import { bumpChangeRevision } from "./discovery.ts";
import { getOperation } from "./operations.ts";
import { columnNumber, columnText, getRows, run, type StoreContext } from "./sqlite.ts";
import { MAX_TASK_LIFETIME_MS } from "./task-lifetime.ts";
import { cancelGeneration } from "./waits.ts";

const reason = "24-hour task lifetime exceeded";
const batch = 8;

export function overdueOperations(ctx: StoreContext) {
    return getRows(ctx, `SELECT operation_id FROM operations WHERE phase = 'running' AND terminal_revision = 0
        AND created_at <= ? ORDER BY created_at LIMIT ?`, ctx.now() - MAX_TASK_LIFETIME_MS, batch)
        .map(row => getOperation(ctx, columnText(row, "operation_id"))!)
        .filter(operation => operation.phase === "running");
}

export function expireWaits(ctx: StoreContext): number {
    const now = ctx.now();
    const cutoff = now - MAX_TASK_LIFETIME_MS;
    const waits = getRows(ctx, `SELECT wait_id, generation FROM waits WHERE phase NOT IN ('consumed', 'cancelled')
        AND dispatch_disarmed = 0 AND created_at <= ? ORDER BY created_at LIMIT ?`, cutoff, batch);
    const claims = getRows(ctx, `SELECT claim_id FROM resume_claims WHERE state IN ('claimed', 'published')
        AND claimed_at <= ? ORDER BY claimed_at LIMIT ?`, cutoff, batch);
    if (!waits.length && !claims.length) return 0;
    return ctx.transaction(() => {
        let changed = 0;
        for (const row of waits) {
            const id = columnText(row, "wait_id"), generation = columnNumber(row, "generation");
            if (!ctx.db.prepare(`SELECT 1 FROM waits WHERE wait_id = ? AND generation = ?
                AND phase NOT IN ('consumed', 'cancelled') AND dispatch_disarmed = 0 AND created_at <= ?`).get(id, generation, cutoff)) continue;
            cancelGeneration(ctx, id, generation, reason);
            changed++;
        }
        // Published claims can outlive consumed waits or a disarmed assignment.
        for (const row of claims) {
            changed += run(ctx, `UPDATE resume_claims SET state = 'invalidated', invalidated_at = ?, reason = ?
                WHERE claim_id = ? AND state IN ('claimed', 'published') AND claimed_at <= ?`,
                now, reason, columnText(row, "claim_id"), cutoff);
        }
        if (changed) bumpChangeRevision(ctx);
        return changed;
    });
}
