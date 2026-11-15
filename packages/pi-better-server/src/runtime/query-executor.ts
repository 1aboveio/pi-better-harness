import { Worker } from "node:worker_threads";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { resolve } from "node:path";
import type { Duplex } from "node:stream";
import { workScope } from "./queries.ts";

export interface EncodedRead { json: string }
interface Waiter { connection: number; resolve(value: EncodedRead): void; reject(error: Error): void }
interface Query {
  id: number; key?: string; command: Record<string, unknown>; connection: number;
  enqueued: number; deadline: ReturnType<typeof setTimeout>; waiters: Set<Waiter>;
}
export type ReadStream = Pick<Duplex, "destroyed" | "writableLength" | "write" | "on" | "once" | "off">;
interface Stream { socket: ReadStream; paused: boolean; generation: number; drain: () => void; close: () => void }
interface WorkerMetrics { sqlite?: { opens: number; active: number; maximum: number }; [key: string]: unknown }
export interface QueryExecutorOptions {
  capacity?: number; timeoutMs?: number; maxConnections?: number;
  workerUrl?: URL;
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
  private workerMetrics: WorkerMetrics = {};
  private lag = monitorEventLoopDelay({ resolution: 10 });
  private waits: number[] = [];
  private completed = 0;
  private coalesced = 0;
  private rejected = 0;
  private cancelled = 0;
  private timeouts = 0;
  private durations: number[] = [];
  private options: QueryExecutorOptions;
  private livenessSnapshot: { reasons: any[]; observedAt: number | null; reason?: string } = { reasons: [], observedAt: null };
  private livenessObservation?: Promise<void>;
  readonly instanceId: string;

  constructor(agentDir: string, instanceId: string, options: QueryExecutorOptions = {}) {
    this.options = options; this.instanceId = instanceId;
    this.lag.enable();
    this.worker = new Worker(options.workerUrl ?? new URL("./query-worker.mjs", import.meta.url), {
      execArgv: [], workerData: { agentDir, instanceId, modelOptions: options.modelOptions },
    });
    this.worker.on("message", message => this.receive(message));
    this.worker.on("error", error => this.fail(new Error(`runtime-unhealthy: read worker failed: ${String(error)}`)));
    this.worker.on("exit", code => {
      this.exited = true;
      const sqlite = this.workerMetrics.sqlite;
      if (sqlite) this.workerMetrics = { ...this.workerMetrics, sqlite: { ...sqlite, active: 0 } };
      this.fail(new Error(`runtime-unhealthy: read worker exited (${code}); restart the runtime to rebuild reads`));
    });
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
    return { handle: (command: Record<string, unknown>) => this.request(connection, command), close };
  }

  async livenessReasons(): Promise<any[]> {
    const result = await this.request(0, { type: "runtime_get_liveness" });
    const reasons = JSON.parse(result.json);
    this.livenessSnapshot = { reasons, observedAt: Date.now() };
    return reasons;
  }

  /** Diagnostic observation only. Idle admission must await livenessReasons instead. */
  observeLiveness() {
    if (!this.livenessObservation && !this.failure) {
      this.livenessObservation = this.request(0, { type: "runtime_observe_liveness" }).then(result => {
        this.livenessSnapshot = { reasons: JSON.parse(result.json), observedAt: Date.now() };
      }, error => {
        this.livenessSnapshot = { ...this.livenessSnapshot, reason: String(error) };
      }).finally(() => { this.livenessObservation = undefined; });
    }
    return { ...this.livenessSnapshot, status: this.failure || this.livenessSnapshot.reason ? "degraded" : "refreshing",
      ...(this.failure ? { reason: this.failure.message } : {}) };
  }

  metrics() {
    return { ...this.workerMetrics, executor: { active: this.active ? 1 : 0, queued: this.queue.length,
      clients: this.streams.size, completed: this.completed, singleflightHits: this.coalesced, rejected: this.rejected,
      cancelled: this.cancelled, timeouts: this.timeouts,
      capacity: this.options.capacity ?? 64, waitMs: [...this.waits], readMs: [...this.durations],
      eventLoopLagMs: { p50: this.lag.percentile(50) / 1e6, p95: this.lag.percentile(95) / 1e6, p99: this.lag.percentile(99) / 1e6 },
      worker: this.exited ? "stopped" : this.failure ? "stopping" : "running",
      status: this.failure ? "degraded" : "ready" } };
  }

  private request(connection: number, input: Record<string, unknown>): Promise<EncodedRead> {
    if (connection !== 0 && !this.streams.has(connection)) return Promise.reject(new Error("runtime-unavailable: client disconnected"));
    if (input.type === "runtime_get_metrics") return Promise.resolve({ json: JSON.stringify(this.metrics()) });
    if (this.failure) return Promise.reject(this.failure);
    if (!["runtime_get_snapshot", "runtime_subscribe", "runtime_unsubscribe", "runtime_get_liveness", "runtime_observe_liveness"].includes(String(input.type))) return Promise.reject(new Error("Unsupported read operation"));
    if (input.sinceSeq !== undefined && !Number.isSafeInteger(input.sinceSeq)) return Promise.reject(new Error("Invalid replay sequence"));
    if (input.instanceId !== undefined && (typeof input.instanceId !== "string" || input.instanceId.length > 256)) return Promise.reject(new Error("Invalid runtime instance"));
    const command: Record<string, unknown> = { type: input.type, sinceSeq: input.sinceSeq, instanceId: input.instanceId };
    if (command.type !== "runtime_unsubscribe" && command.type !== "runtime_get_liveness" && command.type !== "runtime_observe_liveness") {
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
      query = { id, key, command, connection: key ? 0 : connection, enqueued: performance.now(),
        deadline: setTimeout(() => this.expire(id), this.options.timeoutMs ?? 4000), waiters: new Set() };
      this.queue.push(query);
      if (key) this.flights.set(key, query);
    }
    const admitted = query;
    const result = new Promise<EncodedRead>((resolve, reject) => admitted.waiters.add({ connection, resolve, reject }));
    this.pump();
    return result;
  }

  private pump() {
    if (this.failure || this.active || !this.queue.length) return;
    const query = this.active = this.queue.shift()!;
    this.waits.push(performance.now() - query.enqueued);
    if (this.waits.length > 128) this.waits.shift();
    const stream = this.streams.get(query.connection);
    if (stream) { stream.generation++; this.workerConnections.add(query.connection); }
    this.worker.postMessage({ type: "query", id: query.id, connection: query.connection,
      generation: stream?.generation ?? 0, command: query.command });
  }

  private receive(message: any) {
    if (this.failure) return;
    if (message.metrics) this.workerMetrics = message.metrics;
    if (message.type === "revision") { this.revision++; this.worker.postMessage({ type: "revision-consumed" }); return; }
    if (message.type === "event") {
      if (this.streams.get(message.connection)?.generation === message.generation) this.event(message.connection, message.line);
      this.worker.postMessage({ type: "event-consumed", connection: message.connection, serial: message.serial });
      return;
    }
    if (message.type !== "reply" || message.id !== this.active?.id) return;
    const query = this.active!;
    this.active = undefined; this.completed++;
    this.durations.push(performance.now() - query.enqueued);
    if (this.durations.length > 128) this.durations.shift();
    this.finish(query, message.error ? new Error(message.error) : undefined, { json: message.json });
    this.pump();
  }

  private finish(query: Query, error?: Error, value: EncodedRead = { json: "null" }) {
    clearTimeout(query.deadline);
    if (query.key && this.flights.get(query.key) === query) this.flights.delete(query.key);
    for (const waiter of query.waiters) { if (error) waiter.reject(error); else waiter.resolve(value); }
    query.waiters.clear();
  }

  private expire(id: number) {
    this.timeouts++;
    const error = new Error("runtime-unhealthy: read deadline exceeded; retry after recovery");
    if (this.active?.id === id) { this.fail(error); return; }
    const index = this.queue.findIndex(query => query.id === id);
    if (index < 0) return;
    const [query] = this.queue.splice(index, 1);
    this.finish(query!, error);
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
        query.waiters.delete(waiter); this.cancelled++; waiter.reject(new Error("runtime-unavailable: client disconnected"));
      }
      if (!query.waiters.size && query !== this.active) {
        this.queue.splice(this.queue.indexOf(query), 1);
        this.finish(query);
      }
    }
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error; this.lag.disable();
    for (const query of [...this.queue, ...(this.active ? [this.active] : [])]) this.finish(query, error);
    this.queue = []; this.active = undefined;
    for (const connection of this.streams.keys()) this.event(connection, JSON.stringify({ type: "event",
      event: { type: "resync_required", reason: error.message, instanceId: this.instanceId } }) + "\n");
    this.termination = this.worker.terminate();
    this.worker.unref();
  }

  async close() {
    this.fail(new Error("runtime-unavailable: query executor closed"));
    for (const connection of this.streams.keys()) this.detach(connection);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    // Bound graceful close even while native SQLite is still finishing a call.
    await Promise.race([this.termination, new Promise<void>(resolve => { timeout = setTimeout(resolve, 1000); })]);
    if (timeout) clearTimeout(timeout);
  }
}
