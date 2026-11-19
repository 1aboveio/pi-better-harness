import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { queryBootstrap } from "./support/query-bootstrap.ts";

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
