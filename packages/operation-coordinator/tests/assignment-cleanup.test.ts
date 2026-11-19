import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { openStore, type AssignmentOutcomeInput, type Store } from "../index.ts";
import {
    cleanupHarnesses, createHarness, expectStoreError, parentOwner, parkIntent, parkProof,
    registerOperation, removeAssignmentOperationBinding, settleOperation, workerOwner,
} from "./support.ts";

afterEach(cleanupHarnesses);

const assignment = { assignmentId: "assignment-1", owner: workerOwner, recipient: parentOwner };
const attemptId = parkIntent.attemptId;
const outcomeInput: AssignmentOutcomeInput = {
    ...assignment, revision: 1, outcome: "failed", reason: "Assignment ended", evidence: [], waits: [],
    processUncertain: true,
};

function cleanupIds(store: Store, limit = 10, afterOperationId?: string): string[] {
    return store.listAssignmentCleanupOperations(limit, afterOperationId).map(op => op.operationId);
}

test("parking and reopening without an outcome leave assignment-owned operations running", () => {
    const h = createHarness();
    h.store.registerAssignment({ ...assignment, attemptId });
    registerOperation(h.store, { assignmentAttemptId: attemptId });
    const { wait } = h.store.registerWait({ owner: workerOwner, park: parkIntent,
        origin: { assignmentRef: assignment.assignmentId, attemptId },
        dependencies: [{ operationId: "op-build-1" }], continuationNote: "Interpret the dependency" });
    h.store.transitionWaitPhase({ ...wait, from: "registering", to: "parking" });
    h.store.transitionWaitPhase({ ...wait, from: "parking", to: "waiting", proof: parkProof });
    h.reopen();
    assert.equal(h.store.getWait(wait)?.phase, "waiting");
    assert.equal(h.store.getAssignmentOutcome(assignment.assignmentId), null);
    assert.equal(h.store.getOperation("op-build-1")?.phase, "running");
    assert.deepEqual(cleanupIds(h.store), []);
});

for (const outcome of ["succeeded", "failed", "cancelled"] as const) {
    test(`a committed ${outcome} outcome creates a durable obligation until task terminal revision`, () => {
        const h = createHarness();
        h.store.registerAssignment({ ...assignment, attemptId });
        const { operation } = registerOperation(h.store, { assignmentAttemptId: attemptId });
        const priorRevision = h.store.getChangeRevision();
        h.store.recordAssignmentOutcome({ ...outcomeInput, outcome });
        assert.equal(h.store.getChangeRevision(), priorRevision + 1);
        const request = { assignmentId: assignment.assignmentId, recipient: parentOwner, revision: 1 };
        h.store.receiptAssignmentOutcome({ ...request, entryId: "delivery-1" });
        h.store.inspectAssignmentOutcome(request);
        h.store.consumeAssignmentOutcome({ ...request, disposition: "consumed", note: "Outcome read" });
        assert.deepEqual(cleanupIds(h.store), [operation.operationId]);

        const stop = { owner: workerOwner, operationId: operation.operationId, idempotencyKey: "stop-1",
            expectedLaunchToken: operation.launchToken, expectedTerminalRevision: 0, expectedHostId: "host-1",
            reason: "Assignment ended" };
        h.store.acceptTaskCancellation(stop);
        h.store.recordTaskStopRequested(stop);
        h.reopen();
        assert.deepEqual(h.store.listAssignmentCleanupOperations(1), [{ ...operation, resultManaged: false }]);
        settleOperation(h.store, operation.operationId, "cancelled");
        assert.equal(h.store.getOperation(operation.operationId)?.terminalRevision, 1);
        assert.equal(h.store.listOperationEvidence(operation.operationId).length, 2);
        h.reopen();
        assert.deepEqual(cleanupIds(h.store), []);
    });
}

test("cleanup includes exact attempts across a continuation, not linked or same-conversation work", () => {
    const { store } = createHarness();
    store.registerAssignment({ ...assignment, attemptId });
    store.registerAssignment({ ...assignment, attemptId: "continuation" });
    registerOperation(store, { operationId: "owned-a", assignmentAttemptId: attemptId });
    registerOperation(store, { operationId: "owned-b", assignmentAttemptId: "continuation" });
    registerOperation(store, { operationId: "already-terminal", assignmentAttemptId: attemptId });
    settleOperation(store, "already-terminal");
    registerOperation(store, { operationId: "legacy-same-owner" });
    registerOperation(store, { operationId: "parent-linked", owner: parentOwner });
    const { wait } = store.registerWait({ owner: workerOwner, origin: { assignmentRef: assignment.assignmentId },
        dependencies: [{ operationId: "legacy-same-owner" }, { operationId: "parent-linked", link: "explicit" }],
        continuationNote: "Interpret linked work" });
    store.recordAssignmentOutcome({ ...outcomeInput, waits: [wait] });

    store.registerAssignment({ ...assignment, assignmentId: "follow-up", attemptId: "follow-up-attempt" });
    registerOperation(store, { operationId: "new-assignment", assignmentAttemptId: "follow-up-attempt" });
    assert.deepEqual(cleanupIds(store, 1), ["owned-a"]);
    assert.deepEqual(cleanupIds(store, 1, "owned-a"), ["owned-b"]);
    assert.deepEqual(cleanupIds(store, 1, "owned-b"), []);
    assert.deepEqual(cleanupIds(store), ["owned-a", "owned-b"]);
});

test("unverified group exit survives a terminal result and restart until exact verification", () => {
    const h = createHarness();
    h.store.registerAssignment({ ...assignment, attemptId });
    const { operation } = registerOperation(h.store, { assignmentAttemptId: attemptId });
    h.store.recordAssignmentOutcome(outcomeInput);
    h.store.recordTerminalOutcome({ operationId: operation.operationId, eventId: "unproven-exit", owner: workerOwner,
        outcome: "cancelled", reason: "Runner wrote a result without proving group exit",
        evidence: [{ kind: "terminal-record", ref: "result.json", summary: "status=cancelled groupCleanup=unproven" }] });
    h.reopen();
    assert.deepEqual(cleanupIds(h.store), [operation.operationId]);
    assert.equal(h.store.verifyAssignmentCleanup(operation.operationId, "wrong-token", 1), false);
    assert.equal(h.store.verifyAssignmentCleanup(operation.operationId, operation.launchToken, 2), false);
    assert.equal(h.store.verifyAssignmentCleanup(operation.operationId, operation.launchToken, 1), true);
    h.reopen();
    assert.deepEqual(cleanupIds(h.store), []);
    assert.equal(h.store.getOperation(operation.operationId)?.terminalOutcome, "cancelled");
});

test("registration requires the exact captured owner and preserves attempt provenance on replay", () => {
    const h = createHarness();
    h.store.registerAssignment({ ...assignment, attemptId });
    h.store.registerAssignment({ ...assignment, attemptId: "continuation" });
    expectStoreError(() => registerOperation(h.store, { assignmentAttemptId: "missing-attempt" }), "foreign-owner");
    for (const owner of [parentOwner, { ...workerOwner, goalId: "another-goal" }]) {
        expectStoreError(() => registerOperation(h.store, { owner, assignmentAttemptId: attemptId }), "foreign-owner");
    }
    assert.deepEqual(h.store.listOperations(), []);
    const original = { operationId: "bound", assignmentAttemptId: attemptId };
    registerOperation(h.store, original);
    registerOperation(h.store, { operationId: "unbound" });
    expectStoreError(() => registerOperation(h.store, { operationId: "unbound", assignmentAttemptId: attemptId }),
        "operation-conflict", /assignmentAttemptId/);
    expectStoreError(() => registerOperation(h.store, { ...original, assignmentAttemptId: "continuation" }),
        "operation-conflict", /assignmentAttemptId/);
    expectStoreError(() => registerOperation(h.store, { operationId: "bound" }), "operation-conflict", /assignmentAttemptId/);

    const peer = openStore({ path: h.path });
    try {
        h.store.recordAssignmentOutcome(outcomeInput);
        assert.equal(registerOperation(peer, original).created, false);
        expectStoreError(() => registerOperation(peer, { operationId: "too-late", assignmentAttemptId: attemptId }),
            "validation", /terminal assignment/);
        assert.equal(peer.getOperation("too-late"), null);
        assert.deepEqual(cleanupIds(peer), ["bound"]);
    } finally { peer.close(); }
});

test("an outcome transaction that rolls back cannot expose cleanup work", () => {
    const h = createHarness();
    h.store.registerAssignment({ ...assignment, attemptId });
    registerOperation(h.store, { assignmentAttemptId: attemptId });
    const priorRevision = h.store.getChangeRevision();
    const db = new DatabaseSync(h.path);
    try {
        db.exec(`CREATE TRIGGER reject_assignment_outbox BEFORE INSERT ON outbox_events
          WHEN NEW.event_type = 'assignment-outcome' BEGIN SELECT RAISE(ABORT, 'injected outcome enqueue failure'); END`);
        assert.throws(() => h.store.recordAssignmentOutcome(outcomeInput), /injected outcome enqueue failure/);
        assert.equal(h.store.getAssignmentOutcome(assignment.assignmentId), null);
        assert.equal(h.store.getChangeRevision(), priorRevision);
        assert.deepEqual(cleanupIds(h.store), []);
    } finally { db.close(); }
});

test("cleanup pages cap the row count and validate limits and cursors", () => {
    const { store } = createHarness();
    store.registerAssignment({ ...assignment, attemptId });
    for (let i = 0; i < 257; i++) {
        registerOperation(store, { operationId: `op-${String(i).padStart(3, "0")}`, assignmentAttemptId: attemptId });
    }
    store.recordAssignmentOutcome(outcomeInput);
    const first = cleanupIds(store, 1000);
    assert.equal(first.length, 256);
    assert.equal(first[0], "op-000");
    assert.deepEqual(cleanupIds(store, 1000, first.at(-1)), ["op-256"]);
    expectStoreError(() => cleanupIds(store, 0), "validation", /limit/);
    expectStoreError(() => cleanupIds(store, -1), "validation", /limit/);
    expectStoreError(() => cleanupIds(store, 1, ""), "validation", /afterOperationId/);
});

test("v4 migration keeps legacy operations unbound even when their owner has a committed outcome", () => {
    const h = createHarness();
    h.store.registerAssignment({ ...assignment, attemptId });
    registerOperation(h.store);
    h.store.recordAssignmentOutcome(outcomeInput);
    h.closeStore();
    const db = new DatabaseSync(h.path);
    try {
        removeAssignmentOperationBinding(db);
        db.exec("UPDATE schema_meta SET value = '4' WHERE key = 'schema_version'");
    } finally { db.close(); }
    h.reopen();
    assert.equal(h.store.schemaVersion, 5);
    assert.equal(h.store.getAssignmentOutcome(assignment.assignmentId)?.outcome, "failed");
    assert.equal(h.store.getOperation("op-build-1")?.assignmentAttemptId, undefined);
    assert.equal(registerOperation(h.store).created, false);
    assert.deepEqual(cleanupIds(h.store), []);
    expectStoreError(() => registerOperation(h.store, { operationId: "late", assignmentAttemptId: attemptId }),
        "validation", /terminal assignment/);
});
