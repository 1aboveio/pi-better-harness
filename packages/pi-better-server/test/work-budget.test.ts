import test from "node:test";
import assert from "node:assert/strict";
import { createWorkBudget } from "../src/runtime/work-budget.ts";

test("legacy dispatch reserves shared control capacity and queued identities progress once capacity returns", async () => {
  const root = createWorkBudget(), peer = createWorkBudget(root.buffer);
  const held = Array.from({ length: 16 }, () => peer.enter("control")!);
  let calls = 0;
  const first = root.scheduleSource("legacy-watch", "one", () => ++calls);
  const duplicate = root.scheduleSource("legacy-watch", "one", () => ++calls);
  const second = root.scheduleSource("legacy-watch", "two", () => ++calls);
  assert.equal(calls, 0);
  assert.equal(first, duplicate);
  held.forEach(release => release());
  await new Promise(resolve => setTimeout(resolve, 15));
  const keepAlive = setTimeout(() => {}, 1000);
  try { assert.deepEqual(await Promise.all([first, second]), [1, 2]); }
  finally { clearTimeout(keepAlive); }
  assert.equal(peer.metrics().lanes.control!.active, 0);
});

test('nested source dispatch reuses its reservation and shared peers see actual completions', async () => {
  const root = createWorkBudget(), peer = createWorkBudget(root.buffer);
  const value = await root.scheduleSource('legacy-watch','outer', () => root.scheduleSource('legacy-handoff','inner', () => 42));
  assert.equal(value,42);
  assert.equal(peer.metrics().sources['legacy-watch']!.completed,1);
  assert.equal(peer.metrics().sources['legacy-handoff']!.completed,1);
  assert.equal(peer.metrics().lanes.control!.admitted,1);
});

test('a later timer cannot inherit a settled reservation', async () => {
  const budget = createWorkBudget();
  let later!: Promise<number>;
  await budget.scheduleSource('legacy-watch','first', () => {
    later = new Promise(resolve => setTimeout(() => {
      void budget.scheduleSource('legacy-watch','later', () => 7).then(resolve);
    }, 1));
  });
  assert.equal(await later, 7);
  assert.equal(budget.metrics().lanes.control!.admitted, 2);
});

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
