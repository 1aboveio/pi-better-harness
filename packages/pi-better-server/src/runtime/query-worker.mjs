import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";

// Publish liveness during async imports too. This clock measures the worker's
// own event loop, independently of parent delivery and source readiness.
let heartbeatPending = false;
let rpcInstalled = false;
const heartbeat = workerData.heartbeat;
const markHeartbeat = () => { if (heartbeat) Atomics.store(heartbeat, 0, process.hrtime.bigint()); };
markHeartbeat();
setInterval(() => {
  markHeartbeat();
  if (!rpcInstalled || heartbeatPending) return;
  heartbeatPending = true;
  parentPort.postMessage({ type: "heartbeat" });
}, 250).unref();

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
const { createWorkBudget } = await import("./work-budget.ts");
const budget = createWorkBudget(workerData.modelOptions?.budgetBuffer);
const { workerSourceWatch } = await import("./source-watch.ts");
const { WorkQueries, workScope, queryEncodingMetrics, snapshotJSON } = await import("./queries.ts");
const { executionPhases, inventoryPhases } = await import("./read-watchdog-probe.ts");
const probe = workerData.probe;
const markExecution = phase => { if (probe) Atomics.store(probe, 0, executionPhases.indexOf(phase)); };
function observeExecution(phase, run) {
  if (!probe) return run();
  const previous = Atomics.exchange(probe, 0, executionPhases.indexOf(phase));
  try { return run(); } finally { Atomics.store(probe, 0, previous); }
}
let model;
try {
  model = new WorkReadModel(workerData.agentDir, workerData.instanceId, {
    ...workerData.modelOptions, watch: workerSourceWatch(parentPort),
    inventoryPhase: probe ? phase => Atomics.store(probe, 1, inventoryPhases.indexOf(phase)) : undefined,
  });
} catch (error) {
  // Worker error forwarding retains only String(error). Keep the original
  // statement's stack for this specific bootstrap failure, without source data.
  if (/database is locked/.test(String(error))) {
    console.error(`[runtime-read-bootstrap] WorkReadModel constructor\n${String(error?.stack ?? error).split("\n").slice(0, 12).join("\n").slice(0, 4096)}`);
  }
  throw error;
}
markExecution("idle");
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
const requests = new Map();
const cache = new Map();
const encoded = new WeakMap();
let cacheBytes = 0, cacheHits = 0, queryCount = 0, serializationCount = 0;
let revisionPending = false, revisionDirty = false;
const durations = [];
const cacheComparisons = workerData.queryCacheDiagnostics ? [] : undefined;
const metrics = () => ({ ...model.indexCounters, background: model.backgroundCounters, sqlite: { ...connections }, cacheHits, queryCount, serializationCount, eventEncoding: { ...queryEncodingMetrics }, cacheBytes,
  cacheEntries: cache.size, queryDurationMs: [...durations], ...(cacheComparisons ? { cacheComparisons: [...cacheComparisons] } : {}) });
const snapshot = model.snapshot.bind(model);
model.snapshot = (scope, published = false) => observeExecution("snapshot", () => {
  scope = workScope(scope ?? {});
  const key = JSON.stringify(scope ?? {});
  // Explicit exact and history requests verify their sources inside snapshot().
  // During publication identical subscribers can share the committed observation.
  const cacheable = published || !scope?.backgroundHistory && !(scope?.background && scope.id);
  const revision = cacheable ? model.contentRevision(scope, published) : undefined;
  // Historical IDs can outlive the parent's active/recent observation window.
  const previous = cacheable ? cache.get(key) : undefined;
  const comparedAt = Date.now();
  const hit = previous && previous.revision === revision && (previous.value.nextDeadline === null || previous.value.nextDeadline > comparedAt);
  // Only the original regression fixture opts in; no extra source reads.
  let comparison;
  if (cacheComparisons) {
    comparison = { queryCount, scope, revision, priorRevision: previous?.revision ?? null,
      priorScopeRevision: previous?.value.scopeRevision ?? null, priorSeq: previous?.value.seq ?? null,
      priorObservedRevisionVector: previous?.value.observedRevisionVector ?? null, priorDeadline: previous?.value.nextDeadline ?? null,
      comparedAt, hit: Boolean(hit) };
    cacheComparisons.push(comparison);
    if (cacheComparisons.length > 16) cacheComparisons.shift();
  }
  if (hit) {
    cacheHits++; cache.delete(key); cache.set(key, previous); return previous.value;
  }
  if (previous) { cacheBytes -= previous.bytes; cache.delete(key); }
  const started = performance.now();
  const value = snapshot(scope, published);
  if (comparison) Object.assign(comparison, { scopeRevision: value.scopeRevision,
    nextDeadline: value.nextDeadline, seq: value.seq, observedRevisionVector: value.observedRevisionVector });
  const json = snapshotJSON(value);
  serializationCount++;
  const bytes = Buffer.byteLength(json);
  encoded.set(value, json);
  queryCount++; durations.push(performance.now() - started);
  if (durations.length > 128) durations.shift();
  if (cacheable && bytes <= 4 * 1024 * 1024) {
    while (cache.size && (cache.size >= 32 || cacheBytes + bytes > 16 * 1024 * 1024)) {
      const oldest = cache.keys().next().value;
      cacheBytes -= cache.get(oldest).bytes; cache.delete(oldest);
    }
    cache.set(key, { value, bytes, revision }); cacheBytes += bytes;
  }
  return value;
});
function revision() {
  revisionPending = true;
  observeExecution("publish", () => parentPort.postMessage({ type: "revision", metrics: metrics(), observation: model.observation() }));
}
model.onChange(() => {
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
  if (message.type === "inbox-diagnostics") {
    try { parentPort.postMessage({ type: "inbox-diagnostics", sample: model.inboxDiagnostics }); }
    catch (error) { parentPort.postMessage({ type: "inbox-diagnostics", error: String(error).slice(0, 512) }); }
    return;
  }
  if (message.type === "heartbeat-consumed") { heartbeatPending = false; return; }
  if (message.type === "cancel") {
    const request = requests.get(message.id);
    if (request) {
      request.cancelled = true;
      requests.delete(message.id);
      parentPort.postMessage({ type: "reply", id: message.id, error: "runtime-timeout: read cancelled" });
    }
    return;
  }
  if (message.type === "terminal-logs-consumed") { if (terminalLogsPending) model.acknowledgeTerminalLogs(terminalLogsPending); terminalLogsPending = undefined; sendTerminalLogs(); return; }
  if (message.type === "revision-consumed") {
    revisionPending = false;
    if (revisionDirty) { revisionDirty = false; revision(); }
    return;
  }
  if (message.type === "detach") {
    for (const request of requests.values()) if (request.connection === message.connection) request.cancelled = true;
    sessions.get(message.connection)?.queries.close(); sessions.delete(message.connection); return;
  }
  if (message.type === "event-consumed") {
    const state = sessions.get(message.connection);
    if (state?.awaiting && state.serial === message.serial) { state.awaiting = false; state.flush(); }
    return;
  }
  if (message.type !== "query") return;
  if (message.traceSubscription) parentPort.postMessage({ type: "subscription-started", id: message.id, at: Date.now() });
  const request = { connection: message.connection, cancelled: false };
  requests.set(message.id, request);
  const release = budget.enter("query");
  try {
    if (!release) throw new Error("runtime-overloaded: shared source query budget exhausted");
    const command = message.command;
    if (["runtime_get_liveness", "runtime_get_upgrade_obligations"].includes(command.type)) {
      if (command.type === "runtime_get_upgrade_obligations") {
        const blockers = model.coordinatorUpgradeBlockers();
        if (blockers.length) {
          // A durable blocker defers activation without renewing idle/liveness evidence.
          parentPort.postMessage({ type: "reply", id: message.id, json: JSON.stringify(blockers), metrics: metrics() });
          return;
        }
      }
      await model.reconcile();
      if (request.cancelled) return;
      observeExecution("request", () => {
        const observation = model.observation(command.type === "runtime_get_upgrade_obligations" ? model.upgradeObligations() : model.livenessReasons());
        parentPort.postMessage({ type: "reply", id: message.id, json: JSON.stringify(observation.reasons), metrics: metrics(), observation });
      });
      return;
    }
    if (!["runtime_get_snapshot", "runtime_subscribe", "runtime_unsubscribe"].includes(command.type)) throw new Error("Unsupported read operation");
    const indexed = command.type !== "runtime_get_snapshot" || !command.scope?.id || command.scope.background === true || await model.ensureId(command.scope.id);
    if (request.cancelled) return;
    observeExecution("request", () => {
      const state = session(message.connection);
      state.generation = message.generation; state.pending = undefined;
      let value = state.queries.handle(command);
      if (!indexed && !value.rows.length) value = { ...value, status: "rebuilding", reason: "The requested run is being indexed; retry after reconciliation." };
      parentPort.postMessage({ type: "reply", id: message.id, json: encoded.get(value) ?? JSON.stringify(value), metrics: metrics() });
    });
  } catch (error) {
    if (request.cancelled) return;
    parentPort.postMessage({ type: "reply", id: message.id, error: String(error).slice(0, 512), metrics: metrics() });
  } finally { release?.(); requests.delete(message.id); }
});
rpcInstalled = true;
void model.reconcile();
