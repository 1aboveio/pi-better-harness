import { parentPort } from "node:worker_threads";
// The fixture imports the model before the production worker can own control
// messages. Keep that async bootstrap responsive without claiming source readiness.
let bootstrapHeartbeatPending = false;
const acknowledgeBootstrap = message => {
  if (message.type === "heartbeat-consumed") bootstrapHeartbeatPending = false;
};
parentPort.on("message", acknowledgeBootstrap);
const bootstrapHeartbeat = setInterval(() => {
  if (bootstrapHeartbeatPending) return;
  bootstrapHeartbeatPending = true;
  parentPort.postMessage({ type: "heartbeat" });
}, 250);
bootstrapHeartbeat.unref();
if (Number(process.versions.node.split(".")[0]) < 24) {
  const { register } = await import("tsx/esm/api");
  register();
}
const { WorkReadModel } = await import("../../src/runtime/read-model.ts");

const reconcile = WorkReadModel.prototype.reconcile;
function blockInventory() {
  let release;
  const inventory = new Promise(resolve => { release = resolve; });
  let initial;
  WorkReadModel.prototype.reconcile = function() {
    initial ??= inventory.then(() => reconcile.call(this));
    return initial;
  };
  return release;
}
let release = blockInventory();
parentPort.on("message", message => {
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
clearInterval(bootstrapHeartbeat);
parentPort.off("message", acknowledgeBootstrap);
parentPort.postMessage({ type: "fixture-ready" });
parentPort.postMessage({ type: "inventory-blocked" });
