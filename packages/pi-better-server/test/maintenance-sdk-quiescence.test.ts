import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hostedSdkCalls, MaintenanceBusyError } from "../src/maintenance.ts";
import { SessionRegistry } from "../src/registry.ts";
import { gate, makeEnv, waitFor } from "./helpers.ts";

// Run with maintenance.test.ts against SDK 0.82.1 and the isolated native 1.2.0.
// The latter uses Node's type stripping (no tsx inherited declaration-path aliases).
// Regression evidence: without full refresh tracking, all four cancel/replace
// cases below accept idle while their decision/provider promise is still held.
const sdk12 = /^1\.2\./.test(VERSION);
const busy = (error: unknown) => error instanceof MaintenanceBusyError && error.reason === "work";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function setup(t: TestContext, initialize: (pi: ExtensionAPI) => void = () => {}, cacheWarming?: "idle") {
  const previous = { ...process.env };
  const env = makeEnv();
  Object.assign(process.env, env.vars);
  mkdirSync(env.serverDir);
  if (cacheWarming) writeFileSync(join(env.agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-1", cacheWarming }));
  const callbacks = globalThis as unknown as Record<string, unknown>;
  callbacks[env.root] = initialize;
  writeFileSync(join(env.agentDir, "extensions", "quiescence.ts"), `export default function(pi) { globalThis[${JSON.stringify(env.root)}](pi); }`);
  const registry = new SessionRegistry({ serverDir: env.serverDir });
  t.after(async () => {
    gate(env, "direct").release();
    await registry.shutdown();
    delete callbacks[env.root];
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  const summary = await registry.create({ type: "create_session", cwd: env.cwd, model: { provider: "fake", modelId: "fake-1" } });
  const sdk = registry.get(summary.sessionId)!.session;
  await sdk.prompt("initial history");
  return { env, registry, sdk, idle: () => registry.maintenance.withIdleSessions("upgrade", async () => "idle") };
}

test(`SDK ${VERSION}: auth preflight is busy even when public idle wait resolves`, async t => {
  const entered = deferred(), release = deferred();
  t.after(release.resolve);
  const f = await setup(t);
  const runtime = f.sdk.modelRuntime as any;
  const name = "checkAuth";
  const original = runtime[name].bind(runtime);
  runtime.hasConfiguredAuth = () => false;
  runtime[name] = async (...args: unknown[]) => { entered.resolve(); await release.promise; return original(...args); };
  const work = f.sdk.prompt("held authentication");
  await entered.promise;
  assert.equal(f.sdk.isIdle, true);
  await f.sdk.waitForIdle();
  await assert.rejects(f.idle(), busy);
  release.resolve();
  await work;
  assert.equal(await f.idle(), "idle");
});

test(`SDK ${VERSION}: originating prompt owns settlement after public idle`, async t => {
  const entered = deferred(), release = deferred();
  t.after(release.resolve);
  let hold = false;
  const f = await setup(t, pi => (pi as any).on("agent_settled", async () => {
    if (hold) { entered.resolve(); await release.promise; }
  }));
  hold = true;
  let settled = false;
  const work = f.sdk.prompt("settlement held").then(() => { settled = true; });
  await entered.promise;
  assert.equal(f.sdk.isIdle, true);
  await f.sdk.waitForIdle();
  assert.equal(settled, false);
  await assert.rejects(f.idle(), busy);
  release.resolve();
  await work;
  assert.equal(await f.idle(), "idle");
});

test("SDK 1.2: originating prompt owns deferred settled actions through their preflight", { skip: !sdk12 }, async t => {
  const entered = deferred(), release = deferred();
  t.after(release.resolve);
  let queue = false;
  let sdk: any;
  const f = await setup(t, pi => {
    (pi as any).on("agent_settled", async () => {
      if (queue) { queue = false; await sdk.prompt("deferred input"); }
    });
    pi.on("input", async event => {
      if (event.text === "deferred input") { entered.resolve(); await release.promise; }
      return { action: "continue" };
    });
  });
  sdk = f.sdk;
  queue = true;
  let settled = false;
  const work = sdk.prompt("origin").then(() => { settled = true; });
  await entered.promise;
  await sdk.waitForIdle();
  assert.equal(sdk.isIdle, true);
  assert.equal(settled, false);
  await assert.rejects(f.idle(), busy);
  release.resolve();
  await work;
  assert.equal(sdk.getLastAssistantText(), "echo:deferred input");
  assert.equal(await f.idle(), "idle");
});

for (const entry of ["prompt", "continue", "definition", "executable", "nested"] as const) {
  test(`SDK ${VERSION}: direct ${entry} stays counted and its retained handle is fenced`, { skip: entry === "nested" && !sdk12 }, async t => {
    let nested: (() => Promise<unknown>) | undefined;
    const f = await setup(t, pi => pi.registerTool({
      name: "capture_nested", label: "Capture", description: "Capture the SDK nested tool context",
      parameters: { type: "object", properties: {} } as any,
      async execute(_id, _args, _signal, _update, ctx) {
        nested = () => (ctx as any).executeTool("gate", { name: "direct" });
        return { content: [{ type: "text", text: "captured" }], details: {} };
      },
    }));
    const agent = f.sdk.agent;
    let call: () => Promise<unknown>;
    if (entry === "prompt") call = agent.prompt.bind(agent, "tool direct");
    else if (entry === "continue") {
      agent.followUp({ role: "user", content: "tool direct", timestamp: Date.now() });
      call = agent.continue.bind(agent);
    } else if (entry === "nested") {
      const capture = agent.state.tools.find(tool => tool.name === "capture_nested")!;
      await capture.execute("capture", {}, undefined);
      assert.ok(nested);
      call = nested;
    } else {
      const tool = entry === "definition" ? f.sdk.getToolDefinition("gate")! : agent.state.tools.find(tool => tool.name === "gate")!;
      call = (tool.execute as any).bind(tool, "direct", { name: "direct" }, undefined, undefined, f.sdk.extensionRunner.createContext());
    }
    const work = call();
    await waitFor("direct tool entered", gate(f.env, "direct").started);
    assert.ok(hostedSdkCalls(f.sdk) > 0);
    await assert.rejects(f.idle(), busy);
    assert.equal(gate(f.env, "direct").finished(), false);
    gate(f.env, "direct").release();
    await work;
    await f.registry.maintenance.withIdleSessions("upgrade", async (_sessions, lease) => { lease.commitStop(); });
    await assert.rejects(Promise.resolve().then(call), /closed/);
  });
}

// These tests use the native warmer and timer. Only the provider/extension decision
// boundaries and the clock are controlled; status and refresh lifecycle stay real.
async function warming(t: TestContext, phase: "provider" | "decision") {
  const entered = deferred(), release = deferred();
  t.after(release.resolve);
  const f = await setup(t, undefined, "idle");
  const warmer = (f.sdk as any)._cacheWarmer;
  assert.ok(warmer, "SDK 1.2 factory must supply its native CacheWarmer");
  const settingsBefore = readFileSync(join(f.env.agentDir, "settings.json"), "utf8");
  let providerCalls = 0;
  let signal!: AbortSignal;
  const original = f.sdk.modelRuntime.streamSimple.bind(f.sdk.modelRuntime);
  (f.sdk.modelRuntime as any).streamSimple = (model: any, context: any, options: any) => {
    providerCalls++;
    signal = options.signal;
    return { result: async () => {
      if (phase === "provider") { entered.resolve(); await release.promise; }
      return original(model, context, options).result();
    } };
  };
  warmer.decide = async () => {
    if (phase === "decision") { entered.resolve(); await release.promise; }
    return "warm";
  };
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  let current = true;
  const request = {
    model: { ...f.sdk.model!, promptCache: { short: 60 }, cost: { input: 100000, output: 1, cacheRead: 1, cacheWrite: 100000 } },
    context: { messages: [{ role: "user", content: "warm", timestamp: Date.now() }] }, options: {},
  };
  const start = warmer.start.bind(warmer, request, () => current);
  start();
  const run = warmer.run;
  const refresh = warmer.refresh.bind(warmer, run);
  const schedule = warmer.schedule.bind(warmer, run);
  return { ...f, warmer, entered, release, start, refresh, schedule, run, settingsBefore,
    advance: () => t.mock.timers.tick(50_000), invalidate: () => { current = false; },
    providerCalls: () => providerCalls, signal: () => signal,
    settled: async () => { release.resolve(); await waitFor("refresh fully settled", () => hostedSdkCalls(f.sdk) === 0); },
  };
}

for (const [phase, drop] of [["provider", "cancel"], ["provider", "replace"], ["decision", "cancel"], ["decision", "replace"]] as const) {
  test(`SDK 1.2: native warm ${phase} promise remains busy after inactive status and ${drop}`, { skip: !sdk12 }, async t => {
    const f = await warming(t, phase);
    assert.equal((f.sdk as any).cacheWarmingStatus.state, "scheduled");
    await assert.rejects(f.idle(), busy);
    f.advance();
    await f.entered.promise;
    assert.equal((f.sdk as any).cacheWarmingStatus.state, "refreshing");
    f.invalidate();
    assert.equal((f.sdk as any).cacheWarmingStatus.state, "inactive");
    await assert.rejects(f.idle(), busy);
    if (phase === "provider") assert.equal(f.signal().aborted, false, "maintenance must not cancel provider work");
    // Native cancellation drops run immediately; even an abort-ignoring provider
    // or a pending extension decision must remain counted until refresh returns.
    if (drop === "replace") {
      f.start();
      assert.notEqual(f.warmer.run, f.run);
      await assert.rejects(f.idle(), busy);
    }
    f.warmer.cancel();
    assert.equal(f.warmer.run, undefined);
    await assert.rejects(f.idle(), busy);
    assert.ok(hostedSdkCalls(f.sdk) > 0);
    // Use real ticks to wait for promise cleanup after releasing the held boundary.
    t.mock.timers.reset();
    await f.settled();
    assert.equal(await f.idle(), "idle");
    const calls = f.providerCalls();
    assert.equal(calls, phase === "provider" ? 1 : 0, "cancelled decisions must not dispatch a provider request");
    await f.registry.maintenance.withIdleSessions("upgrade", async (_sessions, lease) => { lease.commitStop(); });
    await Promise.resolve().then(f.start);
    await f.refresh();
    await Promise.resolve().then(f.schedule);
    assert.equal(f.warmer.run, undefined);
    assert.equal(f.run.timer, undefined);
    assert.equal(f.providerCalls(), calls);
    assert.equal(readFileSync(join(f.env.agentDir, "settings.json"), "utf8"), f.settingsBefore);
    assert.equal((f.sdk.settingsManager as any).getCacheWarmingMode(), "idle");
  });
}

for (const method of ["start", "schedule", "refresh"] as const) {
  test(`SDK 1.2: an unguarded replacement ${method} defers upgrade`, { skip: !sdk12 }, async t => {
    const f = await setup(t);
    const warmer = (f.sdk as any)._cacheWarmer;
    const original = warmer[method];
    warmer[method] = () => undefined;
    try {
      await assert.rejects(f.idle(), (error: unknown) => error instanceof MaintenanceBusyError && error.reason === "unsupported-sdk");
    } finally { warmer[method] = original; }
    assert.equal(await f.idle(), "idle");
  });
}
