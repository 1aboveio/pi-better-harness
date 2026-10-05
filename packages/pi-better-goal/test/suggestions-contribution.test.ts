import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createEventBus, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension from "./extension-fixture.js";
import {
  createGoalSnapshot, currentGoalSnapshot, currentContinuationState, goalSetEntry, goalWithStatus,
} from "../src/goal-state.js";
import { currentPermissionHold, permissionRecord } from "../src/permission-hold.js";
import { writeGoalPreference } from "../src/preferences.js";
import { EXTENSION_NAME, type GoalSnapshot } from "../src/types.js";

interface Contribution { id: string; blocked(): boolean }
interface Entry { type: string; customType: string; data: unknown }

function setup(t: TestContext, goal?: GoalSnapshot, listenAtLoad = true, load = extension) {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  writeGoalPreference("autoContinue", true);
  const events = createEventBus();
  const registrations: Contribution[] = [];
  const listen = () => events.on("harness-suggestions:register", (data) => registrations.push(data as Contribution));
  if (listenAtLoad) listen();
  const entries: Entry[] = goal ? [{ type: "custom", customType: EXTENSION_NAME, data: goalSetEntry(goal, "command") }] : [];
  const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
  const handlers = new Map<string, (event: any, ctx: ExtensionCommandContext) => unknown>();
  const messages: unknown[] = [];
  const ctx = {
    hasUI: false, mode: "rpc", cwd: "/tmp/goal-suggestions", isIdle: () => true,
    sessionManager: { getBranch: () => entries, getSessionId: () => "goal-suggestions" },
    ui: { notify() {}, setStatus() {}, setWidget() {} },
  } as unknown as ExtensionCommandContext;
  const appendEntry = (customType: string, data: unknown) => entries.push({ type: "custom", customType, data });
  const pi = {
    events, appendEntry,
    registerCommand(name: string, command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) {
      commands.set(name, command);
    },
    registerTool() {}, registerShortcut() {},
    on(name: string, handler: (event: any, ctx: ExtensionCommandContext) => unknown) { handlers.set(name, handler); },
    sendMessage(...args: unknown[]) { messages.push(args); },
    sendUserMessage() { assert.fail("Plain goals must retain their hidden continuation path"); },
    getAllTools: () => [{ name: "subagent_result", sourceInfo: {
      path: fileURLToPath(new URL("../../pi-better-subagents/index.ts", import.meta.url)),
    } }],
  } as unknown as ExtensionAPI;
  load(pi);
  if (!listenAtLoad) listen();
  t.after(async () => { await handlers.get("session_shutdown")!({}, ctx); });
  return {
    events, registrations, entries, messages, ctx, appendEntry,
    command: (args: string) => commands.get("goal")!.handler(args, ctx),
    fire: async (name: string, event: unknown = {}) => { await handlers.get(name)!(event, ctx); },
    discover() {
      events.emit("harness-suggestions:request", undefined);
      assert.ok(registrations.at(-1), "Goal answers trusted runtime discovery");
      return registrations.at(-1)!;
    },
  };
}

const activeGoal = () => ({ ...createGoalSnapshot("Verify the requested work", null, 100), goalId: "suggestion-goal" });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("suggestion discovery handles both load orders and removes its request listener at shutdown", async (t) => {
  for (const listenAtLoad of [true, false]) {
    await t.test(listenAtLoad ? "Harness first" : "Goal first", async (t) => {
      const runtime = setup(t, undefined, listenAtLoad);
      assert.equal(runtime.registrations.length, listenAtLoad ? 1 : 0);
      const contribution = runtime.discover();
      assert.equal(contribution.id, "goal");
      assert.equal(contribution.blocked(), false, "load before session context has no Goal work");
      assert.equal(runtime.discover(), contribution, "requests publish the same live callback");
      await runtime.fire("session_start");
      await runtime.command("Do the requested work");
      assert.equal(contribution.blocked(), true);
      await runtime.fire("session_shutdown");
      assert.equal(contribution.blocked(), false, "stale callback cannot retain the old session's hold");
      const count = runtime.registrations.length;
      runtime.events.emit("harness-suggestions:request", undefined);
      assert.equal(runtime.registrations.length, count, "shutdown stops replying");
    });
  }
});

test("idle active goals block through a pending timer and its asynchronous dispatch audit", async (t) => {
  const runtime = setup(t, activeGoal());
  const contribution = runtime.discover();
  await runtime.fire("session_start");
  assert.equal(runtime.ctx.isIdle(), true);
  assert.equal(contribution.blocked(), true, "active automation blocks even before settlement schedules its timer");
  await runtime.fire("agent_settled");
  t.mock.timers.tick(59_999);
  await flush();
  assert.equal(runtime.messages.length, 0, "continuation remains delayed during the grace period");
  assert.equal(contribution.blocked(), true);

  let releaseAudit: (() => void) | undefined;
  let collections = 0;
  runtime.events.emit("pi-better-goal:register-provider", {
    id: "audit",
    getActivity: () => {
      collections++;
      return new Promise<{ providerId: string; items: [] }>((resolve) => {
        releaseAudit = () => resolve({ providerId: "audit", items: [] });
      });
    },
  });
  await flush();
  releaseAudit!();
  await flush();
  t.mock.timers.tick(1);
  await flush();
  assert.equal(runtime.messages.length, 0, "timer fired but activity audit has not finished");
  const before = { entries: runtime.entries.length, messages: runtime.messages.length, collections };
  for (let i = 0; i < 3; i++) assert.equal(contribution.blocked(), true, "audit gap must not admit suggestions");
  assert.deepEqual({ entries: runtime.entries.length, messages: runtime.messages.length, collections }, before,
    "eligibility is synchronous and does not append, send, or collect activity");
  releaseAudit!();
  await flush();
  assert.equal(runtime.messages.length, 1);
  assert.equal(contribution.blocked(), true, "queued automatic continuation still blocks while Pi is idle");
  await runtime.command("complete");
  assert.equal(contribution.blocked(), false);
});

test("disabling automation releases a pending timer but not an already queued continuation", async (t) => {
  const runtime = setup(t, activeGoal());
  const contribution = runtime.discover();
  await runtime.fire("session_start");
  await runtime.fire("agent_settled");
  assert.equal(contribution.blocked(), true);
  await runtime.command("settings auto-continue off");
  assert.equal(currentGoalSnapshot(runtime.ctx)?.status, "active");
  assert.equal(contribution.blocked(), false);
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(runtime.messages.length, 0, "disabled timer cannot dispatch");

  await runtime.command("settings auto-continue on");
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(runtime.messages.length, 1);
  await runtime.command("settings auto-continue off");
  assert.equal(contribution.blocked(), true, "off does not retract an already queued follow-up");
  await runtime.fire("agent_start");
  await runtime.fire("agent_end", { messages: [] });
  await runtime.fire("agent_settled");
  assert.equal(contribution.blocked(), false, "consuming the queue with automation off releases Goal eligibility");
});

test("process wake-disable overrides release active automation but preserve explicit queued work", async (t) => {
  for (const key of ["PI_BETTER_GOAL_DISABLE_WAKE", "PI_BETTER_EXTENSION_DISABLE_WAKE"]) {
    await t.test(key, async (t) => {
      const keys = ["PI_BETTER_GOAL_DISABLE_WAKE", "PI_BETTER_EXTENSION_DISABLE_WAKE"];
      const previous = keys.map((name) => [name, process.env[name]] as const);
      let load: typeof extension;
      try {
        for (const name of keys) delete process.env[name];
        process.env[key] = "1";
        load = (await import(`${new URL("../src/index.ts", import.meta.url).href}?suggestions-${key}`)).default;
      } finally {
        for (const [name, value] of previous) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
      const runtime = setup(t, activeGoal(), true, load);
      await runtime.fire("session_start");
      await runtime.fire("agent_settled");
      const contribution = runtime.discover();
      assert.equal(contribution.blocked(), false);
      t.mock.timers.tick(60_000);
      await flush();
      assert.equal(runtime.messages.length, 0);
      await runtime.command("pause");
      await runtime.command("resume");
      assert.equal(runtime.messages.length, 1, "process override must not disable explicit resume");
      assert.equal(contribution.blocked(), true, "explicitly queued work blocks even under a process override");
    });
  }
});

test("permission holds block even with automation off and remain blocked during and after one released retry", async (t) => {
  const runtime = setup(t, activeGoal());
  const contribution = runtime.discover();
  await runtime.fire("session_start");
  await runtime.command("settings auto-continue off");
  assert.equal(contribution.blocked(), false);
  await runtime.fire("tool_result", { toolName: "subagent_result", details: { permissionBlockers: [{
    version: 1, kind: "permission-blocker", context: "worker", resource: "credential-files",
    basis: "agent-reported", operation: "credential-cache", remoteOutcome: "unknown",
  }] } });
  assert.equal(currentGoalSnapshot(runtime.ctx)?.pauseReason, "permission-blocker");
  assert.equal(contribution.blocked(), true, "idle permission pause is not normal conversation eligibility");
  await runtime.command("resume");
  assert.equal(currentPermissionHold(runtime.ctx, "suggestion-goal").retryPending, true);
  assert.equal(runtime.messages.length, 1, "explicit resume still sends exactly one continuation");
  assert.equal(contribution.blocked(), true);
  await runtime.fire("agent_start");
  assert.equal(contribution.blocked(), true, "hold blocks without a timer or queued marker during the retry");
  await runtime.fire("agent_end", { messages: [] });
  await runtime.fire("agent_settled");
  assert.equal(currentPermissionHold(runtime.ctx, "suggestion-goal").retryPending, false);
  assert.equal(contribution.blocked(), true);
  await runtime.command("complete");
  assert.equal(contribution.blocked(), false, "completed goal's historical blockers are not a current hold");
  await runtime.command("clear");
  assert.equal(contribution.blocked(), false);
});

test("missing or incomplete permission evidence still blocks the current hold", async (t) => {
  for (const missing of [true, false]) {
    await t.test(missing ? "missing blocker evidence" : "incomplete scope", async (t) => {
      const goal = missing ? goalWithStatus(activeGoal(), "paused", 100, "permission-blocker") : activeGoal();
      const runtime = setup(t, goal);
      if (!missing) runtime.appendEntry(EXTENSION_NAME, permissionRecord(goal.goalId, "permission-gap"));
      await runtime.fire("session_start");
      await runtime.command("settings auto-continue off");
      const contribution = runtime.discover();
      assert.equal(contribution.blocked(), true);
      await runtime.command("clear");
      assert.equal(contribution.blocked(), false);
    });
  }
});

test("no-progress holds and explicit pauses release eligibility until Goal work resumes", async (t) => {
  const runtime = setup(t, activeGoal());
  const contribution = runtime.discover();
  await runtime.fire("session_start");
  for (let i = 0; i <= 10; i++) {
    await runtime.fire("agent_start");
    await runtime.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "No change." }] }] });
    await runtime.fire("agent_settled");
  }
  assert.equal(currentContinuationState(runtime.ctx, "suggestion-goal")?.blocked, true);
  assert.equal(contribution.blocked(), false, "no-progress hold has no autonomous continuation scheduled");
  t.mock.timers.tick(600_000);
  await flush();
  assert.equal(runtime.messages.length, 0);
  await runtime.command("resume");
  assert.equal(contribution.blocked(), true);
  assert.equal(runtime.messages.length, 1);
  await runtime.command("pause");
  assert.equal(contribution.blocked(), false, "ordinary explicit pause has no permission hold");
  await runtime.command("clear");
  assert.equal(contribution.blocked(), false);
});

test("standalone direct Goal commands still kick off and resume with automation disabled", async (t) => {
  const runtime = setup(t);
  await runtime.fire("session_start");
  await runtime.command("settings auto-continue off");
  await runtime.command("Ship the requested fix");
  assert.equal(currentGoalSnapshot(runtime.ctx)?.objective, "Ship the requested fix");
  assert.equal(currentGoalSnapshot(runtime.ctx)?.status, "active");
  assert.equal(runtime.messages.length, 1);
  await runtime.command("pause");
  assert.equal(currentGoalSnapshot(runtime.ctx)?.status, "paused");
  await runtime.command("resume");
  assert.equal(currentGoalSnapshot(runtime.ctx)?.status, "active");
  assert.equal(runtime.messages.length, 2, "direct resume is independent of a Harness registry or automation setting");
  await runtime.command("complete");
  assert.equal(currentGoalSnapshot(runtime.ctx)?.status, "complete");
  await runtime.command("clear");
  assert.equal(currentGoalSnapshot(runtime.ctx), null);
  assert.equal(runtime.messages.length, 2);
});
