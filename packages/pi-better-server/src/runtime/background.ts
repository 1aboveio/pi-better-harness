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

/** Root-owned query connection; never opens a supervisor or mutates source facts. */
export class BackgroundObservation {
  private db: any;
  private identity?: string;
  private knownCoordinator = false;
  private rows: any[] = [];
  private signature = "";
  private root: string;
  private directory: string;
  private enabled = false;
  private history?: BackgroundHistory;
  private legacy = new Map<string, { origin: { cwd: string; sessionId?: string }; rows: any[]; references: number }>();
  status: "ready" | "degraded" = "ready";
  reason?: string;
  get connectionCount() { return this.db ? 1 : 0; }
  get scopeCount() { return this.legacy.size; }
  livenessReasons() {
    this.enabled = true;
    this.refresh();
    if (!this.db) return [];
    const version = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()?.value;
    if (!["1", "2", "3", "4"].includes(version)) return [];
    let operations: any[] = [];
    try { operations = this.db ? this.db.prepare("SELECT * FROM operations WHERE phase = 'running' AND observer_kind = 'local-supervisor' AND terminal_revision = 0").all() : []; }
    catch (error) { this.status = "degraded"; this.reason = String(error); return []; }
    return operations.flatMap((op: any) => {
      try {
        const inspection = snapshot(this.directory, op.task_id);
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
  constructor(root: string, directory = join(tmpdir(), process.env.VITEST_POOL_ID ? `pi-better-background-tasks-vitest-${process.env.VITEST_POOL_ID}` : "pi-better-background-tasks", "supervisor"), indexDb?: any, changed = () => {}) {
    this.root = root; this.directory = directory;
    if (indexDb) this.history = new BackgroundHistory(indexDb, directory, () => {
      if (this.status === "degraded") throw new Error(this.reason);
      return this.db;
    }, operations => this.project(operations), changed);
  }
  refresh(): boolean {
    if (!this.enabled) return false;
    try {
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
      const path = join(this.root, "operation-coordinator.sqlite");
      let identity;
      try { const info = statSync(path, { bigint: true }); identity = `${info.dev}:${info.ino}`; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (identity !== this.identity) { this.history?.invalidate(); this.db?.close(); this.db = undefined; this.identity = identity; }
      if (!identity && this.knownCoordinator) throw new Error("Coordinator source disappeared; retaining the previous observation");
      if (identity) {
        this.db ??= new DatabaseSync(path, { readOnly: true });
        this.knownCoordinator = true;
        const version = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()?.value;
        if (!["1", "2", "3", "4"].includes(version)) throw new Error("Unsupported coordinator schema");
      }
      this.metrics.activeQueries++;
      const operations = this.db ? this.db.prepare("SELECT * FROM operations WHERE phase = 'running' AND observer_kind = 'local-supervisor'").all() : [];
      // Revisit only known recent terminal identities, never enumerate completed history.
      for (const row of this.rows) {
        if (operations.some((op: any) => op.operation_id === row.operationId)) continue;
        if (row.endedAt && Date.now() - row.endedAt >= 30000) continue;
        const operation = this.db.prepare("SELECT * FROM operations WHERE operation_id = ?").get(row.operationId);
        if (operation) operations.push(operation);
      }
      const rows = this.project(operations);
      for (const entry of this.legacy.values()) {
        const active = observeMetasForOrigin(entry.origin);
        const retained = entry.rows.map(row => readMeta(row.id)).filter((row: any) => row && row.dismissedAt === undefined
          && row.status !== "running" && (!row.endedAt || Date.now() - row.endedAt < 30000));
        entry.rows = [...active, ...retained];
      }
      const signature = JSON.stringify([rows, [...this.legacy.values()].flatMap(entry => entry.rows).sort((a, b) => a.id.localeCompare(b.id))]);
      const changed = signature !== this.signature || this.status !== "ready";
      if (changed) this.history?.invalidate();
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
  private project(operations: any[]) {
      return operations.map((op: any) => {
        this.metrics.runnerSnapshots++;
        const inspection = snapshot(this.directory, op.task_id);
        let context: any = {};
        try { context = JSON.parse(readFileSync(join(this.directory, "observed", `${op.task_id}.json`), "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const terminal = inspection?.terminal === true || op.terminal_revision > 0;
        const status = inspection?.terminal ? inspection.status : op.terminal_revision > 0 ? op.terminal_outcome : inspection?.status ?? "running";
        const waits = this.db.prepare(`SELECT w.wait_id, w.generation, w.phase FROM waits w JOIN wait_dependencies d
          ON w.wait_id = d.wait_id AND w.generation = d.generation WHERE d.operation_id = ?
          AND w.owner_kind = ? AND w.owner_session_id = ? AND w.owner_workspace = ?
          AND w.phase NOT IN ('consumed', 'cancelled') AND w.dispatch_disarmed = 0`).all(op.operation_id, op.owner_kind, op.owner_session_id, op.owner_workspace)
          .map((w: any) => ({ waitId: w.wait_id, generation: w.generation, phase: w.phase }));
        return { durable: true, id: op.task_id, operationId: op.operation_id, kind: context.kind ?? inspection?.kind ?? "process",
          status, active: !terminal, terminal, attention: terminal && status !== "succeeded", waits,
          owner: { kind: op.owner_kind, sessionId: op.owner_session_id, workspace: op.owner_workspace },
          startedAt: inspection?.result?.startedAt ?? inspection?.launch.createdAt ?? op.created_at,
          endedAt: inspection?.result?.endedAt ?? op.terminal_at ?? undefined,
          cwd: inspection?.launch.cwd ?? op.owner_workspace, name: context.name, command: context.command, argv: context.argv,
          dismissedAt: context.dismissedAt, exitCode: inspection?.result?.exitCode ?? null, logPaths: inspection?.logs ?? {} };
      }).filter(Boolean);
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
      entry = { origin, rows: observeMetasForOrigin(origin), references: 0 };
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
    if (!this.enabled) { this.enabled = true; this.refresh(); }
    const legacy = this.legacyScope(scope);
    if (scope.backgroundHistory) { this.metrics.historyQueries++; return index.records.map((record: any) => record.meta); }
    const legacyRows = legacy.rows;
    const rows = this.rows;
    return [...rows.filter(row => row.owner.kind === "parent-session" && row.dismissedAt === undefined
      && (scope.backgroundAll || row.owner.workspace === scope.cwd && row.owner.sessionId === scope.sessionId) && (!scope.active || row.active)),
      ...legacyRows.filter((row: any) => (scope.backgroundAll || row.callbackOrigin && belongsToOrigin(row, legacy.origin)
        && (scope.sessionId || row.spawnPid === scope.processId)) && (!scope.active || row.status === "running"))];
  }
  close(): Promise<void> {
    if (this.history) return this.history.close().then(() => { this.db?.close(); });
    this.db?.close(); return Promise.resolve();
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
