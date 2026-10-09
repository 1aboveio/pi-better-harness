import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import extension, { goalArgumentCompletions, toolContext } from "./extension-fixture.js";
import { goalPreferencesPath } from "../src/preferences.js";
import type { PermissionHold } from "../src/permission-hold.js";
import { bundledProducerSource, installedHarnessFixture, registeredProducerTools } from "./permission-producer-fixture.js";

interface SessionEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

interface CommandDefinition {
  getArgumentCompletions?(prefix: string): AutocompleteItem[] | null;
  handler(args: string, ctx: ExtensionContext): Promise<void> | void;
}

interface WidgetRecord {
  content: unknown;
  options?: { placement?: string };
}

test("goal action completions expose selectable actions with context", () => {
  assert.deepEqual(goalArgumentCompletions(""), [
    { value: "pause", label: "pause", description: "Pause the active goal" },
    { value: "resume", label: "resume", description: "Resume the paused goal" },
    { value: "clear", label: "clear", description: "Remove the current goal" },
    { value: "complete", label: "complete", description: "Mark the current goal complete" },
    { value: "settings", label: "settings", description: "Inspect or persist goal continuation, conversational resume, and Escape pause controls" },
  ]);
  assert.deepEqual(
    goalArgumentCompletions("  c")?.map((entry) => entry.value),
    ["clear", "complete"],
  );
  assert.equal(goalArgumentCompletions("ship the release"), null);
  assert.deepEqual(goalArgumentCompletions("settings ")?.map((item) => item.value), [
    "settings auto-continue", "settings conversational-resume", "settings pause-on-escape",
  ]);
  assert.deepEqual(goalArgumentCompletions("settings auto-continue o")?.map((item) => item.value), [
    "settings auto-continue on", "settings auto-continue off",
  ]);
  assert.deepEqual(goalArgumentCompletions("settings pause-on-escape o")?.map((item) => item.value), [
    "settings pause-on-escape on", "settings pause-on-escape off",
  ]);
});

test("active background work adds completion-audit guidance to the agent prompt", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const entries: SessionEntry[] = [];
  const commands = new Map<string, CommandDefinition>();
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const events = new EventEmitter();
  const ctx = {
    hasUI: false,
    isIdle: () => true,
    cwd: "/tmp/project",
    sessionManager: { getBranch: () => entries, getSessionId: () => "session-plan-coordination" },
    ui: { notify() {}, setStatus() {}, setWidget() {} },
  } as unknown as ExtensionContext;
  const pi = {
    events,
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage() {},
    registerCommand(name: string, command: CommandDefinition) {
      commands.set(name, command);
    },
    registerTool() {},
    on(event: string, handler: (event: any, context: ExtensionContext) => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;

  extension(pi);
  events.emit("pi-better-goal:register-provider", {
    id: "fixture",
    getActivity: () => ({
      providerId: "fixture",
      items: [{ id: "worker-1", label: "review", status: "running", active: true }],
    }),
  });
  await commands.get("goal")?.handler("ship coordinated work", ctx);

  const update = await handlers.get("before_agent_start")?.({ systemPrompt: "base prompt" }, ctx) as { systemPrompt?: string };
  assert.match(update.systemPrompt ?? "", /keep any structured plan current/);
  assert.match(update.systemPrompt ?? "", /do not mark verification, the plan, or the goal complete/);
  assert.match(update.systemPrompt ?? "", /inspected and integrated/);

  await handlers.get("session_shutdown")?.({}, ctx);
});

test("idle sessions sleep until provider activity needs polling", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const events = new EventEmitter();
  let activityChanged: (() => void) | undefined;
  let active = false;
  let collections = 0;
  const ctx = {
    hasUI: false,
    isIdle: () => true,
    cwd: "/tmp/project",
    sessionManager: { getBranch: () => [], getSessionId: () => "session-idle" },
    ui: { notify() {}, setStatus() {}, setWidget() {} },
  } as unknown as ExtensionContext;
  const pi = {
    events,
    appendEntry() {},
    sendMessage() {},
    registerCommand() {},
    registerTool() {},
    registerShortcut() {},
    on(event: string, handler: (event: unknown, context: ExtensionContext) => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;

  extension(pi);
  events.emit("pi-better-goal:register-provider", {
    id: "fixture",
    getActivity: () => {
      collections += 1;
      return {
        providerId: "fixture",
        items: active ? [{ id: "work", status: "running", active: true }] : [],
      };
    },
    onActivityChanged(notify: () => void) {
      activityChanged = notify;
      return () => { activityChanged = undefined; };
    },
  });

  await handlers.get("session_start")?.({}, ctx);
  const afterStartup = collections;
  assert.ok(afterStartup >= 1, "startup establishes one activity snapshot");
  t.mock.timers.tick(10_000);
  await Promise.resolve();
  assert.equal(collections, afterStartup, "an idle session performs no periodic provider reads");

  active = true;
  activityChanged?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const afterWake = collections;
  assert.ok(afterWake > afterStartup, "provider changes wake one immediate collection");
  t.mock.timers.tick(2_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(collections > afterWake, "owned running work keeps polling active");

  active = false;
  activityChanged?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const afterDrain = collections;
  t.mock.timers.tick(10_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(collections, afterDrain, "polling stops after owned work drains");
});

test("only the slash command creates a goal and installs an observability-safe widget", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const entries: SessionEntry[] = [];
  const commands = new Map<string, CommandDefinition>();
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const widgets = new Map<string, WidgetRecord>();

  const ctx = {
    hasUI: true,
    isIdle: () => true,
    sessionManager: { getBranch: () => entries },
    ui: {
      confirm: async () => true,
      notify: () => undefined,
      setStatus: () => undefined,
      setWidget(key: string, content: unknown, options?: { placement?: string }) {
        widgets.set(key, { content, ...(options ? { options } : {}) });
      },
    },
  } as unknown as ExtensionContext;

  const pi = {
    events: new EventEmitter(),
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage: () => undefined,
    registerCommand(name: string, command: CommandDefinition) {
      commands.set(name, command);
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    registerShortcut() {
      // Not asserted in this test.
    },
    on(event: string, handler: (event: unknown, context: ExtensionContext) => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;

  extension(pi);

  assert.equal(tools.has("create_goal"), false);
  assert.equal(tools.has("get_goal"), true);
  assert.equal(tools.has("update_goal"), true);

  const sessionStart = handlers.get("session_start");
  assert.ok(sessionStart);
  await sessionStart({ reason: "startup" }, ctx);

  const widget = widgets.get("pi-better-goal");
  assert.equal(widget?.options?.placement, "aboveEditor");
  assert.equal(typeof widget?.content, "function");

  let renderRequests = 0;
  const forcedRenders: boolean[] = [];
  const factory = widget?.content as (
    tui: { requestRender(force?: boolean): void },
    theme: { fg(color: string, text: string): string },
  ) => { render(width: number): string[]; dispose?(): void };
  const component = factory(
    {
      requestRender: (force = false) => {
        renderRequests += 1;
        forcedRenders.push(force);
      },
    },
    { fg: (_color, text) => text },
  );
  assert.deepEqual(component.render(80), []);
  t.mock.timers.tick(30_000);
  assert.equal(renderRequests, 0, "an absent goal must not drive periodic full-screen renders");

  const goalCommand = commands.get("goal");
  assert.ok(goalCommand);
  await goalCommand.handler("Ship slash-only goals", ctx);
  assert.equal(renderRequests, 1, "setting a goal requests one immediate render");
  assert.equal(forcedRenders.at(-1), true, "absent → visible clock forces a full redraw");

  const getGoal = tools.get("get_goal");
  assert.ok(getGoal);
  const result = await getGoal.execute("test", {}, undefined, undefined, toolContext(ctx));
  assert.equal((result.details as { goal: { objective: string } }).goal.objective, "Ship slash-only goals");

  const rendered = component.render(80);
  assert.equal(rendered.length, 2);
  const [line, sectionGap] = rendered;
  assert.match(line ?? "", /goal active \d+:\d{2} Ship slash-only goals/);
  assert.equal(sectionGap, "", "goal keeps the same one-row gap used between navigator sections");

  t.mock.timers.tick(9_999);
  assert.equal(renderRequests, 1, "active clock does not repaint every second");
  t.mock.timers.tick(1);
  assert.equal(renderRequests, 2, "active clock requests one coarse refresh");
  assert.equal(forcedRenders.at(-1), false, "clock ticks use differential paints");

  await goalCommand.handler("clear", ctx);
  assert.equal(renderRequests, 3, "clearing a goal requests one immediate render");
  assert.equal(forcedRenders.at(-1), true, "visible → absent clock forces a full redraw");
  assert.deepEqual(component.render(80), []);
  t.mock.timers.tick(30_000);
  assert.equal(renderRequests, 3, "cleared goal remains timer-free");
  component.dispose?.();

  const shutdown = handlers.get("session_shutdown");
  assert.ok(shutdown);
  await shutdown({}, ctx);
});

test("setting a goal while the agent is streaming avoids chat notify and confirm", async () => {
  const entries: SessionEntry[] = [];
  const commands = new Map<string, CommandDefinition>();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const notifications: Array<{ message: string; type?: string }> = [];
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  let confirms = 0;
  let idle = false;

  const ctx = {
    hasUI: true,
    isIdle: () => idle,
    sessionManager: { getBranch: () => entries },
    ui: {
      confirm: async () => {
        confirms += 1;
        return true;
      },
      notify(message: string, type?: string) {
        notifications.push({ message, ...(type ? { type } : {}) });
      },
      setStatus(key: string, value: string | undefined) {
        statuses.push({ key, value });
      },
      setWidget() {
        // Not needed for this regression.
      },
    },
  } as unknown as ExtensionContext;

  const pi = {
    events: new EventEmitter(),
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage: () => undefined,
    registerCommand(name: string, command: CommandDefinition) {
      commands.set(name, command);
    },
    registerTool() {
      // Not needed for this regression.
    },
    registerShortcut() {
      // Not asserted in this test.
    },
    on(event: string, handler: (event: unknown, context: ExtensionContext) => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;

  extension(pi);
  await handlers.get("session_start")?.({}, ctx);
  await handlers.get("agent_start")?.({}, ctx);

  // Seed an incomplete goal so a mid-stream replace would normally confirm.
  idle = true;
  await commands.get("goal")?.handler("first objective", ctx);
  notifications.length = 0;
  statuses.length = 0;
  confirms = 0;

  idle = false;
  await commands.get("goal")?.handler("second objective", ctx);

  assert.equal(confirms, 0, "mid-stream goal replace must not open a confirm dialog");
  assert.equal(notifications.length, 0, "mid-stream goal feedback must not append chat status lines");
  assert.ok(
    statuses.some((entry) => entry.key === "pi-better-goal" && entry.value?.includes("second objective")),
    "mid-stream feedback goes to the footer status instead",
  );
  assert.equal(latestGoal(entries)?.objective, "second objective");
});

test("external active background providers suppress idle goal continuation", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const entries: SessionEntry[] = [];
  const commands = new Map<string, CommandDefinition>();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const messages: unknown[] = [];

  const ctx = {
    hasUI: false,
    isIdle: () => true,
    sessionManager: { getBranch: () => entries },
    ui: {
      confirm: async () => true,
      notify: () => undefined,
      setStatus: () => undefined,
      setWidget: () => undefined,
    },
  } as unknown as ExtensionContext;

  const events = new EventEmitter();
  const pi = {
    events,
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage(message: unknown) {
      messages.push(message);
    },
    registerCommand(name: string, command: CommandDefinition) {
      commands.set(name, command);
    },
    registerTool() {
      // Not needed for this regression.
    },
    registerShortcut() {
      // Not asserted in this test.
    },
    on(event: string, handler: (event: unknown, context: ExtensionContext) => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;

  extension(pi);
  events.emit("pi-better-goal:register-provider", {
    id: "background-tasks",
    label: "Background Tasks",
    getActivity: () => ({
      providerId: "background-tasks",
      items: [{ id: "bg_watch", status: "running", active: true }],
    }),
  });

  await handlers.get("session_start")?.({}, ctx);
  await commands.get("goal")?.handler("keep watching", ctx);
  await handlers.get("agent_start")?.({}, ctx);
  messages.length = 0;

  await handlers.get("agent_settled")?.({}, ctx);
  t.mock.timers.tick(60_000);
  await flushPromises();

  assert.equal(messages.length, 0, "active background tasks must not trigger idle continuation");
});

test("idle goal continuation waits for the inactivity grace period", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { commands, handlers, messages, ctx } = createContinuationHarness();

  await handlers.get("session_start")?.({}, ctx);
  await commands.get("goal")?.handler("keep watching", ctx);
  await handlers.get("agent_start")?.({}, ctx);
  messages.length = 0;

  await handlers.get("agent_settled")?.({}, ctx);
  assert.equal(messages.length, 0);

  t.mock.timers.tick(59_999);
  await flushPromises();
  assert.equal(messages.length, 0);

  t.mock.timers.tick(1);
  await flushPromises();
  assert.equal(messages.length, 1);
});

test("idle goal continuation rechecks background activity before waking", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let active = false;
  const { commands, handlers, messages, ctx, events } = createContinuationHarness();
  events.emit("pi-better-goal:register-provider", {
    id: "background-tasks",
    label: "Background Tasks",
    getActivity: () => ({
      providerId: "background-tasks",
      items: active ? [{ id: "bg_watch", status: "running", active: true }] : [],
    }),
  });

  await handlers.get("session_start")?.({}, ctx);
  await commands.get("goal")?.handler("keep watching", ctx);
  await handlers.get("agent_start")?.({}, ctx);
  messages.length = 0;

  await handlers.get("agent_settled")?.({}, ctx);
  active = true;
  t.mock.timers.tick(60_000);
  await flushPromises();

  assert.equal(messages.length, 0, "new background activity during the grace period cancels the wake");
});

test("identical autonomous outcomes hold continuation across conversation until explicit resume", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  isolatePreferences(t);
  const { commands, handlers, messages, ctx, entries } = createContinuationHarness();

  await handlers.get("session_start")?.({}, ctx);
  await commands.get("goal")?.handler("keep watching", ctx);
  assert.equal(messages.length, 1, "setting a goal starts its first autonomous turn");

  const identicalOutcome = {
    messages: [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call", name: "bash", arguments: { command: "git status --short" } }],
      },
      {
        role: "toolResult",
        toolCallId: "call",
        toolName: "bash",
        isError: false,
        content: [{ type: "text", text: "" }],
      },
    ],
  };

  // The first outcome is new evidence; each identical retry after it waits
  // one more 60s grace period than the last.
  for (let attempt = 0; attempt <= 10; attempt += 1) {
    await handlers.get("agent_start")?.({}, ctx);
    await handlers.get("agent_end")?.(identicalOutcome, ctx);
    await handlers.get("agent_settled")?.({}, ctx);
    const delay = 60_000 * (attempt + 1);
    const before: number = messages.length;
    if (attempt === 10) break;
    t.mock.timers.tick(delay - 1);
    await flushPromises();
    assert.equal(messages.length, before, `retry ${attempt} waits the full ${delay}ms`);
    t.mock.timers.tick(1);
    await flushPromises();
    assert.equal(messages.length, before + 1, `retry ${attempt} fires after ${delay}ms`);
  }
  assert.equal(messages.length, 11, "the initial turn plus ten no-progress retries are allowed");
  t.mock.timers.tick(60_000 * 12);
  await flushPromises();
  assert.equal(messages.length, 11, "the eleventh identical outcome holds automatic continuation");

  const blocked = latestContinuationState(entries);
  assert.equal(blocked?.blocked, true);
  assert.equal(blocked?.noProgressRetries, 10);
  const heldMessages = messages.length;

  for (const text of ["what is blocked?", "what is needed from me?", "go"]) {
    await handlers.get("input")?.({ source: "interactive", text }, ctx);
    await handlers.get("agent_start")?.({}, ctx);
    await handlers.get("agent_end")?.({ messages: [{ role: "assistant", content: [{ type: "text", text: `Answer to ${text}` }] }] }, ctx);
    await handlers.get("agent_settled")?.({}, ctx);
    assert.deepEqual(latestContinuationState(entries), blocked, "conversation must not replace the held evidence");
    t.mock.timers.tick(720_000);
    await flushPromises();
    assert.equal(messages.length, heldMessages, "conversation does not restart autonomous work");
  }
  await handlers.get("session_start")?.({ reason: "reload" }, ctx);
  t.mock.timers.tick(720_000);
  await flushPromises();
  assert.equal(messages.length, heldMessages, "reload retains the hold");
  await commands.get("goal")?.handler("settings auto-continue off", ctx);
  await commands.get("goal")?.handler("settings auto-continue on", ctx);
  t.mock.timers.tick(720_000);
  await flushPromises();
  assert.deepEqual(latestContinuationState(entries), blocked, "settings changes retain the hold");
  assert.equal(messages.length, heldMessages);
  await handlers.get("session_shutdown")?.({}, ctx);
  const restored = createContinuationHarness();
  t.after(() => restored.handlers.get("session_shutdown")?.({}, restored.ctx));
  restored.entries.push(...structuredClone(entries));
  await restored.handlers.get("session_start")?.({ reason: "reload" }, restored.ctx);
  t.mock.timers.tick(720_000);
  await flushPromises();
  assert.equal(restored.messages.length, 0, "a new extension instance also preserves the hold");
  assert.deepEqual(latestContinuationState(restored.entries), blocked);
  await restored.commands.get("goal")?.handler("resume", restored.ctx);
  assert.equal(latestContinuationState(restored.entries)?.blocked, false);
  assert.equal(restored.messages.length, 1, "explicit resume reopens the loop");
});

test("/goal resume reopens an active no-progress hold without replacing the goal", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = createContinuationHarness();
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("wait for network recovery", h.ctx);
  await exhaustNoProgressRetries(h, t);
  assert.equal(latestContinuationState(h.entries)?.blocked, true);
  const before = h.messages.length;

  await h.commands.get("goal")?.handler("resume", h.ctx);

  assert.equal(latestGoal(h.entries)?.status, "active");
  assert.equal(latestGoal(h.entries)?.objective, "wait for network recovery");
  assert.equal(latestContinuationState(h.entries)?.blocked, false);
  assert.equal(latestContinuationState(h.entries)?.noProgressRetries, 0);
  assert.equal(h.messages.length, before + 1, "explicit resume queues one new turn");
  await settleNetworkFailure(h);
  const afterResume = h.messages.length;
  t.mock.timers.tick(59_999);
  await flushPromises();
  assert.equal(h.messages.length, afterResume);
  t.mock.timers.tick(1);
  await flushPromises();
  assert.equal(h.messages.length, afterResume + 1, "resumed retry uses the base delay");
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
});

test("interrupting held conversation cannot enable conversational resume, but the hotkey can reopen it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = createContinuationHarness();
  t.after(() => h.handlers.get("session_shutdown")?.({}, h.ctx));
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("wait for authorization", h.ctx);
  await exhaustNoProgressRetries(h, t);
  const held = latestContinuationState(h.entries);
  const before = h.messages.length;
  await h.handlers.get("input")?.({ source: "interactive", text: "why is it blocked?" }, h.ctx);
  await h.handlers.get("agent_start")?.({}, h.ctx);
  await h.handlers.get("agent_end")?.({ messages: [{ role: "assistant", content: [], stopReason: "aborted" }] }, h.ctx);
  await h.handlers.get("agent_settled")?.({}, h.ctx);
  assert.equal(latestGoal(h.entries)?.status, "paused");
  assert.equal(h.activeTools().includes("goal_resume"), false);
  const refused = await h.tools.get("goal_resume")!.execute("resume", { reason: "go" }, undefined, undefined, toolContext(h.ctx));
  assert.equal((refused.details as { ok: boolean }).ok, false);
  assert.deepEqual(latestContinuationState(h.entries), held);
  t.mock.timers.tick(720_000);
  await flushPromises();
  assert.equal(h.messages.length, before);
  await h.shortcuts.get("alt+g")?.handler(h.ctx);
  assert.equal(latestGoal(h.entries)?.status, "active");
  assert.equal(latestContinuationState(h.entries)?.blocked, false);
  assert.equal(h.messages.length, before + 1);
});

test("issue #415: unchanged permission blockers hold autonomous continuation despite assistant rephrasing", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 1_000_000 });
  const h = createContinuationHarness();
  t.after(() => h.handlers.get("session_shutdown")?.({}, h.ctx));
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("verify fixture access before completing the goal", h.ctx);
  assert.equal(h.messages.length, 1, "explicit goal creation starts one turn");

  const rephrasings = [
    "Credential cache access and process inspection remain denied.",
    "Neither permission failure has been resolved; verification is blocked.",
  ];
  // Actionable parent reports hold immediately. Repeated messages and prose
  // changes cannot soften that structured hold.
  for (let attempt = 0; attempt <= 10; attempt += 1) {
    await settlePermissionFailure(h, rephrasings[attempt % rephrasings.length]!);
    const inspected = await h.tools.get("get_goal")!.execute("inspect", {}, undefined, undefined, toolContext(h.ctx));
    const { goal } = inspected.details as { goal: { status: string; completedAt: number | null } };
    assert.equal(goal.status, "paused", "actionable permission reports hold rather than implying completion");
    assert.equal(goal.completedAt, null, "no successful verification was supplied");
    const before: number = h.messages.length;
    t.mock.timers.tick(60_000 * (attempt + 1));
    await flushPromises();
    assert.equal(h.messages.length, before, "structured hold suppresses every autonomous retry");
  }

  const beforeHold = h.messages.length;
  assert.equal(beforeHold, 1, "only the explicitly requested kickoff ran");
  t.mock.timers.tick(60_000);
  await flushPromises();
  const inspected = await h.tools.get("get_goal")!.execute("inspect", {}, undefined, undefined, toolContext(h.ctx));
  const { continuation } = inspected.details as { continuation: { blocked: boolean; noProgressRetries: number; lastProgressAt: number } };
  t.diagnostic(`unchanged permission failures: ${JSON.stringify({
    blocked: continuation.blocked,
    noProgressRetries: continuation.noProgressRetries,
    lastProgressAt: continuation.lastProgressAt,
    queuedTurns: h.messages.length,
  })}`);
  assert.equal(h.messages.length, beforeHold, "unchanged permission blockers must not queue another autonomous turn just because the assistant rephrased them");
  assert.equal(latestGoal(h.entries)?.pauseReason, "permission-blocker");
});

test("issue #415: persisted permission-blocked continuation is not rearmed by unrelated activity", async (t) => {
  for (const cause of ["ordinary question", "background completion"] as const) {
    await t.test(cause, async (subtest) => {
      subtest.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 1_000_000 });
      const first = createContinuationHarness();
      subtest.after(() => first.handlers.get("session_shutdown")?.({}, first.ctx));
      await first.handlers.get("session_start")?.({}, first.ctx);
      await first.commands.get("goal")?.handler("verify fixture access before completing the goal", first.ctx);
      await settlePermissionFailure(first, "Both fixture permissions remain denied.");
      assert.equal(latestGoal(first.entries)?.pauseReason, "permission-blocker", "real handlers establish the hold before replay");
      await first.handlers.get("session_shutdown")?.({}, first.ctx);

      const restored = createContinuationHarness();
      subtest.after(() => restored.handlers.get("session_shutdown")?.({}, restored.ctx));
      restored.entries.push(...structuredClone(first.entries));
      let status = "running";
      if (cause === "background completion") {
        restored.events.emit("pi-better-goal:register-provider", {
          id: "unrelated-fixture",
          getActivity: () => ({
            providerId: "unrelated-fixture",
            items: [{ id: "unrelated-work", label: "format unrelated notes", status, active: status === "running" }],
          }),
        });
      }
      await restored.handlers.get("session_start")?.({}, restored.ctx);
      assert.equal(latestGoal(restored.entries)?.pauseReason, "permission-blocker", "session replay preserves the permission hold");
      subtest.mock.timers.tick(60_000 * 12);
      await flushPromises();
      assert.equal(restored.messages.length, 0, "replay alone does not queue a continuation");

      if (cause === "ordinary question") {
        await restored.handlers.get("input")?.({ source: "interactive", text: "What does the unrelated fixture label mean?" }, restored.ctx);
        await restored.handlers.get("agent_start")?.({}, restored.ctx);
        await restored.handlers.get("agent_end")?.(answeredOutcome, restored.ctx);
        await restored.handlers.get("agent_settled")?.({}, restored.ctx);
      } else {
        status = "completed";
        await restored.commands.get("better-activity")?.handler("", restored.ctx);
      }
      subtest.mock.timers.tick(60_000);
      await flushPromises();
      const inspected = await restored.tools.get("get_goal")!.execute("inspect", {}, undefined, undefined, toolContext(restored.ctx));
      const { goal, continuation } = inspected.details as {
        goal: { status: string; completedAt: number | null };
        continuation: { blocked: boolean; noProgressRetries: number; lastProgressAt: number };
      };
      assert.equal(goal.status, "paused", "an unrelated answer or task completion is not successful permission verification");
      assert.equal(goal.completedAt, null);
      subtest.diagnostic(`${cause}: ${JSON.stringify({
        blocked: continuation.blocked,
        noProgressRetries: continuation.noProgressRetries,
        lastProgressAt: continuation.lastProgressAt,
        queuedTurns: restored.messages.length,
      })}`);
      assert.equal(restored.messages.length, 0, `${cause} supplies no permission recovery and must not rearm autonomous goal work`);
      assert.equal(latestGoal(restored.entries)?.pauseReason, "permission-blocker");
    });
  }
});

test("issue #415: prose-only denials retain the generic retry allowance without rewording progress", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 1_000_000 });
  const h = createContinuationHarness();
  t.after(() => h.handlers.get("session_shutdown")?.({}, h.ctx));
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("verify fixture access", h.ctx);
  for (let attempt = 0; attempt <= 10; attempt += 1) {
    await settlePermissionFailure(h, attempt % 2 ? "Neither permission is recovered." : "Both permissions remain denied.", false);
    if (attempt < 10) {
      t.mock.timers.tick(60_000 * (attempt + 1));
      await flushPromises();
    }
  }
  t.mock.timers.tick(720_000);
  await flushPromises();
  assert.equal(h.messages.length, 11, "unchanged actions exhaust the existing ten retries despite prose changes");
  assert.equal(latestContinuationState(h.entries)?.blocked, true);
  assert.equal(latestContinuationState(h.entries)?.noProgressRetries, 10);
  assert.equal(latestGoal(h.entries)?.status, "active", "EPERM prose is not a structured permission pause");
  assert.equal((await inspectPermissionHold(h)).blockers.length, 0);
});

test("issue #415: command and hotkey each release one same-scope retry, never the model tool", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 1_000_000 });
  const h = createContinuationHarness(undefined, { hasUI: true });
  t.after(() => h.handlers.get("session_shutdown")?.({}, h.ctx));
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("verify fixture access", h.ctx);
  await settlePermissionFailure(h, "Access is blocked.");
  t.mock.method(h.ctx.ui, "confirm", async () => { throw new Error("Explicit resume must not open an extra dialog."); });
  const original = structuredClone(permissionRecords(h));
  const goalId = latestGoal(h.entries)?.goalId;
  for (const release of ["command", "hotkey"] as const) {
    const refused = await h.tools.get("goal_resume")!.execute("resume", { reason: "user said go" }, undefined, undefined, toolContext(h.ctx));
    assert.equal((refused.details as { ok: boolean }).ok, false);
    assert.equal(h.activeTools().includes("goal_resume"), false);
    const before = h.messages.length;
    if (release === "command") await h.commands.get("goal")?.handler("resume", h.ctx);
    else await h.shortcuts.get("alt+g")?.handler(h.ctx);
    assert.equal(h.messages.length, before + 1);
    assert.equal(latestGoal(h.entries)?.goalId, goalId);
    const released = await inspectPermissionHold(h);
    assert.equal(released.retryPending, true);
    assert.deepEqual(released.blockers, fixtureBlockers(), "release neither changes scope nor claims recovery");
    assert.deepEqual(permissionRecords(h).slice(0, original.length), original, "prior records remain append-only");
    const prompt = await h.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, h.ctx) as { systemPrompt: string };
    assert.match(prompt.systemPrompt, /ONE bounded retry/);
    assert.match(prompt.systemPrompt, /fixture-cache-read/);
    assert.match(prompt.systemPrompt, /Changed worker settings require a fresh worker/);
    await h.commands.get("goal")?.handler("resume", h.ctx);
    assert.equal(h.messages.length, before + 1, "an active release cannot be dispatched twice");
    await settlePermissionFailure(h, "Same denial again.");
    assert.equal(latestGoal(h.entries)?.pauseReason, "permission-blocker");
    assert.equal((await inspectPermissionHold(h)).retryPending, false);
    t.mock.timers.tick(720_000);
    await flushPromises();
    assert.equal(h.messages.length, before + 1, "the unchanged denial re-holds without autonomous retry");
  }
  assert.equal(permissionRecords(h).filter((record) => record.kind === "permission-release").length, 2);
});

test("issue #415: a fresh worker retains logical blocker identity and its new context references", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = createContinuationHarness();
  t.after(() => h.handlers.get("session_shutdown")?.({}, h.ctx));
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("verify fixture access", h.ctx);
  await settlePermissionFailure(h, "Blocked.");
  await h.commands.get("goal")?.handler("resume", h.ctx);
  await h.handlers.get("agent_start")?.({}, h.ctx);
  const replacement = fixtureBlockers("worker-two", "policy-two").map((blocker) => ({ ...blocker, incidentId: "new-incident" }));
  await reportPermissionBlockers(h, replacement, "subagent_output");
  await h.handlers.get("agent_end")?.(answeredOutcome, h.ctx);
  await h.handlers.get("agent_settled")?.({}, h.ctx);
  const hold = await inspectPermissionHold(h);
  assert.deepEqual(hold.blockers, replacement, "new run/policy/incident references replace evidence, not logical scope");
  assert.equal(hold.retryPending, false);
  assert.equal(latestGoal(h.entries)?.pauseReason, "permission-blocker");
  assert.deepEqual(permissionRecords(h).filter((record) => record.kind === "permission-hold").slice(0, 2).map((record) => record.blocker), fixtureBlockers());
  await reportPermissionBlockers(h, [{ ...replacement[0], basis: "agent-reported" }]);
  const distinguished = (await inspectPermissionHold(h)).blockers;
  assert.equal(distinguished.length, 3, "agent-reported and runtime-observed evidence are not merged");
  assert.deepEqual(distinguished.map((blocker) => blocker.basis), ["os-permission-error", "os-permission-error", "agent-reported"]);
});

test("issue #415: unrelated success cannot refill a released retry or close unknown remote evidence", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = createContinuationHarness();
  t.after(() => h.handlers.get("session_shutdown")?.({}, h.ctx));
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("verify fixture access", h.ctx);
  await settlePermissionFailure(h, "Blocked.");
  await h.commands.get("goal")?.handler("resume", h.ctx);
  await h.handlers.get("agent_start")?.({}, h.ctx);
  await h.handlers.get("agent_end")?.(answeredOutcome, h.ctx);
  await h.handlers.get("agent_settled")?.({}, h.ctx);
  assert.equal(latestGoal(h.entries)?.pauseReason, "permission-blocker");
  assert.deepEqual((await inspectPermissionHold(h)).blockers, fixtureBlockers());
  assert.equal((await inspectPermissionHold(h)).retryPending, false);
  const before = h.messages.length;
  t.mock.timers.tick(720_000);
  await flushPromises();
  assert.equal(h.messages.length, before);
});

test("issue #415: settings publication, workflow prompts, and Escape cannot soften the hold", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  isolatePreferences(t);
  const h = createContinuationHarness(undefined, { hasUI: true, mode: "tui" });
  t.after(() => h.handlers.get("session_shutdown")?.({}, h.ctx));
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("verify fixture access", h.ctx);
  await settlePermissionFailure(h, "Blocked.");
  const history = structuredClone(permissionRecords(h));
  const workflow = { version: 1, kind: "set", owner: { name: "fixture", path: "/__fixture__/SKILL.md", role: "coordinator", planOwner: "workflow" } };
  h.entries.push({ type: "custom", customType: "pi-better-workflow", data: workflow });
  h.events.emit("pi-better-sandbox:policy", { state: "enabled", subagentPermissions: {
    enabled: true, projectFiles: "read-write", outsideProject: "read",
    storedCredentials: "read", commands: true, network: true, processAccess: "read",
  } });
  for (const command of ["settings auto-continue off", "settings auto-continue on", "settings conversational-resume off", "settings conversational-resume on", "settings pause-on-escape off", "settings pause-on-escape on"]) {
    await h.commands.get("goal")?.handler(command, h.ctx);
  }
  const prompt = await h.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, h.ctx) as { systemPrompt: string };
  assert.match(prompt.systemPrompt, /do not advance goal or workflow work/);
  assert.doesNotMatch(prompt.systemPrompt, /Follow the workflow instructions below/);
  assert.deepEqual(h.entries.filter((entry) => entry.customType === "pi-better-workflow").at(-1)?.data, workflow);
  assert.deepEqual(h.terminalInput("\x1b"), [undefined]);
  assert.deepEqual(permissionRecords(h), history);
  assert.equal(latestGoal(h.entries)?.pauseReason, "permission-blocker");
  assert.equal(h.activeTools().includes("goal_resume"), false);
  t.mock.timers.tick(720_000);
  await flushPromises();
  assert.equal(h.messages.length, 1);
  await h.commands.get("goal")?.handler("resume", h.ctx);
  h.terminalInput("\x1b");
  assert.equal(latestGoal(h.entries)?.pauseReason, "permission-blocker", "Escape consumes, not converts, the explicit retry");
  assert.equal((await inspectPermissionHold(h)).retryPending, false);
  assert.equal(h.activeTools().includes("goal_resume"), false);
});

test("issue #415: a permission hold invalidates a pending timer and in-flight wake audit", async (t) => {
  for (const stage of ["timer", "audit"] as const) {
    await t.test(stage, async (subtest) => {
      subtest.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
      const h = createContinuationHarness();
      subtest.after(() => h.handlers.get("session_shutdown")?.({}, h.ctx));
      let delayed = false;
      const gates: Array<ReturnType<typeof deferred<ReturnType<typeof fixtureActivity>>>> = [];
      h.events.emit("pi-better-goal:register-provider", { id: "fixture", getActivity: () => {
        if (!delayed) return fixtureActivity(false);
        const gate = deferred<ReturnType<typeof fixtureActivity>>();
        gates.push(gate);
        return gate.promise;
      } });
      await h.handlers.get("session_start")?.({}, h.ctx);
      await h.commands.get("goal")?.handler("verify fixture access", h.ctx);
      await settleNetworkFailure(h);
      if (stage === "audit") {
        subtest.mock.timers.tick(59_999);
        await flushPromises();
        delayed = true;
        subtest.mock.timers.tick(1);
        await flushPromises();
        assert.ok(gates.length > 0, "the real wake audit is waiting on the provider");
      }
      await reportPermissionBlockers(h, fixtureBlockers());
      delayed = false;
      for (const gate of gates) gate.resolve(fixtureActivity(false));
      subtest.mock.timers.tick(720_000);
      await flushPromises();
      assert.equal(h.messages.length, 1, "stale wakes cannot queue held work");
      assert.equal(latestGoal(h.entries)?.pauseReason, "permission-blocker");
    });
  }
});

test("issue #415: untrusted, malformed, foreground, and prose reports cannot grant retry authority", async (t) => {
  const cases = [
    { name: "wrong owner", producerPath: fileURLToPath(new URL("../src/index.ts", import.meta.url)), blockers: fixtureBlockers() },
    { name: "unknown tool", toolName: "pretend_subagent_result", blockers: fixtureBlockers() },
    { name: "invalid resource", blockers: [{ ...fixtureBlockers()[0], resource: "everything" }] },
    { name: "invalid version", blockers: [{ ...fixtureBlockers()[0], version: 2 }] },
    { name: "raw path operation", blockers: [{ ...fixtureBlockers()[0], operation: "/private/credential.json" }] },
    { name: "unknown success", blockers: [{ ...fixtureBlockers()[0], remoteOutcome: "success" }] },
    { name: "extra data", blockers: [{ ...fixtureBlockers()[0], command: "secret-command" }] },
    { name: "partial malformed batch", blockers: [fixtureBlockers()[0], { version: 1 }] },
    { name: "unsupported foreground transport", blockers: [{ ...fixtureBlockers()[0], context: "foreground" }] },
    { name: "oversized array", blockers: Array.from({ length: 33 }, () => fixtureBlockers()[0]) },
    { name: "not an array", blockers: fixtureBlockers()[0] },
    { name: "EPERM prose only", blockers: undefined },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async (subtest) => {
      subtest.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
      const h = createContinuationHarness(undefined, fixture.producerPath ? { producerPath: fixture.producerPath } : {});
      subtest.after(() => h.handlers.get("session_shutdown")?.({}, h.ctx));
      await h.handlers.get("session_start")?.({}, h.ctx);
      await h.commands.get("goal")?.handler("verify fixture access", h.ctx);
      await reportPermissionBlockers(h, fixture.blockers, fixture.toolName);
      assert.equal(latestGoal(h.entries)?.status, "active", "unsupported reports do not invent a permission pause");
      assert.equal((await inspectPermissionHold(h)).blockers.length, 0);
      assert.equal(permissionRecords(h).length, 0);
      await h.commands.get("goal")?.handler("resume", h.ctx);
      assert.equal(h.messages.length, 1, "unsupported evidence does not create explicit-release authority");
    });
  }
});

test("issue #415: installed harness and standalone SDK producers preserve structured permission holds", async (t) => {
  const fixture = installedHarnessFixture();
  t.after(fixture.cleanup);
  for (const source of [bundledProducerSource(fixture.installed), join(fixture.installed, "node_modules/pi-better-subagents/index.ts")]) {
    await t.test(source.includes("extensions/") ? "bundled wrapper" : "standalone entry", async (subtest) => {
      const registeredTools = await registeredProducerTools(source, fixture.root);
      subtest.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
      const h = createContinuationHarness(undefined, { registeredTools });
      subtest.after(() => h.handlers.get("session_shutdown")?.({}, h.ctx));
      await h.handlers.get("session_start")?.({}, h.ctx);
      await h.commands.get("goal")?.handler("verify fixture access", h.ctx);
      for (const toolName of ["subagent_result", "subagent_output"]) {
        assert.equal(registeredTools.find((tool) => tool.name === toolName)?.sourceInfo.path, source, "the SDK assigns the loaded entry, including the wrapper, as source owner");
        await reportPermissionBlockers(h, fixtureBlockers(), toolName);
        assert.equal(latestGoal(h.entries)?.pauseReason, "permission-blocker");
      }
      assert.deepEqual((await inspectPermissionHold(h)).blockers, fixtureBlockers());
      const before = h.messages.length;
      await h.commands.get("goal")?.handler("resume", h.ctx);
      assert.equal(h.messages.length, before + 1, "complete trusted scope releases one retry");
      await h.handlers.get("tool_result")?.({ toolName: "subagent_output", details: { permissionBlockersOmitted: 1 } }, h.ctx);
      assert.equal((await inspectPermissionHold(h)).saturated, true, "bundled omission handling remains fail closed");
      await h.commands.get("goal")?.handler("resume", h.ctx);
      assert.equal(h.messages.length, before + 1);
    });
  }
});

test("issue #415: forged or altered harness sources cannot adopt blocker or omission authority", async (t) => {
  const body = 'export { default } from "../../node_modules/pi-better-subagents/index.ts";';
  const cases = [
    { name: "forged wrapper without owner", owner: null },
    { name: "wrong owner", owner: "another-harness" },
    { name: "missing extension declaration", missingExtension: true },
    { name: "missing dependency declaration", missingDependency: true },
    { name: "missing bundle declaration", missingBundle: true },
    { name: "wrong wrapper path", path: "extensions/pretend-subagents/index.ts" },
    { name: "wrapper has executable suffix", body: `${body}\nthrow new Error("forged");` },
    { name: "reexport only in prose", body: `// ${body}` },
    { name: "dynamic import", body: 'export default (await import("../../node_modules/pi-better-subagents/index.ts")).default;' },
    { name: "different target", body: 'export { default } from "../../node_modules/pi-better-subagents/other.ts";' },
    { name: "wrong target owner", targetOwner: "another-subagents" },
    { name: "missing canonical target", missingTarget: true },
  ];
  for (const input of cases) {
    await t.test(input.name, async (subtest) => {
      subtest.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
      const root = mkdtempSync(join(tmpdir(), "pi-goal-forged-wrapper-"));
      subtest.after(() => rmSync(root, { recursive: true, force: true }));
      const source = join(root, input.path ?? "extensions/subagents/index.ts");
      mkdirSync(join(source, ".."), { recursive: true });
      mkdirSync(join(root, "node_modules/pi-better-subagents"), { recursive: true });
      if (input.owner !== null) writeFileSync(join(root, "package.json"), JSON.stringify({
        name: input.owner ?? "pi-better-harness",
        pi: { extensions: input.missingExtension ? [] : ["extensions/subagents/index.ts"] },
        dependencies: input.missingDependency ? {} : { "pi-better-subagents": "0.13.1" },
        bundledDependencies: input.missingBundle ? [] : ["pi-better-subagents"],
      }));
      writeFileSync(source, input.body ?? body);
      writeFileSync(join(root, "node_modules/pi-better-subagents/package.json"), JSON.stringify({ name: input.targetOwner ?? "pi-better-subagents" }));
      if (!input.missingTarget) writeFileSync(join(root, "node_modules/pi-better-subagents/index.ts"), "export default function () {}\n");
      const h = createContinuationHarness(undefined, { producerPath: source });
      subtest.after(() => h.handlers.get("session_shutdown")?.({}, h.ctx));
      await h.handlers.get("session_start")?.({}, h.ctx);
      await h.commands.get("goal")?.handler("verify fixture access", h.ctx);
      await h.handlers.get("tool_result")?.({ toolName: "subagent_result", details: {
        permissionBlockers: fixtureBlockers(), permissionBlockersOmitted: 1,
      } }, h.ctx);
      assert.equal(latestGoal(h.entries)?.status, "active");
      assert.deepEqual(permissionRecords(h), [], "untrusted source supplies neither blocker nor gap authority");
    });
  }
});

test("issue #415: omitted parent reports hold an incomplete scope rather than authorize a partial retry", async (t) => {
  for (const blockers of [fixtureBlockers(), []]) {
    await t.test(blockers.length ? "partial scope" : "omitted-only scope", async (subtest) => {
      subtest.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
      const h = createContinuationHarness();
      subtest.after(() => h.handlers.get("session_shutdown")?.({}, h.ctx));
      await h.handlers.get("session_start")?.({}, h.ctx);
      await h.commands.get("goal")?.handler("verify fixture access", h.ctx);
      await h.handlers.get("tool_result")?.({ toolName: "subagent_result", details: {
        permissionBlockers: blockers, permissionBlockersOmitted: 1,
      } }, h.ctx);
      assert.equal(latestGoal(h.entries)?.pauseReason, "permission-blocker");
      assert.deepEqual((await inspectPermissionHold(h)).blockers, blockers);
      assert.equal((await inspectPermissionHold(h)).saturated, true);
      const before = h.messages.length;
      await h.commands.get("goal")?.handler("resume", h.ctx);
      await h.shortcuts.get("alt+g")?.handler(h.ctx);
      assert.equal(h.messages.length, before, "unknown scope cannot be released");
      subtest.mock.timers.tick(720_000);
      await flushPromises();
      assert.equal(h.messages.length, before, "incomplete reports cannot rearm continuation");
    });
  }
});

test("issue #415: blocker scope and record limits fail closed without dropping prior evidence", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = createContinuationHarness();
  t.after(() => h.handlers.get("session_shutdown")?.({}, h.ctx));
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("verify fixture access", h.ctx);
  const blockers = Array.from({ length: 32 }, (_, index) => ({ ...fixtureBlockers()[0], operation: `operation-${index}` }));
  await reportPermissionBlockers(h, blockers);
  await reportPermissionBlockers(h, [{ ...blockers[0], operation: "operation-overflow" }]);
  const scope = await inspectPermissionHold(h);
  assert.deepEqual(scope.blockers, blockers);
  assert.equal(scope.saturated, true);
  await h.commands.get("goal")?.handler("resume", h.ctx);
  assert.equal(h.messages.length, 1, "truncated scope cannot authorize a broader retry");

  await h.commands.get("goal")?.handler("new explicit fixture objective", h.ctx);
  await settlePermissionFailure(h, "Blocked.");
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const beforeRelease = h.messages.length;
    await h.commands.get("goal")?.handler("resume", h.ctx);
    if (h.messages.length > beforeRelease) {
      assert.equal((await inspectPermissionHold(h)).retryPending, true, "every accepted release retains its one retry, including the capacity boundary");
    }
    await reportPermissionBlockers(h, fixtureBlockers());
  }
  const bounded = await inspectPermissionHold(h);
  assert.equal(bounded.saturated, true);
  assert.ok(bounded.recordCount <= 128);
  assert.deepEqual(bounded.blockers, fixtureBlockers());
  const before = h.messages.length;
  await h.shortcuts.get("alt+g")?.handler(h.ctx);
  assert.equal(h.messages.length, before, "full history remains held");
  const serialized = JSON.stringify(permissionRecords(h));
  assert.doesNotMatch(serialized, /cache\.json|fixture-process-inspection --pid|EPERM:/, "durable records do not copy raw paths, argv, or output");
});

test("issue #415: reloading after release does not dispatch or reuse its retry ticket", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const first = createContinuationHarness();
  await first.handlers.get("session_start")?.({}, first.ctx);
  await first.commands.get("goal")?.handler("verify fixture access", first.ctx);
  await settlePermissionFailure(first, "Blocked.");
  await first.commands.get("goal")?.handler("resume", first.ctx);
  assert.equal((await inspectPermissionHold(first)).retryPending, true);
  await first.handlers.get("session_shutdown")?.({}, first.ctx);
  const restored = createContinuationHarness();
  t.after(() => restored.handlers.get("session_shutdown")?.({}, restored.ctx));
  restored.entries.push(...structuredClone(first.entries));
  await restored.handlers.get("session_start")?.({}, restored.ctx);
  assert.equal(latestGoal(restored.entries)?.pauseReason, "permission-blocker");
  assert.equal((await inspectPermissionHold(restored)).retryPending, false);
  t.mock.timers.tick(720_000);
  await flushPromises();
  assert.equal(restored.messages.length, 0);
  assert.equal(permissionRecords(restored).filter((record) => record.kind === "permission-release").length, 1);
});

test("issue #415: a restored permission pause with malformed evidence cannot invent a retry scope", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const first = createContinuationHarness();
  await first.handlers.get("session_start")?.({}, first.ctx);
  await first.commands.get("goal")?.handler("verify fixture access", first.ctx);
  await settlePermissionFailure(first, "Blocked.");
  await first.handlers.get("session_shutdown")?.({}, first.ctx);
  const restored = createContinuationHarness();
  t.after(() => restored.handlers.get("session_shutdown")?.({}, restored.ctx));
  restored.entries.push(...structuredClone(first.entries).map((entry) => {
    const data = entry.data as { kind?: string };
    return data?.kind === "permission-hold" ? { ...entry, data: { ...data, blocker: { version: 2 } } } : entry;
  }));
  await restored.handlers.get("session_start")?.({}, restored.ctx);
  await restored.commands.get("goal")?.handler("resume", restored.ctx);
  assert.equal(restored.messages.length, 0);
  assert.equal(latestGoal(restored.entries)?.pauseReason, "permission-blocker");
  const prompt = await restored.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, restored.ctx) as { systemPrompt: string };
  assert.match(prompt.systemPrompt, /do not invent a retry scope/);
  assert.equal((await inspectPermissionHold(restored)).blockers.length, 0);
  assert.equal(restored.activeTools().includes("goal_resume"), false);
});

test("issue #415: partial corrupt permission history stays incomplete after reload and cannot release", async (t) => {
  const corruptions = [
    { name: "hold version", patch: { version: 2 } },
    { name: "hold blocker", patch: { blocker: { version: 2 } } },
    { name: "hold timestamp", patch: { at: "invalid" } },
    { name: "nonfinite timestamp", patch: { at: Infinity } },
    { name: "release version", patch: { kind: "permission-release", version: 2 } },
    { name: "release timestamp", patch: { kind: "permission-release", at: null } },
    { name: "retry-finished timestamp", patch: { kind: "permission-retry-finished", at: null } },
    { name: "gap version", patch: { kind: "permission-gap", version: 2 } },
  ];
  for (const corruption of corruptions) {
    await t.test(corruption.name, async (subtest) => {
      subtest.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
      const first = createContinuationHarness();
      await first.handlers.get("session_start")?.({}, first.ctx);
      await first.commands.get("goal")?.handler("verify fixture access", first.ctx);
      await settlePermissionFailure(first, "Blocked.");
      await first.handlers.get("session_shutdown")?.({}, first.ctx);
      let corrupted = false;
      const history = structuredClone(first.entries).map((entry) => {
        const data = entry.data as { kind?: string; blocker?: { resource: string } } | undefined;
        if (data?.kind !== "permission-hold" || data.blocker?.resource !== "process-inspection") return entry;
        corrupted = true;
        return { ...entry, data: { ...data, ...corruption.patch } };
      });
      assert.equal(corrupted, true);
      const restored = createContinuationHarness();
      subtest.after(() => restored.handlers.get("session_shutdown")?.({}, restored.ctx));
      restored.entries.push(...history);
      const goalId = latestGoal(history)!.goalId;
      // A valid later release cannot reverse incomplete authority history.
      restored.entries.push({ type: "custom", customType: "pi-better-goal", data: { version: 1, kind: "permission-release", goalId, at: 100 } });
      assert.equal((await inspectPermissionHold(restored)).retryPending, false, "replay itself rejects release authority before startup consumes any ticket");
      await restored.handlers.get("session_start")?.({}, restored.ctx);
      const hold = await inspectPermissionHold(restored);
      assert.deepEqual(hold.blockers, [fixtureBlockers()[0]], "valid scope evidence survives the damaged sibling record");
      assert.equal(hold.saturated, true);
      assert.equal(hold.retryPending, false, "neither malformed nor later valid release supplies retry authority");
      await restored.commands.get("goal")?.handler("resume", restored.ctx);
      await restored.shortcuts.get("alt+g")?.handler(restored.ctx);
      subtest.mock.timers.tick(720_000);
      await flushPromises();
      assert.equal(restored.messages.length, 0, "a smaller retained scope must not queue any retry");
      assert.equal(latestGoal(restored.entries)?.pauseReason, "permission-blocker");
      assert.deepEqual(restored.entries.slice(0, history.length), history, "replay never repairs or rewrites history");
    });
  }
});

test("issue #415: unrelated goal corruption and generic history do not poison a valid permission retry", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const first = createContinuationHarness();
  await first.handlers.get("session_start")?.({}, first.ctx);
  await first.commands.get("goal")?.handler("verify fixture access", first.ctx);
  await settlePermissionFailure(first, "Blocked.");
  await first.handlers.get("session_shutdown")?.({}, first.ctx);
  const restored = createContinuationHarness();
  t.after(() => restored.handlers.get("session_shutdown")?.({}, restored.ctx));
  restored.entries.push(...structuredClone(first.entries));
  for (const data of [
    { version: 2, kind: "permission-hold", goalId: "unrelated-goal", at: null },
    { version: 2, kind: "permission-release", goalId: "unrelated-goal", at: null },
    { version: 2, kind: "permission-hold", at: null },
    { version: 2, kind: "continuation-state", goalId: latestGoal(restored.entries)!.goalId, at: null },
  ]) restored.entries.push({ type: "custom", customType: "pi-better-goal", data });
  await restored.handlers.get("session_start")?.({}, restored.ctx);
  assert.equal((await inspectPermissionHold(restored)).saturated, false);
  await restored.commands.get("goal")?.handler("resume", restored.ctx);
  assert.equal(restored.messages.length, 1, "known matching permission authority is unaffected by unrelated records");
  assert.equal((await inspectPermissionHold(restored)).retryPending, true);
});

test("held resumes preserve active time across repeated holds and later pause/completion", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 1_000_000 });
  const h = createContinuationHarness();
  const clock = async () => {
    const result = await h.tools.get("get_goal")!.execute("clock", {}, undefined, undefined, toolContext(h.ctx));
    return (result.details as { timing: { activeSeconds: number; elapsedSeconds: number } }).timing;
  };
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("preserve the clock", h.ctx);
  for (let cycle = 0; cycle < 2; cycle += 1) {
    await exhaustNoProgressRetries(h, t);
    const before = await clock();
    assert.ok(before.activeSeconds > 0);
    assert.equal(before.activeSeconds, before.elapsedSeconds);
    await h.commands.get("goal")?.handler("resume", h.ctx);
    assert.deepEqual(await clock(), before, "reopening a hold is not an active-state transition");
  }
  const resumed = await clock();
  await h.commands.get("goal")?.handler("pause", h.ctx);
  t.mock.timers.tick(20_000);
  assert.deepEqual(await clock(), { activeSeconds: resumed.activeSeconds, elapsedSeconds: resumed.elapsedSeconds + 20 });
  await h.commands.get("goal")?.handler("resume", h.ctx);
  t.mock.timers.tick(5_000);
  await h.commands.get("goal")?.handler("complete", h.ctx);
  assert.deepEqual(await clock(), { activeSeconds: resumed.activeSeconds + 5, elapsedSeconds: resumed.elapsedSeconds + 25 });
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
});

test("/goal resume does not restart a non-held active or completed goal", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = createContinuationHarness();
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("keep working", h.ctx);
  const before = h.messages.length;
  await h.commands.get("goal")?.handler("resume", h.ctx);
  assert.equal(h.messages.length, before);
  await h.commands.get("goal")?.handler("complete", h.ctx);
  await h.commands.get("goal")?.handler("resume", h.ctx);
  assert.equal(latestGoal(h.entries)?.status, "complete");
  assert.equal(h.messages.length, before);
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
});

test("background drain and callback results preserve an exhausted no-progress hold", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = createContinuationHarness();
  let active = false;
  h.events.emit("pi-better-goal:register-provider", {
    id: "fixture",
    getActivity: () => ({ providerId: "fixture", items: active ? [{ id: "work", status: "running", active: true }] : [] }),
  });
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("wait for recovery", h.ctx);
  await exhaustNoProgressRetries(h, t);
  const held = latestContinuationState(h.entries);
  assert.equal(held?.blocked, true);
  const before = h.messages.length;

  active = true;
  await h.handlers.get("agent_start")?.({}, h.ctx);
  active = false;
  await h.handlers.get("tool_execution_start")?.({ toolName: "ask_user_question", toolCallId: "question" }, h.ctx);
  assert.deepEqual(latestContinuationState(h.entries), held, "a drain is not explicit resume");
  await h.handlers.get("agent_end")?.({ messages: [{ role: "toolResult", toolName: "subagent_result", content: [{ type: "text", text: "completed" }] }] }, h.ctx);
  await h.handlers.get("agent_settled")?.({}, h.ctx);
  t.mock.timers.tick(720_000);
  await flushPromises();
  assert.deepEqual(latestContinuationState(h.entries), held, "a callback may be handled without reopening the loop");
  assert.equal(h.messages.length, before, "the drain does not schedule autonomous continuation");
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
});

test("each background active-to-idle cycle resets backoff even for the same task identity", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = createContinuationHarness();
  let active = false;
  h.events.emit("pi-better-goal:register-provider", {
    id: "fixture",
    getActivity: () => ({ providerId: "fixture", items: active ? [{ id: "work", status: "running", active: true }] : [] }),
  });
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("watch recurring work", h.ctx);
  for (let cycle = 0; cycle < 2; cycle += 1) {
    await settleNetworkFailure(h);
    await settleNetworkFailure(h);
    assert.ok((latestContinuationState(h.entries)?.noProgressRetries ?? 0) > 0);
    active = true;
    await h.handlers.get("agent_start")?.({}, h.ctx);
    active = false;
    await h.handlers.get("tool_execution_start")?.({ toolName: "ask_user_question", toolCallId: `question-${cycle}` }, h.ctx);
    assert.equal(latestContinuationState(h.entries)?.noProgressRetries, 0, `cycle ${cycle} resets the durable ledger`);
    await h.handlers.get("agent_end")?.(networkFailureOutcome, h.ctx);
    await h.handlers.get("agent_settled")?.({}, h.ctx);
  }
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
});

test("an idle background drain keeps its base-delay harvest wake without resetting again at handoff", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = createContinuationHarness();
  let active = false;
  h.events.emit("pi-better-goal:register-provider", {
    id: "fixture",
    getActivity: () => ({ providerId: "fixture", items: active ? [{ id: "work", status: "running", active: true }] : [] }),
  });
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("harvest completed work", h.ctx);
  await settleNetworkFailure(h);
  await settleNetworkFailure(h);
  assert.equal(latestContinuationState(h.entries)?.noProgressRetries, 1);
  active = true;
  await h.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, h.ctx);
  active = false;
  await h.handlers.get("agent_settled")?.({}, h.ctx);
  assert.equal(latestContinuationState(h.entries)?.noProgressRetries, 0);
  const entriesBeforeWake = h.entries.length;
  const before = h.messages.length;
  t.mock.timers.tick(59_999);
  await flushPromises();
  assert.equal(h.messages.length, before);
  t.mock.timers.tick(1);
  await flushPromises();
  assert.equal(h.messages.length, before + 1);
  assert.equal((h.messages.at(-1) as { details: { kind: string } }).details.kind, "background-drained");
  assert.equal(h.entries.length, entriesBeforeWake, "sending a wake must not erase newer evidence again");
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
});

test("background drains do not resume explicitly paused goals", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = createContinuationHarness();
  let active = false;
  h.events.emit("pi-better-goal:register-provider", {
    id: "fixture",
    getActivity: () => ({ providerId: "fixture", items: active ? [{ id: "work", status: "running", active: true }] : [] }),
  });
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("watch work", h.ctx);
  await settleNetworkFailure(h);
  await settleNetworkFailure(h);
  await h.commands.get("goal")?.handler("pause", h.ctx);
  const before = h.messages.length;
  active = true;
  await h.handlers.get("agent_start")?.({}, h.ctx);
  active = false;
  await h.handlers.get("agent_settled")?.({}, h.ctx);
  t.mock.timers.tick(360_000);
  await flushPromises();
  assert.equal(latestGoal(h.entries)?.status, "paused");
  assert.equal(latestContinuationState(h.entries)?.noProgressRetries, 1);
  assert.equal(h.messages.length, before);
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
});

test("changed evidence resets accumulated backoff to the base delay", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = createContinuationHarness();
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("wait for recovery", h.ctx);
  await settleNetworkFailure(h);
  await settleNetworkFailure(h);
  assert.equal(latestContinuationState(h.entries)?.noProgressRetries, 1);
  await h.handlers.get("agent_start")?.({}, h.ctx);
  await h.handlers.get("agent_end")?.(answeredOutcome, h.ctx);
  await h.handlers.get("agent_settled")?.({}, h.ctx);
  assert.equal(latestContinuationState(h.entries)?.noProgressRetries, 0);
  const before = h.messages.length;
  t.mock.timers.tick(59_999);
  await flushPromises();
  assert.equal(h.messages.length, before);
  t.mock.timers.tick(1);
  await flushPromises();
  assert.equal(h.messages.length, before + 1);
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
});

test("enlarged backoff is cancelled by background work or an interrupt", async (t) => {
  for (const cause of ["background", "interrupt"] as const) {
    await t.test(cause, async (subtest) => {
      subtest.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
      const controller = new AbortController();
      const h = createContinuationHarness(controller.signal);
      let active = false;
      h.events.emit("pi-better-goal:register-provider", {
        id: "fixture",
        getActivity: () => ({ providerId: "fixture", items: active ? [{ id: "work", status: "running", active: true }] : [] }),
      });
      await h.handlers.get("session_start")?.({}, h.ctx);
      await h.commands.get("goal")?.handler("wait for recovery", h.ctx);
      await settleNetworkFailure(h);
      await settleNetworkFailure(h);
      assert.equal(latestContinuationState(h.entries)?.noProgressRetries, 1);
      const before = h.messages.length;
      if (cause === "background") active = true;
      else controller.abort();
      subtest.mock.timers.tick(120_000);
      await flushPromises();
      assert.equal(h.messages.length, before);
      assert.equal(latestGoal(h.entries)?.status, cause === "interrupt" ? "paused" : "active");
      await h.handlers.get("session_shutdown")?.({}, h.ctx);
    });
  }
});

test("a drain invalidates cached evidence until a fresh post-drain turn settles", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = createContinuationHarness();
  let active = false;
  h.events.emit("pi-better-goal:register-provider", {
    id: "fixture", getActivity: () => fixtureActivity(active),
  });
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("harvest fresh evidence", h.ctx);
  await settleNetworkFailure(h);
  active = true;
  await h.handlers.get("agent_start")?.({}, h.ctx);
  await h.handlers.get("agent_end")?.(answeredOutcome, h.ctx);
  active = false;
  await h.handlers.get("agent_settled")?.({}, h.ctx);
  assert.equal(latestContinuationState(h.entries)?.lastEvidenceSignature, null);
  const beforeMissingEvidence = h.entries.length;
  await h.handlers.get("agent_settled")?.({}, h.ctx);
  assert.equal(h.entries.length, beforeMissingEvidence, "missing evidence cannot establish a synthetic baseline");
  await h.handlers.get("agent_start")?.({}, h.ctx);
  await h.handlers.get("agent_end")?.(answeredOutcome, h.ctx);
  await h.handlers.get("agent_settled")?.({}, h.ctx);
  assert.equal(typeof latestContinuationState(h.entries)?.lastEvidenceSignature, "string");
  assert.equal(latestContinuationState(h.entries)?.noProgressRetries, 0);
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
});

test("an outcome from the replaced goal cannot become the new goal's baseline", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = createContinuationHarness();
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("old objective", h.ctx);
  await h.handlers.get("agent_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("new objective", h.ctx);
  await h.handlers.get("agent_end")?.(answeredOutcome, h.ctx);
  await h.handlers.get("agent_settled")?.({}, h.ctx);
  assert.equal(latestContinuationState(h.entries)?.lastEvidenceSignature, null);
  await h.handlers.get("agent_start")?.({}, h.ctx);
  await h.handlers.get("agent_end")?.(answeredOutcome, h.ctx);
  await h.handlers.get("agent_settled")?.({}, h.ctx);
  assert.equal(latestContinuationState(h.entries)?.noProgressRetries, 0);
  assert.equal(typeof latestContinuationState(h.entries)?.lastEvidenceSignature, "string");
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
});

test("drain reset is durable before activity listeners can pause the goal", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = createContinuationHarness();
  let active = false;
  h.events.emit("pi-better-goal:register-provider", { id: "fixture", getActivity: () => fixtureActivity(active) });
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("harvest work", h.ctx);
  await settleNetworkFailure(h);
  await settleNetworkFailure(h);
  active = true;
  await h.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, h.ctx);
  let observedReset = false;
  h.events.once("pi-better-goal:activity", () => {
    observedReset = latestContinuationState(h.entries)?.noProgressRetries === 0;
    void h.commands.get("goal")?.handler("pause", h.ctx);
  });
  active = false;
  const before = h.messages.length;
  await h.handlers.get("agent_settled")?.({}, h.ctx);
  assert.equal(observedReset, true);
  assert.equal(latestGoal(h.entries)?.status, "paused");
  t.mock.timers.tick(300_000);
  await flushPromises();
  assert.equal(h.messages.length, before);
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
});

test("obsolete concurrent provider results neither publish nor rearm a drain", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = createContinuationHarness();
  const pending = deferred<ReturnType<typeof fixtureActivity>>();
  let holdNext = false;
  h.events.emit("pi-better-goal:register-provider", {
    id: "fixture", getActivity: () => {
      if (!holdNext) return fixtureActivity(false);
      holdNext = false;
      return pending.promise;
    },
  });
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("compare snapshots", h.ctx);
  await settleNetworkFailure(h);
  await settleNetworkFailure(h);
  const published: boolean[] = [];
  h.events.on("pi-better-goal:activity", (snapshot) => published.push(snapshot.backgroundRunning));
  holdNext = true;
  const tool = h.tools.get("get_background_activity")!;
  const first = tool.execute("old", {}, undefined, undefined, toolContext(h.ctx));
  await flushPromises();
  const second = await tool.execute("new", {}, undefined, undefined, toolContext(h.ctx));
  assert.equal((second.details as { backgroundRunning: boolean }).backgroundRunning, false);
  pending.resolve(fixtureActivity(true));
  assert.equal(((await first).details as { backgroundRunning: boolean }).backgroundRunning, false);
  await tool.execute("fresh", {}, undefined, undefined, toolContext(h.ctx));
  assert.ok(published.length > 0 && published.every((active) => !active));
  assert.equal(latestContinuationState(h.entries)?.noProgressRetries, 1);
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
});

test("wake-disabled observation preserves an exhausted hold without automatic handoffs", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  isolatePreferences(t);
  const overrides = {
    PI_BETTER_GOAL_DISABLE_WAKE: "1",
    PI_BETTER_GOAL_IDLE_CONTINUATION_DELAY_MS: "0",
    PI_BETTER_GOAL_MAX_NO_PROGRESS_RETRIES: "1",
  };
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, overrides);
    const fresh = await import(`${new URL("../src/index.ts", import.meta.url).href}?wake-disabled`);
    const h = createContinuationHarness(undefined, { factory: fresh.default });
    let active = false;
    h.events.emit("pi-better-goal:register-provider", { id: "fixture", getActivity: () => fixtureActivity(active) });
    await h.handlers.get("session_start")?.({}, h.ctx);
    await h.commands.get("goal")?.handler("settings auto-continue on", h.ctx);
    await h.commands.get("goal")?.handler("observe without waking", h.ctx);
    await settleNetworkFailure(h);
    await settleNetworkFailure(h);
    assert.equal(latestContinuationState(h.entries)?.blocked, true);
    active = true;
    await h.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, h.ctx);
    active = false;
    await h.handlers.get("agent_settled")?.({}, h.ctx);
    assert.equal(latestContinuationState(h.entries)?.blocked, true);
    assert.equal(latestContinuationState(h.entries)?.noProgressRetries, 1);
    const before = h.messages.length;
    t.mock.timers.tick(10_000);
    await flushPromises();
    assert.equal(h.messages.length, before);
    await h.handlers.get("session_shutdown")?.({}, h.ctx);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("in-flight wake audits cannot survive pause, Escape, resume, replacement, completion, interactive input, foreground start, session replacement, settings disable or shutdown", async (t) => {
  for (const cause of ["pause", "escape", "resume", "replace", "complete", "input", "foreground", "session", "settings", "shutdown"] as const) {
    await t.test(cause, async (subtest) => {
      subtest.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
      if (cause === "settings") isolatePreferences(subtest);
      const h = createContinuationHarness(undefined, cause === "escape" ? { hasUI: true, mode: "tui" } : {});
      let delayed = false;
      const pending: Array<ReturnType<typeof deferred<ReturnType<typeof fixtureActivity>>>> = [];
      h.events.emit("pi-better-goal:register-provider", {
        id: "fixture", getActivity: () => {
          if (!delayed) return fixtureActivity(false);
          const gate = deferred<ReturnType<typeof fixtureActivity>>();
          pending.push(gate);
          return gate.promise;
        },
      });
      await h.handlers.get("session_start")?.({}, h.ctx);
      await h.commands.get("goal")?.handler("original objective", h.ctx);
      await settleNetworkFailure(h);
      subtest.mock.timers.tick(59_999);
      await flushPromises();
      delayed = true;
      subtest.mock.timers.tick(1);
      await flushPromises();
      assert.ok(pending.length > 0, "the audit must be awaiting an external provider");
      let changed: unknown;
      if (cause === "foreground" || cause === "session") {
        changed = h.handlers.get(cause === "session" ? "session_start" : "agent_start")?.({}, h.ctx);
      } else if (cause === "input") {
        await h.handlers.get("input")?.({ text: "new instruction", source: "interactive" }, h.ctx);
      } else if (cause === "settings") {
        await h.commands.get("goal")?.handler("settings auto-continue off", h.ctx);
      } else if (cause === "shutdown") {
        await h.handlers.get("session_shutdown")?.({}, h.ctx);
        Object.defineProperty(h.ctx, "isIdle", { value: () => { throw new Error("stale context read"); } });
      } else if (cause === "escape") {
        h.terminalInput("\x1b");
      } else {
        await h.commands.get("goal")?.handler(cause === "replace" ? "replacement objective" : cause === "complete" ? "complete" : "pause", h.ctx);
        if (cause === "resume") await h.commands.get("goal")?.handler("resume", h.ctx);
      }
      await flushPromises();
      const afterChange = h.messages.length;
      const goalAfterChange = latestGoal(h.entries);
      assert.ok(goalAfterChange?.goalId);
      delayed = false;
      for (const gate of pending) gate.resolve(fixtureActivity(false));
      await changed;
      await flushPromises();
      assert.equal(h.messages.length, afterChange, "an obsolete audit cannot enqueue a turn");
      assert.equal(latestGoal(h.entries)?.goalId, goalAfterChange?.goalId);
      assert.equal(latestGoal(h.entries)?.status, goalAfterChange?.status);
      if (cause !== "shutdown") await h.handlers.get("session_shutdown")?.({}, h.ctx);
    });
  }
});

test("an aborted run pauses the active goal and suppresses pokes while paused", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { commands, handlers, messages, ctx, entries } = createContinuationHarness();

  await handlers.get("session_start")?.({}, ctx);
  await commands.get("goal")?.handler("keep watching", ctx);
  assert.equal(messages.length, 1, "setting a goal starts its first autonomous turn");
  messages.length = 0;

  const abortedOutcome = { messages: [{ role: "assistant", content: [], stopReason: "aborted" }] };
  await handlers.get("agent_end")?.(abortedOutcome, ctx);
  assert.equal(latestGoal(entries)?.status, "paused");

  await handlers.get("agent_start")?.({}, ctx);
  await handlers.get("agent_settled")?.({}, ctx);
  t.mock.timers.tick(60_000);
  await flushPromises();
  assert.equal(messages.length, 0, "paused goals are never poked");
});

test("terminal Escape pauses an idle goal, cancels its wake, and passes through unchanged", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 1_000_000 });
  const h = createContinuationHarness(undefined, { hasUI: true, mode: "tui" });
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("keep watching", h.ctx);
  await h.handlers.get("agent_start")?.({}, h.ctx);
  await h.handlers.get("agent_end")?.(answeredOutcome, h.ctx);
  await h.handlers.get("agent_settled")?.({}, h.ctx);
  t.mock.timers.tick(5_000);
  const timing = async () => (await h.tools.get("get_goal")!.execute("clock", {}, undefined, undefined, toolContext(h.ctx))).details as { timing: { activeSeconds: number } };
  const before = await timing();
  const messagesBefore = h.messages.length;

  assert.equal(h.terminalListeners.size, 1);
  assert.deepEqual(h.terminalInput("\x1b"), [undefined], "the observer neither consumes nor rewrites Escape");
  assert.equal(h.getAborts(), 0, "Pi, not the observer, owns interrupting the agent");
  assert.equal(latestGoal(h.entries)?.status, "paused");
  assert.equal(latestGoal(h.entries)?.pauseReason, "interrupt");
  assert.ok(h.activeTools().includes("goal_resume"));
  await h.handlers.get("input")?.({ source: "interactive", text: "why this step?" }, h.ctx);
  t.mock.timers.tick(120_000);
  await flushPromises();
  assert.equal(h.messages.length, messagesBefore, "Escape cancels the scheduled between-turn continuation");
  assert.equal(latestGoal(h.entries)?.status, "paused", "an ordinary question does not resume it");
  assert.equal((await timing()).timing.activeSeconds, before.timing.activeSeconds, "the active clock stops");
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
});

test("Escape pause Off preserves idle wakes, manual pauses, and toggles back On immediately", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  isolatePreferences(t);
  const h = createContinuationHarness(undefined, { hasUI: true, mode: "tui" });
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("keep watching", h.ctx);
  await settleNetworkFailure(h);
  await h.commands.get("goal")?.handler("settings pause-on-escape off", h.ctx);
  const before = h.entries.length;
  assert.deepEqual(h.terminalInput("\x1b"), [undefined]);
  assert.equal(h.entries.length, before, "idle Off does not mutate the goal");
  assert.equal(latestGoal(h.entries)?.status, "active");
  t.mock.timers.tick(60_000);
  await flushPromises();
  assert.equal(h.messages.length, 2, "Escape Off leaves automatic continuation enabled");
  assert.equal(h.activeTools().includes("goal_resume"), false);
  await h.commands.get("goal")?.handler("pause", h.ctx);
  h.terminalInput("\x1b");
  assert.equal(latestGoal(h.entries)?.status, "paused", "Off never overrides a manual pause");
  assert.equal(latestGoal(h.entries)?.pauseReason, undefined);
  await h.commands.get("goal")?.handler("resume", h.ctx);
  await h.commands.get("goal")?.handler("settings pause-on-escape on", h.ctx);
  assert.equal(latestGoal(h.entries)?.status, "active", "changing the option itself does not pause");
  assert.deepEqual(h.terminalInput("\x1b"), [undefined]);
  assert.equal(latestGoal(h.entries)?.pauseReason, "interrupt");
  assert.ok(h.activeTools().includes("goal_resume"), "Escape pause does not disable conversational resume");
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
});

test("streaming Escape Off exempts its signal and aborted agent_end, not the next unrelated abort", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  isolatePreferences(t);
  const controller = new AbortController();
  const h = createContinuationHarness(controller.signal, { hasUI: true, mode: "tui" });
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("keep watching", h.ctx);
  await h.commands.get("goal")?.handler("settings pause-on-escape off", h.ctx);
  h.setBusy(true);
  await h.handlers.get("agent_start")?.({}, h.ctx);
  assert.deepEqual(h.terminalInput("\x1b[27u"), [undefined]);
  assert.equal(h.getAborts(), 0, "the observer leaves native interruption to Pi");
  // A later setting change must not reclassify an already-observed Escape.
  await h.commands.get("goal")?.handler("settings pause-on-escape on", h.ctx);
  controller.abort();
  assert.equal(latestGoal(h.entries)?.status, "active", "the associated signal cannot pause");
  await h.handlers.get("agent_end")?.(abortedOutcome, h.ctx);
  assert.equal(latestGoal(h.entries)?.status, "active", "the associated final message cannot pause either");
  h.setBusy(false);
  await h.handlers.get("agent_settled")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("settings pause-on-escape off", h.ctx);
  const next = new AbortController();
  Object.assign(h.ctx, { signal: next.signal });
  h.setBusy(true);
  await h.handlers.get("agent_start")?.({}, h.ctx);
  next.abort();
  assert.equal(latestGoal(h.entries)?.status, "paused", "Off does not disable unrelated signal interrupts");
  await h.handlers.get("agent_end")?.(abortedOutcome, h.ctx);
  assert.equal(latestGoal(h.entries)?.pauseReason, "interrupt");
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
});

test("idle Escape Off and unavailable focus inspection do not suppress unknown abort fallbacks", async (t) => {
  for (const cause of ["idle", "unknown-editor", "menu", "prompt", "overlay"] as const) {
    await t.test(cause, async (subtest) => {
      subtest.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
      isolatePreferences(subtest);
      const h = createContinuationHarness(undefined, { hasUI: true, mode: "tui" });
      await h.handlers.get("session_start")?.({}, h.ctx);
      await h.commands.get("goal")?.handler("keep watching", h.ctx);
      await h.commands.get("goal")?.handler("settings pause-on-escape off", h.ctx);
      if (cause !== "idle") {
        h.setBusy(true);
        await h.handlers.get("agent_start")?.({}, h.ctx);
      }
      if (cause === "unknown-editor") h.setTerminalFocus({ render: () => [] });
      if (cause === "menu") h.setAutocomplete(true);
      if (cause === "prompt") await h.handlers.get("ui_prompt_start")?.({}, h.ctx);
      if (cause === "overlay") h.setOverlay(true);
      assert.deepEqual(h.terminalInput("\x1b"), [undefined]);
      assert.equal(latestGoal(h.entries)?.status, "active");
      await h.handlers.get("agent_end")?.(abortedOutcome, h.ctx);
      assert.equal(latestGoal(h.entries)?.status, "paused", "an unassociated aborted outcome retains the safety fallback");
      await h.handlers.get("session_shutdown")?.({}, h.ctx);
    });
  }
});

test("Escape suppression and stale signal callbacks cannot leak across runs or sessions", async (t) => {
  for (const boundary of ["run", "session"] as const) {
    await t.test(boundary, async (subtest) => {
      subtest.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
      isolatePreferences(subtest);
      const old = new AbortController();
      const h = createContinuationHarness(old.signal, { hasUI: true, mode: "tui" });
      await h.handlers.get("session_start")?.({}, h.ctx);
      await h.commands.get("goal")?.handler("keep watching", h.ctx);
      await h.commands.get("goal")?.handler("settings pause-on-escape off", h.ctx);
      h.setBusy(true);
      await h.handlers.get("agent_start")?.({}, h.ctx);
      h.terminalInput("\x1b");
      if (boundary === "session") await h.handlers.get("session_start")?.({}, h.ctx);
      const next = new AbortController();
      Object.assign(h.ctx, { signal: next.signal });
      if (boundary === "run") await h.handlers.get("agent_start")?.({}, h.ctx);
      old.abort();
      assert.equal(latestGoal(h.entries)?.status, "active", "an obsolete turn signal cannot pause current work");
      await h.handlers.get("agent_end")?.(abortedOutcome, h.ctx);
      assert.equal(latestGoal(h.entries)?.status, "paused", "old Escape suppression cannot exempt a new aborted outcome");
      await h.handlers.get("session_shutdown")?.({}, h.ctx);
    });
  }
});

test("replacing a goal after Escape Off does not exempt that goal from the current turn's abort", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  isolatePreferences(t);
  const controller = new AbortController();
  const h = createContinuationHarness(controller.signal, { hasUI: true, mode: "tui" });
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("keep watching", h.ctx);
  await h.commands.get("goal")?.handler("settings pause-on-escape off", h.ctx);
  h.setBusy(true);
  await h.handlers.get("agent_start")?.({}, h.ctx);
  h.terminalInput("\x1b");
  await h.commands.get("goal")?.handler("replacement goal", h.ctx);
  controller.abort();
  assert.equal(latestGoal(h.entries)?.objective, "replacement goal");
  assert.equal(latestGoal(h.entries)?.status, "paused", "the live turn's signal still protects a replacement goal");
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
});

test("Escape observer ignores non-press input and menu/dialog input ownership", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = createContinuationHarness(undefined, { hasUI: true, mode: "tui" });
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("keep watching", h.ctx);
  const before = h.entries.length;
  for (const data of ["x", "\x1b[A", "\x1bg", "\x1b[27;1:3u", "\x1b[200~\x1b\x1b[201~"]) {
    assert.deepEqual(h.terminalInput(data), [undefined]);
  }
  h.setAutocomplete(true);
  assert.deepEqual(h.terminalInput("\x1b"), [undefined]);
  h.setAutocomplete(false);
  h.setTerminalFocus(null);
  assert.deepEqual(h.terminalInput("\x1b"), [undefined]);
  h.setTerminalFocus({ render: () => [], invalidate() {}, handleInput() {} });
  assert.deepEqual(h.terminalInput("\x1b"), [undefined]);
  h.restoreEditorFocus();
  h.setOverlay(true);
  assert.deepEqual(h.terminalInput("\x1b"), [undefined]);
  h.setOverlay(false);
  await h.handlers.get("ui_prompt_start")?.({}, h.ctx);
  await h.handlers.get("ui_prompt_start")?.({}, h.ctx);
  await h.handlers.get("ui_prompt_end")?.({}, h.ctx);
  assert.deepEqual(h.terminalInput("\x1b"), [undefined], "nested prompts keep Escape dialog-owned");
  assert.equal(h.entries.length, before, "non-interrupt keys and modal cancellation do not change goal state");
  await h.handlers.get("ui_prompt_end")?.({}, h.ctx);
  assert.deepEqual(h.terminalInput("\x1b[27u"), [undefined], "Kitty Escape presses also pass through");
  assert.equal(latestGoal(h.entries)?.status, "paused");
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
});

test("terminal Escape creates no goal and leaves manual/interrupt pauses and completion unchanged", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = createContinuationHarness(undefined, { hasUI: true, mode: "tui" });
  await h.handlers.get("session_start")?.({}, h.ctx);
  assert.deepEqual(h.terminalInput("\x1b"), [undefined]);
  assert.equal(h.entries.length, 0);
  for (const state of ["manual", "interrupt", "complete"] as const) {
    await h.commands.get("goal")?.handler("keep watching", h.ctx);
    if (state === "interrupt") h.terminalInput("\x1b");
    else await h.commands.get("goal")?.handler(state === "manual" ? "pause" : "complete", h.ctx);
    const before: number = h.entries.length;
    assert.deepEqual(h.terminalInput("\x1b"), [undefined]);
    assert.equal(h.entries.length, before, `${state} is unchanged by repeated Escape`);
    assert.equal(latestGoal(h.entries)?.status, state === "complete" ? "complete" : "paused");
    assert.equal(latestGoal(h.entries)?.pauseReason, state === "interrupt" ? "interrupt" : undefined);
  }
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
});

test("terminal observer detaches on restart/shutdown and does not attach outside the TUI", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = createContinuationHarness(undefined, { hasUI: true, mode: "tui" });
  await h.handlers.get("session_start")?.({}, h.ctx);
  const stale = [...h.terminalListeners][0]!;
  await h.handlers.get("session_start")?.({}, h.ctx);
  assert.equal(h.terminalListeners.size, 1, "session replacement never accumulates observers");
  await h.commands.get("goal")?.handler("keep watching", h.ctx);
  const before = h.entries.length;
  assert.equal(stale("\x1b"), undefined);
  assert.equal(h.entries.length, before, "an obsolete listener cannot change the new session");
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
  assert.equal(h.terminalListeners.size, 0, "shutdown is idempotent");
  await h.handlers.get("session_start")?.({}, h.ctx);
  assert.equal(h.terminalListeners.size, 1, "a reloaded runtime attaches again");
  h.terminalInput("\x1b");
  assert.equal(latestGoal(h.entries)?.status, "paused");
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
  for (const mode of ["rpc", "print", "json"] as const) {
    const other = createContinuationHarness(undefined, { hasUI: true, mode });
    await other.handlers.get("session_start")?.({}, other.ctx);
    assert.equal(other.terminalListeners.size, 0);
    await other.handlers.get("session_shutdown")?.({}, other.ctx);
  }
});

test("an aborted run cancels an already-scheduled idle continuation", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { commands, handlers, messages, ctx, entries } = createContinuationHarness();

  await handlers.get("session_start")?.({}, ctx);
  await commands.get("goal")?.handler("keep watching", ctx);
  messages.length = 0;

  await handlers.get("agent_start")?.({}, ctx);
  await handlers.get("agent_settled")?.({}, ctx);
  assert.equal(messages.length, 0, "the continuation waits for the grace period");

  const abortedOutcome = { messages: [{ role: "assistant", content: [], stopReason: "aborted" }] };
  await handlers.get("agent_end")?.(abortedOutcome, ctx);
  assert.equal(latestGoal(entries)?.status, "paused");

  t.mock.timers.tick(60_000);
  await flushPromises();
  assert.equal(messages.length, 0, "pausing before the grace period elapses cancels the poke");
});

test("an aborted run pauses the goal while the agent is running", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { commands, handlers, ctx, entries, setBusy } = createContinuationHarness();

  await handlers.get("session_start")?.({}, ctx);
  await commands.get("goal")?.handler("keep watching", ctx);

  setBusy(true);
  const abortedOutcome = { messages: [{ role: "assistant", content: [], stopReason: "aborted" }] };
  await handlers.get("agent_end")?.(abortedOutcome, ctx);
  setBusy(false);

  assert.equal(latestGoal(entries)?.status, "paused");
});

test("aborting the active turn pauses the goal before agent_end", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const controller = new AbortController();
  const { commands, handlers, ctx, entries, setBusy } = createContinuationHarness(controller.signal);

  await handlers.get("session_start")?.({}, ctx);
  await commands.get("goal")?.handler("keep watching", ctx);

  setBusy(true);
  await handlers.get("agent_start")?.({}, ctx);
  controller.abort();

  assert.equal(
    latestGoal(entries)?.status,
    "paused",
    "Escape aborts the turn signal even when agent_end has no aborted assistant message yet",
  );
});

test("an aborted run without an active goal creates no goal", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { handlers, ctx, entries } = createContinuationHarness();

  await handlers.get("session_start")?.({}, ctx);
  const abortedOutcome = { messages: [{ role: "assistant", content: [], stopReason: "aborted" }] };
  await handlers.get("agent_end")?.(abortedOutcome, ctx);

  assert.equal(latestGoal(entries), undefined, "an abort without a goal creates nothing");
});

test("an escape pause stays paused while the user asks a question; no continuation runs", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { commands, handlers, messages, ctx, entries } = createContinuationHarness();

  await handlers.get("session_start")?.({}, ctx);
  await commands.get("goal")?.handler("keep watching", ctx);
  messages.length = 0;

  await handlers.get("agent_start")?.({}, ctx);
  await handlers.get("agent_end")?.(abortedOutcome, ctx);
  assert.equal(latestGoal(entries)?.status, "paused");
  assert.equal(latestGoal(entries)?.pauseReason, "interrupt");

  await handlers.get("input")?.({ source: "interactive", text: "why is recipient-test failing?" }, ctx);
  assert.equal(latestGoal(entries)?.status, "paused", "a question does not resume the goal");

  await handlers.get("agent_start")?.({}, ctx);
  await handlers.get("agent_end")?.(answeredOutcome, ctx);
  await handlers.get("agent_settled")?.({}, ctx);
  t.mock.timers.tick(60_000);
  await flushPromises();
  assert.equal(messages.length, 0, "the goal loop does not restart after the answer");
  assert.equal(latestGoal(entries)?.status, "paused");
});

test("goal_resume resumes an escape-paused goal and its continuation runs", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { commands, handlers, messages, ctx, entries, tools, activeTools } = createContinuationHarness();

  await handlers.get("session_start")?.({}, ctx);
  await commands.get("goal")?.handler("keep watching", ctx);
  messages.length = 0;
  await handlers.get("agent_start")?.({}, ctx);
  await handlers.get("agent_end")?.(abortedOutcome, ctx);
  assert.ok(activeTools().includes("goal_resume"), "the model sees goal_resume while the goal is escape-paused");

  await handlers.get("input")?.({ source: "interactive", text: "go" }, ctx);
  await handlers.get("agent_start")?.({}, ctx);
  const result = await tools.get("goal_resume")!.execute("call", { reason: "user said go" }, undefined, undefined, toolContext(ctx));
  assert.equal((result.details as { ok: boolean }).ok, true);
  assert.equal(latestGoal(entries)?.status, "active");
  assert.equal(latestGoal(entries)?.pauseReason, undefined);
  assert.equal(activeTools().includes("goal_resume"), false, "the tool leaves the model's list once the goal runs");
  assert.equal(messages.length, 1, "resuming queues the continuation, as /goal resume does");
  assert.match(String((messages[0] as { content?: unknown }).content), /Continue working toward the active thread goal/);
});

test("goal_resume is absent and refused unless the goal is escape-paused", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { commands, handlers, messages, ctx, entries, tools, activeTools } = createContinuationHarness();
  await handlers.get("session_start")?.({}, ctx);
  const goalResume = tools.get("goal_resume")!;
  assert.equal(activeTools().includes("goal_resume"), false, "no goal: the tool is not offered");
  const noGoal = await goalResume.execute("call", {}, undefined, undefined, toolContext(ctx));
  assert.equal((noGoal.details as { ok: boolean }).ok, false);

  await commands.get("goal")?.handler("keep watching", ctx);
  assert.equal(activeTools().includes("goal_resume"), false, "active goal: the tool is not offered");
  const whileActive = await goalResume.execute("call", {}, undefined, undefined, toolContext(ctx));
  assert.equal((whileActive.details as { ok: boolean }).ok, false);

  await commands.get("goal")?.handler("pause", ctx);
  messages.length = 0;
  assert.equal(activeTools().includes("goal_resume"), false, "/goal pause: only the user resumes");
  const afterPause = await goalResume.execute("call", {}, undefined, undefined, toolContext(ctx));
  assert.equal((afterPause.details as { ok: boolean }).ok, false);
  assert.match((afterPause.content[0] as { text: string }).text, /\/goal resume/);
  assert.equal(latestGoal(entries)?.status, "paused");
  assert.equal(messages.length, 0);
});

test("an escape pause persisted by an older version stays paused after reload until /goal resume", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const first = createContinuationHarness();
  await first.handlers.get("session_start")?.({}, first.ctx);
  await first.commands.get("goal")?.handler("keep watching", first.ctx);
  await first.handlers.get("agent_end")?.(abortedOutcome, first.ctx);
  await first.handlers.get("session_shutdown")?.({}, first.ctx);

  const second = createContinuationHarness();
  second.entries.push(...first.entries);
  await second.handlers.get("session_start")?.({}, second.ctx);
  assert.equal(latestGoal(second.entries)?.status, "paused");
  assert.ok(second.activeTools().includes("goal_resume"), "a restored escape pause offers goal_resume");
  t.mock.timers.tick(60_000);
  await flushPromises();
  assert.equal(second.messages.length, 0, "a reloaded paused goal is not poked on its own");

  await second.handlers.get("input")?.({ source: "interactive", text: "continue" }, second.ctx);
  assert.equal(latestGoal(second.entries)?.status, "paused", "a message alone never resumes; the agent decides via goal_resume");

  await second.commands.get("goal")?.handler("resume", second.ctx);
  assert.equal(latestGoal(second.entries)?.status, "active");
  assert.equal(second.messages.length, 1, "/goal resume queues the continuation");
});

test("the resume hotkey resumes any paused goal", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { commands, handlers, messages, ctx, entries, shortcuts } = createContinuationHarness();
  await handlers.get("session_start")?.({}, ctx);
  await commands.get("goal")?.handler("keep watching", ctx);
  await commands.get("goal")?.handler("pause", ctx);
  messages.length = 0;

  const hotkey = shortcuts.get("alt+g");
  assert.ok(hotkey, "alt+g is registered");
  await hotkey.handler(ctx);
  assert.equal(latestGoal(entries)?.status, "active");
  assert.equal(messages.length, 1);
});

test("the status line shows a paused goal and how to resume it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { commands, handlers, ctx, statuses } = createContinuationHarness(undefined, { hasUI: true });
  await handlers.get("session_start")?.({}, ctx);
  await commands.get("goal")?.handler("keep watching", ctx);
  await handlers.get("agent_start")?.({}, ctx);
  await handlers.get("agent_end")?.(abortedOutcome, ctx);
  await handlers.get("agent_settled")?.({}, ctx);
  assert.equal(statuses.at(-1), 'goal paused · say "go" or /goal resume');

  await commands.get("goal")?.handler("resume", ctx);
  await commands.get("goal")?.handler("pause", ctx);
  await handlers.get("agent_settled")?.({}, ctx);
  assert.equal(statuses.at(-1), "goal paused · /goal resume", "an explicit pause names only /goal resume");

  await commands.get("goal")?.handler("resume", ctx);
  await handlers.get("agent_settled")?.({}, ctx);
  assert.equal(statuses.at(-1), undefined, "a running goal clears the paused status");
});

test("an escape-paused goal tells the agent to converse and when it may resume", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { commands, handlers, ctx } = createContinuationHarness();
  await handlers.get("session_start")?.({}, ctx);
  await commands.get("goal")?.handler("keep watching", ctx);
  await handlers.get("agent_end")?.(abortedOutcome, ctx);

  const update = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx) as { systemPrompt?: string };
  assert.match(update.systemPrompt ?? "", /paused because the user pressed escape/);
  assert.match(update.systemPrompt ?? "", /do not continue the goal's work/);
  assert.match(update.systemPrompt ?? "", /Call goal_resume only when the user's latest message clearly says to proceed/);
  assert.match(update.systemPrompt ?? "", /Never call it for questions/);

  await commands.get("goal")?.handler("resume", ctx);
  await commands.get("goal")?.handler("pause", ctx);
  const sticky = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx);
  assert.equal(sticky, undefined, "a /goal pause adds no goal_resume guidance");
});

test("an explicit /goal pause is not undone by later user messages", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { commands, handlers, messages, ctx, entries } = createContinuationHarness();

  await handlers.get("session_start")?.({}, ctx);
  await commands.get("goal")?.handler("keep watching", ctx);
  await commands.get("goal")?.handler("pause", ctx);
  messages.length = 0;
  assert.equal(latestGoal(entries)?.status, "paused");
  assert.equal(latestGoal(entries)?.pauseReason, undefined, "an explicit pause is sticky");

  await handlers.get("input")?.({ source: "interactive", text: "quick question" }, ctx);
  assert.equal(latestGoal(entries)?.status, "paused");
  await handlers.get("agent_start")?.({}, ctx);
  await handlers.get("agent_end")?.(answeredOutcome, ctx);
  await handlers.get("agent_settled")?.({}, ctx);
  t.mock.timers.tick(60_000);
  await flushPromises();
  assert.equal(messages.length, 0, "an explicitly paused goal is never poked");

  await handlers.get("agent_end")?.(abortedOutcome, ctx);
  await handlers.get("input")?.({ source: "interactive", text: "and another" }, ctx);
  assert.equal(latestGoal(entries)?.status, "paused", "an interrupt does not soften an explicit pause");

  await commands.get("goal")?.handler("resume", ctx);
  assert.equal(latestGoal(entries)?.status, "active");
});

test("extension-originated input does not resume an interrupted goal", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { commands, handlers, ctx, entries } = createContinuationHarness();

  await handlers.get("session_start")?.({}, ctx);
  await commands.get("goal")?.handler("keep watching", ctx);
  await handlers.get("agent_end")?.(abortedOutcome, ctx);

  await handlers.get("input")?.({ source: "extension", text: "automated nudge" }, ctx);
  assert.equal(latestGoal(entries)?.status, "paused");
});

test("a completed goal stays complete after user messages and interrupts", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { commands, handlers, messages, ctx, entries } = createContinuationHarness();

  await handlers.get("session_start")?.({}, ctx);
  await commands.get("goal")?.handler("keep watching", ctx);
  await commands.get("goal")?.handler("complete", ctx);
  messages.length = 0;

  await handlers.get("agent_end")?.(abortedOutcome, ctx);
  await handlers.get("input")?.({ source: "interactive", text: "thanks" }, ctx);
  await handlers.get("agent_settled")?.({}, ctx);
  t.mock.timers.tick(60_000);
  await flushPromises();
  assert.equal(latestGoal(entries)?.status, "complete");
  assert.equal(messages.length, 0);
});

test("non-conversational commands leave an active goal and its continuation untouched", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { commands, handlers, messages, ctx, entries } = createContinuationHarness();

  await handlers.get("session_start")?.({}, ctx);
  await commands.get("goal")?.handler("keep watching", ctx);
  await handlers.get("agent_start")?.({}, ctx);
  await handlers.get("agent_end")?.(answeredOutcome, ctx);
  await handlers.get("agent_settled")?.({}, ctx);
  messages.length = 0;

  // Pi runs its built-ins (/settings, /model, /session) without an input event
  // or agent turn; extension commands likewise bypass input handlers.
  await commands.get("better-activity")?.handler("", ctx);
  await commands.get("workflow")?.handler("", ctx);
  await commands.get("goal")?.handler("", ctx);
  assert.equal(latestGoal(entries)?.status, "active");

  t.mock.timers.tick(60_000);
  await flushPromises();
  assert.equal(messages.length, 1, "the scheduled continuation still fires");
});

test("background work that finishes during a pending question is harvested right after the answer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { commands, handlers, messages, sendOptions, ctx, events } = createContinuationHarness();
  let workerStatus = "running";
  events.emit("pi-better-goal:register-provider", {
    id: "fixture",
    getActivity: () => ({
      providerId: "fixture",
      items: [
        { id: "sa_1", label: "developer", status: workerStatus, active: workerStatus === "running" },
        { id: "sa_2", label: "reviewer", status: "running", active: true },
      ],
    }),
  });

  await handlers.get("session_start")?.({}, ctx);
  await commands.get("goal")?.handler("keep watching", ctx);
  await handlers.get("agent_start")?.({}, ctx);
  messages.length = 0;
  sendOptions.length = 0;

  await handlers.get("tool_execution_start")?.({ toolCallId: "q1", toolName: "ask_user_question", args: {} }, ctx);
  workerStatus = "completed";
  await handlers.get("tool_execution_end")?.({ toolCallId: "q1", toolName: "ask_user_question", result: {}, isError: false }, ctx);

  assert.equal(messages.length, 1, "one harvest message follows the answer");
  const harvest = messages[0] as { content: string; details: { kind: string; finished: Array<{ id: string }> } };
  assert.equal(harvest.details.kind, "question-harvest");
  assert.deepEqual(harvest.details.finished.map((item) => item.id), ["sa_1"], "only work that finished during the question is listed");
  assert.match(harvest.content, /developer \(sa_1\): completed/);
  assert.equal((sendOptions[0] as { deliverAs?: string }).deliverAs, "steer", "steering drains right after the tool batch, not after the run");
});

test("a question with no background completions, or a non-question tool, adds nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { commands, handlers, messages, ctx, events } = createContinuationHarness();
  let status = "running";
  events.emit("pi-better-goal:register-provider", {
    id: "fixture",
    getActivity: () => ({ providerId: "fixture", items: [{ id: "sa_1", status, active: status === "running" }] }),
  });

  await handlers.get("session_start")?.({}, ctx);
  await commands.get("goal")?.handler("keep watching", ctx);
  await handlers.get("agent_start")?.({}, ctx);
  messages.length = 0;

  await handlers.get("tool_execution_start")?.({ toolCallId: "q1", toolName: "ask_user_question", args: {} }, ctx);
  await handlers.get("tool_execution_end")?.({ toolCallId: "q1", toolName: "ask_user_question", result: {}, isError: false }, ctx);
  assert.equal(messages.length, 0, "nothing finished while the question was pending");

  await handlers.get("tool_execution_start")?.({ toolCallId: "b1", toolName: "bash", args: {} }, ctx);
  status = "completed";
  await handlers.get("tool_execution_end")?.({ toolCallId: "b1", toolName: "bash", result: {}, isError: false }, ctx);
  assert.equal(messages.length, 0, "ordinary tools are left to the normal callback batch");
});

test("running background work warns the agent that a blocking question holds completions", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { commands, handlers, ctx, events } = createContinuationHarness();
  events.emit("pi-better-goal:register-provider", {
    id: "fixture",
    getActivity: () => ({ providerId: "fixture", items: [{ id: "sa_1", status: "running", active: true }] }),
  });
  await handlers.get("session_start")?.({}, ctx);
  await commands.get("goal")?.handler("keep watching", ctx);

  const update = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx) as { systemPrompt?: string };
  assert.match(update.systemPrompt ?? "", /ask_user_question\) holds this whole turn/);
  assert.match(update.systemPrompt ?? "", /Harvest finished background results before asking/);
});

const abortedOutcome = { messages: [{ role: "assistant", content: [], stopReason: "aborted" }] };
const answeredOutcome = { messages: [{ role: "assistant", content: [{ type: "text", text: "Here is the answer." }], stopReason: "stop" }] };
const networkFailureOutcome = { messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "fetch failed" }] };

test("TUI goal settings opens the interactive page and its toggles persist", async (t) => {
  isolatePreferences(t);
  const h = createContinuationHarness();
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    inverse: (text: string) => text,
  };
  let opened = false;
  let closed = false;
  Object.assign(h.ctx, { mode: "tui", hasUI: true });
  Object.assign(h.ctx.ui, {
    async custom(factory: Function) {
      opened = true;
      const page = factory({ requestRender() {} }, theme, {}, () => { closed = true; });
      assert.match(page.render(80).join("\n"), /Goal settings/);
      page.handleInput(" ");
      await new Promise<void>((resolve) => setImmediate(resolve));
      page.handleInput("\x1b[B");
      page.handleInput("\r");
      await new Promise<void>((resolve) => setImmediate(resolve));
      page.handleInput("\x1b[B");
      page.handleInput(" ");
      await new Promise<void>((resolve) => setImmediate(resolve));
      page.handleInput("\x1b");
    },
  });
  await h.commands.get("goal")?.handler("settings", h.ctx);
  assert.equal(opened, true);
  assert.equal(closed, true);
  const next = createContinuationHarness();
  await next.handlers.get("session_start")?.({}, next.ctx);
  const inspected = await next.tools.get("get_goal")!.execute("inspect", {}, undefined, undefined, toolContext(next.ctx));
  assert.deepEqual((inspected.details as { preferences: unknown }).preferences, { autoContinue: false, conversationalResume: false, pauseOnEscape: false });
  assert.equal(h.entries.length, 0);
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
  await next.handlers.get("session_shutdown")?.({}, next.ctx);
});

test("all settings persist across extension recreation without disabling kickoff or explicit resumes", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  isolatePreferences(t);
  const first = createContinuationHarness();
  await first.handlers.get("session_start")?.({}, first.ctx);
  await first.commands.get("goal")?.handler("settings auto-continue off", first.ctx);
  await first.commands.get("goal")?.handler("settings conversational-resume off", first.ctx);
  await first.commands.get("goal")?.handler("settings pause-on-escape off", first.ctx);
  assert.equal(first.entries.length, 0, "configuring controls does not create a goal");
  await first.handlers.get("session_shutdown")?.({}, first.ctx);

  const h = createContinuationHarness();
  await h.handlers.get("session_start")?.({}, h.ctx);
  const inspected = await h.tools.get("get_goal")!.execute("settings", {}, undefined, undefined, toolContext(h.ctx));
  assert.deepEqual((inspected.details as { preferences: unknown }).preferences, { autoContinue: false, conversationalResume: false, pauseOnEscape: false });
  await h.commands.get("goal")?.handler("settings", h.ctx);
  assert.match(h.notifications.at(-1)?.message ?? "", /Automatic continuation setting: off/);
  assert.match(h.notifications.at(-1)?.message ?? "", /Conversational resume setting: off/);
  assert.match(h.notifications.at(-1)?.message ?? "", /Pause on Esc setting: off/);
  await h.commands.get("goal")?.handler("keep watching", h.ctx);
  assert.equal(h.messages.length, 1, "goal kickoff remains explicit intent");
  const original = latestGoal(h.entries)?.goalId;
  await h.handlers.get("agent_start")?.({}, h.ctx);
  await h.handlers.get("agent_end")?.(abortedOutcome, h.ctx);
  await h.handlers.get("agent_settled")?.({}, h.ctx);
  assert.equal(h.activeTools().includes("goal_resume"), false);
  await h.commands.get("goal")?.handler("resume", h.ctx);
  assert.equal(h.messages.length, 2, "explicit command queues a turn even with both settings off");
  await h.commands.get("goal")?.handler("pause", h.ctx);
  await h.shortcuts.get("alt+g")!.handler(h.ctx);
  assert.equal(h.messages.length, 3, "explicit hotkey queues a turn even with both settings off");
  assert.equal(latestGoal(h.entries)?.goalId, original);
  assert.equal(latestGoal(h.entries)?.status, "active");
  await settleNetworkFailure(h);
  t.mock.timers.tick(120_000);
  await flushPromises();
  assert.equal(h.messages.length, 3, "explicit resume does not re-enable automatic idle continuation");
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
});

test("automatic continuation off cancels pending idle and drain wakes but preserves drain observation", async (t) => {
  for (const kind of ["idle", "drain"] as const) {
    await t.test(kind, async (subtest) => {
      subtest.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
      isolatePreferences(subtest);
      const h = createContinuationHarness();
      let active = false;
      h.events.emit("pi-better-goal:register-provider", { id: "fixture", getActivity: () => fixtureActivity(active) });
      await h.handlers.get("session_start")?.({}, h.ctx);
      await h.commands.get("goal")?.handler("watch recurring work", h.ctx);
      await settleNetworkFailure(h);
      await settleNetworkFailure(h);
      assert.equal(latestContinuationState(h.entries)?.noProgressRetries, 1);
      if (kind === "drain") {
        active = true;
        await h.commands.get("better-activity")?.handler("", h.ctx);
        active = false;
        await h.commands.get("better-activity")?.handler("", h.ctx);
        assert.equal(latestContinuationState(h.entries)?.noProgressRetries, 0);
      }
      const before = h.messages.length;
      await h.commands.get("goal")?.handler("settings auto-continue off", h.ctx);
      subtest.mock.timers.tick(120_000);
      await flushPromises();
      assert.equal(h.messages.length, before, "already scheduled wakes are cancelled");
      assert.equal(latestGoal(h.entries)?.status, "active", "disabling automation does not pause or complete the goal");

      await settleNetworkFailure(h);
      await settleNetworkFailure(h);
      active = true;
      await h.commands.get("better-activity")?.handler("", h.ctx);
      active = false;
      await h.commands.get("better-activity")?.handler("", h.ctx);
      assert.equal(latestContinuationState(h.entries)?.noProgressRetries, 0, "disabled wakes still observe background progress");
      subtest.mock.timers.tick(120_000);
      await flushPromises();
      assert.equal(h.messages.length, before, "new drains cannot wake while the control is off");

      await h.handlers.get("agent_end")?.(abortedOutcome, h.ctx);
      assert.ok(h.activeTools().includes("goal_resume"), "automatic continuation does not control conversational resume");
      const resumed = await h.tools.get("goal_resume")!.execute("resume", {}, undefined, undefined, toolContext(h.ctx));
      assert.equal((resumed.details as { ok: boolean }).ok, true);
      assert.equal(h.messages.length, before + 1);
      await h.handlers.get("session_shutdown")?.({}, h.ctx);
    });
  }
});

test("conversational resume off withdraws and refuses the tool while retaining paused conversation guidance", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  isolatePreferences(t);
  const h = createContinuationHarness(undefined, { hasUI: true });
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("keep watching", h.ctx);
  await h.handlers.get("agent_end")?.(abortedOutcome, h.ctx);
  const otherTools = h.activeTools().filter((name) => name !== "goal_resume");
  assert.ok(h.activeTools().includes("goal_resume"));
  await h.commands.get("goal")?.handler("settings conversational-resume off", h.ctx);
  assert.deepEqual(h.activeTools(), otherTools, "the control changes only the resume tool");
  assert.equal(h.statuses.at(-1), "goal paused · /goal resume");
  const before = h.messages.length;
  await h.handlers.get("input")?.({ source: "interactive", text: "go" }, h.ctx);
  const refused = await h.tools.get("goal_resume")!.execute("stale-call", { reason: "user said go" }, undefined, undefined, toolContext(h.ctx));
  assert.equal((refused.details as { ok: boolean }).ok, false, "stale or direct tool calls cannot bypass the control");
  assert.equal(latestGoal(h.entries)?.status, "paused");
  assert.equal(h.messages.length, before);
  const prompt = await h.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, h.ctx) as { systemPrompt: string };
  assert.match(prompt.systemPrompt, /do not continue the goal's work until it is resumed/);
  assert.doesNotMatch(prompt.systemPrompt, /goal_resume/, "the model is not invited to call a disabled tool");
  await h.commands.get("goal")?.handler("settings conversational-resume on", h.ctx);
  assert.ok(h.activeTools().includes("goal_resume"));
  assert.equal(h.messages.length, before, "enabling the control itself does not resume the goal");
  await h.commands.get("goal")?.handler("resume", h.ctx);
  await h.commands.get("goal")?.handler("settings conversational-resume off", h.ctx);
  await settleNetworkFailure(h);
  const afterExplicit = h.messages.length;
  t.mock.timers.tick(60_000);
  await flushPromises();
  assert.equal(h.messages.length, afterExplicit + 1, "conversational resume does not disable automatic continuation");
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
});

test("re-enabling automatic continuation waits the grace period and conversational settings do not cancel it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  isolatePreferences(t);
  const h = createContinuationHarness();
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("settings auto-continue off", h.ctx);
  await h.commands.get("goal")?.handler("keep watching", h.ctx);
  await settleNetworkFailure(h);
  const before = h.messages.length;
  await h.commands.get("goal")?.handler("settings auto-continue on", h.ctx);
  t.mock.timers.tick(30_000);
  await flushPromises();
  await h.commands.get("goal")?.handler("settings conversational-resume off", h.ctx);
  await h.commands.get("goal")?.handler("settings", h.ctx);
  await h.commands.get("goal")?.handler("", h.ctx);
  t.mock.timers.tick(29_999);
  await flushPromises();
  assert.equal(h.messages.length, before);
  t.mock.timers.tick(1);
  await flushPromises();
  assert.equal(h.messages.length, before + 1, "unrelated setting changes and inspection leave the wake deadline alone");
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
});

test("invalid settings commands cannot replace the goal or modify preferences", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  isolatePreferences(t);
  const h = createContinuationHarness();
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("keep watching", h.ctx);
  const before = h.entries.length;
  for (const args of ["settings unknown off", "settings auto-continue", "settings auto-continue false", "settings conversational-resume on extra"]) {
    await h.commands.get("goal")?.handler(args, h.ctx);
  }
  assert.equal(h.entries.length, before);
  const inspected = await h.tools.get("get_goal")!.execute("inspect", {}, undefined, undefined, toolContext(h.ctx));
  assert.deepEqual((inspected.details as { preferences: unknown }).preferences, { autoContinue: true, conversationalResume: true, pauseOnEscape: true });
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
});

test("preference save failures report an error without changing runtime settings or the goal", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  isolatePreferences(t);
  const h = createContinuationHarness(undefined, { hasUI: true });
  await h.handlers.get("session_start")?.({}, h.ctx);
  await h.commands.get("goal")?.handler("settings conversational-resume off", h.ctx);
  await h.commands.get("goal")?.handler("keep watching", h.ctx);
  await h.handlers.get("agent_end")?.(abortedOutcome, h.ctx);
  const before = h.entries.length;
  writeFileSync(goalPreferencesPath(), "{not valid JSON");
  await h.commands.get("goal")?.handler("settings conversational-resume on", h.ctx);
  assert.equal(h.notifications.at(-1)?.type, "error");
  assert.match(h.notifications.at(-1)?.message ?? "", /not valid JSON/);
  assert.equal(h.entries.length, before);
  assert.equal(h.activeTools().includes("goal_resume"), false);
  const inspected = await h.tools.get("get_goal")!.execute("inspect", {}, undefined, undefined, toolContext(h.ctx));
  assert.equal((inspected.details as { preferences: { conversationalResume: boolean } }).preferences.conversationalResume, false);
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
});

function isolatePreferences(t: TestContext): void {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const root = mkdtempSync(join(tmpdir(), "pi-goal-preferences-"));
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
}

async function settleNetworkFailure(h: ReturnType<typeof createContinuationHarness>): Promise<void> {
  await h.handlers.get("agent_start")?.({}, h.ctx);
  await h.handlers.get("agent_end")?.(networkFailureOutcome, h.ctx);
  await h.handlers.get("agent_settled")?.({}, h.ctx);
}

async function settlePermissionFailure(h: ReturnType<typeof createContinuationHarness>, assistantText: string, structured = true): Promise<void> {
  // These are message fixtures, not executed tools: no real credentials or
  // process inventory are read. Both failures are identical on every turn.
  const outcome = {
    messages: [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "fixture-cache", name: "read", arguments: { path: "/__goal_issue_415_fixture__/credentials/cache.json" } },
          { type: "toolCall", id: "fixture-process", name: "bash", arguments: { command: "fixture-process-inspection --pid 4242" } },
        ],
      },
      {
        role: "toolResult", toolCallId: "fixture-cache", toolName: "read", isError: true,
        content: [{ type: "text", text: "EPERM: operation not permitted, open '/__goal_issue_415_fixture__/credentials/cache.json'" }],
      },
      {
        role: "toolResult", toolCallId: "fixture-process", toolName: "bash", isError: true,
        content: [{ type: "text", text: "Process inspection denied: operation not permitted (EPERM)." }],
      },
      { role: "assistant", content: [{ type: "text", text: assistantText }], stopReason: "stop" },
    ],
  };
  await h.handlers.get("agent_start")?.({}, h.ctx);
  if (structured) await h.handlers.get("tool_result")?.({
    toolName: "subagent_result", toolCallId: "fixture-result", input: { id: "worker-one" }, isError: false,
    content: [{ type: "text", text: assistantText }], details: { permissionBlockers: fixtureBlockers() },
  }, h.ctx);
  await h.handlers.get("agent_end")?.(outcome, h.ctx);
  await h.handlers.get("agent_settled")?.({}, h.ctx);
}

async function exhaustNoProgressRetries(h: ReturnType<typeof createContinuationHarness>, t: TestContext): Promise<void> {
  for (let attempt = 0; attempt <= 10; attempt += 1) {
    await settleNetworkFailure(h);
    if (attempt < 10) {
      t.mock.timers.tick(60_000 * (attempt + 1));
      await flushPromises();
    }
  }
}

function createContinuationHarness(signal?: AbortSignal, options: { hasUI?: boolean; mode?: ExtensionContext["mode"]; factory?: typeof extension; producerPath?: string; registeredTools?: ReturnType<ExtensionAPI["getAllTools"]> } = {}) {
  const entries: SessionEntry[] = [];
  const tools = new Map<string, ToolDefinition>();
  let active: string[] = [];
  const statuses: Array<string | undefined> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const commands = new Map<string, CommandDefinition>();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const messages: unknown[] = [];
  const sendOptions: unknown[] = [];
  const events = new EventEmitter();
  const shortcuts = new Map<string, { handler(ctx: ExtensionContext): Promise<void> | void }>();
  let idle = true;
  let aborts = 0;
  const terminalListeners = new Set<Parameters<ExtensionContext["ui"]["onTerminalInput"]>[0]>();
  let autocomplete = false;
  let overlay = false;
  const editor = { render: () => [], invalidate() {}, onEscape() {}, isShowingAutocomplete: () => autocomplete };
  let terminalFocus: unknown = editor;

  const ctx = {
    hasUI: options.hasUI ?? false,
    mode: options.mode,
    isIdle: () => idle,
    signal,
    abort: () => {
      aborts += 1;
    },
    sessionManager: { getBranch: () => entries },
    ui: {
      confirm: async () => true,
      notify: (message: string, type?: string) => notifications.push({ message, ...(type ? { type } : {}) }),
      setStatus: (_key: string, value: string | undefined) => {
        statuses.push(value);
      },
      setWidget(_key: string, factory: unknown) {
        if (options.mode === "tui" && typeof factory === "function") {
          factory({ requestRender() {}, getFocusedComponent: () => terminalFocus, hasOverlay: () => overlay }, { fg: (_color: string, text: string) => text });
        }
      },
      onTerminalInput(handler: Parameters<ExtensionContext["ui"]["onTerminalInput"]>[0]) {
        terminalListeners.add(handler);
        return () => { terminalListeners.delete(handler); };
      },
    },
  } as unknown as ExtensionContext;

  const pi = {
    events,
    getAllTools: () => options.registeredTools ?? ["subagent_result", "subagent_output"].map((name) => ({
      name, sourceInfo: { path: options.producerPath ?? fileURLToPath(new URL("../../pi-better-subagents/index.ts", import.meta.url)) },
    })),
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) {
      active = [...names];
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage(message: unknown, options?: unknown) {
      messages.push(message);
      sendOptions.push(options);
    },
    registerCommand(name: string, command: CommandDefinition) {
      commands.set(name, command);
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
      // Pi activates newly registered tools by default.
      active.push(tool.name);
    },
    registerShortcut(name: string, shortcut: { handler(ctx: ExtensionContext): Promise<void> | void }) {
      shortcuts.set(name, shortcut);
    },
    on(event: string, handler: (event: unknown, context: ExtensionContext) => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;

  (options.factory ?? extension)(pi);
  return {
    commands,
    handlers,
    messages,
    sendOptions,
    ctx,
    entries,
    events,
    shortcuts,
    tools,
    statuses,
    notifications,
    terminalListeners,
    terminalInput: (data: string) => [...terminalListeners].map((handler) => handler(data)),
    setAutocomplete: (value: boolean) => { autocomplete = value; },
    setOverlay: (value: boolean) => { overlay = value; },
    setTerminalFocus: (value: unknown) => { terminalFocus = value; },
    restoreEditorFocus: () => { terminalFocus = editor; },
    activeTools: () => [...active],
    setBusy: (busy: boolean) => {
      idle = !busy;
    },
    getAborts: () => aborts,
  };
}

function fixtureBlockers(runId = "worker-one", policySnapshotId = "policy-one") {
  return ["credential-files", "process-inspection"].map((resource) => ({
    version: 1, kind: "permission-blocker", context: "worker", resource, basis: "os-permission-error",
    operation: resource === "credential-files" ? "fixture-cache-read" : "fixture-process-inspect",
    remoteOutcome: "unknown", incidentId: `fixture-${resource}`, runId, policySnapshotId,
  }));
}

async function reportPermissionBlockers(h: ReturnType<typeof createContinuationHarness>, permissionBlockers: unknown, toolName = "subagent_result") {
  await h.handlers.get("tool_result")?.({ toolName, toolCallId: "fixture-result", input: { id: "worker-one" }, isError: false,
    content: [{ type: "text", text: "EPERM: fixture access is denied." }], details: { permissionBlockers } }, h.ctx);
}

async function inspectPermissionHold(h: ReturnType<typeof createContinuationHarness>): Promise<PermissionHold> {
  const result = await h.tools.get("get_goal")!.execute("inspect", {}, undefined, undefined, toolContext(h.ctx));
  return (result.details as { permissionHold: PermissionHold }).permissionHold;
}

function permissionRecords(h: ReturnType<typeof createContinuationHarness>) {
  return h.entries.filter((entry) => entry.type === "custom" && entry.customType === "pi-better-goal")
    .map((entry) => entry.data as { kind: string; blocker?: unknown })
    .filter((data) => data.kind.startsWith("permission-"));
}

function latestGoal(entries: SessionEntry[]) {
  let goal: { goalId?: string; status?: string; objective?: string; pauseReason?: string } | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "pi-better-goal" || !entry.data || typeof entry.data !== "object") {
      continue;
    }
    const data = entry.data as { kind?: unknown; goal?: unknown };
    if (data.kind === "set" && data.goal && typeof data.goal === "object") {
      goal = data.goal as { goalId?: string; status?: string; objective?: string; pauseReason?: string };
    }
  }
  return goal;
}

function latestContinuationState(entries: SessionEntry[]) {
  let state: { blocked?: boolean; noProgressRetries?: number; lastEvidenceSignature?: string | null } | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "pi-better-goal" || !entry.data || typeof entry.data !== "object") {
      continue;
    }
    const data = entry.data as { kind?: unknown; state?: unknown };
    if (data.kind === "continuation-state" && data.state && typeof data.state === "object") {
      state = data.state as { blocked?: boolean; noProgressRetries?: number; lastEvidenceSignature?: string | null };
    }
  }
  return state;
}

function fixtureActivity(active: boolean) {
  return { providerId: "fixture", items: active ? [{ id: "work", status: "running", active: true }] : [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
