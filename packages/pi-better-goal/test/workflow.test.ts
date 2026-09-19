import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import extension from "../src/index.js";
import { currentWorkflowOwner, skillCommandName, workflowOwnerFromSkill } from "../src/workflow.js";

test("workflow metadata opts in through Pi's skill command provenance", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-workflow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const skillPath = join(dir, "SKILL.md");
  let registeredSkillPath = skillPath;
  writeFileSync(skillPath, "---\nname: fixture\ndescription: Test workflow\nmetadata:\n  pi-better-workflow-role: coordinator\n  pi-better-plan-owner: workflow\n---\n# Fixture\nOnly coordinate work.\n");
  assert.equal(skillCommandName("/skill:fixture task"), "fixture");
  assert.equal(skillCommandName("task /skill:fixture"), null);
  assert.equal(workflowOwnerFromSkill("fixture", skillPath)?.planOwner, "workflow");
  const ordinarySkill = join(dir, "ordinary.md");
  writeFileSync(ordinarySkill, "---\nname: ordinary\ndescription: Normal skill\n---\n# Ordinary\n");
  assert.equal(workflowOwnerFromSkill("ordinary", ordinarySkill), null);

  const entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> | void }>();
  const tools = new Map<string, ToolDefinition>();
  const messages: Array<{ content: string }> = [];
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
  assert.ok(notices.some((text) => text.includes("cannot be a goal objective")));
  assert.equal(messages.length, 0);
  await handlers.get("session_start")?.({ reason: "resume" }, ctx);
  assert.equal(currentWorkflowOwner(entries)?.name, "fixture");
  const resumed = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx) as { systemPrompt: string };
  assert.match(resumed.systemPrompt, /Only coordinate work/);
  await tools.get("release_workflow")!.execute("release", {}, undefined, undefined, ctx);
  assert.equal(currentWorkflowOwner(entries), null);
  await handlers.get("input")?.({ source: "interactive", text: "/skill:fixture new task" }, ctx);
  assert.equal(currentWorkflowOwner(entries)?.name, "fixture");
  registeredSkillPath = join(dir, "replaced-skill.md");
  await handlers.get("session_start")?.({ reason: "resume" }, ctx);
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