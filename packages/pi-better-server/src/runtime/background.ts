import { processMatchesStart } from "../daemon-owner.ts";
import { createRequire } from "node:module";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
// @ts-expect-error Generated canonical passive runner observation.
import { snapshot } from "./domain/background/snapshot.mjs";
// @ts-expect-error Generated canonical registry queries.
import { observeMetasForOrigin, belongsToOrigin, readMeta } from "./domain/background/registry.mjs";
import { BackgroundHistory } from "./background-history.ts";
import type { WorkScope } from "./read-model.ts";

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
  private terminalProjections = new Map<string, { version: string; row: any }>();
  private signature = "";
  private root: string;
  private directory: string;
  private enabled = false;
  private allRequested = false;
  private history?: BackgroundHistory;
  private legacy = new Map<string, BackgroundScope>();
  private recentRevision?: number;
  private recent: any[] = [];
  status: "ready" | "degraded" = "ready";
  reason?: string;
  get connectionCount() { return this.readConnection ? 0 : this.ownDb ? 1 : 0; }
  get scopeCount() { return this.legacy.size; }
  livenessReasons(options: { refresh?: boolean } = {}) {
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
        const inspection = snapshot(this.directoryFor(op), op.task_id);
        const claim = inspection?.claim;
        return claim && !inspection.terminal && inspection.token === op.launch_token && processMatchesStart(claim.pid, claim.pidStartTime)
          ? [{ kind: "runner", id: op.task_id, owner: { kind: op.owner_kind, sessionId: op.owner_session_id, workspace: op.owner_workspace }, operationId: op.operation_id,
            lastProgressAt: inspection.command?.startedAt ?? claim.claimedAt,
            nextDeadline: inspection.launch.timeoutSeconds ? inspection.launch.createdAt + inspection.launch.timeoutSeconds * 1000 : null,
            recovery: "observe-existing-runner" }] : [];
      } catch (error) { this.status = "degraded"; this.reason = String(error); return []; }
    });
  }
  readonly metrics = { runnerSnapshots: 0, activeQueries: 0, historyQueries: 0 };
  private directoryFor(op: any): string {
    if (!op.supervision_host_id?.startsWith("server:")) return this.directory;
    const row = this.db.prepare("SELECT value FROM coordinator_state WHERE key = ?").get(`result-supervision-v1:${op.operation_id}`);
    if (!row) throw new Error("Captured result-supervision directory unavailable");
    const grant = JSON.parse(row.value);
    if (grant.launchToken !== op.launch_token || typeof grant.directory !== "string") throw new Error("Captured runner execution identity differs");
    return grant.directory;
  }
  constructor(root: string, directory = join(tmpdir(), process.env.VITEST_POOL_ID ? `pi-better-background-tasks-vitest-${process.env.VITEST_POOL_ID}` : "pi-better-background-tasks", "supervisor"), indexDb?: any, changed = () => {}, readConnection?: (refresh?: boolean) => any) {
    this.readConnection = readConnection;
    this.root = root; this.directory = directory;
    if (indexDb) this.history = new BackgroundHistory(indexDb, directory, () => {
      if (this.status === "degraded") throw new Error(this.reason);
      return this.db;
    }, operations => this.project(operations, false), changed);
  }
  refresh(): boolean {
    if (!this.enabled) return false;
    try {
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
      const path = join(this.root, "operation-coordinator.sqlite");
      let identity;
      try { const info = statSync(path, { bigint: true }); identity = `${info.dev}:${info.ino}`; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (identity !== this.identity) { this.terminalProjections.clear(); this.recentRevision = undefined; this.recent = []; for (const entry of this.legacy.values()) { entry.pendingRevision = undefined; entry.recentRevision = undefined; entry.recent = []; } this.history?.invalidate(); this.ownDb?.close(); this.ownDb = undefined; this.identity = identity; }
      if (!identity && this.knownCoordinator) throw new Error("Coordinator source disappeared; retaining the previous observation");
      if (identity) {
        if (this.readConnection) this.readConnection();
        else this.ownDb ??= new DatabaseSync(path, { readOnly: true });
        this.knownCoordinator = true;
        const version = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()?.value;
        if (!["1", "2", "3", "4"].includes(version)) throw new Error("Unsupported coordinator schema");
      }
      this.metrics.activeQueries++;
      const revision = Number(this.db?.prepare("SELECT value FROM coordinator_state WHERE key = 'change_revision'").get()?.value ?? 0);
      const hasPendingIndex = Boolean(this.db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_parent_callbacks'").get());
      const operations = this.db ? this.db.prepare("SELECT * FROM operations WHERE phase = 'running' AND observer_kind = 'local-supervisor'").all() : [];
      // Active snapshots retain a bounded recent window. Complete history is
      // available through the separately paginated history index.
      if (this.allRequested && this.db && this.recentRevision !== revision) {
        this.recent = this.db.prepare(`SELECT * FROM operations WHERE observer_kind='local-supervisor'
          AND terminal_at >= ? AND terminal_revision > 0
          ORDER BY terminal_at DESC, operation_id DESC LIMIT ?`).all(Date.now() - 30000, DISCOVERY_PAGE_SIZE);
        this.recentRevision = revision;
      }
      this.recent = this.recent.filter(op => Date.now() - op.terminal_at < 30000);
      operations.push(...this.recent);
      const rows = this.project(operations);
      // A passive runner may finish before its manager publishes the outcome.
      // Invalidate history on that exact state transition, not on scope/projection
      // churn (which would continually restart a yielding history build).
      const previousRows = new Map(this.rows.map(row => [row.id, row]));
      if (rows.some(row => { const previous = previousRows.get(row.id); return previous
        && (previous.status !== row.status || previous.active !== row.active); })) this.history?.invalidate();
      for (const entry of this.legacy.values()) {
        if (hasPendingIndex) this.refreshPending(entry, revision);
        this.refreshRecent(entry, revision);
        const active = observeMetasForOrigin(entry.origin);
        const retained = entry.rows.map(row => readMeta(row.id)).filter((row: any) => row && row.dismissedAt === undefined
          && row.status !== "running" && (!row.endedAt || Date.now() - row.endedAt < 30000));
        entry.rows = [...active, ...retained];
      }
      const signature = JSON.stringify([rows, [...this.legacy.values()].flatMap(entry => [...entry.rows, ...entry.recent, ...this.pendingRows(entry)]).sort((a, b) => a.id.localeCompare(b.id))]);
      const changed = signature !== this.signature || this.status !== "ready";
      // Projection churn must not cancel a yielding history build. Its own
      // source versions and watchers invalidate only changed source facts.
      this.rows = rows; this.signature = signature; this.status = "ready"; this.reason = undefined;
      this.history?.reconcile();
      return changed;
    } catch (error) {
      const reason = String(error);
      const changed = this.status !== "degraded" || this.reason !== reason;
      this.status = "degraded"; this.reason = reason;
      return changed;
    }
  }
  /** Captured assignment, never the newest assignment in a reused conversation. */
  private workerParent(op: any, context: any): any {
    if (op.owner_kind !== "worker-conversation") return undefined;
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='assignment_bindings'").get()) return undefined;
    let bindings: any[];
    if (typeof context.workerAttemptId === "string") {
      bindings = this.db.prepare(`SELECT b.* FROM assignment_bindings b JOIN assignment_attempts a
        ON a.assignment_id=b.assignment_id WHERE a.attempt_id=?`).all(context.workerAttemptId);
    } else {
      // Older launches are visible only when a durable wait proves the assignment.
      bindings = this.db.prepare(`SELECT DISTINCT b.* FROM assignment_bindings b JOIN waits w
        ON json_extract(w.origin_json,'$.assignmentRef')=b.assignment_id
        JOIN wait_dependencies d ON d.wait_id=w.wait_id AND d.generation=w.generation
        WHERE d.operation_id=?`).all(op.operation_id);
    }
    if (bindings.length !== 1) return undefined;
    const owner = JSON.parse(bindings[0].owner_json), recipient = JSON.parse(bindings[0].recipient_json);
    if (owner.kind !== op.owner_kind || owner.sessionId !== op.owner_session_id || owner.workspace !== op.owner_workspace
      || (owner.branchId ?? null) !== (op.owner_branch_id ?? null) || (owner.goalId ?? null) !== (op.owner_goal_id ?? null) || recipient.kind !== "parent-session") return undefined;
    return {parentAgentId: owner.sessionId, parentRecipient: recipient, readOnly: true};
  }
  private project(operations: any[], useCache = true) {
      const revision = this.db?.prepare("SELECT value FROM coordinator_state WHERE key = 'change_revision'").get()?.value;
      const directories = new Map<string, string>();
      return operations.map((op: any) => {
        const directory = this.directoryFor(op);
        if (!directories.has(directory)) {
          let identity = "missing";
          try { const info = statSync(join(directory, "observed"), { bigint: true }); identity = `${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}`; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          directories.set(directory, identity);
        }
        const version = JSON.stringify([op, revision, directories.get(directory)]), cached = this.terminalProjections.get(op.operation_id);
        if (useCache && op.terminal_revision > 0 && cached?.version === version) return cached.row;
        this.metrics.runnerSnapshots++;
        const inspection = snapshot(directory, op.task_id);
        let context: any = {};
        try { context = JSON.parse(readFileSync(join(directory, "observed", `${op.task_id}.json`), "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const terminal = inspection?.terminal === true || op.terminal_revision > 0;
        const status = inspection?.terminal ? inspection.status : op.terminal_revision > 0 ? op.terminal_outcome : inspection?.status ?? "running";
        const waits = this.db.prepare(`SELECT w.wait_id, w.generation, w.phase FROM waits w JOIN wait_dependencies d
          ON w.wait_id = d.wait_id AND w.generation = d.generation WHERE d.operation_id = ?
          AND w.owner_kind = ? AND w.owner_session_id = ? AND w.owner_workspace = ?
          AND w.phase NOT IN ('consumed', 'cancelled') AND w.dispatch_disarmed = 0`).all(op.operation_id, op.owner_kind, op.owner_session_id, op.owner_workspace)
          .map((w: any) => ({ waitId: w.wait_id, generation: w.generation, phase: w.phase }));
        const parent = this.workerParent(op, context);
        const row = { ...parent, durable: true, id: op.task_id, operationId: op.operation_id, kind: context.kind ?? inspection?.kind ?? "process",
          status, active: !terminal, terminal, attention: terminal && status !== "succeeded", waits,
          owner: { kind: op.owner_kind, sessionId: op.owner_session_id, workspace: op.owner_workspace },
          startedAt: inspection?.result?.startedAt ?? inspection?.launch.createdAt ?? op.created_at,
          endedAt: inspection?.result?.endedAt ?? op.terminal_at ?? undefined,
          cwd: inspection?.launch.cwd ?? op.owner_workspace, name: context.name, command: context.command, argv: context.argv,
          dismissedAt: context.dismissedAt, exitCode: inspection?.result?.exitCode ?? null, logPaths: inspection?.logs ?? {} };
        if (op.terminal_revision > 0) {
          this.terminalProjections.delete(op.operation_id);
          this.terminalProjections.set(op.operation_id, { version, row });
          if (this.terminalProjections.size > 4096) this.terminalProjections.delete(this.terminalProjections.keys().next().value!);
        }
        return row;
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
    if (entry.recentRevision !== revision) {
      const operations = this.db.prepare(`SELECT * FROM operations o WHERE observer_kind='local-supervisor' AND (
          (owner_kind='parent-session' AND owner_workspace=?1 AND owner_session_id=?2) OR
          ${this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='assignment_bindings'").get() ? `(owner_kind='worker-conversation' AND EXISTS (SELECT 1 FROM assignment_bindings b
            WHERE json_extract(b.owner_json,'$.sessionId')=o.owner_session_id
              AND json_extract(b.owner_json,'$.workspace')=o.owner_workspace
              AND json_extract(b.recipient_json,'$.workspace')=?1 AND json_extract(b.recipient_json,'$.sessionId')=?2))` : '0'})
        AND terminal_revision>0 AND terminal_at>=?3 ORDER BY terminal_at DESC,operation_id DESC LIMIT ?4`)
        .all(entry.origin.cwd, entry.origin.sessionId ?? "", Date.now() - 30000, DISCOVERY_PAGE_SIZE);
      entry.recent = this.project(operations);
      entry.recentRevision = revision;
    } else {
      // Refresh changed sidecars through the projection cache, without retaining
      // another owner's burst in this exact scope's recent-window allowance.
      const operations = entry.recent.filter(row => Date.now() - row.endedAt < 30000)
        .map(row => this.db.prepare("SELECT * FROM operations WHERE operation_id=?").get(row.operationId)).filter(Boolean);
      entry.recent = this.project(operations);
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
      entry = { origin, rows: observeMetasForOrigin(origin), references: 0, pending: [], recent: [] };
      if (this.status !== "degraded" && this.db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_parent_callbacks'").get())
        this.refreshPending(entry, Number(this.db.prepare("SELECT value FROM coordinator_state WHERE key='change_revision'").get()?.value ?? 0));
      if (this.status !== "degraded" && this.db) this.refreshRecent(entry, Number(this.db.prepare("SELECT value FROM coordinator_state WHERE key='change_revision'").get()?.value ?? 0));
    }
    this.legacy.delete(key); this.legacy.set(key, entry);
    return entry;
  }
  retain(scope: { cwd?: string; sessionId?: string }) {
    const entry = this.legacyScope(scope);
    entry.references++;
    let released = false;
    return () => { if (!released) { released = true; entry.references--; } };
  }
  read(scope: WorkScope, index?: any): any[] {
    const newlyGlobal = scope.backgroundAll && !this.allRequested;
    if (scope.backgroundAll) this.allRequested = true;
    if (!this.enabled || newlyGlobal) { this.enabled = true; this.refresh(); }
    const legacy = this.legacyScope(scope);
    if (scope.backgroundHistory) { this.metrics.historyQueries++; return index.records.map((record: any) => record.meta); }
    const legacyRows = legacy.rows;
    const exact = scope.id && this.db ? this.project(this.db.prepare("SELECT * FROM operations WHERE task_id=? AND observer_kind='local-supervisor'").all(scope.id)) : [];
    const rows = [...new Map([...exact, ...this.pendingRows(legacy), ...(scope.backgroundAll ? this.rows : [...this.rows, ...legacy.recent])].map(row => [row.id, row])).values()];
    return [...rows.filter(row => (!scope.id || row.id === scope.id) && row.dismissedAt === undefined && (
      row.owner.kind === "parent-session" && (scope.backgroundAll || row.owner.workspace === scope.cwd && row.owner.sessionId === scope.sessionId)
      || !scope.backgroundAll && row.parentRecipient?.workspace === scope.cwd && row.parentRecipient?.sessionId === scope.sessionId)
      && (!scope.active || row.active)),
      ...legacyRows.filter((row: any) => (scope.backgroundAll || row.callbackOrigin && belongsToOrigin(row, legacy.origin)
        && (scope.sessionId || row.spawnPid === scope.processId)) && (!scope.active || row.status === "running"))];
  }
  close(): Promise<void> {
    if (this.history) return this.history.close().then(() => { this.ownDb?.close(); });
    this.ownDb?.close(); return Promise.resolve();
  }
  get historyStatus() { return this.history?.status ?? "degraded"; }
  get historyReason() { return this.history?.reason; }
  get historyMetrics() { return this.history?.metrics; }
  historyIndex(scope: WorkScope) {
    this.read({ ...scope, backgroundHistory: false });
    if (!this.history) throw new Error("Background history requires the shared root index");
    return this.history.read(scope);
  }
}
