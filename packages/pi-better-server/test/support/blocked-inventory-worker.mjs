import { parentPort, workerData } from "node:worker_threads";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { bootstrapHeartbeat } from "./bootstrap-heartbeat.mjs";
// The fixture imports the model before the production worker can own control
// messages. Keep that async bootstrap responsive without claiming source readiness.
const stopBootstrapHeartbeat = bootstrapHeartbeat(parentPort);
if (Number(process.versions.node.split(".")[0]) < 24) {
  const { register } = await import("tsx/esm/api");
  register();
}
const { WorkReadModel } = await import("../../src/runtime/read-model.ts");

const reconcile = WorkReadModel.prototype.reconcile;
let model;
function blockInventory() {
  let release;
  const inventory = new Promise(resolve => { release = resolve; });
  let initial;
  WorkReadModel.prototype.reconcile = function() {
    model = this;
    initial ??= inventory.then(() => reconcile.call(this));
    return initial;
  };
  return release;
}
let release = blockInventory();
let rpcInstalled = false;
const earlyMessages = [];
parentPort.on("message", message => {
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
    release = blockInventory();
    parentPort.postMessage({ type: "inventory-blocked" });
  }
  if (message.type === "release-inventory") {
    WorkReadModel.prototype.reconcile = reconcile;
    release();
  }
});
await import("../../src/runtime/query-worker.mjs");
rpcInstalled = true;
stopBootstrapHeartbeat();
parentPort.postMessage({ type: "fixture-ready" });
parentPort.postMessage({ type: "inventory-blocked", earlyMessages });
