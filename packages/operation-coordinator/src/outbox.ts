/**
 * Durable result delivery.
 *
 * The outbox is addressed to the wait's owner identity, not to a process. One
 * event exists per terminal revision per wait generation, so duplicate terminal
 * events, reload replay and repeated reconciliation cannot enqueue a second
 * event for the same result.
 *
 * Delivery itself is at-least-once, not exactly-once. The unique event and its
 * unique index make enqueue idempotent, but `markOutboxDelivered` commits after
 * the caller emitted the result: a crash between emission and that write leaves
 * the event claimed, and a reconciled host may emit it again. Recipients must
 * key on the event id (or operation, revision, wait and generation) instead of
 * assuming a result is emitted once.
 *
 * Delivery and interpretation are separate: a dispatched or delivered event is
 * not a consumed result. Only `acknowledgeResult` marks the generation consumed,
 * and only an acknowledgement releases the evidence pins that kept the terminal
 * evidence alive.
 */
import { randomUUID } from "node:crypto";
import { StoreError } from "./errors.ts";
import {
    dependencyState,
    mapOutbox,
    readOperationEvidence,
    readOutboxRow,
    requireWaitRow,
} from "./rows.ts";
import { columnJson, columnNullableText, columnText, getRows, run, type StoreContext } from "./sqlite.ts";
import type {
    ClaimOutboxInput,
    OutboxDispatchClaim,
    OutboxDispatchInput,
    OutboxEventRecord,
    OutboxFilter,
    OutboxState,
    OwnerIdentity,
    ReleaseOutboxInput,
    WaitDependencyRecord,
} from "./types.ts";
import { requireCounter, requireId, requireText } from "./validate.ts";

const OUTBOX_STATES: readonly OutboxState[] = [
    "pending",
    "claimed",
    "delivered",
    "acknowledged",
    "voided",
];

/** Delivery is only meaningful once the generation can act on the evidence. */
const DELIVERABLE_WAIT_PHASES = ["ready", "resuming"];
const UNCONSUMED_OUTBOX_STATES = ["pending", "claimed", "delivered"];

function placeholders(count: number): string {
    return new Array(count).fill("?").join(", ");
}

/**
 * Enqueue one event per settled dependency at its terminal revision, and pin the
 * evidence that event refers to. Idempotent: the unique
 * (operation, revision, wait, generation) index decides whether anything is new.
 */
export function enqueueGenerationOutbox(
    ctx: StoreContext,
    waitId: string,
    generation: number,
    recipient: OwnerIdentity,
    dependencies: WaitDependencyRecord[],
    at: number,
): OutboxEventRecord[] {
    const inserted: OutboxEventRecord[] = [];
    for (const dependency of dependencies) {
        if (dependency.terminalRevision <= 0) continue;
        const eventId = `evt_${randomUUID()}`;
        const changes = run(
            ctx,
            `INSERT OR IGNORE INTO outbox_events (
                event_id, operation_id, terminal_revision, wait_id, generation,
                recipient_kind, recipient_session_id, recipient_workspace, recipient_branch_id, recipient_goal_id,
                state, attempts, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
            eventId,
            dependency.operationId,
            dependency.terminalRevision,
            waitId,
            generation,
            recipient.kind,
            recipient.sessionId,
            recipient.workspace,
            recipient.branchId ?? null,
            recipient.goalId ?? null,
            at,
        );
        if (changes === 0) continue;
        for (const evidence of readOperationEvidence(ctx, dependency.operationId, dependency.terminalRevision)) {
            run(
                ctx,
                `INSERT OR IGNORE INTO evidence_pins (
                    pin_id, wait_id, generation, operation_id, terminal_revision,
                    kind, ref, summary, detail_lost, bytes, pinned_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                `pin_${randomUUID()}`,
                waitId,
                generation,
                evidence.operationId,
                evidence.terminalRevision,
                evidence.kind,
                evidence.ref,
                evidence.summary ?? null,
                evidence.detailLost ? 1 : 0,
                evidence.bytes ?? null,
                at,
            );
        }
        const row = readOutboxRow(ctx, eventId);
        if (row) inserted.push(mapOutbox(ctx, row));
    }
    return inserted;
}

/** Enqueue for a generation that just became ready, reading its dependencies. */
export function enqueueReadyGeneration(
    ctx: StoreContext,
    waitId: string,
    generation: number,
    at: number,
): OutboxEventRecord[] {
    const row = requireWaitRow(ctx, waitId, generation);
    const recipient: OwnerIdentity = {
        kind: columnText(row, "owner_kind") as OwnerIdentity["kind"],
        sessionId: columnText(row, "owner_session_id"),
        workspace: columnText(row, "owner_workspace"),
        branchId: columnNullableText(row, "owner_branch_id"),
        goalId: columnNullableText(row, "owner_goal_id"),
    };
    const state = dependencyState(ctx, waitId, generation);
    if (!state.settled) {
        throw new StoreError(
            "dependencies-unsettled",
            `Wait ${waitId} generation ${generation} still has unfinished dependencies; result delivery is enqueued only when every dependency has a terminal outcome.`,
        );
    }
    return enqueueGenerationOutbox(ctx, waitId, generation, recipient, state.dependencies, at);
}

/** Release the pins of a generation; used by acknowledgement and cancellation. */
export function releaseGenerationPins(
    ctx: StoreContext,
    waitId: string,
    generation: number,
    reason: string,
    at: number,
): string[] {
    const rows = getRows(
        ctx,
        "SELECT pin_id FROM evidence_pins WHERE wait_id = ? AND generation = ? AND released_at IS NULL",
        waitId,
        generation,
    );
    const ids = rows.map((row) => columnText(row, "pin_id"));
    if (ids.length === 0) return [];
    run(
        ctx,
        `UPDATE evidence_pins SET released_at = ?, release_reason = ?
         WHERE wait_id = ? AND generation = ? AND released_at IS NULL`,
        at,
        reason,
        waitId,
        generation,
    );
    return ids;
}

/** Void unconsumed deliveries of a generation; cancellation resolves the wait, not the result. */
export function voidGenerationOutbox(
    ctx: StoreContext,
    waitId: string,
    generation: number,
    reason: string,
    at: number,
): string[] {
    const rows = getRows(
        ctx,
        `SELECT event_id FROM outbox_events
         WHERE wait_id = ? AND generation = ? AND state IN (${placeholders(UNCONSUMED_OUTBOX_STATES.length)})`,
        waitId,
        generation,
        ...UNCONSUMED_OUTBOX_STATES,
    );
    const ids = rows.map((row) => columnText(row, "event_id"));
    if (ids.length === 0) return [];
    run(
        ctx,
        `UPDATE outbox_events SET state = 'voided', voided_at = ?, reason = ?, dispatch_claim_json = NULL
         WHERE wait_id = ? AND generation = ? AND state IN (${placeholders(UNCONSUMED_OUTBOX_STATES.length)})`,
        at,
        reason,
        waitId,
        generation,
        ...UNCONSUMED_OUTBOX_STATES,
    );
    return ids;
}

/** Mark the generation's deliveries consumed by interpretation. */
export function acknowledgeGenerationOutbox(
    ctx: StoreContext,
    waitId: string,
    generation: number,
    at: number,
): string[] {
    const rows = getRows(
        ctx,
        `SELECT event_id FROM outbox_events
         WHERE wait_id = ? AND generation = ? AND state IN (${placeholders(UNCONSUMED_OUTBOX_STATES.length)})`,
        waitId,
        generation,
        ...UNCONSUMED_OUTBOX_STATES,
    );
    const ids = rows.map((row) => columnText(row, "event_id"));
    if (ids.length === 0) return [];
    run(
        ctx,
        `UPDATE outbox_events SET state = 'acknowledged', acknowledged_at = ?, dispatch_claim_json = NULL
         WHERE wait_id = ? AND generation = ? AND state IN (${placeholders(UNCONSUMED_OUTBOX_STATES.length)})`,
        at,
        waitId,
        generation,
        ...UNCONSUMED_OUTBOX_STATES,
    );
    return ids;
}

function ownerClause(prefix: string, owner: OwnerIdentity): { sql: string; params: Array<string | null> } {
    return {
        sql: `${prefix}_kind = ? AND ${prefix}_session_id = ? AND ${prefix}_workspace = ?
              AND coalesce(${prefix}_branch_id, '') = ? AND coalesce(${prefix}_goal_id, '') = ?`,
        params: [owner.kind, owner.sessionId, owner.workspace, owner.branchId ?? "", owner.goalId ?? ""],
    };
}

export function listOutbox(ctx: StoreContext, filter: OutboxFilter = {}): OutboxEventRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number | null> = [];
    if (filter.recipient) {
        const clause = ownerClause("recipient", filter.recipient);
        clauses.push(clause.sql);
        params.push(...clause.params);
    }
    if (filter.state !== undefined) {
        const states = Array.isArray(filter.state) ? filter.state : [filter.state as OutboxState];
        for (const state of states) {
            if (!OUTBOX_STATES.includes(state)) {
                throw new StoreError("validation", `Invalid state: must be one of ${OUTBOX_STATES.join(", ")}`);
            }
        }
        clauses.push(`state IN (${placeholders(states.length)})`);
        params.push(...states);
    }
    if (filter.waitId !== undefined) {
        clauses.push("wait_id = ?");
        params.push(requireId("waitId", filter.waitId));
    }
    if (filter.generation !== undefined) {
        clauses.push("generation = ?");
        params.push(requireCounter("generation", filter.generation));
    }
    if (filter.operationId !== undefined) {
        clauses.push("operation_id = ?");
        params.push(requireId("operationId", filter.operationId));
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return getRows(
        ctx,
        `SELECT * FROM outbox_events ${where} ORDER BY created_at, event_id`,
        ...params,
    ).map((row) => mapOutbox(ctx, row));
}

function readDispatchClaim(row: Record<string, unknown>): OutboxDispatchClaim | null {
    return columnJson<OutboxDispatchClaim>(row, "dispatch_claim_json");
}

function assertDispatchTokenUnused(ctx: StoreContext, claimToken: string): void {
    const rows = getRows(
        ctx,
        "SELECT event_id, dispatch_claim_json FROM outbox_events WHERE state = 'claimed'",
    );
    for (const row of rows) {
        const claim = readDispatchClaim(row);
        if (claim === null) continue;
        if (claim.token === claimToken) {
            throw new StoreError(
                "outbox-state",
                `Dispatch token ${claimToken} is already held by event ${columnText(row, "event_id")}. Use a fresh token for a new dispatch attempt.`,
            );
        }
    }
}

/**
 * Claim pending deliveries for dispatch. Claiming records an attempt but does not
 * consume the result: an event that is never acknowledged stays visible.
 */
export function claimOutbox(ctx: StoreContext, input: ClaimOutboxInput): OutboxEventRecord[] {
    const claimToken = requireId("claimToken", input.claimToken);
    const claimedBy = requireText("claimedBy", input.claimedBy, 200);
    const limit = input.limit === undefined ? 10 : requireCounter("limit", input.limit);
    if (limit < 1) {
        throw new StoreError("validation", "Invalid limit: must be at least 1");
    }
    const recipient = input.recipient;

    return ctx.transaction(() => {
        assertDispatchTokenUnused(ctx, claimToken);
        const clauses = [
            "state = 'pending'",
            `(event_type = 'assignment-outcome' OR EXISTS (SELECT 1 FROM waits w WHERE w.wait_id = outbox_events.wait_id
                     AND w.generation = outbox_events.generation
                     AND w.phase IN (${placeholders(DELIVERABLE_WAIT_PHASES.length)})))`,
        ];
        const params: Array<string | number | null> = [...DELIVERABLE_WAIT_PHASES];
        if (input.eventId !== undefined) {
            clauses.push("event_id = ?");
            params.push(requireId("eventId", input.eventId));
        }
        if (input.type !== undefined) {
            if (!["dependency-ready", "assignment-outcome"].includes(input.type)) throw new StoreError("validation", "Unknown outbox event type.");
            clauses.push("event_type = ?");
            params.push(input.type);
        }
        if (input.waitId !== undefined) {
            clauses.push("wait_id = ?");
            params.push(requireId("waitId", input.waitId));
        }
        if (input.generation !== undefined) {
            clauses.push("generation = ?");
            params.push(requireCounter("generation", input.generation));
        }
        if (recipient) {
            const clause = ownerClause("recipient", recipient);
            clauses.push(clause.sql);
            params.push(...clause.params);
        }
        const rows = getRows(
            ctx,
            `SELECT * FROM outbox_events WHERE ${clauses.join(" AND ")} ORDER BY created_at, event_id LIMIT ?`,
            ...params,
            limit,
        );
        const at = ctx.now();
        const claimed: OutboxEventRecord[] = [];
        for (const row of rows) {
            const eventId = columnText(row, "event_id");
            run(
                ctx,
                `UPDATE outbox_events
                 SET state = 'claimed', attempts = attempts + 1, claimed_at = ?, dispatch_claim_json = ?
                 WHERE event_id = ? AND state = 'pending'`,
                at,
                JSON.stringify({ token: claimToken, claimedBy, claimedAt: at }),
                eventId,
            );
            const updated = readOutboxRow(ctx, eventId);
            if (updated) claimed.push(mapOutbox(ctx, updated));
        }
        return claimed;
    });
}

function requireClaimedEvent(
    ctx: StoreContext,
    input: OutboxDispatchInput,
): Record<string, unknown> {
    const eventId = requireId("eventId", input.eventId);
    const claimToken = requireId("claimToken", input.claimToken);
    const row = readOutboxRow(ctx, eventId);
    if (!row) {
        throw new StoreError("outbox-state", `No outbox event ${eventId} is recorded.`);
    }
    const state = columnText(row, "state");
    if (state !== "claimed") {
        throw new StoreError(
            "outbox-state",
            `Outbox event ${eventId} is ${state}; only a claimed delivery can be completed or released.`,
        );
    }
    const claim = readDispatchClaim(row);
    if (claim === null || claim.token !== claimToken) {
        throw new StoreError(
            "outbox-state",
            `Outbox event ${eventId} is claimed by a different dispatch token; the caller does not hold this delivery.`,
        );
    }
    return row;
}

export function markOutboxDelivered(
    ctx: StoreContext,
    input: OutboxDispatchInput,
): OutboxEventRecord {
    return ctx.transaction(() => {
        const row = requireClaimedEvent(ctx, input);
        const eventId = columnText(row, "event_id");
        run(
            ctx,
            "UPDATE outbox_events SET state = 'delivered', delivered_at = ?, dispatch_claim_json = NULL WHERE event_id = ?",
            ctx.now(),
            eventId,
        );
        const updated = readOutboxRow(ctx, eventId);
        return mapOutbox(ctx, updated as Record<string, unknown>);
    });
}

/**
 * Return a claimed delivery to the queue with a recorded reason. Attempts and the
 * recovery reason are retained, and the result stays unconsumed.
 */
export function releaseOutbox(
    ctx: StoreContext,
    input: ReleaseOutboxInput,
): OutboxEventRecord {
    const reason = requireText("reason", input.reason, 1024);
    return ctx.transaction(() => {
        const row = requireClaimedEvent(ctx, input);
        const eventId = columnText(row, "event_id");
        run(
            ctx,
            "UPDATE outbox_events SET state = 'pending', reason = ?, dispatch_claim_json = NULL WHERE event_id = ?",
            reason,
            eventId,
        );
        const updated = readOutboxRow(ctx, eventId);
        return mapOutbox(ctx, updated as Record<string, unknown>);
    });
}
