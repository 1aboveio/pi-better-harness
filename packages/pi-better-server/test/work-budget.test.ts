import test from "node:test";
import assert from "node:assert/strict";
import { createWorkBudget } from "../src/runtime/work-budget.ts";

test("one total source capacity reserves independent control, query and repair progress", () => {
  const root = createWorkBudget();
  const reads = createWorkBudget(root.buffer);
  const release: Array<() => void> = [];
  for (let i = 0; i < 8; i++) {
    release.push(reads.enter("query")!);
    release.push(reads.enter("repair")!);
  }
  assert.equal(reads.enter("query"), undefined);
  assert.equal(reads.enter("repair"), undefined);
  for (let i = 0; i < 16; i++) release.push(root.enter("control")!);
  assert.equal(root.enter("control"), undefined);
  assert.equal(Object.values(root.metrics().lanes).reduce((sum, lane) => sum + lane.active, 0), 32);
  for (const leave of release) { assert.equal(typeof leave, "function"); leave(); leave(); }
  assert.equal(Object.values(root.metrics().lanes).reduce((sum, lane) => sum + lane.active, 0), 0);
  assert.ok(root.enter("control"), "wedged read credits cannot consume reserved control admission");
});
