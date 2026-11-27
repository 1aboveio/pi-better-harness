import { parentPort, workerData } from "node:worker_threads";

const { openWorkLedgerStore } = await import(workerData.moduleUrl);
const gate = new Int32Array(workerData.gate);
parentPort.postMessage({ type: "ready" });
Atomics.wait(gate, 0, 0);

try {
  const ledger = openWorkLedgerStore(workerData.options).update(workerData.update);
  parentPort.postMessage({ type: "done", ok: true, revision: ledger.revision });
} catch (error) {
  parentPort.postMessage({
    type: "done",
    ok: false,
    code: error?.code,
    message: error instanceof Error ? error.message : String(error),
  });
}
