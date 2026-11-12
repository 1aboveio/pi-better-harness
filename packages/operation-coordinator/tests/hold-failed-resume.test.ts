import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { openStore } from "../index.ts";
import {
    cleanupHarnesses,
    createHarness,
    expectStoreError,
    parentOwner,
    registerOperation,
    settleOperation,
} from "./support.ts";

afterEach(cleanupHarnesses);

/** A published resume generation: the wait is `resuming` with one active claim. */
function publishedResume(harness: ReturnType<typeof createHarness>, assignment = false) {
    const owner = assignment ? { ...parentOwner, kind: "worker-conversation" as const } : parentOwner;
    registerOperation(harness.store, { operationId: "op-hold", owner, taskId: "bg_hold" });
    settleOperation(harness.store, "op-hold", "succeeded", owner);
    const registered = harness.store.registerWait({
        waitId: "wait-hold",
        owner,
        dependencies: [{ operationId: "op-hold" }],
        continuationNote: "Interpret the result.",
        park: { attemptId: "attempt-a", checkpointId: "checkpoint-a" },
        ...(assignment ? { origin: { assignmentRef: "assignment-repair" } } : {}),
    });
    assert.equal(registered.wait.phase, "registering");
    harness.store.transitionWaitPhase({
        waitId: "wait-hold",
        generation: 1,
        from: "registering",
        to: "parking",
    });
    harness.store.transitionWaitPhase({
        waitId: "wait-hold",
        generation: 1,
        from: "parking",
        to: "waiting",
        proof: { checkpointRecorded: true, writerLeaseReleased: true, writerPidGone: true },
    });
    const claim = harness.store.claimResume({
        waitId: "wait-hold",
        generation: 1,
        expectedCancelEpoch: 0,
        lease: { ownerId: "host-1", pid: 4242 },
        reservedCheckpointId: "checkpoint-a",
    });
    const published = harness.store.publishResumeAttempt({
        waitId: "wait-hold",
        generation: 1,
        claimId: claim.claim.claimId,
        claimToken: claim.claim.claimToken,
        attemptId: "attempt-b",
        launchToken: "launch-b",
    });
    assert.equal(published.wait.phase, "resuming");
    return {
        claimId: claim.claim.claimId,
        claimToken: claim.claim.claimToken,
        attemptId: "attempt-b",
        launchToken: "launch-b",
    };
}

function holdInput(claim: ReturnType<typeof publishedResume>, overrides: Record<string, unknown> = {}) {
    return {
        waitId: "wait-hold",
        generation: 1,
        claimId: claim.claimId,
        claimToken: claim.claimToken,
        attemptId: claim.attemptId,
        launchToken: claim.launchToken,
        proof: { writerPidGone: true, writerLeaseReleased: true },
        reason: "the published resume attempt attempt-b exited (failed) without interpreting the wait",
        ...overrides,
    };
}

describe("holding a failed published resume", () => {
    it("persists one repair across restart and delivers recurring fault to the recorded parent", () => {
        const h = createHarness();
        const worker = { ...parentOwner, kind: "worker-conversation" as const };
        const claim = publishedResume(h, true);
        const input = { ...holdInput(claim), checkpointId: "checkpoint-a", expectedCancelEpoch: 0 };
        h.store.registerAssignment({ assignmentId: "assignment-repair", owner: worker, recipient: parentOwner });
        const w = { waitId: "wait-hold" };
        const publish = (attemptId: string) => {
            const c = h.store.claimResume({ waitId: w.waitId, generation: 1, expectedCancelEpoch: 0, lease: { ownerId: "replacement-host", pid: 4242 }, reservedCheckpointId: "checkpoint-a" }).claim;
            h.store.publishResumeAttempt({ waitId: w.waitId, generation: 1, claimId: c.claimId, claimToken: c.claimToken, attemptId, launchToken: attemptId });
            return { ...input, waitId: w.waitId, claimId: c.claimId, claimToken: c.claimToken, attemptId, launchToken: attemptId };
        };
        const first = input;
        expectStoreError(() => h.store.repairFailedResume({ ...first, checkpointId: "wrong-checkpoint" }), "resume-proof");
        expectStoreError(() => h.store.repairFailedResume({ ...first, expectedCancelEpoch: 1 }), "stale-cancel-epoch");
        expectStoreError(() => h.store.repairFailedResume({ ...first, proof: { writerPidGone: false, writerLeaseReleased: true } }), "resume-proof");
        assert.deepEqual(h.store.repairFailedResume(first), { phase: "ready", repaired: true });
        h.reopen();
        expectStoreError(() => h.store.repairFailedResume({ ...first, launchToken: "forged-token" }), "claim-state");
        assert.equal(h.store.repairFailedResume({ ...first, reason: "reworded exit" }).repaired, false);
        const second = publish("new-attempt-id");
        assert.equal(h.store.repairFailedResume(second).phase, "held");
        const outcome = h.store.getAssignmentOutcome("assignment-repair");
        assert.equal(outcome?.outcome, "failed");
        assert.deepEqual(outcome?.recipient, parentOwner);
        assert.equal(h.store.getWait({ waitId: w.waitId, generation: 1 })?.acknowledgement, null);
        assert.equal(h.store.listOutbox().filter((e) => e.type === "assignment-outcome").length, 1);
        assert.equal(h.store.repairFailedResume(second).repaired, false);
        expectStoreError(() => publish("third-writer"), "wait-phase");
    });
    it("moves resuming to held, keeps the epoch and pins, and invalidates the claim", () => {
        const harness = createHarness();
        const claim = publishedResume(harness);
        const pinsBefore = harness.store.listEvidencePins({ waitId: "wait-hold" });
        assert.ok(pinsBefore.length >= 1, "delivery pins terminal evidence");

        const held = harness.store.holdFailedResume(holdInput(claim));

        assert.equal(held.applied, true);
        assert.equal(held.wait.phase, "held");
        assert.match(held.wait.phaseReason ?? "", /without interpreting the wait/);
        assert.equal(held.wait.cancelEpoch, 0, "a failure is not a cancellation");
        assert.equal(held.claim.state, "invalidated");
        assert.match(held.claim.reason ?? "", /without interpreting the wait/);
        const pinsAfter = harness.store.listEvidencePins({ waitId: "wait-hold" });
        assert.deepEqual(
            pinsAfter.map((pin) => pin.pinId).sort(),
            pinsBefore.map((pin) => pin.pinId).sort(),
            "evidence pins are retained for the owner's interpretation",
        );
        assert.equal(pinsAfter.every((pin) => pin.releasedAt === null), true);

        // Persisted, and the generation is no longer in the resuming path.
        harness.reopen();
        assert.equal(harness.store.getWait({ waitId: "wait-hold", generation: 1 })?.phase, "held");
        assert.equal(harness.store.listResumeClaims({ waitId: "wait-hold", state: ["published"] }).length, 0);
    });

    it("is idempotent for a replayed hold", () => {
        const harness = createHarness();
        const claim = publishedResume(harness);
        const first = harness.store.holdFailedResume(holdInput(claim));
        const replay = harness.store.holdFailedResume(holdInput(claim));
        assert.equal(first.applied, true);
        assert.equal(replay.applied, false);
        assert.equal(replay.wait.phase, "held");
        assert.equal(replay.wait.cancelEpoch, 0);
    });

    it("refuses a mismatched claim token, attempt id or launch token", () => {
        const harness = createHarness();
        const claim = publishedResume(harness);

        expectStoreError(() => harness.store.holdFailedResume(holdInput(claim, { claimToken: "forged" })), "claim-state");
        expectStoreError(() => harness.store.holdFailedResume(holdInput(claim, { attemptId: "attempt-other" })), "claim-state");
        expectStoreError(() => harness.store.holdFailedResume(holdInput(claim, { launchToken: "launch-other" })), "claim-state");
        assert.equal(harness.store.getWait({ waitId: "wait-hold", generation: 1 })?.phase, "resuming");
        assert.equal(harness.store.listResumeClaims({ waitId: "wait-hold", state: ["published"] }).length, 1);
    });

    it("refuses an unproven exit", () => {
        const harness = createHarness();
        const claim = publishedResume(harness);
        expectStoreError(
            () => harness.store.holdFailedResume(holdInput(claim, { proof: { writerPidGone: false, writerLeaseReleased: true } })),
            "resume-proof",
        );
        expectStoreError(
            () => harness.store.holdFailedResume(holdInput(claim, { proof: { writerPidGone: true, writerLeaseReleased: false } })),
            "resume-proof",
        );
        assert.equal(harness.store.getWait({ waitId: "wait-hold", generation: 1 })?.phase, "resuming");
    });

    it("never rewrites a consumed or cancelled generation", () => {
        const consumed = createHarness();
        const consumedClaim = publishedResume(consumed);
        consumed.store.recordEvidenceRead({
            waitId: "wait-hold",
            generation: 1,
            owner: parentOwner,
            operationId: "op-hold",
            terminalRevision: 1,
        });
        consumed.store.acknowledgeResult({
            waitId: "wait-hold",
            generation: 1,
            owner: parentOwner,
            disposition: "continue",
            note: "interpreted",
            terminalRevisions: [{ operationId: "op-hold", revision: 1 }],
        });
        expectStoreError(() => consumed.store.holdFailedResume(holdInput(consumedClaim)), "wait-phase");
        assert.equal(consumed.store.getWait({ waitId: "wait-hold", generation: 1 })?.phase, "consumed");

        const cancelled = createHarness();
        const cancelledClaim = publishedResume(cancelled);
        cancelled.store.cancelWait({
            waitId: "wait-hold",
            generation: 1,
            expectedCancelEpoch: 0,
            owner: parentOwner,
            reason: "owner cancelled",
        });
        expectStoreError(() => cancelled.store.holdFailedResume(holdInput(cancelledClaim)), "wait-phase");
        assert.equal(cancelled.store.getWait({ waitId: "wait-hold", generation: 1 })?.phase, "cancelled");
    });
});
