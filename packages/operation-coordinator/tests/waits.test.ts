import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
    cleanupHarnesses,
    createHarness,
    expectStoreError,
    otherWorkerOwner,
    parentOwner,
    parkIntent,
    parkProof,
    registerOperation,
    settleOperation,
    workerOwner,
} from "./support.ts";

afterEach(cleanupHarnesses);

function workerWait(harness: ReturnType<typeof createHarness>, operationId = "op-build-1") {
    return harness.store.registerWait({
        owner: workerOwner,
        dependencies: [{ operationId }],
        continuationNote: "Read the build result; diagnose failure or continue packaging.",
        park: parkIntent,
        origin: { taskIds: [`bg_${operationId}`], attemptId: "attempt-worker-1" },
    });
}

describe("all-settled registration", () => {
    it("does not miss a dependency that finished before registration", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        settleOperation(harness.store, "op-build-1");

        const registered = harness.store.registerWait({
            waitId: "wait-build",
            owner: workerOwner,
            dependencies: [{ operationId: "op-build-1" }],
            continuationNote: "Read the build result and continue packaging.",
        });

        assert.equal(registered.settledAtRegistration, true);
        assert.equal(registered.wait.phase, "ready");
        assert.equal(registered.wait.settled, true);
        assert.equal(registered.outbox.length, 1);
        assert.equal(registered.outbox[0].terminalRevision, 1);
        assert.equal(registered.wait.dependencies[0].terminalRevision, 1);
        assert.ok(registered.outbox[0].evidence.length >= 1);
    });

    it("waits until every dependency has a terminal outcome", () => {
        const harness = createHarness();
        registerOperation(harness.store, { operationId: "op-a", owner: parentOwner, taskId: "bg_a" });
        registerOperation(harness.store, { operationId: "op-b", owner: parentOwner, taskId: "bg_b" });
        const registered = harness.store.registerWait({
            waitId: "wait-delivery",
            owner: parentOwner,
            dependencies: [{ operationId: "op-a" }, { operationId: "op-b" }],
            continuationNote: "Inspect both terminal records before reporting.",
        });
        assert.equal(registered.wait.phase, "waiting");
        assert.equal(registered.settledAtRegistration, false);

        settleOperation(harness.store, "op-a", "succeeded", parentOwner);
        let wait = harness.store.getWait({ waitId: "wait-delivery" });
        assert.equal(wait?.phase, "waiting", "one unfinished dependency keeps the wait waiting");
        assert.equal(harness.store.listOutbox({ waitId: "wait-delivery" }).length, 0);

        settleOperation(harness.store, "op-b", "failed", parentOwner);
        wait = harness.store.getWait({ waitId: "wait-delivery" });
        assert.equal(wait?.phase, "ready");
        assert.equal(wait?.phaseReason, "dependencies-settled");
        assert.equal(harness.store.listOutbox({ waitId: "wait-delivery" }).length, 2);
    });

    it("refuses a dependency that is not registered", () => {
        const harness = createHarness();
        expectStoreError(
            () => harness.store.registerWait({
                owner: workerOwner,
                dependencies: [{ operationId: "op-unknown" }],
                continuationNote: "Watch something that was never launched.",
            }),
            "unknown-operation",
        );
    });

    it("refuses a foreign dependency unless the link is explicit", () => {
        const harness = createHarness();
        registerOperation(harness.store, { operationId: "op-other", owner: otherWorkerOwner, taskId: "bg_other" });

        expectStoreError(
            () => harness.store.registerWait({
                owner: workerOwner,
                dependencies: [{ operationId: "op-other" }],
                continuationNote: "Wait on a task owned by another conversation.",
            }),
            "foreign-owner",
        );

        const shared = harness.store.registerWait({
            owner: workerOwner,
            dependencies: [{ operationId: "op-other", link: "explicit" }],
            continuationNote: "Wait on a shared observer explicitly.",
        });
        assert.equal(shared.wait.dependencies[0].link, "explicit");
        assert.equal(shared.wait.phase, "waiting");
    });

    it("refuses a second pending generation for the same owner identity", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        harness.store.registerWait({
            waitId: "wait-build",
            owner: workerOwner,
            dependencies: [{ operationId: "op-build-1" }],
            continuationNote: "First assignment step.",
        });

        const refusal = expectStoreError(
            () => harness.store.registerWait({
                waitId: "wait-build",
                owner: workerOwner,
                dependencies: [{ operationId: "op-build-1" }],
                continuationNote: "Second assignment step.",
            }),
            "pending-wait-generation",
            /still waiting/,
        );
        assert.match(refusal.message, /generation 1/);
        assert.equal(
            harness.store.findPendingWait(workerOwner)?.waitId,
            "wait-build",
            "the owner's pending generation stays discoverable",
        );
        assert.deepEqual(harness.store.listWaits({ pendingOnly: true }).map((wait) => wait.waitId), ["wait-build"]);
    });
});

describe("parked worker phases", () => {
    it("requires proven checkpoint commit and writer exit before waiting", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        const { wait } = workerWait(harness);
        assert.equal(wait.phase, "registering");
        assert.deepEqual(wait.park, parkIntent);

        expectStoreError(
            () => harness.store.transitionWaitPhase({
                waitId: wait.waitId,
                generation: wait.generation,
                from: "registering",
                to: "waiting",
            }),
            "checkpoint-proof",
            /parked worker/,
        );

        const parking = harness.store.transitionWaitPhase({
            waitId: wait.waitId,
            generation: wait.generation,
            from: "registering",
            to: "parking",
            reason: "checkpoint committed; requesting attempt finalization",
        });
        assert.equal(parking.wait.phase, "parking");

        expectStoreError(
            () => harness.store.transitionWaitPhase({
                waitId: wait.waitId,
                generation: wait.generation,
                from: "parking",
                to: "waiting",
            }),
            "checkpoint-proof",
            /no proof/,
        );
        expectStoreError(
            () => harness.store.transitionWaitPhase({
                waitId: wait.waitId,
                generation: wait.generation,
                from: "parking",
                to: "waiting",
                proof: { checkpointRecorded: true, writerLeaseReleased: false },
            }),
            "checkpoint-proof",
        );

        const waiting = harness.store.transitionWaitPhase({
            waitId: wait.waitId,
            generation: wait.generation,
            from: "parking",
            to: "waiting",
            proof: parkProof,
        });
        assert.equal(waiting.wait.phase, "waiting");
        assert.deepEqual(waiting.outbox, []);
    });

    it("requires proof that the original writer process is gone", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        const { wait } = workerWait(harness);
        harness.store.transitionWaitPhase({
            waitId: wait.waitId,
            generation: wait.generation,
            from: "registering",
            to: "parking",
        });

        expectStoreError(
            () => harness.store.transitionWaitPhase({
                waitId: wait.waitId,
                generation: wait.generation,
                from: "parking",
                to: "waiting",
                proof: { checkpointRecorded: true, writerLeaseReleased: true },
            }),
            "checkpoint-proof",
            /writer process exit/,
        );
        expectStoreError(
            () => harness.store.transitionWaitPhase({
                waitId: wait.waitId,
                generation: wait.generation,
                from: "parking",
                to: "waiting",
                proof: { checkpointRecorded: true, writerLeaseReleased: true, writerPidGone: false },
            }),
            "checkpoint-proof",
            /writer process exit/,
        );

        const waiting = harness.store.transitionWaitPhase({
            waitId: wait.waitId,
            generation: wait.generation,
            from: "parking",
            to: "waiting",
            proof: parkProof,
        });
        assert.equal(waiting.wait.phase, "waiting");
    });

    it("does not re-require parking proof once a parked worker has left parking", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        const { wait } = workerWait(harness);
        harness.store.transitionWaitPhase({
            waitId: wait.waitId,
            generation: wait.generation,
            from: "registering",
            to: "parking",
        });
        harness.store.transitionWaitPhase({
            waitId: wait.waitId,
            generation: wait.generation,
            from: "parking",
            to: "waiting",
            proof: parkProof,
        });
        settleOperation(harness.store, "op-build-1");
        assert.equal(harness.store.getWait({ waitId: wait.waitId })?.phase, "ready");

        const held = harness.store.transitionWaitPhase({
            waitId: wait.waitId,
            generation: wait.generation,
            from: "ready",
            to: "held",
            reason: "parent session is inactive",
        });
        assert.equal(held.wait.phase, "held");

        const ready = harness.store.transitionWaitPhase({
            waitId: wait.waitId,
            generation: wait.generation,
            from: "held",
            to: "ready",
            reason: "owner is active again",
        });
        assert.equal(ready.wait.phase, "ready");

        harness.store.transitionWaitPhase({
            waitId: wait.waitId,
            generation: wait.generation,
            from: "ready",
            to: "held",
            reason: "owner paused interpretation",
        });
        const waiting = harness.store.transitionWaitPhase({
            waitId: wait.waitId,
            generation: wait.generation,
            from: "held",
            to: "waiting",
            reason: "owner resumed the assignment",
        });
        assert.equal(waiting.wait.phase, "ready");
        assert.equal(waiting.wait.phaseReason, "settled-while-parking");
    });

    it("moves straight to ready when a dependency settled during parking", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        const { wait } = workerWait(harness);
        harness.store.transitionWaitPhase({
            waitId: wait.waitId,
            generation: wait.generation,
            from: "registering",
            to: "parking",
        });
        settleOperation(harness.store, "op-build-1");

        const settled = harness.store.transitionWaitPhase({
            waitId: wait.waitId,
            generation: wait.generation,
            from: "parking",
            to: "waiting",
            proof: parkProof,
        });

        assert.equal(settled.wait.phase, "ready");
        assert.equal(settled.wait.phaseReason, "settled-while-parking");
        assert.equal(settled.outbox.length, 1);
        assert.equal(settled.wait.settled, true);
    });

    it("refuses parking for a responsive parent wait", () => {
        const harness = createHarness();
        registerOperation(harness.store, { owner: parentOwner, taskId: "bg_parent" });
        const { wait } = harness.store.registerWait({
            owner: parentOwner,
            dependencies: [{ operationId: "op-build-1" }],
            continuationNote: "Parent stays responsive; no attempt is parked.",
        });

        expectStoreError(
            () => harness.store.transitionWaitPhase({
                waitId: wait.waitId,
                generation: wait.generation,
                from: "waiting",
                to: "parking",
            }),
            "wait-phase",
            /no park intent/,
        );
    });

    it("refuses a held phase without a reason", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        const { wait } = workerWait(harness);
        harness.store.transitionWaitPhase({
            waitId: wait.waitId,
            generation: wait.generation,
            from: "registering",
            to: "parking",
        });

        expectStoreError(
            () => harness.store.transitionWaitPhase({
                waitId: wait.waitId,
                generation: wait.generation,
                from: "parking",
                to: "held",
                proof: parkProof,
            }),
            "validation",
            /must record why it is held/,
        );
        const held = harness.store.transitionWaitPhase({
            waitId: wait.waitId,
            generation: wait.generation,
            from: "parking",
            to: "held",
            proof: parkProof,
            reason: "workspace missing; the owner must decide",
        });
        assert.equal(held.wait.phase, "held");
        assert.equal(held.wait.phaseReason, "workspace missing; the owner must decide");
    });
});

describe("phase fencing", () => {
    it("refuses an out-of-order transition", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        const { wait } = harness.store.registerWait({
            owner: workerOwner,
            dependencies: [{ operationId: "op-build-1" }],
            continuationNote: "Read the result.",
        });

        expectStoreError(
            () => harness.store.transitionWaitPhase({
                waitId: wait.waitId,
                generation: wait.generation,
                from: "ready",
                to: "held",
                reason: "stale view",
            }),
            "stale-phase",
            /is waiting, but the caller acted on ready/,
        );
        expectStoreError(
            () => harness.store.transitionWaitPhase({
                waitId: wait.waitId,
                generation: wait.generation + 7,
                from: "waiting",
                to: "held",
                reason: "unknown generation",
            }),
            "unknown-wait",
        );
        expectStoreError(
            () => harness.store.claimResume({
                waitId: wait.waitId,
                generation: wait.generation,
                expectedCancelEpoch: 0,
                lease: { ownerId: "host-1" },
                reservedCheckpointId: "checkpoint-1",
            }),
            "wait-phase",
            /only a ready generation/,
        );
    });

    it("refuses a dependency to become ready before it settles", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        const { wait } = harness.store.registerWait({
            owner: workerOwner,
            dependencies: [{ operationId: "op-build-1" }],
            continuationNote: "Read the result.",
        });

        expectStoreError(
            () => harness.store.transitionWaitPhase({
                waitId: wait.waitId,
                generation: wait.generation,
                from: "waiting",
                to: "ready",
            }),
            "dependencies-unsettled",
            /op-build-1/,
        );
    });

    it("refuses superseded generations after a new generation exists", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        const first = harness.store.registerWait({
            waitId: "wait-build",
            owner: workerOwner,
            dependencies: [{ operationId: "op-build-1" }],
            continuationNote: "First step.",
        });
        settleOperation(harness.store, "op-build-1");
        harness.store.recordEvidenceRead({
            waitId: first.wait.waitId,
            generation: first.wait.generation,
            owner: workerOwner,
            operationId: "op-build-1",
            terminalRevision: 1,
        });
        harness.store.acknowledgeResult({
            waitId: first.wait.waitId,
            generation: first.wait.generation,
            owner: workerOwner,
            disposition: "continue",
            note: "Build succeeded; continue packaging.",
            terminalRevisions: [{ operationId: "op-build-1", revision: 1 }],
        });

        const second = harness.store.registerWait({
            waitId: "wait-build",
            owner: workerOwner,
            dependencies: [{ operationId: "op-build-1" }],
            continuationNote: "Second step.",
        });
        assert.equal(second.wait.generation, 2);

        expectStoreError(
            () => harness.store.cancelWait({
                waitId: "wait-build",
                generation: 1,
                expectedCancelEpoch: 0,
                owner: workerOwner,
                reason: "stale cancellation",
            }),
            "stale-generation",
            /generation 2/,
        );
    });
});

describe("cancellation", () => {
    it("cancels once, increments the epoch, voids delivery and releases pins", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        const { wait } = harness.store.registerWait({
            waitId: "wait-build",
            owner: workerOwner,
            dependencies: [{ operationId: "op-build-1" }],
            continuationNote: "Read the result.",
        });
        settleOperation(harness.store, "op-build-1");
        assert.equal(harness.store.listEvidencePins({ waitId: "wait-build" }).length, 2);

        const cancelled = harness.store.cancelWait({
            waitId: "wait-build",
            generation: wait.generation,
            expectedCancelEpoch: 0,
            owner: workerOwner,
            reason: "the owner is done with this assignment",
        });

        assert.equal(cancelled.wait.phase, "cancelled");
        assert.equal(cancelled.wait.cancelEpoch, 1);
        assert.equal(cancelled.voidedOutboxIds.length, 1);
        assert.deepEqual(cancelled.invalidatedClaimIds, []);
        assert.equal(
            harness.store.listEvidencePins({ waitId: "wait-build" }).length,
            0,
            "cancellation releases evidence pins",
        );
        assert.equal(
            harness.store.listEvidencePins({ waitId: "wait-build" }, { includeReleased: true }).length,
            2,
        );
        assert.equal(harness.store.listOutbox({ waitId: "wait-build" })[0].state, "voided");
        assert.deepEqual(
            harness.store.claimOutbox({
                waitId: "wait-build",
                generation: wait.generation,
                claimToken: "dispatch-after-cancel",
                claimedBy: "host-1",
            }),
            [],
            "a cancelled generation delivers nothing",
        );

        expectStoreError(
            () => harness.store.cancelWait({
                waitId: "wait-build",
                generation: wait.generation,
                expectedCancelEpoch: 0,
                owner: workerOwner,
                reason: "duplicate cancellation",
            }),
            "wait-phase",
            /already cancelled/,
        );
    });

    it("refuses a stale cancellation epoch on a live wait", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        const { wait } = harness.store.registerWait({
            owner: workerOwner,
            dependencies: [{ operationId: "op-build-1" }],
            continuationNote: "Read the result.",
        });

        expectStoreError(
            () => harness.store.cancelWait({
                waitId: wait.waitId,
                generation: wait.generation,
                expectedCancelEpoch: 4,
                owner: workerOwner,
                reason: "wrong epoch",
            }),
            "stale-cancel-epoch",
            /epoch 0/,
        );
        assert.equal(harness.store.getWait({ waitId: wait.waitId })?.phase, "waiting");
    });

    it("refuses cancellation from a foreign owner", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        const { wait } = harness.store.registerWait({
            owner: workerOwner,
            dependencies: [{ operationId: "op-build-1" }],
            continuationNote: "Read the result.",
        });

        expectStoreError(
            () => harness.store.cancelWait({
                waitId: wait.waitId,
                generation: wait.generation,
                expectedCancelEpoch: 0,
                owner: otherWorkerOwner,
                reason: "not my wait",
            }),
            "foreign-owner",
            /another execution owner/,
        );
        assert.equal(harness.store.getWait({ waitId: wait.waitId })?.phase, "waiting");
    });
});

describe("held waits", () => {
    it("stays held when a dependency settles and can be returned to ready", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        const { wait } = harness.store.registerWait({
            waitId: "wait-build",
            owner: workerOwner,
            dependencies: [{ operationId: "op-build-1" }],
            continuationNote: "Read the result.",
        });
        harness.store.transitionWaitPhase({
            waitId: "wait-build",
            generation: wait.generation,
            from: "waiting",
            to: "held",
            reason: "permission revision changed; requires owner decision",
        });

        settleOperation(harness.store, "op-build-1");
        assert.equal(
            harness.store.getWait({ waitId: "wait-build" })?.phase,
            "held",
            "settlement does not override a hold",
        );

        const ready = harness.store.transitionWaitPhase({
            waitId: "wait-build",
            generation: wait.generation,
            from: "held",
            to: "ready",
            reason: "owner accepted the new permission revision",
        });
        assert.equal(ready.wait.phase, "ready");
        assert.equal(ready.outbox.length, 1);
    });
});
