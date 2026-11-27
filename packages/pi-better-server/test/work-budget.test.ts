import test from "node:test";
import assert from "node:assert/strict";
import { createWorkBudget } from "../src/runtime/work-budget.ts";

test('pending source state is bounded by live owner kind entity and reports actual due versus start', async () => {
  const budget = createWorkBudget();
  const held = Array.from({length:16},()=>budget.enter('control')!);
  const dueAt = Date.now() - 50;
  let calls = 0;
  const first = budget.scheduleSource('legacy-handoff','entity',()=>++calls,'owner',dueAt);
  for (let i=0;i<10000;i++) assert.equal(budget.scheduleSource('legacy-handoff','entity',()=>++calls,'owner',dueAt),first);
  assert.equal(budget.metrics().queuedSources,1);
  held.forEach(release=>release());
  const keepAlive=setTimeout(()=>{},1000);
  try { assert.equal(await first,1); } finally { clearTimeout(keepAlive); }
  assert.equal(budget.metrics().queuedSources,0);
  assert.equal(budget.metrics().pendingSources,0);
  assert.ok(budget.metrics().sources['legacy-handoff']!.deadlineLatenessMs >= 50);
  assert.equal(calls,1);
});

test('observation owner saturation does not block another owner or critical work behind it', async () => {
  const budget = createWorkBudget();
  const done: Array<() => void> = [];
  const first = Array.from({length:4}, (_, i) => budget.scheduleSource('legacy-remote-poll',String(i),
    () => new Promise<void>(resolve => done.push(resolve)), 'owner-a'));
  assert.equal(done.length,2);
  assert.equal(budget.metrics().queuedSources,2);
  assert.equal(await budget.scheduleSource('legacy-handoff','critical',()=>42,'owner-b'),42);
  assert.equal(await budget.scheduleSource('legacy-remote-poll','0',()=>7,'owner-b'),7);
  assert.equal(budget.metrics().queuedSources,2);
  const keepAlive = setTimeout(()=>{},1000);
  try {
    done.splice(0).forEach(resolve=>resolve());
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(done.length,2);
    done.forEach(resolve=>resolve()); await Promise.all(first);
    assert.equal(budget.metrics().queuedSources,0);
  } finally { clearTimeout(keepAlive); done.forEach(resolve=>resolve()); }
});

test('pending remote observations cannot block another owner deadline or handoff', async () => {
  const budget = createWorkBudget();
  const finish: Array<() => void> = [];
  const observations = Array.from({length:8}, (_,i) => budget.scheduleSource('legacy-remote-poll',`remote:${i}`,
    () => new Promise<void>(resolve => finish.push(resolve))));
  const originalDeadline = Date.now();
  const timeout = setTimeout(() => finish.forEach(resolve => resolve()),100);
  try {
    const deadline = budget.scheduleSource('legacy-process-deadline','another-owner:deadline', () => {
      assert.equal(finish.length,8);
      assert.equal(budget.metrics().sources['legacy-remote-poll']!.active,8);
      return originalDeadline;
    });
    assert.equal(await deadline,originalDeadline);
    assert.equal(budget.metrics().sources['legacy-remote-poll']!.completed,0,'no physical observation credit was released');
    assert.equal(await budget.scheduleSource('legacy-handoff','third-owner:handoff',() => 42),42);
  } finally { clearTimeout(timeout); finish.forEach(resolve => resolve()); await Promise.all(observations); }
});

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
  assert.equal(root.metrics().lanes.control!.completed,16);
  assert.equal(root.metrics().lanes.query!.completed,8);
  assert.equal(root.metrics().lanes.repair!.completed,8);
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
