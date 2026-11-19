import { parentPort, workerData } from "node:worker_threads";
import { bootstrapHeartbeat } from "./bootstrap-heartbeat.mjs";
import { queryPhase, recordQueryPhase } from "../../src/runtime/query-phase-diagnostics.mjs";
import { traceInitialInventory } from "./query-init-diagnostics.mjs";
const trace = value => recordQueryPhase(workerData.queryPhaseDiagnostics, value, 0, workerData.queryPhaseGeneration);
const stopBootstrapHeartbeat = bootstrapHeartbeat(parentPort, workerData.queryPhaseDiagnostics);
const phase = value => parentPort.postMessage({ type: "fixture-bootstrap-phase", phase: value });
if (workerData.fixtureHoldBootstrap) {
  trace(queryPhase.fixtureHeld);
  phase("bootstrap-held");
  await new Promise(resolve => {
    const release = message => {
      if (message.type !== "release-bootstrap") return;
      parentPort.off("message", release); resolve();
    };
    parentPort.on("message", release);
    parentPort.postMessage({ type: "bootstrap-held" });
  });
  phase("bootstrap-released");
  trace(queryPhase.fixtureReleased);
}
phase("read-model-import-start");
const { WorkReadModel } = await import("../../src/runtime/read-model.ts");
traceInitialInventory(WorkReadModel, workerData);
phase("read-model-import-complete");
const ensureId = WorkReadModel.prototype.ensureId;
let release;
WorkReadModel.prototype.ensureId = async function(id) {
  if (id === "sa_slow") {
    parentPort.postMessage({ type: "query-blocked" });
    await new Promise(resolve => { release = resolve; });
  }
  return ensureId.call(this, id);
};
parentPort.on("message", message => {
  if (message.type === "release-query") release?.();
  if (message.type === "wedge") {
    parentPort.postMessage({ type: "wedged" });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
});
phase("production-worker-import-start");
await import("../../src/runtime/query-worker.mjs");
phase("production-worker-import-complete");
stopBootstrapHeartbeat();
trace(queryPhase.bootstrapHandoff);
parentPort.postMessage({ type: "fixture-ready" });
