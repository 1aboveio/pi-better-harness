import { parentPort, workerData } from "node:worker_threads";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
parentPort.on("message", message => {
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
parentPort.postMessage({ type: "inventory-blocked" });
