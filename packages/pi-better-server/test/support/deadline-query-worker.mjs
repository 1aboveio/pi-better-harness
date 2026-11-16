import { parentPort } from "node:worker_threads";

let now = 1000;
Date.now = () => now;
parentPort.on("message", message => {
  if (message.type !== "test-clock") return;
  now = message.now;
  parentPort.postMessage({ type: "test-clock", now });
});
await import("../../src/runtime/query-worker.mjs");
