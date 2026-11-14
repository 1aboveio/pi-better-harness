import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { processMatchesStart } from "../daemon-owner.ts";
// @ts-expect-error Generated canonical passive runner observation.
import { snapshot } from "./domain/background/snapshot.mjs";
// @ts-expect-error Generated canonical registry queries.
import { observeMetasForOrigin, listTaskRecords, belongsToOrigin, readMeta } from "./domain/background/registry.mjs";

/** Root-owned query connection; never opens a supervisor or mutates source facts. */
export class BackgroundObservation {
  private db: any;
  private rows: any[] = [];
  private signature = "";
  private root: string;
  private directory: string;
  private enabled = false;
  private legacy = new Map<string, { origin: { cwd: string; sessionId?: string }; rows: any[] }>();
  status: "ready" | "degraded" = "ready";
  reason?: string;
  get connectionCount() { return this.db ? 1 : 0; }
  livenessReasons() {
    this.enabled = true;
    this.refresh();
    return this.rows.filter(row => row.active).flatMap(row => {
      const inspection = snapshot(this.directory, row.id);
      const claim = inspection?.claim;
      return claim && processMatchesStart(claim.pid, claim.pidStartTime)
        ? [{ kind: "runner", id: row.id, owner: row.owner, operationId: row.operationId }] : [];
    });
  }
  readonly metrics = { runnerSnapshots: 0, activeQueries: 0, historyQueries: 0 };
  constructor(root: string, directory = join(tmpdir(), process.env.VITEST_POOL_ID ? `pi-better-background-tasks-vitest-${process.env.VITEST_POOL_ID}` : "pi-better-background-tasks", "supervisor")) {
    this.root = root; this.directory = directory;
  }
  refresh(): boolean {
    if (!this.enabled) return false;
    try {
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
      if (existsSync(join(this.root, "operation-coordinator.sqlite"))) {
        this.db ??= new DatabaseSync(join(this.root, "operation-coordinator.sqlite"), { readOnly: true });
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
      this.rows = rows; this.signature = signature; this.status = "ready"; this.reason = undefined;
      return changed;
    } catch (error) {
      const reason = String(error);
      const changed = this.status !== "degraded" || this.reason !== reason;
      this.status = "degraded"; this.reason = reason;
      return changed;
    }
  }
  private project(operations: any[], history = false) {
      return operations.map((op: any) => {
        if (history) {
          const observed = this.rows.find(row => row.operationId === op.operation_id);
          if (observed) return observed;
          if (op.phase === "running") return undefined;
        }
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
  read(scope: { cwd?: string; sessionId?: string; active?: boolean; backgroundHistory?: boolean; backgroundAll?: boolean }, index?: any) {
    if (!this.enabled) { this.enabled = true; this.refresh(); }
    if (!scope.cwd) throw new Error("Background activity requires an exact workspace");
    const key = JSON.stringify([scope.cwd, scope.sessionId]);
    let legacy = this.legacy.get(key);
    if (!legacy) {
      const origin = { cwd: scope.cwd, sessionId: scope.sessionId };
      legacy = { origin, rows: observeMetasForOrigin(origin) }; this.legacy.set(key, legacy);
    }
    const legacyRows = scope.backgroundHistory ? index.records.map((record: any) => record.meta).filter(Boolean) : legacy.rows;
    if (scope.backgroundHistory) this.metrics.historyQueries++;
    const rows = scope.backgroundAll && this.db ? this.project(this.db.prepare("SELECT * FROM operations WHERE owner_kind = 'parent-session' AND observer_kind = 'local-supervisor'").all(), true) : scope.backgroundHistory && this.db ? this.project(this.db.prepare(`SELECT * FROM operations
      WHERE owner_kind = 'parent-session' AND observer_kind = 'local-supervisor' AND owner_workspace = ? AND owner_session_id = ?`).all(scope.cwd, scope.sessionId), true) : this.rows;
    return [...rows.filter(row => row.owner.kind === "parent-session" && row.dismissedAt === undefined
      && (scope.backgroundAll || row.owner.workspace === scope.cwd && row.owner.sessionId === scope.sessionId) && (!scope.active || row.active)),
      ...legacyRows.filter((row: any) => (scope.backgroundAll || row.callbackOrigin && belongsToOrigin(row, legacy.origin)) && (!scope.active || row.status === "running"))];
  }
  close() { this.db?.close(); }
  historyIndex(scope: { cwd?: string; sessionId?: string; backgroundAll?: boolean }) {
    const index = listTaskRecords();
    return { ...index, records: index.records.filter((record: any) => scope.backgroundAll || !record.meta
      || !record.meta.callbackOrigin || belongsToOrigin(record.meta, scope)) };
  }
}
