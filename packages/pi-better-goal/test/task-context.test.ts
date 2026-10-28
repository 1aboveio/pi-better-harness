import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import extension from "./extension-fixture.js";
import { continuationStateEntry, createContinuationState, createGoalSnapshot, goalSetEntry } from "../src/goal-state.js";
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

function createTaskContextHarness(options: {
  providerEnabled?: boolean;
  skills?: SkillCommand[];
} = {}) {
  const entries: SessionEntry[] = [];
  const commands = new Map<string, CommandDefinition>();
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const events = new EventEmitter();
  const requests: TaskContextRequest[] = [];
  const messages: unknown[] = [];
  const userMessages: Array<{ content: string; options: unknown }> = [];
  const ctx = {
    hasUI: false,
    isIdle: () => true,
    cwd: "/tmp/project",
    sessionManager: { getBranch: () => entries, getSessionId: () => "task-context-session" },
    ui: { notify() {}, setStatus() {}, setWidget() {} },
  } as unknown as ExtensionContext;

  events.on("pi-better-harness:task-context", (request: TaskContextRequest) => {
    if (options.providerEnabled !== undefined) request.enabled = options.providerEnabled;
    requests.push({ ...request });
  });

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
  return {
    commands,
    handlers,
    events,
    requests,
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
