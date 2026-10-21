import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createAgentSession, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MaintenanceBusyError } from "../src/maintenance.ts";
import { NativeClientHost } from "../src/remote-client/host.ts";
import { SessionRegistry } from "../src/registry.ts";
import type { IdleSessionsLease } from "../src/startup/managed-types.ts";
import { gate, makeEnv, waitFor } from "./helpers.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function setup(t: TestContext, initialize?: (pi: ExtensionAPI, ctx: ExtensionContext) => void) {
  const previous = { ...process.env };
  const env = makeEnv();
  Object.assign(process.env, env.vars);
  mkdirSync(env.serverDir);
  let pi!: ExtensionAPI;
  let ctx!: ExtensionContext;
  const callbacks = globalThis as unknown as Record<string, unknown>;
  callbacks[env.root] = (api: ExtensionAPI, context: ExtensionContext) => { pi = api; ctx = context; initialize?.(pi, ctx); };
  writeFileSync(join(env.agentDir, "extensions", "maintenance.ts"), `export default function(pi) {
    pi.on("session_start", (_event, ctx) => globalThis[${JSON.stringify(env.root)}](pi, ctx));
  }`);
  let now = 100;
  const registry = new SessionRegistry({ serverDir: env.serverDir, sessionIdleMs: 100, now: () => now });
  t.after(async () => {
    gate(env, "gated").release();
    await registry.shutdown();
    delete callbacks[env.root];
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  const summary = await registry.create({ type: "create_session", cwd: env.cwd, model: { provider: "fake", modelId: "fake-1" } });
  const hosted = registry.get(summary.sessionId)!;
  await hosted.session.prompt("persisted history");
  return { env, registry, hosted, sdk: hosted.session, get pi() { return pi; }, get ctx() { return ctx; }, at: (value: number) => { now = value; }, idle: () => registry.maintenance.withIdleSessions("upgrade", async () => "idle") };
}

function busy(reason: MaintenanceBusyError["reason"]) {
  return (error: unknown) => error instanceof MaintenanceBusyError && error.reason === reason;
}

test("one gate excludes native reload, registry mutation and retained SDK calls without touching inactivity", async t => {
  const f = await setup(t);
  const sdk = f.sdk;
  const prompt = sdk.prompt.bind(sdk);
  const before = f.registry.entry(sdk.sessionId)!.lastActivityAt;
  const native = new NativeClientHost(f.registry);
  f.at(500);
  await f.registry.maintenance.withIdleSessions("upgrade", async (_sessions, lease) => {
    assert.equal(native.busy, true);
    assert.throws(() => native.enterSessionOperation(), busy("maintenance"));
    await assert.rejects(native.reload(sdk.sessionId), busy("maintenance"));
    await assert.rejects(f.registry.create({ type: "create_session", cwd: f.env.cwd }), busy("maintenance"));
    await assert.rejects(f.registry.open(sdk.sessionId), busy("maintenance"));
    await assert.rejects(f.registry.adopt({ ...f.registry.entry(sdk.sessionId)!, sessionId: "incoming" }), busy("maintenance"));
    await assert.rejects(f.registry.retire(sdk.sessionId), busy("maintenance"));
    await assert.rejects(prompt("must not run"), busy("maintenance"));
    assert.equal((await f.hosted.handle({ type: "prompt", message: "denied dispatch" })).success, false);
    assert.equal(f.registry.entry(sdk.sessionId)!.lastActivityAt, before);
    assert.deepEqual(await f.registry.expireIdle(), []);
    await lease.refreshIdle();
  });
  assert.equal(native.busy, false);
  await prompt("admission restored");
  assert.equal(sdk.getLastAssistantText(), "echo:admission restored");
});

test("an upgrade observation rechecks sessions created while admission was open", async t => {
  const f = await setup(t);
  const observation = deferred();
  let waiting = false;
  let observe = false;
  f.pi.events.emit("pi-better-goal:register-provider", {
    id: "changing-live-set", scope: "session", getActivity: async () => {
      if (observe) { waiting = true; await observation.promise; }
      return { items: [] };
    },
  });
  await f.hosted.refreshActivity();
  observe = true;
  const pending = f.idle();
  const rejected = assert.rejects(pending, busy("operations"));
  await waitFor("upgrade is observing without admission", () => waiting);
  assert.equal(f.registry.maintenance.busy, false);
  const created = await f.registry.create({ type: "create_session", cwd: f.env.cwd, model: { provider: "fake", modelId: "fake-1" } });
  observation.resolve();
  await rejected;
  assert.ok(f.registry.get(created.sessionId));
  assert.equal(f.registry.maintenance.busy, false);
  await f.sdk.prompt("work remains admitted");
});

test("a superseded observer cannot clear maintenance acquired after its session closes", async t => {
  const f = await setup(t);
  const observation = deferred();
  let waiting = false;
  let observe = false;
  f.pi.events.emit("pi-better-goal:register-provider", {
    id: "overlapping-observation", scope: "session", getActivity: async () => {
      if (observe) { waiting = true; await observation.promise; }
      return { items: [] };
    },
  });
  await f.hosted.refreshActivity();
  observe = true;
  const pending = f.idle();
  const rejected = assert.rejects(pending, busy("maintenance"));
  await waitFor("old upgrade observation", () => waiting);
  await f.registry.close(f.sdk.sessionId);
  await waitFor("explicit close serialization releases", () => !f.registry.hasPendingOperations);
  await f.registry.maintenance.withIdleSessions("packages", async () => {
    observation.resolve();
    await rejected;
    assert.equal(f.registry.maintenance.busy, true);
    assert.throws(() => f.registry.maintenance.enterSessionOperation(), busy("maintenance"));
  });
  assert.equal(f.registry.maintenance.busy, false);
});

test("an unawaited refresh cannot acquire an upgrade fence after its lease expires", async t => {
  const f = await setup(t);
  const observation = deferred();
  let observe = false;
  f.pi.events.emit("pi-better-goal:register-provider", {
    id: "expired-observation", scope: "session", getActivity: async () => {
      if (observe) await observation.promise;
      return { items: [] };
    },
  });
  await f.hosted.refreshActivity();
  let expired!: Promise<void>;
  let rejected!: Promise<void>;
  await f.registry.maintenance.withIdleSessions("upgrade", async (_sessions, lease) => {
    observe = true;
    expired = lease.refreshIdle();
    rejected = assert.rejects(expired, /lease has expired/);
  });
  assert.equal(f.registry.maintenance.busy, false);
  const release = f.registry.maintenance.enterSessionOperation();
  release();
  observation.resolve();
  await rejected;
  assert.equal(f.registry.maintenance.busy, false);
  assert.equal(await f.idle(), "idle");
});

test("stop commit is synchronous, permanent after callback failure, and permits sequenced upgrade publication", async t => {
  const f = await setup(t);
  const before = readFileSync(f.sdk.sessionFile!, "utf8");
  const manager = f.sdk.sessionManager;
  const writer = manager as unknown as { _persist(entry: unknown): void; _rewriteFile(): void };
  const persist = writer._persist.bind(manager);
  const rewrite = writer._rewriteFile.bind(manager);
  const append = manager.appendCustomEntry.bind(manager);
  const setName = f.sdk.setSessionName.bind(f.sdk);
  const prompt = f.sdk.prompt.bind(f.sdk);
  const oldPi = f.pi;
  let lease!: IdleSessionsLease;
  const notices: unknown[] = [];
  const subscription = f.hosted.subscribe(f.hosted.lastSeq, event => notices.push(event));
  t.after(subscription.unsubscribe);
  const seq = f.hosted.lastSeq;
  const generation = f.hosted.generation;
  const activity = f.registry.entry(f.sdk.sessionId)!.lastActivityAt;
  await assert.rejects(f.registry.maintenance.withIdleSessions("upgrade", async (_sessions, held) => {
    lease = held;
    assert.equal(held.commitStop(), undefined);
    assert.throws(() => f.registry.maintenance.enterSessionOperation(), busy("stopping"));
    assert.throws(() => setName("late name"), /closed/);
    f.hosted.publishRuntimeEvent({ type: "server_upgrading", operationId: "test-upgrade" });
    throw new Error("activation failure after claim");
  }), /activation failure after claim/);
  assert.equal(f.registry.maintenance.busy, true);
  assert.throws(() => lease.commitStop(), /expired/);
  await assert.rejects(prompt("late prompt"), /closed/);
  await assert.rejects(f.registry.create({ type: "create_session" }), busy("stopping"));
  await assert.rejects(f.registry.open(f.sdk.sessionId), busy("stopping"));
  assert.equal((await f.hosted.handle({ type: "set_session_name", name: "late metadata" })).success, false);
  append("late", {});
  oldPi.appendEntry("late callback", {});
  persist({ type: "custom", id: "late-private-write" });
  rewrite();
  assert.equal(readFileSync(f.sdk.sessionFile!, "utf8"), before);
  assert.equal(f.registry.entry(f.sdk.sessionId)!.lastActivityAt, activity);
  assert.equal(f.hosted.generation, generation);
  assert.equal(f.hosted.lastSeq, seq + 1);
  assert.equal(notices.length, 1);
  assert.deepEqual(f.hosted.subscribe(seq, () => {}).replay.events.map(item => item.event), [{ type: "server_upgrading", operationId: "test-upgrade" }]);
  await f.registry.shutdown();
  const releasedSeq = f.hosted.lastSeq;
  f.hosted.publishRuntimeEvent({ type: "late upgrade notice" });
  assert.equal(f.hosted.lastSeq, releasedSeq);
  append("after disposal", {});
  rewrite();
  assert.equal(readFileSync(f.sdk.sessionFile!, "utf8"), before);
});

test("an uncommitted failure releases the gate and expired leases cannot stop a later runtime", async t => {
  const f = await setup(t);
  let old!: IdleSessionsLease;
  await assert.rejects(f.registry.maintenance.withIdleSessions("upgrade", async (_sessions, lease) => { old = lease; throw new Error("staging failed"); }), /staging failed/);
  assert.equal(f.registry.maintenance.busy, false);
  assert.throws(() => old.commitStop(), /expired/);
  assert.equal(await f.idle(), "idle");
  await f.registry.maintenance.withIdleSessions("reload", async (_sessions, lease) => assert.throws(() => lease.commitStop(), /Only upgrade/));
});

test("already admitted native operations and pending registry startup defer immediately", async t => {
  const f = await setup(t);
  const release = new NativeClientHost(f.registry).enterSessionOperation();
  await assert.rejects(f.idle(), busy("operations"));
  release(); release();
  const creation = f.registry.create({ type: "create_session", cwd: f.env.cwd });
  await assert.rejects(f.idle(), busy("operations"));
  await creation;
  assert.equal(await f.idle(), "idle");
});

for (const kind of ["prompt", "model", "compaction"] as const) {
  test(`an admitted SDK ${kind} counts as busy during its auth prolog`, async t => {
    const f = await setup(t);
    if (kind === "compaction") {
      await f.sdk.prompt("another message to compact");
      f.sdk.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 0 } });
    }
    const entered = deferred();
    const release = deferred();
    const runtime = f.sdk.modelRuntime;
    const key = kind === "model" ? "checkAuth" : "getAuth";
    const original = runtime[key].bind(runtime);
    // The external authentication boundary holds the real SDK before its work flags can settle.
    (runtime as any)[key] = async (...args: unknown[]) => { entered.resolve(); await release.promise; return (original as any)(...args); };
    t.after(() => { release.resolve(); (runtime as any)[key] = original; });
    const work = kind === "prompt" ? f.sdk.prompt("auth held") : kind === "model" ? f.sdk.setModel(f.sdk.model!) : f.sdk.compact();
    const settled = work;
    // Attach a rejection handler immediately; the assertion below still observes any failure.
    void settled.catch(() => undefined);
    await entered.promise;
    await assert.rejects(f.idle(), busy("work"));
    assert.equal(f.registry.maintenance.busy, false);
    release.resolve();
    await settled;
    assert.equal(await f.idle(), "idle");
  });
}

test("retained work entry points and extension callbacks cannot start, queue or execute while held", async t => {
  const f = await setup(t);
  const sdk = f.sdk;
  const calls: Array<() => Promise<unknown>> = [
    sdk.prompt.bind(sdk, "denied"), sdk.sendUserMessage.bind(sdk, "denied"),
    sdk.steer.bind(sdk, "denied"), sdk.followUp.bind(sdk, "denied"),
    sdk.executeBash.bind(sdk, "printf denied"), sdk.compact.bind(sdk),
    sdk.setModel.bind(sdk, sdk.model!), sdk.cycleModel.bind(sdk),
    sdk.navigateTree.bind(sdk, sdk.sessionManager.getLeafId()!, { summarize: true }),
    sdk.sendCustomMessage.bind(sdk, { customType: "queued", content: "denied", display: true }, { deliverAs: "nextTurn" }),
    sdk.agent.prompt.bind(sdk.agent, "denied"),
  ];
  const definition = sdk.getToolDefinition("gate")!;
  const executable = sdk.agent.state.tools.find(item => item.name === "gate")!;
  const registered = sdk.extensionRunner.getAllRegisteredTools().find(item => item.definition.name === "gate")!.definition;
  assert.ok(definition && executable && registered, "real tool entry points must exist");
  const executions = [definition.execute.bind(definition), executable.execute.bind(executable), registered.execute.bind(registered)];
  const errors: string[] = [];
  const off = sdk.extensionRunner.onError(error => errors.push(error.event));
  t.after(off);
  const pi = f.pi;
  const ctx = f.ctx;
  await f.registry.maintenance.withIdleSessions("reload", async () => {
    for (const call of calls) await assert.rejects(Promise.resolve().then(() => call()), /maintenance/);
    for (const execute of executions) await assert.rejects(Promise.resolve().then(() => (execute as any)("held", { name: "gated" }, undefined, undefined, ctx)), /maintenance/);
    pi.sendUserMessage("denied extension");
    pi.sendMessage({ customType: "trigger", content: "denied", display: true }, { triggerTurn: true });
    await new Promise<void>(resolve => ctx.compact({ onError: error => { assert.match(error.message, /maintenance/); resolve(); }, onComplete: () => assert.fail("compaction started") }));
    assert.equal(pi.setSessionName("initialization metadata"), undefined);
    assert.equal(pi.setThinkingLevel("off"), undefined);
    pi.appendEntry("initialization", { allowed: true });
    assert.equal(sdk.sessionName, "initialization metadata");
    assert.equal(sdk.pendingMessageCount, 0);
    assert.equal(gate(f.env, "gated").started(), false);
  });
  assert.deepEqual(errors.sort(), ["send_message", "send_user_message"]);
});

test("already running tools and queued messages defer without abort or consuming the queue", async t => {
  const f = await setup(t);
  const work = f.sdk.prompt("tool gated");
  await waitFor("tool started", gate(f.env, "gated").started);
  await assert.rejects(f.idle(), busy("work"));
  assert.equal(gate(f.env, "gated").finished(), false);
  gate(f.env, "gated").release();
  await work;
  await f.sdk.followUp("queued");
  assert.equal(f.sdk.pendingMessageCount, 1);
  await assert.rejects(f.idle(), busy("work"));
  assert.equal(f.sdk.pendingMessageCount, 1);
  f.sdk.clearQueue();
  assert.equal(await f.idle(), "idle");
});

test("already admitted bash and direct extension commands defer without cancellation", async t => {
  const f = await setup(t);
  const bashGate = gate(f.env, "bash");
  t.after(bashGate.release);
  const script = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(join(f.env.gateDir, "bash.started"))}, ''); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(join(f.env.gateDir, "bash.release"))})) { clearInterval(timer); process.stdout.write('finished'); } }, 10);`;
  const bash = f.sdk.executeBash(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`);
  await waitFor("bash started", bashGate.started);
  await assert.rejects(f.idle(), busy("work"));
  assert.equal(f.sdk.isBashRunning, true);
  bashGate.release();
  assert.equal((await bash).output, "finished");
  const runner = f.sdk.extensionRunner;
  const command = runner.getCommand("slow")!.handler;
  t.after(() => gate(f.env, "slow").release());
  const work = command("slow", runner.createCommandContext());
  await waitFor("extension command started", gate(f.env, "slow").started);
  await assert.rejects(f.idle(), busy("operations"));
  gate(f.env, "slow").release();
  await work;
  await f.registry.maintenance.withIdleSessions("upgrade", async () => {
    await assert.rejects(command("", runner.createCommandContext()), busy("maintenance"));
  });
});

test("an admitted snapshot authentication lookup prevents commit until it returns", async t => {
  const f = await setup(t);
  const entered = deferred();
  const release = deferred();
  t.after(release.resolve);
  const original = f.sdk.modelRuntime.getAvailable.bind(f.sdk.modelRuntime);
  f.sdk.modelRuntime.getAvailable = async () => { entered.resolve(); await release.promise; return original(); };
  const snapshot = f.hosted.clientSnapshot();
  await entered.promise;
  await assert.rejects(f.idle(), busy("work"));
  release.resolve();
  assert.equal((await snapshot).sessionId, f.sdk.sessionId);
  assert.equal(await f.idle(), "idle");
});

test("a pending dialog defers upgrade and remains answerable", async t => {
  const f = await setup(t);
  const dialog = f.ctx.ui.confirm("Upgrade", "Finish this first");
  await assert.rejects(f.idle(), busy("dialog"));
  assert.equal(f.hosted.answerDialog(f.hosted.needsInput[0]!.id, { confirmed: true }), true);
  assert.equal(await dialog, true);
  assert.equal(await f.idle(), "idle");
});

test("provider failures and pending observations never establish idle", async t => {
  const f = await setup(t);
  const release = deferred();
  t.after(release.resolve);
  let fail = false;
  f.pi.events.emit("pi-better-goal:register-provider", { id: "maintenance-provider", scope: "session", getActivity: async () => {
    await release.promise;
    if (fail) throw new Error("observer unavailable");
    return { items: [] };
  } });
  await assert.rejects(f.idle(), busy("activity"));
  release.resolve();
  await f.hosted.refreshActivity();
  fail = true;
  await assert.rejects(f.idle(), busy("work"));
  fail = false;
  await f.hosted.refreshActivity();
  assert.equal(await f.idle(), "idle");
});

test("async runtime listeners prevent upgrade and stopped listeners cannot write late metadata", async t => {
  const f = await setup(t);
  const release = deferred();
  t.after(release.resolve);
  let finished = false;
  f.pi.events.on("maintenance:async", async () => { await release.promise; finished = true; });
  f.pi.events.emit("maintenance:async", {});
  await assert.rejects(f.idle(), busy("work"));
  release.resolve();
  await waitFor("async callback settles", () => finished && !f.hosted.executionActive);
  let callbacks = 0;
  f.pi.events.on("maintenance:late", () => { callbacks++; f.pi.appendEntry("late", {}); });
  await f.registry.maintenance.withIdleSessions("upgrade", async (_sessions, lease) => { lease.commitStop(); });
  f.pi.events.emit("maintenance:late", {});
  assert.equal(callbacks, 0);
});

test("an active expiry owns serialization; maintenance then skips new expiry without resetting the idle clock", async t => {
  const f = await setup(t);
  const release = deferred();
  const entered = deferred();
  t.after(release.resolve);
  let hold = false;
  f.pi.events.emit("pi-better-goal:register-provider", { id: "expiry", scope: "session", getActivity: async () => {
    if (hold) { entered.resolve(); await release.promise; }
    return { items: [] };
  } });
  await f.hosted.refreshActivity();
  hold = true;
  f.at(199);
  const expiry = f.registry.expireIdle();
  await entered.promise;
  await assert.rejects(f.idle(), busy("operations"));
  release.resolve();
  assert.deepEqual(await expiry, []);
  const activity = f.registry.entry(f.sdk.sessionId)!.lastActivityAt;
  f.at(200);
  await f.registry.maintenance.withIdleSessions("upgrade", async () => assert.deepEqual(await f.registry.expireIdle(), []));
  assert.equal(f.registry.entry(f.sdk.sessionId)!.lastActivityAt, activity);
  assert.deepEqual(await f.registry.expireIdle(), [f.sdk.sessionId]);
});

test("unsupported persistence ABI defers upgrade while unknown nonhosted SDK sessions remain usable", async t => {
  const f = await setup(t);
  const manager = SessionManager.inMemory(f.env.cwd);
  Object.defineProperty(manager, "_persist", { value: () => undefined, configurable: true });
  f.registry.maintenance.registerManager(manager);
  // A registered manager with unsupported private writers must never be claimed safe.
  const realManager = f.sdk.sessionManager;
  const descriptor = Object.getOwnPropertyDescriptor(f.sdk, "sessionManager")!;
  Object.defineProperty(f.sdk, "sessionManager", { ...descriptor, value: manager });
  try { await assert.rejects(f.idle(), busy("unsupported-sdk")); }
  finally { Object.defineProperty(f.sdk, "sessionManager", { ...descriptor, value: realManager }); }
  const { session: standalone } = await createAgentSession({ cwd: f.env.cwd, model: f.sdk.model, modelRuntime: f.sdk.modelRuntime, sessionManager: SessionManager.inMemory(f.env.cwd) });
  t.after(() => standalone.dispose());
  await f.registry.maintenance.withIdleSessions("upgrade", async () => {
    assert.equal(standalone.setSessionName("not hosted"), undefined);
    await standalone.prompt("standalone");
    assert.equal(standalone.getLastAssistantText(), "echo:standalone");
  });
});
