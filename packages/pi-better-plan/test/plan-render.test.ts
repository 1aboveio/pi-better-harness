import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { replacePlan } from "../src/plan-state.js";
import { renderCompactPlan, renderFullPlan } from "../src/plan-render.js";

const theme = { fg: (_color: string, value: string) => value };

test("compact plan keeps a three-step context window around active work", () => {
  const plan = replacePlan(null, [
    { step: "One", status: "completed" },
    { step: "Two", status: "completed" },
    { step: "Three", status: "in_progress" },
    { step: "Four", status: "pending" },
    { step: "Five", status: "pending" },
  ], undefined, 100);

  const lines = renderCompactPlan(plan, 80, theme);
  assert.match(lines[0] ?? "", /plan 2\/5 steps · in progress/);
  assert.deepEqual(lines.slice(1, 4).map((line) => line.trim()), ["✓ 2  Two", "● 3  Three", "○ 4  Four"]);
  assert.equal(lines.at(-1), "");
});

test("compact and full plan rendering name blocked state and obey width", () => {
  const plan = replacePlan(null, [
    { step: "Completed step", status: "completed" },
    { step: "A blocked step with a deliberately long description", status: "blocked" },
    { step: "Pending step", status: "pending" },
  ], undefined, 100);

  const compact = renderCompactPlan(plan, 28, theme, { focused: true, selectedIndex: 1 });
  assert.ok(compact.some((line) => line.includes("BLOCKED")));
  assert.ok(compact.some((line) => line.startsWith("› !")));
  assert.ok([...compact, ...renderFullPlan(plan, 28, theme, 1)].every((line) => visibleWidth(line) <= 28));
});