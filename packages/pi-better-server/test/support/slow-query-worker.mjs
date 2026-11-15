import { parentPort } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

parentPort.on("message", message => {
  if (message.type !== "diagnostic-stall") return;
  const db = new DatabaseSync(":memory:");
  parentPort.postMessage({ type: "diagnostic-started" });
  const started = performance.now();
  try {
    db.prepare(`WITH RECURSIVE counter(n) AS (VALUES(0) UNION ALL
      SELECT n + 1 FROM counter WHERE n < ?) SELECT sum(n) FROM counter`).get(message.iterations ?? 10000000);
  } finally { db.close(); }
  parentPort.postMessage({ type: "diagnostic-finished", durationMs: performance.now() - started });
});
await import("../../src/runtime/query-worker.mjs");
