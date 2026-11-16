/**
 * The coordinator store handle.
 *
 * One `Store` is one SQLite database. Open it once per process path, hand the
 * handle to the hosting extension, and close it on extension unload. Every call is
 * synchronous and transactional; a refusal throws `StoreError` with a typed code
 * and leaves no partial record.
 */
import { setUpgradeFence } from "./upgrade.ts";
import { setParentCallbackPending, listPendingParentCallbacks, listRecentBackgroundTerminals, seedPendingParentCallbacks, type ParentCallbackScope, type ParentCallbackPage, type RecentBackgroundTerminalPage } from './background-parent-callbacks.ts';
import { BackgroundRequests } from "./background-requests.ts";
import { StoreError } from "./errors.ts";
import { SubagentLaunchJournal } from "./subagent-launch.ts";
import { resultSupervision, resultSupervisions, resultScopeManaged, handoffResultScope, handoffResultSupervision, handoffResultSupervisions, recoverResultSupervision, publishSupervisedResult } from "./result-supervision.ts";
import { acceptTaskCancellation, getTaskCancellation, recordTaskStopRequested, admitTaskCancellation, authorizedTaskCancellation, finishTaskCancellation, cancellationRuntimeEpoch, acceptAuthorizedTaskCancellation, taskCancellationManaged, pendingTaskCancellations, finishTaskCancellationIntent, unknownTaskCancellation } from "./task-cancellation.ts";
import type { TaskCancellationIntent, TaskCancellationRequest } from "./task-cancellation.ts";
import { repairFailedResume, type RepairResumeInput } from "./recovery.ts";
import { recordAssignmentOutcome, getAssignmentOutcome, inspectAssignmentOutcome, consumeAssignmentOutcome, registerAssignment, receiptAssignmentOutcome } from "./assignment-outcomes.ts";
import type { AssignmentOutcomeInput, AssignmentOutcomeRecord } from "./assignment-outcomes.ts";
import {
    describeOwnerDiff,
    normalizeOwner,
    requireCounter,
    requireId,
    requirePath,
} from "./validate.ts";
import { ensureSchema } from "./schema.ts";
import { ensureAssignmentChanges } from "./assignment-changes.ts";
import { createContext, openDatabase, type StoreContext } from "./sqlite.ts";
import {
    getOperation as readOperationRecord,
    listOperations as readOperationRecords,
    listRunningSupervisedBy as readRunningSupervisedBy,
    releaseSupervision as writeSupervisionRelease,
    recordSupervision as writeSupervision,
    recordTerminalOutcome as writeTerminalOutcome,
    registerOperation as writeOperation,
} from "./operations.ts";
import {
    getChangeRevision as readChangeRevision,
    readDiscoveryClaim as readClaim,
    readDiscoveryState,
    releaseDiscoveryClaim as deleteDiscoveryClaim,
    tryClaimDiscovery as writeDiscoveryClaim,
} from "./discovery.ts";
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
    listDispatchableOutboxRecipients as readDispatchableOutboxRecipients,
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
    type DiscoveryClaimRecord,
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
    type ReleaseSupervisionInput,
    type RecordSupervisionInput,
    type RecordTerminalOutcomeInput,
    type RecordTerminalOutcomeResult,
    type RegisterOperationInput,
    type RegisterOperationResult,
    type RegisterWaitInput,
    type RegisterWaitResult,
    type ReleaseDiscoveryClaimInput,
    type ReleaseOutboxInput,
    type ReleaseResumeClaimInput,
    type ReleaseResumeClaimResult,
    type ResumeClaimFilter,
    type ResumeClaimRecord,
    type ResumeClaimResult,
    type StoreOptions,
    type TransitionWaitPhaseInput,
    type TransitionWaitPhaseResult,
    type TryClaimDiscoveryInput,
    type WaitDependencyRecord,
    type WaitFilter,
    type WaitRecord,
    type WaitRef,
} from "./types.ts";

export interface Store {
    subagentLaunchJournal(): SubagentLaunchJournal;
    resultScopeManaged(scope: string): boolean;
    handoffResultScope(input: Parameters<typeof handoffResultScope>[1]): ReturnType<typeof handoffResultScope>;
    resultSupervision(operationId: string): ReturnType<typeof resultSupervision>;
    resultSupervisions(activeOnly?: boolean): ReturnType<typeof resultSupervisions>;
    handoffResultSupervision(input: Parameters<typeof handoffResultSupervision>[1]): ReturnType<typeof handoffResultSupervision>;
    handoffResultSupervisions(input: Parameters<typeof handoffResultSupervisions>[1]): ReturnType<typeof handoffResultSupervisions>;
    recoverResultSupervision(input: Parameters<typeof recoverResultSupervision>[1]): void;
    publishSupervisedResult(input: Parameters<typeof publishSupervisedResult>[1]): ReturnType<typeof publishSupervisedResult>;
    unknownTaskCancellation(input: TaskCancellationRequest): TaskCancellationIntent;
    taskCancellationManaged(operationId: string): boolean;
    pendingTaskCancellations(): ReturnType<typeof pendingTaskCancellations>;
    finishTaskCancellationIntent(input: Parameters<typeof finishTaskCancellationIntent>[1]): TaskCancellationIntent;
    cancellationRuntimeEpoch(instanceId?: string): number;
    acceptAuthorizedTaskCancellation(input: { credential: string; runtimeEpoch: number }): TaskCancellationIntent;
    admitTaskCancellation(input: Parameters<typeof admitTaskCancellation>[1]): void;
    authorizedTaskCancellation(credential: string): ReturnType<typeof authorizedTaskCancellation>;
    finishTaskCancellation(input: Parameters<typeof finishTaskCancellation>[1]): TaskCancellationIntent;
    acceptTaskCancellation(input: TaskCancellationRequest): TaskCancellationIntent;
    getTaskCancellation(input: { owner: OwnerIdentity; idempotencyKey: string }): TaskCancellationIntent | null;
    recordTaskStopRequested(input: TaskCancellationRequest): TaskCancellationIntent;
    registerAssignment(input: Parameters<typeof registerAssignment>[1]): void;
    receiptAssignmentOutcome(input: Parameters<typeof receiptAssignmentOutcome>[1]): AssignmentOutcomeRecord;
    recordAssignmentOutcome(input: AssignmentOutcomeInput): AssignmentOutcomeRecord;
    getAssignmentOutcome(assignmentId: string): AssignmentOutcomeRecord | null;
    inspectAssignmentOutcome(input: Parameters<typeof inspectAssignmentOutcome>[1]): AssignmentOutcomeRecord;
    consumeAssignmentOutcome(input: Parameters<typeof consumeAssignmentOutcome>[1]): AssignmentOutcomeRecord;
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
    backgroundRequests(): BackgroundRequests;
    setParentCallbackPending(taskId: string, pending: boolean): boolean;
    listPendingParentCallbacks(scope: ParentCallbackScope, options?: ParentCallbackPage): OperationRecord[];
    listRecentBackgroundTerminals(options: RecentBackgroundTerminalPage): OperationRecord[];
    seedPendingParentCallbacks(options?: { limit?: number }): { done: boolean; seeded: number };
    setUpgradeFence(epoch: string | null): void;
    registerOperation(input: RegisterOperationInput): RegisterOperationResult;
    /**
     * Replace supervision identity and/or report observer health
     * (`active`/`unmonitored`/`lost`). Ownership stays untouched. A supervision
     * replacement requires `expectedHostId` and is refused with
     * `supervision-conflict` when another host took over first.
     */
    recordSupervision(input: RecordSupervisionInput): OperationRecord;
    /**
     * Clear a closed host's supervision authority when the recorded host still
     * matches. A newer holder is left untouched, and a terminal operation keeps
     * its final supervision record. Returns `null` when another host already took
     * over.
     */
    releaseSupervision(input: ReleaseSupervisionInput): OperationRecord | null;
    /**
     * Record the single terminal revision of an operation and settle every wait
     * that depends on it. Replaying the same event id is idempotent; a different
     * terminal event is refused. Outbox rows are persisted in the same
     * transaction, before anything can be delivered.
     */
    recordTerminalOutcome(input: RecordTerminalOutcomeInput): RecordTerminalOutcomeResult;
    getOperation(operationId: string): OperationRecord | null;
    listOperations(filter?: OperationFilter): OperationRecord[];
    /** Running operations currently assigned to this supervising host. */
    listRunningSupervisedBy(hostId: string): OperationRecord[];
    listOperationEvidence(operationId: string, terminalRevision?: number): OperationEvidenceRecord[];

    // ---- discovery coordination ----

    /** The shared discovery leader for this store/supervisor scope, if recorded. */
    readDiscoveryClaim(scope: string): DiscoveryClaimRecord | null;
    readDiscoveryState(scope: string): ReturnType<typeof readDiscoveryState>;
    /**
     * Compare-and-swap a discovery claim. The caller must name the exact claim it
     * observed, or null for none; a stale contender receives null and must not
     * start a global scan.
     */
    tryClaimDiscovery(input: TryClaimDiscoveryInput): DiscoveryClaimRecord | null;
    /** Delete only this exact host/token claim; a successor is never released. */
    releaseDiscoveryClaim(input: ReleaseDiscoveryClaimInput): boolean;
    /** Monotonic revision for registration, authority changes and terminal publication. */
    getChangeRevision(): number;

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
    repairFailedResume(input: RepairResumeInput): { phase: string; repaired: boolean };
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
    /** Lightweight dispatch candidates; evidence is read only after a claim succeeds. */
    listDispatchableOutboxRecipients(): Array<{ recipient: OwnerIdentity; count: number }>;
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
        ensureAssignmentChanges(ctx);
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
        subagentLaunchJournal() { alive(); return new SubagentLaunchJournal(ctx, alive); },
        resultScopeManaged(scope) { alive(); return resultScopeManaged(ctx, scope); },
        handoffResultScope(input) { alive(); return handoffResultScope(ctx, input); },
        resultSupervision(id) { alive(); return resultSupervision(ctx, id); },
        resultSupervisions(activeOnly) { alive(); return resultSupervisions(ctx, activeOnly); },
        handoffResultSupervision(input) { alive(); return handoffResultSupervision(ctx, input); },
        handoffResultSupervisions(input) { alive(); return handoffResultSupervisions(ctx, input); },
        recoverResultSupervision(input) { alive(); recoverResultSupervision(ctx, input); },
        publishSupervisedResult(input) { alive(); return publishSupervisedResult(ctx, input); },
        unknownTaskCancellation(input) { alive(); return unknownTaskCancellation(ctx, input); },
        taskCancellationManaged(operationId) { alive(); return taskCancellationManaged(ctx, operationId); },
        pendingTaskCancellations() { alive(); return pendingTaskCancellations(ctx); },
        finishTaskCancellationIntent(input) { alive(); return finishTaskCancellationIntent(ctx, input); },
        cancellationRuntimeEpoch(instanceId) { alive(); return cancellationRuntimeEpoch(ctx, instanceId); },
        acceptAuthorizedTaskCancellation(input) { alive(); return acceptAuthorizedTaskCancellation(ctx, input); },
        admitTaskCancellation(input) { alive(); admitTaskCancellation(ctx, input); },
        authorizedTaskCancellation(credential) { alive(); return authorizedTaskCancellation(ctx, credential); },
        finishTaskCancellation(input) { alive(); return finishTaskCancellation(ctx, input); },
        registerAssignment(input) { alive(); registerAssignment(ctx, input); },
        receiptAssignmentOutcome(input) { alive(); return receiptAssignmentOutcome(ctx, input); },
        recordAssignmentOutcome(input) { alive(); return recordAssignmentOutcome(ctx, input); },
        getAssignmentOutcome(assignmentId) { alive(); return getAssignmentOutcome(ctx, assignmentId); },
        inspectAssignmentOutcome(input) { alive(); return inspectAssignmentOutcome(ctx, input); },
        consumeAssignmentOutcome(input) { alive(); return consumeAssignmentOutcome(ctx, input); },
        schemaVersion: SCHEMA_VERSION,
        path,
        close() {
            if (closed) return;
            closed = true;
            db.close();
        },
        setParentCallbackPending(taskId, pending) { alive(); return setParentCallbackPending(ctx, taskId, pending); },
        listPendingParentCallbacks(scope, options) { alive(); return listPendingParentCallbacks(ctx, scope, options); },
        listRecentBackgroundTerminals(options) { alive(); return listRecentBackgroundTerminals(ctx, options); },
        seedPendingParentCallbacks(options) { alive(); return seedPendingParentCallbacks(ctx, options); },
        backgroundRequests() { alive(); return new BackgroundRequests(ctx, alive); },
        setUpgradeFence(epoch) { alive(); setUpgradeFence(ctx, epoch); },
        registerOperation(input) {
            alive();
            return writeOperation(ctx, input);
        },
        recordSupervision(input) {
            alive();
            return writeSupervision(ctx, input);
        },
        releaseSupervision(input) {
            alive();
            return writeSupervisionRelease(ctx, input);
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
        listRunningSupervisedBy(hostId) {
            alive();
            return readRunningSupervisedBy(ctx, hostId);
        },
        listOperationEvidence(operationId, terminalRevision) {
            alive();
            return readOperationEvidence(
                ctx,
                requireId("operationId", operationId),
                terminalRevision === undefined ? undefined : requireCounter("terminalRevision", terminalRevision),
            );
        },
        readDiscoveryState(scope) { alive(); return readDiscoveryState(ctx, scope); },
        readDiscoveryClaim(scope) {
            alive();
            return readClaim(ctx, scope);
        },
        tryClaimDiscovery(input) {
            alive();
            return writeDiscoveryClaim(ctx, input);
        },
        releaseDiscoveryClaim(input) {
            alive();
            return deleteDiscoveryClaim(ctx, input);
        },
        getChangeRevision() {
            alive();
            return readChangeRevision(ctx);
        },
        registerWait(input) {
            alive();
            return writeWait(ctx, input);
        },
        acceptTaskCancellation(input) {
            alive();
            return acceptTaskCancellation(ctx, input);
        },
        getTaskCancellation(input) {
            alive();
            return getTaskCancellation(ctx, input);
        },
        recordTaskStopRequested(input) {
            alive();
            return recordTaskStopRequested(ctx, input);
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
        repairFailedResume(input) {
            alive();
            return repairFailedResume(ctx, input);
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
        listDispatchableOutboxRecipients() {
            alive();
            return readDispatchableOutboxRecipients(ctx);
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
