import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { DaemonClient } from "../src/client.ts";
import { inspectDaemonOwner } from "../src/daemon-owner.ts";
import { hasActivationReservations, readActivationJournal } from "../src/startup/activation.ts";
import { activationArgs } from "../src/startup/commands.ts";
import type { Readiness } from "../src/startup/ensure.ts";
import type { StagedRuntime } from "../src/startup/managed-types.ts";
import { digest, stable } from "../scripts/private-runtime/format.ts";
import { gate, makeEnv, waitFor, type Env } from "./helpers.ts";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
function staged(env: Env, seed: string): StagedRuntime {
  const identity = { format: 1 as const, sourceDigest: digest(seed), dependencyLockDigest: digest("test SDK symlink"), piSdkVersion: PI_VERSION,
    nodeVersion: "24.14.1", platform: `${process.platform}-${process.arch}` as "darwin-arm64", protocolVersion: 1, serverVersion: "0.1.0" };
  const build = { ...identity, contentId: digest(stable(identity)) };
  const installRoot = join(env.root, "managed");
  const root = join(installRoot, "releases", build.contentId);
  mkdirSync(root, { recursive: true });
  cpSync(join(packageDir, "src"), join(root, "src"), { recursive: true });
  mkdirSync(join(root, "scripts", "private-runtime"), { recursive: true });
  cpSync(join(packageDir, "scripts", "private-runtime", "format.ts"), join(root, "scripts", "private-runtime", "format.ts"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(root, "managed-build.json"), JSON.stringify(build));
  symlinkSync(fileURLToPath(new URL("../../../node_modules", import.meta.url)), join(root, "node_modules"));
  mkdirSync(join(root, "node", "bin"), { recursive: true });
  symlinkSync(process.execPath, join(root, "node", "bin", "node"));
  const runtime = { format: 1 as const, root, installRoot, build, node: join(root, "node", "bin", "node"), entrypoint: join(root, "src", "cli.ts"), manifestPath: join(root, "runtime.json") };
  writeFileSync(runtime.manifestPath, JSON.stringify(runtime));
  return runtime;
}
function run(env: Env, runtime: StagedRuntime, args: string[], expectedExit = 0) {
  const childEnv = { ...process.env, ...env.vars, HOME: env.root, PI_SERVER_AGENT: "pi", PI_SERVER_DAEMON_IDLE_MS: "0", PI_SERVER_SESSION_IDLE_MS: "0" };
  delete (childEnv as NodeJS.ProcessEnv).PI_SERVER_COMMAND;
  delete (childEnv as NodeJS.ProcessEnv).PI_SERVER_LAUNCHER;
  const child = spawn(process.execPath, [runtime.entrypoint, ...args], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  return { child, result: once(child, "close").then(([code]) => {
    assert.equal(code, expectedExit, stderr);
    return expectedExit === 0 ? JSON.parse(stdout) : stderr;
  }) };
}
function fixture(t: TestContext) {
  const env = makeEnv();
  t.after(async () => {
    for (const name of ["gated", "create", "observe", "background", "shutdown", "resume"]) gate(env, name).release();
    // Only private test namespace owners are stopped. No production/SSH operation is involved.
    for (const name of ["activation-owner", "daemon-owner"]) {
      const owner = inspectDaemonOwner(env.serverDir, name);
      if (owner.status !== "live") continue;
      try { process.kill(owner.owner.pid, name === "activation-owner" ? "SIGKILL" : "SIGTERM"); } catch { /* exited already */ }
      if (name === "daemon-owner") await waitFor("test daemon release", () => inspectDaemonOwner(env.serverDir).status !== "live");
    }
  });
  return env;
}
async function activate(env: Env, runtime: StagedRuntime, id: string) {
  return run(env, runtime, activationArgs(runtime, env.agentDir, env.serverDir, id)).result;
}

test("real managed CLI activates an empty namespace and ensure reuses exact build identity", { timeout: 30_000 }, async t => {
  const env = fixture(t);
  const runtime = staged(env, "fresh");
  const outcome = await activate(env, runtime, "initial");
  assert.equal(outcome.status, "ready", JSON.stringify(outcome));
  assert.equal(outcome.readiness.hello.build.contentId, runtime.build.contentId);
  const owner = inspectDaemonOwner(env.serverDir);
  assert.equal(owner.status, "live");
  if (owner.status !== "live") throw new Error("missing test daemon");
  assert.equal(outcome.readiness.hello.instanceId, owner.owner.token);
  const ensured = await run(env, runtime, ["ensure", "--desired-runtime", runtime.manifestPath, "--operation-id", "second"]).result;
  assert.equal(ensured.hello.instanceId, owner.owner.token);
  assert.equal(readActivationJournal(env.serverDir)?.phase, "ready");
  assert.equal(existsSync(join(env.root, ".pi", "remote-server.json")), false, "explicit nondefault state does not become the global default");
});

test("managed connect restarts its proven exited ready owner without losing session history", { timeout: 30_000 }, async t => {
  const env = fixture(t);
  const runtime = staged(env, "restart-ready");
  const initial = await activate(env, runtime, "initial");
  assert.equal(initial.status, "ready");
  const client = await DaemonClient.connect(initial.readiness.socketPath);
  t.after(() => client.close());
  const created = await client.call({ type: "create_session", cwd: env.cwd, model: { provider: "fake", modelId: "fake-1" } });
  await client.call({ type: "set_session_name", sessionId: created.sessionId, name: "retained after idle stop" });
  const owner = inspectDaemonOwner(env.serverDir);
  assert.equal(owner.status, "live");
  if (owner.status !== "live") throw new Error("missing isolated daemon owner");
  process.kill(owner.owner.pid, "SIGTERM");
  await waitFor("isolated owner cleanly releases its claim", () => inspectDaemonOwner(env.serverDir).status === "missing");
  const resumed = await activate(env, runtime, "resume-ready");
  assert.equal(resumed.status, "ready", JSON.stringify(resumed));
  assert.notEqual(resumed.readiness.hello.instanceId, initial.readiness.hello.instanceId);
  const next = await DaemonClient.connect(resumed.readiness.socketPath);
  t.after(() => next.close());
  const listed = (await next.call({ type: "list_sessions" })).data.sessions;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].sessionId, created.sessionId);
  assert.equal(listed[0].name, "retained after idle stop");
});

test("managed CLI retires a stale legacy activation after owner exit and preserves sessions", { timeout: 30_000 }, async t => {
  const env = fixture(t);
  const before = staged(env, "stale-legacy");
  const after = staged(env, "stale-successor");
  const initial = await activate(env, before, "initial");
  assert.equal(initial.status, "ready");
  const client = await connected(t, env, initial.readiness);
  const created = await client.call({ type: "create_session", cwd: env.cwd, model: { provider: "fake", modelId: "fake-1" } });
  const owner = inspectDaemonOwner(env.serverDir);
  assert.equal(owner.status, "live");
  if (owner.status !== "live") throw new Error("missing isolated owner");
  process.kill(owner.owner.pid, "SIGTERM");
  await waitFor("previous owner release", () => inspectDaemonOwner(env.serverDir).status === "missing");
  // Reproduce the durable pre-upgrade format left by an older client on r5.
  writeFileSync(join(env.serverDir, "activation.json"), JSON.stringify({
    version: 1, runtime: before, desiredBuild: before.build, serverDir: env.serverDir, agentDir: env.agentDir,
    operationId: "abandoned", phase: "staged", emptyNamespace: false, previousOwner: owner.owner,
    previousCompatibility: { piSdkVersion: PI_VERSION, protocolVersion: 1 },
    reason: "Legacy or unverified live daemon; staged runtime is pending verified owner exit",
  }));
  writeFileSync(join(env.serverDir, "activation-reservations", "a".repeat(64)), JSON.stringify({
    buildId: before.build.contentId, operationId: "abandoned", baseOperationId: null,
  }));
  const [outcome, coalesced] = await Promise.all([
    activate(env, after, "fresh-request"), activate(env, after, "coalesced-request"),
  ]);
  assert.equal(outcome.status, "ready", JSON.stringify(outcome));
  assert.equal(coalesced.status, "ready", JSON.stringify(coalesced));
  assert.equal(coalesced.readiness.hello.instanceId, outcome.readiness.hello.instanceId);
  assert.equal(outcome.readiness.hello.build.contentId, after.build.contentId);
  const next = await connected(t, env, outcome.readiness);
  assert.deepEqual((await next.call({ type: "list_sessions" })).data.sessions.map((s: any) => s.sessionId), [created.sessionId]);
  assert.equal(reservations(env).length, 0);
});

test("ready activation updates registration atomically while preserving registered directories", { timeout: 30_000 }, async t => {
  const env = fixture(t);
  const runtime = staged(env, "registered-default");
  mkdirSync(join(env.root, ".pi"));
  const registrationPath = join(env.root, ".pi", "remote-server.json");
  const original = { version: 1, agent: "pi", launcher: join(env.root, "old-launcher"), agentDir: env.agentDir, defaultServerDir: env.serverDir };
  writeFileSync(registrationPath, JSON.stringify(original));
  assert.equal((await activate(env, runtime, "registered")).status, "ready");
  const updated = JSON.parse(readFileSync(registrationPath, "utf8"));
  assert.equal(updated.agentDir, original.agentDir);
  assert.equal(updated.defaultServerDir, original.defaultServerDir);
  assert.notEqual(updated.launcher, original.launcher);
  assert.equal(existsSync(updated.launcher), true);
  const child = spawn(updated.launcher, ["runtime", "--agent", "pi"], { env: { ...process.env, HOME: env.root, PI_SERVER_DIR: "", PI_CODING_AGENT_DIR: "", PI_SERVER_COMMAND: "", PI_SERVER_LAUNCHER: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  const [code] = await once(child, "close");
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), updated, "published launcher retains the registered agent and default state");
});

test("busy daemon keeps both views usable, then sends restarting events and resumes on one successor", { timeout: 45_000 }, async t => {
  const env = fixture(t);
  const before = staged(env, "before");
  const after = staged(env, "after");
  const initial = await activate(env, before, "initial");
  assert.equal(initial.status, "ready");
  assert.ok(initial.readiness.hello.capabilities.includes("safe-upgrade-v1"), "shared maintenance must be integrated before promising safe restart");
  const a = await DaemonClient.connect(initial.readiness.socketPath);
  const b = await DaemonClient.connect(initial.readiness.socketPath);
  t.after(() => { a.close(); b.close(); });
  const noticesA: any[] = [], noticesB: any[] = [];
  a.onEvent(event => { if ((event.event as { type?: string } | undefined)?.type === "runtime_upgrade") noticesA.push(event); });
  b.onEvent(event => { if ((event.event as { type?: string } | undefined)?.type === "runtime_upgrade") noticesB.push(event); });
  for (const client of [a, b]) await client.call({ type: "hello", protocolVersion: 1, piVersion: PI_VERSION, capabilities: ["runtime-reconnect-v1"] });
  const created = await a.call({ type: "create_session", cwd: env.cwd, model: { provider: "fake", modelId: "fake-1" } });
  const sessionId = created.sessionId!;
  await b.call({ type: "subscribe", sessionId });
  await a.call({ type: "acquire_control", sessionId });
  const prompt = a.call({ type: "prompt", sessionId, message: "tool gated" });
  await waitFor("active tool", gate(env, "gated").started);
  const pending = await activate(env, after, "upgrade");
  assert.equal(pending.status, "deferred");
  assert.equal(pending.operationId, "upgrade");
  assert.equal(hasActivationReservations(readActivationJournal(env.serverDir)!), true, "a deferred caller leaves its request reserved");
  assert.equal((await b.call({ type: "list_sessions" })).data.sessions.length, 1);
  assert.equal((await b.call({ type: "runtime_upgrade_status" })).data.phase, "prepared");
  assert.equal((await b.call({ type: "client_snapshot", sessionId })).success, true);
  assert.equal(inspectDaemonOwner(env.serverDir).status, "live");
  assert.equal(noticesA.length + noticesB.length, 0);
  gate(env, "gated").release();
  await prompt;
  const ready = await waitFor("successor readiness", () => {
    const journal = readActivationJournal(env.serverDir);
    return journal?.phase === "ready" && journal.desiredBuild.contentId === after.build.contentId ? journal : undefined;
  }, 30_000);
  await waitFor("both subscribed views receive restart notice", () => noticesA.length === 1 && noticesB.length === 1);
  assert.equal(noticesA[0].event.operationId, "upgrade");
  assert.equal(noticesB[0].event.buildId, after.build.contentId);
  assert.equal(typeof noticesA[0].generation, "string");
  assert.ok(noticesA[0].seq > 0);
  assert.notEqual(ready.readiness!.hello.instanceId, initial.readiness.hello.instanceId);
  const reconnected = await DaemonClient.connect(ready.readiness!.socketPath);
  t.after(() => reconnected.close());
  assert.deepEqual((await reconnected.call({ type: "list_sessions" })).data.sessions.map((s: any) => s.sessionId), [sessionId]);
  const history = readFileSync(created.data.sessionFile, "utf8");
  assert.match(history, /tool gated/);
  assert.match(history, /toolResult/);
});

async function connected(t: TestContext, env: Env, readiness: Readiness, reconnect = true) {
  const client = await DaemonClient.connect(readiness.socketPath, { hello: { capabilities: reconnect ? ["runtime-reconnect-v1"] : [] } });
  t.after(() => client.close());
  return client;
}

async function successor(t: TestContext, env: Env, runtime: StagedRuntime) {
  const journal = await waitFor("verified successor", () => {
    const journal = readActivationJournal(env.serverDir);
    return journal?.phase === "ready" && journal.desiredBuild.contentId === runtime.build.contentId ? journal : undefined;
  }, 30_000).catch(error => { throw new Error(`${error}\n${readFileSync(join(env.serverDir, "activation.log"), "utf8")}\n${JSON.stringify(readActivationJournal(env.serverDir))}`); });
  const client = await connected(t, env, journal.readiness!);
  const owner = inspectDaemonOwner(env.serverDir);
  assert.equal(owner.status, "live");
  if (owner.status !== "live") throw new Error("successor has no owner");
  assert.equal(client.server!.instanceId, owner.owner.token);
  assert.equal(client.server!.build!.contentId, runtime.build.contentId);
  return { journal, client };
}

async function waiting(env: Env, reason: RegExp) {
  await waitFor(`maintenance deferral ${reason}`, () => reason.test(readFileSync(join(env.serverDir, "activation.log"), "utf8")));
  assert.equal(readActivationJournal(env.serverDir)?.phase, "prepared");
}

function reservations(env: Env) {
  const path = join(env.serverDir, "activation-reservations");
  return existsSync(path) ? readdirSync(path).filter(name => /^[a-f0-9]{64}$/.test(name)) : [];
}

// These are real extension hooks and activity providers in the private agent directory.
// Gates expose the preflight and shutdown awaits without replacing server/SDK code.
function installGates(env: Env) {
  writeFileSync(join(env.agentDir, "extensions", "activation-gates.ts"), `
    import { existsSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const dir = process.env.PI_FAKE_GATE_DIR;
    const path = name => join(dir, name);
    async function hold(name) {
      writeFileSync(path(name + ".started"), String(process.pid));
      while (!existsSync(path(name + ".release"))) await new Promise(resolve => setTimeout(resolve, 15));
      writeFileSync(path(name + ".finished"), String(process.pid));
    }
    export default function(pi) {
      pi.on("session_start", async () => {
        if (existsSync(path("create.hold"))) await hold("create");
        if (process.env.PI_SERVER_ACTIVATION_ID !== "initial" && existsSync(path("resume.hold"))) await hold("resume");
      });
      pi.registerCommand("observe", { description: "Register a gated activity provider", handler: async args => {
        let samples = 0;
        const delayedSample = Number(args.trim()) || 0;
        pi.events.emit("pi-better-goal:register-provider", {
          id: "activation-test", scope: "session",
          getActivity: async () => {
            samples++;
            if (existsSync(path("observe.hold")) && (!delayedSample || samples === delayedSample)) await hold("observe");
            writeFileSync(path("observe.sampled"), "1");
            return { items: [{ active: !existsSync(path("background.release")) }] };
          }
        });
      }});
    }
  `);
}

async function session(client: DaemonClient, env: Env) {
  const created = await client.call({ type: "create_session", cwd: env.cwd, model: { provider: "fake", modelId: "fake-1" } });
  assert.equal(created.success, true);
  await client.call({ type: "acquire_control", sessionId: created.sessionId! });
  await client.call({ type: "prompt", sessionId: created.sessionId!, message: "persist before activation" });
  return created.sessionId!;
}

test("legacy controller defers activation without fencing work, then detaching permits automatic upgrade", { timeout: 45_000 }, async t => {
  const env = fixture(t);
  const before = staged(env, "legacy-before"), after = staged(env, "legacy-after");
  const initial = await activate(env, before, "initial");
  const client = await connected(t, env, initial.readiness, false);
  const sessionId = await session(client, env);
  assert.equal((await activate(env, after, "legacy-upgrade")).status, "deferred");
  await waiting(env, /Waiting for legacy controllers to detach/);
  assert.equal((await client.call({ type: "prompt", sessionId, message: "work while deferred" })).success, true);
  assert.equal(client.server!.instanceId, initial.readiness.hello.instanceId);
  await client.call({ type: "release_control", sessionId });
  const ready = await successor(t, env, after);
  assert.deepEqual((await ready.client.call({ type: "list_sessions" })).data.sessions.map((item: any) => item.sessionId), [sessionId]);
});

test("pending session creation defers activation and finishes before successor adoption", { timeout: 45_000 }, async t => {
  const env = fixture(t);
  installGates(env);
  const before = staged(env, "create-before"), after = staged(env, "create-after");
  const initial = await activate(env, before, "initial");
  const client = await connected(t, env, initial.readiness);
  writeFileSync(join(env.gateDir, "create.hold"), "1");
  const creation = client.call({ type: "create_session", cwd: env.cwd, model: { provider: "fake", modelId: "fake-1" } });
  assert.equal((await activate(env, after, "create-upgrade")).status, "deferred");
  await waitFor("pending startup hook", gate(env, "create").started);
  await waiting(env, /Remote session operations are already in progress/);
  assert.equal((await client.call({ type: "list_sessions" })).success, true);
  assert.equal(gate(env, "create").finished(), false);
  gate(env, "create").release();
  const created = await creation;
  assert.equal(created.success, true);
  const ready = await successor(t, env, after);
  assert.deepEqual((await ready.client.call({ type: "list_sessions" })).data.sessions.map((item: any) => item.sessionId), [created.sessionId]);
});

test("pending dialog stays answerable and its result persists through automatic activation", { timeout: 45_000 }, async t => {
  const env = fixture(t);
  const before = staged(env, "dialog-before"), after = staged(env, "dialog-after");
  const client = await connected(t, env, (await activate(env, before, "initial")).readiness);
  const sessionId = await session(client, env);
  const prompt = client.call({ type: "prompt", sessionId, message: "ask upgrade answer" });
  const dialog = await waitFor("pending dialog", async () => (await client.call({ type: "get_state", sessionId })).data.needsInput[0]);
  assert.equal((await activate(env, after, "dialog-upgrade")).status, "deferred");
  await waiting(env, /Wait for remote dialogs to finish/);
  assert.equal((await client.call({ type: "extension_ui_response", sessionId, requestId: dialog.id, value: "keep this answer" })).success, true);
  assert.equal((await prompt).success, true);
  const ready = await successor(t, env, after);
  const snapshot = await ready.client.call({ type: "client_snapshot", sessionId });
  assert.match(JSON.stringify(snapshot.data.messages), /answer:keep this answer/);
});

test("pending background observation and active background work protect the owner without holding admission", { timeout: 45_000 }, async t => {
  const env = fixture(t);
  installGates(env);
  const before = staged(env, "activity-before"), after = staged(env, "activity-after");
  const client = await connected(t, env, (await activate(env, before, "initial")).readiness);
  const sessionId = await session(client, env);
  writeFileSync(join(env.gateDir, "observe.hold"), "1");
  assert.equal((await client.call({ type: "prompt", sessionId, message: "/observe" })).success, true);
  await waitFor("activity observation", gate(env, "observe").started);
  assert.equal((await activate(env, after, "activity-upgrade")).status, "deferred");
  await waiting(env, /Wait for remote activity observation to finish/);
  assert.equal((await client.call({ type: "prompt", sessionId, message: "swallow during observation" })).success, true);
  gate(env, "observe").release();
  await waiting(env, /Wait for remote model, tool, bash, compaction, background work and dialogs/);
  assert.equal((await client.call({ type: "prompt", sessionId, message: "swallow during background work" })).success, true);
  gate(env, "background").release();
  await successor(t, env, after);
});

test("an upgrade's fresh observation leaves admission open and rechecks work started during that await", { timeout: 45_000 }, async t => {
  const env = fixture(t);
  installGates(env);
  const before = staged(env, "observe-before"), after = staged(env, "observe-after");
  const client = await connected(t, env, (await activate(env, before, "initial")).readiness);
  const sessionId = await session(client, env);
  gate(env, "background").release();
  await client.call({ type: "prompt", sessionId, message: "/observe" });
  await waitFor("initial idle sample", () => existsSync(join(env.gateDir, "observe.sampled")));
  writeFileSync(join(env.gateDir, "observe.hold"), "1");
  assert.equal((await activate(env, after, "observe-upgrade")).status, "deferred");
  await waitFor("fresh upgrade observation", gate(env, "observe").started);
  const work = client.call({ type: "prompt", sessionId, message: "tool gated" });
  await waitFor("work admitted during observation", gate(env, "gated").started);
  gate(env, "observe").release();
  await waiting(env, /Wait for remote model, tool, bash, compaction, background work and dialogs/);
  assert.equal(gate(env, "gated").finished(), false, "the final idle check must preserve newly admitted work");
  gate(env, "gated").release();
  assert.equal((await work).success, true);
  const ready = await successor(t, env, after);
  assert.match(JSON.stringify((await ready.client.call({ type: "client_snapshot", sessionId })).data.messages), /gate:gated/);
});

test("a repeated activity observation during upgrade also leaves admission open", { timeout: 45_000 }, async t => {
  const env = fixture(t);
  installGates(env);
  const before = staged(env, "repeat-observe-before"), after = staged(env, "repeat-observe-after");
  const client = await connected(t, env, (await activate(env, before, "initial")).readiness);
  const sessionId = await session(client, env);
  gate(env, "background").release();
  // The provider can return quickly, then stall on a later sample. Fewer samples
  // are also valid: successful activation need not query it three times.
  await client.call({ type: "prompt", sessionId, message: "/observe 3" });
  await waitFor("initial idle sample", () => existsSync(join(env.gateDir, "observe.sampled")));
  writeFileSync(join(env.gateDir, "observe.hold"), "1");
  const activation = activate(env, after, "repeat-observe-upgrade");
  await waitFor("repeated sample or activation", () => gate(env, "observe").started() || readActivationJournal(env.serverDir)?.desiredBuild.contentId === after.build.contentId && readActivationJournal(env.serverDir)?.phase === "ready");
  if (gate(env, "observe").started()) {
    assert.equal((await client.call({ type: "prompt", sessionId, message: "swallow during repeated observation" })).success, true,
      "an asynchronous activity provider must not hold the idle admission fence");
    gate(env, "observe").release();
  }
  await activation;
  const ready = await successor(t, env, after);
  assert.match(JSON.stringify((await ready.client.call({ type: "client_snapshot", sessionId })).data.messages), /persist before activation/);
});

async function holdCoordinator(t: TestContext, env: Env) {
  mkdirSync(env.serverDir, { recursive: true });
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { claimDaemonOwner } from ${JSON.stringify(new URL("../src/daemon-owner.ts", import.meta.url).href)};
    const release = claimDaemonOwner(${JSON.stringify(env.serverDir)}, "activation-owner");
    process.on("message", () => { release(); process.exit(0); });
    process.send("ready");
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await once(child, "message");
  return async () => { const closed = once(child, "close"); child.send("release"); await closed; };
}

for (const otherCaller of [false, true]) {
  test(`precommit cancellation ${otherCaller ? "preserves a coalesced timeout reservation" : "removes the last reservation without launching"}`, { timeout: 30_000 }, async t => {
    const env = fixture(t);
    const runtime = staged(env, `cancel-${otherCaller}`);
    const release = await holdCoordinator(t, env);
    if (otherCaller) {
      const timeout = await run(env, runtime, [...activationArgs(runtime, env.agentDir, env.serverDir, "same-operation"), "--timeout-ms", "1"]).result;
      assert.equal(timeout.status, "deferred");
      assert.equal(reservations(env).length, 1);
    }
    const caller = run(env, runtime, activationArgs(runtime, env.agentDir, env.serverDir, "same-operation"), 1);
    await waitFor("observer reservation", () => reservations(env).length === (otherCaller ? 2 : 1));
    caller.child.kill("SIGTERM");
    assert.match(await caller.result, /aborted/);
    assert.equal(reservations(env).length, otherCaller ? 1 : 0);
    await release();
    const worker = await run(env, runtime, ["activation-worker", "--runtime", runtime.manifestPath, "--server-dir", env.serverDir, "--agent-dir", env.agentDir, "--operation-id", "same-operation"]).result;
    if (otherCaller) {
      assert.ok(["ready", "deferred"].includes(worker.status), JSON.stringify(worker));
      await successor(t, env, runtime);
      assert.equal(reservations(env).length, 0);
    } else {
      assert.equal(worker.status, "deferred");
      assert.match(worker.reason, /reservation is no longer present|Activation coordinator already owns this directory/);
      await waitFor("cancelled activation coordinators finish without launching", () => inspectDaemonOwner(env.serverDir, "activation-owner").status !== "live");
      assert.equal(inspectDaemonOwner(env.serverDir).status, "missing");
      assert.equal(readActivationJournal(env.serverDir), undefined);
    }
  });
}

test("caller timeout retains a reservation across the previous ready journal and automatically activates", { timeout: 45_000 }, async t => {
  const env = fixture(t);
  const before = staged(env, "timeout-before"), after = staged(env, "timeout-after");
  const initial = await activate(env, before, "initial");
  const timedOut = await run(env, after, [...activationArgs(after, env.agentDir, env.serverDir, "timeout-upgrade"), "--timeout-ms", "1"]).result;
  assert.equal(timedOut.status, "deferred");
  assert.equal(timedOut.operationId, "timeout-upgrade", "a timeout must identify the requested activation, not the previous ready journal");
  const ready = await successor(t, env, after);
  assert.notEqual(ready.journal.readiness!.hello.instanceId, initial.readiness.hello.instanceId);
});

test("committed activation survives observer cancellation and waits for shutdown owner release before adoption", { timeout: 45_000 }, async t => {
  const env = fixture(t);
  installGates(env);
  const before = staged(env, "shutdown-before"), after = staged(env, "shutdown-after");
  // Delay return from the real shutdown boundary after its work finishes. Owner release
  // is server-owned and must remain later, even when shutdown takes another async turn.
  const preload = join(env.root, "shutdown-gate.mjs");
  writeFileSync(preload, `
    if (process.env.PI_SERVER_RUNTIME_MANIFEST === ${JSON.stringify(before.manifestPath)}) {
      const { SessionRegistry } = await import(${JSON.stringify(pathToFileURL(join(before.root, "src/registry.ts")).href)});
      const { existsSync, writeFileSync } = await import("node:fs");
      const shutdown = SessionRegistry.prototype.shutdown;
      SessionRegistry.prototype.shutdown = async function() {
        await shutdown.call(this);
        writeFileSync(${JSON.stringify(join(env.gateDir, "shutdown.started"))}, String(process.pid));
        while (!existsSync(${JSON.stringify(join(env.gateDir, "shutdown.release"))})) await new Promise(resolve => setTimeout(resolve, 15));
      };
    }
  `);
  env.vars.NODE_OPTIONS = `--import=${preload}`;
  const initial = await activate(env, before, "initial");
  const client = await connected(t, env, initial.readiness);
  await session(client, env);
  const pending = activate(env, after, "shutdown-upgrade");
  await waitFor("old owner shutdown hook", gate(env, "shutdown").started);
  const old = inspectDaemonOwner(env.serverDir);
  assert.equal(old.status, "live");
  if (old.status !== "live") throw new Error("old owner released too early");
  assert.equal(old.owner.token, initial.readiness.hello.instanceId);
  assert.equal(readActivationJournal(env.serverDir)?.phase, "stopping");
  const count = reservations(env).length;
  const observer = run(env, after, activationArgs(after, env.agentDir, env.serverDir, "cancel-after-commit"), 1);
  await waitFor("committed observer reservation", () => reservations(env).length === count + 1);
  observer.child.kill("SIGTERM");
  assert.match(await observer.result, /aborted/);
  assert.equal(readActivationJournal(env.serverDir)?.phase, "stopping");
  assert.deepEqual(inspectDaemonOwner(env.serverDir), old);
  gate(env, "shutdown").release();
  await pending;
  const ready = await successor(t, env, after);
  assert.notEqual(ready.journal.candidateOwner!.token, old.owner.token);
});

test("coordinator recovery preserves the adopted candidate during startup work and reconciles that exact owner", { timeout: 45_000 }, async t => {
  const env = fixture(t);
  installGates(env);
  const before = staged(env, "recovery-before"), after = staged(env, "recovery-after");
  const client = await connected(t, env, (await activate(env, before, "initial")).readiness);
  const sessionId = await session(client, env);
  writeFileSync(join(env.gateDir, "resume.hold"), "1");
  const pending = activate(env, after, "recovery-upgrade");
  await waitFor("adopted startup hook", gate(env, "resume").started);
  const adopted = readActivationJournal(env.serverDir)!;
  assert.equal(adopted.phase, "adopted");
  assert.equal(adopted.candidateOwner!.pid, Number(readFileSync(join(env.gateDir, "resume.started"), "utf8")));
  const coordinator = inspectDaemonOwner(env.serverDir, "activation-owner");
  assert.equal(coordinator.status, "live");
  if (coordinator.status !== "live") throw new Error("coordinator missing");
  process.kill(coordinator.owner.pid, "SIGKILL");
  await waitFor("coordinator exit", () => inspectDaemonOwner(env.serverDir, "activation-owner").status === "dead");
  const args = ["activation-worker", "--runtime", after.manifestPath, "--server-dir", env.serverDir, "--agent-dir", env.agentDir, "--operation-id", "recovery-upgrade"];
  assert.equal((await run(env, after, args).result).status, "recovery-required");
  assert.deepEqual(inspectDaemonOwner(env.serverDir), { status: "live", owner: adopted.candidateOwner });
  assert.equal(gate(env, "resume").finished(), false);
  gate(env, "resume").release();
  await waitFor("candidate listener", () => existsSync(join(env.serverDir, "pi-server.sock")));
  assert.equal((await run(env, after, args).result).status, "ready");
  await pending;
  const ready = await successor(t, env, after);
  assert.deepEqual(ready.journal.candidateOwner, adopted.candidateOwner);
  assert.deepEqual((await ready.client.call({ type: "list_sessions" })).data.sessions.map((item: any) => item.sessionId), [sessionId]);
});
