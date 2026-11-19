import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { queryBootstrap, querySourceReady } from "./support/query-bootstrap.ts";
import { fixture } from "./support/query-fixture.ts";
import { WorkQueryExecutor } from "../src/runtime/query-executor.ts";
import { performance } from "node:perf_hooks";
const nativeTimers = { setTimeout, clearTimeout };

test("bootstrap exit retains a prior watchdog cause without claiming source readiness", async () => {
  const worker = new EventEmitter();
  const receipt = queryBootstrap(worker, () => ({
    observation: { status: "degraded", reason: "runtime-unhealthy: read worker unresponsive; watchdog deadline exceeded" },
    executor: { worker: "failed", restarts: 0, timeouts: 0, status: "degraded" },
  }));
  worker.emit("online"); worker.emit("message", { type: "heartbeat" });
  worker.emit("exit", 1);
  await assert.rejects(receipt, error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /query fixture worker exited before bootstrap \(code 1\)/);
    assert.match(error.message, /watchdog deadline exceeded/);
    assert.match(error.message, /"online":true,"heartbeats":1/);
    return true;
  });
  assert.deepEqual(worker.eventNames(), []);
});

test("bootstrap keeps the exact worker exception ahead of later teardown", async () => {
  const worker = new EventEmitter();
  const original = new Error("fixture import refused");
  const receipt = queryBootstrap(worker, () => { throw new Error("must not mask worker error"); });
  worker.emit("error", original); worker.emit("exit", 1);
  await assert.rejects(receipt, error => error === original);
  assert.deepEqual(worker.eventNames(), []);
});

test("only the explicit bootstrap receipt settles success and releases listeners", async () => {
  const worker = new EventEmitter();
  let completed = false;
  const receipt = queryBootstrap(worker, () => { throw new Error("successful startup needs no diagnostics"); });
  void receipt.then(() => { completed = true; });
  worker.emit("online"); worker.emit("message", { type: "heartbeat" });
  await Promise.resolve();
  assert.equal(completed, false);
  worker.emit("message", { type: "fixture-ready" });
  await receipt;
  assert.deepEqual(worker.eventNames(), []);
});

test("diagnostic failure never replaces the original bootstrap exit", async () => {
  const worker = new EventEmitter();
  const receipt = queryBootstrap(worker, () => { throw new Error("diagnostic unavailable"); });
  worker.emit("exit", 1);
  await assert.rejects(receipt, /exited before bootstrap \(code 1\).*diagnostic unavailable/);
  assert.deepEqual(worker.eventNames(), []);
});

test("bootstrap failure retains the actual import substage and heartbeat count without claiming readiness", async () => {
  const worker = new EventEmitter();
  let now = 100;
  const receipt = queryBootstrap(worker, () => ({ observation: { status: "degraded", reason: "watchdog deadline exceeded" },
    executor: { worker: "stopped" } }), () => now);
  worker.emit("message", { type: "fixture-bootstrap-phase", phase: "bootstrap-held" });
  for (let n = 0; n < 6; n++) worker.emit("message", { type: "heartbeat" });
  now = 1600;
  worker.emit("message", { type: "fixture-bootstrap-phase", phase: "read-model-import-start" });
  worker.emit("exit", 1);
  await assert.rejects(receipt, error => {
    assert.match(String(error), /"phase":"read-model-import-start","elapsedMs":1500,"heartbeats":6/);
    assert.match(String(error), /watchdog deadline exceeded/);
    return true;
  });
  assert.deepEqual(worker.eventNames(), []);
});

test("source readiness waits for verified pushed inventory, not heartbeat or bootstrap", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const worker = new EventEmitter();
  let observation = { status: "rebuilding", observedAt: null as number | null };
  let settled = false;
  const pending = querySourceReady(worker, () => observation).then(() => { settled = true; });
  worker.emit("message", { type: "fixture-ready" });
  worker.emit("message", { type: "heartbeat" });
  t.mock.timers.tick(4000);
  await Promise.resolve();
  assert.equal(settled, false, "startup has its own budget, not either measured caller deadline");
  observation = { status: "ready", observedAt: null };
  worker.emit("message", { type: "revision" });
  await Promise.resolve();
  assert.equal(settled, false, "executor status without a source observation is not readiness");
  observation = { status: "ready", observedAt: 1 };
  worker.emit("message", { type: "revision" });
  await pending;
  assert.equal(settled, true);
  assert.deepEqual(worker.eventNames(), []);
  await querySourceReady(worker, () => observation);
  assert.deepEqual(worker.eventNames(), [], "an already verified inventory needs no future event");
});

test("source startup timeout and worker failure remain distinct from caller read deadlines", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const observation = () => ({ status: "rebuilding", observedAt: null });
  const worker = new EventEmitter();
  const startup = assert.rejects(querySourceReady(worker, observation), /source inventory did not become ready within 5000 ms/);
  t.mock.timers.tick(5000);
  await startup;
  assert.deepEqual(worker.eventNames(), []);
  const unavailable = () => ({ status: "degraded", observedAt: null,
    reason: "runtime-unhealthy: read worker unresponsive; watchdog deadline exceeded" });
  const exited = assert.rejects(querySourceReady(worker, unavailable), error => {
    assert.match(String(error), /exited before source inventory readiness \(code 9\)/);
    assert.match(String(error), /watchdog deadline exceeded/);
    return true;
  });
  worker.emit("exit", 9);
  await exited;
  const original = new Error("source worker failed");
  const failed = assert.rejects(querySourceReady(worker, observation), error => error === original);
  worker.emit("error", original);
  await failed;
  assert.deepEqual(worker.eventNames(), []);
});

test("held real inventory settles separately before the first uncached subscription", { timeout: 10000 }, async () => {
  const f = await fixture({ timeoutMs: 400, watchdogMs: 2000,
    workerUrl: new URL("./support/blocked-inventory-worker.mjs", import.meta.url) });
  try {
    const id = "sa_source_ready";
    mkdirSync(join(f.root, "runs", id));
    writeFileSync(join(f.root, "runs", id, "meta.json"), JSON.stringify({
      id, cwd: f.root, status: "completed", startedAt: 1, name: "present-before-ready",
    }));
    await f.bootstrapped;
    let settled = false;
    const inventory = f.waitForSourceReady().then(() => { settled = true; });
    const held = await new Promise<any>(resolve => {
      const status = (message: any) => {
        if (message.type !== "inventory-status") return;
        f.worker.off("message", status); resolve(message);
      };
      f.worker.on("message", status);
      f.worker.postMessage({ type: "inventory-status" });
    });
    assert.equal(held.rpcInstalled, true);
    assert.equal(held.held, true);
    assert.equal(settled, false);
    assert.equal(f.executor.observation().status, "rebuilding");
    assert.equal(f.executor.metrics().executor.completed, 0);
    assert.equal(f.executor.metrics().executor.clients, 0);
    f.worker.postMessage({ type: "release-inventory" });
    await inventory;
    const before = f.executor.metrics() as ReturnType<typeof f.executor.metrics> & { queryCount: number; cacheEntries: number };
    assert.equal(f.executor.observation().status, "ready");
    assert.ok(f.executor.observation().observedAt !== null);
    assert.equal(before.queryCount, 0, "inventory startup must not issue a query or warm snapshots");
    assert.equal(before.cacheEntries, 0);
    assert.equal(before.executor.completed, 0);
    assert.equal(before.executor.callerTimeouts, 0);
    const client = await f.client();
    const first = await client.subscribe({ id, limit: 1 });
    assert.equal(first.status, "ready");
    assert.equal(first.rows[0]?.meta.name, "present-before-ready");
    assert.equal(f.executor.metrics().executor.completed, 1);
    assert.equal(f.executor.metrics().executor.callerTimeouts, 0);
    assert.equal(f.executor.metrics().executor.restarts, 0);
  } finally { await f.close(); }
});

test("an overdue watchdog polls queued responses before failing but preserves caller and wedge deadlines", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let now = 0, terminations = 0;
  t.mock.method(performance, "now", () => now);
  const worker = { postMessage() {}, async terminate() { terminations++; return 0; }, unref() {} };
  const prototype = WorkQueryExecutor.prototype as any, startWorker = prototype.startWorker;
  prototype.startWorker = function () {
    this.heartbeat = new BigInt64Array(new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT));
    return worker;
  };
  let executor: WorkQueryExecutor;
  try { executor = new WorkQueryExecutor("unused-controlled-root", "poll-order", { timeoutMs: 400, watchdogMs: 800 }); }
  finally { prototype.startWorker = startWorker; }
  const advance = (ms: number) => { now += ms; t.mock.timers.tick(ms); };
  try {
    advance(799);
    (executor as any).receive({ type: "heartbeat" });
    advance(800);
    assert.equal(terminations, 0, "an accepted heartbeat owns the next full watchdog window");
    advance(1);
    assert.equal(terminations, 0, "an overdue host timer must poll queued worker responses before termination");
    (executor as any).receive({ type: "heartbeat" });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(executor.metrics().executor.worker, "running");
    const stream = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0, write() { return true; } });
    const client = executor.connect(stream as any);
    const expired = assert.rejects(client.handle({ type: "runtime_subscribe", scope: {} }), /runtime-timeout: caller read deadline exceeded/);
    advance(400);
    await expired;
    assert.equal(executor.metrics().executor.callerTimeouts, 1, "polling the worker does not extend caller deadlines");
    advance(600);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(terminations, 1, "an actually unresponsive worker still fails after the unchanged 800ms window");
    assert.match(executor.observation().reason!, /watchdog deadline exceeded/);
    client.close();
  } finally { await executor.close(); }
});

test("a real Worker heartbeat queued before the watchdog is delivered after microtasks and before failure commitment", { timeout: 10000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let now = 0, delivered = false;
  t.mock.method(performance, "now", () => now);
  const workerUrl = new URL(`data:text/javascript,${encodeURIComponent(`
    import { parentPort } from 'node:worker_threads';
    const gate = new Int32Array(new SharedArrayBuffer(8));
    parentPort.on('message', () => {});
    parentPort.postMessage({ type: 'test-gate', buffer: gate.buffer });
    while (Atomics.load(gate, 0) === 0) Atomics.wait(gate, 0, 0);
    parentPort.postMessage({ type: 'heartbeat' });
    Atomics.store(gate, 1, 1); Atomics.notify(gate, 1);
  `)}`);
  const executor = new WorkQueryExecutor("unused-real-worker-root", "real-poll-order", { watchdogMs: 800, workerUrl });
  const worker = (executor as any).worker;
  let gate!: Int32Array;
  let accept!: () => void, reject!: (error: Error) => void;
  let rejectSetup: (error: Error) => void = () => {};
  const heartbeat = new Promise<void>((resolve, fail) => { accept = resolve; reject = fail; });
  void heartbeat.catch(() => {});
  const exit = () => {
    const error = new Error("worker terminated before its queued heartbeat was accepted");
    reject(error); rejectSetup(error);
  };
  const observe = (message: any) => {
    if (message.type === "heartbeat") {
      delivered = true;
      try {
        assert.equal((executor as any).lastResponse, now, "the actual executor message listener accepted this heartbeat");
        accept();
      } catch (error) { reject(error as Error); }
    }
  };
  worker.on("message", observe); worker.once("exit", exit);
  const guard = nativeTimers.setTimeout(() => {
    const error = new Error("real Worker heartbeat proof did not settle");
    reject(error); rejectSetup(error);
  }, 5000);
  try {
    gate = await new Promise<Int32Array>((resolve, fail) => {
      rejectSetup = fail;
      const setup = (message: any) => {
        if (message.type !== "test-gate") return;
        worker.off("message", setup); resolve(new Int32Array(message.buffer));
      };
      worker.on("message", setup);
    });
    // A real timer turn reproduces the overdue-timer-before-poll boundary.
    // The atomic gate, not an elapsed sleep, proves the message is already sent.
    await new Promise<void>((resolve, fail) => nativeTimers.setTimeout(() => {
      void (async () => {
        Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
        while (Atomics.load(gate, 1) === 0) {
          assert.notEqual(Atomics.wait(gate, 1, 0, 5000), "timed-out", "worker must post before the host watchdog callback");
        }
        assert.equal(delivered, false, "posting is not synchronous executor delivery");
        now = 801; t.mock.timers.tick(801);
        await Promise.resolve();
        assert.equal(delivered, false, "a microtask checkpoint is not Worker message delivery");
        assert.equal(executor.metrics().executor.worker, "running", "neither synchronous nor microtask termination may precede poll");
        await heartbeat;
        await new Promise<void>(done => setImmediate(done));
        assert.equal(executor.metrics().executor.worker, "running");
      })().then(resolve, fail);
    }, 0));
  } finally {
    worker.off("message", observe); worker.off("exit", exit);
    if (gate) { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); }
    try { await executor.close(); }
    finally { nativeTimers.clearTimeout(guard); }
  }
});
