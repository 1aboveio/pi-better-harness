// Generated canonical coordinator. Do not edit directly.
/**
 * The coordinator store handle.
 *
 * One `Store` is one SQLite database. Open it once per process path, hand the
 * handle to the hosting extension, and close it on extension unload. Every call is
 * synchronous and transactional; a refusal throws `StoreError` with a typed code
 * and leaves no partial record.
 */
import { StoreError } from "./errors.mjs";
import { resultSupervision, resultSupervisions, resultScopeManaged, handoffResultScope, handoffResultSupervision, handoffResultSupervisions, recoverResultSupervision, publishSupervisedResult } from "./result-supervision.mjs";
import { acceptTaskCancellation, getTaskCancellation, recordTaskStopRequested, admitTaskCancellation, authorizedTaskCancellation, finishTaskCancellation, cancellationRuntimeEpoch, acceptAuthorizedTaskCancellation, taskCancellationManaged, pendingTaskCancellations, finishTaskCancellationIntent, unknownTaskCancellation } from "./task-cancellation.mjs";
import { repairFailedResume } from "./recovery.mjs";
import { recordAssignmentOutcome, getAssignmentOutcome, inspectAssignmentOutcome, consumeAssignmentOutcome, registerAssignment, receiptAssignmentOutcome } from "./assignment-outcomes.mjs";
import { describeOwnerDiff, normalizeOwner, requireCounter, requireId, requirePath, } from "./validate.mjs";
import { ensureSchema } from "./schema.mjs";
import { createContext, openDatabase } from "./sqlite.mjs";
import { getOperation as readOperationRecord, listOperations as readOperationRecords, listRunningSupervisedBy as readRunningSupervisedBy, releaseSupervision as writeSupervisionRelease, recordSupervision as writeSupervision, recordTerminalOutcome as writeTerminalOutcome, registerOperation as writeOperation, } from "./operations.mjs";
import { getChangeRevision as readChangeRevision, readDiscoveryClaim as readClaim, releaseDiscoveryClaim as deleteDiscoveryClaim, tryClaimDiscovery as writeDiscoveryClaim, } from "./discovery.mjs";
import { acknowledgeResult as writeAcknowledgement, cancelWait as writeCancellation, claimResume as writeClaim, findPendingWaitForOwner, getWait as readWait, listDependencies as readDependencies, listEvidencePins as readPins, listEvidenceReads as readReads, listResumeClaims as readClaims, listUnreconciledClaims, listWaits as readWaits, publishResumeAttempt as writeAttemptPublication, recordEvidencePin as writePin, recordEvidenceRead as writeRead, registerWait as writeWait, releaseEvidencePins as writePinRelease, holdFailedResume as writeHoldFailedResume, releaseResumeClaim as writeClaimRelease, transitionWaitPhase as writePhase, } from "./waits.mjs";
import { claimOutbox as writeOutboxClaim, listDispatchableOutboxRecipients as readDispatchableOutboxRecipients, listOutbox as readOutbox, markOutboxDelivered as writeOutboxDelivery, releaseOutbox as writeOutboxRelease, } from "./outbox.mjs";
import { readOperationEvidence } from "./rows.mjs";
import { SCHEMA_VERSION, } from "./types.mjs";
export function openStore(options) {
    const path = requirePath("path", options.path);
    const db = openDatabase(path, { busyTimeoutMs: options.busyTimeoutMs ?? 5_000 });
    const ctx = createContext(db, options.now ? { now: options.now } : {});
    try {
        ensureSchema(ctx);
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
            if (closed)
                return;
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
            return readOperationEvidence(ctx, requireId("operationId", operationId), terminalRevision === undefined ? undefined : requireCounter("terminalRevision", terminalRevision));
        },
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
export function ownerDiff(a, b) {
    return describeOwnerDiff(a, b);
}
