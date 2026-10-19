import assert from "node:assert/strict";
import test from "node:test";
import { cancelledRowsClearDelay, observeCancelledRows } from "../src/cancelled-rows.js";
import { projectRushPlan, visibleRushUnits } from "../src/workflow-plan.js";

test("each cancellation spelling expires on its own deadline while skipped rows remain", () => {
  const plan = projectRushPlan({
    runId: "staggered", planRevision: 1, fleet: {},
    units: [
      { id: "first", title: "First", stage: "done", status: "canceled" },
      { id: "second", title: "Second", stage: "pending", status: "pending" },
      { id: "skip", title: "Skipped", stage: "done", status: "skipped" },
    ],
  }, "staggered");
  const binding = { path: "/staggered/task-plan.json", owner: "fixture", runId: "staggered" };
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  const append = (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); };
  observeCancelledRows(plan, binding, entries, append, 0);
  plan.issues[1]!.status = "cancelled";
  observeCancelledRows(plan, binding, entries, append, 15_000);
  assert.equal(cancelledRowsClearDelay(plan, 29_999), 1);
  assert.deepEqual(visibleRushUnits(plan, 29_999).map(unit => unit.id), ["first", "second", "skip"]);
  assert.deepEqual(visibleRushUnits(plan, 30_000).map(unit => unit.id), ["second", "skip"]);
  assert.equal(cancelledRowsClearDelay(plan, 30_000), 15_000);
  assert.deepEqual(visibleRushUnits(plan, 45_000).map(unit => unit.id), ["skip"]);
  assert.equal(cancelledRowsClearDelay(plan, 45_000), null);
});