import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";

// The fixed Node 24 artifact strips types natively and does not depend on tsx.
// Development on Node 22 uses the workspace loader without inheriting test preloads.
if (Number(process.versions.node.split(".")[0]) < 24) {
  const { register } = await import("tsx/esm/api");
  register();
}
const sqlite = createRequire(import.meta.url)("node:sqlite");
const OriginalDatabase = sqlite.DatabaseSync;
const connections = { opens: 0, active: 0, maximum: 0 };
sqlite.DatabaseSync = class extends OriginalDatabase {
  counted = true;
  constructor(...args) {
    super(...args);
    connections.opens++; connections.active++;
    connections.maximum = Math.max(connections.maximum, connections.active);
  }
  close() {
    super.close();
    if (this.counted) { this.counted = false; connections.active--; }
  }
};
const { WorkReadModel } = await import("./read-model.ts");
const { WorkQueries } = await import("./queries.ts");
const model = new WorkReadModel(workerData.agentDir, workerData.instanceId, workerData.modelOptions);
// One bounded in-flight batch. Remaining obligations stay in the reconstructable
// inventory index; an acknowledgement cannot erase a newer revision of an ID.
let terminalLogsPending;
const sendTerminalLogs = () => {
  if (terminalLogsPending) return;
  const batch = model.terminalLogChanges();
  if (!batch.length) return;
  terminalLogsPending = batch;
  parentPort.postMessage({ type: "terminal-logs", ids: batch.map(entry => entry.id) });
};
model.onTerminalLogsChanged = sendTerminalLogs;
const sessions = new Map();
const cache = new Map();
const encoded = new WeakMap();
let cacheBytes = 0, cacheHits = 0, queryCount = 0;
let revisionPending = false, revisionDirty = false;
const durations = [];
const metrics = () => ({ ...model.metrics, background: model.backgroundMetrics, sqlite: { ...connections }, cacheHits, queryCount, cacheBytes,
  cacheEntries: cache.size, queryDurationMs: [...durations] });
const snapshot = model.snapshot.bind(model);
model.snapshot = scope => {
  const key = JSON.stringify(scope ?? {});
  const cacheable = !scope?.backgroundHistory;
  const previous = cacheable ? cache.get(key) : undefined;
  if (previous) { cacheHits++; cache.delete(key); cache.set(key, previous); return previous.value; }
  const started = performance.now();
  const value = snapshot(scope);
  const json = JSON.stringify(value);
  const bytes = Buffer.byteLength(json);
  encoded.set(value, json);
  queryCount++; durations.push(performance.now() - started);
  if (durations.length > 128) durations.shift();
  if (cacheable && bytes <= 4 * 1024 * 1024) {
    while (cache.size && (cache.size >= 32 || cacheBytes + bytes > 16 * 1024 * 1024)) {
      const oldest = cache.keys().next().value;
      cacheBytes -= cache.get(oldest).bytes; cache.delete(oldest);
    }
    cache.set(key, { value, bytes }); cacheBytes += bytes;
  }
  return value;
};
function revision() {
  revisionPending = true;
  parentPort.postMessage({ type: "revision", metrics: metrics(), observation: model.observation() });
}
model.onChange(() => {
  cache.clear(); cacheBytes = 0;
  if (revisionPending) revisionDirty = true;
  else revision();
});

function session(id) {
  if (sessions.has(id)) return sessions.get(id);
  if (sessions.size >= 65) throw new Error("runtime-overloaded: subscription capacity reached; retry later");
  const state = { generation: 0, serial: 0, awaiting: false, pending: undefined, queries: undefined };
  state.flush = () => {
    if (state.awaiting || !state.pending) return;
    state.awaiting = true;
    parentPort.postMessage({ type: "event", connection: id, serial: ++state.serial, ...state.pending });
    state.pending = undefined;
  };
  const stream = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0,
    write(line) { state.pending = { line, generation: state.generation }; state.flush(); return true; } });
  state.queries = new WorkQueries(model, stream);
  sessions.set(id, state);
  return state;
}

parentPort.on("message", async message => {
  if (message.type === "terminal-logs-consumed") { if (terminalLogsPending) model.acknowledgeTerminalLogs(terminalLogsPending); terminalLogsPending = undefined; sendTerminalLogs(); return; }
  if (message.type === "revision-consumed") {
    revisionPending = false;
    if (revisionDirty) { revisionDirty = false; revision(); }
    return;
  }
  if (message.type === "detach") { sessions.get(message.connection)?.queries.close(); sessions.delete(message.connection); return; }
  if (message.type === "event-consumed") {
    const state = sessions.get(message.connection);
    if (state?.awaiting && state.serial === message.serial) { state.awaiting = false; state.flush(); }
    return;
  }
  if (message.type !== "query") return;
  try {
    const command = message.command;
    if (["runtime_get_liveness", "runtime_get_upgrade_obligations"].includes(command.type)) {
      await model.reconcile();
      const observation = model.observation(command.type === "runtime_get_upgrade_obligations" ? model.upgradeObligations() : model.livenessReasons());
      parentPort.postMessage({ type: "reply", id: message.id, json: JSON.stringify(observation.reasons), metrics: metrics(), observation });
      return;
    }
    if (!["runtime_get_snapshot", "runtime_subscribe", "runtime_unsubscribe"].includes(command.type)) throw new Error("Unsupported read operation");
    const indexed = command.type !== "runtime_get_snapshot" || !command.scope?.id || await model.ensureId(command.scope.id);
    const state = session(message.connection);
    state.generation = message.generation; state.pending = undefined;
    let value = state.queries.handle(command);
    if (!indexed && !value.rows.length) value = { ...value, status: "rebuilding", reason: "The requested run is being indexed; retry after reconciliation." };
    parentPort.postMessage({ type: "reply", id: message.id, json: encoded.get(value) ?? JSON.stringify(value), metrics: metrics() });
  } catch (error) {
    parentPort.postMessage({ type: "reply", id: message.id, error: String(error).slice(0, 512), metrics: metrics() });
  }
});
void model.reconcile();
