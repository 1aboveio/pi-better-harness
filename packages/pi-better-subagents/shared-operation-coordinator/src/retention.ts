// Generated from packages/operation-coordinator/src/retention.ts. Do not edit directly.
/**
 * Conservation-aware physical retention for terminal operation history.
 *
 * Preview is read-only. Apply is explicitly bounded and uses a durable
 * reservation (and, after SQLite deletion, a tombstone) so a crash between the
 * filesystem and database steps can be resumed instead of leaving a dangling
 * reference. The store itself performs no filesystem deletion; callers supply
 * the artifact reference and remove only paths they have validated as their own.
 *
 * A reserved operation cannot gain new waits, evidence pins, outbox events or
 * resume claims. Database triggers enforce that even for an older client that
 * does not call the retention API.
 */
import {
    columnNullableNumber,
    columnNullableText,
    columnNumber,
    columnText,
    getRow,
    getRows,
    run,
    type StoreContext,
} from "./sqlite.ts";
import { mapOperation } from "./rows.ts";
import { StoreError } from "./errors.ts";
import { normalizeOwner, optionalText, requireCounter, requireId } from "./validate.ts";
import type {
    OperationRecord,
    RetentionCandidate,
    RetentionPreview,
    RetentionPreviewInput,
    RetentionProtected,
    RetentionProtection,
    RetentionUnitRecord,
    ReserveRetentionInput,
} from "./types.ts";

const PENDING_OUTBOX_STATES = ["pending", "claimed", "delivered"];

function placeholders(values: readonly unknown[]): string {
    return values.map(() => "?").join(", ");
}

function existingReservation(ctx: StoreContext, operationId: string): boolean {
    return !!getRow(ctx, "SELECT operation_id FROM retention_units WHERE operation_id = ?", operationId);
}

function candidateFromOperation(operation: OperationRecord): RetentionCandidate {
    return {
        operationId: operation.operationId,
        taskId: operation.taskId,
        owner: operation.owner,
        terminalRevision: operation.terminalRevision,
        terminalOutcome: operation.terminalOutcome,
        terminalAt: operation.terminalAt,
    };
}

/**
 * Recheck every protection against current rows. This is called by preview and
 * again inside the reservation transaction, so a pin/outbox/wait created
 * between preview and apply prevents the reservation.
 */
export function retentionProtectionReasons(
    ctx: StoreContext,
    operation: OperationRecord,
    cutoff: number,
): RetentionProtection[] {
    const reasons = new Set<RetentionProtection>();
    if (operation.phase !== "terminal" || operation.terminalRevision <= 0 || operation.terminalAt === null) {
        reasons.add("nonterminal");
        if (operation.phase === "terminal") reasons.add("invalid-record");
        return [...reasons];
    }
    if (operation.terminalAt >= cutoff) reasons.add("too-recent");
    if (existingReservation(ctx, operation.operationId)) reasons.add("reservation");

    const pendingOutbox = getRow(
        ctx,
        `SELECT event_id FROM outbox_events
         WHERE operation_id = ? AND state IN (${placeholders(PENDING_OUTBOX_STATES)})
         LIMIT 1`,
        operation.operationId,
        ...PENDING_OUTBOX_STATES,
    );
    if (pendingOutbox) reasons.add("pending-outbox");

    const pin = getRow(
        ctx,
        "SELECT pin_id FROM evidence_pins WHERE operation_id = ? AND released_at IS NULL LIMIT 1",
        operation.operationId,
    );
    if (pin) reasons.add("evidence-pin");

    const waits = getRows(
        ctx,
        `SELECT DISTINCT w.wait_id, w.generation, w.phase
         FROM waits w
         JOIN wait_dependencies d ON d.wait_id = w.wait_id AND d.generation = w.generation
         WHERE d.operation_id = ?`,
        operation.operationId,
    );
    for (const wait of waits) {
        const waitId = columnText(wait, "wait_id");
        const generation = columnNumber(wait, "generation");
        const phase = columnText(wait, "phase");
        if (phase !== "consumed" && phase !== "cancelled") reasons.add("unconsumed-wait");
        const claim = getRow(
            ctx,
            "SELECT claim_id FROM resume_claims WHERE wait_id = ? AND generation = ? LIMIT 1",
            waitId,
            generation,
        );
        if (claim) reasons.add("resume-reference");
        const waitPin = getRow(
            ctx,
            `SELECT pin_id FROM evidence_pins
             WHERE wait_id = ? AND generation = ? AND released_at IS NULL LIMIT 1`,
            waitId,
            generation,
        );
        if (waitPin) reasons.add("evidence-pin");
        // Do not remove a terminal wait record while one of its other
        // dependencies is still too recent. That would erase a fresh link.
        const freshDependency = getRow(
            ctx,
            `SELECT o.operation_id FROM wait_dependencies d
             JOIN operations o ON o.operation_id = d.operation_id
             WHERE d.wait_id = ? AND d.generation = ? AND d.operation_id <> ?
               AND (o.phase <> 'terminal' OR o.terminal_at IS NULL OR o.terminal_at >= ?)
             LIMIT 1`,
            waitId,
            generation,
            operation.operationId,
            cutoff,
        );
        if (freshDependency) reasons.add("too-recent");
    }
    return [...reasons];
}

function validatedPreviewInput(input: RetentionPreviewInput): { cutoff: number; limit: number } {
    if (!Number.isSafeInteger(input.cutoff) || input.cutoff < 0) {
        throw new StoreError("validation", "Invalid cutoff: must be a non-negative epoch millisecond");
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
        throw new StoreError("validation", "Invalid limit: bounded retention applies 1–1000 operations at a time");
    }
    return { cutoff: input.cutoff, limit: input.limit };
}

/** Read-only eligibility report. No reservation or deletion is performed. */
export function previewRetention(ctx: StoreContext, input: RetentionPreviewInput): RetentionPreview {
    const { cutoff, limit } = validatedPreviewInput(input);
    const rows = getRows(
        ctx,
        `SELECT * FROM operations ORDER BY created_at, operation_id`,
    );
    const candidates: RetentionCandidate[] = [];
    const protectedEntries: RetentionProtected[] = [];
    let truncated = false;
    for (const row of rows) {
        const operation = mapOperation(row);
        const reasons = retentionProtectionReasons(ctx, operation, cutoff);
        if (reasons.length > 0) {
            protectedEntries.push({
                operationId: operation.operationId,
                taskId: operation.taskId,
                reasons,
            });
            continue;
        }
        if (candidates.length >= limit) {
            truncated = true;
            continue;
        }
        candidates.push(candidateFromOperation(operation));
    }
    return { cutoff, scanned: rows.length, candidates, protected: protectedEntries, truncated };
}

function requireUnit(ctx: StoreContext, operationId: string): RetentionUnitRecord {
    const row = getRow(ctx, "SELECT * FROM retention_units WHERE operation_id = ?", operationId);
    if (!row) {
        throw new StoreError("validation", `No retention reservation exists for operation ${operationId}.`);
    }
    return mapRetentionUnit(row);
}

function mapRetentionUnit(row: Record<string, unknown>): RetentionUnitRecord {
    return {
        operationId: columnText(row, "operation_id"),
        taskId: columnNullableText(row, "task_id"),
        launchToken: columnNullableText(row, "launch_token"),
        token: columnText(row, "token"),
        state: columnText(row, "state") as RetentionUnitRecord["state"],
        artifactRef: columnNullableText(row, "artifact_ref"),
        createdAt: columnNumber(row, "created_at"),
        updatedAt: columnNumber(row, "updated_at"),
        detail: columnNullableText(row, "detail"),
    };
}

/**
 * Reserve one terminal operation for deletion. The age and every protection are
 * rechecked in the same immediate transaction as the reservation insert, so a
 * concurrent pin/wait/delivery either commits first (blocks this reservation) or
 * sees the trigger and is refused.
 */
export function reserveRetention(ctx: StoreContext, input: ReserveRetentionInput): RetentionUnitRecord {
    const operationId = requireId("operationId", input.operationId);
    const token = requireId("token", input.token);
    const cutoff = requireCounter("cutoff", input.cutoff);
    const artifactRef = optionalText("artifactRef", input.artifactRef, 1024);
    return ctx.transaction(() => {
        const row = getRow(ctx, "SELECT * FROM operations WHERE operation_id = ?", operationId);
        if (!row) {
            throw new StoreError(
                "unknown-operation",
                `Cannot reserve operation ${operationId}: it is not registered (or a completed tombstone already covers it).`,
            );
        }
        const operation = mapOperation(row);
        const reasons = retentionProtectionReasons(ctx, operation, cutoff);
        if (reasons.length > 0) {
            throw new StoreError(
                "retention-protected",
                `Operation ${operationId} is protected from retention: ${reasons.join(", ")}. Re-preview after the protection changes.`,
            );
        }
        const at = ctx.now();
        run(
            ctx,
            `INSERT INTO retention_units (
                operation_id, task_id, launch_token, token, state, artifact_ref, created_at, updated_at, detail
            ) VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?, NULL)`,
            operationId,
            operation.taskId,
            operation.launchToken,
            token,
            artifactRef,
            at,
            at,
        );
        return requireUnit(ctx, operationId);
    });
}

/**
 * Persist the irreversible deletion fence before any filesystem change. Once
 * this committed, a restart must finish or explicitly hold the unit; releasing
 * it would let new waits/pins reference evidence that may already be gone.
 */
export function markRetentionDeletionStarted(
    ctx: StoreContext,
    operationId: string,
    token: string,
): RetentionUnitRecord {
    const id = requireId("operationId", operationId);
    const claim = requireId("token", token);
    return ctx.transaction(() => {
        const unit = requireUnit(ctx, id);
        if (unit.token !== claim) {
            throw new StoreError("validation", `Retention reservation for ${id} belongs to another cleanup attempt.`);
        }
        if (unit.state === "complete") return unit;
        if (unit.state !== "reserved") {
            throw new StoreError(
                "retention-protected",
                `Retention unit ${id} is ${unit.state}; deletion has already started and cannot cross the fence twice.`,
            );
        }
        run(
            ctx,
            "UPDATE retention_units SET state = 'deleting', updated_at = ?, detail = 'deletion-started' WHERE operation_id = ?",
            ctx.now(),
            id,
        );
        return requireUnit(ctx, id);
    });
}

/** Record that the caller removed its runtime-owned filesystem artifact. */
export function markRetentionFilesRemoved(
    ctx: StoreContext,
    operationId: string,
    token: string,
    detail?: string,
): RetentionUnitRecord {
    const id = requireId("operationId", operationId);
    const claim = requireId("token", token);
    const note = optionalText("detail", detail, 1024);
    return ctx.transaction(() => {
        const unit = requireUnit(ctx, id);
        if (unit.token !== claim) {
            throw new StoreError("validation", `Retention reservation for ${id} belongs to another cleanup attempt.`);
        }
        if (unit.state === "complete") return unit;
        if (unit.state === "deletion-unknown") {
            throw new StoreError(
                "retention-protected",
                `Retention unit ${id} is held as deletion-unknown; an operator must resolve the artifact before files are marked removed.`,
            );
        }
        if (unit.state !== "deleting") {
            throw new StoreError(
                "retention-protected",
                `Retention unit ${id} is ${unit.state}; files may only be marked removed after the durable deletion fence.`,
            );
        }
        run(
            ctx,
            "UPDATE retention_units SET state = 'files-removed', updated_at = ?, detail = coalesce(?, detail) WHERE operation_id = ?",
            ctx.now(),
            note,
            id,
        );
        return requireUnit(ctx, id);
    });
}

/**
 * Mark a deletion-started unit whose artifact state cannot be proven. The
 * reservation stays in place, so no new wait, pin or delivery can reference it.
 */
export function markRetentionDeletionUnknown(
    ctx: StoreContext,
    operationId: string,
    token: string,
    detail: string,
): RetentionUnitRecord {
    const id = requireId("operationId", operationId);
    const claim = requireId("token", token);
    const note = optionalText("detail", detail, 1024);
    return ctx.transaction(() => {
        const unit = requireUnit(ctx, id);
        if (unit.token !== claim) {
            throw new StoreError("validation", `Retention reservation for ${id} belongs to another cleanup attempt.`);
        }
        if (unit.state === "complete") return unit;
        if (unit.state !== "deleting" && unit.state !== "files-removed") {
            throw new StoreError(
                "retention-protected",
                `Retention unit ${id} is ${unit.state}; it has no deletion boundary to hold.`,
            );
        }
        run(
            ctx,
            "UPDATE retention_units SET state = 'deletion-unknown', updated_at = ?, detail = coalesce(?, detail) WHERE operation_id = ?",
            ctx.now(),
            note,
            id,
        );
        return requireUnit(ctx, id);
    });
}

/**
 * Delete the terminal operation and its now-unreferenced wait/evidence/outbox
 * rows, then retain a completed tombstone. The caller must already have removed
 * its own filesystem artifact (or be resuming a `files-removed` unit).
 */
export function finalizeRetention(
    ctx: StoreContext,
    operationId: string,
    token: string,
): RetentionUnitRecord {
    const id = requireId("operationId", operationId);
    const claim = requireId("token", token);
    return ctx.transaction(() => {
        const unit = requireUnit(ctx, id);
        if (unit.token !== claim) {
            throw new StoreError("validation", `Retention reservation for ${id} belongs to another cleanup attempt.`);
        }
        if (unit.state === "complete") return unit;
        if (unit.state !== "files-removed") {
            throw new StoreError(
                "validation",
                `Retention unit ${id} is still ${unit.state}; files must be removed (or a resume recorded) before the database rows are deleted.`,
            );
        }
        const waits = getRows(
            ctx,
            "SELECT DISTINCT wait_id, generation FROM wait_dependencies WHERE operation_id = ?",
            id,
        );
        for (const wait of waits) {
            const waitId = columnText(wait, "wait_id");
            const generation = columnNumber(wait, "generation");
            run(ctx, "DELETE FROM resume_claims WHERE wait_id = ? AND generation = ?", waitId, generation);
            run(ctx, "DELETE FROM evidence_reads WHERE wait_id = ? AND generation = ?", waitId, generation);
            run(ctx, "DELETE FROM evidence_pins WHERE wait_id = ? AND generation = ?", waitId, generation);
            run(ctx, "DELETE FROM outbox_events WHERE wait_id = ? AND generation = ?", waitId, generation);
            run(ctx, "DELETE FROM wait_dependencies WHERE wait_id = ? AND generation = ?", waitId, generation);
            run(ctx, "DELETE FROM waits WHERE wait_id = ? AND generation = ?", waitId, generation);
        }
        run(ctx, "DELETE FROM operation_evidence WHERE operation_id = ?", id);
        run(ctx, "DELETE FROM operations WHERE operation_id = ?", id);
        // A stale hint must not make a client look up records that no longer exist.
        run(ctx, "DELETE FROM coordinator_changes WHERE operation_id = ?", id);
        const at = ctx.now();
        run(
            ctx,
            "UPDATE retention_units SET state = 'complete', updated_at = ?, detail = 'deleted' WHERE operation_id = ?",
            at,
            id,
        );
        return requireUnit(ctx, id);
    });
}

/** Abandon a reservation before any filesystem artifact was removed. */
export function releaseRetention(
    ctx: StoreContext,
    operationId: string,
    token: string,
    reason: string,
): RetentionUnitRecord {
    const id = requireId("operationId", operationId);
    const claim = requireId("token", token);
    const note = optionalText("reason", reason, 1024);
    return ctx.transaction(() => {
        const unit = requireUnit(ctx, id);
        if (unit.token !== claim) {
            throw new StoreError("validation", `Retention reservation for ${id} belongs to another cleanup attempt.`);
        }
        if (unit.state !== "reserved") {
            throw new StoreError(
                "retention-protected",
                `Retention unit ${id} is ${unit.state}; only a reservation whose deletion fence was never crossed can be released. Resume finalization or resolve the held unit instead.`,
            );
        }
        run(ctx, "DELETE FROM retention_units WHERE operation_id = ?", id);
        const at = ctx.now();
        return { ...unit, state: "reserved", updatedAt: at, detail: note ?? unit.detail };
    });
}

export function listRetentionUnits(
    ctx: StoreContext,
    filter: { state?: RetentionUnitRecord["state"] | readonly RetentionUnitRecord["state"][]; limit?: number } = {},
): RetentionUnitRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.state !== undefined) {
        const states = Array.isArray(filter.state) ? filter.state : [filter.state as RetentionUnitRecord["state"]];
        for (const state of states) {
            if (state !== "reserved" && state !== "deleting" && state !== "files-removed"
                && state !== "deletion-unknown" && state !== "complete") {
                throw new StoreError("validation", `Invalid retention state ${JSON.stringify(state)}.`);
            }
        }
        clauses.push(`state IN (${placeholders(states)})`);
        params.push(...states);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter.limit === undefined ? 1_000 : Math.min(10_000, Math.max(1, Math.floor(filter.limit)));
    return getRows(
        ctx,
        `SELECT * FROM retention_units ${where} ORDER BY created_at, operation_id LIMIT ?`,
        ...params,
        limit,
    ).map(mapRetentionUnit);
}

export function retentionUnit(ctx: StoreContext, operationId: string): RetentionUnitRecord | null {
    const row = getRow(ctx, "SELECT * FROM retention_units WHERE operation_id = ?", requireId("operationId", operationId));
    return row ? mapRetentionUnit(row) : null;
}

/** Used by tests/diagnostics; normalized owner is intentionally not stored separately. */
export function retentionOwnerOf(candidate: RetentionCandidate): string {
    const owner = normalizeOwner("owner", candidate.owner);
    return `${owner.kind}:${owner.sessionId}:${owner.workspace}:${owner.branchId ?? ""}:${owner.goalId ?? ""}`;
}
