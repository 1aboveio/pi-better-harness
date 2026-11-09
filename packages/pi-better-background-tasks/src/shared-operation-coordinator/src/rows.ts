// Generated from packages/operation-coordinator/src/rows.ts. Do not edit directly.
/**
 * Row mapping for the coordinator store.
 *
 * Reads are strict: a column that does not match its declared shape raises
 * `store-corruption` instead of being coerced, so a damaged journal is reported
 * rather than silently reinterpreted.
 */
import {
    columnBoolean,
    columnJson,
    columnNullableNumber,
    columnNullableText,
    columnNumber,
    columnText,
    getRow,
    getRows,
    type StoreContext,
} from "./sqlite.ts";
import { StoreError } from "./errors.ts";
import type {
    AcknowledgeDisposition,
    EvidenceKind,
    EvidencePinRecord,
    EvidenceReadRecord,
    ObserverHealth,
    OperationEvidenceRecord,
    OperationPhase,
    OperationRecord,
    OutboxDispatchClaim,
    OutboxEventRecord,
    OutboxState,
    OwnerIdentity,
    OwnerKind,
    ResumeClaimRecord,
    ResumeClaimState,
    ResumeLeaseIdentity,
    SupervisionIdentity,
    TerminalOutcome,
    WaitAcknowledgement,
    WaitDependencyRecord,
    WaitParkIntent,
    WaitPhase,
    WaitRecord,
} from "./types.ts";

// ---- owner identity -----------------------------------------------------

export function ownerFromRow(row: Record<string, unknown>, prefix = "owner"): OwnerIdentity {
    const kind = columnText(row, `${prefix}_kind`) as OwnerKind;
    return {
        kind,
        sessionId: columnText(row, `${prefix}_session_id`),
        workspace: columnText(row, `${prefix}_workspace`),
        branchId: columnNullableText(row, `${prefix}_branch_id`),
        goalId: columnNullableText(row, `${prefix}_goal_id`),
    };
}

// ---- operations ---------------------------------------------------------

export function getOperationRow(
    ctx: StoreContext,
    operationId: string,
): Record<string, unknown> | undefined {
    return getRow(ctx, "SELECT * FROM operations WHERE operation_id = ?", operationId);
}

export function getOperationRowByTask(
    ctx: StoreContext,
    taskId: string,
): Record<string, unknown> | undefined {
    return getRow(ctx, "SELECT * FROM operations WHERE task_id = ?", taskId);
}

export function mapOperation(row: Record<string, unknown>): OperationRecord {
    return {
        operationId: columnText(row, "operation_id"),
        taskId: columnText(row, "task_id"),
        launchToken: columnText(row, "launch_token"),
        owner: ownerFromRow(row),
        observer: {
            kind: columnText(row, "observer_kind"),
            version: columnText(row, "observer_version"),
        },
        supervision: columnJson<SupervisionIdentity>(row, "supervision_json"),
        authorityRef: columnNullableText(row, "authority_ref"),
        intentRef: columnNullableText(row, "intent_ref"),
        phase: columnText(row, "phase") as OperationPhase,
        health: columnText(row, "health") as ObserverHealth,
        healthReason: columnNullableText(row, "health_reason"),
        terminalRevision: columnNumber(row, "terminal_revision"),
        terminalOutcome: columnNullableText(row, "terminal_outcome") as TerminalOutcome | null,
        terminalEventId: columnNullableText(row, "terminal_event_id"),
        terminalDetailLost: columnBoolean(row, "terminal_detail_lost"),
        terminalReason: columnNullableText(row, "terminal_reason"),
        createdAt: columnNumber(row, "created_at"),
        updatedAt: columnNumber(row, "updated_at"),
        terminalAt: columnNullableNumber(row, "terminal_at"),
    };
}

export function readOperation(ctx: StoreContext, operationId: string): OperationRecord | null {
    const row = getOperationRow(ctx, operationId);
    return row ? mapOperation(row) : null;
}

export function requireOperation(ctx: StoreContext, operationId: string): OperationRecord {
    const row = getOperationRow(ctx, operationId);
    if (!row) {
        throw new StoreError(
            "unknown-operation",
            `No durable operation is registered as ${operationId}. Register the launch before reporting a terminal outcome or waiting on it.`,
        );
    }
    return mapOperation(row);
}

export function mapOperationEvidence(row: Record<string, unknown>): OperationEvidenceRecord {
    const summary = columnNullableText(row, "summary");
    const bytes = columnNullableNumber(row, "bytes");
    const record: OperationEvidenceRecord = {
        operationId: columnText(row, "operation_id"),
        terminalRevision: columnNumber(row, "terminal_revision"),
        ordinal: columnNumber(row, "ordinal"),
        kind: columnText(row, "kind") as EvidenceKind,
        ref: columnText(row, "ref"),
        detailLost: columnBoolean(row, "detail_lost"),
        capturedAt: columnNumber(row, "captured_at"),
    };
    if (summary !== null) record.summary = summary;
    if (bytes !== null) record.bytes = bytes;
    return record;
}

export function readOperationEvidence(
    ctx: StoreContext,
    operationId: string,
    terminalRevision?: number,
): OperationEvidenceRecord[] {
    const rows = terminalRevision === undefined
        ? getRows(
            ctx,
            "SELECT * FROM operation_evidence WHERE operation_id = ? ORDER BY terminal_revision, ordinal",
            operationId,
        )
        : getRows(
            ctx,
            "SELECT * FROM operation_evidence WHERE operation_id = ? AND terminal_revision = ? ORDER BY ordinal",
            operationId,
            terminalRevision,
        );
    return rows.map(mapOperationEvidence);
}

// ---- waits --------------------------------------------------------------

export function getWaitRow(
    ctx: StoreContext,
    waitId: string,
    generation: number,
): Record<string, unknown> | undefined {
    return getRow(ctx, "SELECT * FROM waits WHERE wait_id = ? AND generation = ?", waitId, generation);
}

export function latestWaitGeneration(ctx: StoreContext, waitId: string): number | null {
    const row = getRow(ctx, "SELECT MAX(generation) AS generation FROM waits WHERE wait_id = ?", waitId);
    if (!row) return null;
    const value = columnNullableNumber(row, "generation");
    return value ?? null;
}

export function readWaitRow(
    ctx: StoreContext,
    waitId: string,
    generation?: number,
): Record<string, unknown> | null {
    if (generation !== undefined) return getWaitRow(ctx, waitId, generation) ?? null;
    const latest = latestWaitGeneration(ctx, waitId);
    if (latest === null) return null;
    return getWaitRow(ctx, waitId, latest) ?? null;
}

export function requireWaitRow(
    ctx: StoreContext,
    waitId: string,
    generation: number,
): Record<string, unknown> {
    const row = getWaitRow(ctx, waitId, generation);
    if (!row) {
        throw new StoreError(
            "unknown-wait",
            `No wait generation ${generation} is registered for ${waitId}. Read the current generation before acting on it.`,
        );
    }
    return row;
}

export function readDependencies(
    ctx: StoreContext,
    waitId: string,
    generation: number,
): WaitDependencyRecord[] {
    return getRows(
        ctx,
        "SELECT * FROM wait_dependencies WHERE wait_id = ? AND generation = ? ORDER BY ordinal",
        waitId,
        generation,
    ).map((row) => ({
        operationId: columnText(row, "operation_id"),
        link: columnText(row, "link") as "owner" | "explicit",
        terminalRevision: columnNumber(row, "terminal_revision"),
        terminalOutcome: columnNullableText(row, "terminal_outcome") as TerminalOutcome | null,
        settledAt: columnNullableNumber(row, "settled_at"),
    }));
}

export interface DependencyState {
    dependencies: WaitDependencyRecord[];
    /** Every dependency has a terminal revision. */
    settled: boolean;
    settledAt: number | null;
}

export function dependencyState(
    ctx: StoreContext,
    waitId: string,
    generation: number,
): DependencyState {
    const dependencies = readDependencies(ctx, waitId, generation);
    const settled = dependencies.length > 0 && dependencies.every((dep) => dep.terminalRevision > 0);
    const settledTimes = dependencies
        .map((dep) => dep.settledAt)
        .filter((value): value is number => value !== null);
    return {
        dependencies,
        settled,
        settledAt: settled && settledTimes.length > 0 ? Math.max(...settledTimes) : null,
    };
}

export function mapWait(ctx: StoreContext, row: Record<string, unknown>): WaitRecord {
    const waitId = columnText(row, "wait_id");
    const generation = columnNumber(row, "generation");
    const state = dependencyState(ctx, waitId, generation);
    const acknowledgement = columnJson<WaitAcknowledgement>(row, "acknowledgement_json");
    return {
        waitId,
        generation,
        owner: ownerFromRow(row),
        phase: columnText(row, "phase") as WaitPhase,
        phaseReason: columnNullableText(row, "phase_reason"),
        cancelEpoch: columnNumber(row, "cancel_epoch"),
        continuationNote: columnText(row, "continuation_note"),
        park: columnJson<WaitParkIntent>(row, "park_json"),
        origin: columnJson<WaitRecord["origin"]>(row, "origin_json"),
        dependencies: state.dependencies,
        settled: state.settled,
        settledAt: state.settledAt,
        acknowledgement: acknowledgement
            ? { ...acknowledgement, disposition: acknowledgement.disposition as AcknowledgeDisposition }
            : null,
        createdAt: columnNumber(row, "created_at"),
        updatedAt: columnNumber(row, "updated_at"),
    };
}

export function readWait(ctx: StoreContext, waitId: string, generation?: number): WaitRecord | null {
    const row = readWaitRow(ctx, waitId, generation);
    return row ? mapWait(ctx, row) : null;
}

export function requireWait(ctx: StoreContext, waitId: string, generation: number): WaitRecord {
    return mapWait(ctx, requireWaitRow(ctx, waitId, generation));
}

// ---- resume claims ------------------------------------------------------

export function mapClaim(row: Record<string, unknown>): ResumeClaimRecord {
    return {
        claimId: columnText(row, "claim_id"),
        claimToken: columnText(row, "claim_token"),
        waitId: columnText(row, "wait_id"),
        generation: columnNumber(row, "generation"),
        cancelEpoch: columnNumber(row, "cancel_epoch"),
        state: columnText(row, "state") as ResumeClaimState,
        attemptId: columnNullableText(row, "attempt_id"),
        launchToken: columnNullableText(row, "launch_token"),
        lease: columnJson<ResumeLeaseIdentity>(row, "lease_json") ?? { ownerId: "unknown" },
        reservedCheckpointId: columnText(row, "reserved_checkpoint_id"),
        claimedAt: columnNumber(row, "claimed_at"),
        publishedAt: columnNullableNumber(row, "published_at"),
        releasedAt: columnNullableNumber(row, "released_at"),
        invalidatedAt: columnNullableNumber(row, "invalidated_at"),
        reason: columnNullableText(row, "reason"),
    };
}

export function readClaim(ctx: StoreContext, claimId: string): ResumeClaimRecord | null {
    const row = getRow(ctx, "SELECT * FROM resume_claims WHERE claim_id = ?", claimId);
    return row ? mapClaim(row) : null;
}

export function readActiveClaim(
    ctx: StoreContext,
    waitId: string,
    generation: number,
): ResumeClaimRecord | null {
    const row = getRow(
        ctx,
        "SELECT * FROM resume_claims WHERE wait_id = ? AND generation = ? AND state IN ('claimed', 'published')",
        waitId,
        generation,
    );
    return row ? mapClaim(row) : null;
}

export function requireClaim(ctx: StoreContext, claimId: string): ResumeClaimRecord {
    const claim = readClaim(ctx, claimId);
    if (!claim) {
        throw new StoreError(
            "claim-state",
            `No resume claim ${claimId} is recorded. Claims are created by claimResume and are not caller-supplied.`,
        );
    }
    return claim;
}

// ---- evidence reads and pins -------------------------------------------

export function mapEvidenceRead(row: Record<string, unknown>): EvidenceReadRecord {
    return {
        waitId: columnText(row, "wait_id"),
        generation: columnNumber(row, "generation"),
        operationId: columnText(row, "operation_id"),
        terminalRevision: columnNumber(row, "terminal_revision"),
        reader: {
            kind: columnText(row, "reader_kind") as OwnerKind,
            sessionId: columnText(row, "reader_session_id"),
            workspace: columnText(row, "reader_workspace"),
            branchId: columnNullableText(row, "reader_branch_id"),
            goalId: columnNullableText(row, "reader_goal_id"),
        },
        readAt: columnNumber(row, "read_at"),
    };
}

export function mapEvidencePin(row: Record<string, unknown>): EvidencePinRecord {
    return {
        pinId: columnText(row, "pin_id"),
        waitId: columnText(row, "wait_id"),
        generation: columnNumber(row, "generation"),
        operationId: columnText(row, "operation_id"),
        terminalRevision: columnNumber(row, "terminal_revision"),
        kind: columnText(row, "kind") as EvidenceKind,
        ref: columnText(row, "ref"),
        summary: columnNullableText(row, "summary"),
        detailLost: columnBoolean(row, "detail_lost"),
        bytes: columnNullableNumber(row, "bytes"),
        pinnedAt: columnNumber(row, "pinned_at"),
        releasedAt: columnNullableNumber(row, "released_at"),
        releaseReason: columnNullableText(row, "release_reason"),
    };
}

export function readPins(
    ctx: StoreContext,
    waitId: string,
    generation: number,
    includeReleased: boolean,
): EvidencePinRecord[] {
    const rows = includeReleased
        ? getRows(
            ctx,
            "SELECT * FROM evidence_pins WHERE wait_id = ? AND generation = ? ORDER BY pinned_at, pin_id",
            waitId,
            generation,
        )
        : getRows(
            ctx,
            "SELECT * FROM evidence_pins WHERE wait_id = ? AND generation = ? AND released_at IS NULL ORDER BY pinned_at, pin_id",
            waitId,
            generation,
        );
    return rows.map(mapEvidencePin);
}

export function readPinsForRevision(
    ctx: StoreContext,
    waitId: string,
    generation: number,
    operationId: string,
    terminalRevision: number,
): EvidencePinRecord[] {
    return getRows(
        ctx,
        `SELECT * FROM evidence_pins
         WHERE wait_id = ? AND generation = ? AND operation_id = ? AND terminal_revision = ?
         ORDER BY pinned_at, pin_id`,
        waitId,
        generation,
        operationId,
        terminalRevision,
    ).map(mapEvidencePin);
}

// ---- outbox -------------------------------------------------------------

export function mapOutbox(ctx: StoreContext, row: Record<string, unknown>): OutboxEventRecord {
    const waitId = columnText(row, "wait_id");
    const generation = columnNumber(row, "generation");
    const operationId = columnText(row, "operation_id");
    const terminalRevision = columnNumber(row, "terminal_revision");
    return {
        eventId: columnText(row, "event_id"),
        operationId,
        terminalRevision,
        waitId,
        generation,
        recipient: ownerFromRow(row, "recipient"),
        evidence: readPinsForRevision(ctx, waitId, generation, operationId, terminalRevision),
        state: columnText(row, "state") as OutboxState,
        attempts: columnNumber(row, "attempts"),
        dispatchClaim: columnJson<OutboxDispatchClaim>(row, "dispatch_claim_json"),
        createdAt: columnNumber(row, "created_at"),
        claimedAt: columnNullableNumber(row, "claimed_at"),
        deliveredAt: columnNullableNumber(row, "delivered_at"),
        acknowledgedAt: columnNullableNumber(row, "acknowledged_at"),
        voidedAt: columnNullableNumber(row, "voided_at"),
        reason: columnNullableText(row, "reason"),
    };
}

export function readOutboxRow(
    ctx: StoreContext,
    eventId: string,
): Record<string, unknown> | null {
    return getRow(ctx, "SELECT * FROM outbox_events WHERE event_id = ?", eventId) ?? null;
}
