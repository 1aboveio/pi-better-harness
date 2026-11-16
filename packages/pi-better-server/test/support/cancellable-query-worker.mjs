import { parentPort } from "node:worker_threads";
const { WorkReadModel } = await import("../../src/runtime/read-model.ts");
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
await import("../../src/runtime/query-worker.mjs");
parentPort.postMessage({ type: "fixture-ready" });
