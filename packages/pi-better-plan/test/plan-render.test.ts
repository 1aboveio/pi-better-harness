import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { replacePlan } from "../src/plan-state.js";
import { renderCompactPlan, renderFullPlan, createFullPlanComponent } from "../src/plan-render.js";
import { renderRushPlan, createRushPlanComponent, type RushPlan } from "../src/workflow-plan.js";

const theme = { fg: (_color: string, value: string) => value };

test("compact plan keeps the complete checklist visible", () => {
  const plan = replacePlan(null, [
    { step: "One", status: "completed" },
    { step: "Two", status: "completed" },
    { step: "Three", status: "in_progress" },
    { step: "Four", status: "pending" },
    { step: "Five", status: "pending" },
  ], undefined, 100);

  const lines = renderCompactPlan(plan, 80, theme);
  assert.equal(lines[0], "plan  2/5 complete · 1 in progress");
  assert.deepEqual(lines.slice(1).map((line) => line.trim().replace(/ +/g, " ")), [
    "✓ 1 One",
    "✓ 2 Two",
    "● 3 Three active",
    "○ 4 Four",
    "○ 5 Five",
  ]);
  assert.notEqual(lines.at(-1), "", "the next widget owns its leading section gap");
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

function rushFixture(): RushPlan {
  return {
    runId: "style", planRevision: 2, warehouseCanaryRequired: false,
    fleet: { explore: { status: "succeeded" }, combine: { status: "in-flight" } },
    issues: [
      { id: "863", title: "Completed", stage: "done", status: "succeeded", dependsOn: [] },
      { id: "864", title: "Implement", stage: "build", status: "in-flight", worker: 0, dependsOn: ["863"], note: "Keep the evidence" },
      { id: "866", title: "Pending", stage: "pending", status: "pending", dependsOn: [] },
      { id: "865", title: "Policy", stage: "review", status: "blocked", dependsOn: [] },
    ],
  };
}

test("native and workflow plans share summary, colors, glyphs and title columns", () => {
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
    assert.equal(strip(left).indexOf(title), strip(right).indexOf(title));
    assert.equal(strip(right).replace(/#\d+/g, (id) => String(workflow.issues.findIndex((unit) => `#${unit.id}` === id) + 1).padEnd(4)), strip(left));
    assert.equal(right.slice(0, right.indexOf(" ", 3)), left.slice(0, left.indexOf(" ", 3)));
  }
  assert.match(b.join("\n"), /explore ✓/);
  assert.match(b.join("\n"), /canary —/);
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
  assert.match(rendered, /0\/5 complete · 1 blocked · 1 failed · 1 skipped · 1 unknown/);
  assert.match(rendered, /×\s+#0\s+Task 0\s+failed/);
  assert.match(rendered, /\?\s+#4\s+Task 4\s+awaiting-approval/);
  assert.doesNotMatch(rendered, /active/);
});

test("workflow summaries handle concurrent activity, idle, complete and empty plans", () => {
  const workflow = rushFixture();
  workflow.issues[2]!.status = "diagnosing";
  assert.equal(renderRushPlan(workflow, 100)[0], "plan  1/4 complete · 2 in progress · 1 blocked");
  assert.match(renderRushPlan(workflow, 100, true).join("\n"), /pending · diagnosing/);
  for (const unit of workflow.issues) unit.status = "pending";
  assert.equal(renderRushPlan(workflow, 100)[0], "plan  0/4 complete · 4 pending");
  for (const unit of workflow.issues) unit.status = "succeeded";
  assert.equal(renderRushPlan(workflow, 100)[0], "plan  4/4 complete");
  workflow.issues = [];
  assert.equal(renderRushPlan(workflow, 100)[0], "plan  0/0 complete");
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