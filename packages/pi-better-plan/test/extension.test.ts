import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import extension, { planArgumentCompletions } from "../src/index.js";
import { planSetEntry, replacePlan } from "../src/plan-state.js";

interface SessionEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

interface CommandDefinition {
  getArgumentCompletions?(prefix: string): AutocompleteItem[] | null;
  handler(args: string, ctx: ExtensionContext): Promise<void> | void;
}

test("plan action completions expose valid commands with context", () => {
  assert.deepEqual(planArgumentCompletions(""), [
    { value: "clear", label: "clear", description: "Remove the current plan" },
    { value: "hide", label: "hide", description: "Hide the plan widget" },
    { value: "show", label: "show", description: "Restore automatic plan display" },
    { value: "expand", label: "expand", description: "Show all steps in the plan widget" },
    { value: "collapse", label: "collapse", description: "Show up to five relevant steps" },
    { value: "pin auto", label: "pin auto", description: "Use automatic plan pinning" },
    { value: "pin on", label: "pin on", description: "Keep the plan pinned" },
    { value: "pin off", label: "pin off", description: "Keep the plan unpinned" },
  ]);
  assert.deepEqual(planArgumentCompletions(" pin ")?.map((entry) => entry.value), ["pin auto", "pin on", "pin off"]);
  assert.equal(planArgumentCompletions("unknown"), null);
});

test("the registered /plan command publishes its argument completions", () => {
  let command: CommandDefinition | undefined;
  const pi = {
    events: new EventEmitter(),
    appendEntry() {}, registerTool() {}, on() {},
    registerCommand(name: string, definition: CommandDefinition) { if (name === "plan") command = definition; },
  } as unknown as ExtensionAPI;
  extension(pi);
  assert.deepEqual(command?.getArgumentCompletions?.("pi")?.map((entry) => entry.value), [
    "pin auto", "pin on", "pin off",
  ]);
});

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
  assert.ok(updatePlan.promptGuidelines?.some((line) => line.includes("active delegation mode")));
  assert.ok(updatePlan.promptGuidelines?.some((line) => line.includes("separate steps for distinct deliverables")));
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

  const promptUpdate = await handlers.get("before_agent_start")?.({ systemPrompt: "base prompt" }, ctx) as { systemPrompt?: string };
  assert.match(promptUpdate.systemPrompt ?? "", /Adaptive delegation mode/);
  assert.match(promptUpdate.systemPrompt ?? "", /Mark distinct foreground and delegated milestones in_progress concurrently/);
  assert.match(promptUpdate.systemPrompt ?? "", /inspected, integrated/);
});

test("active delegation mode controls plan guidance without changing plan steps", async () => {
  const entries: SessionEntry[] = [];
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const events = new EventEmitter();
  let mode: string = "manual";
  events.on("pi-better-subagents:delegation-mode-request", (request: { mode?: string }) => { request.mode = mode; });
  const ctx = {
    mode: "print", hasUI: false,
    sessionManager: { getBranch: () => entries },
    ui: { setWidget() {}, setStatus() {} },
  } as unknown as ExtensionContext;
  const pi = {
    events,
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerCommand() {},
    on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); },
  } as unknown as ExtensionAPI;
  extension(pi);
  await handlers.get("session_start")?.({}, ctx);
  await tools.get("update_plan")!.execute("plan", { plan: [{ step: "Build", status: "in_progress" }] }, undefined, undefined, ctx);
  const prompt = async () => (await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx) as { systemPrompt: string }).systemPrompt;
  assert.match(await prompt(), /Manual delegation mode: a plan does not authorize proactive delegation/);
  assert.doesNotMatch(await prompt(), /Delegate a bounded task/);
  mode = "coordinator";
  assert.match(await prompt(), /consult agents_catalog and delegate nontrivial role-owned milestones/);
  mode = "invalid";
  assert.match(await prompt(), /Adaptive delegation mode/);
});

test("concurrent plan updates persist and invalid updates leave the plan unchanged", async () => {
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
  const concurrent = await updatePlan.execute("valid", { plan: [
    { step: "Foreground", status: "in_progress" },
    { step: "Delegated", status: "in_progress" },
  ] }, undefined, undefined, ctx);
  assert.equal((concurrent.details as any).progress.inProgress, 2);
  assert.match((concurrent.content[0] as { text: string }).text, /2 steps in progress/);
  const entryCount = entries.length;
  const expectedPlan = structuredClone((concurrent.details as any).plan);
  await assert.rejects(
    updatePlan.execute("invalid", { plan: [
      { step: "Same", status: "in_progress" },
      { step: " same ", status: "in_progress" },
    ] }, undefined, undefined, ctx),
    /duplicates an earlier step/,
  );
  assert.equal(entries.length, entryCount);
  const retained = await tools.get("get_plan")!.execute("retained", {}, undefined, undefined, ctx);
  assert.deepEqual((retained.details as any).plan, expectedPlan);
});

test("plan tool reports ready DAG steps and rejects premature transitions", async () => {
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
  const updatePlan = tools.get("update_plan")!;
  const getPlan = tools.get("get_plan")!;
  const steps = [
    { id: "api", step: "Build API", status: "in_progress" },
    { id: "worker", step: "Build worker", status: "pending" },
    { id: "join", step: "Integrate", status: "pending", dependsOn: ["api", "worker"] },
  ];
  const updated = await updatePlan.execute("dag", { plan: steps }, undefined, undefined, ctx);
  assert.deepEqual((updated.details as any).progress.readyIndices, [1]);
  const result = await getPlan.execute("get", {}, undefined, undefined, ctx);
  assert.match((result.content[0] as { text: string }).text, /Integrate \(after: api, worker\)/);
  assert.match((result.content[0] as { text: string }).text, /Ready: Build worker/);
  const prompt = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx) as { systemPrompt: string };
  assert.match(prompt.systemPrompt, /Ready pending steps: Build worker/);
  const count = entries.length;
  const expectedPlan = structuredClone((updated.details as any).plan);
  await assert.rejects(updatePlan.execute("early", { plan: steps.map((item) =>
    item.id === "join" ? { ...item, status: "in_progress" } : item,
  ) }, undefined, undefined, ctx), /dependency api is completed/);
  assert.equal(entries.length, count);
  const retained = await getPlan.execute("retained", {}, undefined, undefined, ctx);
  assert.deepEqual((retained.details as any).plan, expectedPlan);
});

test("skill-owned workflow suppresses the generic plan and its update tool", async () => {
  const entries: SessionEntry[] = [];
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const ctx = {
    mode: "print", hasUI: false,
    sessionManager: { getBranch: () => entries },
    ui: { setWidget() {}, setStatus() {} },
  } as unknown as ExtensionContext;
  const pi = {
    events: new EventEmitter(),
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerCommand() {},
    on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown) { handlers.set(event, handler); },
  } as unknown as ExtensionAPI;
  extension(pi);
  await handlers.get("session_start")?.({}, ctx);
  const update = tools.get("update_plan")!;
  await update.execute("ordinary", { plan: [{ step: "Generic", status: "in_progress" }] }, undefined, undefined, ctx);
  entries.push({ type: "custom", customType: "pi-better-workflow", data: {
    version: 1, kind: "set", owner: { name: "fixture", planOwner: "workflow" },
  } });
  assert.equal(await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx), undefined);
  await assert.rejects(update.execute("owned", { plan: [{ step: "Wrong plan", status: "in_progress" }] }, undefined, undefined, ctx), /owns the task plan/);
  const owned = await tools.get("get_plan")!.execute("get", {}, undefined, undefined, ctx);
  assert.match((owned.content[0] as { text: string }).text, /fixture owns the task plan/);
  entries.push({ type: "custom", customType: "pi-better-workflow", data: { version: 1, kind: "clear" } });
  const restored = await tools.get("get_plan")!.execute("get", {}, undefined, undefined, ctx);
  assert.match((restored.content[0] as { text: string }).text, /Generic/);
});

test("released handoff suppresses stale generic guidance until a generic replacement is saved", async () => {
  const generic = replacePlan(null, [{ step: "Stale generic", status: "in_progress" }], undefined, 100);
  const entries: SessionEntry[] = [
    { type: "custom", customType: "pi-better-plan", data: planSetEntry(generic) },
    { type: "custom", customType: "pi-better-workflow", data: {
      version: 1, kind: "set", owner: { name: "fixture-workflow", planOwner: "workflow" },
    } },
    { type: "custom", customType: "pi-better-workflow-plan", data: {
      version: 1, kind: "set", owner: "fixture-workflow", path: "/missing/task-plan.json", runId: "missing",
    } },
    { type: "custom", customType: "pi-better-workflow", data: { version: 1, kind: "clear" } },
  ];
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const ctx = {
    cwd: "/missing", mode: "print", hasUI: false,
    sessionManager: { getBranch: () => entries },
    ui: { setWidget() {}, setStatus() {} },
  } as unknown as ExtensionContext;
  extension({
    events: new EventEmitter(),
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerCommand() {},
    on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown) { handlers.set(event, handler); },
  } as unknown as ExtensionAPI);
  await handlers.get("session_start")!({}, ctx);
  assert.equal(await handlers.get("before_agent_start")!({ systemPrompt: "base" }, ctx), undefined,
    "an unavailable handoff is not permission to resume the stale generic checklist");
  await tools.get("update_plan")!.execute("replace", {
    plan: [{ step: "New generic", status: "in_progress" }],
  }, undefined, undefined, ctx);
  const prompt = await handlers.get("before_agent_start")!({ systemPrompt: "base" }, ctx) as { systemPrompt: string };
  assert.match(prompt.systemPrompt, /New generic/);
  assert.doesNotMatch(prompt.systemPrompt, /Stale generic/);
  await handlers.get("session_tree")!({}, ctx);
  const restoredPrompt = await handlers.get("before_agent_start")!({ systemPrompt: "base" }, ctx) as { systemPrompt: string };
  assert.match(restoredPrompt.systemPrompt, /New generic/);
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