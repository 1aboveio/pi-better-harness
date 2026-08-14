import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import extension from "../src/index.js";

interface SessionEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

interface CommandDefinition {
  handler(args: string, ctx: ExtensionContext): Promise<void> | void;
}

interface WidgetRecord {
  content: unknown;
  options?: { placement?: string };
}

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
  const factory = widget?.content as (
    tui: { requestRender(): void },
    theme: { fg(color: string, text: string): string },
  ) => { render(width: number): string[]; dispose?(): void };
  const component = factory(
    { requestRender: () => { renderRequests += 1; } },
    { fg: (_color, text) => text },
  );
  assert.deepEqual(component.render(80), []);
  t.mock.timers.tick(30_000);
  assert.equal(renderRequests, 0, "an absent goal must not drive periodic full-screen renders");

  const goalCommand = commands.get("goal");
  assert.ok(goalCommand);
  await goalCommand.handler("Ship slash-only goals", ctx);
  assert.equal(renderRequests, 1, "setting a goal requests one immediate render");

  const getGoal = tools.get("get_goal");
  assert.ok(getGoal);
  const result = await getGoal.execute("test", {}, undefined, undefined, ctx);
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

  await goalCommand.handler("clear", ctx);
  assert.equal(renderRequests, 3, "clearing a goal requests one immediate render");
  assert.deepEqual(component.render(80), []);
  t.mock.timers.tick(30_000);
  assert.equal(renderRequests, 3, "cleared goal remains timer-free");
  component.dispose?.();

  const shutdown = handlers.get("session_shutdown");
  assert.ok(shutdown);
  await shutdown({}, ctx);
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
  t.mock.timers.tick(30_000);
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

  t.mock.timers.tick(29_999);
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
  t.mock.timers.tick(30_000);
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

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await handlers.get("agent_start")?.({}, ctx);
    await handlers.get("agent_end")?.(identicalOutcome, ctx);
    await handlers.get("agent_settled")?.({}, ctx);
    t.mock.timers.tick(30_000);
    await flushPromises();
  }
  assert.equal(messages.length, 4, "the initial turn plus three no-progress retries are allowed");

  await handlers.get("agent_start")?.({}, ctx);
  await handlers.get("agent_end")?.(identicalOutcome, ctx);
  await handlers.get("agent_settled")?.({}, ctx);
  t.mock.timers.tick(30_000);
  await flushPromises();
  assert.equal(messages.length, 4, "the fourth identical outcome holds automatic continuation");

  const blocked = latestContinuationState(entries);
  assert.equal(blocked?.blocked, true);
  assert.equal(blocked?.noProgressRetries, 3);

  await handlers.get("input")?.({ source: "interactive" }, ctx);
  const reset = latestContinuationState(entries);
  assert.equal(reset?.blocked, false);
  assert.equal(reset?.noProgressRetries, 0);

  await handlers.get("agent_start")?.({}, ctx);
  await handlers.get("agent_end")?.(identicalOutcome, ctx);
  await handlers.get("agent_settled")?.({}, ctx);
  t.mock.timers.tick(30_000);
  await flushPromises();
  assert.equal(messages.length, 5, "interactive input reopens the autonomous loop");
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
  t.mock.timers.tick(30_000);
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

  t.mock.timers.tick(30_000);
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

test("an aborted run without an active goal creates no goal", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { handlers, ctx, entries } = createContinuationHarness();

  await handlers.get("session_start")?.({}, ctx);
  const abortedOutcome = { messages: [{ role: "assistant", content: [], stopReason: "aborted" }] };
  await handlers.get("agent_end")?.(abortedOutcome, ctx);

  assert.equal(latestGoal(entries), undefined, "an abort without a goal creates nothing");
});

function createContinuationHarness() {
  const entries: SessionEntry[] = [];
  const commands = new Map<string, CommandDefinition>();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const messages: unknown[] = [];
  const events = new EventEmitter();
  const shortcuts = new Map<string, { handler(ctx: ExtensionContext): Promise<void> | void }>();
  let idle = true;
  let aborts = 0;

  const ctx = {
    hasUI: false,
    isIdle: () => idle,
    abort: () => {
      aborts += 1;
    },
    sessionManager: { getBranch: () => entries },
    ui: {
      confirm: async () => true,
      notify: () => undefined,
      setStatus: () => undefined,
      setWidget: () => undefined,
    },
  } as unknown as ExtensionContext;

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
      // Not needed for these continuation regressions.
    },
    registerShortcut(name: string, shortcut: { handler(ctx: ExtensionContext): Promise<void> | void }) {
      shortcuts.set(name, shortcut);
    },
    on(event: string, handler: (event: unknown, context: ExtensionContext) => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;

  extension(pi);
  return {
    commands,
    handlers,
    messages,
    ctx,
    entries,
    events,
    shortcuts,
    setBusy: (busy: boolean) => {
      idle = !busy;
    },
    getAborts: () => aborts,
  };
}

function latestGoal(entries: SessionEntry[]) {
  let goal: { status?: string } | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "pi-better-goal" || !entry.data || typeof entry.data !== "object") {
      continue;
    }
    const data = entry.data as { kind?: unknown; goal?: unknown };
    if (data.kind === "set" && data.goal && typeof data.goal === "object") {
      goal = data.goal as { status?: string };
    }
  }
  return goal;
}

function latestContinuationState(entries: SessionEntry[]) {
  let state: { blocked?: boolean; noProgressRetries?: number } | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "pi-better-goal" || !entry.data || typeof entry.data !== "object") {
      continue;
    }
    const data = entry.data as { kind?: unknown; state?: unknown };
    if (data.kind === "continuation-state" && data.state && typeof data.state === "object") {
      state = data.state as { blocked?: boolean; noProgressRetries?: number };
    }
  }
  return state;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
