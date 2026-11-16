import { Worker } from "node:worker_threads";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { resolve } from "node:path";
import type { Duplex } from "node:stream";
import type { WorkReadModel } from "./read-model.ts";
import { workScope } from "./queries.ts";

export interface EncodedRead { json: string }
interface Waiter { connection: number; deadline: ReturnType<typeof setTimeout>; resolve(value: EncodedRead): void; reject(error: Error): void }
interface Query {
  id: number; key?: string; command: Record<string, unknown>; connection: number;
  enqueued: number; started?: number; waiters: Set<Waiter>;
}
export type ReadStream = Pick<Duplex, "destroyed" | "writableLength" | "write" | "on" | "once" | "off">;
interface Stream { socket: ReadStream; paused: boolean; generation: number; drain: () => void; close: () => void }
interface WorkerMetrics { sourceWatchers?: number; inventories?: number; coordinatorConnections?: number; indexConnections?: number; sqlite?: { opens: number; active: number; maximum: number }; [key: string]: unknown }
export interface QueryExecutorOptions {
  capacity?: number; timeoutMs?: number; maxConnections?: number; watchdogMs?: number;
  workerUrl?: URL;
  budgetBuffer?: SharedArrayBuffer;
  onTerminalLogsChanged?: (ids: string[]) => Promise<void>;
  modelOptions?: { supervisorDirectory?: string; baseDir?: string; durableDir?: string; intervalMs?: number };
}

/** One root, one read worker, one admitted operation at a time. No mutation RPC. */
export class WorkQueryExecutor {
  private worker: Worker;
  private streams = new Map<number, Stream>();
  private workerConnections = new Set<number>();
  private queue: Query[] = [];
  private active?: Query;
  private flights = new Map<string, Query>();
  private counter = 0;
  private connectionCounter = 0;
  private revision = 0;
  private failure?: Error;
  private termination?: Promise<number>;
  private exited = false;
  private closed = false;
  private workerGeneration = 0;
  private recoveryAttempts: number[] = [];
  private internalRecoveryDemand = false;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setInterval>;
  private lastResponse = performance.now();
  private workerMetrics: WorkerMetrics = {};
  private lastObservation: Omit<ReturnType<WorkReadModel["observation"]>, "observedAt"> & { observedAt: number | null } = {
    status: "rebuilding", reason: "Initial source inventory is rebuilding.", observedAt: null, reasons: [],
  };
  private lag = monitorEventLoopDelay({ resolution: 10 });
  private waits: number[] = [];
  private completed = 0;
  private coalesced = 0;
  private rejected = 0;
  private cancelled = 0;
  private timeouts = 0;
  private queueTimeouts = 0;
  private callerTimeouts = 0;
  private durations: number[] = [];
  private options: QueryExecutorOptions;
  private agentDir: string;
  readonly instanceId: string;

  constructor(agentDir: string, instanceId: string, options: QueryExecutorOptions = {}) {
    this.options = options; this.instanceId = instanceId; this.agentDir = agentDir;
    this.lag.enable();
    this.worker = this.startWorker();
    this.watchdog = setInterval(() => {
      if (!this.closed && !this.failure && performance.now() - this.lastResponse > (this.options.watchdogMs ?? 4000)) {
        this.fail(new Error("runtime-unhealthy: read worker unresponsive; watchdog deadline exceeded"));
      }
    }, Math.min(250, (this.options.watchdogMs ?? 4000) / 4));
    this.watchdog.unref();
  }

  private startWorker() {
    if (this.options.budgetBuffer) {
      // startWorker runs only initially or after the preceding thread exited.
      // A dead generation cannot retain source credits in the shared budget.
      const counts = new Int32Array(this.options.budgetBuffer);
      Atomics.store(counts, 1, 0); Atomics.store(counts, 2, 0);
    }
    const instanceId = this.workerGeneration ? `${this.instanceId}:reads:${this.workerGeneration}` : this.instanceId;
    const worker = new Worker(this.options.workerUrl ?? new URL("./query-worker.mjs", import.meta.url), {
      execArgv: [], workerData: { agentDir: this.agentDir, instanceId, modelOptions: { ...this.options.modelOptions, budgetBuffer: this.options.budgetBuffer } },
    });
    worker.on("message", message => { if (worker === this.worker) this.receive(message); });
    worker.on("error", error => { if (worker === this.worker) this.fail(new Error(`runtime-unhealthy: read worker failed: ${String(error)}`)); });
    worker.on("exit", code => {
      if (worker !== this.worker) return;
      this.exited = true;
      const sqlite = this.workerMetrics.sqlite;
      this.workerMetrics = { ...this.workerMetrics, sourceWatchers: 0, coordinatorConnections: 0, indexConnections: 0,
        ...(sqlite ? { sqlite: { ...sqlite, active: 0 } } : {}) };
      this.fail(new Error(`runtime-unhealthy: read worker exited (${code}); rebuilding reads after recovery`));
      this.scheduleRecovery();
    });
    return worker;
  }

  private scheduleRecovery() {
    if (this.closed || !this.exited || this.recoveryTimer || (!this.streams.size && !this.internalRecoveryDemand)) return;
    const now = Date.now();
    this.recoveryAttempts = this.recoveryAttempts.filter(attempt => now - attempt < 60_000);
    if (this.recoveryAttempts.length >= 2) {
      if (!this.failure?.message.includes("recovery budget exhausted")) {
        this.failure = new Error(`${this.failure?.message}; automatic read recovery budget exhausted`);
      }
      return;
    }
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      if (this.closed || (!this.streams.size && !this.internalRecoveryDemand)) return;
      this.recoveryAttempts.push(Date.now());
      this.workerGeneration++;
      this.internalRecoveryDemand = false;
      this.exited = false; this.failure = undefined; this.termination = undefined;
      this.workerMetrics = {}; this.workerConnections.clear(); this.revision++;
      this.lastResponse = performance.now();
      this.lastObservation = { status: "rebuilding", reason: "Read worker is recovering its source inventory.", observedAt: null, reasons: [] };
      this.lag.reset(); this.lag.enable();
      try { this.worker = this.startWorker(); }
      catch (error) {
        this.exited = true; this.lag.disable();
        this.failure = new Error(`runtime-unhealthy: read worker restart failed: ${String(error)}`);
        this.scheduleRecovery();
        return;
      }
      for (const connection of this.streams.keys()) this.event(connection, JSON.stringify({ type: "event",
        event: { type: "resync_required", reason: "read-worker-recovered", instanceId: this.instanceId } }) + "\n");
    }, 500);
    this.recoveryTimer.unref();
  }

  connect(socket: ReadStream) {
    if (this.streams.size >= (this.options.maxConnections ?? 64)) throw new Error("runtime-overloaded: too many read clients; retry later");
    const connection = ++this.connectionCounter;
    const drain = () => {
      const stream = this.streams.get(connection);
      if (!stream?.paused) return;
      stream.paused = false;
      this.event(connection, JSON.stringify({ type: "event", event: { type: "resync_required", reason: "slow-reader", instanceId: this.instanceId } }) + "\n");
    };
    const close = () => this.detach(connection);
    this.streams.set(connection, { socket, paused: false, generation: 0, drain, close });
    socket.on("drain", drain); socket.once("close", close);
    if (this.failure) this.scheduleRecovery();
    return { handle: (command: Record<string, unknown>) => this.request(connection, command), close };
  }

  async snapshot(scope: Record<string, unknown>): Promise<any> { return JSON.parse((await this.request(0, {type:"runtime_get_snapshot",scope})).json); }

  async upgradeObligations(): Promise<any[]> {
    return JSON.parse((await this.request(0, { type: "runtime_get_upgrade_obligations" })).json);
  }
  async livenessReasons(): Promise<any[]> {
    const result = await this.request(0, { type: "runtime_get_liveness" });
    return JSON.parse(result.json);
  }

  observation() {
    return this.failure ? { ...this.lastObservation, status: "degraded" as const, reason: this.failure.message } : this.lastObservation;
  }

  metrics() {
    return { ...this.workerMetrics, executor: { active: this.active ? 1 : 0, queued: this.queue.length,
      clients: this.streams.size, completed: this.completed, singleflightHits: this.coalesced, rejected: this.rejected,
      cancelled: this.cancelled, timeouts: this.timeouts, queueTimeouts: this.queueTimeouts, callerTimeouts: this.callerTimeouts,
      capacity: this.options.capacity ?? 64, waitMs: [...this.waits], readMs: [...this.durations],
      eventLoopLagMs: { p50: this.lag.percentile(50) / 1e6, p95: this.lag.percentile(95) / 1e6, p99: this.lag.percentile(99) / 1e6 },
      worker: this.exited ? "stopped" : this.failure ? "stopping" : "running",
      restarts: this.workerGeneration, recoveryPending: !!this.recoveryTimer,
      status: this.failure ? "degraded" : "ready" } };
  }

  private request(connection: number, input: Record<string, unknown>): Promise<EncodedRead> {
    if (connection !== 0 && !this.streams.has(connection)) return Promise.reject(new Error("runtime-unavailable: client disconnected"));
    if (input.type === "runtime_get_metrics") return Promise.resolve({ json: JSON.stringify(this.metrics()) });
    if (this.failure) {
      if (connection === 0) this.internalRecoveryDemand = true;
      this.scheduleRecovery(); return Promise.reject(this.failure);
    }
    if (input.sinceSeq !== undefined && !Number.isSafeInteger(input.sinceSeq)) return Promise.reject(new Error("Invalid replay sequence"));
    if (input.instanceId !== undefined && (typeof input.instanceId !== "string" || input.instanceId.length > 256)) return Promise.reject(new Error("Invalid runtime instance"));
    if (input.type === "runtime_unsubscribe") {
      for (const query of [...this.queue, ...(this.active ? [this.active] : [])]) {
        if (query.command.type !== "runtime_subscribe" || query.connection !== connection) continue;
        this.finish(query, new Error("runtime-unavailable: subscription cancelled"));
        this.release(query);
      }
      const stream = this.streams.get(connection);
      if (stream) stream.generation++;
      this.worker.postMessage({ type: "detach", connection });
      this.workerConnections.delete(connection);
      return Promise.resolve({ json: '{"unsubscribed":true}' });
    }
    if (!["runtime_get_snapshot", "runtime_subscribe", "runtime_unsubscribe", "runtime_get_liveness", "runtime_get_upgrade_obligations"].includes(String(input.type))) return Promise.reject(new Error("Unsupported read operation"));
    const command: Record<string, unknown> = { type: input.type, sinceSeq: input.sinceSeq, instanceId: input.instanceId };
    if (command.type !== "runtime_unsubscribe" && command.type !== "runtime_get_liveness" && command.type !== "runtime_get_upgrade_obligations") {
      const scope = workScope(input.scope);
      if (scope.cwd) scope.cwd = resolve(scope.cwd);
      scope.limit ??= scope.backgroundHistory ? 10 : 50;
      scope.detail ||= undefined;
      scope.statuses = scope.statuses?.length ? [...new Set(scope.statuses)].sort() : undefined;
      command.scope = scope;
    }
    const key = command.type === "runtime_get_snapshot" ? JSON.stringify([this.revision, command.scope]) : undefined;
    let query = key ? this.flights.get(key) : undefined;
    if (query) this.coalesced++;
    else {
      if (this.queue.length + (this.active ? 1 : 0) >= (this.options.capacity ?? 64)) {
        this.rejected++;
        return Promise.reject(new Error("runtime-overloaded: read queue is full; retry later"));
      }
      const id = ++this.counter;
      query = { id, key, command, connection: key ? 0 : connection, enqueued: performance.now(), waiters: new Set() };
      this.queue.push(query);
      if (key) this.flights.set(key, query);
    }
    const admitted = query;
    const result = new Promise<EncodedRead>((resolve, reject) => {
      const waiter: Waiter = { connection, resolve, reject,
        deadline: setTimeout(() => this.expire(admitted, waiter), this.options.timeoutMs ?? 4000) };
      admitted.waiters.add(waiter);
    });
    this.pump();
    return result;
  }

  private pump() {
    if (this.failure || this.active || !this.queue.length) return;
    const query = this.active = this.queue.shift()!;
    query.started = performance.now();
    this.waits.push(performance.now() - query.enqueued);
    if (this.waits.length > 128) this.waits.shift();
    const stream = this.streams.get(query.connection);
    if (stream) { stream.generation++; this.workerConnections.add(query.connection); }
    this.worker.postMessage({ type: "query", id: query.id, connection: query.connection,
      generation: stream?.generation ?? 0, command: query.command });
  }

  private receive(message: any) {
    if (this.failure) return;
    this.lastResponse = performance.now();
    if (message.type === "heartbeat") { this.worker.postMessage({ type: "heartbeat-consumed" }); return; }
    // Replies to cancelled reads carry no fresh observation or metrics authority.
    if (message.type === "reply" && (!this.active || message.id !== this.active.id || !this.active.waiters.size)) {
      if (message.id === this.active?.id) { this.active = undefined; this.pump(); }
      return;
    }
    if (message.metrics) this.workerMetrics = message.metrics;
    if (message.observation) this.lastObservation = message.observation;
    if (message.type === "terminal-logs") {
      const sourceWorker = this.worker;
      const ids = Array.isArray(message.ids) ? message.ids.filter((id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id)).slice(0, 128) : [];
      void Promise.resolve().then(() => this.options.onTerminalLogsChanged?.(ids)).then(
        () => { if (!this.failure && this.worker === sourceWorker) sourceWorker.postMessage({ type: "terminal-logs-consumed" }); },
        error => { if (!this.failure && this.worker === sourceWorker) this.fail(new Error(`runtime-unhealthy: terminal failure supervision failed: ${String(error)}`)); },
      );
      return;
    }
    if (message.type === "revision") { this.revision++; this.worker.postMessage({ type: "revision-consumed" }); return; }
    if (message.type === "event") {
      if (this.streams.get(message.connection)?.generation === message.generation) this.event(message.connection, message.line);
      this.worker.postMessage({ type: "event-consumed", connection: message.connection, serial: message.serial });
      return;
    }
    if (message.type !== "reply" || message.id !== this.active?.id) return;
    const query = this.active!;
    this.active = undefined; this.completed++;
    this.durations.push(performance.now() - query.started!);
    if (this.durations.length > 128) this.durations.shift();
    this.finish(query, message.error ? new Error(message.error) : undefined, { json: message.json });
    this.pump();
  }

  private finish(query: Query, error?: Error, value: EncodedRead = { json: "null" }) {
    if (query.key && this.flights.get(query.key) === query) this.flights.delete(query.key);
    for (const waiter of query.waiters) { clearTimeout(waiter.deadline); if (error) waiter.reject(error); else waiter.resolve(value); }
    query.waiters.clear();
  }

  private expire(query: Query, waiter: Waiter) {
    if (!query.waiters.delete(waiter)) return;
    this.timeouts++;
    if (query === this.active) this.callerTimeouts++;
    else this.queueTimeouts++;
    waiter.reject(new Error(query === this.active
      ? "runtime-timeout: caller read deadline exceeded; source was not verified"
      : "runtime-overloaded: queued read deadline exceeded; retry later"));
    this.release(query);
  }

  private release(query: Query) {
    if (query.waiters.size) return;
    this.finish(query);
    if (query === this.active) {
      // Keep the execution slot until cancellation is acknowledged. This bounds
      // the worker mailbox even when native work cannot be interrupted.
      this.worker.postMessage({ type: "cancel", id: query.id });
    } else {
      const index = this.queue.indexOf(query);
      if (index >= 0) this.queue.splice(index, 1);
    }
  }

  private event(connection: number, line: string) {
    const stream = this.streams.get(connection);
    if (!stream || stream.socket.destroyed || stream.paused) return;
    if (stream.socket.writableLength > 4 * 1024 * 1024) { stream.paused = true; return; }
    stream.socket.write(line);
  }

  private detach(connection: number) {
    const stream = this.streams.get(connection);
    if (!stream) return;
    stream.socket.off("drain", stream.drain); stream.socket.off("close", stream.close);
    this.streams.delete(connection);
    if (this.workerConnections.delete(connection) && !this.failure) this.worker.postMessage({ type: "detach", connection });
    for (const query of [...this.queue, ...(this.active ? [this.active] : [])]) {
      for (const waiter of query.waiters) if (waiter.connection === connection) {
        query.waiters.delete(waiter); clearTimeout(waiter.deadline); this.cancelled++; waiter.reject(new Error("runtime-unavailable: client disconnected"));
      }
      this.release(query);
    }
  }

  private fail(error: Error) {
    if (this.failure) return;
    if ([...this.queue, ...(this.active ? [this.active] : [])].some(query =>
      [...query.waiters].some(waiter => waiter.connection === 0))) this.internalRecoveryDemand = true;
    this.failure = error; this.lag.disable();
    for (const query of [...this.queue, ...(this.active ? [this.active] : [])]) this.finish(query, error);
    this.queue = []; this.active = undefined;
    for (const connection of this.streams.keys()) this.event(connection, JSON.stringify({ type: "event",
      event: { type: "resync_required", reason: error.message, instanceId: this.instanceId } }) + "\n");
    this.termination = this.worker.terminate();
    this.worker.unref();
  }

  async close() {
    this.closed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.recoveryTimer) { clearTimeout(this.recoveryTimer); this.recoveryTimer = undefined; }
    this.fail(new Error("runtime-unavailable: query executor closed"));
    for (const connection of this.streams.keys()) this.detach(connection);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    // Bound graceful close even while native SQLite is still finishing a call.
    await Promise.race([this.termination, new Promise<void>(resolve => { timeout = setTimeout(resolve, 1000); })]);
    if (timeout) clearTimeout(timeout);
  }
}
