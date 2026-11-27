// Generated fixed launch domain from packages/pi-better-subagents/shared-operation-coordinator/src/store.ts. Do not edit directly.
// Generated from packages/operation-coordinator/src/store.ts. Do not edit directly.
/**
 * The coordinator store handle.
 *
 * One `Store` is one SQLite database. Open it once per process path, hand the
 * handle to the hosting extension, and close it on extension unload. Every call is
 * synchronous and transactional; a refusal throws `StoreError` with a typed code
 * and leaves no partial record.
 */
import { expireWaits, overdueOperations } from "./expiry.domain.mjs";
import { setUpgradeFence } from "./upgrade.domain.mjs";
import { parentRecoveryRevision, setParentCallbackPending, listPendingParentCallbacks, listRecentBackgroundTerminals, seedPendingParentCallbacks } from "./background-parent-callbacks.domain.mjs";
import { BackgroundRequests } from "./background-requests.domain.mjs";
import { StoreError } from "./errors.domain.mjs";
import { SubagentLaunchJournal } from "./subagent-launch.domain.mjs";
import { serverAssignmentCleanup, serverAssignmentCleanupRevision, resultSupervisionChanges, resultSupervision, resultSupervisions, resultScopeManaged, handoffResultScope, handoffResultSupervision, handoffResultSupervisions, recoverResultSupervision, publishSupervisedResult } from "./result-supervision.domain.mjs";
import { acceptTaskCancellation, getTaskCancellation, recordTaskStopRequested, admitTaskCancellation, authorizedTaskCancellation, finishTaskCancellation, cancellationRuntimeEpoch, acceptAuthorizedTaskCancellation, taskCancellationManaged, pendingTaskCancellations, finishTaskCancellationIntent, unknownTaskCancellation } from "./task-cancellation.domain.mjs";
import { repairFailedResume } from "./recovery.domain.mjs";
import { recordAssignmentOutcome, getAssignmentOutcome, inspectAssignmentOutcome, consumeAssignmentOutcome, registerAssignment, receiptAssignmentOutcome } from "./assignment-outcomes.domain.mjs";
import { describeOwnerDiff, normalizeOwner, requireCounter, requireId, requirePath, } from "./validate.domain.mjs";
import { ensureSchema } from "./schema.domain.mjs";
import { ensureAssignmentChanges } from "./assignment-changes.domain.mjs";
import { createContext, openDatabase, run } from "./sqlite.domain.mjs";
import { getOperation as readOperationRecord, listAssignmentCleanupOperations as readAssignmentCleanupOperations, listOperations as readOperationRecords, listRunningSupervisedBy as readRunningSupervisedBy, releaseSupervision as writeSupervisionRelease, recordSupervision as writeSupervision, recordTerminalOutcome as writeTerminalOutcome, registerOperation as writeOperation, } from "./operations.domain.mjs";
import { getChangeRevision as readChangeRevision, readDiscoveryClaim as readClaim, readDiscoveryState, releaseDiscoveryClaim as deleteDiscoveryClaim, tryClaimDiscovery as writeDiscoveryClaim, } from "./discovery.domain.mjs";
import { acknowledgeResult as writeAcknowledgement, cancelWait as writeCancellation, claimResume as writeClaim, findPendingWaitForOwner, getWait as readWait, listDependencies as readDependencies, listEvidencePins as readPins, listEvidenceReads as readReads, listResumeClaims as readClaims, listUnreconciledClaims, listWaits as readWaits, publishResumeAttempt as writeAttemptPublication, recordEvidencePin as writePin, recordEvidenceRead as writeRead, registerWait as writeWait, releaseEvidencePins as writePinRelease, holdFailedResume as writeHoldFailedResume, releaseResumeClaim as writeClaimRelease, transitionWaitPhase as writePhase, } from "./waits.domain.mjs";
import { claimOutbox as writeOutboxClaim, hasDeliveredWaitDependency as readDeliveredWaitDependency, listDispatchableOutboxRecipients as readDispatchableOutboxRecipients, listOutbox as readOutbox, markOutboxDelivered as writeOutboxDelivery, releaseOutbox as writeOutboxRelease, } from "./outbox.domain.mjs";
import { readOperationEvidence } from "./rows.domain.mjs";
import { SCHEMA_VERSION, } from "./types.domain.mjs";
export function openStore(options) {
    const path = requirePath("path", options.path);
    const db = openDatabase(path, { busyTimeoutMs: options.busyTimeoutMs ?? 5_000 });
    const ctx = createContext(db, options.now ? { now: options.now } : {});
    try {
        ensureSchema(ctx);
        ensureAssignmentChanges(ctx);
    }
    catch (error) {
        try {
            db.close();
        }
        catch {
            // The schema refusal is the failure worth reporting.
        }
        throw error;
    }
    let closed = false;
    const alive = () => {
        if (closed) {
            throw new StoreError("closed", "This operation coordinator store was closed. Open a new handle instead of reusing it.");
        }
    };
    const store = {
        overdueOperations() { alive(); return overdueOperations(ctx); },
        expireWaits() { alive(); return expireWaits(ctx); },
        subagentLaunchJournal() { alive(); return new SubagentLaunchJournal(ctx, alive); },
        resultScopeManaged(scope) { alive(); return resultScopeManaged(ctx, scope); },
        handoffResultScope(input) { alive(); return handoffResultScope(ctx, input); },
        resultSupervision(id) { alive(); return resultSupervision(ctx, id); },
        hasSubagentManagement() { alive(); return Boolean(ctx.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='subagent_management'").get()); },
        serverAssignmentCleanupRevision() { alive(); return serverAssignmentCleanupRevision(ctx); },
        serverAssignmentCleanup(limit, after) { alive(); return serverAssignmentCleanup(ctx, limit, after); },
        resultSupervisionChanges(after) { alive(); return resultSupervisionChanges(ctx, after); },
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
            if (closed)
                return;
            closed = true;
            db.close();
        },
        parentRecoveryRevision(scope) { alive(); return parentRecoveryRevision(ctx, scope); },
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
        listAssignmentCleanupOperations(limit, afterOperationId, hostId) {
            alive();
            return readAssignmentCleanupOperations(ctx, limit, afterOperationId, hostId);
        },
        verifyAssignmentCleanup(operationId, launchToken, terminalRevision) {
            alive();
            if (!Number.isSafeInteger(terminalRevision) || terminalRevision < 1)
                return false;
            return run(ctx, `INSERT OR IGNORE INTO coordinator_state (key, value)
                SELECT 'assignment-cleanup-verified:' || op.operation_id, 'v2:' || op.launch_token
                FROM operations op JOIN assignment_attempts a ON a.attempt_id = op.assignment_attempt_id
                JOIN assignment_outcomes o ON o.assignment_id = a.assignment_id
                WHERE op.operation_id = ? AND op.launch_token = ? AND op.terminal_revision = ?`, operationId, launchToken, terminalRevision) > 0;
        },
        listRunningSupervisedBy(hostId) {
            alive();
            return readRunningSupervisedBy(ctx, hostId);
        },
        listOperationEvidence(operationId, terminalRevision) {
            alive();
            return readOperationEvidence(ctx, requireId("operationId", operationId), terminalRevision === undefined ? undefined : requireCounter("terminalRevision", terminalRevision));
        },
        readDiscoveryState(scope, hostId) { alive(); return readDiscoveryState(ctx, scope, hostId); },
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
        hasDeliveredWaitDependency(operationId, terminalRevision, recipient) {
            alive();
            return readDeliveredWaitDependency(ctx, operationId, terminalRevision, recipient);
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
export function ownerDiff(a, b) {
    return describeOwnerDiff(a, b);
}
