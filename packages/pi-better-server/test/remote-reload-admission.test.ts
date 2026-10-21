import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NativeClientHost } from "../src/remote-client/host.ts";
import { startDaemon } from "../src/server.ts";
import { gate, makeEnv, waitFor } from "./helpers.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function setup(t: TestContext) {
  const previous = { ...process.env };
  const env = makeEnv();
  Object.assign(process.env, env.vars);
  const daemon = await startDaemon({ serverDir: env.serverDir });
  const host = new NativeClientHost(daemon.registry);
  const sessions = [];
  for (const name of ["A", "B"]) {
    const item = await daemon.registry.create({ type: "create_session", cwd: env.cwd, name, model: { provider: "fake", modelId: "fake-1" } });
    const hosted = daemon.registry.get(item.sessionId)!;
    await hosted.session.prompt(`history ${name}`);
    sessions.push(hosted);
  }
  const [a, b] = sessions as [typeof sessions[number], typeof sessions[number]];
  const histories = sessions.map(s => readFileSync(s.session.sessionFile!, "utf8"));
  const reloads: string[] = [];
  let aborts = 0;
  for (const [index, hosted] of sessions.entries()) {
    const reload = hosted.session.reload.bind(hosted.session);
    hosted.session.reload = async (...args) => {
      reloads.push(index === 0 ? "A" : "B");
      return reload(...args);
    };
    const abort = hosted.session.abort.bind(hosted.session);
    hosted.session.abort = async () => { aborts++; return abort(); };
  }
  t.after(async () => {
    gate(env, "gated").release();
    delete (globalThis as Record<string, unknown>)[env.root];
    await daemon.stop();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  return {
    env, daemon, host, a, b, sessions, histories, reloads, aborts: () => aborts,
    sync: (packages: unknown[] = []) => host.handle({ type: "client_packages_install", cwd: env.cwd, packages }),
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;
function startup(f: Fixture, run: (pi: ExtensionAPI, ctx: ExtensionContext) => unknown) {
  (globalThis as Record<string, unknown>)[f.env.root] = run;
  writeFileSync(join(f.env.agentDir, "extensions", "admission.ts"), `export default function(pi) {
    pi.on("session_start", (_event, ctx) => globalThis[${JSON.stringify(f.env.root)}](pi, ctx));
  }`);
}
function historiesKept(f: Fixture) {
  f.sessions.forEach((s, i) => assert.ok(readFileSync(s.session.sessionFile!, "utf8").startsWith(f.histories[i]!)));
}
function admissionReleased(f: Fixture) {
  assert.equal(f.host.busy, false);
  f.host.enterSessionOperation()();
}

test("startup pi.sendUserMessage cannot start a tool while another SDK reload is pending", { timeout: 30_000 }, async t => {
  const f = await setup(t);
  const outcome = deferred<"started" | "refused">();
  const off = f.a.session.subscribe(event => { if (event.type === "tool_execution_start") outcome.resolve("started"); });
  t.after(off);
  let result: string | undefined;
  startup(f, async (pi, ctx) => {
    if (ctx.sessionManager.getSessionId() !== f.a.session.sessionId) return;
    const stop = f.a.session.extensionRunner.onError(error => {
      if (error.event === "send_user_message" && /maintenance|updated/.test(error.error)) outcome.resolve("refused");
    });
    pi.sendUserMessage("tool gated");
    result = await outcome.promise;
    stop();
  });
  const reloadB = f.b.session.reload.bind(f.b.session);
  f.b.session.reload = async (...args) => {
    assert.equal(f.a.executionActive, false, "B must not reset global providers while A runs");
    return reloadB(...args);
  };
  await f.sync();
  assert.equal(result, "refused");
  assert.deepEqual(f.reloads, ["A", "B"]);
  assert.equal(gate(f.env, "gated").started(), false);
  assert.equal(f.aborts(), 0);
  admissionReleased(f);
  historiesKept(f);
  await f.a.session.sendUserMessage("after maintenance");
  assert.equal(f.a.session.getLastAssistantText(), "echo:after maintenance");
});

test("startup background work stops the batch, preserves the work and fences pending stale runtimes", { timeout: 30_000 }, async t => {
  const f = await setup(t);
  const released = deferred();
  const observed = deferred();
  const observe = deferred();
  let active = false;
  let finished = false;
  startup(f, (pi, ctx) => {
    if (ctx.sessionManager.getSessionId() !== f.a.session.sessionId) return;
    active = true;
    void released.promise.then(() => { active = false; finished = true; });
    pi.events.emit("pi-better-goal:register-provider", {
      id: "startup-work", scope: "session", getActivity: async () => {
        observed.resolve();
        await observe.promise;
        return { items: [{ active }] };
      },
    });
  });
  t.after(() => { observe.resolve(); released.resolve(); });
  const rejected = assert.rejects(f.sync(), /partial.*1\/2|1\/2.*partial/i);
  await observed.promise;
  assert.equal(f.a.activityChecking, true);
  assert.deepEqual(f.reloads, ["A"]);
  assert.equal(f.host.busy, true);
  observe.resolve();
  await rejected;
  assert.deepEqual(f.reloads, ["A"]);
  assert.equal(active, true);
  assert.equal(finished, false);
  assert.equal(f.aborts(), 0);
  admissionReleased(f);
  historiesKept(f);
  await assert.rejects(f.b.session.sendUserMessage("stale runtime must not run"), /closed|close and reopen/);
  assert.equal((await f.b.handle({ type: "prompt", message: "stale" })).success, false);
  released.resolve();
  await waitFor("background work to finish", () => finished);
  await f.a.refreshActivity();
  await f.a.session.prompt("after background work");
  assert.equal(f.a.session.getLastAssistantText(), "echo:after background work");
});

test("maintenance guards SDK work admission in every idle session and restores healthy methods", { timeout: 30_000 }, async t => {
  const f = await setup(t);
  const started = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  startup(f, async (_pi, ctx) => {
    if (ctx.sessionManager.getSessionId() !== f.a.session.sessionId) return;
    started.resolve();
    await release.promise;
  });
  const sync = f.sync();
  await started.promise;
  try {
    for (const hosted of f.sessions) {
      const sdk = hosted.session;
      for (const work of [
        () => sdk.prompt("tool gated"),
        () => sdk.sendUserMessage("tool gated"),
        () => sdk.sendCustomMessage({ customType: "work", content: "trigger", display: true }, { triggerTurn: true }),
        () => sdk.steer("must not queue"),
        () => sdk.followUp("must not queue"),
        () => sdk.executeBash("printf must-not-run"),
        () => sdk.compact(),
        () => sdk.navigateTree(sdk.sessionManager.getLeafId()!, { summarize: true }),
      ]) await assert.rejects(work(), /maintenance/);
      assert.equal(sdk.pendingMessageCount, 0);
      assert.equal(sdk.isStreaming || sdk.isBashRunning || sdk.isCompacting, false);
      await sdk.sendCustomMessage({ customType: "notice", content: "initialization notice", display: true });
    }
  } finally { release.resolve(); await sync; }
  assert.deepEqual(f.reloads, ["A", "B"]);
  assert.equal(f.aborts(), 0);
  historiesKept(f);
  admissionReleased(f);
  for (const hosted of f.sessions) {
    assert.equal((await hosted.session.executeBash("printf restored")).output, "restored");
    await hosted.session.prompt("restored model");
    assert.equal(hosted.session.getLastAssistantText(), "echo:restored model");
  }
});

test("work admitted through a previously captured SDK prompt stops pending reloads without abort", { timeout: 30_000 }, async t => {
  const f = await setup(t);
  // A callback may already hold a method reference before the temporary guards exist.
  const prompt = f.a.session.prompt.bind(f.a.session);
  const toolStarted = deferred();
  const off = f.a.session.subscribe(event => { if (event.type === "tool_execution_start") toolStarted.resolve(); });
  t.after(off);
  let work: Promise<unknown> | undefined;
  startup(f, async (_pi, ctx) => {
    if (ctx.sessionManager.getSessionId() !== f.a.session.sessionId) return;
    work = prompt("tool gated");
    await toolStarted.promise;
  });
  await assert.rejects(f.sync(), /partial: 1\/2 reloaded, 0 failed, 1 deferred/);
  await waitFor("gated tool to execute", gate(f.env, "gated").started);
  assert.deepEqual(f.reloads, ["A"]);
  assert.equal(f.a.executionActive, true);
  assert.equal(gate(f.env, "gated").finished(), false);
  assert.equal(f.aborts(), 0);
  admissionReleased(f);
  historiesKept(f);
  gate(f.env, "gated").release();
  await work;
  assert.equal(f.a.session.getLastAssistantText(), "tool-done:gate:gated");
});

test("a startup dialog stops pending SDK reloads and can still be answered", { timeout: 30_000 }, async t => {
  const f = await setup(t);
  let dialog: Promise<boolean> | undefined;
  startup(f, (_pi, ctx) => {
    if (ctx.sessionManager.getSessionId() !== f.a.session.sessionId) return;
    // Open the dialog on the successfully refreshed runtime so fencing B cannot hide it.
    dialog = ctx.ui.confirm("Startup", "Continue?");
  });
  await assert.rejects(f.sync(), /partial: 1\/2 reloaded, 0 failed, 1 deferred/);
  assert.deepEqual(f.reloads, ["A"]);
  assert.equal(f.a.needsInput.length, 1);
  assert.equal(f.aborts(), 0);
  admissionReleased(f);
  assert.equal(f.a.answerDialog(f.a.needsInput[0]!.id, { confirmed: true }), true);
  assert.equal(await dialog, true);
  historiesKept(f);
});

test("activity is sampled again between SDK reloads even without a provider notification", { timeout: 30_000 }, async t => {
  const f = await setup(t);
  let active = false;
  let cachedIdleWhenWorkStarted = false;
  startup(f, (pi, ctx) => {
    if (ctx.sessionManager.getSessionId() !== f.a.session.sessionId) return;
    pi.events.emit("pi-better-goal:register-provider", {
      id: "silent-background", scope: "session", getActivity: () => ({ items: [{ active }] }),
    });
  });
  const off = f.a.addListener(({ event }) => {
    if ((event as { type?: string }).type !== "remote_resources_reloaded") return;
    cachedIdleWhenWorkStarted = !f.a.executionActive && !f.a.activityChecking;
    active = true;
  });
  t.after(off);
  await assert.rejects(f.sync(), /partial: 1\/2 reloaded, 0 failed, 1 deferred/);
  assert.equal(cachedIdleWhenWorkStarted, true);
  assert.deepEqual(f.reloads, ["A"]);
  assert.equal(f.a.executionActive, true);
  assert.equal(f.aborts(), 0);
  admissionReleased(f);
  historiesKept(f);
  active = false;
  await f.a.refreshActivity();
});

test("install failure remains the primary error when a reload also fails; stale SDK admission stays closed", { timeout: 30_000 }, async t => {
  const f = await setup(t);
  f.a.session.reload = async () => { throw new Error("broken SDK reload"); };
  await assert.rejects(f.sync([{ source: "./invalid-package" }]), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.match(String(error.cause), /Invalid|Unsupported/);
    assert.equal(error.errors[0], error.cause);
    assert.match(error.message, /partial: 1\/2 reloaded, 1 failed, 0 deferred/);
    assert.match(error.message, /broken SDK reload/);
    return true;
  });
  assert.deepEqual(f.reloads, ["B"]);
  admissionReleased(f);
  historiesKept(f);
  assert.equal(f.aborts(), 0);
  await assert.rejects(f.a.session.sendUserMessage("stale direct SDK call"), /runtime is closed/);
  assert.equal((await f.a.handle({ type: "prompt", message: "stale dispatch" })).success, false);
  await f.b.session.prompt("healthy after failure");
  assert.equal(f.b.session.getLastAssistantText(), "echo:healthy after failure");
  // A subsequent maintenance attempt must not restore the failed runtime's SDK methods.
  await f.host.reload(f.b.session.sessionId);
  await assert.rejects(f.a.session.executeBash("printf stale"), /runtime is closed/);
});
