import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { watch, statSync, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type { WorkScope } from "./read-model.ts";
// @ts-expect-error Generated canonical cursor and scope functions.
import { rowCursorKey, pageRows, sessionScopeKey } from "./domain/shared-log-utils.mjs";
// @ts-expect-error Generated canonical passive registry inspection.
import { inspectMeta, tasksDir } from "./domain/background/registry.mjs";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function identity(path: string): Promise<string> {
  try { const s = await stat(path, { bigint: true }); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
}
function currentIdentity(path: string): string {
  try { const s = statSync(path, { bigint: true }); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
}

/** Explicit history builds share the root index; ordinary activity never opens the archive. */
export class BackgroundHistory {
  private db: any;
  private directory: string;
  private source: () => any;
  private project: (operations: any[]) => any[];
  private changed: () => void;
  private pending?: Promise<void>;
  private completed = 0;
  private version = "";
  private closed = false;
  private generation = 0;
  private watchers = new Map<string, FSWatcher>();
  private activated = false;
  private scheduled = false;
  private timer?: ReturnType<typeof setInterval>;
  private changes = 0;
  status: "ready" | "rebuilding" | "degraded" = "rebuilding";
  reason?: string;
  readonly metrics = { inventories: 0, metadataReads: 0, projections: 0 };

  constructor(db: any, directory: string, source: () => any, project: (operations: any[]) => any[], changed: () => void) {
    this.db = db; this.directory = directory; this.source = source; this.project = project; this.changed = changed;
    db.exec(`CREATE TABLE background_history (key TEXT PRIMARY KEY, id TEXT, workspace TEXT, session TEXT,
      known INTEGER, unreadable INTEGER, state TEXT, started REAL, payload TEXT, signature TEXT, failure TEXT, spawn_pid INTEGER, active INTEGER, context TEXT);
      CREATE INDEX background_history_scope ON background_history(workspace, session, state, started DESC, id DESC);
      CREATE INDEX background_history_process ON background_history(workspace, session, spawn_pid, state, started DESC, id DESC);
      CREATE INDEX background_history_state ON background_history(state, started DESC, id DESC);
      CREATE INDEX background_history_order ON background_history(started DESC, id DESC);
      CREATE TABLE background_history_revisions (workspace TEXT, session TEXT, state TEXT, content INTEGER, failure INTEGER,
        PRIMARY KEY (workspace, session, state));`);
  }

  private sourceVersion() {
    const db = this.source();
    const roots = [tasksDir(), join(this.directory, "observed")].map(path => {
      try { const s = statSync(path, { bigint: true }); return `${s.dev}:${s.ino}:${s.mtimeNs}:${s.ctimeNs}`; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
    });
    return JSON.stringify([db ? db.prepare("PRAGMA data_version").get().data_version : "absent", roots]);
  }

  private observeSources() {
    for (const path of [dirname(tasksDir()), this.directory]) {
      if (this.watchers.has(path)) continue;
      try {
        const watcher = watch(path, { recursive: true }, (_event, file) => {
          if (!file || /(?:meta|result|lost|launch|claim)\.json$|failures\.jsonl(?:\.observed)?$|^observed[/\\].*\.json$/.test(String(file))) this.invalidate();
        });
        watcher.on("error", () => { this.watchers.delete(path); watcher.close(); this.status = "degraded"; this.reason = "Background history watcher failed; reconciling source signatures"; this.invalidate(); });
        this.watchers.set(path, watcher);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  invalidate() {
    this.completed = 0; this.generation++;
    if (!this.activated || this.closed || this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => { this.scheduled = false; if (!this.closed && !this.pending) this.startRefresh(); });
  }

  private startRefresh(version?: string) {
    if (this.closed || this.pending) return;
    const previous = this.status, changes = this.changes;
    this.status = "rebuilding";
    this.pending = Promise.resolve().then(() => this.refresh(version ?? this.sourceVersion())).catch(error => {
      if (!this.closed) { this.status = "degraded"; this.reason = String(error); }
    }).finally(() => {
      this.pending = undefined;
      if (this.closed) return;
      if (changes !== this.changes || previous !== this.status) this.changed();
      if (this.status === "rebuilding") this.invalidate();
    });
  }

  read(scope: WorkScope) {
    this.observeSources();
    if (!this.activated) {
      this.activated = true;
      this.timer = setInterval(() => this.startRefresh(), 30000); this.timer.unref();
    }
    const version = this.sourceVersion();
    // Legacy writers have no entity notification yet; share one slower signature inventory.
    if (!this.pending && (this.version !== version || Date.now() - this.completed >= 30000)) {
      this.startRefresh(version);
    }
    const resource = `list:${sessionScopeKey({ all: scope.backgroundAll, origin: { cwd: scope.cwd, sessionId: scope.sessionId }, processId: scope.processId })}:${[...(scope.statuses ?? [])].sort().join(",")}`;
    const clauses = ["unreadable = 0"], args: any[] = [];
    if (!scope.backgroundAll) clauses.push("known = 1");
    if (!scope.backgroundAll) { clauses.push("workspace = ? AND session = ?"); args.push(scope.cwd, scope.sessionId ?? ""); }
    if (!scope.backgroundAll && !scope.sessionId) { clauses.push("spawn_pid = ?"); args.push(scope.processId ?? -1); }
    if (scope.statuses?.length) { clauses.push(`(state IN (${scope.statuses.map(() => "?").join(",")})${scope.statuses.includes("running") ? " OR active = 1" : ""})`); args.push(...scope.statuses); }
    if (scope.active !== undefined) { clauses.push("active = ?"); args.push(scope.active ? 1 : 0); }
    const where = clauses.join(" AND ");
    const aggregate = this.db.prepare(`SELECT count(*) AS n FROM background_history WHERE ${where}`).get(...args);
    const anchor = rowCursorKey(scope.cursor, resource);
    const after = anchor ? " AND (started < ? OR (started = ? AND id < ?))" : "";
    const anchorArgs = anchor ? [anchor.time, anchor.time, anchor.id] : [];
    const before = anchor ? Number(this.db.prepare(`SELECT count(*) AS n FROM background_history WHERE ${where} AND (started > ? OR (started = ? AND id >= ?))`).get(...args, ...anchorArgs).n) : 0;
    const selected = this.db.prepare(`SELECT key, id, payload, context FROM background_history WHERE ${where}${after} ORDER BY started DESC, id DESC LIMIT ?`)
      .all(...args, ...anchorArgs, (scope.limit ?? 10) + 1);
    for (const row of selected) {
      const path = row.key.startsWith("d:") ? join(this.directory, "observed", `${row.id}.json`) : join(tasksDir(), row.id, "meta.json");
      if (row.context !== currentIdentity(path)) { this.invalidate(); this.status = "rebuilding"; }
    }
    const records = selected.map((row: any) => JSON.parse(row.payload));
    const page = pageRows(records, { resource, cursor: scope.cursor, limit: scope.limit ?? 10, maxBytes: Number.MAX_SAFE_INTEGER,
      indexed: { total: Number(aggregate.n), before }, keyOf: (meta: any) => ({ time: meta.startedAt, id: meta.id }), render: () => "" });
    const revisionStates = scope.statuses?.length ? [...new Set([...scope.statuses, ...(scope.statuses.includes("running") ? ["starting"] : [])])] : ["*"];
    const revisions = this.db.prepare(`SELECT sum(content) AS content, sum(failure) AS failure FROM background_history_revisions
      WHERE workspace = ? AND session = ? AND state IN (${revisionStates.map(() => "?").join(",")})`)
      .get(scope.backgroundAll ? "" : scope.cwd, scope.backgroundAll ? "" : scope.sessionId || `process:${scope.processId ?? -1}`, ...revisionStates);
    const diagnostics = this.db.prepare("SELECT sum(unreadable) AS unreadable, sum(known = 0 AND unreadable = 0) AS unknown FROM background_history").get();
    return { records: records.slice(0, scope.limit ?? 10).map((meta: any) => ({ id: meta.id, found: true, readable: true, meta })),
      page: { total: Number(aggregate.n), before, nextCursor: page.nextCursor, resource,
        contentRevision: digest([aggregate.n, revisions.content, diagnostics.unreadable, diagnostics.unknown]), failureRevision: digest(revisions.failure),
        unreadable: Number(diagnostics.unreadable ?? 0), unknown: scope.backgroundAll ? 0 : Number(diagnostics.unknown ?? 0) } };
  }

  private async refresh(version: string) {
    const generation = this.generation;
    this.metrics.inventories++;
    const seen = new Set<string>();
    const upsert = this.db.prepare(`INSERT OR REPLACE INTO background_history VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const previous = this.db.prepare("SELECT * FROM background_history WHERE key = ?");
    const bump = (row: any, content: boolean, failure: boolean) => {
      const session = row.session || `process:${row.spawn_pid ?? -1}`;
      const keys = new Map([[JSON.stringify([row.workspace, session, row.state]), [row.workspace, session, row.state]],
        [JSON.stringify([row.workspace, session, "*"]), [row.workspace, session, "*"]],
        [JSON.stringify(["", "", row.state]), ["", "", row.state]], [JSON.stringify(["", "", "*"]), ["", "", "*"]]]);
      for (const key of keys.values()) this.db.prepare(`INSERT INTO background_history_revisions VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(workspace, session, state) DO UPDATE SET content = content + excluded.content, failure = failure + excluded.failure`)
        .run(...key, content ? 1 : 0, failure ? 1 : 0);
    };
    const updateFailure = (key: string, failure: string) => {
      const old = previous.get(key);
      if (old.failure !== failure) { this.changes++; bump(old, false, true); this.db.prepare("UPDATE background_history SET failure = ? WHERE key = ?").run(failure, key); }
    };
    const save = (key: string, meta: any, signature: string, failure: string, unreadable = false, context = signature) => {
      seen.add(key);
      const old = previous.get(key);
      if (old?.signature === signature) { updateFailure(key, failure); return; }
      const origin = meta?.callbackOrigin;
      const known = origin && typeof origin.cwd === "string";
      upsert.run(key, meta?.id ?? key, origin?.cwd ?? "", origin?.sessionId ?? "", known ? 1 : 0, unreadable ? 1 : 0,
        meta?.status ?? "", meta?.startedAt ?? 0, JSON.stringify(meta ?? null), signature, failure, meta?.spawnPid ?? null,
        meta?.durable ? Number(meta.active) : Number(meta?.status === "running"), context);
      this.changes++;
      if (old) bump(old, true, old.failure !== failure);
      bump(previous.get(key), true, old?.failure !== failure);
    };
    const source = this.source();
    let last = "";
    if (source) for (;;) {
      if (this.closed) return;
      const operations = source.prepare(`SELECT * FROM operations WHERE owner_kind = 'parent-session' AND observer_kind = 'local-supervisor'
        AND operation_id > ? ORDER BY operation_id LIMIT 128`).all(last);
      if (!operations.length) break;
      for (const op of operations) {
        if (this.closed) return;
        const key = `d:${op.operation_id}`;
        const waits = source.prepare(`SELECT w.* FROM waits w JOIN wait_dependencies d ON w.wait_id = d.wait_id AND w.generation = d.generation
          WHERE d.operation_id = ? ORDER BY w.wait_id, w.generation`).all(op.operation_id);
        const context = await identity(join(this.directory, "observed", `${op.task_id}.json`));
        const signature = digest([op, waits, context,
          await identity(join(this.directory, "tasks", op.task_id, "result.json")), await identity(join(this.directory, "tasks", op.task_id, "lost.json")),
          // Active runner/wait facts come from the current shared projection.
          op.phase === "running" ? this.project([op]) : null]);
        let meta;
        if (previous.get(key)?.signature !== signature) {
          this.metrics.projections++;
          meta = this.project([op])[0];
          if (meta?.dismissedAt !== undefined) continue;
          meta = { ...meta, callbackOrigin: { cwd: op.owner_workspace, sessionId: op.owner_session_id }, logPath: meta.logPaths?.stdout ?? "" };
        }
        if (meta) save(key, meta, signature, "", false, context);
        else if (previous.get(key)?.signature === signature) seen.add(key);
      }
      last = operations.at(-1).operation_id;
      await yieldTurn();
    }
    let ids: string[] = [];
    try { ids = await readdir(tasksDir()); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let batch = 0;
    for (const id of ids) {
      if (this.closed) return;
      if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
      const key = `l:${id}`, path = join(tasksDir(), id);
      const signature = await identity(join(path, "meta.json"));
      const failure = digest([await identity(join(path, "failures.jsonl")), await identity(join(path, "failures.jsonl.observed"))]);
      if (previous.get(key)?.signature === signature) { seen.add(key); updateFailure(key, failure); }
      else {
        this.metrics.metadataReads++;
        const record = inspectMeta(id);
        if (record.found) save(key, record.meta, signature, failure, !record.meta);
      }
      if (++batch % 128 === 0) await yieldTurn();
    }
    if (this.closed) return;
    for (const row of this.db.prepare("SELECT key FROM background_history").all()) {
      if (!seen.has(row.key)) { this.changes++; bump(previous.get(row.key), true, true); this.db.prepare("DELETE FROM background_history WHERE key = ?").run(row.key); }
    }
    this.version = version;
    this.completed = generation === this.generation ? Date.now() : 0;
    this.status = generation === this.generation && version === this.sourceVersion() ? "ready" : "rebuilding";
    this.reason = undefined;
  }

  async close() { this.closed = true; if (this.timer) clearInterval(this.timer); for (const watcher of this.watchers.values()) watcher.close(); this.watchers.clear(); await this.pending; }
}
