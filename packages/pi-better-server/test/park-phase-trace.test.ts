import assert from "node:assert/strict";
import test from "node:test";
import { parkPhaseTrace } from "./support/park-phase-trace.ts";

test("park timeout evidence retains the waiting phase before later cleanup and emits once", () => {
  const controller = new AbortController();
  const records: any[] = [];
  let clock = 100;
  const trace = parkPhaseTrace(controller.signal, record => records.push(record), () => clock);
  trace.mark("sdk-ready");
  clock = 300;
  trace.mark("unavailable-control-status");
  assert.deepEqual(records, [], "successful progress produces no diagnostics");
  clock = 500;
  controller.abort();
  trace.mark("cleanup");
  trace.report("failure");
  assert.deepEqual(records, [{ parkPhaseFailure: { cause: "abort", elapsedMs: 400,
    phases: [{ phase: "sdk-ready", elapsedMs: 0 }, { phase: "unavailable-control-status", elapsedMs: 200 }] } }]);
  trace.close();
});

test("park phase history is bounded and successful disposal removes abort diagnostics", () => {
  const controller = new AbortController();
  const records: any[] = [];
  const trace = parkPhaseTrace(controller.signal, record => records.push(record), () => 0);
  for (let i = 0; i < 40; i++) trace.mark(`phase-${i}`);
  trace.report("failure");
  assert.equal(records[0].parkPhaseFailure.phases.length, 32);
  assert.equal(records[0].parkPhaseFailure.phases[0].phase, "phase-8");
  trace.close();
  const successful = parkPhaseTrace(controller.signal, record => records.push(record));
  successful.mark("complete");
  successful.close();
  controller.abort();
  assert.equal(records.length, 1);
});
