/**
 * Daily legacy task-registry maintenance used by the extension.
 *
 * The reconciliation/deletion mechanics live in `maintenance-core.ts` so the
 * shared coordinator can run the same pass in its standalone closure. This
 * wrapper keeps the failure-journal side effect and accepts the same optional
 * retention authority as the core.
 */
import { recordFailure } from "./failures.js";
import {
  DEFAULT_TASK_RETENTION_MS,
  runTaskMaintenanceCore,
  type RemovalDecision,
  type TaskMaintenanceCoreOptions,
} from "./maintenance-core.js";
import type { BackgroundTaskMeta } from "./types.js";

export { DEFAULT_TASK_RETENTION_MS };
export type { RemovalDecision };

export interface TaskMaintenanceOptions extends Omit<TaskMaintenanceCoreOptions, "onReconciled"> {}

export interface TaskMaintenanceResult {
  ran: boolean;
  reconciled: number;
  removed: number;
  protected: number;
  protectedReasons: string[];
}

export function runTaskMaintenance(options: TaskMaintenanceOptions = {}): TaskMaintenanceResult {
  return runTaskMaintenanceCore({
    ...options,
    onReconciled: (meta: BackgroundTaskMeta, error: string, at: number) => {
      recordFailure(meta, "execution", error, "supervisor-lost", { incomplete: true, at });
    },
  });
}
