import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import goalExtension from "../../../pi-better-goal/src/index.js";
import { reconstructGoalSnapshot, goalSetEntry, goalWithStatus } from "../../../pi-better-goal/src/goal-state.js";
import { GOAL_PANEL_START_EVENT, OUTCOME_ACCEPTED_EVENT } from "../../../pi-better-goal/src/task-context.js";
import { EXTENSION_NAME } from "../../../pi-better-goal/src/types.js";
import { currentWorkflowOwner, workflowEntry, WORKFLOW_ENTRY_TYPE } from "../../../pi-better-goal/src/workflow.js";
import { boundPlanPath } from "../../../pi-better-goal/src/workflow-gates.js";
import { WORKFLOW_PLAN_ENTRY, workflowBinding } from "../../extensions/task-context/workflow-plan.js";
import taskExtension from "../../extensions/task-context/index.js";
import { createSettingsRegistry } from "../../extensions/settings/registry.js";
import { OUTCOME_ENTRY, restoreOutcome } from "../../extensions/task-context/outcome-state.js";

async function fixture(t: TestContext, options: { autoStart?: boolean; ledger?: boolean; harnessFirst?: boolean; restored?: boolean; workflow?: "available" | "missing" | "invalid" } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const dir = mkdtempSync(join(tmpdir(), "outcome-auto-goal-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ piBetterHarness: {
    outcomeTodo: { version: 1, enabled: false, display: false, ledger: options.ledger ?? false },
    goal: { version: 1, autoStartFromOutcome: options.autoStart ?? true },
  } }));
  const entries: any[] = [];
  const skillPath = join(dir, "SKILL.md");
  if (options.workflow) {
    writeFileSync(skillPath, options.workflow === "invalid" ? "# No workflow metadata\n"
      : "---\nname: rush-issues\nmetadata:\n  workflow-role: coordinator\n---\n# Rush issues\n");
    entries.push({ type: "custom", customType: WORKFLOW_ENTRY_TYPE, data: workflowEntry({
      name: "rush-issues", path: skillPath, role: "coordinator", planOwner: "workflow",
    }) });
  }
  if (options.restored) entries.push({ type: "custom", customType: OUTCOME_ENTRY, data: {
    version: 1, outcome: { objective: "Ship checkout", status: "active", doneWhen: ["Checkout succeeds"] },
  } });
  const hooks = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const messages: unknown[] = [];
  const events = createEventBus();
  let active: string[] = [];
  let idle = false;
  const ctx: any = {
    cwd: dir, mode: "print", hasUI: false, isIdle: () => idle,
    sessionManager: { getBranch: () => entries, getSessionId: () => "auto-goal-session" },
    ui: { notify() {}, setWidget() {}, setStatus() {} },
  };
  const pi: any = {
    events,
    registerTool(tool: any) { tools.set(tool.name, tool); active.push(tool.name); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerShortcut() {},
    getCommands: () => options.workflow && options.workflow !== "missing"
      ? [{ name: "skill:rush-issues", source: "skill", sourceInfo: { path: skillPath } }] : [],
    getActiveTools: () => active, setActiveTools(names: string[]) { active = names; },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    sendMessage(...args: unknown[]) { messages.push(args); },
    sendUserMessage(...args: unknown[]) { messages.push(args); },
    on(name: string, handler: Function) { hooks.set(name, [...hooks.get(name) ?? [], handler]); },
  };
  const settings = createSettingsRegistry(pi);
  for (const extension of options.harnessFirst ? [taskExtension, goalExtension] : [goalExtension, taskExtension]) extension(pi);
  const emit = async (name: string, event: unknown = {}) => { for (const handler of hooks.get(name) ?? []) await handler(event, ctx); };
  t.after(async () => {
    await emit("session_shutdown");
    settings.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  await emit("session_start");
  settings.refresh();
  return {
    entries, ctx, events, messages, emit, settings,
    startWorkflow: () => commands.get("dynamic-workflow").handler("", ctx),
    workflow: async (input: unknown) => (await tools.get("dynamic_workflow").execute("wf", input, undefined, undefined, ctx)).details.run,
    setIdle(value: boolean) { idle = value; },
    goal: () => reconstructGoalSnapshot(entries),
    outcome: () => restoreOutcome(entries),
    update: (input: unknown) => tools.get("update_todo").execute("update", input, undefined, undefined, ctx),
    getGoal: async () => (await tools.get("get_goal").execute("get", {}, undefined, undefined, ctx)).details,
    getTodo: async () => (await tools.get("get_todo").execute("get", {}, undefined, undefined, ctx)).details,
    complete: (evidence?: { criterion: string; result: string }[]) => tools.get("update_goal").execute("complete", { status: "complete", evidence }, undefined, undefined, ctx),
    command: (args: string) => commands.get("goal").handler(args, ctx),
  };
}

const accepted = { objective: "Ship checkout", doneWhen: ["Checkout succeeds"], boundaries: ["No production writes"] };

for (const first of ["pause", "resume"] as const) {
  test(`/goal ${first} controls a restored Todo with no execution record or doneWhen`, async t => {
    const h = await fixture(t, { autoStart: false });
    const objective = "Deliver checkout";
    await h.update({ outcome: { objective, boundaries: ["Staging only"] }, todo: [{ step: "Verify checkout", status: "pending" }] });
    await h.emit("session_tree");
    const before = await h.getTodo();
    assert.equal(h.goal(), null);
    assert.equal((await h.getGoal()).goal.objective, objective);
    await h.command(first);
    const id = h.goal()?.goalId;
    assert.ok(id);
    assert.equal(h.goal()?.status, first === "pause" ? "paused" : "active");
    assert.equal(h.messages.length, first === "pause" ? 0 : 1);
    await h.emit("session_tree");
    if (first === "pause") {
      await assert.rejects(h.update({ goal: { objective, status: "active" } }), /goal resume/);
      await h.command("resume");
    }
    assert.equal(h.messages.length, 1);
    assert.equal(h.goal()?.goalId, id);
    assert.equal(h.goal()?.status, "active");
    const after = await h.getTodo();
    assert.deepEqual(after.plan, before.plan);
    assert.deepEqual(after.goal, { ...before.outcome, goalId: id, status: "active" });
    await h.update({ goal: { objective: "Deliver checkout and receipts" } });
    assert.equal(h.outcome()?.objective, "Deliver checkout and receipts");
    assert.equal((await h.getGoal()).goal.objective, h.outcome()?.objective);
    assert.equal(h.goal()?.goalId, id);
  });
}

test("the panel starts only its current saved objective and ignores repeat clicks", async t => {
  const h = await fixture(t, { autoStart: false });
  h.ctx.hasUI = true;
  const sessionId = h.ctx.sessionManager.getSessionId();
  await h.update({ goal: accepted, todo: [{ step: "Check payments", status: "pending" }] });
  const before = await h.getTodo();
  const click = { action: "start", sessionId, objective: accepted.objective };
  h.events.emit(GOAL_PANEL_START_EVENT, { ...click, sessionId: "another-session" });
  h.events.emit(GOAL_PANEL_START_EVENT, { ...click, objective: "Earlier task" });
  assert.equal(h.goal(), null);
  h.events.emit(GOAL_PANEL_START_EVENT, click);
  h.events.emit(GOAL_PANEL_START_EVENT, click);
  assert.equal(h.goal()?.objective, accepted.objective);
  assert.deepEqual((await h.getTodo()).plan, before.plan);
  assert.equal(h.messages.length, 1);
});

test("manual controls preserve a checklist without an objective and ignore an empty session", async t => {
  const h = await fixture(t);
  await h.command("resume");
  assert.equal(h.goal(), null);
  await h.update({ todo: [{ step: "Ship the patch", status: "in_progress" }] });
  const before = await h.getTodo();
  await h.command("pause");
  assert.equal(h.goal()?.status, "paused");
  await h.command("resume");
  assert.deepEqual((await h.getTodo()).plan, before.plan);
  assert.equal(h.messages.length, 1);
});

test("manual controls work with legacy disabled flags and auto-run off", async t => {
  const h = await fixture(t, { autoStart: false });
  await h.update({ goal: accepted });
  assert.equal(h.goal(), null);
  await h.command("pause");
  assert.equal(h.outcome()?.status, "paused");
  await h.emit("session_tree");
  await h.command("resume");
  assert.equal(h.outcome()?.status, "active");
  assert.equal(h.settings.controls().find(control => control.id === "goal-auto-start")?.get(), "Off");
  assert.equal(h.messages.length, 1);
});

test("manual controls never replace another unfinished Goal or restart a finished task", async t => {
  const h = await fixture(t, { autoStart: false });
  await h.command("Ship checkout");
  const first = h.goal()!.goalId;
  await h.update({ newTask: true, goal: { objective: "Publish a guide" } });
  const before = h.entries.length;
  for (const control of ["pause", "resume"]) await h.command(control);
  assert.equal(h.entries.length, before);
  assert.equal(h.goal()?.goalId, first);
  await h.command("clear");
  await h.update({ goal: { objective: "Publish a guide", status: "complete" } });
  await h.command("resume");
  assert.equal(h.goal(), null);
});

test("automatic Goals retain the workflow's completion gates on creation and reopen", async t => {
  const h = await fixture(t, { workflow: "available" });
  await h.update({ outcome: accepted });
  assert.equal(h.goal()?.status, "active");
  assert.equal(h.goal()?.command?.name, "skill:rush-issues");
  const result = await h.complete();
  assert.equal(result.details.ok, false, "an unverified workflow cannot be completed through the automatic Goal");
  assert.equal(h.goal()?.status, "active");
  assert.equal(currentWorkflowOwner(h.entries)?.name, "rush-issues");
  assert.deepEqual(h.messages, [], "binding the active workflow must not invoke the skill again");
  const original = h.goal()!;
  await h.command("complete");
  assert.equal(currentWorkflowOwner(h.entries), null);
  await assert.rejects(h.update({ outcome: { ...accepted, status: "active" }, todo: [] }), /rush-issues owns the task plan/);
  assert.equal(h.outcome()?.status, "complete");
  await h.update({ outcome: { ...accepted, status: "active" } });
  assert.notEqual(h.goal()?.goalId, original.goalId);
  assert.deepEqual(h.goal()?.command, original.command);
  assert.equal(currentWorkflowOwner(h.entries)?.name, "rush-issues");
  const reopened = await h.complete([{ criterion: accepted.doneWhen[0]!, result: "Checkout test passed" }]);
  assert.equal(reopened.details.ok, false);
  assert.match(reopened.content[0].text, /plan|scheduler/i);
  assert.equal(h.goal()?.status, "active");
  assert.deepEqual(h.messages, []);
  await h.command("complete");
  await h.update({ newTask: true, outcome: accepted });
  assert.equal(h.goal()?.status, "active");
  assert.equal(h.goal()?.command, undefined, "a new task with the same objective has its own binding");
});

for (const legacy of [true, false]) test(`reopening restores the original coordinator after a different coordinator owned the session (legacy: ${legacy})`, async t => {
  const h = await fixture(t, { workflow: "available" });
  await h.update({ outcome: accepted });
  const original = h.goal()!;
  const other = { ...currentWorkflowOwner(h.entries)!, name: "another-coordinator", path: join(h.ctx.cwd, "other.md") };
  h.entries.push({ type: "custom", customType: WORKFLOW_ENTRY_TYPE, data: workflowEntry(other) });
  await h.command("complete");
  if (legacy) {
    for (const entry of h.entries) if (entry.data?.goal) delete entry.data.goal.workflowBinding;
  }
  assert.deepEqual(currentWorkflowOwner(h.entries), other);
  await h.update({ outcome: { ...accepted, status: "active" } });
  assert.equal(h.goal()?.status, "active");
  assert.deepEqual(h.goal()?.command, original.command);
  assert.equal(currentWorkflowOwner(h.entries)?.name, "rush-issues");
  await h.command("complete");
  await h.update({ outcome: { ...accepted, status: "active" } });
  assert.deepEqual(h.goal()?.workflowBinding, original.workflowBinding);
  assert.equal(h.goal()?.status, "active");
});

test("a failed workflow reopen keeps its binding across edits and reload", async t => {
  const h = await fixture(t, { workflow: "available" });
  await h.update({ outcome: accepted });
  const original = h.goal()!;
  await h.command("complete");
  const skill = original.command!.path;
  const contents = readFileSync(skill);
  rmSync(skill);
  await h.update({ outcome: { ...accepted, status: "active" } });
  await h.emit("session_tree");
  const refinement = { objective: "Verify deployment", doneWhen: ["Deployment checked"] };
  await h.update({ outcome: refinement });
  assert.equal(h.outcome()?.reopenedGoalId, original.goalId);
  assert.equal(h.goal()?.goalId, original.goalId);
  assert.equal(h.goal()?.status, "complete");

  await assert.rejects(h.update({ todo: [] }), /Restore \/skill:rush-issues/);
  writeFileSync(skill, "# Skill without workflow metadata");
  await h.update({ outcome: refinement });
  assert.equal(h.goal()?.status, "complete");
  writeFileSync(skill, contents);
  await h.update({ outcome: refinement });
  assert.deepEqual(h.goal()?.command, original.command);
  assert.equal(h.goal()?.status, "active");
  assert.equal(h.outcome()?.reopenedGoalId, undefined);
  assert.equal(currentWorkflowOwner(h.entries)?.name, "rush-issues");
  const result = await h.complete([{ criterion: refinement.doneWhen[0]!, result: "Verified" }]);
  assert.equal(result.details.ok, false);
  assert.match(result.content[0].text, /plan|scheduler/i);
});

for (const workflow of ["missing", "invalid"] as const) {
  test(`automatic Goals wait when the current workflow is ${workflow}`, async t => {
    const h = await fixture(t, { workflow });
    await h.update({ outcome: accepted });
    assert.equal(h.goal(), null);
    assert.equal(h.outcome()?.goalId, undefined);
    assert.equal(currentWorkflowOwner(h.entries)?.name, "rush-issues");
    assert.deepEqual(h.messages, []);
  });
}

for (const harnessFirst of [false, true]) {
  test(`accepted outcome binds one Goal without losing Todo or sending kickoff (Harness first: ${harnessFirst})`, async t => {
    const h = await fixture(t, { harnessFirst });
    await h.update({ outcome: accepted, todo: [{ step: "Verify checkout", status: "completed" }] });
    const goal = h.goal();
    assert.equal(goal?.status, "active");
    assert.equal(goal?.objective, accepted.objective);
    assert.deepEqual(h.outcome(), { ...accepted, status: "active", goalId: goal!.goalId });
    assert.equal((await h.getTodo()).progress.completed, 1);
    assert.deepEqual(h.messages, [], "the current tool turn must not queue a duplicate kickoff");
    await h.update({ outcome: { ...accepted, objective: "Ship checkout and refunds" } });
    assert.equal(h.goal()?.goalId, goal!.goalId, "a refinement does not start a second Goal");
    assert.equal(h.outcome()?.objective, "Ship checkout and refunds");
    assert.equal(h.entries.filter(e => e.customType === EXTENSION_NAME && e.data.kind === "set").length, 1);
    await h.command("complete");
    assert.equal(h.outcome()?.status, "complete", "the existing completion bridge remains authoritative");
  });
}

for (const autoContinue of [true, false]) {
  test(`an automatically created Goal respects idle continuation (enabled: ${autoContinue})`, async t => {
    const h = await fixture(t);
    await h.command(`settings auto-continue ${autoContinue ? "on" : "off"}`);
    await h.emit("agent_start");
    await h.update({ outcome: accepted });
    assert.deepEqual(h.messages, []);
    await h.emit("agent_end", { messages: [{
      role: "assistant", content: [{ type: "text", text: "Checkout verification is still pending." }], stopReason: "stop",
    }] });
    h.setIdle(true);
    await h.emit("agent_settled");
    t.mock.timers.tick(60_000);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(h.messages.length, autoContinue ? 1 : 0);
    assert.equal(h.goal()?.status, "active");
  });
}

test("auto-start defaults off, enabling does not replay existing state, and disabling affects future outcomes", async t => {
  const h = await fixture(t, { autoStart: false });
  await h.update({ outcome: accepted });
  assert.equal(h.goal(), null);
  const before = h.entries.length;
  const control = h.settings.controls().find(item => item.id === "goal-auto-start")!;
  assert.equal(control.label, "Auto-start Goals");
  assert.equal(control.get(), "Off");
  await control.change("On", h.ctx);
  assert.equal(control.get(), "On");
  assert.equal(h.goal(), null);
  assert.equal(h.entries.length, before, "changing a preference does not start an existing outcome");
  await h.update({ outcome: accepted });
  assert.equal(h.goal()?.status, "active");
  await h.command("complete");
  await h.command("settings auto-start-from-outcome off");
  assert.equal(control.get(), "Off");
  const completed = h.goal()!.goalId;
  await h.update({ newTask: true, outcome: { ...accepted, objective: "Investigate refunds" } });
  assert.equal(h.goal()?.goalId, completed);
  assert.equal(h.goal()?.status, "complete");
});

test("missing acceptance criteria, inactive outcomes and slash invocations do not start Goals", async t => {
  const h = await fixture(t);
  for (const outcome of [
    { objective: "Investigate checkout" },
    { ...accepted, doneWhen: [] },
    { ...accepted, doneWhen: [" "] },
    { ...accepted, status: "paused" },
    { ...accepted, status: "complete" },
    { ...accepted, status: "cancelled" },
    { ...accepted, objective: "/skill:ship checkout" },
    { ...accepted, objective: "x".repeat(8001) },
  ]) {
    await h.update({ newTask: true, outcome });
    assert.equal(h.goal(), null);
  }
  const count = h.entries.length;
  await assert.rejects(h.update({ newTask: true, outcome: accepted, todo: [{ step: "", status: "pending" }] }));
  assert.equal(h.entries.length, count, "failed Todo validation cannot partially commit a Goal");
});

for (const status of ["active", "paused", "budgetLimited"] as const) {
  test(`auto-start never replaces or resumes an existing ${status} Goal`, async t => {
    const h = await fixture(t);
    await h.update({ outcome: accepted });
    const original = h.goal()!;
    if (status !== "active") h.entries.push({ type: "custom", customType: EXTENSION_NAME,
      data: goalSetEntry(goalWithStatus(original, status), "runtime") });
    await h.update({ newTask: true, outcome: { ...accepted, objective: "Investigate another task" } });
    assert.equal(h.goal()?.goalId, original.goalId);
    assert.equal(h.goal()?.status, status);
    assert.equal(h.outcome()?.goalId, undefined, "new task memory is not rebound to an unrelated Goal");
    assert.deepEqual(h.messages, []);
  });
}

test("a new task may start after completion, but clearing a bound Goal does not rearm that outcome", async t => {
  const h = await fixture(t);
  await h.update({ outcome: accepted });
  const first = h.goal()!.goalId;
  await h.command("complete");
  await h.update({ newTask: true, outcome: { ...accepted, objective: "Investigate refunds" } });
  assert.notEqual(h.goal()?.goalId, first);
  const second = h.goal()!.goalId;
  await h.command("clear");
  await h.update({ outcome: { ...accepted, objective: "Investigate refunds", status: "active" } });
  assert.equal(h.goal(), null);
  assert.equal(h.outcome()?.goalId, second);
});

test("session restore, branch navigation and foreign session notifications do not auto-start", async t => {
  const h = await fixture(t, { restored: true });
  assert.equal(h.goal(), null);
  await h.emit("session_tree");
  assert.equal(h.goal(), null);
  h.events.emit(OUTCOME_ACCEPTED_EVENT, { sessionId: "other-session", outcome: { ...accepted, status: "active" } });
  assert.equal(h.goal(), null);
  await h.update({ outcome: accepted });
  assert.equal(h.outcome()?.goalId, h.goal()?.goalId);
});

test("a separate coordinator cannot bypass a plain Goal's unfinished Todo or be released by it", async t => {
  for (const status of ["pending", "completed"]) {
    await t.test(status, async t => {
      const h = await fixture(t, { workflow: "available" });
      h.entries.push({ type: "custom", customType: WORKFLOW_ENTRY_TYPE, data: workflowEntry(null) });
      await h.emit("session_tree");
      await h.update({ goal: accepted, todo: [{ step: "Check receipts", status }] });
      assert.equal(h.goal()?.command, undefined);
      await h.emit("input", { source: "interactive", text: "/skill:rush-issues #42" });
      assert.equal(currentWorkflowOwner(h.entries)?.name, "rush-issues");
      const result = await h.complete([{ criterion: accepted.doneWhen[0]!, result: "Checkout test passed" }]);
      assert.equal(result.details.ok, status === "completed");
      if (status === "pending") assert.deepEqual(result.details.openSteps, ["Check receipts"]);
      assert.equal(h.goal()?.status, status === "pending" ? "active" : "complete");
      assert.equal(currentWorkflowOwner(h.entries)?.name, "rush-issues");
    });
  }
});

test("scheduler finish still requires evidence for each accepted criterion", async t => {
  const h = await fixture(t, { workflow: "available" });
  const doneWhen = ["SGP1 deployment verified", "Payment rules accepted", "Issue closed"];
  await h.update({ outcome: { objective: "Deliver the issue", doneWhen } });
  mkdirSync(join(h.ctx.cwd, "scripts"));
  writeFileSync(join(h.ctx.cwd, "scripts", "next-actions.mjs"), 'console.log(JSON.stringify({due:[{action:"finish"}]}))');
  h.entries.push({ type: "custom", customType: "pi-better-workflow-plan",
    data: { version: 1, kind: "set", owner: "rush-issues", path: join(h.ctx.cwd, "task-plan.json") } });
  await assert.rejects(h.update({ outcome: { objective: "Deliver the issue", status: "complete" } }), /update_goal/);
  const evidence = doneWhen.map((criterion, i) => ({ criterion, result: ["QA receipt 12 passed", "Policy test 5 passed", "Issue tracker shows closed"][i]! }));
  assert.deepEqual((await h.complete()).details.missing, doneWhen);
  assert.deepEqual((await h.complete(evidence.slice(0, 2))).details.missing, ["Issue closed"]);
  assert.equal(h.goal()?.status, "active");
  assert.equal(currentWorkflowOwner(h.entries)?.name, "rush-issues");
  assert.equal((await h.complete(evidence)).details.ok, true);
  assert.equal(h.outcome()?.status, "complete");
});

test("explicitly reopening work after a completed Goal continues its Todo with a fresh Goal", async t => {
  const h = await fixture(t, { autoStart: false });
  await h.command("Deliver checkout");
  const first = h.goal()!.goalId;
  await h.command("complete");
  const objective = "Verify deployment and close the issue";
  await h.update({ outcome: { objective, status: "active" }, todo: [{ step: "Verify deployment", status: "in_progress" }] });
  assert.equal(h.goal()?.status, "complete");
  assert.equal(h.outcome()?.goalId, undefined);
  await h.emit("session_tree");
  await h.command("resume");
  assert.notEqual(h.goal()?.goalId, first);
  assert.equal(h.goal()?.status, "active");
  assert.equal(h.outcome()?.goalId, h.goal()?.goalId);
  const evidence = [{ criterion: objective, result: "Deployment QA passed and the tracker records the issue closed" }];
  assert.deepEqual((await h.complete(evidence)).details.openSteps, ["Verify deployment"]);
  await h.update({ todo: [{ step: "Verify deployment", status: "completed" }] });
  assert.deepEqual((await h.complete()).details.missing, [objective]);
  assert.equal((await h.complete(evidence)).details.ok, true);
});

test("restoring a legacy follow-up preserves its active work and an explicit Goal adopts it", async t => {
  const h = await fixture(t, { autoStart: false });
  await h.command("Deliver checkout");
  await h.command("complete");
  const objective = "Verify deployment";
  h.entries.push({ type: "custom", customType: OUTCOME_ENTRY, data: { version: 1,
    outcome: { objective, status: "active", goalId: h.goal()!.goalId, source: "goal" } } });
  await h.emit("session_tree");
  const restored = (await h.getTodo()).outcome;
  assert.equal(restored.status, "active");
  assert.equal(restored.goalId, undefined);
  await h.update({ todo: [{ step: "Verify receipts", status: "pending" }] });
  await h.command(objective);
  assert.equal(h.outcome()?.goalId, h.goal()?.goalId);
  assert.deepEqual((await h.complete()).details.openSteps, ["Verify receipts"]);
});

test("reopening the original slash-command Outcome restores its binding without dispatching the skill", async t => {
  const h = await fixture(t, { autoStart: false, workflow: "available" });
  const objective = "/skill:rush-issues verify deployment";
  await h.command(objective);
  const original = h.goal()!;
  assert.equal(original.command?.args, "verify deployment");
  const plan = { owner: "rush-issues", runId: "deployment", path: join(h.ctx.cwd, ".resolve-issues/rush/deployment/task-plan.json") };
  mkdirSync(join(plan.path, ".."), { recursive: true });
  writeFileSync(plan.path, JSON.stringify({ runId: plan.runId, planRevision: 1, units: [] }));
  h.entries.push({ type: "custom", customType: WORKFLOW_PLAN_ENTRY, data: { version: 1, kind: "set", ...plan } });
  await h.command("complete");
  for (const todo of [[], [{ step: "Replace workflow plan", status: "pending" }]]) {
    const entryCount = h.entries.length;
    await assert.rejects(h.update({ outcome: { objective, status: "active" }, todo }), /rush-issues owns the task plan/);
    assert.equal(h.entries.length, entryCount, "a rejected reopen must not write any entry");
    assert.deepEqual(workflowBinding(h.entries), plan);
    assert.equal((await h.getTodo()).readOnly, true);
  }
  const sent = h.messages.length;
  await h.update({ outcome: { objective, status: "active" } });
  assert.equal(h.goal()?.status, "complete");
  await h.emit("session_tree");
  await assert.rejects(h.update({ todo: [] }), /rush-issues owns the task plan/);
  assert.deepEqual(workflowBinding(h.entries), plan);
  await h.command("pause");
  assert.equal(h.goal()?.status, "paused");
  assert.deepEqual(h.goal()?.command, original.command);
  assert.equal(h.messages.length, sent);
  await h.command("resume");
  const reopened = h.goal()!;
  assert.equal(reopened.status, "active");
  assert.notEqual(reopened.goalId, original.goalId);
  assert.equal(h.outcome()?.goalId, reopened.goalId);
  assert.deepEqual(reopened.command, original.command);
  assert.deepEqual(workflowBinding(h.entries), plan);
  assert.equal(boundPlanPath(h.entries, currentWorkflowOwner(h.entries)!), plan.path);
  assert.equal(currentWorkflowOwner(h.entries)?.name, "rush-issues");
  assert.equal(h.messages.length, sent + 1);

  await h.command("complete");
  await h.update({ outcome: { objective: "/skill:rush-issues release deployment", status: "active" } });
  assert.equal(h.goal()?.status, "complete");
  assert.equal(h.messages.length, sent + 1);
});

test("Goal completion checks the associated work ledger in a headless session", async t => {
  const h = await fixture(t, { ledger: true });
  await h.update({ outcome: accepted });
  const created = await h.update({ ledger: { action: "create", outcome: accepted.objective,
    items: [{ id: "qa", title: "Verify SGP1" }] } });
  const ledgerId = created.details.ledger.id;
  await h.update({ ledger: { action: "attach", ledgerId } });
  const evidence = [{ criterion: accepted.doneWhen[0]!, result: "Checkout passed in SGP1" }];
  const blocked = await h.complete(evidence);
  assert.equal(blocked.details.ok, false);
  assert.match(blocked.content[0].text, /qa \(pending\)/);
  assert.equal(h.goal()?.status, "active");
  await h.update({ ledger: { action: "update", ledgerId, revision: 1,
    changes: [{ id: "qa", status: "completed", evidence: ["Deployment receipt"] }] } });
  assert.equal((await h.complete(evidence)).details.ok, true);
});

test("agent completion consults bound dynamic work and reuses the recorded objective evidence", async t => {
  const h = await fixture(t);
  await h.update({ outcome: accepted });
  await h.startWorkflow();
  const run = await h.workflow({ action: "define", definition: { objective: accepted.objective,
    goalId: h.goal()!.goalId, criteria: accepted.doneWhen, steps: [{ id: "verify", title: "Verify checkout", output: "Receipt" }] } });
  const evidence = [{ criterion: accepted.doneWhen[0], result: "Receipt 9" }];
  assert.equal((await h.complete(evidence)).details.ok, false);
  await h.workflow({ action: "submit", runId: run.id, revision: 1, step: "verify", result: "Receipt 9" });
  assert.equal((await h.complete(evidence)).details.ok, false);
  await h.workflow({ action: "finish", runId: run.id, revision: 2, evidence });
  await h.emit("session_tree");
  assert.equal((await h.complete()).details.ok, true);
  assert.equal(h.goal()?.status, "complete");
});
