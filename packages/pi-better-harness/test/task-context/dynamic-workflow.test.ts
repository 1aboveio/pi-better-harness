import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createGoalSnapshot, goalSetEntry } from "pi-better-goal/src/goal-state.ts";
import { requestTaskContext } from "pi-better-goal/src/task-context.ts";
import { captureLaunchContext } from "pi-better-subagents/launch-context.ts";
import { launchWorkflowAssignment } from "pi-better-subagents/workflow-assignment.ts";
import extension from "../../extensions/task-context/index.js";
import { advanceWorkflow, defineWorkflow, phase, type Definition, type DynamicInput, type WorkflowRun } from "../../extensions/task-context/dynamic-workflow.js";
import { renderDynamic } from "../../extensions/task-context/dynamic-workflow-view.js";

const report: Definition = {
  objective: "Deliver the interview report", criteria: ["Both interviewees are represented"],
  steps: [
    { id: "one", title: "Interview buyer", stage: "Research", output: "Buyer notes" },
    { id: "two", title: "Interview seller", stage: "Research", output: "Seller notes" },
    { id: "draft", title: "Draft report", dependsOn: ["one", "two"], output: "Report" },
    { id: "review", title: "Review draft", dependsOn: ["draft"], output: "Findings or approval", review: { artifact: "draft", revision: "fix" } },
    { id: "fix", title: "Revise draft", output: "Updated report" },
    { id: "ship", title: "Deliver report", dependsOn: ["review"], output: "Delivery receipt" },
  ],
};
const action = (run: WorkflowRun, input: DynamicInput) => advanceWorkflow(run, { runId: run.id, revision: run.revision, ...input });
const submit = (run: WorkflowRun, step: string, result = step + " output") => action(run, { action: "submit", step, result });
const states = (run: WorkflowRun) => run.steps.map(s => phase(run, s));

test("two independent tasks join, then versioned review either ships directly or loops through revision", () => {
  const initial = defineWorkflow(report, []);
  assert.deepEqual(states(initial), ["ready", "ready", "waiting", "waiting", "standby", "waiting"]);
  const first = submit(initial, "two");
  assert.throws(() => submit(first, "draft"), /waiting/);
  assert.throws(() => advanceWorkflow(first, { action: "submit", runId: initial.id, revision: 1, step: "one", result: "notes" }), /changed/);
  const draft = submit(submit(first, "one"), "draft");
  const review = (run: WorkflowRun, version: number, verdict: "passed" | "changes_requested") =>
    action(run, { action: "submit", step: "review", artifactVersion: version, verdict, result: verdict === "passed" ? "Sources verified" : "Add the missing quote" });
  assert.equal(states(review(draft, 1, "passed")).at(-1), "ready");
  const changes = review(draft, 1, "changes_requested");
  assert.deepEqual(states(changes).slice(-3), ["waiting", "ready", "waiting"]);
  const revised = action(changes, { action: "submit", step: "fix", artifactVersion: 1, result: "Report with quote" });
  assert.throws(() => review(revised, 1, "passed"), /current artifact/);
  assert.throws(() => submit(revised, "ship"), /waiting/);
  const delivered = submit(review(revised, 2, "passed"), "ship");
  assert.deepEqual(delivered.history.filter(h => h.verdict).map(h => [h.version, h.verdict]), [[1, "changes_requested"], [2, "passed"]]);
  assert.throws(() => action(delivered, { action: "finish" }), /Missing objective/);
  assert.ok(action(delivered, { action: "finish", evidence: [{ criterion: report.criteria[0]!, result: "Report contains both attributed interviews" }] }).evidence);
  for (const width of [18, 100]) {
    const lines = renderDynamic(first, width, { fg: (_, s) => s }, false, {});
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    const all = lines.join(" ");
    assert.match(all, /Research/);
    assert.match(all, /↔/);
    assert.match(all, /one ○/);
    assert.match(all, /two ✓/);
    const expanded = renderDynamic(first, width, { fg: (_, s) => s }, true, {});
    assert.ok(expanded.length > lines.length);
  }
  assert.throws(() => defineWorkflow({ ...report, steps: report.steps.map(s => s.id === "fix" ? { ...s, dependsOn: ["ship"] } : s) }, []), /revision step/);
});

async function harness(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "dynamic-workflow-"));
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => { if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved; rmSync(dir, { recursive: true, force: true }); });
  const entries: any[] = [];
  const hooks = new Map<string, any>(), tools = new Map<string, any>(), commands = new Map<string, any>(), settings = new Map<string, any>();
  const events = new EventEmitter();
  events.on("harness-settings:register", c => settings.set(c.id, c));
  const messages: any[] = [];
  let active: string[] = [];
  const pi: any = { events, getActiveTools: () => active, setActiveTools: (a: string[]) => { active = a; },
    registerCommand: (n: string, c: any) => commands.set(n, c), registerTool: (c: any) => tools.set(c.name, c),
    on: (n: string, h: any) => hooks.set(n, h), sendMessage: (m: any) => messages.push(m), sendUserMessage: (m: any) => messages.push(m),
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }) };
  const ctx: any = { cwd: dir, hasUI: false, ui: { notify() {} }, sessionManager: { getBranch: () => entries, getSessionId: () => "test" } };
  extension(pi);
  await hooks.get("session_start")({}, ctx);
  t.after(() => hooks.get("session_shutdown")({}, ctx));
  const call = (n: string, input: any) => tools.get(n).execute("call", input, undefined, undefined, ctx);
  const start = () => commands.get("dynamic-workflow").handler("", ctx);
  const run = async (input: DynamicInput) => (await call("dynamic_workflow", input)).details.run as WorkflowRun;
  return { pi, ctx, hooks, entries, messages, settings, active: () => active, start, run, call, todo: async () => (await call("get_todo", {})).details.plan as WorkflowRun };
}
test("one-off activation, branch restore, dedicated owner and automatic modes share the command", async t => {
  const h = await harness(t);
  const control = h.settings.get("dynamic-workflow");
  assert.equal(control.get(), "off");
  await assert.rejects(h.run({ action: "define", definition: report }), /off/);
  for (const mode of ["off", "on", "adaptive"]) {
    control.change(mode);
    const fork = h.entries.length;
    if (mode !== "off") {
      const options = { sections: {} as Record<string, string> };
      h.hooks.get("before_agent_start")({ systemPrompt: "", systemPromptOptions: options }, h.ctx);
      assert.match(options.sections.dynamic_workflow!, mode === "adaptive" ? /single-action/ : /objective/);
      assert.equal((await h.run({ action: "define", definition: report })).objective, report.objective);
      h.entries.length = fork;
      await h.hooks.get("session_tree")({}, h.ctx);
    }
    await h.start();
    assert.equal(control.get(), mode);
    const accepted = await h.run({ action: "define", definition: report });
    await h.run({ action: "submit", step: "one", result: "Saved interview", runId: accepted.id, revision: 1 });
    await h.hooks.get("session_start")({}, h.ctx);
    const restored = await h.todo();
    assert.equal(restored.history[0]!.result, "Saved interview");
    assert.equal(states(restored)[0], "complete");
    h.entries.length = fork;
    await h.hooks.get("session_tree")({}, h.ctx);
    if (mode === "off") assert.ok(!h.active().includes("dynamic_workflow"));
  }
  h.pi.appendEntry("pi-better-workflow", { version: 1, kind: "set", owner: { name: "resolve-issues", planOwner: "workflow" } });
  const count = h.messages.length;
  await h.start();
  assert.equal(h.messages.length, count);
  await assert.rejects(h.run({ action: "define", definition: report }), /resolve-issues/);
});

test("catalog assignments use ordinary launch, record failures, and require verified output from the same run", async t => {
  const h = await harness(t);
  await h.start();
  const def = { ...report, steps: report.steps.map(s => s.id === "draft" ? { ...s, catalog: "role.writer" } : s) };
  const accepted = await h.run({ action: "define", definition: def });
  let launches = 0;
  const args = { workflow: { runId: accepted.id, step: "draft" }, role: "writer", prompt: "Compile interviews" };
  const spawn = (fails = false) => launchWorkflowAssignment(h.pi, captureLaunchContext(h.ctx), "spawn-" + launches, args, async p => {
    launches++;
    assert.equal(p.role, "writer");
    assert.equal("skills" in p, false);
    assert.equal("workflow" in p, false);
    assert.match(p.prompt, /buyer notes/);
    if (fails) throw new Error("Launch denied");
    return { details: { launched: true, runId: "worker-" + launches }, content: [] };
  });
  await assert.rejects(spawn(), /waiting/);
  assert.equal(launches, 0);
  const advance = async (input: DynamicInput) => {
    const curr = await h.todo();
    return h.run({ runId: curr.id, revision: curr.revision, ...input });
  };
  await advance({ action: "submit", step: "one", result: "buyer notes" });
  await advance({ action: "submit", step: "two", result: "seller notes" });
  assert.equal(states(await h.todo())[2], "failed");
  h.entries.push({ type: "message", message: { role: "toolResult", toolName: "agents_catalog",
    details: { view: { id: "role.writer", found: true, definitionValid: true, catalogLaunchable: true, skills: { effective: { mode: "explicit", paths: ["/skills/writing"] } } } } } });
  await advance({ action: "retry", step: "draft" });
  assert.deepEqual((await h.todo()).catalogChoices[0]!.skills, ["/skills/writing"]);
  const manual = (r: any) => { r.mode = "manual"; };
  h.pi.events.on("pi-better-subagents:delegation-mode-request", manual);
  await assert.rejects(spawn(), /manual/);
  h.pi.events.off("pi-better-subagents:delegation-mode-request", manual);
  await advance({ action: "retry", step: "draft" });
  await assert.rejects(spawn(true), /Launch denied/);
  assert.equal((await h.todo()).workers.draft!.error, "Launch denied");
  await advance({ action: "retry", step: "draft" });
  await spawn();
  await assert.rejects(spawn(), /working/);
  const observe = (id: string, state: string, verified: boolean) => h.hooks.get("tool_result")({
    toolName: "subagent_result", input: { id }, details: { assignment: { attemptId: id, state, verified, reason: state } }, content: [{ type: "text", text: "Full report" }],
  }, h.ctx);
  observe("worker-2", "failed", true);
  assert.equal(states(await h.todo())[2], "failed");
  await advance({ action: "retry", step: "draft" });
  await spawn();
  observe("foreign", "completed", true);
  observe("worker-3", "completed", false);
  await assert.rejects(advance({ action: "submit", step: "draft", result: "Report" }), /successful/);
  observe("worker-3", "completed", true);
  const done = await advance({ action: "submit", step: "draft", result: "Report" });
  assert.equal(done.history.at(-1)?.worker?.result, "Full report");
  assert.equal(states(done)[3], "ready");
});

test("Goal audit restores its bound run, requires objective evidence, and ignores standalone runs", async t => {
  const h = await harness(t);
  const goal = createGoalSnapshot("Deliver notes", null);
  h.pi.appendEntry("pi-better-goal", goalSetEntry(goal, "command"));
  const audit = () => requestTaskContext(h.pi, "audit", goal);
  await h.start();
  const def = { objective: goal.objective, criteria: ["Readable"], steps: [{ id: "notes", title: "Write notes", output: "notes.md" }] };
  const run = await h.run({ action: "define", definition: def });
  assert.equal(run.goalId, goal.goalId);
  assert.match(audit().openSteps!.join(" "), /Write notes/);
  const done = await h.run({ action: "submit", runId: run.id, revision: 1, step: "notes", result: "notes.md" });
  assert.match(audit().openSteps!.join(" "), /evidence/);
  await h.run({ action: "finish", runId: run.id, revision: done.revision, evidence: [{ criterion: "Readable", result: "Opened notes.md" }] });
  await h.hooks.get("session_start")({}, h.ctx);
  assert.deepEqual(audit().openSteps, []);
  assert.deepEqual(audit().doneWhen, ["Readable"]);
  await h.start();
  const standalone = await h.run({ action: "define", definition: { ...def, objective: "Prepare lunch" } });
  assert.equal(standalone.goalId, undefined);
  assert.deepEqual(audit().openSteps, []);
});
