import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { watch, statSync, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { setImmediate as yieldTurn, setTimeout as delay } from "node:timers/promises";
import type { WorkScope } from "./read-model.ts";
import { workPage } from "./work-budget.ts";
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
  private directoryFor: (operation: any) => string;
  private changed: () => void;
  private pending?: Promise<void>;
  private completed = 0;
  private version = "";
  private closed = false;
  private generation = 0;
  private watchers = new Map<string, FSWatcher>();
  private activated = false;
  get active() { return this.activated; }
  private scheduled = false;
  private timer?: ReturnType<typeof setInterval>;
  private changes = 0;
  private observedVersion = "";
  private imported = false;
  private dirty = new Set<string>();
  private applying: string[] = [];
  private dirtyLegacy = new Set<string>();
  private applyingLegacy: string[] = [];
  private legacyOwed = true;
  status: "ready" | "rebuilding" | "degraded" = "rebuilding";
  get queryStatus() {
    // A delivered hint is an outstanding observation obligation even before
    // its scheduled refresh starts; page-local checks cannot verify off-page rows.
    return this.status === "ready" && (this.dirty.size || this.dirtyLegacy.size || this.legacyOwed || !this.imported)
      ? "rebuilding" : this.status;
  }
  reason?: string;
  readonly metrics = { inventories: 0, metadataReads: 0, projections: 0, operationReads: 0, operationQueries: 0, dependencyQueries: 0, inputStats: 0, incrementalBatches: 0 };

  constructor(db: any, directory: string, source: () => any, project: (operations: any[]) => any[], changed: () => void, directoryFor = (_operation: any) => directory) {
    this.db = db; this.directory = directory; this.source = source; this.project = project; this.changed = changed;
    this.directoryFor = directoryFor;
    db.exec(`CREATE TABLE background_history (key TEXT PRIMARY KEY, id TEXT, workspace TEXT, session TEXT,
      known INTEGER, unreadable INTEGER, state TEXT, started REAL, payload TEXT, signature TEXT, failure TEXT, spawn_pid INTEGER, active INTEGER, context TEXT, dismissed INTEGER);
      CREATE INDEX background_history_scope ON background_history(dismissed, workspace, session, state, started DESC, id DESC);
      CREATE INDEX background_history_process ON background_history(dismissed, workspace, session, spawn_pid, state, started DESC, id DESC);
      CREATE INDEX background_history_state ON background_history(dismissed, state, started DESC, id DESC);
      CREATE INDEX background_history_order ON background_history(dismissed, started DESC, id DESC);
      CREATE TABLE background_history_revisions (workspace TEXT, session TEXT, state TEXT, content INTEGER, failure INTEGER,
        PRIMARY KEY (workspace, session, state));`);
  }

  private sourceVersion() {
    const db = this.source();
    const roots = [tasksDir()].map(path => {
      this.metrics.inputStats++;
      try { const s = statSync(path, { bigint: true }); return `${s.dev}:${s.ino}:${s.mtimeNs}:${s.ctimeNs}`; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
    });
    const journal = db?.prepare("SELECT 1 FROM sqlite_master WHERE name='assignment_change_source'").get();
    return JSON.stringify([db ? journal ? db.prepare("SELECT generation FROM assignment_change_source").get()?.generation
      : db.prepare("PRAGMA data_version").get().data_version : "absent", roots]);
  }

  private observeSources() {
    for (const path of [dirname(tasksDir()), this.directory]) {
      if (this.watchers.has(path)) continue;
      try {
        const watcher = watch(path, { recursive: true }, (_event, file) => {
          if (this.closed) return;
          const legacy = file && /^tasks[/\\]([A-Za-z0-9_-]+)[/\\](?:meta\.json|failures\.jsonl(?:\.observed)?)$/.exec(String(file));
          if (path !== this.directory && legacy) { this.dirtyLegacy.add(legacy[1]!); this.invalidateOperation(""); return; }
          const match = file && /^tasks[/\\]([^/\\]+)[/\\](?:result|lost|launch|claim|command|stop|cleanup)\.json$|^observed[/\\]([^/\\]+)\.json$/.exec(String(file));
          if (path === this.directory && match) {
            const op = this.source()?.prepare("SELECT operation_id FROM operations WHERE task_id=?").get(match[1] ?? match[2]);
            if (op) this.invalidateOperation(op.operation_id);
            return;
          }
          if (!file || /(?:meta|result|lost|launch|claim)\.json$|failures\.jsonl(?:\.observed)?$|^observed[/\\].*\.json$/.test(String(file))) this.invalidateLegacy();
        });
        watcher.on("error", () => { this.watchers.delete(path); watcher.close(); this.status = "degraded"; this.reason = "Background history watcher failed; reconciling source signatures"; this.invalidate(); });
        this.watchers.set(path, watcher);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  invalidate() {
    this.completed = 0; this.generation++; this.legacyOwed = true;
    this.imported = false;
    if (!this.activated || this.closed || this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => { this.scheduled = false; if (!this.closed && !this.pending) this.startRefresh(); });
  }

  invalidateOperation(id: string) {
    if (!this.activated || this.closed) return;
    this.dirty.add(id);
    if (!this.scheduled) { this.scheduled = true; setImmediate(() => { this.scheduled = false; if (!this.closed && !this.pending) this.startRefresh(); }); }
  }

  private operationInput(op: any) {
    const waits = this.source().prepare(`SELECT w.* FROM waits w JOIN wait_dependencies d ON w.wait_id = d.wait_id AND w.generation = d.generation
      WHERE d.operation_id = ? ORDER BY w.wait_id, w.generation`).all(op.operation_id);
    this.metrics.dependencyQueries++;
    const directory = this.directoryFor(op);
    const context = currentIdentity(join(directory, "observed", `${op.task_id}.json`));
    const files = ["launch", "claim", "command", "result", "lost", "stop", "cleanup"]
      .map(name => currentIdentity(join(directory, "tasks", op.task_id, `${name}.json`)));
    this.metrics.inputStats += 8;
    const active = op.phase === "running" ? this.project([op])[0] : undefined;
    return { context, active, signature: digest([op, waits, context, files, active]) };
  }

  repairOperation(op: any, id: string) {
    if (!this.activated || !this.imported || this.closed) return;
    const previous = this.db.prepare("SELECT signature FROM background_history WHERE key=?").get(`d:${id}`);
    if (op?.owner_kind !== "parent-session" || op.observer_kind !== "local-supervisor") {
      if (previous) this.invalidateOperation(id);
    } else if (!previous || previous.signature !== this.operationInput(op).signature) this.invalidateOperation(id);
  }

  private invalidateLegacy() {
    this.legacyOwed = true; this.completed = 0;
    this.invalidateOperation("");
  }

  reconcile() {
    if (!this.activated || this.closed) return;
    const version = this.sourceVersion();
    if (version !== this.observedVersion) { this.observedVersion = version; this.invalidateLegacy(); }
  }

  private startRefresh(version?: string) {
    if (this.source()?.observationActive) return;
    if (this.closed || this.pending) return;
    const previous = this.queryStatus, changes = this.changes;
    this.status = "rebuilding";
    this.pending = Promise.resolve().then(() => this.refresh(version ?? this.sourceVersion())).catch(error => {
      for (const id of this.applying) this.dirty.add(id);
      for (const id of this.applyingLegacy) this.dirtyLegacy.add(id);
      if (!this.closed) {
        this.status = error === this.sourceChanged ? "rebuilding" : "degraded";
        this.reason = error === this.sourceChanged ? undefined : String(error);
      }
    }).finally(() => {
      this.applying = [];
      this.applyingLegacy = [];
      this.pending = undefined;
      if (this.closed) return;
      if (changes !== this.changes || previous !== this.status) this.changed();
      if (this.status !== "degraded" && (this.status === "rebuilding" || this.dirty.size || this.dirtyLegacy.size)) this.invalidateOperation("");
    });
  }

  private prepareRead() {
    this.observeSources();
    if (!this.activated) {
      this.activated = true;
      this.timer = setInterval(() => { this.legacyOwed = true; this.startRefresh(); }, 30000); this.timer.unref();
    }
    const version = this.sourceVersion();
    this.observedVersion = version;
    // Legacy writers have no entity notification yet; share one slower signature inventory.
    if (!this.pending && (this.version !== version || Date.now() - this.completed >= 30000)) {
      this.startRefresh(version);
    }
  }

  read(scope: WorkScope, published = false) {
    if (!published || !this.activated) this.prepareRead();
    const resource = `list:${sessionScopeKey({ all: scope.backgroundAll, origin: { cwd: scope.cwd, sessionId: scope.sessionId }, processId: scope.processId })}:${[...(scope.statuses ?? [])].sort().join(",")}`;
    const ownerClauses: string[] = [], ownerArgs: any[] = [];
    if (!scope.backgroundAll) {
      ownerClauses.push("workspace = ? AND session = ?");
      ownerArgs.push(scope.cwd, scope.sessionId ?? "");
      if (!scope.sessionId) { ownerClauses.push("spawn_pid = ?"); ownerArgs.push(scope.processId ?? -1); }
    }
    const ownerWhere = ownerClauses.join(" AND ");
    const clauses = ["unreadable = 0", "dismissed = 0"], args = [...ownerArgs];
    if (ownerWhere) clauses.push("known = 1", ownerWhere);
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
    if (!published) for (const row of selected) {
      if (row.key.startsWith("d:")) this.metrics.operationQueries++;
      const op = row.key.startsWith("d:") ? this.source()?.prepare("SELECT * FROM operations WHERE operation_id=?").get(row.key.slice(2)) : undefined;
      const path = row.key.startsWith("d:") ? join(op ? this.directoryFor(op) : this.directory, "observed", `${row.id}.json`) : join(tasksDir(), row.id, "meta.json");
      this.metrics.inputStats++;
      if (row.context !== currentIdentity(path)) {
        if (row.key.startsWith("d:")) this.invalidateOperation(row.key.slice(2)); else this.invalidateLegacy();
        this.status = "rebuilding";
      }
    }
    const records = selected.map((row: any) => JSON.parse(row.payload));
    const page = pageRows(records, { resource, cursor: scope.cursor, limit: scope.limit ?? 10, maxBytes: Number.MAX_SAFE_INTEGER,
      indexed: { total: Number(aggregate.n), before }, keyOf: (meta: any) => ({ time: meta.startedAt, id: meta.id }), render: () => "" });
    const revisionStates = scope.statuses?.length ? [...new Set([...scope.statuses, ...(scope.statuses.includes("running") ? ["starting"] : [])])] : ["*"];
    const revisions = this.db.prepare(`SELECT sum(content) AS content, sum(failure) AS failure FROM background_history_revisions
      WHERE workspace = ? AND session = ? AND state IN (${revisionStates.map(() => "?").join(",")})`)
      .get(scope.backgroundAll ? "" : scope.cwd, scope.backgroundAll ? "" : scope.sessionId || `process:${scope.processId ?? -1}`, ...revisionStates);
    const diagnosticScope = ownerWhere ? ` AND (known = 0 OR (${ownerWhere}))` : "";
    const diagnostics = this.db.prepare(`SELECT sum(unreadable) AS unreadable, sum(known = 0 AND unreadable = 0) AS unknown
      FROM background_history WHERE dismissed = 0${diagnosticScope}`).get(...ownerArgs);
    return { records: records.slice(0, scope.limit ?? 10).map((meta: any) => ({ id: meta.id, found: true, readable: true, meta })),
      page: { total: Number(aggregate.n), before, nextCursor: page.nextCursor, resource,
        contentRevision: digest([aggregate.n, revisions.content, diagnostics.unreadable, diagnostics.unknown]), failureRevision: digest(revisions.failure),
        unreadable: Number(diagnostics.unreadable ?? 0), unknown: scope.backgroundAll ? 0 : Number(diagnostics.unknown ?? 0) } };
  }

  private readonly sourceChanged = new Error("Background history source replaced during refresh");
  private async refresh(version: string) {
    const generation = this.generation;
    const ownerBusy = () => {
      if (generation !== this.generation) throw this.sourceChanged;
      return !this.closed && this.source()?.observationActive;
    };
    const baseline = !this.imported;
    const legacy = this.legacyOwed || baseline;
    this.legacyOwed = false;
    if (baseline || legacy) this.metrics.inventories++;
    else this.metrics.incrementalBatches++;
    const dirty = workPage(this.dirty, 128).filter(Boolean);
    this.applying = dirty;
    const dirtyLegacy = workPage(this.dirtyLegacy, 128);
    this.applyingLegacy = dirtyLegacy;
    for (const id of dirtyLegacy) this.dirtyLegacy.delete(id);
    for (const id of dirty) this.dirty.delete(id);
    this.dirty.delete("");
    const seen = new Set<string>();
    const upsert = this.db.prepare(`INSERT OR REPLACE INTO background_history VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
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
        meta?.durable ? Number(meta.active) : Number(meta?.status === "running"), context, Number(meta?.dismissedAt !== undefined));
      this.changes++;
      if (old) bump(old, true, old.failure !== failure);
      bump(previous.get(key), true, old?.failure !== failure);
    };
    const source = this.source();
    let last = "";
    if (source) for (;;) {
      while (ownerBusy()) await delay(10);
      if (this.closed) return;
      this.metrics.operationQueries += baseline ? 1 : dirty.length;
      const operations = baseline ? source.prepare(`SELECT * FROM operations WHERE owner_kind = 'parent-session' AND observer_kind = 'local-supervisor'
        AND operation_id > ? ORDER BY operation_id LIMIT 128`).all(last)
        : dirty.map(id => source.prepare("SELECT * FROM operations WHERE operation_id=? AND owner_kind='parent-session' AND observer_kind='local-supervisor'").get(id)).filter(Boolean);
      this.metrics.operationReads += operations.length;
      if (!operations.length) break;
      for (const op of operations) {
        if (this.closed) return;
        const key = `d:${op.operation_id}`;
        const { context, active, signature } = this.operationInput(op);
        let meta;
        if (previous.get(key)?.signature !== signature) {
          this.metrics.projections++;
          meta = active ?? this.project([op])[0];
          // Retain the source signature even when dismissal hides the row:
          // absence would make every exact repair demand another history build.
          meta = { ...meta, callbackOrigin: { cwd: op.owner_workspace, sessionId: op.owner_session_id, branchId: op.owner_branch_id ?? null }, logPath: meta.logPaths?.stdout ?? "" };
        }
        if (meta) save(key, meta, signature, "", meta.unreadable === true, context);
        else if (previous.get(key)?.signature === signature) seen.add(key);
      }
      last = operations.at(-1).operation_id;
      await yieldTurn();
      if (!baseline) break;
    }
    let ids: string[] = dirtyLegacy;
    try { if (legacy) ids = await readdir(tasksDir()); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let batch = 0;
    for (const id of ids) {
      if (this.closed) return;
      if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
      const key = `l:${id}`, path = join(tasksDir(), id);
      this.metrics.inputStats += 3;
      const signature = await identity(join(path, "meta.json"));
      const failure = digest([await identity(join(path, "failures.jsonl")), await identity(join(path, "failures.jsonl.observed"))]);
      while (ownerBusy()) await delay(10);
      if (this.closed) return;
      if (previous.get(key)?.signature === signature) { seen.add(key); updateFailure(key, failure); }
      else {
        this.metrics.metadataReads++;
        const record = inspectMeta(id);
        if (record.found) save(key, record.meta, signature, failure, !record.meta);
      }
      if (++batch % 128 === 0) await yieldTurn();
    }
    while (ownerBusy()) await delay(10);
    if (this.closed) return;
    const removals = baseline ? this.db.prepare("SELECT key FROM background_history").all()
      : [...(legacy ? this.db.prepare("SELECT key FROM background_history WHERE key LIKE 'l:%'").all() : []),
        ...dirty.map(id => ({ key: `d:${id}` })), ...dirtyLegacy.map(id => ({ key: `l:${id}` }))];
    for (const row of removals) {
      const affected = row.key.startsWith("d:") ? baseline || dirty.includes(row.key.slice(2)) : legacy || dirtyLegacy.includes(row.key.slice(2));
      if (affected && !seen.has(row.key) && previous.get(row.key)) { this.changes++; bump(previous.get(row.key), true, true); this.db.prepare("DELETE FROM background_history WHERE key = ?").run(row.key); }
    }
    this.version = version;
    this.imported = generation === this.generation;
    this.completed = Date.now();
    this.status = this.dirty.size || this.dirtyLegacy.size || !this.imported ? "rebuilding" : "ready";
    this.reason = undefined;
  }

  async close() { this.closed = true; if (this.timer) clearInterval(this.timer); for (const watcher of this.watchers.values()) watcher.close(); this.watchers.clear(); await this.pending; }
}
