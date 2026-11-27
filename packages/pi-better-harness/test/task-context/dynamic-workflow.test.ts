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
import { renderDynamic, renderDynamicFrame } from "../../extensions/task-context/dynamic-workflow-view.js";
import { createPlanWidget } from "../../extensions/task-context/plan-widget.js";

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
    assert.match(all, /↺|┬/);
    assert.match(all, /○1/);
    assert.match(all, /✓1/);
    const expanded = renderDynamic(first, width, { fg: (_, s) => s }, true, {});
    assert.match(lines.join("\n"), /… 1 more/);
    assert.doesNotMatch(expanded.join("\n"), /… 1 more/);
    for (const step of report.steps) assert.ok(expanded.some(line => line.includes(step.title)));
    assert.doesNotMatch(all, /\b(?:ready|waiting|standby|complete|working)\b/);
  }
  assert.throws(() => defineWorkflow({ ...report, steps: report.steps.map(s => s.id === "fix" ? { ...s, dependsOn: ["ship"] } : s) }, []), /revision step/);
});

test("independent stages retain their individual edges at a join", () => {
  const steps = report.steps.slice(0, 3).map(s => ({ ...s, stage: undefined }));
  const run = defineWorkflow({ ...report, steps }, []);
  const graph = renderDynamic(run, 140, { fg: (_, text) => text }, false, {}).join("\n");
  assert.match(graph, /○ Interview buyer/);
  assert.match(graph, /○ Interview seller/);
  assert.match(graph, /Interview buyer \+ Interview seller → · Draft report/);
});

test("a task click selects its diagram node in terminal cells without folding the list", () => {
  const run = defineWorkflow({ ...report, steps: report.steps.map(s => s.id === "draft" ? { ...s, title: "整理访谈记录", stage: "Draft" } : s) }, []);
  const theme = { fg: (_: string, text: string) => text, underline: (text: string) => "\x1b[4m" + text + "\x1b[24m" };
  let selected: string | undefined;
  let frame: ReturnType<typeof renderDynamicFrame>;
  const widget = createPlanWidget(width => {
    frame = renderDynamicFrame(run, width, theme, false, {}, selected);
    return frame.lines;
  }, () => false, () => false, () => assert.fail("a task click toggled disclosure"), (x, y) => {
    const id = frame.stepAt(x, y);
    return id ? () => { selected = id; } : undefined;
  });
  for (const width of [18, 35, 36, 61, 110, 161]) {
    const lines = widget.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    const y = lines.findIndex(line => line.includes("整理"));
    assert.ok(y > 0, lines.join("\n"));
    const click = { type: "click", button: "left", x: 2, y, width };
    if (width >= 36) {
      const leftWidth = Math.floor((width - 3) / 2);
      const divider = lines[y]!.indexOf(" │ ");
      assert.ok(divider >= 0);
      assert.equal(visibleWidth(lines[y]!.slice(0, divider)), leftWidth);
      click.x = leftWidth - 1;
      assert.equal(widget.handleMouse({ ...click, x: leftWidth }), undefined);
      assert.equal(widget.handleMouse({ ...click, x: width - 1 }), undefined);
    }
    assert.deepEqual(widget.handleMouse({ ...click, type: "press" }), { handled: true, render: false });
    assert.equal(selected, undefined);
    assert.deepEqual(widget.handleMouse(click), { handled: true, render: true });
    assert.equal(selected, "draft");
    const highlighted = widget.render(width).join("\n");
    assert.match(highlighted, /\x1b\[4m· Draft\x1b\[24m/);
    assert.match(highlighted, /draft · /);
    if (width >= 36) assert.match(highlighted, /Required: Report/);
    selected = undefined;
    widget.invalidate();
    assert.equal(widget.handleMouse(click), undefined);
  }
});

test("dragging the divider previews the split and saves it once on release", () => {
  const run = defineWorkflow(report, []);
  const saved: number[] = [];
  let frame!: ReturnType<typeof renderDynamicFrame>;
  const widget = createPlanWidget((width, _, preview) => {
    frame = renderDynamicFrame(run, width, { fg: (_color, text) => text }, false, {}, undefined, preview ?? saved.at(-1));
    return frame.lines;
  }, () => true, () => false, () => assert.fail("divider toggled the list"), undefined, {
    resizeAt: (x, y) => frame.resizeAt(x, y), save: share => saved.push(share),
  });
  const dividerX = (row: string) => visibleWidth(row.slice(0, row.indexOf(" │ "))) + 1;
  const width = 100;
  const rows = widget.render(width);
  const y = rows.findIndex(line => line.includes(" │ "));
  const x = dividerX(rows[y]!);
  const mouse = (type: string, at: number) => widget.handleMouse({ type, x: at, y, width, button: "left" });
  mouse("press", x);
  mouse("release", x);
  mouse("click", x);
  assert.deepEqual(saved, []);

  assert.equal(mouse("press", x)?.capture, true);
  for (const [at, expected] of [[-50, 13], [200, 86], [38, 38]] as const) {
    mouse("drag", at);
    assert.equal(dividerX(widget.render(width)[y]!), expected);
    assert.deepEqual(saved, []);
  }
  mouse("release", 38);
  assert.deepEqual(saved, [37 / 97]);
  assert.equal(dividerX(widget.render(width)[y]!), 38);
  assert.equal(frame.resizeAt(38, 0), undefined);
  assert.equal(widget.render(35).some(line => line.includes(" │ ")), false);
  assert.equal(frame.resizeAt(12, y), undefined);
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
  const observe = (id: string, state: string, verified: boolean, hasFinalAnswer = true) => h.hooks.get("tool_result")({
    toolName: "subagent_result", input: { id }, details: { hasFinalAnswer, assignment: { attemptId: id, state, verified, reason: state } }, content: [{ type: "text", text: "Full report" }],
  }, h.ctx);
  observe("worker-2", "failed", true);
  assert.equal(states(await h.todo())[2], "failed");
  await advance({ action: "retry", step: "draft" });
  await spawn();
  observe("foreign", "completed", true);
  observe("worker-3", "completed", false);
  await assert.rejects(advance({ action: "submit", step: "draft", result: "Report" }), /successful/);
  observe("worker-3", "completed", true, false);
  assert.match((await h.todo()).workers.draft!.error!, /without returning/);
  await advance({ action: "retry", step: "draft" });
  await spawn();
  observe("worker-4", "completed", true);
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
