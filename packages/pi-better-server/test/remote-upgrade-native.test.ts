import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { VERSION, type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { DaemonClient } from "../src/client.ts";
import { inspectDaemonOwner } from "../src/daemon-owner.ts";
import { pullAttachedSession } from "../src/remote-client/extension.ts";
import { RemoteClientSession } from "../src/remote-client/session.ts";
import { parseRemoteTransferArgs, type TransferFrontend } from "../src/remote-client/transfer-command.ts";
import { openUpgradeTransport } from "../src/remote-client/upgrade-transport.ts";
import { resolveTarget } from "../src/remote/target.ts";
import { hasActivationReservations, readActivationJournal } from "../src/startup/activation.ts";
import { activationArgs } from "../src/startup/commands.ts";
import type { ActivationResult, StagedRuntime } from "../src/startup/managed-types.ts";
import { digest, stable } from "../scripts/private-runtime/format.ts";
import { gate, llmCalls, makeEnv, waitFor, type Env } from "./helpers.ts";
import { privateRuntimeNode } from "./private-runtime-node.ts";

// Like activation-upgrade.test.ts, stage real source with this test process's SDK.
// The build IDs differ, but no server, adapter, bridge, or wire implementation is patched.
function stage(env: Env, seed: string): StagedRuntime {
  const privateNode = privateRuntimeNode();
  const identity = { format: 1 as const, sourceDigest: digest(seed), dependencyLockDigest: digest(`test SDK ${VERSION}`),
    piSdkVersion: VERSION, nodeVersion: privateNode.version, platform: `${process.platform}-${process.arch}` as StagedRuntime["build"]["platform"],
    protocolVersion: 1, serverVersion: "0.1.0" };
  const build = { ...identity, contentId: digest(stable(identity)) };
  const installRoot = join(env.root, "managed");
  const root = join(installRoot, "releases", build.contentId);
  mkdirSync(root, { recursive: true });
  cpSync(fileURLToPath(new URL("../src", import.meta.url)), join(root, "src"), { recursive: true });
  mkdirSync(join(root, "scripts", "private-runtime"), { recursive: true });
  cpSync(fileURLToPath(new URL("../scripts/private-runtime/format.ts", import.meta.url)), join(root, "scripts", "private-runtime", "format.ts"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(root, "managed-build.json"), JSON.stringify(build));
  symlinkSync(fileURLToPath(new URL("../../../node_modules", import.meta.url)), join(root, "node_modules"));
  mkdirSync(join(root, "node", "bin"), { recursive: true });
  symlinkSync(privateNode.node, join(root, "node", "bin", "node"));
  const runtime = { format: 1 as const, build, root, installRoot, node: join(root, "node", "bin", "node"),
    entrypoint: join(root, "src", "cli.ts"), manifestPath: join(root, "runtime.json") };
  writeFileSync(runtime.manifestPath, JSON.stringify(runtime));
  return runtime;
}

async function activate(env: Env, runtime: StagedRuntime, operationId: string): Promise<ActivationResult> {
  const childEnv = { ...process.env, ...env.vars, HOME: env.root, PI_SERVER_AGENT: "pi",
    PI_SERVER_DAEMON_IDLE_MS: "0", PI_SERVER_SESSION_IDLE_MS: "0" };
  delete (childEnv as NodeJS.ProcessEnv).PI_SERVER_COMMAND;
  delete (childEnv as NodeJS.ProcessEnv).PI_SERVER_LAUNCHER;
  const child = spawn(runtime.node, [runtime.entrypoint, ...activationArgs(runtime, env.agentDir, env.serverDir, operationId)], {
    env: childEnv, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const [code, signal] = await once(child, "close");
  assert.equal(code, 0, `activation ${operationId}: ${signal}\n${stderr}\n${stdout}`);
  return JSON.parse(stdout);
}

function lines(path: string): any[] {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}
function text(message: any): string {
  return typeof message.content === "string" ? message.content : (message.content ?? []).map((part: any) => part.text ?? "").join("");
}
function users(messages: readonly any[]): string[] { return messages.filter(message => message.role === "user").map(text); }

function progressUi(t: TestContext): Pick<ExtensionUIContext, "custom"> {
  let active: (Component & { dispose?(): void }) | undefined;
  t.after(() => active?.dispose?.());
  return { custom: factory => new Promise(resolve => {
    assert.equal(active, undefined, "transfer progress screens must not overlap");
    const component = factory({ requestRender() {} } as unknown as TUI,
      { fg: (_color: string, value: string) => value } as Theme, {} as Parameters<typeof factory>[2],
      value => { active?.dispose?.(); active = undefined; resolve(value); });
    assert.ok(!("then" in component));
    active = component;
    assert.ok(active.render(100).length > 0);
  }) };
}

function identities(remote: RemoteClientSession) {
  return [remote, remote.agent, remote.sessionManager, remote.modelRuntime, remote.extensionRunner];
}

async function reply(remote: RemoteClientSession, message: string) {
  await remote.prompt(message);
  await waitFor(`native reply to ${message}`, () => remote.getLastAssistantText() === `echo:${message}`);
  await remote.waitForIdle();
}

test("two native sessions survive a busy managed upgrade, then pull and disconnect through their replacement clients", { timeout: 90_000 }, async t => {
  const started = performance.now();
  const previousEnv = { ...process.env };
  const env = makeEnv();
  const clients = new Set<DaemonClient>();
  const remotes: RemoteClientSession[] = [];
  t.after(async () => {
    gate(env, "gated").release();
    for (const remote of remotes) remote.dispose();
    for (const client of clients) client.close();
    try {
      for (const name of ["activation-owner", "daemon-owner"]) {
        const owner = inspectDaemonOwner(env.serverDir, name);
        if (owner.status !== "live") continue;
        try { process.kill(owner.owner.pid, name === "activation-owner" ? "SIGKILL" : "SIGTERM"); } catch { /* already exited */ }
        await waitFor(`private ${name} exits`, () => inspectDaemonOwner(env.serverDir, name).status !== "live");
      }
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
      Object.assign(process.env, previousEnv);
    }
  });
  // Real extension hooks record executions, and real UI messages exercise the
  // bindings retained by the adapter. Only the model/provider is scripted.
  const toolLog = join(env.root, "tools.jsonl");
  writeFileSync(join(env.agentDir, "extensions", "native-upgrade-proof.ts"), `
    import { appendFileSync } from "node:fs";
    export default function(pi) {
      pi.on("tool_call", event => appendFileSync(${JSON.stringify(toolLog)}, JSON.stringify({ tool: event.toolName, input: event.input }) + "\\n"));
      pi.registerCommand("native-ui", { description: "Upgrade presentation probe", handler: async (args, ctx) => {
        ctx.ui.setStatus("native-proof", args);
        ctx.ui.notify("native:" + args, "info");
      }});
    }
  `);
  const before = stage(env, "native-before"), after = stage(env, "native-after");
  const initial = await activate(env, before, "native-initial");
  assert.equal(initial.status, "ready");
  if (initial.status !== "ready") throw new Error(JSON.stringify(initial));
  const oldOwner = inspectDaemonOwner(env.serverDir);
  assert.equal(oldOwner.status, "live");
  if (oldOwner.status !== "live") throw new Error("initial daemon owner missing");
  const initialReadiness = initial.readiness;
  const initialOwner = oldOwner.owner;
  assert.equal(initialReadiness.hello.instanceId, initialOwner.token);
  assert.ok(initialReadiness.hello.capabilities?.includes("safe-upgrade-v1"));

  async function attach(label: string) {
    const original = await DaemonClient.connect(initialReadiness.socketPath, { hello: { capabilities: ["runtime-reconnect-v1"] } });
    clients.add(original);
    assert.equal(original.server?.instanceId, initialOwner.token);
    const created = await original.call({ type: "create_session", cwd: env.cwd, name: label, model: { provider: "fake", modelId: "fake-1" } });
    const sessionId = created.sessionId!;
    const notices: any[] = [], events: any[] = [], phases: string[] = [], uiEvents: unknown[][] = [], errors: unknown[] = [];
    let current = original;
    let oldCloses = 0, replacementCloses = 0, targetDisposals = 0, reconnects = 0, disconnected = 0;
    let resolvedTargets = 0, closedTargets = 0;
    original.onClose(() => { oldCloses++; });
    original.onEvent(envelope => { if ((envelope.event as any)?.type === "runtime_upgrade") notices.push(envelope); });
    const remote = await RemoteClientSession.connect(original, sessionId, {
      reconnectAfterUpgrade: async (notice, signal) => {
        reconnects++;
        assert.deepEqual(notice, { operationId: "native-upgrade", buildId: after.build.contentId });
        // Start at old-socket close, before successor readiness. The helper must
        // handle the real socket gap using only connect/hello against this state.
        const replacement = await openUpgradeTransport({ socket: initialReadiness.socketPath, agent: "pi", managedRuntime: true, ensureServer: true }, {
          resolveTarget: async options => {
            assert.equal(options.ensureServer, false);
            assert.equal(options.managedRuntime, true);
            const target = await resolveTarget(options);
            resolvedTargets++;
            return { ...target, close: async () => { closedTargets++; await target.close(); } };
          },
        }, signal, notice.buildId);
        assert.equal(closedTargets, resolvedTargets - 1, "every provisional target was cleaned before adoption");
        const dispose = replacement.dispose;
        replacement.dispose = async () => {
          targetDisposals++;
          await dispose?.();
          assert.equal(closedTargets, resolvedTargets, "all recovery targets are disposed");
        };
        clients.add(replacement.client);
        replacement.client.onClose(() => { replacementCloses++; });
        return replacement;
      },
      onReconnected: client => { current = client; original.close(); },
      onUpgradeStatus: phase => { phases.push(phase); },
      onDisconnect: () => { disconnected++; },
    });
    remotes.push(remote);
    const listener = (event: any) => { events.push(event); };
    const unsubscribe = remote.subscribe(listener);
    const bindings = { uiContext: {
      notify: (message: string, kind: string) => { uiEvents.push(["notify", message, kind]); },
      setStatus: (key: string, value: string) => { uiEvents.push(["status", key, value]); },
    }, onError: (error: unknown) => { errors.push(error); } };
    await remote.bindExtensions(bindings);
    const identity = identities(remote);
    const generation = remote.generation;
    const sessionFile = remote.sessionFile!;
    await reply(remote, `history-${label}`);
    await remote.prompt(`/native-ui before-${label}`);
    await waitFor("original UI binding", () => uiEvents.length >= 1);
    return { label, remote, original, sessionId, sessionFile, generation, identity, listener, unsubscribe, bindings, events, notices, phases, uiEvents, errors,
      get current() { return current; },
      counts: () => ({ oldCloses, replacementCloses, targetDisposals, reconnects, disconnected }) };
  }
  const a = await attach("a"), b = await attach("b");
  assert.notEqual(a.sessionId, b.sessionId);
  assert.notEqual(a.remote.agent, b.remote.agent);
  const gated = a.remote.prompt("tool gated");
  // Observe rejection immediately so a shutdown race fails this test, not the runner.
  void gated.catch(() => undefined);
  await waitFor("busy native tool", gate(env, "gated").started);
  const deferred = await activate(env, after, "native-upgrade");
  assert.equal(deferred.status, "deferred", JSON.stringify(deferred));
  assert.equal(readActivationJournal(env.serverDir)?.phase, "prepared");
  assert.ok(hasActivationReservations(readActivationJournal(env.serverDir)!));
  assert.deepEqual(inspectDaemonOwner(env.serverDir), oldOwner);
  assert.equal(gate(env, "gated").finished(), false);
  for (const view of [a, b]) {
    assert.deepEqual(view.phases, []);
    assert.equal(view.notices.length, 0);
    assert.equal((await view.current.call({ type: "client_snapshot", sessionId: view.sessionId })).success, true);
  }
  // A write and a full model turn on the OTHER session prove deferral did not fence admission.
  await b.remote.setSessionName("b-while-deferred");
  await reply(b.remote, "work-while-deferred");
  assert.deepEqual(inspectDaemonOwner(env.serverDir), oldOwner);
  assert.equal(gate(env, "gated").finished(), false);
  assert.deepEqual(lines(toolLog), [{ tool: "gate", input: { name: "gated" } }]);
  const inputsBeforeRestart = lines(`${env.logFile}.inputs`);
  const callsBeforeRelease = llmCalls(env).length;
  const releaseAt = performance.now();
  gate(env, "gated").release();
  await gated;
  await waitFor("both native views ready without another activation request", () => [a, b].every(view => view.phases.includes("ready")), 30_000);
  const readyAt = performance.now();
  await waitFor("activation readiness persisted after client reconnection", () => readActivationJournal(env.serverDir)?.phase === "ready");
  const journal = readActivationJournal(env.serverDir)!;
  assert.equal(journal.phase, "ready");
  assert.equal(journal.desiredBuild.contentId, after.build.contentId);
  assert.notEqual(journal.readiness!.hello.instanceId, initialOwner.token);
  await waitFor("old managed process actually exits", () => {
    try { process.kill(initialOwner.pid, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
  });
  assert.equal(a.remote.getLastAssistantText(), "tool-done:gate:gated");
  assert.equal(llmCalls(env).length, callsBeforeRelease + 1, "only the held tool's continuation ran during restart");
  assert.deepEqual(lines(`${env.logFile}.inputs`), inputsBeforeRestart, "no prompt was resubmitted during recovery");
  assert.deepEqual(lines(toolLog), [{ tool: "gate", input: { name: "gated" } }], "the tool executed once across both daemons");
  await assert.rejects(a.original.call({ type: "list_sessions" }), /closed/);
  await assert.rejects(b.original.call({ type: "list_sessions" }), /closed/);

  const observer = await DaemonClient.connect(journal.readiness!.socketPath, { hello: { capabilities: ["runtime-reconnect-v1"] } });
  clients.add(observer);
  assert.deepEqual((await observer.call({ type: "list_sessions" })).data.sessions.map((item: any) => item.sessionId).sort(), [a.sessionId, b.sessionId].sort());
  for (const view of [a, b]) {
    identities(view.remote).forEach((value, index) => assert.equal(value, view.identity[index], "native object identity survives transport replacement"));
    assert.equal(view.remote.sessionId, view.sessionId);
    assert.equal(view.remote.sessionFile, view.sessionFile);
    assert.notEqual(view.remote.generation, view.generation);
    assert.equal(view.current.server?.instanceId, journal.readiness!.hello.instanceId);
    assert.equal(view.current.server?.build?.contentId, after.build.contentId);
    assert.deepEqual(view.phases, ["restarting", "reconnecting", "ready"]);
    assert.equal(view.notices.length, 1);
    assert.equal(view.notices[0].sessionId, view.sessionId);
    assert.equal(view.notices[0].generation, view.generation);
    assert.ok(Number.isSafeInteger(view.notices[0].seq) && view.notices[0].seq > 0);
    assert.equal(view.events.filter(event => event.type === "remote_snapshot").length, 1);
    assert.deepEqual(view.counts(), { oldCloses: 1, replacementCloses: 0, targetDisposals: 0, reconnects: 1, disconnected: 0 });
    await assert.rejects(observer.call({ type: "acquire_control", sessionId: view.sessionId }), /controller/);
    const expectedUsers = view === a ? ["history-a", "tool gated"] : ["history-b", "work-while-deferred"];
    const snapshot = (await view.current.call({ type: "client_snapshot", sessionId: view.sessionId })).data;
    assert.deepEqual(users(snapshot.messages), expectedUsers);
    const expectedReplies = view === a ? ["echo:history-a", "", "tool-done:gate:gated"] : ["echo:history-b", "echo:work-while-deferred"];
    assert.deepEqual(snapshot.messages.filter((message: any) => message.role === "assistant").map(text), expectedReplies);
    assert.deepEqual(view.remote.messages, snapshot.messages, "native cache agrees with persisted successor history");
    assert.equal(view.remote.generation, snapshot.generation);
    assert.ok(view.remote.lastSeq >= snapshot.lastSeq, "native subscription reached the successor cursor");
    const persisted = lines(view.sessionFile).filter(entry => entry.type === "message").map(entry => entry.message);
    assert.deepEqual(users(persisted), expectedUsers);
    assert.deepEqual(persisted.filter(message => message.role === "assistant").map(text), expectedReplies);
    assert.deepEqual(persisted.filter(message => message.role === "toolResult").map(text), view === a ? ["gate:gated"] : []);
    // No extra bindExtensions or subscribe call: these are the original bindings/listener.
    await reply(view.remote, `first-after-ready-${view.label}`);
    assert.equal(view.events.filter(event => event.type === "message_end" && event.message.role === "assistant" && text(event.message) === `echo:first-after-ready-${view.label}`).length, 1);
    await view.remote.prompt(`/native-ui after-${view.label}`);
    await waitFor("retained UI callbacks receive successor events", () => view.uiEvents.length >= 2);
    assert.deepEqual(view.uiEvents, [["notify", `native:before-${view.label}`, "info"],
      ["notify", `native:after-${view.label}`, "info"]]);
    assert.deepEqual(view.errors, []);
  }
  assert.equal(a.remote.getLastAssistantText(), "echo:first-after-ready-a");
  assert.equal(b.remote.sessionName, "b-while-deferred");
  assert.equal(llmCalls(env).length, callsBeforeRelease + 3, "exactly one new prompt per session after ready");
  assert.equal(lines(toolLog).length, 1);

  // Public extension helper proof: the old connection is closed, so source
  // resolution and reconciliation must use the replacement passed here.
  // This does not pretend to exercise connectHost's private command closure or a TTY.
  const local = makeEnv();
  Object.assign(process.env, local.vars, { PI_REMOTE_STATE_DIR: join(local.root, "transfer-state") });
  let transferTargetsClosed = 0, disconnects = 0;
  const frontend: TransferFrontend & { connected: NonNullable<TransferFrontend["connected"]> } = {
    cwd: local.cwd, connected: { host: "native-fixture", remoteDir: env.serverDir, sessionId: a.sessionId },
    resolveTarget: async () => ({ socketPath: journal.readiness!.socketPath,
      forwardSocket: async () => assert.fail("No SSH in the pull helper test"), close: async () => { transferTargetsClosed++; } }),
    ui: { ...progressUi(t), confirm: async () => true, input: async () => local.cwd, notify() {} } as unknown as ExtensionUIContext,
  };
  const disconnect = async () => { disconnects++; a.remote.dispose(); };
  const copied = await pullAttachedSession(parseRemoteTransferArgs("pull --copy"), frontend, a.current, a.remote, disconnect);
  assert.ok(copied?.sessionFile);
  assert.notEqual(copied.sessionId, a.sessionId);
  const copyBytes = readFileSync(copied.sessionFile, "utf8");
  assert.deepEqual(users(lines(copied.sessionFile).filter(entry => entry.type === "message").map(entry => entry.message)), ["history-a", "tool gated", "first-after-ready-a"]);
  assert.equal(disconnects, 0);
  assert.equal(transferTargetsClosed, 1);
  await reply(a.remote, "after-upgraded-copy");
  assert.ok(a.events.some(event => event.type === "message_end" && text(event.message) === "echo:after-upgraded-copy"));
  assert.equal(readFileSync(copied.sessionFile, "utf8"), copyBytes);
  await assert.rejects(observer.call({ type: "acquire_control", sessionId: a.sessionId }), /controller/);
  const moved = await pullAttachedSession(parseRemoteTransferArgs("pull"), frontend, a.current, a.remote, disconnect);
  assert.equal(moved?.sessionId, a.sessionId);
  assert.equal(disconnects, 1);
  assert.equal(transferTargetsClosed, 2);
  a.remote.dispose();
  b.remote.dispose();
  b.remote.dispose();
  await waitFor("both replacement transports close and dispose exactly once", () => [a, b].every(view => view.counts().replacementCloses === 1 && view.counts().targetDisposals === 1));
  for (const view of [a, b]) {
    assert.deepEqual(view.counts(), { oldCloses: 1, replacementCloses: 1, targetDisposals: 1, reconnects: 1, disconnected: 0 });
    await assert.rejects(view.remote.prompt("must-not-run-after-disconnect"), /detached/);
    assert.deepEqual(view.errors, []);
  }
  const sessions = (await observer.call({ type: "list_sessions" })).data.sessions;
  assert.equal(sessions.find((item: any) => item.sessionId === a.sessionId).ownership, "moved");
  assert.equal((await observer.call({ type: "acquire_control", sessionId: b.sessionId })).success, true, "detach releases control without retiring the other session");
  const bEvents = b.events.length;
  await observer.call({ type: "prompt", sessionId: b.sessionId, message: "after-native-detach" });
  const detachedHistory = (await observer.call({ type: "get_messages", sessionId: b.sessionId })).data.messages;
  assert.equal(text(detachedHistory.at(-1)), "echo:after-native-detach");
  assert.equal(b.events.length, bEvents, "disposed native listener receives no later events");
  assert.equal(lines(toolLog).length, 1);
  assert.equal(lines(`${env.logFile}.inputs`).some(input => input.text === "must-not-run-after-disconnect"), false);
  t.diagnostic(JSON.stringify({ sdk: VERSION, oldPid: oldOwner.owner.pid, newPid: journal.candidateOwner?.pid,
    oldInstance: oldOwner.owner.token, newInstance: journal.readiness!.hello.instanceId,
    sessionIds: [a.sessionId, b.sessionId], releaseToBothReadyMs: Math.round(readyAt - releaseAt),
    totalMs: Math.round(performance.now() - started), modelCalls: llmCalls(env).length, toolExecutions: lines(toolLog).length,
    replacementCleanup: [a.counts(), b.counts()], helperPullCopy: true, helperPullMoveDisconnect: true }));
});
