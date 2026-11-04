import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
    cleanupHarnesses,
    createHarness,
    expectStoreError,
    otherWorkerOwner,
    parentOwner,
    parkProof,
    registerOperation,
    settleOperation,
    workerOwner,
} from "./support.ts";

afterEach(cleanupHarnesses);

const lease = { ownerId: "host-1", pid: 4242, processStartToken: "start-4242" };

/**
 * A ready worker wait. The operation settled before registration, so the parked
 * worker only has to prove its checkpoint was committed and its writer exited.
 */
function readyWorkerWait(harness: ReturnType<typeof createHarness>) {
    registerOperation(harness.store);
    settleOperation(harness.store, "op-build-1");
    const registered = harness.store.registerWait({
        waitId: "wait-build",
        owner: workerOwner,
        dependencies: [{ operationId: "op-build-1" }],
        continuationNote: "Read the build result and continue packaging.",
        park: {
            attemptId: "attempt-worker-1",
            checkpointId: "checkpoint-worker-1",
        },
    });
    harness.store.transitionWaitPhase({
        waitId: registered.wait.waitId,
        generation: registered.wait.generation,
        from: "registering",
        to: "parking",
        reason: "checkpoint committed; attempt finalizing",
    });
    const ready = harness.store.transitionWaitPhase({
        waitId: registered.wait.waitId,
        generation: registered.wait.generation,
        from: "parking",
        to: "waiting",
        proof: parkProof,
    });
    assert.equal(ready.wait.phase, "ready");
    return ready.wait;
}

function claim(harness: ReturnType<typeof createHarness>) {
    return harness.store.claimResume({
        waitId: "wait-build",
        generation: 1,
        expectedCancelEpoch: 0,
        lease,
        reservedCheckpointId: "checkpoint-worker-1",
    });
}

describe("resume claims", () => {
    it("admits one claim per generation and persists it across reopen", () => {
        const harness = createHarness();
        readyWorkerWait(harness);

        const claimed = claim(harness);
        assert.equal(claimed.claim.state, "claimed");
        assert.equal(claimed.claim.attemptId, null);
        assert.equal(claimed.wait.phase, "resuming");
        assert.equal(claimed.wait.cancelEpoch, 0);
        assert.match(claimed.claim.claimToken, /^claimtok_/);
        assert.deepEqual(claimed.claim.lease, lease);

        expectStoreError(() => claim(harness), "concurrent-claim", /active resume claim/);

        harness.reopen();
        const reread = harness.store.listResumeClaims({ waitId: "wait-build" });
        assert.equal(reread.length, 1);
        assert.equal(reread[0].claimId, claimed.claim.claimId);
        assert.equal(reread[0].state, "claimed");
    });

    it("persists the attempt id and launch token before spawn", () => {
        const harness = createHarness();
        readyWorkerWait(harness);
        const { claim: claimed } = claim(harness);

        const published = harness.store.publishResumeAttempt({
            waitId: "wait-build",
            generation: 1,
            claimId: claimed.claimId,
            claimToken: claimed.claimToken,
            attemptId: "attempt-worker-2",
            launchToken: "launch-worker-2",
        });
        assert.equal(published.published, true);
        assert.equal(published.claim.state, "published");
        assert.equal(published.claim.attemptId, "attempt-worker-2");
        assert.equal(published.claim.launchToken, "launch-worker-2");
        assert.ok(published.claim.publishedAt !== null);

        harness.reopen();
        const reconciled = harness.store.listUnreconciledClaims();
        assert.deepEqual(reconciled.map((entry) => entry.attemptId), ["attempt-worker-2"]);

        const replay = harness.store.publishResumeAttempt({
            waitId: "wait-build",
            generation: 1,
            claimId: claimed.claimId,
            claimToken: claimed.claimToken,
            attemptId: "attempt-worker-2",
            launchToken: "launch-worker-2",
        });
        assert.equal(replay.published, false, "an identical publish is an idempotent replay");

        expectStoreError(
            () => harness.store.publishResumeAttempt({
                waitId: "wait-build",
                generation: 1,
                claimId: claimed.claimId,
                claimToken: claimed.claimToken,
                attemptId: "attempt-worker-3",
                launchToken: "launch-worker-3",
            }),
            "claim-state",
            /already published attempt attempt-worker-2/,
        );
    });

    it("refuses a publish that does not hold the claim token", () => {
        const harness = createHarness();
        readyWorkerWait(harness);
        const { claim: claimed } = claim(harness);

        expectStoreError(
            () => harness.store.publishResumeAttempt({
                waitId: "wait-build",
                generation: 1,
                claimId: claimed.claimId,
                claimToken: "claimtok_forged",
                attemptId: "attempt-worker-2",
                launchToken: "launch-worker-2",
            }),
            "claim-state",
            /was not issued with this token/,
        );
        assert.equal(harness.store.listUnreconciledClaims()[0].state, "claimed");
    });

    it("refuses an attempt id already published by another claim", () => {
        const harness = createHarness();
        readyWorkerWait(harness);
        const first = claim(harness);
        harness.store.publishResumeAttempt({
            waitId: "wait-build",
            generation: 1,
            claimId: first.claim.claimId,
            claimToken: first.claim.claimToken,
            attemptId: "attempt-shared",
            launchToken: "launch-shared",
        });

        registerOperation(harness.store, { operationId: "op-other", owner: parentOwner, taskId: "bg_other" });
        settleOperation(harness.store, "op-other", "succeeded", parentOwner);
        harness.store.registerWait({
            waitId: "wait-other",
            owner: parentOwner,
            dependencies: [{ operationId: "op-other" }],
            continuationNote: "Parent interprets the other result.",
        });
        const other = harness.store.claimResume({
            waitId: "wait-other",
            generation: 1,
            expectedCancelEpoch: 0,
            lease,
            reservedCheckpointId: "checkpoint-other",
        });

        expectStoreError(
            () => harness.store.publishResumeAttempt({
                waitId: "wait-other",
                generation: 1,
                claimId: other.claim.claimId,
                claimToken: other.claim.claimToken,
                attemptId: "attempt-shared",
                launchToken: "launch-shared",
            }),
            "attempt-conflict",
            /cannot be reused/,
        );
    });

    it("invalidates the claim when cancellation wins the race", () => {
        const harness = createHarness();
        readyWorkerWait(harness);
        const { claim: claimed } = claim(harness);

        const cancelled = harness.store.cancelWait({
            waitId: "wait-build",
            generation: 1,
            expectedCancelEpoch: 0,
            owner: workerOwner,
            reason: "owner cancelled the parked assignment",
        });
        assert.equal(cancelled.wait.cancelEpoch, 1);
        assert.deepEqual(cancelled.invalidatedClaimIds, [claimed.claimId]);

        expectStoreError(
            () => harness.store.publishResumeAttempt({
                waitId: "wait-build",
                generation: 1,
                claimId: claimed.claimId,
                claimToken: claimed.claimToken,
                attemptId: "attempt-worker-2",
                launchToken: "launch-worker-2",
            }),
            "claim-state",
            /invalidated/,
        );
        assert.equal(harness.store.listUnreconciledClaims().length, 0);
        assert.equal(harness.store.getWait({ waitId: "wait-build" })?.phase, "cancelled");
    });

    it("refuses to publish an attempt for a superseded generation", () => {
        const harness = createHarness();
        readyWorkerWait(harness);
        const first = claim(harness);

        harness.store.cancelWait({
            waitId: "wait-build",
            generation: 1,
            expectedCancelEpoch: 0,
            owner: workerOwner,
            reason: "cancelled while admitting",
        });
        const next = harness.store.registerWait({
            waitId: "wait-build",
            owner: workerOwner,
            dependencies: [{ operationId: "op-build-1" }],
            continuationNote: "Replacement generation.",
        });
        assert.equal(next.wait.generation, 2);

        expectStoreError(
            () => harness.store.publishResumeAttempt({
                waitId: "wait-build",
                generation: 1,
                claimId: first.claim.claimId,
                claimToken: first.claim.claimToken,
                attemptId: "attempt-worker-2",
                launchToken: "launch-worker-2",
            }),
            "stale-generation",
            /generation 2/,
        );
    });

    it("returns a pre-spawn admission failure to ready for a fresh claim", () => {
        const harness = createHarness();
        readyWorkerWait(harness);
        const first = claim(harness);

        const released = harness.store.releaseResumeClaim({
            waitId: "wait-build",
            generation: 1,
            claimId: first.claim.claimId,
            claimToken: first.claim.claimToken,
            outcome: "ready",
            reason: "capacity reservation failed before spawn",
        });
        assert.equal(released.claim.state, "released");
        assert.equal(released.wait.phase, "ready");

        const second = claim(harness);
        assert.notEqual(second.claim.claimId, first.claim.claimId);
        assert.equal(second.claim.state, "claimed");
    });

    it("holds an uncertain admission and refuses a second claim", () => {
        const harness = createHarness();
        readyWorkerWait(harness);
        const first = claim(harness);
        const held = harness.store.releaseResumeClaim({
            waitId: "wait-build",
            generation: 1,
            claimId: first.claim.claimId,
            claimToken: first.claim.claimToken,
            outcome: "held",
            reason: "bootstrap records cannot prove whether a writer started",
        });

        assert.equal(held.wait.phase, "held");
        assert.equal(held.wait.phaseReason, "bootstrap records cannot prove whether a writer started");
        expectStoreError(() => claim(harness), "wait-phase", /is held/);
    });

    it("refuses to release a published claim", () => {
        const harness = createHarness();
        readyWorkerWait(harness);
        const { claim: claimed } = claim(harness);
        harness.store.publishResumeAttempt({
            waitId: "wait-build",
            generation: 1,
            claimId: claimed.claimId,
            claimToken: claimed.claimToken,
            attemptId: "attempt-worker-2",
            launchToken: "launch-worker-2",
        });

        expectStoreError(
            () => harness.store.releaseResumeClaim({
                waitId: "wait-build",
                generation: 1,
                claimId: claimed.claimId,
                claimToken: claimed.claimToken,
                outcome: "ready",
                reason: "attempt to release a live attempt",
            }),
            "claim-state",
            /reconciled, not released/,
        );
        assert.equal(harness.store.getWait({ waitId: "wait-build" })?.phase, "resuming");
    });

    it("refuses to publish an attempt from a released claim", () => {
        const harness = createHarness();
        readyWorkerWait(harness);
        const first = claim(harness);
        harness.store.releaseResumeClaim({
            waitId: "wait-build",
            generation: 1,
            claimId: first.claim.claimId,
            claimToken: first.claim.claimToken,
            outcome: "ready",
            reason: "admission failed before spawn",
        });

        expectStoreError(
            () => harness.store.publishResumeAttempt({
                waitId: "wait-build",
                generation: 1,
                claimId: first.claim.claimId,
                claimToken: first.claim.claimToken,
                attemptId: "attempt-after-release",
                launchToken: "launch-after-release",
            }),
            "claim-state",
            /may only be published while the generation is resuming/,
        );
        assert.equal(harness.store.listUnreconciledClaims().length, 0);
    });

    it("refuses a claim with a stale cancellation epoch", () => {
        const harness = createHarness();
        readyWorkerWait(harness);
        expectStoreError(
            () => harness.store.claimResume({
                waitId: "wait-build",
                generation: 1,
                expectedCancelEpoch: 3,
                lease,
                reservedCheckpointId: "checkpoint-worker-1",
            }),
            "stale-cancel-epoch",
        );
    });

    it("refuses a claim by a foreign generation address", () => {
        const harness = createHarness();
        readyWorkerWait(harness);
        expectStoreError(
            () => harness.store.claimResume({
                waitId: "wait-build",
                generation: 2,
                expectedCancelEpoch: 0,
                lease,
                reservedCheckpointId: "checkpoint-worker-1",
            }),
            "unknown-wait",
        );
    });

    it("keeps a foreign owner from claiming its neighbour's wait", () => {
        const harness = createHarness();
        registerOperation(harness.store, { operationId: "op-other", owner: otherWorkerOwner, taskId: "bg_other" });
        settleOperation(harness.store, "op-other", "succeeded", otherWorkerOwner);
        const registered = harness.store.registerWait({
            waitId: "wait-other",
            owner: otherWorkerOwner,
            dependencies: [{ operationId: "op-other" }],
            continuationNote: "Other owner's assignment.",
        });
        assert.equal(registered.wait.phase, "ready");

        // Claims are taken by the supervising host, but a foreign attempt to
        // publish the claim under another owner's conversation is refused below.
        const other = harness.store.claimResume({
            waitId: "wait-other",
            generation: 1,
            expectedCancelEpoch: 0,
            lease,
            reservedCheckpointId: "checkpoint-other",
        });
        expectStoreError(
            () => harness.store.publishResumeAttempt({
                waitId: "wait-other",
                generation: 1,
                claimId: other.claim.claimId,
                claimToken: "claimtok_forged",
                attemptId: "attempt-forged",
                launchToken: "launch-forged",
            }),
            "claim-state",
        );
    });
});
