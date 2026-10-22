import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { DaemonClient } from "../src/client.ts";
import { localStateDir, readLocalRecord } from "../src/detach/local-state.ts";
import type { SessionSummary } from "../src/protocol.ts";
import { parseRemoteTransferArgs, runRemoteTransfer, type TransferFrontend } from "../src/remote-client/transfer-command.ts";
import { makeEnv, spawnDaemon, waitFor } from "./helpers.ts";

test("pull defaults to a conversation-only handoff without exposing compression as an option", () => {
  assert.deepEqual(parseRemoteTransferArgs("  pull  "), {
    direction: "pull", host: undefined, copy: false, includeWorkspace: false,
  });
  assert.deepEqual(parseRemoteTransferArgs("pull user@r5"), {
    direction: "pull", host: "user@r5", copy: false, includeWorkspace: false,
  });
  assert.deepEqual(parseRemoteTransferArgs("pull --session selected"), {
    direction: "pull", host: undefined, sessionId: "selected", copy: false, includeWorkspace: false,
  });
});

test("pull parses copy, workspace scope, destination, session, and remote server selectors independently", () => {
  for (const copy of [false, true]) {
    for (const includeWorkspace of [false, true]) {
      const flags = [copy ? "--copy" : "", includeWorkspace ? "--with-workspace" : ""].filter(Boolean).join(" ");
      assert.deepEqual(parseRemoteTransferArgs(`pull --cwd /local/destination ${flags} r5 --session abc --remote-dir /remote/server`), {
        direction: "pull", host: "r5", cwd: "/local/destination", sessionId: "abc", remoteDir: "/remote/server", copy, includeWorkspace,
      });
    }
  }
});

test("transfer command parsing refuses push and other commands rather than opening a transfer", () => {
  for (const text of ["", "push", "push r5 --copy", "connect r5", "list", "r5", "/remote pull r5"]) {
    assert.throws(() => parseRemoteTransferArgs(text), /Use \/remote connect.*\/remote pull/, text);
  }
});

test("pull refuses malformed, unknown, and user-selectable compression options", () => {
  const cases: Array<[string, RegExp | { code: string }]> = [
    ["pull r5 r6", /one SSH host/],
    ["pull ../host", /one SSH host alias/],
    ["pull r5 --cwd relative", /--cwd must be an absolute/],
    ["pull r5 --remote-dir relative", /--remote-dir must be absolute/],
    ["pull r5 --cwd", { code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" }],
    ["pull r5 --session", { code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" }],
    ["pull r5 --remote-dir", { code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" }],
    ["pull r5 --copy=true", { code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" }],
    ["pull r5 --with-workspace=true", { code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" }],
    ["pull r5 --unknown", { code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" }],
    ["pull r5 --compression gzip", { code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" }],
    ["pull r5 --gzip", { code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" }],
    ["pull r5 --push", { code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" }],
  ];
  for (const [text, error] of cases) assert.throws(() => parseRemoteTransferArgs(text), error, text);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function nativeUi(t: TestContext, dialogs: Partial<ExtensionUIContext> = {}) {
  type Screen = Component & { dispose?(): void };
  const screens: Array<{ text: string; cancellable: boolean; disposed: boolean }> = [];
  let active: Screen | undefined;
  const ui = {
    notify() {},
    select: async () => assert.fail("Unexpected session selection"),
    input: async () => assert.fail("Unexpected destination input"),
    confirm: async () => {
      assert.equal(active, undefined, "Approval must not be nested inside progress");
      return true;
    },
    ...dialogs,
    custom: (factory: (...args: any[]) => Screen) => new Promise(resolve => {
      assert.equal(active, undefined, "Native dialogs must not be nested");
      const component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, (value: unknown) => {
        component.dispose?.();
        screen.disposed = true;
        active = undefined;
        resolve(value);
      });
      const text = component.render(120).join("\n");
      const screen = { text, cancellable: text.includes("Esc cancel"), disposed: false };
      screens.push(screen);
      active = component;
      if (!screen.cancellable) {
        component.handleInput?.("\x1b");
        assert.equal(screen.disposed, false, "Escape must not dismiss an ongoing transfer");
      }
    }),
  } as unknown as ExtensionUIContext;
  t.after(() => active?.dispose?.());
  return { ui, screens, cancel: () => active?.handleInput?.("\x1b"), render: () => active?.render(120).join("\n") };
}

function workspaceFiles(cwd: string): Record<string, string> {
  return Object.fromEntries(readdirSync(cwd).sort().map(name => [name, readFileSync(join(cwd, name), "utf8")]));
}

async function transferFixture(t: TestContext) {
  const remote = makeEnv();
  const { child, socketPath } = await spawnDaemon(remote);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
      child.kill("SIGKILL");
      await closed;
    }
  });
  const client = await DaemonClient.connect(socketPath);
  t.after(() => client.close());
  const local = makeEnv();
  const vars = { ...local.vars, PI_REMOTE_STATE_DIR: join(local.root, "transfer-state") };
  const previous = new Map(Object.keys(vars).map(key => [key, process.env[key]]));
  Object.assign(process.env, vars);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  writeFileSync(join(remote.cwd, "remote-only.txt"), "remote workspace stays remote");
  writeFileSync(join(local.cwd, "local-only.txt"), "local work stays untouched");
  writeFileSync(join(local.cwd, ".env"), "DESTINATION_SECRET=untouched");
  const created = await client.call({ type: "create_session", cwd: remote.cwd, name: "Pull fixture", model: { provider: "fake", modelId: "fake-1" } });
  const sessionId = created.sessionId!;
  await client.call({ type: "prompt", sessionId, message: "history to pull" });
  await waitFor("remote fixture reply", async () => {
    const state = await client.call({ type: "get_state", sessionId });
    const messages = await client.call({ type: "get_messages", sessionId });
    return !state.data.isStreaming && JSON.stringify(messages.data.messages).includes("echo:history to pull");
  });
  const sessions = async () => (await client.call({ type: "list_sessions" })).data.sessions as SessionSummary[];
  const source = (await sessions()).find(session => session.sessionId === sessionId)!;
  let closedTargets = 0;
  const resolveTarget: NonNullable<TransferFrontend["resolveTarget"]> = async options => {
    assert.equal(options.host, "fixture-host");
    assert.equal(options.remoteDir, remote.serverDir);
    return {
      socketPath,
      forwardSocket: async () => assert.fail("Unix socket tests must not open SSH forwards"),
      close: async () => { closedTargets++; },
    };
  };
  return { remote, local, source, sessions, socketPath, resolveTarget, closedTargets: () => closedTargets };
}

test("real daemon: standalone pull copies then hands off conversation history without changing either workspace", async t => {
  const fixture = await transferFixture(t);
  const { local, remote, source } = fixture;
  const sourceTranscript = readFileSync(source.sessionFile!, "utf8");
  const localFiles = workspaceFiles(local.cwd);
  const remoteFiles = workspaceFiles(remote.cwd);
  for (const copy of [true, false]) {
    const notices: string[] = [];
    let approvals = 0;
    const progress = nativeUi(t, {
      select: async () => assert.fail("An explicit session must bypass session selection"),
      input: async () => assert.fail("An explicit destination must bypass destination input"),
      confirm: async (title: string, body: string) => {
        approvals++;
        assert.match(title, copy ? /Copy/ : /Move/);
        assert.ok(body.includes(`To: local:${local.cwd}`));
        assert.match(body, /Scope: conversation only/);
        assert.match(body, /Compression: gzip/);
        return true;
      },
      notify: (message: string) => { notices.push(message); },
    });
    const result = await runRemoteTransfer(parseRemoteTransferArgs(`pull fixture-host --session ${source.sessionId} --cwd ${local.cwd} --remote-dir ${remote.serverDir}${copy ? " --copy" : ""}`), {
      ui: progress.ui, cwd: local.cwd, resolveTarget: fixture.resolveTarget,
    });
    assert.ok(result?.sessionFile, "standalone pull provides an exact resumable transcript");
    assert.equal(result.direction, "pull");
    assert.equal(result.copy, copy);
    assert.equal(result.host, "fixture-host");
    assert.equal(result.cwd, local.cwd);
    assert.equal(approvals, 1);
    assert.deepEqual(progress.screens.map(screen => screen.cancellable), [true, true, false]);
    assert.ok(progress.screens.every(screen => screen.disposed), "All native progress components are disposed");
    if (copy) assert.notEqual(result.sessionId, source.sessionId);
    else assert.equal(result.sessionId, source.sessionId);
    const resumed = SessionManager.open(result.sessionFile);
    assert.equal(resumed.getSessionId(), result.sessionId);
    assert.equal(resumed.getCwd(), local.cwd);
    assert.match(readFileSync(result.sessionFile, "utf8"), /echo:history to pull/);
    assert.equal(readLocalRecord(localStateDir(), result.sessionId)?.state, "owned");
    const after = (await fixture.sessions()).find(session => session.sessionId === source.sessionId)!;
    assert.equal(after.ownership, copy ? undefined : "moved");
    assert.equal(after.live, copy);
    assert.equal(readFileSync(source.sessionFile!, "utf8"), sourceTranscript);
    assert.deepEqual(workspaceFiles(local.cwd), localFiles);
    assert.deepEqual(workspaceFiles(remote.cwd), remoteFiles);
    assert.ok(notices.some(message => message.includes(`pi --session '${result.sessionFile}'`)), "completion gives a runnable resume command");
    assert.ok(notices.some(message => message.startsWith(copy ? "Copied session" : "Moved session")));
  }
  assert.equal(fixture.closedTargets(), 2);
});

test("real daemon: cancelling session, destination, or scope confirmation leaves source ownership and files unchanged", async t => {
  const fixture = await transferFixture(t);
  const { local, remote, source } = fixture;
  const before = await fixture.sessions();
  const transcript = readFileSync(source.sessionFile!, "utf8");
  const localFiles = workspaceFiles(local.cwd);
  const remoteFiles = workspaceFiles(remote.cwd);
  const cases = [
    { cancel: "session", copy: false, includeWorkspace: false },
    { cancel: "destination", copy: false, includeWorkspace: false },
    { cancel: "confirmation", copy: false, includeWorkspace: false },
    { cancel: "confirmation", copy: true, includeWorkspace: true },
  ];
  for (const { cancel, copy, includeWorkspace } of cases) {
    const prompts: string[] = [];
    const progress = nativeUi(t, {
      select: async (_title: string, options: string[]) => {
        prompts.push("session");
        assert.equal(options.length, 1);
        assert.ok(options[0]!.includes(source.sessionId));
        return cancel === "session" ? undefined : options[0];
      },
      input: async (_title: string, defaultValue: string) => {
        prompts.push("destination");
        assert.equal(defaultValue, includeWorkspace ? join(local.cwd, `${basename(remote.cwd)}-${source.sessionId.slice(0, 8)}-copy`) : local.cwd);
        return cancel === "destination" ? undefined : defaultValue;
      },
      confirm: async (title: string, body: string) => {
        prompts.push("confirmation");
        assert.match(title, copy ? /Copy/ : /Move/);
        assert.match(body, includeWorkspace ? /Scope: conversation and workspace files/ : /Scope: conversation only/);
        assert.match(body, /Compression: gzip/);
        return false;
      },
      notify: () => {},
    });
    const result = await runRemoteTransfer(parseRemoteTransferArgs(`pull fixture-host --remote-dir ${remote.serverDir}${copy ? " --copy" : ""}${includeWorkspace ? " --with-workspace" : ""}`), {
      ui: progress.ui, cwd: local.cwd, resolveTarget: fixture.resolveTarget,
    });
    assert.equal(result, undefined);
    assert.deepEqual(prompts, cancel === "session" ? ["session"] : cancel === "destination" ? ["session", "destination"] : ["session", "destination", "confirmation"]);
    assert.deepEqual(await fixture.sessions(), before);
    assert.equal(readFileSync(source.sessionFile!, "utf8"), transcript);
    assert.equal(readLocalRecord(localStateDir(), source.sessionId), undefined);
    assert.deepEqual(workspaceFiles(local.cwd), localFiles);
    assert.deepEqual(workspaceFiles(remote.cwd), remoteFiles);
  }
  assert.equal(fixture.closedTargets(), cases.length);
});

function observeConnections(t: TestContext, observe: (client: DaemonClient, options: Parameters<typeof DaemonClient.connect>[1]) => void | Promise<void>) {
  const connect = DaemonClient.connect;
  t.mock.method(DaemonClient, "connect", async (path: string, options: Parameters<typeof DaemonClient.connect>[1]) => {
    const client = await connect(path, options);
    await observe(client, options);
    return client;
  });
}

function localSession(fixture: Awaited<ReturnType<typeof transferFixture>>): NonNullable<TransferFrontend["localSession"]> {
  const manager = SessionManager.create(fixture.local.cwd, join(fixture.local.agentDir, "sessions", "seed"));
  manager.appendModelChange("fake", "fake-1");
  manager.appendMessage({ role: "user", content: "local history to push", timestamp: 0 });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "local reply" }], api: "fake-api" as never,
    provider: "fake", model: "fake-1", stopReason: "stop", timestamp: 0,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  return {
    manager, isBusy: () => false, pi: { on() {} } as unknown as ExtensionAPI,
    info: { sessionId: manager.getSessionId(), cwd: fixture.local.cwd, sessionFile: manager.getSessionFile(), model: "fake/fake-1" },
  };
}

for (const phase of ["session list", "session resolution", "workspace discovery"]) {
  test(`real daemon: cancelling ${phase} progress closes the connection without transferring`, { timeout: 30_000 }, async t => {
    const fixture = await transferFixture(t);
    const progress = nativeUi(t);
    const source = phase === "workspace discovery" ? localSession(fixture) : undefined;
    const before = await fixture.sessions();
    const localFiles = workspaceFiles(fixture.local.cwd);
    const remoteFiles = workspaceFiles(fixture.remote.cwd);
    const responseReady = deferred<void>();
    const release = deferred<void>();
    const closed = deferred<void>();
    const commands: unknown[] = [];
    observeConnections(t, client => {
      client.onClose(() => closed.resolve());
      const call = client.call.bind(client);
      t.mock.method(client, "call", async (command: Record<string, unknown>) => {
        commands.push(command.type);
        const response = await call(command);
        responseReady.resolve();
        await release.promise;
        return response;
      });
    });
    const args = { direction: source ? "push" as const : "pull" as const, host: "fixture-host", remoteDir: fixture.remote.serverDir,
      copy: false, includeWorkspace: false,
      ...(phase === "session resolution" ? { sessionId: fixture.source.sessionId } : {}) };
    const attempt = runRemoteTransfer(args, { ui: progress.ui, cwd: fixture.local.cwd, localSession: source, resolveTarget: fixture.resolveTarget });
    await responseReady.promise;
    assert.match(progress.render()!, phase === "session list" ? /Loading remote sessions/ : phase === "session resolution" ? /Resolving remote session/ : /Finding remote workspace/);
    progress.cancel();
    assert.equal(await attempt, undefined);
    await closed.promise;
    release.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(commands, [source ? "client_workspaces" : "list_sessions"], "No transfer write may follow a cancelled read");
    assert.equal(fixture.closedTargets(), 1);
    assert.ok(progress.screens.every(screen => screen.disposed));
    assert.deepEqual(await fixture.sessions(), before);
    assert.equal(readLocalRecord(localStateDir(), (source?.info ?? fixture.source).sessionId), undefined);
    assert.deepEqual(workspaceFiles(fixture.local.cwd), localFiles);
    assert.deepEqual(workspaceFiles(fixture.remote.cwd), remoteFiles);
  });
}

for (const phase of ["target", "daemon client"]) {
  test(`real daemon: cancelling connection setup disposes a late ${phase}`, { timeout: 30_000 }, async t => {
    const fixture = await transferFixture(t);
    const progress = nativeUi(t);
    const started = deferred<void>();
    const release = deferred<void>();
    const cleaned = deferred<void>();
    const clientClosed = deferred<void>();
    let signal!: AbortSignal;
    const commands: unknown[] = [];
    let clients = 0;
    observeConnections(t, async (client, options) => {
      clients++;
      assert.equal(options?.signal, signal, "The setup signal must reach the daemon handshake");
      client.onClose(() => clientClosed.resolve());
      const call = client.call.bind(client);
      t.mock.method(client, "call", (command: Record<string, unknown>) => { commands.push(command.type); return call(command); });
      if (phase === "daemon client") { started.resolve(); await release.promise; }
    });
    const resolveTarget: NonNullable<TransferFrontend["resolveTarget"]> = async options => {
      signal = options.signal!;
      const target = await fixture.resolveTarget(options);
      options.onProgress?.("forward");
      if (phase === "target") { started.resolve(); await release.promise; }
      return { ...target, close: async () => { await target.close(); cleaned.resolve(); } };
    };
    const before = await fixture.sessions();
    const attempt = runRemoteTransfer({ direction: "pull", host: "fixture-host", remoteDir: fixture.remote.serverDir,
      sessionId: fixture.source.sessionId, cwd: fixture.local.cwd, copy: false, includeWorkspace: false },
    { ui: progress.ui, cwd: fixture.local.cwd, resolveTarget });
    await started.promise;
    assert.match(progress.render()!, phase === "target" ? /opening SSH tunnel/ : /contacting Pi server/);
    progress.cancel();
    assert.equal(await attempt, undefined);
    assert.equal(signal.aborted, true);
    release.resolve();
    await cleaned.promise;
    if (phase === "daemon client") await clientClosed.promise;
    assert.equal(clients, phase === "target" ? 0 : 1);
    assert.equal(fixture.closedTargets(), 1);
    assert.deepEqual(commands, [], "A late connection must not start any reads or writes");
    assert.deepEqual(await fixture.sessions(), before);
    assert.equal(readLocalRecord(localStateDir(), fixture.source.sessionId), undefined);
    assert.ok(progress.screens.every(screen => screen.disposed));
  });
}

test("real daemon: push uses the selected destination and keeps native progress through copy and handoff", { timeout: 30_000 }, async t => {
  const fixture = await transferFixture(t);
  const source = localSession(fixture);
  const commands: unknown[] = [];
  let currentProgress!: ReturnType<typeof nativeUi>;
  observeConnections(t, client => {
    const call = client.call.bind(client);
    t.mock.method(client, "call", async (command: Record<string, unknown>) => {
      commands.push(command.type);
      const response = await call(command);
      if (command.type === "move_write") {
        assert.match(currentProgress.render()!, /Transferring conversation/);
        currentProgress.cancel();
        assert.match(currentProgress.render()!, /Transferring conversation/, "Escape cannot dismiss an in-flight write");
      }
      return response;
    });
  });
  const localFiles = workspaceFiles(fixture.local.cwd);
  const remoteFiles = workspaceFiles(fixture.remote.cwd);
  for (const copy of [true, false]) {
    const progress = currentProgress = nativeUi(t);
    let prepared = false;
    const result = await runRemoteTransfer({ direction: "push", host: "fixture-host", remoteDir: fixture.remote.serverDir,
      cwd: fixture.remote.cwd, copy, includeWorkspace: false }, {
      ui: progress.ui, cwd: fixture.local.cwd, localSession: source, resolveTarget: fixture.resolveTarget,
      beforeTransfer: async () => {
        assert.equal(progress.render(), undefined, "Extension synchronization may open its own dialogs");
        assert.equal(readLocalRecord(localStateDir(), source.info.sessionId)?.state, copy ? undefined : "owned", "Approval and preparation must precede fencing");
        prepared = true;
      },
    });
    assert.ok(result);
    assert.equal(prepared, true);
    assert.equal(result.cwd, fixture.remote.cwd);
    assert.deepEqual(progress.screens.map(screen => screen.cancellable), [true, false]);
    assert.ok(progress.screens.every(screen => screen.disposed));
    assert.equal(commands.includes("client_workspaces"), false, "A selected destination must not trigger workspace discovery");
    const destination = (await fixture.sessions()).find(session => session.sessionId === result.sessionId)!;
    assert.match(readFileSync(destination.sessionFile!, "utf8"), /local history to push/);
    assert.equal(readLocalRecord(localStateDir(), source.info.sessionId)?.state, copy ? "owned" : "moved");
    if (copy) assert.notEqual(result.sessionId, source.info.sessionId);
    else assert.equal(result.sessionId, source.info.sessionId);
    assert.deepEqual(workspaceFiles(fixture.local.cwd), localFiles);
    assert.deepEqual(workspaceFiles(fixture.remote.cwd), remoteFiles);
  }
  assert.equal(fixture.closedTargets(), 2);
});

test("real daemon: read errors retain their original message even if target cleanup fails", async t => {
  const fixture = await transferFixture(t);
  const progress = nativeUi(t);
  let closed = false;
  observeConnections(t, client => { client.onClose(() => { closed = true; }); });
  const resolveTarget: NonNullable<TransferFrontend["resolveTarget"]> = async options => {
    const target = await fixture.resolveTarget(options);
    return { ...target, close: async () => { await target.close(); throw new Error("cleanup failure"); } };
  };
  await assert.rejects(runRemoteTransfer({ direction: "pull", host: "fixture-host", remoteDir: fixture.remote.serverDir,
    sessionId: "missing-session", cwd: fixture.local.cwd, copy: false, includeWorkspace: false },
  { ui: progress.ui, cwd: fixture.local.cwd, resolveTarget }), /No session matches "missing-session"/);
  await waitFor("failed read connection to close", () => closed);
  assert.equal(fixture.closedTargets(), 1);
  assert.ok(progress.screens.every(screen => screen.disposed));
  assert.equal(readLocalRecord(localStateDir(), fixture.source.sessionId), undefined);
});

test("connection setup preserves the original failure and cleans a target when the daemon connection fails", async t => {
  const fixture = await transferFixture(t);
  const original = new Error("SSH refused fixture-host");
  const args = { direction: "pull" as const, host: "fixture-host", remoteDir: fixture.remote.serverDir, copy: false, includeWorkspace: false };
  const progress = nativeUi(t);
  await assert.rejects(runRemoteTransfer(args, { ui: progress.ui, cwd: fixture.local.cwd,
    resolveTarget: async () => { throw original; } }), error => error === original);
  await assert.rejects(runRemoteTransfer(args, { ui: progress.ui, cwd: fixture.local.cwd,
    resolveTarget: async options => {
      const target = await fixture.resolveTarget(options);
      return { ...target, socketPath: join(fixture.remote.root, "missing.sock"),
        close: async () => { await target.close(); throw new Error("cleanup failure"); } };
    },
  }), { code: "ENOENT" });
  assert.equal(fixture.closedTargets(), 1);
  assert.ok(progress.screens.every(screen => screen.disposed));
});
