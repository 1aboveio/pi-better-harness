// Generated from packages/operation-coordinator/src/changes.ts. Do not edit directly.
/**
 * Durable, owner-scoped change hints.
 *
 * The shared Background Tasks coordinator is the only process that scans the
 * shared registry. It reads these hints (written in the same transaction as the
 * evidence they describe) and forwards each one only to clients subscribed to
 * the recorded execution owner. A hint is not a delivery and never starts a
 * model turn: the receiving Pi-side host re-reads its own operation/wait/outbox
 * records and applies the existing callback, branch and acknowledgement rules.
 */
import {
    columnNullableNumber,
    columnNullableText,
    columnNumber,
    columnText,
    getRows,
    run,
    type StoreContext,
} from "./sqlite.ts";
import { normalizeOwner } from "./validate.ts";
import type {
    ChangeFilter,
    CoordinatorChange,
    OwnerIdentity,
} from "./types.ts";

export interface AppendChangeInput {
    kind: string;
    owner: OwnerIdentity;
    operationId?: string | null;
    taskId?: string | null;
    terminalRevision?: number;
    waitId?: string | null;
    generation?: number | null;
}

function mapChange(row: Record<string, unknown>): CoordinatorChange {
    return {
        seq: columnNumber(row, "seq"),
        at: columnNumber(row, "at"),
        kind: columnText(row, "kind"),
        operationId: columnNullableText(row, "operation_id"),
        taskId: columnNullableText(row, "task_id"),
        owner: {
            kind: columnText(row, "owner_kind") as OwnerIdentity["kind"],
            sessionId: columnText(row, "owner_session_id"),
            workspace: columnText(row, "owner_workspace"),
            branchId: columnNullableText(row, "owner_branch_id"),
            goalId: columnNullableText(row, "owner_goal_id"),
        },
        terminalRevision: columnNumber(row, "terminal_revision"),
        waitId: columnNullableText(row, "wait_id"),
        generation: columnNullableNumber(row, "generation"),
    };
}

/**
 * Append one hint. Callers do this inside the transaction that made the change,
 * so a committed fact always has a durable hint even if the coordinator crashes
 * before it broadcasts anything.
 */
export function appendChange(ctx: StoreContext, input: AppendChangeInput): CoordinatorChange {
    const owner = normalizeOwner("owner", input.owner);
    const at = ctx.now();
    const result = ctx.db.prepare(
        `INSERT INTO coordinator_changes (
            at, kind, operation_id, task_id,
            owner_kind, owner_session_id, owner_workspace, owner_branch_id, owner_goal_id,
            terminal_revision, wait_id, generation
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        at,
        input.kind,
        input.operationId ?? null,
        input.taskId ?? null,
        owner.kind,
        owner.sessionId,
        owner.workspace,
        owner.branchId ?? null,
        owner.goalId ?? null,
        input.terminalRevision ?? 0,
        input.waitId ?? null,
        input.generation ?? null,
    );
    const row = getRows(ctx, "SELECT * FROM coordinator_changes WHERE seq = ?", Number(result.lastInsertRowid))[0];
    if (!row) throw new Error("coordinator change hint was not readable after insert");
    return mapChange(row);
}

export function listChanges(ctx: StoreContext, filter: ChangeFilter = {}): CoordinatorChange[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.owner) {
        const owner = normalizeOwner("owner", filter.owner);
        clauses.push(
            "owner_kind = ? AND owner_session_id = ? AND owner_workspace = ? AND coalesce(owner_branch_id, '') = ? AND coalesce(owner_goal_id, '') = ?",
        );
        params.push(owner.kind, owner.sessionId, owner.workspace, owner.branchId ?? "", owner.goalId ?? "");
    }
    if (filter.afterSeq !== undefined) {
        clauses.push("seq > ?");
        params.push(Math.max(0, Math.floor(filter.afterSeq)));
    }
    if (filter.throughSeq !== undefined) {
        clauses.push("seq <= ?");
        params.push(Math.max(0, Math.floor(filter.throughSeq)));
    }
    const limit = filter.limit === undefined ? 1_000 : Math.min(10_000, Math.max(1, Math.floor(filter.limit)));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return getRows(
        ctx,
        `SELECT * FROM coordinator_changes ${where} ORDER BY seq LIMIT ?`,
        ...params,
        limit,
    ).map(mapChange);
}

export function latestChangeSeq(ctx: StoreContext): number {
    const row = getRows(ctx, "SELECT MAX(seq) AS seq FROM coordinator_changes")[0];
    return row ? columnNullableNumber(row, "seq") ?? 0 : 0;
}

/** Oldest retained hint, used to detect a cursor that predates pruning. */
export function oldestChangeSeq(ctx: StoreContext): number | null {
    const row = getRows(ctx, "SELECT MIN(seq) AS seq FROM coordinator_changes")[0];
    return row ? columnNullableNumber(row, "seq") : null;
}

/**
 * Bound the hint journal by both age and count. Pruning is safe because the
 * coordinator tells a client whose cursor predates the retained window to take
 * a fresh owner-scoped snapshot instead of silently skipping missing history.
 *
 * Only a contiguous sequence prefix is removed. Timestamps are not monotonic
 * (a clock rollback can put a newer row at an older time); deleting by time
 * alone could leave holes inside the retained sequence and make a lost cursor
 * indistinguishable from a complete one. The first row that fails the age
 * horizon blocks every later row, even if that later row is old enough.
 */
export function pruneChangesBefore(ctx: StoreContext, cutoff: number, keepLatest = 10_000): number {
    const keep = Math.max(0, Math.floor(keepLatest));
    const at = Math.floor(cutoff);
    return ctx.transaction(() => {
        const counts = getRows(
            ctx,
            "SELECT COUNT(*) AS total, MAX(seq) AS max_seq FROM coordinator_changes",
        )[0];
        const total = Number(counts?.total ?? 0);
        if (total === 0) return 0;
        const maxSeq = columnNumber(counts as Record<string, unknown>, "max_seq");
        const kept = Math.min(keep, total);
        const newestKept = kept > 0
            ? getRows(
                ctx,
                "SELECT seq FROM coordinator_changes ORDER BY seq LIMIT 1 OFFSET ?",
                total - kept,
            )[0]
            : undefined;
        const oldestNonEligible = getRows(
            ctx,
            "SELECT MIN(seq) AS seq FROM coordinator_changes WHERE at >= ?",
            at,
        )[0];
        const barriers = [
            newestKept ? columnNumber(newestKept, "seq") : undefined,
            oldestNonEligible ? columnNullableNumber(oldestNonEligible, "seq") : null,
        ].filter((value): value is number => typeof value === "number");
        const limit = barriers.length > 0 ? Math.min(...barriers) : maxSeq + 1;
        if (limit <= 1) return 0;
        return run(ctx, "DELETE FROM coordinator_changes WHERE seq < ?", limit);
    });
}
