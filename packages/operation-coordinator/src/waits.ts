/**
 * All-settled waits, their phase machine, resume claims, evidence pins and
 * interpretation acknowledgement.
 *
 * The phase machine is deliberately small and every transition names the phase
 * it acts on, so an out-of-order or duplicated call is refused instead of
 * replaying a step. A parked worker cannot reach `waiting`/`ready` without
 * proving its checkpoint was committed and its writer exited; a dependency that
 * settled earlier is not missed, because registration reads the terminal
 * revisions inside its own transaction and resolves straight to `ready`.
 *
 * Fencing: every mutation names the generation and, where cancellation can race,
 * the cancellation epoch it observed. Cancellation invalidates the active resume
 * claim, and a claim whose epoch no longer matches can never publish an attempt.
 */
import { randomUUID } from "node:crypto";
import { StoreError } from "./errors.ts";
import {
    acknowledgeGenerationOutbox,
    enqueueReadyGeneration,
    releaseGenerationPins,
    voidGenerationOutbox,
} from "./outbox.ts";
import {
    dependencyState,
    getOperationRow,
    latestWaitGeneration,
    mapClaim,
    mapEvidencePin,
    mapEvidenceRead,
    mapWait,
    ownerFromRow,
    readPins,
    readWait,
    readWaitRow,
    requireClaim,
    requireWait,
    requireWaitRow,
} from "./rows.ts";
import {
    columnNullableText,
    columnNumber,
    columnText,
    getRow,
    getRows,
    isUniqueViolation,
    run,
    type StoreContext,
} from "./sqlite.ts";
import type {
    AcknowledgeDisposition,
    AcknowledgeResultInput,
    AcknowledgeResultOutput,
    CancelWaitInput,
    CancelWaitResult,
    ClaimResumeInput,
    EvidencePinRecord,
    EvidenceReadRecord,
    HoldFailedResumeInput,
    HoldFailedResumeResult,
    OperationRecord,
    OwnerIdentity,
    PublishResumeAttemptInput,
    PublishResumeAttemptResult,
    RecordEvidencePinInput,
    RecordEvidencePinResult,
    RecordEvidenceReadInput,
    RecordEvidenceReadResult,
    RegisterWaitInput,
    RegisterWaitResult,
    ReleaseResumeClaimInput,
    ReleaseResumeClaimResult,
    ResumeClaimFilter,
    ResumeClaimRecord,
    ResumeClaimResult,
    ResumeClaimState,
    ResumeLeaseIdentity,
    TerminalOutcome,
    TransitionWaitPhaseInput,
    TransitionWaitPhaseResult,
    WaitDependencyInput,
    WaitDependencyRecord,
    WaitFilter,
    WaitParkIntent,
    WaitPhase,
    WaitRecord,
    WaitRef,
} from "./types.ts";
import {
    describeOwnerDiff,
    normalizeOwner,
    optionalText,
    requireBoolean,
    requireCounter,
    requireEnum,
    requireId,
    requireText,
    sameOwner,
} from "./validate.ts";

const PHASES: readonly WaitPhase[] = [
    "registering",
    "parking",
    "waiting",
    "ready",
    "resuming",
    "consumed",
    "held",
    "cancelled",
];

const TERMINAL_PHASES: readonly WaitPhase[] = ["consumed", "cancelled"];

/**
 * Direct transitions. `consumed`/`cancelled` have dedicated calls, and leaving
 * `resuming` goes through `releaseResumeClaim` so the claim record stays truthful.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<WaitPhase, readonly WaitPhase[]>> = {
    registering: ["parking", "waiting", "ready", "held"],
    parking: ["waiting", "ready", "held"],
    waiting: ["ready", "held"],
    ready: ["held"],
    resuming: [],
    held: ["waiting", "ready"],
    consumed: [],
    cancelled: [],
};

const DIRECT_TARGETS = ["parking", "waiting", "ready", "held"] as const;

const DISPOSITIONS: readonly AcknowledgeDisposition[] = ["continue", "blocked", "assignment-complete"];
const CLAIM_STATES: readonly ResumeClaimState[] = ["claimed", "published", "released", "invalidated"];

function assertWaitOwner(wait: WaitRecord, owner: OwnerIdentity, action: string): void {
    if (!sameOwner(wait.owner, owner)) {
        throw new StoreError(
            "foreign-owner",
            `Wait ${wait.waitId} generation ${wait.generation} belongs to another execution owner (differs in ${describeOwnerDiff(wait.owner, owner)}); ${action} must come from the owner.`,
        );
    }
}

/** Reject a caller that addresses a superseded generation. */
function assertCurrentGeneration(ctx: StoreContext, waitId: string, generation: number): void {
    if (getRow(ctx, "SELECT assignment_id FROM assignment_outcome_waits WHERE wait_id = ? AND generation = ?", waitId, generation)) {
        throw new StoreError("wait-phase", "The assignment has a terminal outcome; automatic dispatch is disarmed.");
    }
    const latest = latestWaitGeneration(ctx, waitId);
    if (latest !== null && generation < latest) {
        throw new StoreError(
            "stale-generation",
            `Wait ${waitId} has moved on to generation ${latest}; generation ${generation} is superseded. Read the current generation before acting.`,
        );
    }
}

function assertExpectedEpoch(wait: WaitRecord, expected: number): void {
    if (expected !== wait.cancelEpoch) {
        throw new StoreError(
            "stale-cancel-epoch",
            `Wait ${wait.waitId} generation ${wait.generation} is at cancellation epoch ${wait.cancelEpoch}; the caller observed ${expected}. A cancellation or replacement happened in between, so this action is stale.`,
        );
    }
}

function normalizeDependencies(value: unknown): WaitDependencyInput[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new StoreError(
            "validation",
            "Invalid dependencies: a wait needs at least one operation dependency",
        );
    }
    if (value.length > 100) {
        throw new StoreError("validation", "Invalid dependencies: at most 100 operations per wait");
    }
    const seen = new Set<string>();
    return value.map((entry, index) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new StoreError("validation", `Invalid dependencies[${index}]: must be an object`);
        }
        const item = entry as WaitDependencyInput;
        const operationId = requireId(`dependencies[${index}].operationId`, item.operationId);
        if (seen.has(operationId)) {
            throw new StoreError(
                "validation",
                `Invalid dependencies: operation ${operationId} is listed twice`,
            );
        }
        seen.add(operationId);
        const link = item.link === undefined
            ? "owner" as const
            : requireEnum(`dependencies[${index}].link`, item.link, ["owner", "explicit"] as const);
        return { operationId, link };
    });
}

function normalizePark(value: unknown): WaitParkIntent | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "object" || Array.isArray(value)) {
        throw new StoreError("validation", "Invalid park: must be an object");
    }
    const park = value as WaitParkIntent;
    return {
        attemptId: requireId("park.attemptId", park.attemptId),
        checkpointId: requireId("park.checkpointId", park.checkpointId),
        writerLeaseId: park.writerLeaseId === undefined || park.writerLeaseId === null
            ? null
            : requireId("park.writerLeaseId", park.writerLeaseId),
    };
}

function normalizeOrigin(value: unknown): RegisterWaitInput["origin"] | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "object" || Array.isArray(value)) {
        throw new StoreError("validation", "Invalid origin: must be an object");
    }
    const origin = value as NonNullable<RegisterWaitInput["origin"]>;
    if (origin.taskIds !== undefined && !Array.isArray(origin.taskIds)) {
        throw new StoreError("validation", "Invalid origin.taskIds: must be an array");
    }
    return {
        taskIds: (origin.taskIds ?? []).map((taskId, index) => requireId(`origin.taskIds[${index}]`, taskId)),
        assignmentRef: optionalText("origin.assignmentRef", origin.assignmentRef, 200),
        attemptId: origin.attemptId === undefined || origin.attemptId === null
            ? null
            : requireId("origin.attemptId", origin.attemptId),
    };
}

function normalizeLease(value: unknown): ResumeLeaseIdentity {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new StoreError("validation", "Invalid lease: must be an object");
    }
    const lease = value as ResumeLeaseIdentity;
    return {
        ownerId: requireId("lease.ownerId", lease.ownerId),
        pid: lease.pid === undefined || lease.pid === null ? null : requireCounter("lease.pid", lease.pid),
        processStartToken: lease.processStartToken === undefined || lease.processStartToken === null
            ? null
            : requireId("lease.processStartToken", lease.processStartToken),
    };
}

// ---- settlement ---------------------------------------------------------

/**
 * Apply a terminal revision to every wait generation that depends on it.
 *
 * Waits in `waiting` move to `ready` and get their delivery enqueued in the same
 * transaction. Waits in `registering`/`parking` stay put — their checkpoint gate
 * is still open — but their dependency rows are already settled, so their next
 * transition resolves straight to `ready`.
 */
export function settleWaitsForOperation(
    ctx: StoreContext,
    operation: OperationRecord,
    at: number,
): { ready: WaitRecord[] } {
    if (operation.terminalRevision <= 0) return { ready: [] };
    const affected = getRows(
        ctx,
        "SELECT DISTINCT wait_id, generation FROM wait_dependencies WHERE operation_id = ? AND terminal_revision = 0",
        operation.operationId,
    );
    if (affected.length === 0) return { ready: [] };
    run(
        ctx,
        `UPDATE wait_dependencies SET terminal_revision = ?, terminal_outcome = ?, settled_at = ?
         WHERE operation_id = ? AND terminal_revision = 0`,
        operation.terminalRevision,
        operation.terminalOutcome,
        at,
        operation.operationId,
    );

    const ready: WaitRecord[] = [];
    for (const row of affected) {
        const waitId = columnText(row, "wait_id");
        const generation = columnNumber(row, "generation");
        const waitRow = readWaitRow(ctx, waitId, generation);
        if (!waitRow) continue;
        const state = dependencyState(ctx, waitId, generation);
        if (state.settled) {
            run(
                ctx,
                "UPDATE waits SET settled_at = coalesce(settled_at, ?), updated_at = ? WHERE wait_id = ? AND generation = ?",
                state.settledAt ?? at,
                at,
                waitId,
                generation,
            );
        }
        const phase = columnText(waitRow, "phase") as WaitPhase;
        if (phase !== "waiting" || !state.settled) continue;
        run(
            ctx,
            "UPDATE waits SET phase = 'ready', phase_reason = ?, updated_at = ? WHERE wait_id = ? AND generation = ?",
            "dependencies-settled",
            at,
            waitId,
            generation,
        );
        enqueueReadyGeneration(ctx, waitId, generation, at);
        ready.push(requireWait(ctx, waitId, generation));
    }
    return { ready };
}

// ---- registration -------------------------------------------------------

export function registerWait(ctx: StoreContext, input: RegisterWaitInput): RegisterWaitResult {
    const owner = normalizeOwner("owner", input.owner);
    const dependencies = normalizeDependencies(input.dependencies);
    const continuationNote = requireText("continuationNote", input.continuationNote, 8192);
    const park = normalizePark(input.park);
    const origin = normalizeOrigin(input.origin);
    const requestedWaitId = input.waitId === undefined ? null : requireId("waitId", input.waitId);

    return ctx.transaction(() => {
        const at = ctx.now();
        if (origin?.assignmentRef && getRow(ctx, "SELECT assignment_id FROM assignment_outcomes WHERE assignment_id = ?", origin.assignmentRef)) {
            throw new StoreError("wait-phase", "A terminal assignment cannot register another wait; delegate a new assignment.");
        }
        const resolved: Array<{
            dependency: WaitDependencyInput;
            terminalRevision: number;
            terminalOutcome: TerminalOutcome | null;
        }> = [];
        for (const dependency of dependencies) {
            const row = getOperationRow(ctx, dependency.operationId);
            if (!row) {
                throw new StoreError(
                    "unknown-operation",
                    `Unknown operation ${dependency.operationId}. A wait may only depend on a registered operation; an unregistered id is refused rather than watched.`,
                );
            }
            const operationOwner = ownerFromRow(row);
            if (dependency.link === "owner" && !sameOwner(operationOwner, owner)) {
                throw new StoreError(
                    "foreign-owner",
                    `Operation ${dependency.operationId} belongs to another execution owner (differs in ${describeOwnerDiff(operationOwner, owner)}). Only an owned or explicitly linked operation may be waited on.`,
                );
            }
            const terminalRevision = columnNumber(row, "terminal_revision");
            resolved.push({
                dependency,
                terminalRevision,
                terminalOutcome: terminalRevision > 0
                    ? columnNullableText(row, "terminal_outcome") as TerminalOutcome | null
                    : null,
            });
        }

        let waitId = requestedWaitId ?? `wait_${randomUUID()}`;
        let generation = 1;
        if (requestedWaitId !== null) {
            const existing = getRows(
                ctx,
                "SELECT * FROM waits WHERE wait_id = ? ORDER BY generation DESC",
                requestedWaitId,
            );
            for (const row of existing) {
                const existingOwner = ownerFromRow(row);
                if (!sameOwner(existingOwner, owner)) {
                    throw new StoreError(
                        "foreign-owner",
                        `Wait ${requestedWaitId} is owned by another execution owner (differs in ${describeOwnerDiff(existingOwner, owner)}).`,
                    );
                }
            }
            const pending = existing.find(
                (row) => !TERMINAL_PHASES.includes(columnText(row, "phase") as WaitPhase),
            );
            if (pending) {
                throw new StoreError(
                    "pending-wait-generation",
                    `Wait ${requestedWaitId} generation ${Number(pending.generation)} is still ${columnText(pending, "phase")}. A second pending generation is refused; consume, cancel or take over the existing one first.`,
                );
            }
            generation = existing.length === 0 ? 1 : Number(existing[0].generation) + 1;
        } else {
            const otherPending = getRow(
                ctx,
                `SELECT * FROM waits
                 WHERE owner_kind = ? AND owner_session_id = ?
                   AND coalesce(owner_branch_id, '') = ?
                   AND phase NOT IN ('consumed', 'cancelled')`,
                owner.kind,
                owner.sessionId,
                owner.branchId ?? "",
            );
            if (otherPending) {
                waitId = columnText(otherPending, "wait_id");
                throw new StoreError(
                    "pending-wait-generation",
                    `This execution owner already has a pending wait (${waitId} generation ${Number(otherPending.generation)}, ${columnText(otherPending, "phase")}). A second pending generation would compete for the same continuation; reuse that wait id after consuming or cancelling it.`,
                );
            }
        }

        const settled = resolved.every((entry) => entry.terminalRevision > 0);
        const phase: WaitPhase = park !== null ? "registering" : settled ? "ready" : "waiting";
        const settledAt = settled ? at : null;
        try {
            run(
                ctx,
                `INSERT INTO waits (
                    wait_id, generation,
                    owner_kind, owner_session_id, owner_workspace, owner_branch_id, owner_goal_id,
                    phase, phase_reason, cancel_epoch, continuation_note, park_json, origin_json,
                    settled_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
                waitId,
                generation,
                owner.kind,
                owner.sessionId,
                owner.workspace,
                owner.branchId ?? null,
                owner.goalId ?? null,
                phase,
                settled ? "dependencies-settled-at-registration" : null,
                continuationNote,
                park ? JSON.stringify(park) : null,
                origin ? JSON.stringify(origin) : null,
                settledAt,
                at,
                at,
            );
        } catch (error) {
            // A concurrent process registered a generation for this owner identity
            // between the check above and this insert.
            if (isUniqueViolation(error, "waits_one_pending_per_owner", "waits")) {
                throw new StoreError(
                    "pending-wait-generation",
                    `This execution owner already has a pending wait generation; a concurrent registration won. Re-read the pending generation before registering again.`,
                );
            }
            throw error;
        }
        resolved.forEach((entry, ordinal) => {
            run(
                ctx,
                `INSERT INTO wait_dependencies (
                    wait_id, generation, ordinal, operation_id, link,
                    terminal_revision, terminal_outcome, settled_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                waitId,
                generation,
                ordinal,
                entry.dependency.operationId,
                entry.dependency.link ?? "owner",
                entry.terminalRevision,
                entry.terminalOutcome,
                entry.terminalRevision > 0 ? at : null,
            );
        });

        const outbox = settled ? enqueueReadyGeneration(ctx, waitId, generation, at) : [];
        return {
            wait: requireWait(ctx, waitId, generation),
            settledAtRegistration: settled,
            outbox,
        };
    });
}

// ---- phase transitions --------------------------------------------------

export function transitionWaitPhase(
    ctx: StoreContext,
    input: TransitionWaitPhaseInput,
): TransitionWaitPhaseResult {
    const waitId = requireId("waitId", input.waitId);
    const generation = requireCounter("generation", input.generation);
    const from = requireEnum("from", input.from, PHASES);
    const to = requireEnum("to", input.to, DIRECT_TARGETS);
    const reason = optionalText("reason", input.reason, 1024);
    const proof = input.proof === undefined || input.proof === null
        ? null
        : {
            checkpointRecorded: requireBoolean("proof.checkpointRecorded", input.proof.checkpointRecorded),
            writerLeaseReleased: requireBoolean("proof.writerLeaseReleased", input.proof.writerLeaseReleased),
            writerPidGone: input.proof.writerPidGone === undefined
                ? false
                : requireBoolean("proof.writerPidGone", input.proof.writerPidGone),
        };

    return ctx.transaction(() => {
        assertCurrentGeneration(ctx, waitId, generation);
        const wait = requireWait(ctx, waitId, generation);
        if (wait.phase !== from) {
            throw new StoreError(
                "stale-phase",
                `Wait ${waitId} generation ${generation} is ${wait.phase}, but the caller acted on ${from}. Re-read the wait before transitioning it.`,
            );
        }
        if (to === "parking" && wait.park === null) {
            throw new StoreError(
                "wait-phase",
                `Wait ${waitId} generation ${generation} has no park intent; a responsive parent stays in waiting/ready and does not park an attempt.`,
            );
        }
        if (!ALLOWED_TRANSITIONS[wait.phase].includes(to)) {
            const allowed = ALLOWED_TRANSITIONS[wait.phase];
            const detail = wait.phase === "resuming"
                ? "a resuming wait is completed with releaseResumeClaim, not a direct transition"
                : `allowed from ${wait.phase}: ${allowed.length === 0 ? "none" : allowed.join(", ")}`;
            throw new StoreError(
                "wait-phase",
                `Wait ${waitId} generation ${generation} cannot move ${wait.phase} → ${to} (${detail}).`,
            );
        }
        // The checkpoint gate belongs to the parking boundary only. Once a parked
        // worker has left `parking` with proof, later holds and recoveries act on
        // the same generation and must not be asked to re-prove the checkpoint.
        const atParkingBoundary = wait.park !== null
            && to !== "parking"
            && (wait.phase === "registering" || wait.phase === "parking");
        if (atParkingBoundary) {
            const proven = proof !== null
                && proof.checkpointRecorded
                && proof.writerLeaseReleased
                && proof.writerPidGone;
            if (wait.phase !== "parking" || !proven) {
                throw new StoreError(
                    "checkpoint-proof",
                    `Wait ${waitId} generation ${generation} belongs to a parked worker. It can reach ${to} only from parking with proven checkpoint commit, writer lease release and writer process exit (got phase ${wait.phase}${proof ? "" : ", no proof"}). A partially recorded checkpoint must never become the continuation point.`,
                );
            }
        }
        if (to === "held" && reason === null) {
            throw new StoreError(
                "validation",
                "Invalid reason: a held wait must record why it is held",
            );
        }
        const state = dependencyState(ctx, waitId, generation);
        if (to === "ready" && !state.settled) {
            throw new StoreError(
                "dependencies-unsettled",
                `Wait ${waitId} generation ${generation} cannot be ready: ${state.dependencies.filter((dep) => dep.terminalRevision === 0).map((dep) => dep.operationId).join(", ")} has no terminal outcome yet.`,
            );
        }
        // A dependency that settled during parking resolves straight to ready.
        const resulting: WaitPhase = to === "waiting" && state.settled ? "ready" : to;
        const phaseReason = to === "waiting" && state.settled
            ? "settled-while-parking"
            : reason;
        const at = ctx.now();
        run(
            ctx,
            "UPDATE waits SET phase = ?, phase_reason = ?, settled_at = coalesce(settled_at, ?), updated_at = ? WHERE wait_id = ? AND generation = ?",
            resulting,
            phaseReason,
            state.settled ? state.settledAt ?? at : null,
            at,
            waitId,
            generation,
        );
        const outbox = resulting === "ready" ? enqueueReadyGeneration(ctx, waitId, generation, at) : [];
        return { wait: requireWait(ctx, waitId, generation), outbox };
    });
}

// ---- cancellation -------------------------------------------------------

export function cancelWait(ctx: StoreContext, input: CancelWaitInput): CancelWaitResult {
    const waitId = requireId("waitId", input.waitId);
    const generation = requireCounter("generation", input.generation);
    const expectedCancelEpoch = requireCounter("expectedCancelEpoch", input.expectedCancelEpoch);
    const owner = normalizeOwner("owner", input.owner);
    const reason = requireText("reason", input.reason, 1024);

    return ctx.transaction(() => {
        assertCurrentGeneration(ctx, waitId, generation);
        const wait = requireWait(ctx, waitId, generation);
        assertWaitOwner(wait, owner, "cancellation");
        if (TERMINAL_PHASES.includes(wait.phase)) {
            throw new StoreError(
                "wait-phase",
                `Wait ${waitId} generation ${generation} is already ${wait.phase}; cancellation is recorded once and cannot be repeated or replaced.`,
            );
        }
        assertExpectedEpoch(wait, expectedCancelEpoch);
        const at = ctx.now();
        run(
            ctx,
            "UPDATE waits SET phase = 'cancelled', phase_reason = ?, cancel_epoch = cancel_epoch + 1, updated_at = ? WHERE wait_id = ? AND generation = ?",
            reason,
            at,
            waitId,
            generation,
        );
        const activeClaimRows = getRows(
            ctx,
            "SELECT claim_id FROM resume_claims WHERE wait_id = ? AND generation = ? AND state IN ('claimed', 'published')",
            waitId,
            generation,
        );
        const invalidatedClaimIds = activeClaimRows.map((row) => columnText(row, "claim_id"));
        run(
            ctx,
            `UPDATE resume_claims SET state = 'invalidated', invalidated_at = ?, reason = ?
             WHERE wait_id = ? AND generation = ? AND state IN ('claimed', 'published')`,
            at,
            reason,
            waitId,
            generation,
        );
        const voidedOutboxIds = voidGenerationOutbox(ctx, waitId, generation, reason, at);
        releaseGenerationPins(ctx, waitId, generation, "wait-cancelled", at);
        return {
            wait: requireWait(ctx, waitId, generation),
            invalidatedClaimIds,
            voidedOutboxIds,
        };
    });
}

// ---- resume claims ------------------------------------------------------

export function claimResume(ctx: StoreContext, input: ClaimResumeInput): ResumeClaimResult {
    const waitId = requireId("waitId", input.waitId);
    const generation = requireCounter("generation", input.generation);
    const expectedCancelEpoch = requireCounter("expectedCancelEpoch", input.expectedCancelEpoch);
    const lease = normalizeLease(input.lease);
    const reservedCheckpointId = requireId("reservedCheckpointId", input.reservedCheckpointId);

    return ctx.transaction(() => {
        assertCurrentGeneration(ctx, waitId, generation);
        const wait = requireWait(ctx, waitId, generation);
        const active = getRows(
            ctx,
            "SELECT claim_id FROM resume_claims WHERE wait_id = ? AND generation = ? AND state IN ('claimed', 'published')",
            waitId,
            generation,
        )[0];
        if (active) {
            throw new StoreError(
                "concurrent-claim",
                `Wait ${waitId} generation ${generation} already has an active resume claim (${columnText(active, "claim_id")}). One conversation admits one writer; release or invalidate that claim instead of claiming again.`,
            );
        }
        if (wait.phase !== "ready") {
            throw new StoreError(
                "wait-phase",
                `Wait ${waitId} generation ${generation} is ${wait.phase}; only a ready generation can be claimed for continuation.`,
            );
        }
        assertExpectedEpoch(wait, expectedCancelEpoch);
        if (!wait.settled) {
            throw new StoreError(
                "dependencies-unsettled",
                `Wait ${waitId} generation ${generation} has unfinished dependencies; a continuation is claimed only after every dependency is terminal.`,
            );
        }
        const at = ctx.now();
        const claimId = `claim_${randomUUID()}`;
        try {
            run(
                ctx,
                `INSERT INTO resume_claims (
                    claim_id, wait_id, generation, cancel_epoch, claim_token, state,
                    lease_json, reserved_checkpoint_id, claimed_at
                ) VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, ?)`,
                claimId,
                waitId,
                generation,
                wait.cancelEpoch,
                `claimtok_${randomUUID()}`,
                JSON.stringify(lease),
                reservedCheckpointId,
                at,
            );
        } catch (error) {
            // Another supervisor claimed this generation concurrently.
            if (isUniqueViolation(error, "resume_claims_one_active", "resume_claims")) {
                throw new StoreError(
                    "concurrent-claim",
                    `Wait ${waitId} generation ${generation} was claimed concurrently by another supervisor. One conversation admits one writer; reconcile that claim instead of claiming again.`,
                );
            }
            throw error;
        }
        run(
            ctx,
            "UPDATE waits SET phase = 'resuming', phase_reason = ?, updated_at = ? WHERE wait_id = ? AND generation = ?",
            "resume-claimed",
            at,
            waitId,
            generation,
        );
        return { claim: requireClaim(ctx, claimId), wait: requireWait(ctx, waitId, generation) };
    });
}

export function publishResumeAttempt(
    ctx: StoreContext,
    input: PublishResumeAttemptInput,
): PublishResumeAttemptResult {
    const waitId = requireId("waitId", input.waitId);
    const generation = requireCounter("generation", input.generation);
    const claimId = requireId("claimId", input.claimId);
    const claimToken = requireId("claimToken", input.claimToken);
    const attemptId = requireId("attemptId", input.attemptId);
    const launchToken = requireId("launchToken", input.launchToken);

    return ctx.transaction(() => {
        assertCurrentGeneration(ctx, waitId, generation);
        const wait = requireWait(ctx, waitId, generation);
        const claim = requireClaim(ctx, claimId);
        if (claim.waitId !== waitId || claim.generation !== generation) {
            throw new StoreError(
                "claim-state",
                `Resume claim ${claimId} belongs to ${claim.waitId} generation ${claim.generation}, not ${waitId} generation ${generation}.`,
            );
        }
        if (claim.claimToken !== claimToken) {
            throw new StoreError(
                "claim-state",
                `Resume claim ${claimId} was not issued with this token; the caller does not hold the claim.`,
            );
        }
        if (claim.state === "invalidated") {
            throw new StoreError(
                "claim-state",
                `Resume claim ${claimId} was invalidated (${claim.reason ?? "no reason recorded"}); it can never publish an attempt.`,
            );
        }
        if (wait.phase === "cancelled" || wait.cancelEpoch !== claim.cancelEpoch) {
            // Cancellation already invalidates the claim in its own transaction; this
            // refusal must not write anything (a throw rolls the transaction back).
            throw new StoreError(
                "stale-cancel-epoch",
                `Wait ${waitId} generation ${generation} was cancelled after the claim (epoch ${wait.cancelEpoch} vs claimed ${claim.cancelEpoch}). The attempt must not start.`,
            );
        }
        if (wait.phase !== "resuming") {
            throw new StoreError(
                "claim-state",
                `Wait ${waitId} generation ${generation} is ${wait.phase}; a resume attempt may only be published while the generation is resuming.`,
            );
        }
        if (claim.state === "published") {
            if (claim.attemptId === attemptId && claim.launchToken === launchToken) {
                return { claim, wait, published: false };
            }
            throw new StoreError(
                "claim-state",
                `Resume claim ${claimId} already published attempt ${claim.attemptId}. One claim launches one attempt; reconcile that attempt instead of publishing another.`,
            );
        }
        if (claim.state !== "claimed") {
            throw new StoreError(
                "claim-state",
                `Resume claim ${claimId} is ${claim.state}; only a claimed reservation can publish an attempt.`,
            );
        }
        const clash = getRow(
            ctx,
            "SELECT claim_id FROM resume_claims WHERE attempt_id = ? AND claim_id <> ?",
            attemptId,
            claimId,
        );
        if (clash) {
            throw new StoreError(
                "attempt-conflict",
                `Attempt ${attemptId} is already published by resume claim ${columnText(clash, "claim_id")}. Attempt ids identify one execution and cannot be reused.`,
            );
        }
        const at = ctx.now();
        run(
            ctx,
            "UPDATE resume_claims SET state = 'published', attempt_id = ?, launch_token = ?, published_at = ? WHERE claim_id = ?",
            attemptId,
            launchToken,
            at,
            claimId,
        );
        return { claim: requireClaim(ctx, claimId), wait, published: true };
    });
}

export function releaseResumeClaim(
    ctx: StoreContext,
    input: ReleaseResumeClaimInput,
): ReleaseResumeClaimResult {
    const waitId = requireId("waitId", input.waitId);
    const generation = requireCounter("generation", input.generation);
    const claimId = requireId("claimId", input.claimId);
    const claimToken = requireId("claimToken", input.claimToken);
    const outcome = requireEnum("outcome", input.outcome, ["ready", "held"] as const);
    const reason = requireText("reason", input.reason, 1024);

    return ctx.transaction(() => {
        assertCurrentGeneration(ctx, waitId, generation);
        const wait = requireWait(ctx, waitId, generation);
        const claim = requireClaim(ctx, claimId);
        if (claim.waitId !== waitId || claim.generation !== generation) {
            throw new StoreError(
                "claim-state",
                `Resume claim ${claimId} belongs to ${claim.waitId} generation ${claim.generation}, not ${waitId} generation ${generation}.`,
            );
        }
        if (claim.claimToken !== claimToken) {
            throw new StoreError(
                "claim-state",
                `Resume claim ${claimId} was not issued with this token; the caller does not hold the claim.`,
            );
        }
        if (claim.state === "published") {
            throw new StoreError(
                "claim-state",
                `Resume claim ${claimId} already published attempt ${claim.attemptId}. A published attempt is reconciled, not released; releasing it could start a second execution.`,
            );
        }
        if (claim.state !== "claimed") {
            throw new StoreError(
                "claim-state",
                `Resume claim ${claimId} is ${claim.state}; only a claimed reservation can be released.`,
            );
        }
        if (outcome === "ready" && !wait.settled) {
            throw new StoreError(
                "dependencies-unsettled",
                `Wait ${waitId} generation ${generation} cannot return to ready with unfinished dependencies.`,
            );
        }
        const at = ctx.now();
        run(
            ctx,
            "UPDATE resume_claims SET state = 'released', released_at = ?, reason = ? WHERE claim_id = ?",
            at,
            reason,
            claimId,
        );
        run(
            ctx,
            "UPDATE waits SET phase = ?, phase_reason = ?, updated_at = ? WHERE wait_id = ? AND generation = ?",
            outcome,
            reason,
            at,
            waitId,
            generation,
        );
        return { claim: requireClaim(ctx, claimId), wait: requireWait(ctx, waitId, generation) };
    });
}

/**
 * Hold a published generation whose attempt exited without interpreting it.
 *
 * This is the proven-exit counterpart of `releaseResumeClaim`: the general release
 * refuses a published claim because releasing it could start a second execution.
 * Here the attempt is proven gone, so the generation leaves `resuming` for `held`
 * with a reason, its cancellation epoch is unchanged (a failure is not a user
 * cancellation), its evidence pins are retained, and the claim is invalidated so it
 * can never publish another attempt.
 *
 * Identity is exact: generation, claim id, claim token, attempt id and launch
 * token must all name this publication. The proof must state a gone writer and a
 * released writer lease. Replaying the same call is idempotent. A generation that
 * is already `consumed` or `cancelled` is never altered.
 */
export function holdFailedResume(
    ctx: StoreContext,
    input: HoldFailedResumeInput,
): HoldFailedResumeResult {
    const waitId = requireId("waitId", input.waitId);
    const generation = requireCounter("generation", input.generation);
    const claimId = requireId("claimId", input.claimId);
    const claimToken = requireId("claimToken", input.claimToken);
    const attemptId = requireId("attemptId", input.attemptId);
    const launchToken = requireId("launchToken", input.launchToken);
    const reason = requireText("reason", input.reason, 1024);
    const proof = input.proof;
    if (!proof || typeof proof !== "object") {
        throw new StoreError("validation", "Invalid proof: a held resume needs the writer exit proof");
    }
    if (proof.writerPidGone !== true || proof.writerLeaseReleased !== true) {
        throw new StoreError(
            "resume-proof",
            "Holding a published resume needs proven writer exit and a released writer lease; an ambiguous identity stays with its live writer and is not held here.",
        );
    }

    return ctx.transaction(() => {
        assertCurrentGeneration(ctx, waitId, generation);
        const wait = requireWait(ctx, waitId, generation);
        if (TERMINAL_PHASES.includes(wait.phase)) {
            throw new StoreError(
                "wait-phase",
                `Wait ${waitId} generation ${generation} is already ${wait.phase}; a failed resume never rewrites a consumed or cancelled generation.`,
            );
        }
        const claim = requireClaim(ctx, claimId);
        if (claim.waitId !== waitId || claim.generation !== generation) {
            throw new StoreError(
                "claim-state",
                `Resume claim ${claimId} belongs to ${claim.waitId} generation ${claim.generation}, not ${waitId} generation ${generation}.`,
            );
        }
        if (claim.claimToken !== claimToken) {
            throw new StoreError(
                "claim-state",
                `Resume claim ${claimId} was not issued with this token; the caller does not hold the claim.`,
            );
        }
        if (claim.attemptId !== attemptId || claim.launchToken !== launchToken) {
            throw new StoreError(
                "claim-state",
                `Resume claim ${claimId} published attempt ${claim.attemptId ?? "(none)"} with a different launch token; this is not the attempt that failed.`,
            );
        }
        if (claim.cancelEpoch !== wait.cancelEpoch) {
            throw new StoreError(
                "stale-cancel-epoch",
                `Resume claim ${claimId} was taken at cancellation epoch ${claim.cancelEpoch}, but the wait is at ${wait.cancelEpoch}.`,
            );
        }
        if (claim.state === "invalidated" && wait.phase === "held") {
            // Idempotent replay: the same failed attempt already held this generation.
            return { wait, claim, applied: false };
        }
        if (claim.state !== "published") {
            throw new StoreError(
                "claim-state",
                `Resume claim ${claimId} is ${claim.state}; only a published attempt can be held after a proven exit.`,
            );
        }
        if (wait.phase !== "resuming") {
            throw new StoreError(
                "wait-phase",
                `Wait ${waitId} generation ${generation} is ${wait.phase}, not resuming; it cannot be held as a failed resume.`,
            );
        }
        const at = ctx.now();
        run(
            ctx,
            "UPDATE waits SET phase = 'held', phase_reason = ?, updated_at = ? WHERE wait_id = ? AND generation = ?",
            reason,
            at,
            waitId,
            generation,
        );
        run(
            ctx,
            "UPDATE resume_claims SET state = 'invalidated', invalidated_at = ?, reason = ? WHERE claim_id = ? AND state = 'published'",
            at,
            reason,
            claimId,
        );
        return { wait: requireWait(ctx, waitId, generation), claim: requireClaim(ctx, claimId), applied: true };
    });
}

export function listResumeClaims(
    ctx: StoreContext,
    filter: ResumeClaimFilter = {},
): ResumeClaimRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.waitId !== undefined) {
        clauses.push("wait_id = ?");
        params.push(requireId("waitId", filter.waitId));
    }
    if (filter.generation !== undefined) {
        clauses.push("generation = ?");
        params.push(requireCounter("generation", filter.generation));
    }
    if (filter.state !== undefined) {
        const states = Array.isArray(filter.state) ? filter.state : [filter.state as ResumeClaimState];
        for (const state of states) {
            if (!CLAIM_STATES.includes(state)) {
                throw new StoreError("validation", `Invalid state: must be one of ${CLAIM_STATES.join(", ")}`);
            }
        }
        clauses.push(`state IN (${states.map(() => "?").join(", ")})`);
        params.push(...states);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return getRows(ctx, `SELECT * FROM resume_claims ${where} ORDER BY claimed_at, claim_id`, ...params)
        .map(mapClaim);
}

// ---- evidence reads and pins -------------------------------------------

export function recordEvidenceRead(
    ctx: StoreContext,
    input: RecordEvidenceReadInput,
): RecordEvidenceReadResult {
    const waitId = requireId("waitId", input.waitId);
    const generation = requireCounter("generation", input.generation);
    const owner = normalizeOwner("owner", input.owner);
    const operationId = requireId("operationId", input.operationId);
    const terminalRevision = requireCounter("terminalRevision", input.terminalRevision);

    return ctx.transaction(() => {
        const wait = requireWait(ctx, waitId, generation);
        assertWaitOwner(wait, owner, "an evidence read");
        if (TERMINAL_PHASES.includes(wait.phase)) {
            throw new StoreError(
                "wait-phase",
                `Wait ${waitId} generation ${generation} is ${wait.phase}; its evidence is no longer interpreted.`,
            );
        }
        const dependency = wait.dependencies.find((dep) => dep.operationId === operationId);
        if (!dependency) {
            throw new StoreError(
                "stale-evidence",
                `Operation ${operationId} is not a dependency of wait ${waitId} generation ${generation}.`,
            );
        }
        if (dependency.terminalRevision === 0) {
            throw new StoreError(
                "dependencies-unsettled",
                `Operation ${operationId} has no terminal outcome yet, so there is no evidence to read for wait ${waitId}.`,
            );
        }
        if (dependency.terminalRevision !== terminalRevision) {
            throw new StoreError(
                "stale-evidence",
                `Operation ${operationId} is at terminal revision ${dependency.terminalRevision}, not ${terminalRevision}. A read must name the revision it actually inspected.`,
            );
        }
        const at = ctx.now();
        const changes = run(
            ctx,
            `INSERT OR IGNORE INTO evidence_reads (
                wait_id, generation, operation_id, terminal_revision,
                reader_kind, reader_session_id, reader_workspace, reader_branch_id, reader_goal_id, read_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            waitId,
            generation,
            operationId,
            terminalRevision,
            owner.kind,
            owner.sessionId,
            owner.workspace,
            owner.branchId ?? null,
            owner.goalId ?? null,
            at,
        );
        const row = getRow(
            ctx,
            `SELECT * FROM evidence_reads
             WHERE wait_id = ? AND generation = ? AND operation_id = ? AND terminal_revision = ?`,
            waitId,
            generation,
            operationId,
            terminalRevision,
        );
        return { read: mapEvidenceRead(row as Record<string, unknown>), recorded: changes > 0 };
    });
}

export function listEvidenceReads(ctx: StoreContext, ref: WaitRef): EvidenceReadRecord[] {
    const waitId = requireId("waitId", ref.waitId);
    const generation = ref.generation === undefined
        ? latestWaitGeneration(ctx, waitId)
        : requireCounter("generation", ref.generation);
    if (generation === null) return [];
    return getRows(
        ctx,
        "SELECT * FROM evidence_reads WHERE wait_id = ? AND generation = ? ORDER BY read_at, operation_id",
        waitId,
        generation,
    ).map(mapEvidenceRead);
}

export function recordEvidencePin(
    ctx: StoreContext,
    input: RecordEvidencePinInput,
): RecordEvidencePinResult {
    const waitId = requireId("waitId", input.waitId);
    const generation = requireCounter("generation", input.generation);
    const operationId = requireId("operationId", input.operationId);
    const terminalRevision = requireCounter("terminalRevision", input.terminalRevision);
    const kind = requireEnum("kind", input.kind, [
        "terminal-record",
        "log",
        "summary",
        "artifact",
    ] as const);
    const ref = requireText("ref", input.ref, 1024);
    const summary = optionalText("summary", input.summary, 2048);
    const detailLost = input.detailLost === undefined ? false : requireBoolean("detailLost", input.detailLost);
    const bytes = input.bytes === undefined ? null : requireCounter("bytes", input.bytes);

    return ctx.transaction(() => {
        const wait = requireWait(ctx, waitId, generation);
        if (TERMINAL_PHASES.includes(wait.phase)) {
            throw new StoreError(
                "wait-phase",
                `Wait ${waitId} generation ${generation} is ${wait.phase}; its evidence pins were released.`,
            );
        }
        const dependency = wait.dependencies.find((dep) => dep.operationId === operationId);
        if (!dependency) {
            throw new StoreError(
                "stale-evidence",
                `Operation ${operationId} is not a dependency of wait ${waitId} generation ${generation}.`,
            );
        }
        if (dependency.terminalRevision === 0) {
            throw new StoreError(
                "dependencies-unsettled",
                `Operation ${operationId} has no terminal outcome yet; only terminal evidence can be pinned.`,
            );
        }
        if (dependency.terminalRevision !== terminalRevision) {
            throw new StoreError(
                "stale-evidence",
                `Operation ${operationId} is at terminal revision ${dependency.terminalRevision}, not ${terminalRevision}.`,
            );
        }
        const at = ctx.now();
        const pinId = `pin_${randomUUID()}`;
        const changes = run(
            ctx,
            `INSERT OR IGNORE INTO evidence_pins (
                pin_id, wait_id, generation, operation_id, terminal_revision,
                kind, ref, summary, detail_lost, bytes, pinned_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            pinId,
            waitId,
            generation,
            operationId,
            terminalRevision,
            kind,
            ref,
            summary,
            detailLost ? 1 : 0,
            bytes,
            at,
        );
        const row = changes > 0
            ? getRow(ctx, "SELECT * FROM evidence_pins WHERE pin_id = ?", pinId)
            : getRow(
                ctx,
                `SELECT * FROM evidence_pins
                 WHERE wait_id = ? AND generation = ? AND operation_id = ? AND terminal_revision = ?
                   AND kind = ? AND ref = ?`,
                waitId,
                generation,
                operationId,
                terminalRevision,
                kind,
                ref,
            );
        return { pin: mapEvidencePin(row as Record<string, unknown>), recorded: changes > 0 };
    });
}

export function listEvidencePins(
    ctx: StoreContext,
    ref: WaitRef,
    options: { includeReleased?: boolean } = {},
): EvidencePinRecord[] {
    const waitId = requireId("waitId", ref.waitId);
    const generation = ref.generation === undefined
        ? latestWaitGeneration(ctx, waitId)
        : requireCounter("generation", ref.generation);
    if (generation === null) return [];
    return readPins(ctx, waitId, generation, options.includeReleased === true);
}

/**
 * Explicit dismissal: release pins without consuming the result. Called by the
 * owner or by the supervising host during cleanup; it changes retention only.
 */
export function releaseEvidencePins(
    ctx: StoreContext,
    ref: WaitRef & { generation: number },
    reason: string,
): string[] {
    const waitId = requireId("waitId", ref.waitId);
    const generation = requireCounter("generation", ref.generation);
    const text = requireText("reason", reason, 1024);
    return ctx.transaction(() => {
        requireWaitRow(ctx, waitId, generation);
        return releaseGenerationPins(ctx, waitId, generation, text, ctx.now());
    });
}

// ---- interpretation acknowledgement ------------------------------------

/**
 * Record the owner's interpretation of the exact terminal revisions and consume
 * the wait generation. A read of the current revision by the same owner and a
 * persisted note are required; delivery or a status read alone is not consumption.
 */
export function acknowledgeResult(
    ctx: StoreContext,
    input: AcknowledgeResultInput,
): AcknowledgeResultOutput {
    const waitId = requireId("waitId", input.waitId);
    const generation = requireCounter("generation", input.generation);
    const owner = normalizeOwner("owner", input.owner);
    const disposition = requireEnum("disposition", input.disposition, DISPOSITIONS);
    const note = requireText("note", input.note, 8192);
    if (!Array.isArray(input.terminalRevisions) || input.terminalRevisions.length === 0) {
        throw new StoreError(
            "validation",
            "Invalid terminalRevisions: acknowledgement names the exact revisions it interpreted",
        );
    }
    const revisions = input.terminalRevisions.map((entry, index) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new StoreError("validation", `Invalid terminalRevisions[${index}]: must be an object`);
        }
        return {
            operationId: requireId(`terminalRevisions[${index}].operationId`, entry.operationId),
            revision: requireCounter(`terminalRevisions[${index}].revision`, entry.revision),
        };
    });

    return ctx.transaction(() => {
        assertCurrentGeneration(ctx, waitId, generation);
        const wait = requireWait(ctx, waitId, generation);
        assertWaitOwner(wait, owner, "acknowledgement");
        if (TERMINAL_PHASES.includes(wait.phase)) {
            throw new StoreError(
                "wait-phase",
                `Wait ${waitId} generation ${generation} is already ${wait.phase}; an interpretation is recorded once per generation.`,
            );
        }
        if (wait.phase === "registering" || wait.phase === "parking") {
            throw new StoreError(
                "wait-phase",
                `Wait ${waitId} generation ${generation} is still ${wait.phase}; the attempt that owns this checkpoint has not parked, so the result cannot be interpreted yet.`,
            );
        }
        if (!wait.settled) {
            throw new StoreError(
                "dependencies-unsettled",
                `Wait ${waitId} generation ${generation} still has unfinished dependencies; acknowledgement requires a terminal outcome for every one.`,
            );
        }
        const byOperation = new Map(revisions.map((entry) => [entry.operationId, entry.revision]));
        if (byOperation.size !== revisions.length) {
            throw new StoreError(
                "validation",
                "Invalid terminalRevisions: an operation is listed twice",
            );
        }
        for (const dependency of wait.dependencies) {
            const claimed = byOperation.get(dependency.operationId);
            if (claimed === undefined) {
                throw new StoreError(
                    "stale-evidence",
                    `Acknowledgement omits operation ${dependency.operationId}; every settled dependency must be interpreted.`,
                );
            }
            if (claimed !== dependency.terminalRevision) {
                throw new StoreError(
                    "stale-evidence",
                    `Operation ${dependency.operationId} is at terminal revision ${dependency.terminalRevision}, but the acknowledgement names ${claimed}.`,
                );
            }
        }
        if (byOperation.size !== wait.dependencies.length) {
            throw new StoreError(
                "stale-evidence",
                "Acknowledgement names an operation that is not a dependency of this wait generation.",
            );
        }
        for (const dependency of wait.dependencies) {
            const read = getRow(
                ctx,
                `SELECT 1 AS present FROM evidence_reads
                 WHERE wait_id = ? AND generation = ? AND operation_id = ? AND terminal_revision = ?`,
                waitId,
                generation,
                dependency.operationId,
                dependency.terminalRevision,
            );
            if (!read) {
                throw new StoreError(
                    "evidence-read-required",
                    `Operation ${dependency.operationId} revision ${dependency.terminalRevision} has not been read by this owner. Record the evidence read before acknowledging; a delivery or status read is not an interpretation.`,
                );
            }
        }
        const at = ctx.now();
        run(
            ctx,
            "UPDATE waits SET phase = 'consumed', phase_reason = ?, acknowledged_at = ?, acknowledgement_json = ?, updated_at = ? WHERE wait_id = ? AND generation = ?",
            disposition,
            at,
            JSON.stringify({ disposition, note, revisions, acknowledgedAt: at }),
            at,
            waitId,
            generation,
        );
        const acknowledgedOutboxIds = acknowledgeGenerationOutbox(ctx, waitId, generation, at);
        const releasedPinIds = releaseGenerationPins(ctx, waitId, generation, "wait-consumed", at);
        return {
            wait: requireWait(ctx, waitId, generation),
            acknowledgedOutboxIds,
            releasedPinIds,
        };
    });
}

// ---- reads --------------------------------------------------------------

export function getWait(ctx: StoreContext, ref: WaitRef): WaitRecord | null {
    const waitId = requireId("waitId", ref.waitId);
    const generation = ref.generation === undefined
        ? undefined
        : requireCounter("generation", ref.generation);
    return readWait(ctx, waitId, generation);
}

export function listWaits(ctx: StoreContext, filter: WaitFilter = {}): WaitRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.owner) {
        clauses.push("owner_kind = ? AND owner_session_id = ? AND owner_workspace = ?");
        params.push(filter.owner.kind, filter.owner.sessionId, filter.owner.workspace);
        if (filter.owner.branchId !== undefined) {
            clauses.push("coalesce(owner_branch_id, '') = ?");
            params.push(filter.owner.branchId ?? "");
        }
    }
    if (filter.phase !== undefined) {
        const phases = Array.isArray(filter.phase) ? filter.phase : [filter.phase as WaitPhase];
        for (const phase of phases) {
            if (!PHASES.includes(phase)) {
                throw new StoreError("validation", `Invalid phase: must be one of ${PHASES.join(", ")}`);
            }
        }
        clauses.push(`phase IN (${phases.map(() => "?").join(", ")})`);
        params.push(...phases);
    }
    if (filter.pendingOnly) {
        clauses.push("phase NOT IN ('consumed', 'cancelled')");
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return getRows(
        ctx,
        `SELECT * FROM waits ${where} ORDER BY created_at, wait_id, generation`,
        ...params,
    ).map((row) => mapWait(ctx, row));
}

export function listDependencies(
    ctx: StoreContext,
    ref: WaitRef,
): WaitDependencyRecord[] {
    const waitId = requireId("waitId", ref.waitId);
    const generation = ref.generation === undefined
        ? latestWaitGeneration(ctx, waitId)
        : requireCounter("generation", ref.generation);
    if (generation === null) return [];
    return dependencyState(ctx, waitId, generation).dependencies;
}

/** Latest-generation helper for callers that only know an owner. */
export function findPendingWaitForOwner(
    ctx: StoreContext,
    owner: OwnerIdentity,
): WaitRecord | null {
    const row = getRow(
        ctx,
        `SELECT * FROM waits
         WHERE owner_kind = ? AND owner_session_id = ? AND coalesce(owner_branch_id, '') = ?
           AND phase NOT IN ('consumed', 'cancelled')`,
        owner.kind,
        owner.sessionId,
        owner.branchId ?? "",
    );
    return row ? requireWait(ctx, columnText(row, "wait_id"), columnNumber(row, "generation")) : null;
}

/** Diagnostic: unresolved resume claims a replacement host must reconcile first. */
export function listUnreconciledClaims(ctx: StoreContext): ResumeClaimRecord[] {
    return getRows(
        ctx,
        "SELECT * FROM resume_claims WHERE state IN ('claimed', 'published') ORDER BY claimed_at, claim_id",
    ).map(mapClaim);
}
