import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "./extension-fixture.js";
import type { ActivitySnapshot } from "../src/types.js";
import { currentGoalSnapshot, continuationStateEntry, createContinuationState } from "../src/goal-state.js";

for (const transition of ["pause", "resume", "hold", "complete", "clear", "session_tree", "agent_start", "session_shutdown"]) {
  test(`Goal fences activity callbacks and deadlines across ${transition}`, async t => {
    t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 100_000 });
    const events = new EventEmitter();
    const handlers = new Map<string, any>();
    const commands = new Map<string, any>();
    const entries: any[] = [];
    let busy = false, calls = 0, wakes = 0;
    let callback = () => {};
    const ctx = { hasUI: false, cwd: "/owner", isIdle: () => !busy,
      sessionManager: { getSessionId: () => "owner", getBranch: () => entries }, ui: { notify() {}, setWidget() {} } } as unknown as ExtensionContext;
    extension({ events, on: (key: string, handler: any) => handlers.set(key, handler),
      registerCommand: (key: string, command: any) => commands.set(key, command), registerTool() {},
      appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
      sendMessage: () => wakes++,
    } as unknown as ExtensionAPI);
    events.emit("pi-better-goal:register-provider", { id: "subagents", activityVersion: 1,
      onActivityChanged: (notify: () => void) => { callback = notify; return () => {}; },
      getActivity: () => { calls++; return { providerId: "subagents", items: [], nextDeadline: Date.now() + 5_000 }; },
    });
    await handlers.get("session_start")({}, ctx);
    await commands.get("goal").handler("finish", ctx);
    const oldCallback = callback;
    if (transition === "resume") {
      await commands.get("goal").handler("pause", ctx);
      await commands.get("goal").handler("resume", ctx);
    } else if (transition === "hold") {
      const state = { ...createContinuationState(currentGoalSnapshot(ctx)!.goalId), blocked: true };
      entries.push({ type: "custom", customType: "pi-better-goal", data: continuationStateEntry(state) });
      await handlers.get("agent_settled")({}, ctx);
    } else if (["pause", "complete", "clear"].includes(transition)) await commands.get("goal").handler(transition, ctx);
    else {
      if (transition === "agent_start") busy = true;
      await handlers.get(transition)({}, ctx);
    }
    const before = calls, beforeWakes = wakes;
    oldCallback();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls, before, "old callback cannot query a replacement generation");
    t.mock.timers.tick(5_000);
    await new Promise<void>(resolve => setImmediate(resolve));
    if (!["session_tree", "clear", "resume"].includes(transition)) assert.equal(calls, before, "held or busy scope cancels its deadline");
    assert.equal(wakes, beforeWakes, "observation does not authorize a model turn");
    if (transition !== "session_shutdown") await handlers.get("session_shutdown")({}, ctx);
  });
}

test("new activity providers cannot silently enter legacy compatibility polling", async () => {
  const events = new EventEmitter();
  const handlers = new Map<string, any>();
  let calls = 0;
  const ctx = { hasUI: false, cwd: "/owner", isIdle: () => true,
    sessionManager: { getSessionId: () => "owner", getBranch: () => [] }, ui: { setWidget() {} } } as unknown as ExtensionContext;
  extension({ events, on: (key: string, handler: any) => handlers.set(key, handler), registerCommand() {}, registerTool() {} } as unknown as ExtensionAPI);
  events.emit("pi-better-goal:register-provider", { id: "bad-v1", activityVersion: 1,
    getActivity: () => { calls++; return { providerId: "bad-v1", items: [] }; },
  });
  await handlers.get("session_start")({}, ctx);
  assert.equal(calls, 0, "v1 without notifications is refused, not treated as a legacy scanner");
  await handlers.get("session_shutdown")({}, ctx);
});

test("notification bursts do not exceed the explicit legacy compatibility budget", async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 100_000 });
  const events = new EventEmitter(), handlers = new Map<string, any>();
  let legacyReads = 0, notify = () => {};
  let latest: ActivitySnapshot | undefined;
  const ctx = { hasUI: false, cwd: "/owner", isIdle: () => true,
    sessionManager: { getSessionId: () => "owner", getBranch: () => [] }, ui: { setWidget() {} } } as unknown as ExtensionContext;
  extension({ events, on: (key: string, handler: any) => handlers.set(key, handler), registerCommand() {}, registerTool() {} } as unknown as ExtensionAPI);
  events.on("pi-better-goal:activity", value => { latest = value; });
  events.emit("pi-better-goal:register-provider", { id: "subagents", activityVersion: 1,
    onActivityChanged: (changed: () => void) => { notify = changed; return () => {}; },
    getActivity: () => ({ providerId: "subagents", items: [{ id: "worker", status: "running", active: true }], nextDeadline: null }),
  });
  events.emit("pi-better-goal:register-provider", { id: "legacy", getActivity: () => {
    legacyReads++; return { providerId: "legacy", items: [] };
  } });
  await handlers.get("session_start")({}, ctx);
  assert.equal(latest?.providers.find(provider => provider.providerId === "legacy")?.compatibilityIntervalMs, 2_000);
  const initial = legacyReads;
  for (let i = 0; i < 10; i++) notify();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(legacyReads, initial);
  t.mock.timers.tick(1_999);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(legacyReads, initial);
  t.mock.timers.tick(1);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(legacyReads, initial + 1);
  await handlers.get("session_shutdown")({}, ctx);
});

test("Goal observes notifications and exact deadlines without polling a warmed provider", async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 100_000 });
  const events = new EventEmitter();
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const commands = new Map<string, any>();
  const entries: any[] = [];
  const messages: any[] = [];
  const snapshots: ActivitySnapshot[] = [];
  const ctx = {
    hasUI: false, cwd: "/owned", isIdle: () => true,
    sessionManager: { getBranch: () => entries, getSessionId: () => "owner" },
    ui: { notify() {}, setWidget() {} },
  } as unknown as ExtensionContext;
  extension({
    events, on: (name: string, handler: any) => handlers.set(name, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool() {}, appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    sendMessage: (message: any) => messages.push(message),
  } as unknown as ExtensionAPI);
  let notify = () => {};
  let calls = 0;
  let running = true;
  let deadline: number | null = 110_000;
  events.emit("pi-better-goal:register-provider", {
    id: "subagents", onActivityChanged: (changed: () => void) => { notify = changed; return () => {}; },
    getActivity: () => {
      calls++;
      if (deadline !== null && Date.now() >= deadline) deadline = null;
      return { providerId: "subagents", nextDeadline: deadline,
        items: [{ id: "worker", status: running ? "running" : "completed", active: running, terminal: !running }] };
    },
  });
  events.on("pi-better-goal:activity", value => snapshots.push(value));
  await handlers.get("session_start")!({}, ctx);
  await commands.get("goal").handler("finish work", ctx);
  await handlers.get("agent_start")!({}, ctx);
  await handlers.get("agent_settled")!({}, ctx);
  const warmed = calls;
  t.mock.timers.tick(9_999);
  await Promise.resolve();
  assert.equal(calls, warmed, "elapsed time must not query a notifying provider");
  t.mock.timers.tick(1);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(calls, warmed + 1, "one collection at the exact provider deadline");
  deadline = 120_000;
  notify();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  deadline = 130_000;
  notify();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  const rearmed = calls;
  t.mock.timers.tick(10_000);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(calls, rearmed, "a replaced deadline must not collect at its old time");
  t.mock.timers.tick(10_000);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(calls, rearmed + 1, "the replacement deadline fires exactly once");
  running = false;
  notify();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(snapshots.at(-1)?.backgroundRunning, false);
  const beforeWake = messages.length;
  t.mock.timers.tick(60_000);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(messages.length, beforeWake + 1, "owner gets one drained continuation");
  const settledCalls = calls;
  t.mock.timers.tick(60_000);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(calls, settledCalls);
  assert.equal(messages.length, beforeWake + 1, "no duplicate wake");
  await handlers.get("session_shutdown")!({}, ctx);
});
