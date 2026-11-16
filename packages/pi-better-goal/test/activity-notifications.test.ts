import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "./extension-fixture.js";
import type { ActivitySnapshot } from "../src/types.js";

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
