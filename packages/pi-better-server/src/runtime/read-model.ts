import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join, resolve, sep } from "node:path";
import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { createAssignmentProjector } from "./domain/assignment-projection.mjs";
import { createAssignmentReader } from "./domain/assignment-observation.mjs";
import { parseArchivedAttempt, parseArchivedSessionState } from "./domain/session-store.mjs";
import { parseRun, readRunTranscript } from "./domain/parse.mjs";
import { fmtSpend } from "./domain/widget.mjs";
import { effectiveStatus } from "./domain/process-status.mjs";
import { extractChildEventFactsFromLog, healthThresholdsForConfig } from "./domain/health-observation.mjs";
import { BackgroundObservation } from "./background.ts";
import { readHealthConfig } from "./health-config.ts";

export interface WorkScope { processId?: number; backgroundAll?: boolean; background?: boolean; backgroundHistory?: boolean; cwd?: string; sessionId?: string; id?: string; statuses?: string[]; active?: boolean; endedAfter?: number; detail?: boolean; limit?: number; cursor?: string }
export interface WorkSnapshot {
  instanceId: string; runtimeEpoch: string; scopeRevision: string; seq: number;
  observedRevisionVector: { inventory: number; coordinator: string; healthConfig: string };
  status: "ready" | "rebuilding" | "degraded"; reason?: string;
  rows: Array<{ meta: any; assignment: any; sourceRevision: string }>;
  nextCursor?: string; activity: { active: number }; nextDeadline: number | null;
  totalMatching: number;
  backgroundIndex?: any;
  resyncRequired?: boolean; resyncReason?: string;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safeId = /^[A-Za-z0-9_-]+$/;

/** Reconstructable query state. It never authorizes execution or writes source records. */
export class WorkReadModel {
  private background: BackgroundObservation;
  private db: any;
  private reader: ReturnType<typeof createAssignmentReader>;
  private files = new Map<string, { signature: string; meta: any }>();
  private projected = new Map<string, { meta: any; assignment: any; sourceRevision: string; display?: { spend: string; tool: string }; health?: any }>();
  private logs = new Map<string, string>();
  private processes = new Map<string, string>();
  private healthRevision = "";
  private details = new Map<string, { revision: string; value: any }>();
  private watchers: FSWatcher[] = [];
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private dirty = false;
  private closed = false;
  private inventory = 0;
  private coordinator = "unknown";
  private coordinatorConversations?: Map<string, string>;
  private revision = 0;
  private state: WorkSnapshot["status"] = "rebuilding";
  private reason: string | undefined = "Initial source inventory is rebuilding.";
  readonly metrics = { inventories: 0, metadataReads: 0, projections: 0, coordinatorConnections: 1, indexConnections: 1 };
  readonly runs: string;
  readonly archives: string;
  readonly markers: string;
  readonly agentDir: string;
  readonly instanceId: string;

  constructor(agentDir: string, instanceId: string, options: { supervisorDirectory?: string; baseDir?: string; durableDir?: string; intervalMs?: number } = {}) {
    this.agentDir = agentDir; this.instanceId = instanceId;
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    this.db = new DatabaseSync(":memory:");
    this.background = new BackgroundObservation(agentDir, options.supervisorDirectory, this.db, () => this.publish());
    this.db.exec(`CREATE TABLE rows (id TEXT PRIMARY KEY, cwd TEXT, origin_cwd TEXT, origin_session TEXT,
      started REAL, state TEXT, active INTEGER, ended REAL, payload TEXT);
      CREATE INDEX work_folder ON rows(cwd, started DESC, id DESC);
      CREATE INDEX work_origin ON rows(origin_cwd, origin_session, started DESC, id DESC);
      CREATE INDEX work_active ON rows(active, started DESC, id DESC);
      CREATE INDEX work_terminal ON rows(active, ended, started DESC, id DESC);
      CREATE INDEX work_state ON rows(state, started DESC, id DESC);`);
    this.reader = createAssignmentReader(join(agentDir, "operation-coordinator.sqlite"));
    this.runs = join(options.baseDir ?? join(realpathSync(tmpdir()), "pi-better-subagents"), "runs");
    this.archives = join(options.durableDir ?? process.env.PI_SUBAGENT_DURABLE_DIR ?? join(agentDir, "subagents"), "attempts");
    this.markers = join(this.archives, "../session-state");
    // Notifications accelerate discovery; a shared bounded inventory repairs lost hints.
    for (const path of [this.runs, this.archives, this.markers]) {
      try {
        const watcher = watch(path, { recursive: true }, () => { void this.reconcile(); });
        watcher.on("error", () => this.invalidate("Watcher overflow or failure; reconciling source inventory."));
        this.watchers.push(watcher);
      } catch { /* Missing roots are discovered by the compatibility inventory. */ }
    }
    this.timer = setInterval(() => { void this.reconcile(); }, options.intervalMs ?? 1000);
    this.timer.unref();
  }

  onChange(listener: () => void, scope?: WorkScope) {
    const release = scope?.background ? this.background.retain(scope) : undefined;
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); release?.(); };
  }
  get backgroundMetrics() { return { ...this.background.metrics, scopes: this.background.scopeCount, history: this.background.historyMetrics }; }
  async ensureId(id: string) {
    if (!safeId.test(id)) throw new Error("Invalid run ID");
    if (this.state === "rebuilding") await this.reconcile();
    if (this.db.prepare("SELECT id FROM rows WHERE id = ?").get(id)) return;
    try { await stat(join(this.runs, id, "meta.json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    // An exact-ID read may race the writer's atomic replacement during inventory.
    // Join the bounded repair passes before treating that freshly written ID as absent.
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.reconcile();
      if (this.db.prepare("SELECT id FROM rows WHERE id = ?").get(id) || !this.dirty) break;
      await yieldTurn();
    }
  }
  invalidate(reason: string) {
    this.state = "degraded"; this.reason = reason;
    this.publish();
    void this.reconcile();
  }
  private publish() { this.revision++; for (const listener of this.listeners) listener(); }

  reconcile(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pending) { this.dirty = true; return this.pending; }
    this.pending = (async () => {
      for (let pass = 0; pass < 2; pass++) {
        this.dirty = false;
        await this.scan();
        if (!this.dirty || this.closed) break;
      }
    })().finally(() => {
      this.pending = undefined;
      if (this.dirty && !this.closed) { this.dirty = false; void this.reconcile(); }
    });
    return this.pending;
  }

  private async scan() {
    this.metrics.inventories++;
    if (this.background.refresh()) this.publish();
    try {
      const next = new Map<string, { signature: string; meta: any }>();
      let batch = 0;
      for (const [directory, archived] of [[this.markers, true], [this.archives, true], [this.runs, false]] as const) {
        let names: string[];
        try { names = await readdir(directory); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        for (const name of names) {
          const id = archived ? name.replace(/\.json$/, "") : name;
          if (!safeId.test(id) || (archived && !name.endsWith(".json"))) continue;
          const path = archived ? join(directory, name) : join(directory, name, "meta.json");
          try {
            const info = await stat(path, { bigint: true });
            const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
            let entry = this.files.get(path);
            if (entry?.signature !== signature) {
              this.metrics.metadataReads++;
              const raw = await readFile(path, "utf8");
              if (directory === this.markers) {
                const marker = parseArchivedSessionState(raw, id);
                if (!marker) throw new Error(`Unusable session marker: ${id}`);
                entry = { signature, meta: marker };
                next.set(path, entry);
                continue;
              }
              const meta = archived ? parseArchivedAttempt(raw, id, join(this.archives, "../sessions")) : JSON.parse(raw);
              if (meta?.id !== id || typeof meta.cwd !== "string" || !Number.isFinite(meta.startedAt) || typeof meta.status !== "string") throw new Error(`Unusable run record: ${id}`);
              entry = { signature, meta };
            }
            next.set(path, entry!);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (++batch % 256 === 0) await yieldTurn();
          if (this.closed) return;
        }
      }
      let coordinator: string;
      try { coordinator = this.reader.revision(); } catch { coordinator = "unknown"; }
      const coordinatorConversations = coordinator === this.coordinator ? this.coordinatorConversations : this.reader.conversationRevisions();
      const logs = new Map<string, string>();
      const processes = new Map<string, string>();
      const logFamilies = new Set<string>();
      for (const [path, entry] of next) {
        if (!path.startsWith(this.runs + sep)) continue;
        let signature = this.logs.get(entry.meta.id);
        {
          try {
            const info = await stat(join(this.runs, entry.meta.id, "output.log"), { bigint: true });
            signature = `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
          } catch (error) { signature = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unverified"; }
        }
        logs.set(entry.meta.id, signature);
        if (signature !== this.logs.get(entry.meta.id)) logFamilies.add(JSON.stringify([entry.meta.sessionId, entry.meta.cwd]));
        const status = effectiveStatus(entry.meta); processes.set(entry.meta.id, status);
        if (status !== this.processes.get(entry.meta.id)) logFamilies.add(JSON.stringify([entry.meta.sessionId, entry.meta.cwd]));
      }
      const healthConfig = readHealthConfig(this.agentDir);
      const changed = next.size !== this.files.size || [...next].some(([path, entry]) => this.files.get(path)?.signature !== entry.signature);
      if (!changed && !logFamilies.size && coordinator === this.coordinator && healthConfig.revision === this.healthRevision && this.state === "ready") return;
      const metas = new Map<string, any>();
      const markers = new Map([...next].filter(([path]) => path.startsWith(this.markers + sep)).map(([, entry]) => [entry.meta.sessionId, entry.meta]));
      for (const [path, entry] of next) {
        if (path.startsWith(this.markers + sep)) continue;
        const marker = markers.get(entry.meta.sessionId);
        if (path.startsWith(this.archives + sep) && marker && marker.attemptId !== entry.meta.id && marker.startedAt >= entry.meta.startedAt) continue;
        metas.set(entry.meta.id, entry.meta);
      }
      const attempts = [...metas.values()];
      const affected = new Set<string>(logFamilies);
      const family = (meta: any) => JSON.stringify([meta.sessionId, meta.cwd]);
      for (const [path, entry] of [...this.files, ...next]) {
        if (this.files.get(path)?.signature !== next.get(path)?.signature) affected.add(family(entry.meta));
      }
      if (coordinator !== this.coordinator) for (const meta of attempts) {
        if (!(meta.assignment || meta.operations || meta.park)) continue;
        const owner = JSON.stringify([meta.operations?.conversationId ?? meta.sessionId, meta.operations?.workspace ?? meta.cwd]);
        if (!coordinatorConversations || !this.coordinatorConversations ||
            coordinatorConversations.get(owner) !== this.coordinatorConversations.get(owner)) affected.add(family(meta));
      }
      const project = createAssignmentProjector({ attempts, observe: (owner: any) => this.reader.read(owner) });
      const rows = [];
      for (const meta of attempts) {
        let row = this.projected.get(meta.id);
        if (!row || !row.assignment.verified || healthConfig.revision !== this.healthRevision || affected.has(family(meta))) {
          this.metrics.projections++;
          const assignment = project(meta, processes.get(meta.id) ?? meta.status);
          const parsed = logs.get(meta.id) && logs.get(meta.id) !== "missing" ? parseRun(meta.id, { logPath: join(this.runs, meta.id, "output.log") }) : undefined;
          const display = { spend: parsed ? fmtSpend(parsed.usage) : "", tool: parsed?.toolCalls.at(-1) ?? "" };
          const health = logs.has(meta.id) ? { ...extractChildEventFactsFromLog(meta.id, { logPath: join(this.runs, meta.id, "output.log") }), thresholds: healthThresholdsForConfig(healthConfig.config) } : undefined;
          row = { meta, assignment, display, health, sourceRevision: hash([meta, assignment.revision, display, health]) };
        }
        rows.push(row);
        if (++batch % 256 === 0) await yieldTurn();
      }
      let after: string;
      try { after = this.reader.revision(); } catch { after = "unknown"; }
      if (after !== coordinator) { this.state = "degraded"; this.reason = "Coordinator changed during observation; retrying."; this.dirty = true; this.publish(); return; }
      for (const [path, entry] of next) {
        if (!affected.has(family(entry.meta))) continue;
        const info = await stat(path, { bigint: true });
        if (`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` !== entry.signature) {
          this.dirty = true;
          throw new Error("Source changed during observation; retaining the previous snapshot while reconciling.");
        }
        if (++batch % 256 === 0) await yieldTurn();
      }
      if (this.closed) return;
      this.db.exec("BEGIN");
      const insert = this.db.prepare("INSERT OR REPLACE INTO rows VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const remove = this.db.prepare("DELETE FROM rows WHERE id = ?");
      let semanticChange = false;
      try {
        for (const id of this.projected.keys()) if (!metas.has(id)) { remove.run(id); semanticChange = true; }
        for (const row of rows) {
          if (this.projected.get(row.meta.id)?.sourceRevision === row.sourceRevision) continue;
          semanticChange = true;
          const m = row.meta;
          insert.run(m.id, m.cwd, m.callbackOrigin?.cwd ?? m.cwd, m.callbackOrigin?.sessionId ?? null,
            m.startedAt, row.assignment.state, ["running", "waiting"].includes(row.assignment.state) ? 1 : 0, m.endedAt ?? m.lostAt ?? null, JSON.stringify(row));
        }
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      this.files = next; this.logs = logs; this.processes = processes; this.healthRevision = healthConfig.revision; this.coordinator = coordinator; this.inventory++;
      this.coordinatorConversations = coordinatorConversations;
      this.projected = new Map(rows.map(row => [row.meta.id, row]));
      const previousState = this.state;
      const previousReason = this.reason;
      this.state = rows.some(row => !row.assignment.verified) ? "degraded" : "ready";
      this.reason = this.state === "degraded" ? "Some assignment sources could not be verified." : undefined;
      if (semanticChange || previousState !== this.state || previousReason !== this.reason) this.publish();
    } catch (error) {
      if (this.closed) return;
      this.state = "degraded"; this.reason = String(error).slice(0, 512); this.publish();
    }
  }

  snapshot(scope: WorkScope = {}): WorkSnapshot {
    if (scope.background) {
      if (scope.backgroundHistory && this.background.refresh()) this.publish();
      const index = scope.backgroundHistory ? this.background.historyIndex(scope) : undefined;
      const tasks = this.background.read(scope, index);
      const status = this.background.status === "degraded" ? "degraded" : index ? this.background.historyStatus : this.background.status;
      this.metrics.coordinatorConnections = 1 + this.background.connectionCount;
      return { instanceId: this.instanceId, runtimeEpoch: this.instanceId, scopeRevision: hash([scope, tasks, status, index?.page]), seq: this.revision,
        observedRevisionVector: { inventory: this.inventory, coordinator: this.coordinator, healthConfig: this.healthRevision },
        status, reason: this.background.reason ?? (index ? this.background.historyReason : undefined),
        rows: tasks.map(meta => ({ meta, assignment: null, sourceRevision: hash(meta) })), totalMatching: index?.page.total ?? tasks.length,
        ...(index?.page.nextCursor ? { nextCursor: index.page.nextCursor } : {}),
        ...(index ? { backgroundIndex: index } : {}),
        activity: { active: (index ? this.background.read({ ...scope, backgroundHistory: false, active: true }) : tasks).filter(task => task.durable ? task.active : task.status === "running").length }, nextDeadline: null };
    }
    const clauses: string[] = [], args: any[] = [];
    if (scope.id) { clauses.push("id = ?"); args.push(scope.id); }
    if (scope.sessionId) { clauses.push("origin_session = ? AND origin_cwd = ?"); args.push(scope.sessionId, scope.cwd); }
    else if (scope.cwd) { const cwd = resolve(scope.cwd); clauses.push("(cwd = ? OR substr(cwd, 1, ?) = ?)"); args.push(cwd, (cwd.endsWith(sep) ? cwd : cwd + sep).length, cwd.endsWith(sep) ? cwd : cwd + sep); }
    // Activity describes the scope, independently of history filters and pagination.
    const active = Number(this.db.prepare(`SELECT count(*) AS n FROM rows WHERE ${[...clauses, "active = 1"].join(" AND ")}`).get(...args).n);
    if (scope.active !== undefined) { clauses.push("active = ?"); args.push(scope.active ? 1 : 0); }
    if (scope.endedAfter !== undefined) { clauses.push("(ended IS NULL OR ended >= ?)"); args.push(scope.endedAfter); }
    if (scope.statuses?.length) { clauses.push(`state IN (${scope.statuses.map(() => "?").join(",")})`); args.push(...scope.statuses); }
    const key = hash({ ...scope, cursor: undefined });
    const totalMatching = Number(this.db.prepare(`SELECT count(*) AS n FROM rows ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""}`).get(...args).n);
    if (scope.cursor) {
      let cursor;
      try { cursor = JSON.parse(Buffer.from(scope.cursor, "base64url").toString()); } catch { throw new Error("Invalid runtime cursor"); }
      if (!Array.isArray(cursor) || cursor[0] !== key || cursor[1] !== this.instanceId || cursor[2] !== this.revision) throw new Error("resync_required: cursor snapshot changed");
      clauses.push("(started < ? OR (started = ? AND id < ?))"); args.push(cursor[3], cursor[3], cursor[4]);
    }
    const limit = Math.max(1, Math.min(200, Number.isSafeInteger(scope.limit) ? scope.limit! : 50));
    const records = this.db.prepare(`SELECT payload, started, id FROM rows ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""} ORDER BY started DESC, id DESC LIMIT ?`).all(...args, limit + 1);
    const page = records.slice(0, limit), last = page.at(-1);
    return { instanceId: this.instanceId, runtimeEpoch: this.instanceId, scopeRevision: hash([key, this.revision]), seq: this.revision,
      observedRevisionVector: { inventory: this.inventory, coordinator: this.coordinator, healthConfig: this.healthRevision }, status: this.state, reason: this.reason,
      totalMatching,
      rows: page.map((record: any) => {
        const row = JSON.parse(record.payload);
        if (scope.detail && scope.id) {
          let cached = this.details.get(row.meta.id);
          if (!cached || cached.revision !== row.sourceRevision) {
            const logPath = join(this.runs, row.meta.id, "output.log");
            const expectedLog = this.logs.get(row.meta.id) ?? "missing";
            const signature = () => {
              try { const info = statSync(logPath, { bigint: true }); return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`; }
              catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unverified"; }
            };
            if (signature() !== expectedLog) throw new Error("state-degraded: log changed since the indexed observation; resync required");
            const value = { parsed: parseRun(row.meta.id, { logPath }), transcript: readRunTranscript(row.meta.id, { logPath }) };
            if (signature() !== expectedLog) throw new Error("state-degraded: log changed during detail observation; resync required");
            if (Buffer.byteLength(JSON.stringify(value)) > 3 * 1024 * 1024) throw new Error("state-degraded: detail exceeds the bounded snapshot allowance");
            cached = { revision: row.sourceRevision, value }; this.details.set(row.meta.id, cached);
            if (this.details.size > 16) this.details.delete(this.details.keys().next().value!);
          }
          row.detail = cached.value;
        }
        return { ...row, cursor: Buffer.from(JSON.stringify([key, this.instanceId, this.revision, record.started, record.id])).toString("base64url") };
      }),
      ...(records.length > limit ? { nextCursor: Buffer.from(JSON.stringify([key, this.instanceId, this.revision, last.started, last.id])).toString("base64url") } : {}),
      activity: { active }, nextDeadline: null };
  }

  async close() {
    this.closed = true; if (this.timer) clearInterval(this.timer);
    for (const watcher of this.watchers) watcher.close();
    await this.pending; this.listeners.clear(); await this.background.close(); this.reader.close(); this.db.close();
  }
}
