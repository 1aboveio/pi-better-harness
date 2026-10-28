import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { replacePlan } from "../../extensions/task-context/plan-state.js";
import { renderCompactPlan } from "../../extensions/task-context/plan-render.js";
import { createPlanWidget } from "../../extensions/task-context/plan-widget.js";

test("plain left clicks unfold and fold the real plan render without capturing editor keys", () => {
  const plan = replacePlan(null, Array.from({ length: 9 }, (_, index) => ({ step: `Task ${index + 1}`, status: "pending" })), undefined, 100);
  let expanded = false;
  const widget = createPlanWidget((width) => renderCompactPlan(plan, width, { fg: (_color, text) => text }, expanded),
    () => true, () => expanded, () => { expanded = !expanded; });
  const click = { type: "click", button: "left", x: 3, y: 1, width: 100 };
  assert.equal(widget.render(100).filter((line) => line.includes("Task ")).length, 5);
  assert.equal(widget.handleInput, undefined);
  for (const event of [
    { ...click, type: "wheel" }, { ...click, type: "drag" },
    { ...click, button: "right" }, { ...click, shift: true }, { ...click, alt: true }, { ...click, ctrl: true },
    { ...click, y: 0 }, { ...click, y: 100 }, { ...click, x: -1 },
  ]) assert.equal(widget.handleMouse(event), undefined);
  assert.equal(expanded, false);
  assert.deepEqual(widget.handleMouse({ ...click, type: "press" }), { handled: true, render: false });
  assert.equal(expanded, false, "a press registers the click target but must not toggle");
  assert.deepEqual(widget.handleMouse(click), { handled: true, render: true });
  assert.equal(widget.render(100).filter((line) => line.includes("Task ")).length, 9);
  widget.handleMouse({ ...click, y: 5 });
  assert.equal(widget.render(100).filter((line) => line.includes("Task ")).length, 5);
  widget.invalidate();
  assert.equal(widget.handleMouse(click), undefined, "invalidated bounds cannot toggle an invisible widget");
});

test("the folded widget heads the section as todo and keeps the caret inside 80 columns", () => {
  const plan = replacePlan(null, Array.from({ length: 9 }, (_, index) => ({ step: `Task ${index + 1}`, status: "pending" })), undefined, 100);
  let expanded = false;
  const widget = createPlanWidget((width) => renderCompactPlan(plan, width, { fg: (_color, text) => text }, expanded),
    () => true, () => expanded, () => { expanded = !expanded; });
  const folded = widget.render(80);
  assert.equal(folded[0], "", "the section keeps its leading gap");
  assert.equal(folded[1], "\u25b8 todo  0/9 complete · 9 pending", "the fold caret and heading share one row");
  assert.doesNotMatch(folded.join("\n"), /\bplan\b/i);
  assert.ok(folded.every((line) => visibleWidth(line) <= 80));
  widget.handleMouse({ type: "click", button: "left", x: 3, y: 1, width: 80 });
  assert.equal(widget.render(80)[1], "\u25be todo  0/9 complete · 9 pending");
});