import { CANCELLED_ROW_RETENTION_MS, isRecord, type RushPlan, type WorkflowPlanBinding } from "./workflow-plan.js";

export const CANCELLED_ROWS_ENTRY = "pi-better-plan-cancelled-rows";

export function observeCancelledRows(
  plan: RushPlan,
  binding: WorkflowPlanBinding,
  entries: Iterable<{ type: string; customType?: string; data?: unknown }>,
  append: (type: string, data: unknown) => void,
  now = Date.now(),
): void {
  // Keep display deadlines in branch history, not in the workflow-owned task plan.
  let previous: Record<string, unknown> = {};
  for (const entry of entries) {
    const data = entry.data;
    if (entry.type === "custom" && entry.customType === CANCELLED_ROWS_ENTRY && isRecord(data) &&
        data.version === 1 && data.path === binding.path && data.runId === binding.runId &&
        data.owner === binding.owner && isRecord(data.rows)) previous = data.rows;
  }
  const rows: Record<string, number> = Object.create(null);
  for (const unit of plan.issues) {
    if (unit.status !== "cancelled" && unit.status !== "canceled") continue;
    const saved = previous[unit.id];
    unit.cancelledAt = typeof saved === "number" && Number.isFinite(saved) && saved >= 0 ? saved : now;
    rows[unit.id] = unit.cancelledAt;
  }
  if (JSON.stringify(rows) !== JSON.stringify(previous)) {
    append(CANCELLED_ROWS_ENTRY, { version: 1, ...binding, rows });
  }
}

export function cancelledRowsClearDelay(plan: RushPlan, now = Date.now()): number | null {
  const deadlines = plan.issues.flatMap(unit => unit.cancelledAt === undefined ? [] : [unit.cancelledAt + CANCELLED_ROW_RETENTION_MS])
    .filter(deadline => deadline > now);
  return deadlines.length ? Math.min(...deadlines) - now : null;
}