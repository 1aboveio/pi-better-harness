import { join } from "node:path";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { createRequire } from "node:module";
import { acquireMutationStore } from "./mutation-store.ts";
import { ENTITY_BUDGET } from "./work-budget.ts";
// @ts-expect-error Generated canonical supervisor.
import { createLocalSupervisor } from "./domain/background/supervisor/supervisor.mjs";
// @ts-expect-error Generated canonical terminal evidence rules.
import { supervisorTerminalPublication } from "./domain/background/terminal-publication.mjs";

export function hasResultSupervision(root: string): boolean {
  const path = join(root, "operation-coordinator.sqlite");
  if (!existsSync(path)) return false;
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try { return !!db.prepare("SELECT 1 FROM coordinator_state WHERE key LIKE 'result-supervision-v1:%' LIMIT 1").get(); }
  finally { db.close(); }
}

/** Mechanical observation only. Never launches, stops, claims resumes or consumes results. */
export class RuntimeResultSupervision {
  private store: any;
  private budget: ReturnType<typeof acquireMutationStore>["budget"];
  private releaseStore: () => void;
  private timer?: NodeJS.Timeout;
  private watcher?: FSWatcher;
  private taskWatchers = new Map<string, FSWatcher>();
  private active = new Map<string, { grant: any; due: number; reason?: any; failure?: string; uncertainSince?: number }>();
  private dirty = new Set<string>();
  private position?: { generation: string; seq: number };
  private scheduled = false;
  private closed = false;
  readonly metrics = { restores: 0, feedPages: 0, inspections: 0, publications: 0, deadlineLatenessMs: 0, passes: 0 };
  readonly hostId: string;
  readonly epoch: string;
  reason?: string;
  private verificationMs: number;
  constructor(root: string, epoch: string, verificationMs = 30_000) {
    this.verificationMs = verificationMs;
    this.epoch = epoch;
    this.hostId = `server:${epoch}`;
    const lease = acquireMutationStore(root);
    this.store = lease.store;
    this.budget = lease.budget;
    this.releaseStore = lease.release;
    this.watcher = watch(root, (_event, file) => {
      if (!file || String(file).startsWith("operation-coordinator.sqlite")) this.schedule();
    });
    this.watcher.on("error", () => { this.watcher?.close(); this.watcher = undefined; });
    this.reconcile();
  }
  private schedule() {
    if (this.closed || this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => { this.scheduled = false; if (!this.closed) this.reconcile(); });
  }
  private retain(grant: any) {
    const previous = this.active.get(grant.operationId);
    if (previous && JSON.stringify(previous.grant) === JSON.stringify(grant)) return;
    const now = Date.now();
    this.active.set(grant.operationId, { grant, due: now, reason: { kind: "verification", id: grant.operationId,
      operationId: grant.operationId, owner: grant.owner, lastProgressAt: now, nextDeadline: now + this.verificationMs,
      recovery: "restore-captured-result-authority" } });
    this.dirty.add(grant.operationId);
    this.taskWatchers.get(grant.operationId)?.close();
    this.taskWatchers.delete(grant.operationId);
    try {
      const watcher = watch(join(grant.directory, "tasks", this.store.getOperation(grant.operationId).taskId), () => {
        if (this.active.has(grant.operationId)) { this.dirty.add(grant.operationId); this.schedule(); }
      });
      watcher.on("error", () => { watcher.close(); this.taskWatchers.delete(grant.operationId); });
      this.taskWatchers.set(grant.operationId, watcher);
    } catch { /* Missing task evidence is checked at its bounded deadline. */ }
  }
  private forget(id: string) {
    this.active.delete(id); this.dirty.delete(id);
    this.taskWatchers.get(id)?.close(); this.taskWatchers.delete(id);
  }
  livenessReasons() { return [...this.active.values()].flatMap(entry => entry.reason ? [entry.reason] : []); }
  manages(operationId: string) { return this.active.has(operationId); }
  reconcile() {
    if (this.closed) return;
    const release = this.budget.enter("control");
    if (!release) { this.schedule(); return; }
    this.metrics.passes++;
    try {
      this.reason = undefined;
      try {
      const page = this.store.resultSupervisionChanges(this.position);
      this.metrics.feedPages++;
      if (page.reset) {
        this.metrics.restores++;
        const grants = this.store.resultSupervisions(true);
        const ids = new Set(grants.map((grant: any) => grant.operationId));
        for (const id of this.active.keys()) if (!ids.has(id)) this.forget(id);
        for (const grant of grants) this.retain(grant);
      } else for (const id of page.operationIds) {
        const grant = this.store.resultSupervision(id);
        const operation = this.store.getOperation(id);
        if (grant && operation?.phase === "running" && !operation.terminalRevision) { this.retain(grant); this.dirty.add(id); }
        else this.forget(id);
      }
      // Restart always restores authority; this in-memory position never authorizes work.
      this.position = { generation: page.generation, seq: page.seq };
      if (page.more) this.schedule();
      } catch (error) {
        // Feed recovery must not suppress deadlines for already captured work.
        this.reason = String(error);
      }
      const now = Date.now();
      for (const [id, entry] of this.active) if (entry.due <= now) this.dirty.add(id);
      for (const id of [...this.dirty].slice(0, ENTITY_BUDGET)) {
        this.dirty.delete(id);
        const entry = this.active.get(id)!;
        let grant = entry.grant;
        this.metrics.deadlineLatenessMs = Math.max(this.metrics.deadlineLatenessMs, Math.max(0, now - entry.due));
        entry.due = now + 1000;
        const operation = this.store.getOperation(grant.operationId);
        if (!operation || operation.terminalRevision > 0) { this.forget(id); continue; }
        entry.reason = undefined;
        const uncertain = (reason: string) => {
          this.reason = reason;
          entry.failure = reason;
          entry.uncertainSince ??= now;
          if (now < entry.uncertainSince + this.verificationMs) entry.reason = {
            kind: "verification", id: operation.taskId, operationId: operation.operationId,
            owner: operation.owner, lastProgressAt: entry.uncertainSince,
            nextDeadline: entry.uncertainSince + this.verificationMs, recovery: reason,
          };
          else entry.due = Infinity;
          if (entry.reason) entry.due = Math.min(entry.due, entry.uncertainSince + this.verificationMs);
        };
        try {
        if (grant.capability?.adapter !== "background-results-v1" || !grant.capability.captured || !grant.capability.current) {
          uncertain("permission-unavailable: captured Background adapter or permission source unavailable");
          continue;
        }
        if (grant.epoch !== this.epoch) {
          // Daemon startup has already proved the preceding root owner exited.
          grant = { ...grant, hostId: this.hostId, epoch: this.epoch };
          this.store.recoverResultSupervision(grant);
          entry.grant = grant;
        }
        this.metrics.inspections++;
        const inspection = createLocalSupervisor({ directory: grant.directory }).inspect(operation.taskId);
        if (!inspection || inspection.token !== grant.launchToken) {
          uncertain("reconciling: exact runner evidence unavailable; no replacement command is permitted");
          continue;
        }
        if (!inspection.terminal && (inspection.fenceBusy || !inspection.claim?.pidStartTime)) {
          uncertain("reconciling: runner start identity or state fence is unverified; no takeover is permitted");
          continue;
        }
        if (inspection.terminal) {
          this.store.publishSupervisedResult({ operationId: operation.operationId,
            epoch: this.epoch, publication: supervisorTerminalPublication(operation, inspection) });
          this.metrics.publications++; this.forget(id);
        } else {
          entry.failure = undefined;
          entry.uncertainSince = undefined;
          entry.reason = { kind: "runner", id: operation.taskId, operationId: operation.operationId,
            launchToken: grant.launchToken, owner: operation.owner, directory: grant.directory,
            lastProgressAt: inspection.command?.startedAt ?? inspection.claim?.claimedAt ?? inspection.launch.createdAt,
            nextDeadline: entry.due, recovery: "observe-existing-runner" };
        }
        } catch (error) { uncertain(String(error)); }
      }
      this.reason ??= [...this.active.values()].find(entry => entry.failure)?.failure;
    } catch (error) { this.reason = String(error); }
    finally {
      release();
      if (this.timer) clearTimeout(this.timer);
      if (this.dirty.size) this.schedule();
      // A cheap journal page repairs missed database hints; task inspections are
      // charged only to exact dirty identities or their liveness deadline.
      const next = [...this.active.values()].reduce((deadline, entry) => Math.min(deadline, entry.due), Date.now() + 1000);
      this.timer = setTimeout(() => this.reconcile(), Math.max(1, next - Date.now()));
      this.timer.unref();
    }
  }
  close() {
    this.closed = true; if (this.timer) clearTimeout(this.timer); this.watcher?.close();
    for (const watcher of this.taskWatchers.values()) watcher.close();
    this.taskWatchers.clear(); this.releaseStore();
  }
}
