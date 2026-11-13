import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createHarness, cleanupHarnesses, registerOperation, parentOwner, workerOwner } from "./support.ts";
import type { AssignmentOutcomeInput } from "../index.ts";
import { DatabaseSync } from "node:sqlite";

afterEach(cleanupHarnesses);

function fixture() {
    const h = createHarness();
    registerOperation(h.store);
    h.store.recordTerminalOutcome({ operationId: "op-build-1", eventId: "command-failure", owner: workerOwner, outcome: "failed", reason: "Tests failed", evidence: [{ kind: "log", ref: "/workspace/harness/build.log", summary: "Assertion failed" }] });
    const { wait } = h.store.registerWait({ owner: workerOwner, dependencies: [{ operationId: "op-build-1" }], continuationNote: "Interpret tests", origin: { assignmentRef: "assignment-1" } });
    const claim = h.store.claimResume({ waitId: wait.waitId, generation: wait.generation, expectedCancelEpoch: 0, lease: { ownerId: "host-1" }, reservedCheckpointId: "checkpoint-1" }).claim;
    h.store.publishResumeAttempt({ waitId: wait.waitId, generation: wait.generation, claimId: claim.claimId, claimToken: claim.claimToken, attemptId: "attempt-2", launchToken: "launch-2" });
    const input: AssignmentOutcomeInput = { assignmentId: "assignment-1", owner: workerOwner, recipient: parentOwner, revision: 1, outcome: "failed", reason: "Cannot finish within scope", evidence: [{ kind: "summary", ref: "report-1", summary: "Completed diagnosis" }], waits: [{ waitId: wait.waitId, generation: 1, cancelEpoch: 0 }], processUncertain: true };
    h.store.registerAssignment(input);
    return { h, wait, claim, input };
}

test("terminal failure atomically disarms dispatch, transfers pins, and preserves unresolved facts and writer fences", () => {
    const { h, wait, claim, input } = fixture();
    const outcome = h.store.recordAssignmentOutcome(input);
    assert.deepEqual(h.store.listDispatchableOutboxRecipients(), [], "assignment outcomes are delivered through their own path");
    assert.equal(h.store.getWait(wait)?.phase, "held");
    assert.equal(h.store.getWait(wait)?.acknowledgement, null);
    assert.equal(h.store.getWait(wait)?.cancelEpoch, 0);
    assert.equal(h.store.listResumeClaims()[0].state, "published");
    assert.deepEqual(h.store.listResumeClaims()[0].lease, claim.lease);
    assert.equal(h.store.listEvidencePins(wait).length, 0);
    assert.throws(() => h.store.recordEvidencePin({ waitId: wait.waitId, generation: wait.generation, operationId: "op-build-1", terminalRevision: 1, kind: "log", ref: "duplicate.log" }), /terminal outcome/);
    assert.throws(() => h.store.registerAssignment({ ...input, attemptId: "conflicting-new-attempt" }), /terminal assignment/);
    assert.equal(h.store.listEvidencePins({ waitId: outcome.eventId, generation: 1 }).length, 2);
    assert.throws(() => h.store.transitionWaitPhase({ ...wait, from: "held", to: "ready" }), /terminal outcome/);
    assert.throws(() => h.store.publishResumeAttempt({ ...wait, claimId: claim.claimId, claimToken: claim.claimToken, attemptId: "attempt-2", launchToken: "launch-2" }), /terminal outcome/);
    assert.equal(h.store.claimOutbox({ type: "dependency-ready", claimToken: "dependencies", claimedBy: "host-2" }).length, 0);
    const events = h.store.claimOutbox({ type: "assignment-outcome", recipient: parentOwner, claimToken: "parent-delivery", claimedBy: "host-2" });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "assignment-outcome");
    assert.equal(events[0].eventId, outcome.eventId);
});

test("decision replay survives reload and cannot rewrite terminal truth", () => {
    const { h, input } = fixture();
    const outcome = h.store.recordAssignmentOutcome(input);
    h.reopen();
    assert.deepEqual(h.store.recordAssignmentOutcome(input), outcome);
    assert.equal(h.store.listOutbox().filter((e) => e.type === "assignment-outcome").length, 1);
    assert.throws(() => h.store.recordAssignmentOutcome({ ...input, outcome: "succeeded" }), /cannot be rewritten/);
});

test("stale epoch and missing wait refuse the whole transaction", () => {
    const { h, input, wait } = fixture();
    assert.throws(() => h.store.recordAssignmentOutcome({ ...input, waits: [{ ...input.waits[0], cancelEpoch: 1 }] }), /epoch/);
    assert.throws(() => h.store.recordAssignmentOutcome({ ...input, waits: [] }), /omitted/);
    assert.equal(h.store.getAssignmentOutcome(input.assignmentId), null);
    assert.equal(h.store.getWait(wait)?.phase, "resuming");
    assert.equal(h.store.listEvidencePins(wait).length, 1);
});

test("delivery and inspection do not consume an outcome; exact parent disposition releases only outcome pins", () => {
    const { h, wait, input } = fixture();
    const record = h.store.recordAssignmentOutcome(input);
    const request = { assignmentId: input.assignmentId, recipient: parentOwner, revision: 1 };
    h.store.claimOutbox({ type: "assignment-outcome", claimToken: "delivery", claimedBy: "host-2" });
    h.store.markOutboxDelivered({ eventId: record.eventId, claimToken: "delivery" });
    const ref = { waitId: record.eventId, generation: 1 };
    assert.equal(h.store.listEvidencePins(ref).length, 2);
    assert.throws(() => h.store.consumeAssignmentOutcome({ ...request, disposition: "consumed", note: "Read it" }), /Inspect/);
    assert.throws(() => h.store.inspectAssignmentOutcome({ ...request, revision: 2 }), /revision/);
    assert.throws(() => h.store.inspectAssignmentOutcome({ ...request, recipient: { ...parentOwner, sessionId: "unrelated" } }), /different parent/);
    h.store.inspectAssignmentOutcome(request);
    assert.equal(h.store.listEvidencePins(ref).length, 2);
    h.reopen();
    const disposition = { ...request, disposition: "consumed" as const, note: "Diagnosis inspected; delegate follow-up separately" };
    h.store.consumeAssignmentOutcome(disposition);
    assert.equal(h.store.consumeAssignmentOutcome(disposition).disposition?.kind, "consumed");
    assert.equal(h.store.listEvidencePins(ref).length, 0);
    assert.equal(h.store.getWait(wait)?.acknowledgement, null);
    assert.equal(h.store.listResumeClaims()[0].state, "published");
});

test("success cannot hide an unresolved interpretation", () => {
    const { h, input } = fixture();
    assert.throws(() => h.store.recordAssignmentOutcome({ ...input, outcome: "succeeded" }), /interpretation/);
    assert.equal(h.store.getAssignmentOutcome(input.assignmentId), null);
});

test("captured recipient is immutable and delivery reconciliation is independent of interpretation", () => {
    const { h, input } = fixture();
    const recipient = { ...parentOwner, branchId: "unrelated" };
    assert.throws(() => h.store.registerAssignment({ ...input, recipient }), /immutable/);
    assert.throws(() => h.store.recordAssignmentOutcome({ ...input, recipient }), /captured/);
    const outcome = h.store.recordAssignmentOutcome(input);
    const receipt = { assignmentId: input.assignmentId, recipient: parentOwner, revision: 1, entryId: "transcript-entry-1" };
    h.store.receiptAssignmentOutcome(receipt);
    h.reopen();
    assert.equal(h.store.receiptAssignmentOutcome(receipt).deliveryReceipt?.entryId, receipt.entryId);
    assert.equal(h.store.getAssignmentOutcome(input.assignmentId)?.inspectedAt, null);
    assert.equal(h.store.listEvidencePins({ waitId: outcome.eventId, generation: 1 }).length, 2);
    assert.equal(h.store.claimOutbox({ type: "assignment-outcome", claimToken: "replay", claimedBy: "reload" }).length, 0);
});

test("version 1 migrates without losing dependency evidence or published writer claims", () => {
    const { h, input } = fixture();
    h.closeStore();
    const db = new DatabaseSync(h.path);
    db.exec("DROP TABLE assignment_outcome_waits; DROP TABLE assignment_outcomes; DROP TABLE assignment_attempts; DROP TABLE assignment_bindings; ALTER TABLE outbox_events DROP COLUMN event_type; DROP INDEX waits_one_pending_per_owner; ALTER TABLE waits DROP COLUMN dispatch_disarmed; CREATE UNIQUE INDEX waits_one_pending_per_owner ON waits (owner_kind, owner_session_id, coalesce(owner_branch_id, '')) WHERE phase NOT IN ('consumed', 'cancelled'); UPDATE schema_meta SET value = '1' WHERE key = 'schema_version'");
    db.close();
    h.reopen();
    assert.equal(h.store.schemaVersion, 4);
    assert.equal(h.store.listResumeClaims()[0].state, "published");
    h.store.registerAssignment(input);
    assert.equal(h.store.recordAssignmentOutcome(input).outcome, "failed");
});

test("an insertion failure rolls back the decision, dispatch disarming and pin transfer together", () => {
    const { h, input, wait } = fixture();
    const db = new DatabaseSync(h.path);
    db.exec("CREATE TRIGGER reject_assignment_outbox BEFORE INSERT ON outbox_events WHEN NEW.event_type = 'assignment-outcome' BEGIN SELECT RAISE(ABORT, 'injected outcome enqueue failure'); END");
    db.close();
    assert.throws(() => h.store.recordAssignmentOutcome(input), /injected outcome enqueue failure/);
    assert.equal(h.store.getAssignmentOutcome(input.assignmentId), null);
    assert.equal(h.store.getWait(wait)?.phase, "resuming");
    assert.equal(h.store.listEvidencePins(wait).length, 1);
    assert.equal(h.store.listOutbox()[0].state, "pending");
});

test("terminal wait leaves room for a new assignment without authorizing a conflicting writer", () => {
    const { h, input, wait, claim } = fixture();
    h.store.recordAssignmentOutcome(input);
    const follow = h.store.registerWait({ owner: workerOwner, dependencies: [{ operationId: "op-build-1" }], continuationNote: "A new assignment", origin: { assignmentRef: "follow-up" } }).wait;
    const request = { waitId: follow.waitId, generation: follow.generation, expectedCancelEpoch: 0, lease: { ownerId: "new-host" }, reservedCheckpointId: "follow-up-checkpoint" };
    assert.throws(() => h.store.claimResume(request), /prior published conversation writer/);
    h.store.holdFailedResume({ waitId: wait.waitId, generation: wait.generation, claimId: claim.claimId, claimToken: claim.claimToken, attemptId: "attempt-2", launchToken: "launch-2", proof: { writerPidGone: true, writerLeaseReleased: true }, reason: "Independent exit proof" });
    assert.equal(h.store.getWait(wait)?.acknowledgement, null);
    assert.equal(h.store.claimResume(request).claim.state, "claimed");
});

test("late dependency evidence belongs to the terminal outcome, not a new worker dispatch", () => {
    const h = createHarness();
    registerOperation(h.store);
    const { wait } = h.store.registerWait({ owner: workerOwner, dependencies: [{ operationId: "op-build-1" }], continuationNote: "Interpret", origin: { assignmentRef: "late-assignment" } });
    const input: AssignmentOutcomeInput = { assignmentId: "late-assignment", owner: workerOwner, recipient: parentOwner, revision: 1, outcome: "failed", reason: "Scope exhausted", evidence: [], waits: [{ waitId: wait.waitId, generation: 1, cancelEpoch: 0 }], processUncertain: true };
    h.store.registerAssignment(input);
    const outcome = h.store.recordAssignmentOutcome(input);
    h.store.inspectAssignmentOutcome({ assignmentId: input.assignmentId, recipient: parentOwner, revision: 1 });
    h.store.recordTerminalOutcome({ operationId: "op-build-1", owner: workerOwner, eventId: "late-terminal", outcome: "failed", evidence: [{ kind: "log", ref: "late.log" }], reason: "Failed tests" });
    const pins = h.store.listEvidencePins({ waitId: outcome.eventId, generation: 1 });
    assert.equal(pins[0].operationId, "op-build-1");
    assert.equal(h.store.getWait(wait)?.phase, "held");
    assert.equal(h.store.getWait(wait)?.acknowledgement, null);
    assert.equal(h.store.listEvidencePins(wait).length, 0);
    assert.equal(h.store.listOutbox().length, 1);
    assert.equal(h.store.getAssignmentOutcome(input.assignmentId)?.inspectedAt, null);
    assert.throws(() => h.store.consumeAssignmentOutcome({ assignmentId: input.assignmentId, recipient: parentOwner, revision: 1, disposition: "consumed", note: "A stale inspection cannot release newly retained evidence" }), /Inspect/);
});

test("version 2 outcome migration preserves receipts and disarms the historical pending slot", () => {
    const { h, input } = fixture();
    const outcome = h.store.recordAssignmentOutcome(input);
    h.store.receiptAssignmentOutcome({ assignmentId: input.assignmentId, recipient: parentOwner, revision: 1, entryId: "retained-transcript-entry" });
    h.closeStore();
    const db = new DatabaseSync(h.path);
    db.exec("DROP TABLE assignment_attempts; DROP INDEX waits_one_pending_per_owner; ALTER TABLE waits DROP COLUMN dispatch_disarmed; CREATE UNIQUE INDEX waits_one_pending_per_owner ON waits (owner_kind, owner_session_id, coalesce(owner_branch_id, '')) WHERE phase NOT IN ('consumed', 'cancelled'); UPDATE schema_meta SET value = '2' WHERE key = 'schema_version'");
    db.close();
    h.reopen();
    assert.equal(h.store.getAssignmentOutcome(input.assignmentId)?.deliveryReceipt?.entryId, "retained-transcript-entry");
    assert.equal(h.store.getAssignmentOutcome(input.assignmentId)?.eventId, outcome.eventId);
    assert.doesNotThrow(() => h.store.registerWait({ owner: workerOwner, dependencies: [{ operationId: "op-build-1" }], continuationNote: "New assignment after upgrade", origin: { assignmentRef: "new-assignment" } }));
});
