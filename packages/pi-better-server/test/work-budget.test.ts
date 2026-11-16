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

test("source work records synchronous throws and asynchronous settlement without changing results", async () => {
  const budget = createWorkBudget();
  assert.equal(budget.source("legacy-handoff", () => 42), 42);
  const failure = new Error("source failed");
  assert.throws(() => budget.source("legacy-handoff", () => { throw failure; }), error => error === failure);
  let finish!: (value: number) => void;
  const pending = budget.source("legacy-watch", () => new Promise<number>(resolve => { finish = resolve; }));
  assert.equal(budget.metrics().sources["legacy-watch"]!.active, 1);
  finish(7);
  assert.equal(await pending, 7);
  await assert.rejects(budget.source("legacy-watch", () => Promise.reject(failure)), error => error === failure);
  const metrics = budget.metrics().sources;
  assert.deepEqual([metrics["legacy-handoff"]!.started, metrics["legacy-handoff"]!.completed, metrics["legacy-handoff"]!.failed], [2, 2, 1]);
  assert.deepEqual([metrics["legacy-watch"]!.started, metrics["legacy-watch"]!.completed, metrics["legacy-watch"]!.failed, metrics["legacy-watch"]!.active], [2, 2, 1, 0]);
});
