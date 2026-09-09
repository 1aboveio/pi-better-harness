import assert from "node:assert/strict";
import test from "node:test";

import {
  planClearEntry,
  planDisplayEntry,
  planProgress,
  planSetEntry,
  reconstructPlanState,
  replacePlan,
  validatePlanInput,
} from "../src/plan-state.js";
import { EXTENSION_NAME } from "../src/types.js";

test("replaces a plan atomically and preserves identities for unchanged steps", () => {
  const initial = replacePlan(null, [
    { step: "Inspect schema", status: "in_progress" },
    { step: "Import records", status: "pending" },
  ], "Initial plan", 100);
  const updated = replacePlan(initial, [
    { step: "Inspect schema", status: "completed" },
    { step: "Import records", status: "in_progress" },
    { step: "Reconcile totals", status: "pending" },
  ], "Schema verified", 120);

  assert.equal(updated.planId, initial.planId);
  assert.equal(updated.revision, 2);
  assert.equal(updated.steps[0]?.id, initial.steps[0]?.id);
  assert.equal(updated.steps[1]?.id, initial.steps[1]?.id);
  assert.equal(updated.steps[2]?.id, "step_2_3");
  assert.equal(updated.createdAt, 100);
  assert.equal(updated.updatedAt, 120);
});

test("rejects malformed updates without mutating the current snapshot", () => {
  const current = replacePlan(null, [{ step: "Keep this plan", status: "in_progress" }], undefined, 100);
  const before = structuredClone(current);

  assert.equal(validatePlanInput([], undefined), "A plan must contain at least one step.");
  assert.equal(validatePlanInput([
    { step: "One", status: "in_progress" },
    { step: "Two", status: "in_progress" },
  ]), "A plan can have at most one step in progress.");
  assert.equal(validatePlanInput([
    { step: "Duplicate", status: "pending" },
    { step: " duplicate ", status: "pending" },
  ]), "Plan step 2 duplicates an earlier step.");
  assert.throws(() => replacePlan(current, [], undefined, 110), /at least one step/);
  assert.deepEqual(current, before);
});

test("derives honest checklist progress and blocked state", () => {
  const plan = replacePlan(null, [
    { step: "Done", status: "completed" },
    { step: "Waiting", status: "blocked" },
    { step: "Later", status: "pending" },
  ], undefined, 100);

  assert.deepEqual(planProgress(plan), {
    total: 3,
    completed: 1,
    pending: 1,
    blocked: 1,
    inProgress: 0,
    activeIndex: 1,
    state: "blocked",
  });
});

test("reconstructs plan and display preference from the active branch", () => {
  const plan = replacePlan(null, [{ step: "Ship", status: "in_progress" }], undefined, 100);
  const entry = (data: unknown) => ({ type: "custom", customType: EXTENSION_NAME, data });

  assert.deepEqual(reconstructPlanState([
    entry(planSetEntry(plan, 100)),
    entry(planDisplayEntry("on", 101)),
  ]), { plan, displayMode: "on" });

  assert.deepEqual(reconstructPlanState([
    entry(planSetEntry(plan, 100)),
    entry(planDisplayEntry("hidden", 101)),
    entry(planClearEntry(102)),
  ]), { plan: null, displayMode: "hidden" });
});