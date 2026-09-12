import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import extension from "../src/index.js";
import { planSetEntry, replacePlan } from "../src/plan-state.js";

interface SessionEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

interface CommandDefinition {
  handler(args: string, ctx: ExtensionContext): Promise<void> | void;
}

test("plan tools persist progress without taking over editor navigation", async () => {
  const entries: SessionEntry[] = [];
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, CommandDefinition>();
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const widgets = new Map<string, any>();
  const statuses = new Map<string, string | undefined>();
  const delegatedInput: string[] = [];
  const editorFactory = () => ({
    getText: () => "",
    handleInput: (data: string) => delegatedInput.push(data),
    render: () => [],
    invalidate: () => undefined,
  });
  let editorInstallations = 0;
  let customViews = 0;

  const ctx = {
    mode: "tui",
    hasUI: true,
    sessionManager: { getBranch: () => entries },
    ui: {
      notify: () => undefined,
      setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
      setWidget: (key: string, content: unknown, options?: unknown) => widgets.set(key, { content, options }),
      getEditorComponent: () => editorFactory,
      setEditorComponent: () => { editorInstallations += 1; },
      custom: async (_factory: unknown) => { customViews += 1; },
    },
  } as unknown as ExtensionContext;

  const pi = {
    events: new EventEmitter(),
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: CommandDefinition) { commands.set(name, command); },
    on(event: string, handler: (event: any, context: ExtensionContext) => unknown) { handlers.set(event, handler); },
  } as unknown as ExtensionAPI;

  extension(pi);
  await handlers.get("session_start")?.({ reason: "startup" }, ctx);
  const updatePlan = tools.get("update_plan");
  assert.ok(updatePlan);
  await updatePlan.execute("update", {
    explanation: "Start implementation",
    plan: [
      { step: "Inspect", status: "completed" },
      { step: "Implement", status: "in_progress" },
      { step: "Verify", status: "pending" },
    ],
  }, undefined, undefined, ctx);

  assert.equal(statuses.get("pi-better-plan-nav"), undefined);
  assert.equal(editorInstallations, 0, "the plan leaves the editor component unchanged");
  const widgetFactory = widgets.get("pi-better-plan")?.content;
  assert.equal(typeof widgetFactory, "function");
  const widget = widgetFactory({ requestRender: () => undefined }, { fg: (_color: string, value: string) => value });
  assert.ok(widget.render(80).every((line: string) => !line.startsWith("›")));

  const editor = editorFactory();
  editor.handleInput("\u001b[C");
  assert.deepEqual(delegatedInput, ["\u001b[C"], "right remains normal editor input on an empty editor");

  await commands.get("plan")?.handler("", ctx);
  assert.equal(customViews, 1, "/plan still opens the full plan view");

  const getPlan = tools.get("get_plan");
  assert.ok(getPlan);
  const result = await getPlan.execute("get", {}, undefined, undefined, ctx);
  assert.equal((result.details as any).progress.completed, 1);
  assert.equal((result.details as any).plan.steps[1].status, "in_progress");
});

test("invalid plan updates leave the durable plan unchanged", async () => {
  const entries: SessionEntry[] = [];
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const ctx = {
    mode: "print",
    hasUI: false,
    sessionManager: { getBranch: () => entries },
    ui: { setWidget: () => undefined, setStatus: () => undefined },
  } as unknown as ExtensionContext;
  const pi = {
    events: new EventEmitter(),
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerCommand: () => undefined,
    on(event: string, handler: (event: any, context: ExtensionContext) => unknown) { handlers.set(event, handler); },
  } as unknown as ExtensionAPI;

  extension(pi);
  await handlers.get("session_start")?.({ reason: "startup" }, ctx);
  const updatePlan = tools.get("update_plan");
  assert.ok(updatePlan);
  await updatePlan.execute("valid", { plan: [{ step: "Only", status: "in_progress" }] }, undefined, undefined, ctx);
  const entryCount = entries.length;
  await assert.rejects(
    updatePlan.execute("invalid", { plan: [
      { step: "One", status: "in_progress" },
      { step: "Two", status: "in_progress" },
    ] }, undefined, undefined, ctx),
    /at most one step/,
  );
  assert.equal(entries.length, entryCount);
});

test("a completed plan clears durably after 30 seconds and replacement cancels the deadline", async () => {
  const entries: SessionEntry[] = [];
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 1;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realDateNow = Date.now;

  globalThis.setTimeout = ((callback: () => void, delay: number) => {
    const id = nextTimer++;
    timers.set(id, { callback: () => {
      timers.delete(id);
      callback();
    }, delay });
    return { id, unref() {} } as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    timers.delete((timer as unknown as { id: number }).id);
  }) as typeof clearTimeout;
  Date.now = () => 1_000_000;

  try {
    const ctx = {
      mode: "print",
      hasUI: false,
      sessionManager: { getBranch: () => entries },
      ui: { setWidget: () => undefined, setStatus: () => undefined },
    } as unknown as ExtensionContext;
    const pi = {
      events: new EventEmitter(),
      appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
      registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
      registerCommand: () => undefined,
      on(event: string, handler: (event: any, context: ExtensionContext) => unknown) { handlers.set(event, handler); },
    } as unknown as ExtensionAPI;

    extension(pi);
    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    const updatePlan = tools.get("update_plan");
    const getPlan = tools.get("get_plan");
    assert.ok(updatePlan);
    assert.ok(getPlan);

    await updatePlan.execute("complete", {
      plan: [{ step: "Ship", status: "completed" }],
    }, undefined, undefined, ctx);
    assert.equal(timers.size, 1);
    const completionTimer = [...timers.values()][0]!;
    assert.equal(completionTimer.delay, 30_000);

    await updatePlan.execute("replace", {
      plan: [{ step: "Follow up", status: "in_progress" }],
    }, undefined, undefined, ctx);
    assert.equal(timers.size, 0, "an incomplete replacement cancels completion cleanup");
    completionTimer.callback();
    const activeResult = await getPlan.execute("get-active", {}, undefined, undefined, ctx);
    assert.equal((activeResult.details as any).hasPlan, true);

    await updatePlan.execute("complete-replacement", {
      plan: [{ step: "Follow up", status: "completed" }],
    }, undefined, undefined, ctx);
    const replacementTimer = [...timers.values()][0]!;
    replacementTimer.callback();

    const clearedResult = await getPlan.execute("get-cleared", {}, undefined, undefined, ctx);
    assert.equal((clearedResult.details as any).hasPlan, false);
    assert.equal((entries.at(-1)?.data as { kind?: string }).kind, "clear");

    const overduePlan = replacePlan(null, [{ step: "Restore", status: "completed" }], undefined, 900, 900_000);
    entries.push({ type: "custom", customType: "pi-better-plan", data: planSetEntry(overduePlan, 900) });
    await handlers.get("session_tree")?.({ reason: "navigate" }, ctx);
    assert.equal(timers.size, 1);
    const overdueTimer = [...timers.values()][0]!;
    assert.equal(overdueTimer.delay, 0, "an overdue restored plan clears on the next timer turn");
    overdueTimer.callback();
    const restoredResult = await getPlan.execute("get-restored", {}, undefined, undefined, ctx);
    assert.equal((restoredResult.details as any).hasPlan, false);

    await updatePlan.execute("complete-before-shutdown", {
      plan: [{ step: "Stop timer", status: "completed" }],
    }, undefined, undefined, ctx);
    assert.equal(timers.size, 1);
    await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
    assert.equal(timers.size, 0, "session shutdown cancels completion cleanup");
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    Date.now = realDateNow;
  }
});