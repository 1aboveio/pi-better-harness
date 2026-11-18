import { processMatchesStart } from "../daemon-owner.ts";
import { createRequire } from "node:module";
import { readFileSync, statSync, mkdirSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
// @ts-expect-error Generated canonical passive runner observation.
import { snapshot } from "./domain/background/snapshot.mjs";
// @ts-expect-error Generated canonical registry queries.
import { observeMetasForOrigin, observeRecentMetasForOrigin, recentMetaDeadline, observationRevisionForOrigin, belongsToOrigin, readMeta, getRegistryIoMetrics } from "./domain/background/registry.mjs";
import { BackgroundHistory } from "./background-history.ts";
import type { WorkScope } from "./read-model.ts";
import { ENTITY_BUDGET } from "./work-budget.ts";
// @ts-expect-error Shared durable observation inbox, not execution authority.
import { AssignmentInbox } from "./domain/assignment-inbox.mjs";

type BackgroundScope = { origin: { cwd: string; sessionId?: string }; rows: any[]; references: number;
  pending: any[]; pendingRevision?: number; recent: any[]; recentRevision?: number };
const DISCOVERY_PAGE_SIZE = 256;

/** Root-owned query connection; never opens a supervisor or mutates source facts. */
export class BackgroundObservation {
  private ownDb: any;
  private readConnection?: (refresh?: boolean) => any;
  private get db(): any { return this.readConnection ? this.readConnection(false) : this.ownDb; }
  private identity?: string;
  private knownCoordinator = false;
  private rows: any[] = [];
  private terminalProjections = new Map<string, { version: string; authority: string; operation: any; inspection: any; row: any; dependencyVersion?: number }>();
  private hasInputVersions = false;
  private inbox: any;
  private indexDb: any;
  private initialized = false;
  get ready() { return this.initialized && !this.closed; }
  private dirtyOperations = new Set<string>();
  private scopeVersions = new Map<string, number>();
  private watchers = new Map<string, FSWatcher>();
  private repairAfter = "";
  private repairIds = new Set<string>();
  private changedOperations = new Map<string, any>();
  private scheduled = false;
  private expiry?: ReturnType<typeof setTimeout>;
  private closed = false;
  private repairComplete = false;
  private changed: () => void;
  private signature = "";
  private root: string;
  private directory: string;
  private enabled = false;
  private allRequested = false;
  private history?: BackgroundHistory;
  private legacy = new Map<string, BackgroundScope>();
  private recentRevision?: number;
  private recent: any[] = [];
  status: "ready" | "rebuilding" | "degraded" = "rebuilding";
  reason?: string;
  get connectionCount() { return this.readConnection ? 0 : this.ownDb ? 1 : 0; }
  get scopeCount() { return this.legacy.size; }
  prepareQuery(): void {
    if (!this.ready) return;
    if (!this.enabled || !this.db || !this.hasInputVersions) return;
    // Native mutations can commit between the last scheduled observation and
    // the next list. Reuse the durable bounded inbox before cache validation.
    const batch = this.inbox.receive(this.db, this.identity);
    if (batch.size && this.refresh()) this.changed();
    if (this.inbox.metrics.more || this.inbox.metrics.pending) this.schedule();
  }
  sourceRevision(scope: WorkScope): string[] {
    if (!this.ready) return [];
    if (!scope.cwd) return [];
    return [observationRevisionForOrigin({ cwd: scope.cwd, sessionId: scope.sessionId }),
      ...(scope.sessionId ? [observationRevisionForOrigin({ cwd: scope.cwd })] : [])];
  }
  nextDeadline(scope: WorkScope): number | null {
    if (!this.ready) return null;
    if (!scope.cwd) return null;
    const deadlines = [...recentMetaDeadline({ cwd: scope.cwd, sessionId: scope.sessionId }),
      ...(scope.sessionId ? recentMetaDeadline({ cwd: scope.cwd }) : [])];
    return deadlines.length ? Math.min(...deadlines) : null;
  }
  get registryMetrics() { return getRegistryIoMetrics(); }
  get changeMetrics() { return { ...(this.ready ? this.inbox.metrics : { available: false, received: null, applied: null, pending: null }), coverage: this.hasInputVersions ? "cooperative-journal-and-exact-files" : "legacy-bounded-repair",
    operationRepairComplete: this.ready && this.repairComplete, repairAfter: this.ready ? this.repairAfter : null, queuedHints: this.dirtyOperations.size,
    fileCoverage: "active-and-retained; historical-files-only-when-history-requested" }; }
  livenessReasons(options: { refresh?: boolean } = {}) {
    if (!this.ready) throw new Error("Background inbox coverage is unverified");
    if (options.refresh !== false) {
      this.enabled = true;
      this.refresh();
    }
    if (!this.db) return [];
    let operations: any[] = [];
    try {
      // The file may be visible before its writer commits the initial schema.
      // Keep publication alive and report unverified background state until refresh.
      const version = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()?.value;
      if (!["1", "2", "3", "4"].includes(version)) return [];
      operations = this.db.prepare("SELECT * FROM operations WHERE phase = 'running' AND observer_kind = 'local-supervisor' AND terminal_revision = 0").all();
    }
    catch (error) { this.status = "degraded"; this.reason = String(error); return []; }
    return operations.flatMap((op: any) => {
      try {
        const directory = this.directoryFor(op);
        const cached = this.terminalProjections.get(op.operation_id);
        const inspection = cached?.authority === JSON.stringify([op, directory]) ? cached.inspection : snapshot(directory, op.task_id);
        if (!cached || cached.authority !== JSON.stringify([op, directory])) this.metrics.runnerSnapshots++;
        const claim = inspection?.claim;
        return claim && !inspection.terminal && inspection.token === op.launch_token && processMatchesStart(claim.pid, claim.pidStartTime)
          ? [{ kind: "runner", id: op.task_id, owner: { kind: op.owner_kind, sessionId: op.owner_session_id, workspace: op.owner_workspace }, operationId: op.operation_id,
            lastProgressAt: inspection.command?.startedAt ?? claim.claimedAt,
            nextDeadline: inspection.launch.timeoutSeconds ? inspection.launch.createdAt + inspection.launch.timeoutSeconds * 1000 : null,
            recovery: "observe-existing-runner" }] : [];
      } catch (error) { this.status = "degraded"; this.reason = String(error); return []; }
    });
  }
  readonly metrics = { runnerSnapshots: 0, activeQueries: 0, historyQueries: 0, inputStats: 0, dependencyQueries: 0, projectionHits: 0,
    repairEntries: 0, exactHints: 0, journalEntities: 0, overflows: 0, activeRows: 0, exactOperationQueries: 0,
    sourceWork: { active: { stats: 0, waits: 0, snapshots: 0 }, repair: { stats: 0, waits: 0, snapshots: 0 }, history: { stats: 0, waits: 0, snapshots: 0 } } };
  private schedule() {
    if (!this.ready || this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => { this.scheduled = false; if (!this.closed && this.refresh()) this.changed(); });
  }
  private oweRepair() {
    this.inbox.db.prepare(`INSERT OR REPLACE INTO ${this.inbox.prefix}background_file_repair VALUES(1,?,'',0)`).run(this.identity ?? "");
    this.repairAfter = ""; this.repairComplete = false;
  }
  private observeDirectory(directory: string) {
    if (this.watchers.has(directory)) return;
    try {
      const watcher = watch(directory, { recursive: true }, (_event, file) => {
        if (this.closed) return;
        const match = file && /^(?:observed[/\\]([^/\\]+)\.json|tasks[/\\]([^/\\]+)[/\\](?:launch|claim|command|result|lost|stop|cleanup)\.json)$/.exec(String(file));
        if (match) {
          const op = this.db?.prepare("SELECT operation_id FROM operations WHERE task_id=? AND observer_kind='local-supervisor'").get(match[1] ?? match[2]);
          if (op) {
            if (this.dirtyOperations.size < 256) this.dirtyOperations.add(op.operation_id);
            else { this.oweRepair(); this.metrics.overflows++; }
            this.history?.invalidateOperation(op.operation_id); this.metrics.exactHints++;
          }
        } else if (!file) { this.oweRepair(); this.metrics.overflows++; }
        else return;
        this.schedule();
      });
      watcher.on("error", () => { watcher.close(); this.watchers.delete(directory); this.status = "degraded"; this.reason = "Background watcher failed; bounded repair required"; this.oweRepair(); this.schedule(); });
      this.watchers.set(directory, watcher);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  private directoryFor(op: any): string {
    if (!op.supervision_host_id?.startsWith("server:")) return this.directory;
    const row = this.db.prepare("SELECT value FROM coordinator_state WHERE key = ?").get(`result-supervision-v1:${op.operation_id}`);
    if (!row) throw new Error("Captured result-supervision directory unavailable");
    const grant = JSON.parse(row.value);
    if (grant.launchToken !== op.launch_token || typeof grant.directory !== "string") throw new Error("Captured runner execution identity differs");
    return grant.directory;
  }
  constructor(root: string, directory = join(tmpdir(), process.env.VITEST_POOL_ID ? `pi-better-background-tasks-vitest-${process.env.VITEST_POOL_ID}` : "pi-better-background-tasks", "supervisor"), indexDb?: any, changed = () => {}, readConnection?: (refresh?: boolean) => any, options: { defer?: boolean } = {}) {
    this.readConnection = readConnection;
    this.changed = changed;
    this.root = root; this.directory = directory;
    this.indexDb = indexDb;
    mkdirSync(join(root, "runtime-read-repair"), { recursive: true });
    // Create the owner's in-memory history tables once, never per acquisition attempt.
    if (indexDb) this.history = new BackgroundHistory(indexDb, directory, () => {
      if (!this.ready) throw new Error("Background inbox coverage is unverified");
      if (this.status === "degraded") throw new Error(this.reason);
      return this.db;
    }, operations => this.project(operations, false), changed, op => this.directoryFor(op));
    if (!options.defer) this.initialize();
  }
  initialize(): void {
    if (this.closed) throw new Error("Background observation is closed");
    if (this.ready) return;
    if (this.indexDb?.isTransaction) throw new Error("Background initialization requires an unpinned owner");
    if (this.inbox) throw new Error("Background inbox cleanup is incomplete");
    const inbox = this.indexDb
      ? new AssignmentInbox(join(this.root, "runtime-read-repair", "background.sqlite"), this.indexDb, { entityPrefix: "background:" })
      : new AssignmentInbox(join(this.root, "runtime-read-repair", "background.sqlite"), { entityPrefix: "background:" });
    try {
      inbox.db.exec(`CREATE TABLE IF NOT EXISTS ${inbox.prefix}background_file_repair(singleton INTEGER PRIMARY KEY CHECK(singleton=1), identity TEXT, after_id TEXT, complete INTEGER)`);
      const repair = inbox.db.prepare(`SELECT * FROM ${inbox.prefix}background_file_repair WHERE singleton=1`).get();
      if (repair) { this.identity = repair.identity || undefined; this.knownCoordinator = Boolean(this.identity); this.repairAfter = repair.after_id; this.repairComplete = Boolean(repair.complete); }
      this.inbox = inbox;
      this.initialized = true;
    } catch (error) {
      try { inbox.close(); }
      catch (cleanup) {
        this.inbox = inbox;
        throw new AggregateError([error, cleanup], "Background initialization and owned cleanup failed");
      }
      throw error;
    }
  }
  refresh(): boolean {
    if (!this.ready) return false;
    if (!this.enabled) return false;
    try {
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
      const path = join(this.root, "operation-coordinator.sqlite");
      let identity;
      try { const info = statSync(path, { bigint: true }); identity = `${info.dev}:${info.ino}`; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (identity !== this.identity) { this.repairAfter = ""; this.repairComplete = false; this.scopeVersions.clear(); this.terminalProjections.clear(); this.recentRevision = undefined; this.recent = []; for (const entry of this.legacy.values()) { entry.pendingRevision = undefined; entry.recentRevision = undefined; entry.recent = []; } this.history?.invalidate(); this.ownDb?.close(); this.ownDb = undefined; this.identity = identity; }
      if (!identity && this.knownCoordinator) throw new Error("Coordinator source disappeared; retaining the previous observation");
      if (identity) {
        if (this.readConnection) this.readConnection();
        else this.ownDb ??= new DatabaseSync(path, { readOnly: true });
        this.knownCoordinator = true;
        const version = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()?.value;
        if (!["1", "2", "3", "4"].includes(version)) throw new Error("Unsupported coordinator schema");
        this.hasInputVersions = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_input_versions'").get());
      }
      this.metrics.activeQueries++;
      let batch: any;
      if (this.db && this.hasInputVersions) {
        batch = this.inbox.receive(this.db, this.identity);
        for (const [scope, seq] of batch) if (scope !== "*") {
          const [session, workspace, operationId] = JSON.parse(scope);
          this.dirtyOperations.add(operationId);
          this.scopeVersions.set(JSON.stringify([workspace, session]), Number(seq));
          this.history?.invalidateOperation(operationId);
          this.metrics.journalEntities++;
        }
        if (batch.has("*")) { this.terminalProjections.clear(); this.recentRevision = undefined; for (const entry of this.legacy.values()) { entry.recentRevision = undefined; entry.pendingRevision = undefined; } this.history?.invalidate(); }
      }
      const revision = this.hasInputVersions ? Math.max(0, ...this.scopeVersions.values())
        : Number(this.db?.prepare("SELECT value FROM coordinator_state WHERE key = 'change_revision'").get()?.value ?? 0);
      this.repairIds.clear();
      if (this.db) {
        const repair = this.db.prepare("SELECT operation_id FROM operations WHERE observer_kind='local-supervisor' AND operation_id>? ORDER BY operation_id LIMIT ?").all(this.repairAfter, ENTITY_BUDGET);
        for (const op of repair) { this.repairIds.add(op.operation_id); this.metrics.repairEntries++; }
        this.repairAfter = repair.length === ENTITY_BUDGET ? repair.at(-1).operation_id : "";
        if (!this.repairAfter) this.repairComplete = true;
        const saved = this.inbox.db.prepare(`SELECT * FROM ${this.inbox.prefix}background_file_repair WHERE singleton=1`).get();
        if (!saved || saved.identity !== (this.identity ?? "") || saved.after_id !== this.repairAfter || saved.complete !== Number(this.repairComplete))
          this.inbox.db.prepare(`INSERT OR REPLACE INTO ${this.inbox.prefix}background_file_repair VALUES(1,?,?,?)`).run(this.identity ?? "", this.repairAfter, Number(this.repairComplete));
      }
      const hasPendingIndex = Boolean(this.db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_parent_callbacks'").get());
      this.changedOperations.clear();
      if (this.db) for (const id of new Set([...this.dirtyOperations, ...this.repairIds])) {
        this.metrics.exactOperationQueries++;
        this.changedOperations.set(id, this.db.prepare("SELECT * FROM operations WHERE operation_id=?").get(id));
      }
      const operations = this.db ? this.db.prepare("SELECT * FROM operations WHERE phase = 'running' AND observer_kind = 'local-supervisor'").all() : [];
      this.metrics.activeRows += operations.length;
      // Active snapshots retain a bounded recent window. Complete history is
      // available through the separately paginated history index.
      if (this.allRequested && this.db && (this.recentRevision === undefined || !this.hasInputVersions && this.recentRevision !== revision)) {
        this.recent = this.db.prepare(`SELECT * FROM operations WHERE observer_kind='local-supervisor'
          AND terminal_at >= ? AND terminal_revision > 0
          ORDER BY terminal_at DESC, operation_id DESC LIMIT ?`).all(Date.now() - 30000, DISCOVERY_PAGE_SIZE);
        this.recentRevision = revision;
      } else if (this.allRequested) {
        const recent = new Map(this.recent.map(op => [op.operation_id, op]));
        for (const [id, op] of this.changedOperations) {
          if (op?.observer_kind === "local-supervisor" && op.terminal_revision > 0 && Date.now() - op.terminal_at < 30000) recent.set(id, op);
          else recent.delete(id);
        }
        this.recent = [...recent.values()].sort((a, b) => b.terminal_at - a.terminal_at || b.operation_id.localeCompare(a.operation_id)).slice(0, DISCOVERY_PAGE_SIZE);
        this.recentRevision = revision;
      }
      this.recent = this.recent.filter(op => Date.now() - op.terminal_at < 30000);
      operations.push(...this.recent);
      const rows = this.project(operations);
      // A passive runner may finish before its manager publishes the outcome.
      // Invalidate history on that exact state transition, not on scope/projection
      // churn (which would continually restart a yielding history build).
      const previousRows = new Map(this.rows.map(row => [row.id, row]));
      for (const row of rows) { const previous = previousRows.get(row.id); if (previous
        && (previous.status !== row.status || previous.active !== row.active)) this.history?.invalidateOperation(row.operationId); }
      for (const entry of this.legacy.values()) {
        const scopedRevision = this.hasInputVersions ? this.scopeVersions.get(JSON.stringify([entry.origin.cwd, entry.origin.sessionId])) ?? 0 : revision;
        if (hasPendingIndex) this.refreshPending(entry, scopedRevision);
        this.refreshRecent(entry, scopedRevision);
        const active = this.visibleLegacy(entry.origin);
        const retained = entry.rows.map(row => readMeta(row.id)).filter((row: any) => row && row.dismissedAt === undefined
          && row.status !== "running" && (!row.endedAt || Date.now() - row.endedAt < 30000));
        entry.rows = [...new Map([...retained, ...active].map(row => [row.id, row])).values()];
      }
      const signature = JSON.stringify([rows, [...this.legacy.values()].flatMap(entry => [...entry.rows, ...entry.recent, ...this.pendingRows(entry)]).sort((a, b) => a.id.localeCompare(b.id))]);
      const changed = signature !== this.signature || this.status !== "ready";
      // Projection churn must not cancel a yielding history build. Its own
      // source versions and watchers invalidate only changed source facts.
      this.rows = rows; this.signature = signature; this.status = "ready"; this.reason = undefined;
      // History's source fence must see this newly verified observation, not
      // reject recovery because the previous pass found a partial legacy write.
      for (const id of this.repairIds) this.history?.repairOperation(this.changedOperations.get(id), id);
      this.history?.reconcile();
      if (batch) this.inbox.acknowledge(batch, true);
      this.dirtyOperations.clear();
      if (this.inbox.metrics.more || this.inbox.metrics.pending) this.schedule();
      if (this.expiry) clearTimeout(this.expiry);
      const deadlines = [...this.recent.map(op => op.terminal_at + 30000), ...[...this.legacy.values()].flatMap(entry => [
        ...entry.recent.map(row => row.endedAt + 30000), ...recentMetaDeadline(entry.origin),
        ...(entry.origin.sessionId ? recentMetaDeadline({ cwd: entry.origin.cwd }) : [])])].filter(Number.isFinite);
      if (deadlines.length) { this.expiry = setTimeout(() => this.schedule(), Math.max(1, Math.min(...deadlines) - Date.now())); this.expiry.unref(); }
      return changed;
    } catch (error) {
      const reason = String(error);
      const changed = this.status !== "degraded" || this.reason !== reason;
      this.status = "degraded"; this.reason = reason;
      return changed;
    }
  }
  private project(operations: any[], useCache = true) {
      return operations.map((op: any) => {
        try {
        const directory = this.directoryFor(op);
        this.observeDirectory(directory);
        const cached = this.terminalProjections.get(op.operation_id);
        const authority = JSON.stringify([op, directory]);
        const work = !useCache ? this.metrics.sourceWork.history : this.repairIds.has(op.operation_id) && !this.dirtyOperations.has(op.operation_id)
          ? this.metrics.sourceWork.repair : this.metrics.sourceWork.active;
        const dependencyVersion = this.hasInputVersions
          ? Number(this.db.prepare("SELECT revision FROM background_input_versions WHERE operation_id=?").get(op.operation_id)?.revision ?? 0)
          : undefined;
        const paths = [join(directory, "observed", `${op.task_id}.json`),
          ...["launch.json", "claim.json", "command.json", "result.json", "lost.json", "stop.json", "cleanup.json"]
            .map(name => join(directory, "tasks", op.task_id, name))];
        const identities = paths.map(path => {
          this.metrics.inputStats++;
          work.stats++;
          try { const info = statSync(path, { bigint: true }); return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          return "missing";
        });
        let waits = cached?.row.waits;
        if (dependencyVersion === undefined || !cached || cached.authority !== authority || cached.dependencyVersion !== dependencyVersion) {
          this.metrics.dependencyQueries++;
          work.waits++;
          waits = this.db.prepare(`SELECT w.wait_id, w.generation, w.phase FROM waits w JOIN wait_dependencies d
            ON w.wait_id = d.wait_id AND w.generation = d.generation WHERE d.operation_id = ?
            AND w.owner_kind = ? AND w.owner_session_id = ? AND w.owner_workspace = ?
            AND w.phase NOT IN ('consumed', 'cancelled') AND w.dispatch_disarmed = 0
            ORDER BY w.wait_id, w.generation`).all(op.operation_id, op.owner_kind, op.owner_session_id, op.owner_workspace)
            .map((w: any) => ({ waitId: w.wait_id, generation: w.generation, phase: w.phase }));
        }
        const version = JSON.stringify([op, directory, identities, waits]);
        // Both paths validate authority, file identities and dependencies above.
        // History mode changes accounting/invalidation, not projection identity.
        if (cached?.version === version) { cached.dependencyVersion = dependencyVersion; this.metrics.projectionHits++; return cached.row; }
        if (useCache) this.history?.invalidateOperation(op.operation_id);
        this.metrics.runnerSnapshots++;
        work.snapshots++;
        const inspection = snapshot(directory, op.task_id);
        let context: any = {};
        try { context = JSON.parse(readFileSync(join(directory, "observed", `${op.task_id}.json`), "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const terminal = inspection?.terminal === true || op.terminal_revision > 0;
        const status = inspection?.terminal ? inspection.status : op.terminal_revision > 0 ? op.terminal_outcome : inspection?.status ?? "running";
        const row = { durable: true, id: op.task_id, operationId: op.operation_id, kind: context.kind ?? inspection?.kind ?? "process",
          status, active: !terminal, terminal, attention: terminal && status !== "succeeded", waits,
          owner: { kind: op.owner_kind, sessionId: op.owner_session_id, workspace: op.owner_workspace },
          startedAt: inspection?.result?.startedAt ?? inspection?.launch.createdAt ?? op.created_at,
          endedAt: inspection?.result?.endedAt ?? op.terminal_at ?? undefined,
          cwd: inspection?.launch.cwd ?? op.owner_workspace, name: context.name, command: context.command, argv: context.argv,
          dismissedAt: context.dismissedAt, exitCode: inspection?.result?.exitCode ?? null, logPaths: inspection?.logs ?? {} };
        this.terminalProjections.delete(op.operation_id);
        this.terminalProjections.set(op.operation_id, { version, authority, operation: op, inspection, row, dependencyVersion });
        if (this.terminalProjections.size > 4096) this.terminalProjections.delete(this.terminalProjections.keys().next().value!);
        return row;
        } catch (error) { this.dirtyOperations.add(op.operation_id); throw error; }
      }).filter(Boolean);
  }
  private pendingRows(entry: BackgroundScope): any[] { return entry.pending; }
  private refreshPending(entry: BackgroundScope, revision: number): void {
    if (!entry.origin.sessionId || entry.pendingRevision === revision) return;
    // These compact pointers only notify the frontend that obligations exist.
    // The canonical manager independently pages and resolves every obligation.
    entry.pending = this.db.prepare(`SELECT o.operation_id,o.task_id,o.owner_kind,o.owner_workspace,o.owner_session_id,
        o.terminal_outcome,o.terminal_at,o.created_at FROM background_parent_callbacks c
      JOIN operations o ON o.operation_id=c.operation_id
      WHERE c.owner_kind='parent-session' AND c.owner_workspace=? AND c.owner_session_id=? AND o.terminal_revision>0
      ORDER BY c.operation_id LIMIT ?`).all(entry.origin.cwd, entry.origin.sessionId, DISCOVERY_PAGE_SIZE)
      .map((op: any) => ({ durable: true, id: op.task_id, operationId: op.operation_id, callbackPending: true,
        owner: { kind: op.owner_kind, workspace: op.owner_workspace, sessionId: op.owner_session_id },
        status: op.terminal_outcome, terminal: true, active: false, startedAt: op.created_at, endedAt: op.terminal_at }));
    entry.pendingRevision = revision;
  }
  private refreshRecent(entry: BackgroundScope, revision: number): void {
    if (!this.db) return;
    if (entry.recentRevision === undefined || !this.hasInputVersions && entry.recentRevision !== revision) {
      const operations = this.db.prepare(`SELECT * FROM operations WHERE owner_kind='parent-session'
        AND owner_workspace=? AND owner_session_id=? AND observer_kind='local-supervisor'
        AND terminal_revision>0 AND terminal_at>=? ORDER BY terminal_at DESC,operation_id DESC LIMIT ?`)
        .all(entry.origin.cwd, entry.origin.sessionId ?? "", Date.now() - 30000, DISCOVERY_PAGE_SIZE);
      entry.recent = this.project(operations);
      entry.recentRevision = revision;
    } else {
      const rows = new Map(entry.recent.filter(row => Date.now() - row.endedAt < 30000).map(row => [row.operationId, row]));
      // Retained visible terminals must observe atomic file replacement even
      // before a watcher hint arrives or the historical repair cursor reaches them.
      for (const id of rows.keys()) if (!this.changedOperations.has(id)) {
        let op = this.terminalProjections.get(id)?.operation;
        if (!op) { this.metrics.exactOperationQueries++; op = this.db.prepare("SELECT * FROM operations WHERE operation_id=?").get(id); }
        if (op) rows.set(id, this.project([op])[0]);
        else rows.delete(id);
      }
      for (const [id, op] of this.changedOperations) {
        if (op?.owner_kind === "parent-session" && op.owner_workspace === entry.origin.cwd && op.owner_session_id === (entry.origin.sessionId ?? "")
          && op.observer_kind === "local-supervisor" && op.terminal_revision > 0 && Date.now() - op.terminal_at < 30000) {
          rows.set(id, this.project([op])[0]);
        } else rows.delete(id);
      }
      entry.recent = [...rows.values()].sort((a, b) => b.endedAt - a.endedAt || b.operationId.localeCompare(a.operationId)).slice(0, DISCOVERY_PAGE_SIZE);
      entry.recentRevision = revision;
    }
  }
  private legacyScope(scope: { cwd?: string; sessionId?: string }) {
    if (!scope.cwd) throw new Error("Background activity requires an exact workspace");
    const key = JSON.stringify([scope.cwd, scope.sessionId]);
    let entry = this.legacy.get(key);
    if (!entry) {
      if (this.legacy.size >= 128) {
        const oldest = [...this.legacy].find(([, value]) => value.references === 0);
        if (!oldest) throw new Error("runtime-overloaded: Background scope capacity reached; retry later");
        this.legacy.delete(oldest[0]);
      }
      const origin = { cwd: scope.cwd, sessionId: scope.sessionId };
      entry = { origin, rows: this.ready ? this.visibleLegacy(origin) : [], references: 0, pending: [], recent: [] };
      if (this.ready && this.status !== "degraded" && this.db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_parent_callbacks'").get())
        this.refreshPending(entry, Number(this.db.prepare("SELECT value FROM coordinator_state WHERE key='change_revision'").get()?.value ?? 0));
      if (this.ready && this.status !== "degraded" && this.db) this.refreshRecent(entry, Number(this.db.prepare("SELECT value FROM coordinator_state WHERE key='change_revision'").get()?.value ?? 0));
    }
    this.legacy.delete(key); this.legacy.set(key, entry);
    return entry;
  }
  private visibleLegacy(origin: { cwd: string; sessionId?: string }): any[] {
    return [...new Map([...observeMetasForOrigin(origin), ...observeRecentMetasForOrigin(origin),
      ...(origin.sessionId ? observeRecentMetasForOrigin({ cwd: origin.cwd }).filter((row: any) => !row.callbackOrigin) : [])]
      .map((row: any) => [row.id, row])).values()];
  }
  retain(scope: { cwd?: string; sessionId?: string }) {
    if (!this.ready) this.enabled = true;
    const entry = this.legacyScope(scope);
    entry.references++;
    let released = false;
    return () => { if (!released) { released = true; entry.references--; } };
  }
  read(scope: WorkScope, index?: any): any[] {
    if (!this.ready) { this.enabled = true; return []; }
    const newlyGlobal = scope.backgroundAll && !this.allRequested;
    if (scope.backgroundAll) this.allRequested = true;
    if (!this.enabled || newlyGlobal) { this.enabled = true; this.refresh(); }
    const legacy = this.legacyScope(scope);
    if (scope.backgroundHistory) { this.metrics.historyQueries++; return index.records.map((record: any) => record.meta); }
    // Retained terminals stay visible by default, but a sidecar dismissal must
    // be observed even before its watcher notification is delivered.
    if (this.status !== "degraded" && this.db) this.refreshRecent(legacy, legacy.recentRevision ?? 0);
    const legacyRows = this.status === "degraded" ? legacy.rows : this.visibleLegacy(legacy.origin);
    const rows = [...new Map([...this.pendingRows(legacy), ...(scope.backgroundAll ? this.rows : [...this.rows, ...legacy.recent])].map(row => [row.id, row])).values()];
    return [...rows.filter(row => row.owner.kind === "parent-session" && row.dismissedAt === undefined
      && (scope.backgroundAll || row.owner.workspace === scope.cwd && row.owner.sessionId === scope.sessionId) && (!scope.active || row.active)),
      ...legacyRows.filter((row: any) => (scope.backgroundAll || !row.callbackOrigin || row.callbackOrigin && belongsToOrigin(row, legacy.origin)
        && (scope.sessionId || row.spawnPid === scope.processId)) && (!scope.active || row.status === "running"))];
  }
  close(): Promise<void> {
    this.closed = true;
    if (this.expiry) clearTimeout(this.expiry);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear(); this.inbox?.close(); this.inbox = undefined;
    if (this.history) return this.history.close().then(() => { this.ownDb?.close(); this.ownDb = undefined; });
    this.ownDb?.close(); this.ownDb = undefined; return Promise.resolve();
  }
  get historyStatus() { return this.history?.queryStatus ?? "degraded"; }
  get historyReason() { return this.history?.reason; }
  get historyMetrics() { return this.history?.metrics; }
  historyIndex(scope: WorkScope) {
    if (!this.ready) throw new Error("Background inbox coverage is unverified");
    this.read({ ...scope, backgroundHistory: false });
    if (!this.history) throw new Error("Background history requires the shared root index");
    return this.history.read(scope);
  }
}
