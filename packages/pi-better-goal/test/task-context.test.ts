import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import extension from "./extension-fixture.js";
import { continuationStateEntry, createContinuationState, createGoalSnapshot, goalSetEntry } from "../src/goal-state.js";
import { ACTIVE_GOAL_REFRESH_MS } from "../src/goal-clock.js";
import type { TaskContextRequest } from "../src/task-context.js";

interface SessionEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

interface CommandDefinition {
  handler(args: string, ctx: ExtensionContext): Promise<void> | void;
}

interface SkillCommand {
  name: string;
  source: "skill";
  sourceInfo: { path: string };
}

const abortedOutcome = { messages: [{ role: "assistant", content: [], stopReason: "aborted" }] };

interface GoalWidgetInstall {
  factory: (tui: unknown, theme: unknown) => { render(width: number): string[]; dispose?(): void };
  options?: { placement?: string };
}

function createTaskContextHarness(options: {
  providerEnabled?: boolean;
  /** Harness visual ownership: should its combined Todo header render this goal? */
  providerDisplay?: (request: TaskContextRequest) => boolean | undefined;
  hasUI?: boolean;
  /** Load order on the shared event bus; the Harness runtime subscribes first by default. */
  harnessFirst?: boolean;
  skills?: SkillCommand[];
} = {}) {
  const entries: SessionEntry[] = [];
  const commands = new Map<string, CommandDefinition>();
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const events = new EventEmitter();
  const requests: TaskContextRequest[] = [];
  const widgets = new Map<string, GoalWidgetInstall>();
  const renders: boolean[] = [];
  const tui = {
    requestRender(force = false) {
      renders.push(force);
    },
    hasOverlay: () => false,
    getFocusedComponent: () => null,
  };
  const messages: unknown[] = [];
  const userMessages: Array<{ content: string; options: unknown }> = [];
  const ctx = {
    hasUI: options.hasUI === true,
    isIdle: () => true,
    cwd: "/tmp/project",
    sessionManager: { getBranch: () => entries, getSessionId: () => "task-context-session" },
    ui: {
      notify() {},
      setStatus() {},
      setWidget(name: string, factory: unknown, widgetOptions?: { placement?: string }) {
        if (!factory) {
          widgets.delete(name);
          return;
        }
        widgets.set(name, {
          factory: factory as GoalWidgetInstall["factory"],
          ...(widgetOptions ? { options: widgetOptions } : {}),
        });
      },
    },
  } as unknown as ExtensionContext;

  const registerHarness = (): void => {
    events.on("pi-better-harness:task-context", (request: TaskContextRequest) => {
      if (options.providerEnabled !== undefined) request.enabled = options.providerEnabled;
      if (request.action === "inspect") {
        const display = options.providerDisplay?.(request);
        if (display !== undefined) request.display = display;
      }
      requests.push({ ...request });
    });
  };
  // Load order must not matter: the runtime either listens before Goal loads or
  // subscribes afterwards.
  if (options.harnessFirst !== false) registerHarness();

  const pi = {
    events,
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage(message: unknown) {
      messages.push(message);
    },
    sendUserMessage(content: string, sendOptions: unknown) {
      userMessages.push({ content, options: sendOptions });
    },
    getCommands: () => options.skills ?? [],
    getActiveTools: () => [],
    setActiveTools() {},
    registerCommand(name: string, command: CommandDefinition) {
      commands.set(name, command);
    },
    registerTool(_tool: ToolDefinition) {},
    registerShortcut() {},
    on(event: string, handler: (data: any, context: ExtensionContext) => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;

  extension(pi);
  if (options.harnessFirst === false) registerHarness();
  return {
    commands,
    handlers,
    events,
    requests,
    widgets,
    renders,
    tui,
    messages,
    userMessages,
    ctx,
    entries,
    async start() {
      await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    },
    async goal(args: string) {
      await commands.get("goal")!.handler(args, ctx);
    },
    async prompt(base = "base prompt") {
      return handlers.get("before_agent_start")?.({ systemPrompt: base }, ctx) as Promise<{ systemPrompt?: string } | undefined>;
    },
    async shutdown() {
      await handlers.get("session_shutdown")?.({}, ctx);
    },
  };
}

function latestRequest(harness: ReturnType<typeof createTaskContextHarness>): TaskContextRequest {
  const request = harness.requests.at(-1);
  assert.ok(request, "expected one task-context request");
  return request;
}

test("goal lifecycle dispatches start, pause, resume, complete, and clear with raw objectives only on start", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const harness = createTaskContextHarness();
  await harness.start();
  harness.requests.length = 0;

  await harness.goal("first objective");
  const started = latestRequest(harness);
  assert.equal(started.action, "start");
  assert.ok(started.goalId, "start carries the Goal-bound id");
  assert.equal(started.objective, "first objective");
  const firstGoalId = started.goalId;

  await harness.goal("pause");
  const paused = latestRequest(harness);
  assert.equal(paused.action, "pause");
  assert.equal(paused.goalId, firstGoalId);
  assert.equal(Object.hasOwn(paused, "objective"), false, "non-start actions carry no objective");

  await harness.goal("resume");
  const resumed = latestRequest(harness);
  assert.equal(resumed.action, "resume");
  assert.equal(resumed.goalId, firstGoalId);
  assert.equal(Object.hasOwn(resumed, "objective"), false);

  await harness.goal("complete");
  const completed = latestRequest(harness);
  assert.equal(completed.action, "complete");
  assert.equal(completed.goalId, firstGoalId);
  assert.equal(Object.hasOwn(completed, "objective"), false);

  await harness.goal("second objective");
  const replaced = latestRequest(harness);
  assert.equal(replaced.action, "start");
  assert.equal(replaced.objective, "second objective");
  assert.ok(replaced.goalId);
  assert.notEqual(replaced.goalId, firstGoalId, "a replacement goal has a distinct id");

  await harness.goal("clear");
  const cleared = latestRequest(harness);
  assert.equal(cleared.action, "pause", "clear pauses the bound outcome instead of deleting or completing it");
  assert.equal(cleared.goalId, replaced.goalId);
  assert.equal(Object.hasOwn(cleared, "objective"), false);

  await harness.shutdown();
});

test("standalone Goal keeps its objective prompts when no Harness runtime is present", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const harness = createTaskContextHarness();
  await harness.start();
  await harness.goal("watch the build");

  const active = await harness.prompt();
  assert.equal(harness.requests.at(-1)?.action, "inspect");
  assert.match(active?.systemPrompt ?? "", /Pi Better Goal active objective: watch the build/);
  assert.equal(harness.requests.at(-1)?.enabled, undefined, "no provider leaves enabled undefined");

  await harness.handlers.get("agent_end")?.(abortedOutcome, harness.ctx);
  const paused = await harness.prompt();
  assert.match(paused?.systemPrompt ?? "", /paused because the user pressed escape/);
  assert.match(paused?.systemPrompt ?? "", /Goal: watch the build/);
  assert.match(paused?.systemPrompt ?? "", /do not continue the goal's work/);
  assert.match(paused?.systemPrompt ?? "", /Call goal_resume only when/);

  await harness.shutdown();
});

test("Harness presence suppresses duplicate Goal outcome text while enabled or off and keeps paused constraints", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  for (const providerEnabled of [true, false]) {
    const harness = createTaskContextHarness({ providerEnabled });
    await harness.start();
    await harness.goal("watch the build");
    assert.equal(latestRequest(harness).objective, "watch the build", "start still seeds the raw trigger");

    const active = await harness.prompt();
    assert.doesNotMatch(active?.systemPrompt ?? "", /Pi Better Goal active objective/);
    assert.ok(!(active?.systemPrompt ?? "").includes("watch the build"), "the outcome text is not duplicated");
    assert.equal(harness.requests.at(-1)?.action, "inspect");
    assert.equal(harness.requests.at(-1)?.enabled, providerEnabled, "a present Harness reports its on/off state");

    await harness.handlers.get("agent_end")?.(abortedOutcome, harness.ctx);
    const paused = await harness.prompt();
    assert.doesNotMatch(paused?.systemPrompt ?? "", /Pi Better Goal active objective/);
    assert.ok(!(paused?.systemPrompt ?? "").includes("watch the build"), "the paused prompt omits the raw objective");
    assert.match(paused?.systemPrompt ?? "", /paused because the user pressed escape/);
    assert.match(paused?.systemPrompt ?? "", /do not continue the goal's work/);
    assert.match(paused?.systemPrompt ?? "", /Call goal_resume only when/);
    assert.match(paused?.systemPrompt ?? "", /Never call it for questions/);

    await harness.shutdown();
  }
});

test("Harness presence keeps background completion guidance without repeating the objective", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const harness = createTaskContextHarness({ providerEnabled: false });
  harness.events.emit("pi-better-goal:register-provider", {
    id: "fixture",
    getActivity: () => ({
      providerId: "fixture",
      items: [{ id: "worker-1", label: "review", status: "running", active: true }],
    }),
  });
  await harness.start();
  await harness.goal("ship the change");

  const update = await harness.prompt();
  assert.match(update?.systemPrompt ?? "", /delegated background work running/);
  assert.match(update?.systemPrompt ?? "", /inspected and integrated/);
  assert.ok(!(update?.systemPrompt ?? "").includes("ship the change"));
  assert.doesNotMatch(update?.systemPrompt ?? "", /Pi Better Goal active objective/);

  await harness.shutdown();
});

test("Harness presence keeps the no-progress hold without repeating the objective", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const harness = createTaskContextHarness({ providerEnabled: false });
  const goal = createGoalSnapshot("hold this objective", null);
  harness.entries.push(
    { type: "custom", customType: "pi-better-goal", data: goalSetEntry(goal, "command") },
    {
      type: "custom",
      customType: "pi-better-goal",
      data: continuationStateEntry({
        ...createContinuationState(goal.goalId),
        blocked: true,
        noProgressRetries: 10,
        lastEvidenceSummary: "fixture, no observable action",
      }),
    },
  );
  await harness.start();

  const update = await harness.prompt();
  assert.match(update?.systemPrompt ?? "", /Automatic Goal continuation is held for no progress/);
  assert.match(update?.systemPrompt ?? "", /Only \/goal resume or alt\+g reopens this hold/);
  assert.ok(!(update?.systemPrompt ?? "").includes("hold this objective"));
  assert.doesNotMatch(update?.systemPrompt ?? "", /Pi Better Goal active objective/);

  await harness.shutdown();
});

test("Harness presence suppresses Goal's workflow objective line but retains workflow instructions", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const dir = mkdtempSync(join(tmpdir(), "pi-goal-task-context-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const skillPath = join(dir, "SKILL.md");
  writeFileSync(skillPath, "---\nname: fixture\nmetadata:\n  workflow-role: coordinator\n---\n# Fixture\nOnly coordinate work.\n");
  const skills: SkillCommand[] = [{ name: "skill:fixture", source: "skill", sourceInfo: { path: skillPath } }];

  const standalone = createTaskContextHarness({ skills });
  await standalone.start();
  await standalone.goal("/skill:fixture implement task");
  const standalonePrompt = await standalone.prompt();
  assert.match(standalonePrompt?.systemPrompt ?? "", /Only coordinate work/);
  assert.match(standalonePrompt?.systemPrompt ?? "", /Active objective: \/skill:fixture implement task/);
  await standalone.shutdown();

  const harness = createTaskContextHarness({ skills, providerEnabled: false });
  await harness.start();
  await harness.goal("/skill:fixture implement task");
  const update = await harness.prompt();
  assert.match(update?.systemPrompt ?? "", /Only coordinate work/, "workflow instructions are retained");
  assert.match(update?.systemPrompt ?? "", /Complete the goal only after the workflow completion audit/);
  assert.doesNotMatch(update?.systemPrompt ?? "", /Active objective:/);
  assert.ok(!(update?.systemPrompt ?? "").includes("/skill:fixture implement task"), "Goal does not repeat the raw trigger");
  await harness.shutdown();
});

function goalWidget(harness: ReturnType<typeof createTaskContextHarness>) {
  const installed = harness.widgets.get("pi-better-goal");
  assert.ok(installed, "expected Goal to install its clock widget");
  return installed.factory(harness.tui, { fg: (_color: string, value: string) => value });
}

test("a Harness header that renders the goal suppresses Goal's own clock line in either load order", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  for (const harnessFirst of [true, false]) {
    const harness = createTaskContextHarness({
      hasUI: true,
      harnessFirst,
      providerEnabled: true,
      providerDisplay: () => true,
    });
    await harness.start();
    await harness.goal("watch the build");
    const goalId = latestRequest(harness).goalId;
    const widget = goalWidget(harness);
    harness.requests.length = 0;

    assert.deepEqual(widget.render(80), [], "the combined header already renders this goal");
    const inspect = latestRequest(harness);
    assert.equal(inspect.action, "inspect");
    assert.equal(inspect.goalId, goalId, "inspect carries the real goal so the runtime can match the id");
    widget.dispose?.();
    await harness.shutdown();
  }
});

test("Goal's clock line depends on display ownership, never on hooks authority", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  // `undefined` means the runtime or field is absent, not merely false.
  const cases: Array<{ label: string; enabled: boolean | undefined; display: boolean | undefined; suppressed: boolean }> = [
    { label: "hooks off, display on", enabled: false, display: true, suppressed: true },
    { label: "hooks on, display on", enabled: true, display: true, suppressed: true },
    { label: "hooks on, Todo hidden", enabled: true, display: false, suppressed: false },
    { label: "hooks off, Todo hidden", enabled: false, display: false, suppressed: false },
    { label: "runtime without display ownership", enabled: true, display: undefined, suppressed: false },
    { label: "no Harness runtime", enabled: undefined, display: undefined, suppressed: false },
  ];

  for (const scenario of cases) {
    const harness = createTaskContextHarness({
      hasUI: true,
      ...(scenario.enabled === undefined ? {} : { providerEnabled: scenario.enabled }),
      ...(scenario.display === undefined ? {} : { providerDisplay: () => scenario.display }),
    });
    await harness.start();
    await harness.goal("watch the build");
    const rendered = goalWidget(harness).render(80);

    if (scenario.suppressed) {
      assert.deepEqual(rendered, [], `${scenario.label}: the combined header owns the clock`);
    } else {
      assert.equal(rendered.length, 2, `${scenario.label}: Goal keeps its standalone clock`);
      assert.match(rendered[0] ?? "", /goal active \d+:\d{2} watch the build/);
    }
    await harness.shutdown();
  }
});

test("a header showing a different goal leaves the standalone Goal clock in place", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const harness = createTaskContextHarness({
    hasUI: true,
    providerEnabled: false,
    providerDisplay: (request) => request.goalId === "another-goal",
  });
  await harness.start();
  await harness.goal("watch the build");
  const rendered = goalWidget(harness).render(80);

  assert.equal(rendered.length, 2, "an unmatched goalId is not display ownership");
  assert.match(rendered[0] ?? "", /goal active \d+:\d{2} watch the build/);
  await harness.shutdown();
});

test("a suppressed Goal clock still schedules coarse root renders for the header's timing", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const harness = createTaskContextHarness({
    hasUI: true,
    providerEnabled: true,
    providerDisplay: () => true,
  });
  await harness.start();
  await harness.goal("watch the build");
  const goalId = latestRequest(harness).goalId;
  const widget = goalWidget(harness);
  harness.renders.length = 0;
  harness.requests.length = 0;

  assert.deepEqual(widget.render(80), []);
  const paintsAfterFirstRender = harness.renders.length;
  t.mock.timers.tick(ACTIVE_GOAL_REFRESH_MS - 1);
  assert.equal(harness.renders.length, paintsAfterFirstRender, "the header is not repainted every second");
  t.mock.timers.tick(1);
  assert.equal(harness.renders.length, paintsAfterFirstRender + 1, "the clock keeps asking for a root render");
  assert.equal(harness.renders.at(-1), false, "clock ticks stay differential paints");

  widget.render(80);
  const reinspect = latestRequest(harness);
  assert.equal(reinspect.action, "inspect");
  assert.equal(reinspect.goalId, goalId, "every root render carries the real goal for the runtime to rebuild");
  widget.dispose?.();
  await harness.shutdown();
});
