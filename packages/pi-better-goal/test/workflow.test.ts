import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import extension, { toolContext } from "./extension-fixture.js";
import { currentGoalSnapshot } from "../src/goal-state.js";
import { currentWorkflowOwner, skillCommandName, workflowOwnerFromSkill } from "../src/workflow.js";

test("workflow metadata opts in through Pi's skill command provenance", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const dir = mkdtempSync(join(tmpdir(), "pi-workflow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const skillPath = join(dir, "SKILL.md");
  let registeredSkillPath = skillPath;
  writeFileSync(skillPath, "---\nname: fixture\ndescription: Test workflow\nmetadata:\n  workflow-role: coordinator\n---\n# Fixture\nOnly coordinate work.\n");
  assert.equal(skillCommandName("/skill:fixture task"), "fixture");
  assert.equal(skillCommandName("task /skill:fixture"), null);
  assert.equal(workflowOwnerFromSkill("fixture", skillPath)?.planOwner, "workflow");
  const ordinarySkill = join(dir, "ordinary.md");
  writeFileSync(ordinarySkill, "---\nname: ordinary\ndescription: Normal skill\n---\n# Ordinary\n");
  assert.equal(workflowOwnerFromSkill("ordinary", ordinarySkill), null);
  const previousSkill = join(dir, "previous.md");
  writeFileSync(previousSkill, "---\nmetadata:\n  pi-better-plan-workflow: coordinator\n---\n");
  assert.equal(workflowOwnerFromSkill("previous", previousSkill)?.planOwner, "workflow");
  const conflictingSkill = join(dir, "conflicting.md");
  writeFileSync(conflictingSkill, "---\nmetadata:\n  workflow-role: coordinator\n  pi-better-plan-workflow: worker\n---\n");
  assert.throws(() => workflowOwnerFromSkill("conflicting", conflictingSkill), /Invalid workflow metadata/);
  const invalidSkill = join(dir, "invalid.md");
  writeFileSync(invalidSkill, "---\nmetadata:\n  workflow-role: worker\n---\n");
  assert.throws(() => workflowOwnerFromSkill("invalid", invalidSkill), /Invalid workflow metadata/);
  const legacySkill = join(dir, "legacy.md");
  writeFileSync(legacySkill, "---\nmetadata:\n  pi-better-workflow-role: coordinator\n  pi-better-plan-owner: workflow\n---\n");
  assert.throws(() => workflowOwnerFromSkill("legacy", legacySkill), /Outdated workflow metadata/);

  const entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> | void }>();
  const tools = new Map<string, ToolDefinition>();
  const messages: Array<{ content: string }> = [];
  const userMessages: Array<{ content: string; options: unknown }> = [];
  const notices: string[] = [];
  const ctx = {
    cwd: dir,
    hasUI: true,
    isIdle: () => true,
    sessionManager: { getBranch: () => entries, getSessionId: () => "workflow-session" },
    ui: { notify: (text: string) => notices.push(text), setStatus() {}, setWidget() {} },
  } as unknown as ExtensionContext;
  const pi = {
    events: new EventEmitter(),
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    getCommands: () => [{ name: "skill:fixture", source: "skill", sourceInfo: { path: registeredSkillPath } }],
    sendMessage(message: { content: string }) { messages.push(message); },
    sendUserMessage(content: string, options: unknown) { userMessages.push({ content, options }); },
    registerCommand(name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> | void }) { commands.set(name, command); },
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown) { handlers.set(event, handler); },
  } as unknown as ExtensionAPI;
  extension(pi);
  await handlers.get("session_start")?.({ reason: "startup" }, ctx);
  await handlers.get("input")?.({ source: "interactive", text: "/skill:fixture implement task" }, ctx);
  assert.equal(currentWorkflowOwner(entries)?.name, "fixture");
  const prompt = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx) as { systemPrompt: string };
  assert.match(prompt.systemPrompt, /Only coordinate work/);
  assert.doesNotMatch(prompt.systemPrompt, /Keep working through clear low-risk next steps/);

  await commands.get("goal")?.handler("/skill:fixture implement task", ctx);
  assert.equal(currentGoalSnapshot(ctx)?.command?.path, skillPath);
  assert.equal(userMessages[0]?.content, "/skill:fixture implement task");
  assert.deepEqual(userMessages[0]?.options, { deliverAs: "followUp", expandPromptTemplates: true });
  assert.equal(messages.length, 0);
  await handlers.get("session_start")?.({ reason: "resume" }, ctx);
  t.mock.timers.tick(60_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(userMessages[1]?.content ?? "", /Continue the existing goal/);
  await commands.get("goal")?.handler("pause", ctx);
  await handlers.get("session_start")?.({ reason: "resume" }, ctx);
  await commands.get("goal")?.handler("resume", ctx);
  assert.match(userMessages[2]?.content ?? "", /^\/skill:fixture implement task/);
  assert.match(userMessages[2]?.content ?? "", /Continue the existing goal/);
  assert.equal(currentWorkflowOwner(entries)?.name, "fixture");
  const resumed = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx) as { systemPrompt: string };
  assert.match(resumed.systemPrompt, /Only coordinate work/);
  await tools.get("release_workflow")!.execute("release", {}, undefined, undefined, toolContext(ctx));
  assert.equal(currentWorkflowOwner(entries), null);
  assert.equal(currentGoalSnapshot(ctx)?.status, "paused");
  await handlers.get("input")?.({ source: "interactive", text: "/skill:fixture new task" }, ctx);
  assert.equal(currentWorkflowOwner(entries)?.name, "fixture");
  registeredSkillPath = join(dir, "replaced-skill.md");
  await handlers.get("session_start")?.({ reason: "resume" }, ctx);
  assert.equal(currentGoalSnapshot(ctx)?.status, "paused");
  const unavailable = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx) as { systemPrompt: string };
  assert.match(unavailable.systemPrompt, /no longer a registered, valid skill/);
  assert.equal(currentWorkflowOwner(entries), null, "a stale skill path loses ownership on resume");
  await commands.get("workflow")?.handler("clear", ctx);
  assert.equal(currentWorkflowOwner(entries), null);
  await handlers.get("session_shutdown")?.({}, ctx);
});

test("a legacy slash-shaped goal pauses on resume rather than executing as plain text", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { createGoalSnapshot, goalSetEntry } = await import("../src/goal-state.js");
  const entries: Array<{ type: string; customType?: string; data?: unknown }> = [
    { type: "custom", customType: "pi-better-goal", data: goalSetEntry(createGoalSnapshot("/skill:missing work", null), "command") },
  ];
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const messages: unknown[] = [];
  const ctx = {
    hasUI: false, isIdle: () => true,
    sessionManager: { getBranch: () => entries, getSessionId: () => "legacy-session" },
    ui: { notify() {}, setStatus() {}, setWidget() {} },
  } as unknown as ExtensionContext;
  const pi = {
    events: new EventEmitter(),
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    sendMessage(message: unknown) { messages.push(message); },
    registerTool() {}, registerCommand() {},
    on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown) { handlers.set(event, handler); },
  } as unknown as ExtensionAPI;
  extension(pi);
  await handlers.get("session_start")?.({ reason: "resume" }, ctx);
  const { currentGoalSnapshot } = await import("../src/goal-state.js");
  assert.equal(currentGoalSnapshot(ctx)?.status, "paused");
  assert.equal(messages.length, 0);
  await handlers.get("session_shutdown")?.({}, ctx);
});

test("an alias declaring workflow-alias-of binds its coordinator, so the coordinator's plan can sync", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const dir = mkdtempSync(join(tmpdir(), "pi-workflow-alias-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rushPath = join(dir, "rush-issues.md");
  writeFileSync(rushPath, "---\nname: rush-issues\nmetadata:\n  workflow-role: coordinator\n---\n# Rush\nCoordinate the rush run.\n");
  const aliasPath = join(dir, "resolve-issues.md");
  writeFileSync(aliasPath, "---\nname: resolve-issues\nmetadata:\n  workflow-alias-of: rush-issues\n---\n# Alias\nRun rush-issues unchanged.\n");
  const registered = new Map([["rush-issues", rushPath], ["resolve-issues", aliasPath]]);
  const resolve = (name: string) => registered.get(name);
  const rushOwner = { name: "rush-issues", path: rushPath, role: "coordinator", planOwner: "workflow" };

  assert.deepEqual(workflowOwnerFromSkill("resolve-issues", aliasPath, resolve), rushOwner);
  assert.throws(() => workflowOwnerFromSkill("resolve-issues", aliasPath), /rush-issues, which is not a registered skill/);
  const ordinaryPath = join(dir, "ordinary.md");
  writeFileSync(ordinaryPath, "---\nname: ordinary\n---\n");
  const toOrdinary = join(dir, "to-ordinary.md");
  writeFileSync(toOrdinary, "---\nmetadata:\n  workflow-alias-of: ordinary\n---\n");
  assert.throws(() => workflowOwnerFromSkill("to-ordinary", toOrdinary, () => ordinaryPath), /not a workflow coordinator/);
  const chained = join(dir, "chained.md");
  writeFileSync(chained, "---\nmetadata:\n  workflow-alias-of: resolve-issues\n---\n");
  assert.throws(() => workflowOwnerFromSkill("chained", chained, resolve), /aliases do not chain/);
  const both = join(dir, "both.md");
  writeFileSync(both, "---\nmetadata:\n  workflow-alias-of: rush-issues\n  workflow-role: coordinator\n---\n");
  assert.throws(() => workflowOwnerFromSkill("both", both, resolve), /Invalid workflow metadata/);
  const self = join(dir, "self.md");
  writeFileSync(self, "---\nmetadata:\n  workflow-alias-of: self\n---\n");
  assert.throws(() => workflowOwnerFromSkill("self", self, resolve), /Invalid workflow metadata/);

  // The session-level failure: after /skill:resolve-issues, pi-better-plan's
  // sync_workflow_plan refused with "Only an active rush-issues workflow can sync its plan."
  const { default: planExtension } = await import("../../pi-better-plan/src/index.js");
  const runDir = join(dir, ".resolve-issues", "rush", "run-1");
  mkdirSync(runDir, { recursive: true });
  const planPath = join(runDir, "task-plan.json");
  writeFileSync(planPath, JSON.stringify({
    runId: "run-1", planRevision: 1, warehouseCanaryRequired: false,
    fleet: { explore: { status: "pending" }, implement: { status: "pending" } },
    issues: [{ id: "1", title: "Unit", stage: "pending", status: "pending", dependsOn: [] }],
  }));
  type Command = { handler(args: string, ctx: ExtensionContext): Promise<void> | void };
  const entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
  const goalHandlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const goalCommands = new Map<string, Command>();
  const goalTools = new Map<string, ToolDefinition>();
  const planTools = new Map<string, ToolDefinition>();
  const userMessages: string[] = [];
  const notices: string[] = [];
  const ctx = {
    cwd: dir, hasUI: true, isIdle: () => true,
    sessionManager: { getBranch: () => entries, getSessionId: () => "alias-session" },
    ui: { notify: (text: string) => notices.push(text), setStatus() {}, setWidget() {} },
  } as unknown as ExtensionContext;
  const shared = {
    events: new EventEmitter(),
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    getCommands: () => [...registered].map(([name, path]) => ({ name: `skill:${name}`, source: "skill", sourceInfo: { path } })),
    sendMessage() {},
    sendUserMessage(content: string) { userMessages.push(content); },
  };
  extension({
    ...shared,
    registerCommand(name: string, command: Command) { goalCommands.set(name, command); },
    registerTool(tool: ToolDefinition) { goalTools.set(tool.name, tool); },
    on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown) { goalHandlers.set(event, handler); },
  } as unknown as ExtensionAPI);
  planExtension({
    ...shared,
    registerCommand() {},
    registerTool(tool: ToolDefinition) { planTools.set(tool.name, tool); },
    on() {},
  } as unknown as Parameters<typeof planExtension>[0]);

  await goalHandlers.get("session_start")?.({ reason: "startup" }, ctx);
  await goalHandlers.get("input")?.({ source: "interactive", text: "/skill:resolve-issues #312" }, ctx);
  assert.deepEqual(currentWorkflowOwner(entries), rushOwner);
  const prompt = await goalHandlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx) as { systemPrompt: string };
  assert.match(prompt.systemPrompt, /Coordinate the rush run/, "resumed turns carry the coordinator's instructions");
  const synced = await planTools.get("update_plan")!.execute("bind", { workflow: { path: planPath, revision: 1 } }, undefined, undefined, toolContext(ctx));
  assert.equal((synced.details as { runId: string }).runId, "run-1");

  await goalCommands.get("workflow")?.handler("clear", ctx);
  await goalCommands.get("goal")?.handler("/skill:resolve-issues #312", ctx);
  assert.equal(userMessages.at(-1), "/skill:resolve-issues #312");
  assert.deepEqual(currentWorkflowOwner(entries), rushOwner, "a goal bound to the alias binds the coordinator too");
  await planTools.get("update_plan")!.execute("bind-goal", { workflow: { path: planPath, revision: 1 } }, undefined, undefined, toolContext(ctx));

  const goalId = currentGoalSnapshot(ctx)?.goalId;
  await goalTools.get("release_workflow")!.execute("release", {}, undefined, undefined, toolContext(ctx));
  assert.equal(currentWorkflowOwner(entries), null);
  assert.equal(currentGoalSnapshot(ctx)?.status, "paused", "handoff stops the associated goal without completing it");
  assert.equal(currentGoalSnapshot(ctx)?.completedAt, null);
  const before = userMessages.length;
  await goalHandlers.get("agent_settled")?.({}, ctx);
  await goalHandlers.get("session_start")?.({ reason: "reload" }, ctx);
  t.mock.timers.tick(720_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(userMessages.length, before, "handoff and reload do not dispatch synthetic skill invocations");
  await goalCommands.get("goal")?.handler("resume", ctx);
  assert.equal(currentGoalSnapshot(ctx)?.status, "paused", "resume alone cannot run with an unwritable workflow plan");
  assert.equal(userMessages.length, before);
  await assert.rejects(planTools.get("update_plan")!.execute("held-update", {
    workflow: { path: planPath, revision: 1, event: "held", changes: [{ target: "run", set: { note: "held" } }] },
  }, undefined, undefined, toolContext(ctx)), /read-only handoff/);
  await goalHandlers.get("input")?.({ source: "extension", text: "/skill:resolve-issues #312" }, ctx);
  assert.equal(currentWorkflowOwner(entries), null, "synthetic input does not reacquire ownership");
  await goalHandlers.get("input")?.({ source: "interactive", text: "/skill:resolve-issues #312" }, ctx);
  await goalCommands.get("goal")?.handler("resume", ctx);
  assert.equal(currentGoalSnapshot(ctx)?.goalId, goalId);
  assert.equal(currentGoalSnapshot(ctx)?.status, "active");
  const updated = await planTools.get("update_plan")!.execute("resumed-update", {
    workflow: { path: planPath, revision: 1, event: "resumed", changes: [{ target: "run", set: { note: "resumed" } }] },
  }, undefined, undefined, toolContext(ctx));
  assert.equal((updated.details as { revision: number }).revision, 2, "explicit re-entry restores real plan mutation");

  await goalCommands.get("goal")?.handler("clear", ctx);
  await goalCommands.get("goal")?.handler("an unrelated objective", ctx);
  await goalHandlers.get("input")?.({ source: "interactive", text: "/skill:resolve-issues #312" }, ctx);
  await goalTools.get("release_workflow")!.execute("unrelated-release", {}, undefined, undefined, toolContext(ctx));
  assert.equal(currentGoalSnapshot(ctx)?.status, "active", "release does not pause an unrelated ordinary goal");

  await goalCommands.get("workflow")?.handler("clear", ctx);
  registered.delete("rush-issues");
  const result = await goalHandlers.get("input")?.({ source: "interactive", text: "/skill:resolve-issues #312" }, ctx);
  assert.deepEqual(result, { action: "handled" }, "an alias whose coordinator is not installed is refused, not run bare");
  assert.match(notices.at(-1) ?? "", /not a registered skill/);
  assert.equal(currentWorkflowOwner(entries), null);
  await goalHandlers.get("session_shutdown")?.({}, ctx);
});
test("an escape-paused workflow goal puts the paused instruction before, and over, the workflow text", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const dir = mkdtempSync(join(tmpdir(), "pi-workflow-paused-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  });
  const skillPath = join(dir, "SKILL.md");
  writeFileSync(skillPath, "---\nname: fixture\nmetadata:\n  workflow-role: coordinator\n---\n# Fixture\nOnly coordinate work.\n");
  const entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> | void }>();
  const ctx = {
    cwd: dir,
    hasUI: false,
    isIdle: () => true,
    sessionManager: { getBranch: () => entries, getSessionId: () => "workflow-paused" },
    ui: { notify() {}, setStatus() {}, setWidget() {} },
  } as unknown as ExtensionContext;
  const pi = {
    events: new EventEmitter(),
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    getCommands: () => [{ name: "skill:fixture", source: "skill", sourceInfo: { path: skillPath } }],
    sendMessage() {},
    sendUserMessage() {},
    registerCommand(name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> | void }) { commands.set(name, command); },
    registerTool() {},
    on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown) { handlers.set(event, handler); },
  } as unknown as ExtensionAPI;
  extension(pi);
  await handlers.get("session_start")?.({ reason: "startup" }, ctx);
  await commands.get("goal")?.handler("/skill:fixture implement task", ctx);
  await handlers.get("agent_end")?.({ messages: [{ role: "assistant", content: [], stopReason: "aborted" }] }, ctx);
  assert.equal(currentGoalSnapshot(ctx)?.pauseReason, "interrupt");

  const prompt = (await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx) as { systemPrompt: string }).systemPrompt;
  const paused = prompt.indexOf("paused because the user pressed escape");
  const override = prompt.indexOf("this overrides the workflow instructions below");
  const workflow = prompt.indexOf("Follow the workflow instructions below");
  const skillText = prompt.indexOf("Only coordinate work.");
  assert.ok(paused > 0 && override > paused, "the paused instruction states that it overrides the workflow");
  assert.ok(workflow > override && skillText > workflow, "the workflow text follows the paused instruction");
  assert.match(prompt, /with a choice that means proceed/);

  await commands.get("goal")?.handler("settings conversational-resume off", ctx);
  await handlers.get("session_start")?.({ reason: "reload" }, ctx);
  const disabled = (await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx) as { systemPrompt: string }).systemPrompt;
  assert.equal(currentGoalSnapshot(ctx)?.status, "paused", "reloading the saved control never resumes the goal");
  assert.match(disabled, /do not continue the goal's work until it is resumed/);
  assert.match(disabled, /this overrides the workflow instructions below/);
  assert.match(disabled, /Only coordinate work/);
  assert.doesNotMatch(disabled, /goal_resume/, "disabling the resume tool retains the workflow pause override");

  await commands.get("goal")?.handler("resume", ctx);
  const running = (await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx) as { systemPrompt: string }).systemPrompt;
  assert.doesNotMatch(running, /pressed escape|overrides the workflow/);
  await handlers.get("session_shutdown")?.({}, ctx);
});
