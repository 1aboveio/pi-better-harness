import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import extension, { goalArgumentCompletions, toolContext } from "./extension-fixture.js";

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
  ]);
  assert.deepEqual(
    goalArgumentCompletions("  c")?.map((entry) => entry.value),
    ["clear", "complete"],
  );
  assert.equal(goalArgumentCompletions("ship the release"), null);
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

test("identical autonomous outcomes pause continuation until interactive input resets the ledger", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
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

  await handlers.get("input")?.({ source: "interactive" }, ctx);
  const reset = latestContinuationState(entries);
  assert.equal(reset?.blocked, false);
  assert.equal(reset?.noProgressRetries, 0);

  await handlers.get("agent_start")?.({}, ctx);
  await handlers.get("agent_end")?.(identicalOutcome, ctx);
  await handlers.get("agent_settled")?.({}, ctx);
  t.mock.timers.tick(60_000);
  await flushPromises();
  assert.equal(messages.length, 12, "interactive input reopens the loop at the base delay");
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

test("background drain resets a held ledger before a callback can cancel its wake", async (t) => {
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
  assert.equal(latestContinuationState(h.entries)?.blocked, true);

  active = true;
  await h.handlers.get("agent_start")?.({}, h.ctx);
  active = false;
  await h.handlers.get("tool_execution_start")?.({ toolName: "ask_user_question", toolCallId: "question" }, h.ctx);
  assert.equal(latestContinuationState(h.entries)?.blocked, false, "drain progress persists while foreground is busy");
  assert.equal(latestContinuationState(h.entries)?.noProgressRetries, 0);
  await h.handlers.get("agent_end")?.(networkFailureOutcome, h.ctx);
  await h.handlers.get("agent_settled")?.({}, h.ctx);
  t.mock.timers.tick(100);
  await flushPromises();
  await settleNetworkFailure(h);

  assert.equal(latestContinuationState(h.entries)?.blocked, false);
  assert.equal(latestContinuationState(h.entries)?.noProgressRetries, 1, "only the post-drain repetition counts");
  const before = h.messages.length;
  t.mock.timers.tick(119_999);
  await flushPromises();
  assert.equal(h.messages.length, before);
  t.mock.timers.tick(1);
  await flushPromises();
  assert.equal(h.messages.length, before + 1, "callback cancellation cannot leave the goal held");
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

test("wake-disabled observation resets a held ledger without automatic handoffs", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
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
    await h.commands.get("goal")?.handler("observe without waking", h.ctx);
    await settleNetworkFailure(h);
    await settleNetworkFailure(h);
    assert.equal(latestContinuationState(h.entries)?.blocked, true);
    active = true;
    await h.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, h.ctx);
    active = false;
    await h.handlers.get("agent_settled")?.({}, h.ctx);
    assert.equal(latestContinuationState(h.entries)?.blocked, false);
    assert.equal(latestContinuationState(h.entries)?.noProgressRetries, 0);
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

test("in-flight wake audits cannot survive pause, resume, replacement, completion, interactive input, foreground start, session replacement or shutdown", async (t) => {
  for (const cause of ["pause", "resume", "replace", "complete", "input", "foreground", "session", "shutdown"] as const) {
    await t.test(cause, async (subtest) => {
      subtest.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
      const h = createContinuationHarness();
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
      } else if (cause === "shutdown") {
        await h.handlers.get("session_shutdown")?.({}, h.ctx);
        Object.defineProperty(h.ctx, "isIdle", { value: () => { throw new Error("stale context read"); } });
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

async function settleNetworkFailure(h: ReturnType<typeof createContinuationHarness>): Promise<void> {
  await h.handlers.get("agent_start")?.({}, h.ctx);
  await h.handlers.get("agent_end")?.(networkFailureOutcome, h.ctx);
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

function createContinuationHarness(signal?: AbortSignal, options: { hasUI?: boolean; factory?: typeof extension } = {}) {
  const entries: SessionEntry[] = [];
  const tools = new Map<string, ToolDefinition>();
  let active: string[] = [];
  const statuses: Array<string | undefined> = [];
  const commands = new Map<string, CommandDefinition>();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const messages: unknown[] = [];
  const sendOptions: unknown[] = [];
  const events = new EventEmitter();
  const shortcuts = new Map<string, { handler(ctx: ExtensionContext): Promise<void> | void }>();
  let idle = true;
  let aborts = 0;

  const ctx = {
    hasUI: options.hasUI ?? false,
    isIdle: () => idle,
    signal,
    abort: () => {
      aborts += 1;
    },
    sessionManager: { getBranch: () => entries },
    ui: {
      confirm: async () => true,
      notify: () => undefined,
      setStatus: (_key: string, value: string | undefined) => {
        statuses.push(value);
      },
      setWidget: () => undefined,
    },
  } as unknown as ExtensionContext;

  const pi = {
    events,
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
    activeTools: () => [...active],
    setBusy: (busy: boolean) => {
      idle = !busy;
    },
    getAborts: () => aborts,
  };
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
