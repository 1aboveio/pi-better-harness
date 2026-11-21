import { parentPort } from "node:worker_threads";
await import("../../src/runtime/query-worker.mjs");
parentPort.on("message", message => {
  if (message.type === "diagnostic-fold") parentPort.postMessage({ type: "terminal-logs", ids: [message.id] });
  if (message.type === "terminal-logs-consumed") parentPort.postMessage({ type: "diagnostic-fold-ack" });
});
