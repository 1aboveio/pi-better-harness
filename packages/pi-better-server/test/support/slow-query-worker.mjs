import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { statSync, readdirSync, readFileSync } from "node:fs";
import { sourceEventTrace } from "./source-event-trace.mjs";

await import("../../src/runtime/query-worker.mjs");
const { WorkReadModel } = await import("../../src/runtime/read-model.ts");
let latestModel;
const traces = new WeakMap();
const scan = WorkReadModel.prototype.scan;
WorkReadModel.prototype.scan = function (...args) { latestModel = this; return scan.apply(this, args); };
const contentRevision = WorkReadModel.prototype.contentRevision;
WorkReadModel.prototype.contentRevision = function (...args) {
  latestModel = this;
  if (!traces.has(this)) traces.set(this, sourceEventTrace(this));
  return contentRevision.apply(this, args);
};
const hints = [];
const fileHint = WorkReadModel.prototype.fileHint;
WorkReadModel.prototype.fileHint = function (...args) {
  hints.push(args); if (hints.length > 16) hints.shift();
  return fileHint.apply(this, args);
};

parentPort.on("message", message => {
  if (message.type === "diagnostic-source-hint") {
    latestModel.fileHint(latestModel.runs, message.id);
    return;
  }
  if (message.type === "diagnostic-source-state") {
    const model = latestModel;
    parentPort.postMessage({ type: "diagnostic-source-state", id: message.id, state: model && {
      configured: workerData, imported: model.imported,
      eventOwnership: traces.get(model)?.(),
      roots: { agentDir: model.agentDir, runs: model.runs, archives: model.archives, markers: model.markers },
      watchers: [...model.watchers.keys()], rootIdentities: [...model.rootWatchIdentities],
      actualRoots: [model.runs, model.archives, model.markers].map(path => {
        try { const info = statSync(path, { bigint: true }); return { path, identity: `${info.dev}:${info.ino}`, changeListeners: model.watchers.get(path)?.listenerCount("change") }; }
        catch (error) { return { path, error: error.code }; }
      }), deliveredHints: hints,
      rawEntries: (() => {
        try {
          return readdirSync(model.runs).slice(0, 16).map(name => {
            try {
              const path = `${model.runs}/${name}/meta.json`, info = statSync(path);
              if (info.size > 1024 * 1024) return { name, bytes: info.size, oversized: true };
              const meta = JSON.parse(readFileSync(path, "utf8"));
              return { name, meta: { id: meta?.id, name: meta?.name, status: meta?.status } };
            }
            catch (error) { return { name, error: String(error) }; }
          });
        } catch (error) { return [{ error: String(error) }]; }
      })(),
      parents: [...model.rootParents].map(([root, value]) => ({ root, path: value.path, identity: value.identity })),
      hints: [...model.hints.keys()], pending: Boolean(model.pending), repair: Boolean(model.repair),
      metrics: model.metrics, sql: WorkReadModel.prototype.snapshot.call(model, message.scope),
      cached: model.snapshot(message.scope),
    } });
    return;
  }
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
