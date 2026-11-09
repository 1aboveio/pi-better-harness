import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { replacePlan } from "../../extensions/task-context/plan-state.js";
import { renderCompactPlan, renderFullPlan, createFullPlanComponent } from "../../extensions/task-context/plan-render.js";
import { renderRushPlan, createRushPlanComponent, projectRushPlan, type RushPlan } from "../../extensions/task-context/workflow-plan.js";

const theme = { fg: (_color: string, value: string) => value };

test("compact plan keeps a short checklist visible", () => {
  const plan = replacePlan(null, [
    { step: "One", status: "completed" },
    { step: "Two", status: "completed" },
    { step: "Three", status: "in_progress" },
    { step: "Four", status: "pending" },
    { step: "Five", status: "pending" },
  ], undefined, 100);

  const lines = renderCompactPlan(plan, 80, theme);
  assert.equal(lines[0], "todo  2/5 complete · 1 in progress");
  assert.deepEqual(lines.slice(1).map((line) => line.trim().replace(/ +/g, " ")), [
    "✓ 1 One",
    "✓ 2 Two",
    "● 3 Three active",
    "○ 4 Four",
    "○ 5 Five",
  ]);
  assert.notEqual(lines.at(-1), "", "the next widget owns its leading section gap");
  assert.match(lines[1]!, /^  ✓ 1 One/, "single-digit labels have one space before the title");
});

test("multi-digit item labels keep one fitted column and a single trailing separator", () => {
  const plan = replacePlan(null, Array.from({ length: 12 }, (_, index) => ({
    step: `Task ${index + 1}`, status: "pending" as const,
  })), undefined, 100);
  const rows = renderCompactPlan(plan, 80, theme, true);
  assert.match(rows[1]!, /^  ○ 1  Task 1$/);
  assert.match(rows[12]!, /^  ○ 12 Task 12$/);
  assert.equal(rows[1]!.indexOf("Task"), rows[12]!.indexOf("Task"));
});

test("compact plan follows progress from head to tail and expansion reveals omitted rows", () => {
  const make = (active: number) => replacePlan(null, Array.from({ length: 12 }, (_, index) => ({
    step: `Task ${index + 1}`, status: index < active ? "completed" as const : index === active ? "in_progress" as const : "pending" as const,
  })), undefined, 100);
  const titles = (lines: string[]) => lines.filter((line) => /Task \d/.test(line)).map((line) => line.match(/Task \d+/)![0]);
  assert.deepEqual(titles(renderCompactPlan(make(0), 100, theme)), ["Task 1", "Task 2", "Task 3", "Task 4", "Task 5"]);
  assert.deepEqual(titles(renderCompactPlan(make(6), 100, theme)), ["Task 5", "Task 6", "Task 7", "Task 8", "Task 9"]);
  const tail = renderCompactPlan(make(11), 100, theme);
  assert.deepEqual(titles(tail), ["Task 8", "Task 9", "Task 10", "Task 11", "Task 12"]);
  assert.match(tail.join("\n"), /\.\.\. 7 earlier steps/);
  assert.match(tail[0]!, /11\/12 complete/);
  assert.equal(titles(renderCompactPlan(make(6), 100, theme, true)).length, 12);
  assert.equal(titles(renderFullPlan(make(6), 100, theme)).length, 12);
  assert.deepEqual(titles(renderCompactPlan(make(12), 100, theme)), ["Task 8", "Task 9", "Task 10", "Task 11", "Task 12"]);
});

test("omitted single steps use singular labels on either side of the window", () => {
  const make = (active: number) => replacePlan(null, Array.from({ length: 7 }, (_, index) => ({
    step: `Task ${index + 1}`, status: index < active ? "completed" as const : index === active ? "in_progress" as const : "pending" as const,
  })), undefined, 100);
  const middle = renderCompactPlan(make(3), 80, theme);
  assert.match(middle.join("\n"), /\.\.\. 1 earlier step\n/);
  assert.match(middle.at(-1)!, /\.\.\. 1 more step$/);
  assert.match(renderCompactPlan(make(0), 80, theme).at(-1)!, /\.\.\. 2 more steps$/);
});

test("compact plan retains scattered active steps and caps concurrent activity at the latest five", () => {
  const make = (active: number[]) => replacePlan(null, Array.from({ length: 12 }, (_, index) => ({
    step: `Task ${index + 1}`, status: active.includes(index) ? "in_progress" as const : "pending" as const,
  })), undefined, 100);
  const scattered = renderCompactPlan(make([0, 6, 11]), 100, theme);
  for (const id of [1, 7, 12]) assert.match(scattered.join("\n"), new RegExp(`Task ${id} +active`));
  assert.equal(scattered.filter((line) => /Task \d/.test(line)).length, 5);
  const concurrent = renderCompactPlan(make([0, 2, 4, 6, 8, 10]), 100, theme);
  assert.doesNotMatch(concurrent.join("\n"), /Task 1 +active/);
  assert.deepEqual(concurrent.filter((line) => /Task \d/.test(line)).map((line) => line.match(/Task \d+/)![0]),
    ["Task 3", "Task 5", "Task 7", "Task 9", "Task 11"]);
  assert.match(concurrent[0]!, /6 in progress/);
  for (const width of [1, 8, 28, 80]) assert.ok(renderCompactPlan(make([0, 6, 11]), width, theme).every((line) => visibleWidth(line) <= width));
});

test("idle and blocked plans focus the next pending work or latest blocker", () => {
  for (const [statuses, expected] of [
    [Array.from({ length: 10 }, () => "pending" as const), [1, 2, 3, 4, 5]],
    [Array.from({ length: 10 }, (_, index) => index < 8 ? "completed" as const : "pending" as const), [6, 7, 8, 9, 10]],
    [Array.from({ length: 10 }, (_, index) => index === 8 ? "blocked" as const : "pending" as const), [6, 7, 8, 9, 10]],
  ] as const) {
    const plan = replacePlan(null, statuses.map((status, index) => ({ step: `Task ${index + 1}`, status })), undefined, 100);
    const actual = renderCompactPlan(plan, 100, theme).flatMap((line) => {
      const match = line.match(/Task (\d+)/);
      return match ? [Number(match[1])] : [];
    });
    assert.deepEqual(actual, expected);
  }
});

test("long workflow and read-only handoff views use the same five-row window and expand fully", () => {
  const workflow = rushFixture();
  workflow.issues = Array.from({ length: 12 }, (_, index) => ({
    id: String(index + 1), title: `Unit ${index + 1}`, stage: "done", status: index < 10 ? "succeeded" : "in-flight",
    dependsOn: [], headSha: "abc", reviewedHead: "abc",
  }));
  const folded = renderRushPlan(workflow, 100, false, undefined, "rush-issues", true);
  assert.equal(folded.filter((line) => /Unit \d/.test(line)).length, 5);
  assert.match(folded.join("\n"), /Unit 12 +review passed/);
  assert.match(folded.join("\n"), /read-only handoff/);
  assert.match(folded[0]!, /10\/12 complete/);
  const expanded = renderRushPlan(workflow, 100, false, undefined, "rush-issues", true, true);
  assert.equal(expanded.filter((line) => /Unit \d/.test(line)).length, 12);
  assert.doesNotMatch(expanded.join("\n"), /\.\.\./);
});

test("compact and full plan rendering name blocked state and obey width", () => {
  const plan = replacePlan(null, [
    { step: "Completed step", status: "completed" },
    { step: "A blocked step with a deliberately long description", status: "blocked" },
    { step: "Pending step", status: "pending" },
  ], undefined, 100);

  const compact = renderCompactPlan(plan, 28, theme);
  assert.ok(compact.some((line) => line.includes("blocked")));
  assert.ok(compact.every((line) => !line.startsWith("›")));
  assert.ok([...compact, ...renderFullPlan(plan, 28, theme, 1)].every((line) => visibleWidth(line) <= 28));
});

test("every user-facing todo view heads the checklist as todo", () => {
  const native = replacePlan(null, [
    { step: "Done", status: "completed" },
    { step: "Working", status: "in_progress" },
  ], undefined, 100);
  const views = [
    renderCompactPlan(native, 80, theme),
    renderCompactPlan(native, 80, theme, true),
    renderFullPlan(native, 80, theme),
    createFullPlanComponent(native, theme, () => {}).render(80),
  ];
  for (const lines of views) {
    assert.equal(lines[0], "todo  1/2 complete · 1 in progress");
    assert.doesNotMatch(lines.join("\n"), /\bplan\b/i, "the relocated runtime must not leak the old heading");
  }
  const workflow = rushFixture();
  assert.match(renderRushPlan(workflow, 80)[0]!, /^todo  \d+\/\d+ complete/);
  assert.equal(renderRushPlan(workflow, 80, true)[0], renderRushPlan(workflow, 80)[0]);
});

test("the full view names steps by id and shows prerequisite edges inside the width", () => {
  const plan = replacePlan(null, [
    { id: "step_1", step: "Inspect the terminal", status: "completed" },
    { id: "step_2", step: "中文任务验证长标签不会重叠并保持完整内容ABCDEFGHIJKLMN", status: "in_progress", dependsOn: ["step_1"] },
    { id: "step_3", step: "Verify the terminal journey", status: "pending", dependsOn: ["step_1", "step_2"] },
  ], undefined, 100);

  const compact = renderCompactPlan(plan, 80, theme).join("\n");
  assert.match(compact, /●\s+2\s+(?=中文)/, "the compact widget keeps its stable ordinals");
  assert.doesNotMatch(compact, /after:/, "edges stay out of the folded widget");

  const full = renderFullPlan(plan, 80, theme, 1).join("\n");
  assert.match(full, /^\u203a ●\s+step_2/m);
  assert.match(full, /after: step_1$/m);
  assert.match(full, /after: step_1, step_2/);
  assert.ok(full.replace(/\s/g, "").includes("中文任务验证长标签不会重叠并保持完整内容ABCDEFGHIJKLMN"), "long CJK titles keep their content");

  const component = createFullPlanComponent(plan, theme, () => {}).render(80).join("\n");
  assert.match(component, /^\u203a ●\s+step_2/m, "the fullscreen view starts on the active step id");
  assert.match(component, /after: step_1/);

  for (const width of [1, 2, 8, 16, 28, 40, 80]) {
    const lines = [
      ...renderCompactPlan(plan, width, theme), ...renderCompactPlan(plan, width, theme, true),
      ...renderFullPlan(plan, width, theme, 0), ...createFullPlanComponent(plan, theme, () => {}).render(width),
    ];
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `overflow at ${width}`);
  }
});

function rushFixture(): RushPlan {
  return {
    runId: "style", planRevision: 2, warehouseCanaryRequired: false,
    fleet: { explore: { status: "succeeded" }, implement: { status: "in-flight" } },
    issues: [
      { id: "863", title: "Completed", stage: "done", status: "succeeded", dependsOn: [] },
      { id: "864", title: "Implement", stage: "build", status: "in-flight", worker: 0, dependsOn: ["863"], note: "Keep the evidence" },
      { id: "866", title: "Pending", stage: "pending", status: "pending", dependsOn: [] },
      { id: "865", title: "Policy", stage: "review", status: "blocked", dependsOn: [] },
    ],
  };
}

test("native and workflow plans share summary, colors and glyphs with fitted label columns", () => {
  const workflow = rushFixture();
  const native = replacePlan(null, [
    { step: "Completed", status: "completed" },
    { step: "Implement", status: "in_progress" },
    { step: "Pending", status: "pending" },
    { step: "Policy", status: "blocked" },
  ], undefined, 100);
  const ansiTheme = { fg: (color: string, value: string) => `\x1b[${({ warning: 33, accent: 36, success: 32, dim: 90, muted: 37, text: 97 } as Record<string, number>)[color] ?? 31}m${value}\x1b[0m` };
  const a = renderCompactPlan(native, 100, ansiTheme);
  const b = renderRushPlan(workflow, 100, false, ansiTheme.fg);
  assert.equal(a[0], b[0]);
  const strip = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");
  for (const title of ["Completed", "Implement", "Pending", "Policy"]) {
    const left = a.find((line) => line.includes(title))!;
    const right = b.find((line) => line.includes(title))!;
    assert.equal(strip(left).indexOf(title), 6, "one-digit native labels do not reserve unused columns");
    assert.equal(strip(right).indexOf(title), 9, "four-character issue labels have one trailing space");
    assert.equal(strip(right).trim().replace(/#\d+/g, (id) => String(workflow.issues.findIndex((unit) => `#${unit.id}` === id) + 1)).replace(/ +/g, " "), strip(left).trim().replace(/ +/g, " "));
    assert.equal(right.slice(0, right.indexOf(" ", 3)), left.slice(0, left.indexOf(" ", 3)));
  }
  assert.match(b.join("\n"), /explore ✓/);
  assert.match(b.join("\n"), /implement ●/);
  assert.doesNotMatch(b.join("\n"), /combine|cicd/);
  assert.doesNotMatch(b.join("\n"), /canary/, "no data work, no canary cell");
  assert.notEqual(b.at(-1), "");
  const full = renderRushPlan(workflow, 100, true).join("\n");
  assert.match(full, /build · in-flight · worker 0/);
  assert.match(full, /after: #863/);
  assert.match(full, /Keep the evidence/);
});

test("Unicode and narrow terminals keep every row within its cell budget", () => {
  const workflow = rushFixture();
  workflow.spec = { title: "中文计划 👩‍💻 e\u0301" };
  workflow.issues[1]!.title = "修复中文布局 👩‍💻 e\u0301 ".repeat(12);
  workflow.issues[1]!.note = "证据：每个字符都保留";
  const native = replacePlan(null, [{ step: workflow.issues[1]!.title, status: "blocked" }], undefined, 100);
  for (const width of [1, 2, 8, 16, 28, 40, 80, 100, 160]) {
    const lines = [
      ...renderCompactPlan(native, width, theme), ...renderFullPlan(native, width, theme, 0),
      ...renderRushPlan(workflow, width), ...renderRushPlan(workflow, width, true),
    ];
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `overflow at ${width}`);
    assert.ok(lines.every((line) => !line.includes("\n")));
  }
  assert.match(renderRushPlan(workflow, 28).join("\n"), /active/);
});

test("workflow failures and unknown statuses never look active or completed", () => {
  const workflow = rushFixture();
  workflow.issues = ["failed", "blocked", "pending", "cancelled", "awaiting-approval"].map((status, index) => ({
    id: String(index), title: `Task ${index}`, stage: "review", status, dependsOn: [],
  }));
  const rendered = renderRushPlan(workflow, 100).join("\n");
  assert.match(rendered, /0\/4 complete · 1 blocked · 1 failed · 1 skipped · 1 unknown/);
  assert.match(rendered, /×\s+#0\s+Task 0\s+failed/);
  assert.match(rendered, /\?\s+#4\s+Task 4\s+awaiting-approval/);
  assert.doesNotMatch(rendered, /active/);
});

test("workflow completion counts exclude cancellation spellings but retain skipped and other unfinished rows", () => {
  const statuses = [
    "succeeded", "completed", "pending", "in-flight", "blocked", "failed",
    "skipped", "not-applicable", "awaiting-approval", "cancelled", "canceled",
  ];
  const workflow = projectRushPlan({
    runId: "counts", planRevision: 1, fleet: {},
    units: statuses.map((status, index) => ({
      id: String(index + 1), title: `Unit ${index + 1}`, stage: "done", status,
    })),
  }, "counts");
  const compact = renderRushPlan(workflow, 160);
  const expanded = renderRushPlan(workflow, 160, false, undefined, "rush-issues", false, true);
  const full = renderRushPlan(workflow, 160, true);
  const component = createRushPlanComponent(workflow, () => {}).render(160);
  for (const lines of [compact, expanded, full, component]) {
    assert.match(lines[0]!, /\b2\/9 complete\b/);
  }
  assert.doesNotMatch(compact.join("\n"), /Unit 10|Unit 11/, "hidden cancellations still affect the total");
  for (const [id, status] of [[7, "skipped"], [8, "skipped"], [10, "cancelled"], [11, "canceled"]] as const) {
    assert.match(full.join("\n"), new RegExp(`#${id}\\s+Unit ${id}\\s+${status}\\n`));
  }
});

test("all-canceled workflow plans show zero eligible items without counting cancellations as completed", () => {
  for (const statuses of [["cancelled"], ["canceled"], ["cancelled", "canceled"]]) {
    const workflow = projectRushPlan({
      runId: "canceled", planRevision: 1, fleet: {},
      issues: statuses.map((status, index) => ({
        id: String(index), title: `Canceled unit ${index}`, stage: "done", status,
      })),
    }, "canceled");
    const lines = renderRushPlan(workflow, 100, true);
    assert.match(lines[0]!, /\b0\/0 complete\b/);
    assert.equal(lines.filter((line) => line.includes("Canceled unit")).length, statuses.length);
  }
});

test("workflow summaries handle concurrent activity, idle, complete and empty plans", () => {
  const workflow = rushFixture();
  workflow.issues[2]!.status = "diagnosing";
  assert.equal(renderRushPlan(workflow, 100)[0], "todo  1/4 complete · 2 in progress · 1 blocked");
  assert.match(renderRushPlan(workflow, 100, true).join("\n"), /pending · diagnosing/);
  for (const unit of workflow.issues) unit.status = "pending";
  assert.equal(renderRushPlan(workflow, 100)[0], "todo  0/4 complete · 4 pending");
  for (const unit of workflow.issues) unit.status = "succeeded";
  assert.equal(renderRushPlan(workflow, 100)[0], "todo  4/4 complete");
  workflow.issues = [];
  assert.equal(renderRushPlan(workflow, 100)[0], "todo  0/0 complete");
});

test("issue rows show implemented, review passed and delivered as distinct states", () => {
  const workflow = rushFixture();
  workflow.issues = [
    { id: "1", title: "Building", stage: "validate", status: "in-flight", dependsOn: [] },
    { id: "2", title: "Implemented", stage: "done", status: "in-flight", headSha: "aaa", reviewedHead: "old", delivery: "review", dependsOn: [] },
    { id: "3", title: "Reviewed", stage: "done", status: "in-flight", headSha: "bbb", reviewedHead: "bbb", delivery: "ci", dependsOn: [] },
    { id: "4", title: "Merged", stage: "done", status: "succeeded", headSha: "ccc", reviewedHead: "ccc", delivery: "merged", dependsOn: [] },
    { id: "5", title: "Pushed", stage: "done", status: "succeeded", dependsOn: [] },
  ];
  const rendered = renderRushPlan(workflow, 100).join("\n");
  assert.equal(renderRushPlan(workflow, 100)[0], "todo  2/5 complete · 1 in progress · 1 implemented · 1 review passed");
  assert.match(rendered, /●\s+#1\s+Building\s+active/);
  assert.match(rendered, /◐\s+#2\s+Implemented\s+implemented/);
  assert.match(rendered, /◑\s+#3\s+Reviewed\s+review passed/);
  assert.match(rendered, /✓\s+#4\s+Merged/);
  assert.match(rendered, /✓\s+#5\s+Pushed/, "a direct push with no PR fields is delivered");
  assert.match(renderRushPlan(workflow, 100, true).join("\n"), /done · in-flight · ci/);
});

test("a code-done unit without a HEAD keeps the plain in-progress state", () => {
  const unit = projectRushPlan({
    runId: "r", planRevision: 1, fleet: {},
    units: [{ id: "1", title: "Older plan", stage: "done", status: "in-flight" }],
  }, "r");
  assert.match(renderRushPlan(unit, 100).join("\n"), /●\s+#1\s+Older plan\s+active/);
  assert.equal(renderRushPlan(unit, 100)[0], "todo  0/1 complete · 1 in progress");
});

test("both full components use the same selection and return keys", () => {
  const native = replacePlan(null, [{ step: "Done", status: "completed" }, { step: "Working", status: "in_progress" }], undefined, 100);
  let closed = 0;
  for (const component of [
    createFullPlanComponent(native, theme, () => closed++),
    createRushPlanComponent(rushFixture(), () => closed++),
  ]) {
    assert.match(component.render(100).join("\n"), /^› ●/m);
    component.handleInput?.("\x1b[A");
    assert.match(component.render(100).join("\n"), /^› ✓/m);
    component.handleInput?.("\x1b[D");
  }
  assert.equal(closed, 2);
});
test("the canary cell shows, last, only when a unit carries warehouse canary work", () => {
  const raw = (warehouseCanary?: unknown) => ({
    runId: "canary", planRevision: 3,
    fleet: { explore: "succeeded", implement: "in-flight", canary: "pending" },
    units: [
      { id: "1", title: "Data job", stage: "implement", status: "in-flight", ...(warehouseCanary === undefined ? {} : { warehouseCanary }) },
      { id: "2", title: "UI", stage: "pending", status: "pending" },
    ],
  });
  const header = (data: unknown) => renderRushPlan(projectRushPlan(data, "canary"), 120, false).join("\n");
  const data = header(raw({ reason: "changes the settlement job", result: null }));
  assert.match(data, /explore ✓\s+implement ●\s+review ○\s+ci ○\s+canary ○/);
  assert.doesNotMatch(header(raw()), /canary/);
  assert.doesNotMatch(header(raw(false)), /canary/);
  assert.match(header({ ...raw(), warehouseCanaryRequired: true }), /canary ○/, "the run-level flag still works");
});
