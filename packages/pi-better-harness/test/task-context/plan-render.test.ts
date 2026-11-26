import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { replacePlan } from "../../extensions/task-context/plan-state.js";
import { renderCompactPlan } from "../../extensions/task-context/plan-render.js";
import { renderRushPlan, projectRushPlan, type RushPlan } from "../../extensions/task-context/workflow-plan.js";

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
  assert.match(folded.join("\n"), /◑ +#12 +Unit 12 +│/);
  assert.match(folded.join("\n"), /read-only handoff/);
  assert.match(folded[0]!, /10\/12 complete/);
  const expanded = renderRushPlan(workflow, 100, false, undefined, "rush-issues", true, true);
  assert.equal(expanded.filter((line) => /Unit \d/.test(line)).length, 12);
  assert.doesNotMatch(expanded.join("\n"), /\.\.\./);
});

test("compact plan rendering names blocked state and obeys width", () => {
  const plan = replacePlan(null, [
    { step: "Completed step", status: "completed" },
    { step: "A blocked step with a deliberately long description", status: "blocked" },
    { step: "Pending step", status: "pending" },
  ], undefined, 100);

  const compact = renderCompactPlan(plan, 28, theme);
  assert.ok(compact.some((line) => line.includes("blocked")));
  assert.ok(compact.every((line) => !line.startsWith("›")));
  assert.ok(compact.every((line) => visibleWidth(line) <= 28));
});

test("every user-facing todo view heads the checklist as todo", () => {
  const native = replacePlan(null, [
    { step: "Done", status: "completed" },
    { step: "Working", status: "in_progress" },
  ], undefined, 100);
  const views = [
    renderCompactPlan(native, 80, theme),
    renderCompactPlan(native, 80, theme, true),
  ];
  for (const lines of views) {
    assert.equal(lines[0], "todo  1/2 complete · 1 in progress");
    assert.doesNotMatch(lines.join("\n"), /\bplan\b/i, "the relocated runtime must not leak the old heading");
  }
  const workflow = rushFixture();
  assert.match(renderRushPlan(workflow, 80)[0]!, /^todo  \d+\/\d+ complete/);
  assert.equal(renderRushPlan(workflow, 80, true)[0], renderRushPlan(workflow, 80)[0]);
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

test("native and workflow plans share summary, colors and glyphs in the task list", () => {
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
  const tasks = b.slice(2).map(line => line.split("│")[0]!);
  const normalize = (line: string) => strip(line).trim().replace(/ +/g, " ");
  for (const [i, row] of workflow.issues.entries()) {
    const nativeRow = a[i + 1]!;
    const boundRow = tasks.find(line => line.includes(`#${row.id}`))!;
    assert.equal(normalize(boundRow).replace(`#${row.id}`, String(i + 1)), normalize(nativeRow).replace(/ (active|blocked)$/, ""));
    const styledTitle = nativeRow.match(new RegExp(`\\x1b\\[[0-9]+m${row.title}\\x1b\\[0m`))![0];
    assert.ok(boundRow.includes(styledTitle), row.title + " uses its status color");
  }
  assert.match(strip(b.join("\n")), /Implement 2\/4 ●1[^]*Review !1[^]*Ship 1\/4/);
  assert.doesNotMatch(b.join("\n"), /explore|combine|\bci\b|cicd/);
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
      ...renderCompactPlan(native, width, theme),
      ...renderRushPlan(workflow, width), ...renderRushPlan(workflow, width, true),
    ];
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `overflow at ${width}`);
    assert.ok(lines.every((line) => !line.includes("\n")));
  }
  assert.match(renderRushPlan(workflow, 28).join("\n"), /Implement 2\/4 ●1/);
});

test("workflow failures and unknown statuses never look active or completed", () => {
  const workflow = rushFixture();
  workflow.issues = ["failed", "blocked", "pending", "cancelled", "awaiting-approval"].map((status, index) => ({
    id: String(index), title: `Task ${index}`, stage: "review", status, dependsOn: [],
  }));
  const rendered = renderRushPlan(workflow, 100).join("\n");
  assert.match(rendered, /0\/4 complete · 1 blocked · 1 failed · 1 skipped · 1 unknown/);
  assert.match(rendered, /× +#0 +Task 0 +│/);
  assert.match(rendered, /\? +#4 +Task 4 +│/);
  assert.doesNotMatch(rendered, /active/);
});

test("workflow columns split the available cells equally and each task uses one row", () => {
  const workflow = rushFixture();
  workflow.issues = [
    { id: "1", title: "修复布局", stage: "review", status: "waiting-for-provider-".repeat(100), dependsOn: [] },
    { id: "2", title: "Next task", stage: "done", status: "in-flight", headSha: "abc", reviewedHead: "abc", dependsOn: [] },
  ];
  for (const width of [35, 36, 81, 100, 161, 240]) {
    for (const expanded of [false, true]) {
      const lines = renderRushPlan(workflow, width, false, undefined, "rush-issues", false, expanded);
      const first = lines.findIndex(line => line.includes("#1"));
      assert.ok(first >= 0);
      const rows = lines.slice(first, first + 2);
      assert.deepEqual(rows.map(line => line.split(" │ ")[0]!.trimEnd()), ["? #1 修复布局", "◑ #2 Next task"]);
      if (width >= 36) {
        for (const line of rows) {
          const divider = line.indexOf(" │ ");
          assert.ok(divider >= 0);
          const left = visibleWidth(line.slice(0, divider));
          const right = width - left - 3;
          assert.ok(Math.abs(left - right) <= 1, `width ${width}: ${left} and ${right} cells`);
        }
      }
    }
  }
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
  for (const lines of [compact, expanded, full]) {
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
  assert.match(rendered, /● +#1 +Building +│/);
  assert.match(rendered, /◐ +#2 +Implemented +│/);
  assert.match(rendered, /◑ +#3 +Reviewed +│/);
  assert.match(rendered, /✓\s+#4\s+Merged/);
  assert.match(rendered, /✓\s+#5\s+Pushed/, "a direct push with no PR fields is delivered");
  assert.match(renderRushPlan(workflow, 100, true).join("\n"), /done · in-flight · ci/);
});

test("stage headers aggregate every applicable issue, even when fleet entries disagree or rows are folded", () => {
  const workflow = rushFixture();
  const diagram = () => renderRushPlan(workflow, 160).slice(2, 5).join("\n");
  const unit = (id: string, fields: Partial<RushPlan["issues"][number]> = {}): RushPlan["issues"][number] => ({
    id, title: `Issue ${id}`, stage: "done", status: "in-flight", headSha: "abc", reviewedHead: "abc", delivery: "ci", dependsOn: [], ...fields,
  });
  workflow.fleet.implement = { status: "pending" };
  workflow.fleet.review = { status: "pending" };
  workflow.fleet.ci = { status: "succeeded" };
  workflow.issues = [unit("1", { status: "blocked" }), ...Array.from({ length: 6 }, (_, index) => unit(String(index + 2)))];
  assert.doesNotMatch(renderRushPlan(workflow, 100).join("\n"), /#1\s+Issue 1/, "the blocked issue is outside the row window");
  assert.match(diagram(), /Implement 7\/7 .*Review ✓7\/7 .*Ship !1 ●6/);
  const widgetHeader = (width: number) => renderRushPlan(workflow, width, false, undefined, "rush-issues", false, false, {
    disclosure: "▸", runtime: { status: "active", clock: "2:14" },
  })[0]!;
  for (const width of [40, 100]) {
    assert.match(widgetHeader(width), /^todo ▸  0\/7 complete(?: · ●)?\s+goal active  2:14$/);
  }

  workflow.issues[0] = unit("1", { status: "pending", stage: "pending", headSha: undefined, reviewedHead: undefined, delivery: undefined });
  assert.match(diagram(), /Implement 6\/7 .*Review ✓6\/7 .*Ship ●6/);

  workflow.issues = [unit("1", { headSha: "new" })];
  assert.match(diagram(), /Implement 1\/1 .*Review ●1 .*Ship ○\n/, "draft CI can run while the new HEAD awaits review");

  workflow.issues = [unit("1", { reviewedHead: undefined, delivery: "review", status: "failed" })];
  assert.match(diagram(), /Review ×1 .*Ship ○\n/);

  workflow.issues = [unit("1", { status: "succeeded", delivery: "merged" }), unit("2", { status: "cancelled" })];
  assert.match(diagram(), /Implement 1\/1 .*Review ✓1\/1 .*Ship 1\/1\n/);

  workflow.issues = [
    unit("1", { status: "succeeded", delivery: "merged", reviewedHead: undefined }),
    unit("2", { status: "succeeded", delivery: "merged", reviewedHead: "previous" }),
  ];
  assert.match(diagram(), /Implement 2\/2 .*Review \?2 .*Ship 2\/2/);
});

test("a review can return to fix and re-review before the unit ships", () => {
  const unit = { id: "1", title: "Deliver report", stage: "done", status: "in-flight", headSha: "a", delivery: "ci" };
  const diagram = (fields: Record<string, unknown>) => renderRushPlan(projectRushPlan({
    runId: "loop", planRevision: 1, units: [{ ...unit, ...fields }],
  }, "loop"), 160).slice(2, 5).join("\n");
  const open = [{ status: "open" }];
  assert.match(diagram({ worker: 1, workerKind: "review", fixRound: 1 }), /Review ●1 .*Ship ○\n[^]*Fix —/);
  assert.match(diagram({ reviewFindings: open }), /Review 1 open finding .*Ship ○\n[^]*Fix ○1/);
  assert.match(diagram({ worker: "", workerKind: "fix", reviewFindings: open }), /Fix ○1/);
  assert.match(diagram({ stage: "validate", worker: 0, workerKind: "fix", delivery: "building" }), /Implement 1\/1 .*Review ○ .*Ship ○\n[^]*Fix ●1/);
  assert.match(diagram({ stage: "diagnose", reviewedHead: "a", delivery: "building", status: "blocked" }),
    /Implement 1\/1 .*Review ✓1\/1 .*Ship !1/);
  assert.match(diagram({ worker: 0, workerKind: "fix", status: "blocked" }), /Fix !1/);
  assert.match(diagram({ headSha: "b", worker: 2, workerKind: "review", reviewFindings: open }), /Review ●1 .*Ship ○\n[^]*Fix ○1/);
  assert.match(diagram({ headSha: "b", reviewedHead: "b", worker: null, workerKind: "fix", reviewFindings: [{ status: "resolved" }] }),
    /Review ✓1\/1 .*Ship ●1\n[^]*Fix ✓1/);
  assert.match(diagram({ headSha: "c", reviewedHead: "b", worker: 3, workerKind: "fix" }), /Review ○ .*Ship ○\n[^]*Fix ●1/);
  assert.match(diagram({ headSha: "c", reviewedHead: "c", status: "succeeded", delivery: "merged", fixRound: 2 }),
    /Review ✓1\/1 .*Ship 1\/1\n[^]*Fix ✓1/);
  assert.match(diagram({ reviewedHead: "a", delivery: "review", fixRound: 1, reviewFindings: [{ status: "deferred" }] }),
    /Review ✓1\/1 .*Ship ●1\n[^]*Fix —/);
});

test("blocked validation uses the explicit delivery phase or the legacy fleet record", () => {
  const render = (fleet: Record<string, string>, delivery?: string) => renderRushPlan(projectRushPlan({
    runId: "legacy", planRevision: 1, fleet,
    units: [{ id: "1", title: "Deploy", stage: "validate", status: "blocked", delivery }],
  }, "legacy"), 160)[2]!;
  assert.match(render({ ci: "blocked", review: "succeeded" }), /Implement 1\/1 .*Review ✓1\/1 .*Ship !1/);
  assert.match(render({ review: "blocked" }, "ci"), /Implement 1\/1 .*Review ○ .*Ship !1/);
  assert.match(render({ review: "blocked" }), /Implement 1\/1 .*Review !1 .*Ship ○$/);
});

test("the default diagram connects fixes back to review and counts findings across live units", () => {
  const unit = { stage: "done", status: "in-flight", delivery: "ci", headSha: "a" };
  const findings = [{ status: "open" }, { status: "open" }, { status: "resolved" }, { status: "deferred" }];
  const plan = projectRushPlan({
    runId: "graph", planRevision: 1, units: [
      { ...unit, id: "1", title: "Report", worker: 0, workerKind: "fix", reviewFindings: findings },
      { ...unit, id: "2", title: "Dashboard", worker: 1, workerKind: "review" },
      { ...unit, id: "3", title: "Retired", status: "cancelled", reviewFindings: findings },
    ],
  }, "graph");
  const [top, middle, bottom] = renderRushPlan(plan, 160).slice(2, 5) as [string, string, string];
  assert.match(top, /#1 Report +│ Implement 2\/2 ─→ Review ●1 · 2 open findings .*┬ ─→ Ship ○$/);
  assert.match(middle, /#2 Dashboard +│/);
  assert.match(bottom, /Fix ●1/);
  assert.equal(top.indexOf("Review"), middle.indexOf("↑"));
  assert.equal(top.indexOf("Review"), bottom.indexOf("└"));
  assert.equal(top.indexOf("┬"), middle.lastIndexOf("│"));
  assert.equal(top.indexOf("┬"), bottom.indexOf("┘"));
  for (const width of [35, 36, 40]) {
    const lines = renderRushPlan(plan, width);
    const task = lines.findIndex(line => line.includes("#1 Report"));
    const graph = lines.findIndex(line => line.includes("Implement 2/2"));
    assert.ok(task >= 0 && graph >= 0);
    if (width >= 36) {
      assert.equal(task, graph);
      assert.match(lines[task]!, /#1 Report +│ Implement 2\/2/);
    } else {
      const lastTask = lines.findIndex(line => line.includes("#3 Retired"));
      assert.ok(lastTask > task && graph > lastTask);
      assert.doesNotMatch(lines[task]!, /│/);
    }
    assert.match(lines.join("\n"), /↺ Review/);
  }
  assert.match(renderRushPlan(plan, 24).join("\n"), /↺ Review/);
});

test("a code-done unit without a HEAD keeps the plain in-progress state", () => {
  const unit = projectRushPlan({
    runId: "r", planRevision: 1, fleet: {},
    units: [{ id: "1", title: "Older plan", stage: "done", status: "in-flight" }],
  }, "r");
  assert.match(renderRushPlan(unit, 100).join("\n"), /● +#1 +Older plan +│/);
  assert.equal(renderRushPlan(unit, 100)[0], "todo  0/1 complete · 1 in progress");
});

test("the workflow metadata shows the canary only when a unit carries warehouse canary work", () => {
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
  assert.match(data, /rev 3  ·  canary ○\n[^\n]*│ Implement ●1/);
  assert.doesNotMatch(header(raw()), /canary/);
  assert.doesNotMatch(header(raw(false)), /canary/);
  assert.doesNotMatch(header(raw({ required: false, reason: "does not change warehouse work" })), /canary/);
  assert.match(header(raw({ reason: "changes the settlement job", status: "succeeded" })), /canary ✓\n/);
  assert.match(header(raw({ reason: "changes the settlement job", status: "in-flight" })), /canary ●\n/);
  for (const marker of [true, { reason: "changes the settlement job" }]) {
    assert.match(header({ ...raw(marker), fleet: { canary: { status: "succeeded" } } }), /canary ✓/);
    assert.match(header({ ...raw(marker), fleet: { canary: "failed" } }), /canary ×/);
  }
  assert.match(header({ ...raw({ status: "pending" }), fleet: { canary: "succeeded" } }), /canary ○/);
  assert.match(header({ ...raw(), warehouseCanaryRequired: true }), /canary ○/, "the run-level flag still works");
});
