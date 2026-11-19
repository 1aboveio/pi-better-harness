import { parentPort, workerData } from "node:worker_threads";
import { bootstrapHeartbeat } from "./bootstrap-heartbeat.mjs";
import { traceInitialInventory } from "./query-init-diagnostics.mjs";
import { queryPhase, recordQueryPhase } from "./query-phase-diagnostics.mjs";
const data = { ...workerData, queryPhaseDiagnostics: workerData.modelOptions?.queryPhaseDiagnostics };
const trace = value => recordQueryPhase(data.queryPhaseDiagnostics, value);
// The fixture imports the model before the production worker can own control
// messages. Keep that async bootstrap responsive without claiming source readiness.
const stopBootstrapHeartbeat = bootstrapHeartbeat(parentPort, data.queryPhaseDiagnostics);
const { readFileSync, statSync } = await import("node:fs");
const { join } = await import("node:path");
if (Number(process.versions.node.split(".")[0]) < 24) {
  const { register } = await import("tsx/esm/api");
  register();
}
trace(queryPhase.modelImportBegin);
const { WorkReadModel } = await import("../../src/runtime/read-model.ts");
trace(queryPhase.modelImportEnd);
traceInitialInventory(WorkReadModel, data);

const reconcile = WorkReadModel.prototype.reconcile;
let model;
let inventoryHeld = false;
function blockInventory() {
  inventoryHeld = true;
  let release;
  const inventory = new Promise(resolve => { release = resolve; });
  let initial;
  WorkReadModel.prototype.reconcile = function() {
    model = this;
    initial ??= inventory.then(() => reconcile.call(this));
    return initial;
  };
  return () => { inventoryHeld = false; release(); };
}
let release = blockInventory();
let rpcInstalled = false;
let releaseScanTail;
const earlyMessages = [];
parentPort.on("message", async message => {
  if (message.type === "inventory-status") {
    parentPort.postMessage({ type: "inventory-status", rpcInstalled, held: inventoryHeld, imported: model.imported });
    return;
  }
  if (!rpcInstalled && ["query", "cancel"].includes(message.type) && earlyMessages.length < 4) {
    earlyMessages.push({ messageType: message.type, id: message.id });
  }
  if (message.type === "initial-source-state") {
    const path = join(model.runs, message.id, "meta.json");
    const info = statSync(path);
    const meta = info.size <= 1024 * 1024 ? JSON.parse(readFileSync(path, "utf8")) : undefined;
    parentPort.postMessage({ type: "initial-source-state", configured: workerData, imported: model.imported,
      runs: model.runs, watchers: [...model.watchers.keys()], path, meta,
      snapshot: WorkReadModel.prototype.snapshot.call(model, message.scope) });
    return;
  }
  if (message.type === "block-inventory") {
    parentPort.postMessage({ type: "block-requested", pending: Boolean(model.pending) });
    // Drain only already-owned work: replacing reconcile cannot stop a call
    // that entered the original method before this control message arrived.
    while (model.pending) await model.pending;
    release = blockInventory();
    parentPort.postMessage({ type: "inventory-blocked", pending: Boolean(model.pending) });
  }
  if (message.type === "hold-scan-tail") {
    const scan = WorkReadModel.prototype.scan;
    const tail = new Promise(resolve => { releaseScanTail = resolve; });
    WorkReadModel.prototype.scan = async function(...args) {
      WorkReadModel.prototype.scan = scan;
      await scan.apply(this, args);
      parentPort.postMessage({ type: "scan-tail-held" });
      await tail;
    };
    model.fileHint(model.runs, message.id);
  }
  if (message.type === "release-scan-tail") {
    releaseScanTail?.();
  }
  if (message.type === "release-inventory") {
    trace(queryPhase.fixtureReleased);
    WorkReadModel.prototype.reconcile = reconcile;
    release();
  }
});
await import("../../src/runtime/query-worker.mjs");
trace(queryPhase.handlerInstalled);
rpcInstalled = true;
stopBootstrapHeartbeat();
trace(queryPhase.bootstrapHandoff);
parentPort.postMessage({ type: "fixture-ready" });
parentPort.postMessage({ type: "inventory-blocked", earlyMessages });
