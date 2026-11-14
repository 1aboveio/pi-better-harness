import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { createAssignmentProjector } from "./domain/assignment-projection.mjs";
import { createAssignmentReader } from "./domain/assignment-observation.mjs";

export interface WorkScope { cwd?: string; sessionId?: string; id?: string; statuses?: string[]; active?: boolean; limit?: number; cursor?: string }
export interface WorkSnapshot {
  instanceId: string; runtimeEpoch: string; scopeRevision: string; seq: number;
  observedRevisionVector: { inventory: number; coordinator: string };
  status: "ready" | "rebuilding" | "degraded"; reason?: string;
  rows: Array<{ meta: any; assignment: any; sourceRevision: string }>;
  nextCursor?: string; activity: { active: number }; nextDeadline: number | null;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safeId = /^[A-Za-z0-9_-]+$/;

/** Reconstructable query state. It never authorizes execution or writes source records. */
export class WorkReadModel {
  private db: any;
  private reader: ReturnType<typeof createAssignmentReader>;
  private files = new Map<string, { signature: string; meta: any }>();
  private watchers: FSWatcher[] = [];
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private dirty = false;
  private closed = false;
  private inventory = 0;
  private coordinator = "unknown";
  private revision = 0;
  private state: WorkSnapshot["status"] = "rebuilding";
  private reason: string | undefined = "Initial source inventory is rebuilding.";
  readonly metrics = { inventories: 0, metadataReads: 0, projections: 0, coordinatorConnections: 1, indexConnections: 1 };
  readonly runs: string;
  readonly archives: string;
  readonly agentDir: string;
  readonly instanceId: string;

  constructor(agentDir: string, instanceId: string, options: { baseDir?: string; durableDir?: string; intervalMs?: number } = {}) {
    this.agentDir = agentDir; this.instanceId = instanceId;
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    this.db = new DatabaseSync(":memory:");
    this.db.exec(`CREATE TABLE rows (id TEXT PRIMARY KEY, cwd TEXT, origin_cwd TEXT, origin_session TEXT,
      started REAL, state TEXT, active INTEGER, payload TEXT);
      CREATE INDEX work_folder ON rows(cwd, started DESC, id DESC);
      CREATE INDEX work_origin ON rows(origin_cwd, origin_session, started DESC, id DESC);
      CREATE INDEX work_active ON rows(active, started DESC, id DESC);
      CREATE INDEX work_state ON rows(state, started DESC, id DESC);`);
    this.reader = createAssignmentReader(join(agentDir, "operation-coordinator.sqlite"));
    this.runs = join(options.baseDir ?? join(realpathSync(tmpdir()), "pi-better-subagents"), "runs");
    this.archives = join(options.durableDir ?? process.env.PI_SUBAGENT_DURABLE_DIR ?? join(agentDir, "subagents"), "attempts");
    // Notifications accelerate discovery; a shared bounded inventory repairs lost hints.
    for (const path of [this.runs, this.archives]) {
      try {
        const watcher = watch(path, { recursive: true }, () => { void this.reconcile(); });
        watcher.on("error", () => this.invalidate("Watcher overflow or failure; reconciling source inventory."));
        this.watchers.push(watcher);
      } catch { /* Missing roots are discovered by the compatibility inventory. */ }
    }
    this.timer = setInterval(() => { void this.reconcile(); }, options.intervalMs ?? 1000);
    this.timer.unref();
  }

  onChange(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  invalidate(reason: string) {
    this.state = "degraded"; this.reason = reason;
    this.publish();
    void this.reconcile();
  }
  private publish() { this.revision++; for (const listener of this.listeners) listener(); }

  reconcile(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pending) { this.dirty = true; return this.pending; }
    this.pending = this.scan().finally(() => {
      this.pending = undefined;
      if (this.dirty && !this.closed) { this.dirty = false; void this.reconcile(); }
    });
    return this.pending;
  }

  private async scan() {
    this.metrics.inventories++;
    try {
      const next = new Map<string, { signature: string; meta: any }>();
      let batch = 0;
      for (const [directory, archived] of [[this.archives, true], [this.runs, false]] as const) {
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
              const data = JSON.parse(await readFile(path, "utf8"));
              const meta = archived ? data.meta : data;
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
      const changed = next.size !== this.files.size || [...next].some(([path, entry]) => this.files.get(path)?.signature !== entry.signature);
      if (!changed && coordinator === this.coordinator && this.state === "ready") return;
      const metas = new Map<string, any>();
      for (const entry of next.values()) metas.set(entry.meta.id, entry.meta);
      const attempts = [...metas.values()];
      const project = createAssignmentProjector({ attempts, observe: (owner: any) => this.reader.read(owner) });
      const rows = [];
      for (const meta of attempts) {
        this.metrics.projections++;
        const assignment = project(meta, meta.status);
        rows.push({ meta, assignment, sourceRevision: hash([meta, assignment.revision]) });
        if (++batch % 256 === 0) await yieldTurn();
      }
      let after: string;
      try { after = this.reader.revision(); } catch { after = "unknown"; }
      if (after !== coordinator) { this.state = "degraded"; this.reason = "Coordinator changed during observation; retrying."; this.dirty = true; this.publish(); return; }
      if (this.closed) return;
      this.db.exec("BEGIN; DELETE FROM rows");
      const insert = this.db.prepare("INSERT INTO rows VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      try {
        for (const row of rows) {
          const m = row.meta;
          insert.run(m.id, m.cwd, m.callbackOrigin?.cwd ?? m.cwd, m.callbackOrigin?.sessionId ?? null,
            m.startedAt, row.assignment.state, ["running", "waiting"].includes(row.assignment.state) ? 1 : 0, JSON.stringify(row));
        }
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      this.files = next; this.coordinator = coordinator; this.inventory++;
      this.state = rows.some(row => !row.assignment.verified) ? "degraded" : "ready";
      this.reason = this.state === "degraded" ? "Some assignment sources could not be verified." : undefined;
      this.publish();
    } catch (error) {
      if (this.closed) return;
      this.state = "degraded"; this.reason = String(error).slice(0, 512); this.publish();
    }
  }

  snapshot(scope: WorkScope = {}): WorkSnapshot {
    const clauses: string[] = [], args: any[] = [];
    if (scope.id) { clauses.push("id = ?"); args.push(scope.id); }
    if (scope.sessionId) { clauses.push("origin_session = ? AND origin_cwd = ?"); args.push(scope.sessionId, scope.cwd); }
    else if (scope.cwd) { const cwd = resolve(scope.cwd); clauses.push("(cwd = ? OR substr(cwd, 1, ?) = ?)"); args.push(cwd, (cwd.endsWith(sep) ? cwd : cwd + sep).length, cwd.endsWith(sep) ? cwd : cwd + sep); }
    if (scope.active) clauses.push("active = 1");
    if (scope.statuses?.length) { clauses.push(`state IN (${scope.statuses.map(() => "?").join(",")})`); args.push(...scope.statuses); }
    const key = hash({ ...scope, cursor: undefined });
    if (scope.cursor) {
      let cursor;
      try { cursor = JSON.parse(Buffer.from(scope.cursor, "base64url").toString()); } catch { throw new Error("Invalid runtime cursor"); }
      if (cursor.key !== key || cursor.instanceId !== this.instanceId || cursor.revision !== this.revision) throw new Error("resync_required: cursor snapshot changed");
      clauses.push("(started < ? OR (started = ? AND id < ?))"); args.push(cursor.started, cursor.started, cursor.id);
    }
    const limit = Math.max(1, Math.min(200, Number.isSafeInteger(scope.limit) ? scope.limit! : 50));
    const records = this.db.prepare(`SELECT payload, started, id FROM rows ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""} ORDER BY started DESC, id DESC LIMIT ?`).all(...args, limit + 1);
    const page = records.slice(0, limit), last = page.at(-1);
    return { instanceId: this.instanceId, runtimeEpoch: this.instanceId, scopeRevision: hash([key, this.revision]), seq: this.revision,
      observedRevisionVector: { inventory: this.inventory, coordinator: this.coordinator }, status: this.state, reason: this.reason,
      rows: page.map((record: any) => JSON.parse(record.payload)),
      ...(records.length > limit ? { nextCursor: Buffer.from(JSON.stringify({ key, instanceId: this.instanceId, revision: this.revision, started: last.started, id: last.id })).toString("base64url") } : {}),
      activity: { active: Number(this.db.prepare("SELECT count(*) AS n FROM rows WHERE active = 1").get().n) }, nextDeadline: null };
  }

  async close() {
    this.closed = true; if (this.timer) clearInterval(this.timer);
    for (const watcher of this.watchers) watcher.close();
    await this.pending; this.listeners.clear(); this.reader.close(); this.db.close();
  }
}
