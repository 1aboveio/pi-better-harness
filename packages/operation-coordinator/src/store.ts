/**
 * The coordinator store handle.
 *
 * One `Store` is one SQLite database. Open it once per process path, hand the
 * handle to the hosting extension, and close it on extension unload. Every call is
 * synchronous and transactional; a refusal throws `StoreError` with a typed code
 * and leaves no partial record.
 */
import { StoreError } from "./errors.ts";
import {
    describeOwnerDiff,
    normalizeOwner,
    requireCounter,
    requireId,
    requirePath,
} from "./validate.ts";
import { ensureSchema } from "./schema.ts";
import { createContext, openDatabase, type StoreContext } from "./sqlite.ts";
import {
    getOperation as readOperationRecord,
    listOperations as readOperationRecords,
    recordSupervision as writeSupervision,
    recordTerminalOutcome as writeTerminalOutcome,
    registerOperation as writeOperation,
} from "./operations.ts";
import {
    acknowledgeResult as writeAcknowledgement,
    cancelWait as writeCancellation,
    claimResume as writeClaim,
    findPendingWaitForOwner,
    getWait as readWait,
    listDependencies as readDependencies,
    listEvidencePins as readPins,
    listEvidenceReads as readReads,
    listResumeClaims as readClaims,
    listUnreconciledClaims,
    listWaits as readWaits,
    publishResumeAttempt as writeAttemptPublication,
    recordEvidencePin as writePin,
    recordEvidenceRead as writeRead,
    registerWait as writeWait,
    releaseEvidencePins as writePinRelease,
    holdFailedResume as writeHoldFailedResume,
    releaseResumeClaim as writeClaimRelease,
    transitionWaitPhase as writePhase,
} from "./waits.ts";
import {
    claimOutbox as writeOutboxClaim,
    listOutbox as readOutbox,
    markOutboxDelivered as writeOutboxDelivery,
    releaseOutbox as writeOutboxRelease,
} from "./outbox.ts";
import { readOperationEvidence } from "./rows.ts";
import {
    SCHEMA_VERSION,
    type AcknowledgeResultInput,
    type AcknowledgeResultOutput,
    type CancelWaitInput,
    type CancelWaitResult,
    type ClaimOutboxInput,
    type ClaimResumeInput,
    type EvidencePinRecord,
    type EvidenceReadRecord,
    type HoldFailedResumeInput,
    type HoldFailedResumeResult,
    type OperationEvidenceRecord,
    type OperationFilter,
    type OperationRecord,
    type OutboxDispatchInput,
    type OutboxEventRecord,
    type OutboxFilter,
    type OwnerIdentity,
    type PublishResumeAttemptInput,
    type PublishResumeAttemptResult,
    type RecordEvidencePinInput,
    type RecordEvidencePinResult,
    type RecordEvidenceReadInput,
    type RecordEvidenceReadResult,
    type RecordSupervisionInput,
    type RecordTerminalOutcomeInput,
    type RecordTerminalOutcomeResult,
    type RegisterOperationInput,
    type RegisterOperationResult,
    type RegisterWaitInput,
    type RegisterWaitResult,
    type ReleaseOutboxInput,
    type ReleaseResumeClaimInput,
    type ReleaseResumeClaimResult,
    type ResumeClaimFilter,
    type ResumeClaimRecord,
    type ResumeClaimResult,
    type StoreOptions,
    type TransitionWaitPhaseInput,
    type TransitionWaitPhaseResult,
    type WaitDependencyRecord,
    type WaitFilter,
    type WaitRecord,
    type WaitRef,
} from "./types.ts";

export interface Store {
    /** Schema version this handle verified on open. */
    readonly schemaVersion: number;
    /** Database path this handle opened. */
    readonly path: string;
    /** Release the database handle. Subsequent calls are refused. */
    close(): void;

    // ---- operations ----

    /**
     * Register a durable operation for one task launch. The owner, task id,
     * launch token and observer are immutable: a replay of the same launch
     * returns `created: false`, and any difference is refused with
     * `operation-conflict` or `task-ownership`.
     */
    registerOperation(input: RegisterOperationInput): RegisterOperationResult;
    /**
     * Replace supervision identity and/or report observer health
     * (`active`/`unmonitored`/`lost`). Ownership stays untouched.
     */
    recordSupervision(input: RecordSupervisionInput): OperationRecord;
    /**
     * Record the single terminal revision of an operation and settle every wait
     * that depends on it. Replaying the same event id is idempotent; a different
     * terminal event is refused. Outbox rows are persisted in the same
     * transaction, before anything can be delivered.
     */
    recordTerminalOutcome(input: RecordTerminalOutcomeInput): RecordTerminalOutcomeResult;
    getOperation(operationId: string): OperationRecord | null;
    listOperations(filter?: OperationFilter): OperationRecord[];
    listOperationEvidence(operationId: string, terminalRevision?: number): OperationEvidenceRecord[];

    // ---- waits ----

    /**
     * Register an all-settled wait generation. The dependency's current terminal
     * revision is read in this transaction, so a task that finished before
     * registration is not missed: the generation starts `ready` and its delivery
     * is enqueued immediately. A second pending generation for the same owner
     * identity is refused.
     */
    registerWait(input: RegisterWaitInput): RegisterWaitResult;
    /**
     * Move a generation between `registering`, `parking`, `waiting`, `ready` and
     * `held`. `consumed`/`cancelled` use their own calls and `resuming` belongs to
     * a resume claim. A parked worker needs checkpoint and writer-exit proof to
     * leave `parking`.
     */
    transitionWaitPhase(input: TransitionWaitPhaseInput): TransitionWaitPhaseResult;
    /**
     * Cancel a generation: increments the cancellation epoch, invalidates the
     * active resume claim, voids unconsumed deliveries and releases evidence pins.
     */
    cancelWait(input: CancelWaitInput): CancelWaitResult;
    getWait(ref: WaitRef): WaitRecord | null;
    listWaits(filter?: WaitFilter): WaitRecord[];
    listDependencies(ref: WaitRef): WaitDependencyRecord[];
    /** The owner's single pending generation, if any. */
    findPendingWait(owner: OwnerIdentity): WaitRecord | null;

    // ---- resume claims ----

    /**
     * Claim a ready generation for continuation. Exactly one claim may be active
     * per generation; the claim carries the unique token and cancellation epoch
     * that later steps are fenced against.
     */
    claimResume(input: ClaimResumeInput): ResumeClaimResult;
    /**
     * Persist the chosen attempt id and launch token before spawn. Publishing is
     * once per claim; an identical replay is idempotent, a different attempt is
     * refused, and a cancellation after the claim invalidates it.
     */
    publishResumeAttempt(input: PublishResumeAttemptInput): PublishResumeAttemptResult;
    /**
     * Release an unpublished claim: `ready` when admission failed before spawn,
     * `held` when the outcome is uncertain. A published claim cannot be released.
     */
    releaseResumeClaim(input: ReleaseResumeClaimInput): ReleaseResumeClaimResult;
    /**
     * Hold a published generation whose attempt exited WITHOUT interpreting it.
     * The failure is not a cancellation: the cancellation epoch is preserved, the
     * evidence pins are retained, and the claim is invalidated so no second attempt
     * can be published. Requires exact claim identity (generation, claim id/token,
     * attempt id, launch token) and proven writer exit plus a released writer lease.
     * Replaying the same call is idempotent; consumed or cancelled generations are
     * refused untouched.
     */
    holdFailedResume(input: HoldFailedResumeInput): HoldFailedResumeResult;
    listResumeClaims(filter?: ResumeClaimFilter): ResumeClaimRecord[];
    /** Active claims a replacement host must reconcile before admitting resumes. */
    listUnreconciledClaims(): ResumeClaimRecord[];

    // ---- evidence ----

    /**
     * Record that the owner read one dependency's exact terminal revision.
     * Repeating the same read is idempotent; a different revision is refused.
     */
    recordEvidenceRead(input: RecordEvidenceReadInput): RecordEvidenceReadResult;
    listEvidenceReads(ref: WaitRef): EvidenceReadRecord[];
    /**
     * Pin a retained evidence reference for an unconsumed generation. Delivery
     * pins terminal evidence automatically; this adds bounded summaries or
     * retained log artifacts that must outlive ordinary task-log cleanup.
     */
    recordEvidencePin(input: RecordEvidencePinInput): RecordEvidencePinResult;
    listEvidencePins(ref: WaitRef, options?: { includeReleased?: boolean }): EvidencePinRecord[];
    /** Explicit dismissal: release pins without consuming the generation. */
    releaseEvidencePins(ref: WaitRef & { generation: number }, reason: string): string[];

    // ---- interpretation ----

    /**
     * Record the owner's interpretation of the exact terminal revisions and consume
     * the generation. Requires a recorded evidence read by the same owner and a
     * persisted note; acking twice, acking a foreign generation or acking stale
     * revisions is refused.
     */
    acknowledgeResult(input: AcknowledgeResultInput): AcknowledgeResultOutput;

    // ---- outbox ----

    listOutbox(filter?: OutboxFilter): OutboxEventRecord[];
    /** Claim pending deliveries for a `ready`/`resuming` generation. */
    claimOutbox(input: ClaimOutboxInput): OutboxEventRecord[];
    /** Mark a claimed delivery delivered; the result is still unconsumed. */
    markOutboxDelivered(input: OutboxDispatchInput): OutboxEventRecord;
    /** Return a claimed delivery to the queue with a retained recovery reason. */
    releaseOutbox(input: ReleaseOutboxInput): OutboxEventRecord;
}

export type { OperationFilter };

export function openStore(options: StoreOptions): Store {
    const path = requirePath("path", options.path);
    const db = openDatabase(path, { busyTimeoutMs: options.busyTimeoutMs ?? 5_000 });
    const ctx: StoreContext = createContext(db, options.now ? { now: options.now } : {});
    try {
        ensureSchema(ctx);
    } catch (error) {
        try {
            db.close();
        } catch {
            // The schema refusal is the failure worth reporting.
        }
        throw error;
    }

    let closed = false;
    const alive = (): void => {
        if (closed) {
            throw new StoreError(
                "closed",
                "This operation coordinator store was closed. Open a new handle instead of reusing it.",
            );
        }
    };

    const store: Store = {
        schemaVersion: SCHEMA_VERSION,
        path,
        close() {
            if (closed) return;
            closed = true;
            db.close();
        },
        registerOperation(input) {
            alive();
            return writeOperation(ctx, input);
        },
        recordSupervision(input) {
            alive();
            return writeSupervision(ctx, input);
        },
        recordTerminalOutcome(input) {
            alive();
            return writeTerminalOutcome(ctx, input);
        },
        getOperation(operationId) {
            alive();
            return readOperationRecord(ctx, requireId("operationId", operationId));
        },
        listOperations(filter = {}) {
            alive();
            return readOperationRecords(ctx, filter);
        },
        listOperationEvidence(operationId, terminalRevision) {
            alive();
            return readOperationEvidence(
                ctx,
                requireId("operationId", operationId),
                terminalRevision === undefined ? undefined : requireCounter("terminalRevision", terminalRevision),
            );
        },
        registerWait(input) {
            alive();
            return writeWait(ctx, input);
        },
        transitionWaitPhase(input) {
            alive();
            return writePhase(ctx, input);
        },
        cancelWait(input) {
            alive();
            return writeCancellation(ctx, input);
        },
        getWait(ref) {
            alive();
            return readWait(ctx, ref);
        },
        listWaits(filter = {}) {
            alive();
            return readWaits(ctx, filter);
        },
        listDependencies(ref) {
            alive();
            return readDependencies(ctx, ref);
        },
        findPendingWait(owner) {
            alive();
            return findPendingWaitForOwner(ctx, normalizeOwner("owner", owner));
        },
        claimResume(input) {
            alive();
            return writeClaim(ctx, input);
        },
        publishResumeAttempt(input) {
            alive();
            return writeAttemptPublication(ctx, input);
        },
        releaseResumeClaim(input) {
            alive();
            return writeClaimRelease(ctx, input);
        },
        holdFailedResume(input) {
            alive();
            return writeHoldFailedResume(ctx, input);
        },
        listResumeClaims(filter = {}) {
            alive();
            return readClaims(ctx, filter);
        },
        listUnreconciledClaims() {
            alive();
            return listUnreconciledClaims(ctx);
        },
        recordEvidenceRead(input) {
            alive();
            return writeRead(ctx, input);
        },
        listEvidenceReads(ref) {
            alive();
            return readReads(ctx, ref);
        },
        recordEvidencePin(input) {
            alive();
            return writePin(ctx, input);
        },
        listEvidencePins(ref, options) {
            alive();
            return readPins(ctx, ref, options);
        },
        releaseEvidencePins(ref, reason) {
            alive();
            return writePinRelease(ctx, ref, reason);
        },
        acknowledgeResult(input) {
            alive();
            return writeAcknowledgement(ctx, input);
        },
        listOutbox(filter = {}) {
            alive();
            return readOutbox(ctx, filter);
        },
        claimOutbox(input) {
            alive();
            return writeOutboxClaim(ctx, input);
        },
        markOutboxDelivered(input) {
            alive();
            return writeOutboxDelivery(ctx, input);
        },
        releaseOutbox(input) {
            alive();
            return writeOutboxRelease(ctx, input);
        },
    };
    return store;
}

/** Identity helper re-exported for callers that compare recorded owners. */
export function ownerDiff(a: OwnerIdentity, b: OwnerIdentity): string {
    return describeOwnerDiff(a, b);
}
