import { join } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
// @ts-expect-error Generated canonical coordinator.
import { openStore } from "./domain/coordinator/index.mjs";
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
  private timer: NodeJS.Timeout;
  readonly hostId: string;
  readonly epoch: string;
  reason?: string;
  constructor(root: string, epoch: string) {
    this.epoch = epoch;
    this.hostId = `server:${epoch}`;
    this.store = openStore({ path: join(root, "operation-coordinator.sqlite") });
    this.reconcile();
    this.timer = setInterval(() => this.reconcile(), 250);
    this.timer.unref();
  }
  reconcile() {
    try {
      for (let grant of this.store.resultSupervisions()) {
        const operation = this.store.getOperation(grant.operationId);
        if (!operation || operation.terminalRevision > 0) continue;
        if (grant.epoch !== this.epoch) {
          // Daemon startup has already proved the preceding root owner exited.
          grant = { ...grant, hostId: this.hostId, epoch: this.epoch };
          this.store.recoverResultSupervision(grant);
        }
        const inspection = createLocalSupervisor({ directory: grant.directory }).inspect(operation.taskId);
        if (!inspection || inspection.token !== grant.launchToken) {
          this.reason = "reconciling: exact runner evidence unavailable; no replacement command is permitted";
          continue;
        }
        if (inspection.terminal) this.store.publishSupervisedResult({ operationId: operation.operationId,
          epoch: this.epoch, publication: supervisorTerminalPublication(operation, inspection) });
      }
    } catch (error) { this.reason = String(error); }
  }
  close() { clearInterval(this.timer); this.store.close(); }
}
