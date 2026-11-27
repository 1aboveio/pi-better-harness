import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
    cleanupHarnesses,
    createHarness,
    expectStoreError,
    otherWorkerOwner,
    parentOwner,
    parkIntent,
    registerOperation,
    settleOperation,
    workerOwner,
} from "./support.ts";

afterEach(cleanupHarnesses);

/** A wait whose single dependency already settled: ready, with delivery queued. */
function readyWait(harness: ReturnType<typeof createHarness>, waitId = "wait-build") {
    registerOperation(harness.store);
    settleOperation(harness.store, "op-build-1");
    const registered = harness.store.registerWait({
        waitId,
        owner: workerOwner,
        dependencies: [{ operationId: "op-build-1" }],
        continuationNote: "Read the build result and continue packaging.",
    });
    assert.equal(registered.wait.phase, "ready");
    return { waitId, generation: registered.wait.generation };
}

function acknowledge(harness: ReturnType<typeof createHarness>, waitId = "wait-build") {
    return harness.store.acknowledgeResult({
        waitId,
        generation: 1,
        owner: workerOwner,
        disposition: "continue",
        note: "Build succeeded; continue packaging the release.",
        terminalRevisions: [{ operationId: "op-build-1", revision: 1 }],
    });
}

describe("evidence reads", () => {
    it("records one read per exact terminal revision", () => {
        const harness = createHarness();
        readyWait(harness);

        const first = harness.store.recordEvidenceRead({
            waitId: "wait-build",
            generation: 1,
            owner: workerOwner,
            operationId: "op-build-1",
            terminalRevision: 1,
        });
        assert.equal(first.recorded, true);
        assert.equal(first.read.terminalRevision, 1);
        assert.deepEqual(first.read.reader, workerOwner);

        const replay = harness.store.recordEvidenceRead({
            waitId: "wait-build",
            generation: 1,
            owner: workerOwner,
            operationId: "op-build-1",
            terminalRevision: 1,
        });
        assert.equal(replay.recorded, false, "re-reading the same revision is idempotent");
        assert.equal(harness.store.listEvidenceReads({ waitId: "wait-build" }).length, 1);
    });

    it("refuses a read by a foreign owner or of an unsettled revision", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        harness.store.registerWait({
            waitId: "wait-build",
            owner: workerOwner,
            dependencies: [{ operationId: "op-build-1" }],
            continuationNote: "Read the result.",
        });

        expectStoreError(
            () => harness.store.recordEvidenceRead({
                waitId: "wait-build",
                generation: 1,
                owner: otherWorkerOwner,
                operationId: "op-build-1",
                terminalRevision: 1,
            }),
            "foreign-owner",
        );
        expectStoreError(
            () => harness.store.recordEvidenceRead({
                waitId: "wait-build",
                generation: 1,
                owner: workerOwner,
                operationId: "op-build-1",
                terminalRevision: 1,
            }),
            "dependencies-unsettled",
        );

        settleOperation(harness.store, "op-build-1");
        expectStoreError(
            () => harness.store.recordEvidenceRead({
                waitId: "wait-build",
                generation: 1,
                owner: workerOwner,
                operationId: "op-build-1",
                terminalRevision: 2,
            }),
            "stale-evidence",
            /terminal revision 1, not 2/,
        );
        assert.equal(harness.store.listEvidenceReads({ waitId: "wait-build" }).length, 0);
    });
});

describe("interpretation acknowledgement", () => {
    it("requires a recorded evidence read before acknowledging", () => {
        const harness = createHarness();
        readyWait(harness);

        const refusal = expectStoreError(
            () => acknowledge(harness),
            "evidence-read-required",
            /has not been read by this owner/,
        );
        assert.match(refusal.message, /a delivery or status read is not an interpretation/);
        assert.equal(harness.store.getWait({ waitId: "wait-build" })?.phase, "ready");
    });

    it("refuses a stale or incomplete revision set", () => {
        const harness = createHarness();
        readyWait(harness);
        harness.store.recordEvidenceRead({
            waitId: "wait-build",
            generation: 1,
            owner: workerOwner,
            operationId: "op-build-1",
            terminalRevision: 1,
        });

        expectStoreError(
            () => harness.store.acknowledgeResult({
                waitId: "wait-build",
                generation: 1,
                owner: workerOwner,
                disposition: "continue",
                note: "Interpret a revision that does not exist.",
                terminalRevisions: [{ operationId: "op-build-1", revision: 2 }],
            }),
            "stale-evidence",
            /names 2/,
        );
        expectStoreError(
            () => harness.store.acknowledgeResult({
                waitId: "wait-build",
                generation: 1,
                owner: workerOwner,
                disposition: "continue",
                note: "Interpret an unrelated operation.",
                terminalRevisions: [{ operationId: "op-other", revision: 1 }],
            }),
            "stale-evidence",
            /omits operation op-build-1/,
        );
        assert.equal(harness.store.getWait({ waitId: "wait-build" })?.phase, "ready");
    });

    it("consumes the generation, acknowledges delivery and releases pins", () => {
        const harness = createHarness();
        readyWait(harness);
        assert.equal(harness.store.listEvidencePins({ waitId: "wait-build" }).length, 2);
        harness.store.recordEvidenceRead({
            waitId: "wait-build",
            generation: 1,
            owner: workerOwner,
            operationId: "op-build-1",
            terminalRevision: 1,
        });

        const acknowledged = acknowledge(harness);

        assert.equal(acknowledged.wait.phase, "consumed");
        assert.equal(acknowledged.wait.acknowledgement?.disposition, "continue");
        assert.match(acknowledged.wait.acknowledgement?.note ?? "", /continue packaging/);
        assert.equal(acknowledged.acknowledgedOutboxIds.length, 1);
        assert.equal(acknowledged.releasedPinIds.length, 2);
        assert.equal(harness.store.listOutbox({ waitId: "wait-build" })[0].state, "acknowledged");
        assert.equal(
            harness.store.listEvidencePins({ waitId: "wait-build" }).length,
            0,
            "consumption releases the pins that kept the evidence alive",
        );

        assert.deepEqual(
            harness.store.listWaits({ pendingOnly: true }).map((wait) => wait.phase),
            [],
            "a consumed generation is no longer pending",
        );

        harness.reopen();
        const reread = harness.store.getWait({ waitId: "wait-build" });
        assert.equal(reread?.phase, "consumed");
        assert.equal(reread?.acknowledgement?.note.includes("continue packaging"), true);
        assert.equal(
            harness.store.listEvidencePins({ waitId: "wait-build" }, { includeReleased: true }).length,
            2,
        );
    });

    it("refuses a duplicate acknowledgement", () => {
        const harness = createHarness();
        readyWait(harness);
        harness.store.recordEvidenceRead({
            waitId: "wait-build",
            generation: 1,
            owner: workerOwner,
            operationId: "op-build-1",
            terminalRevision: 1,
        });
        acknowledge(harness);

        expectStoreError(() => acknowledge(harness), "wait-phase", /already consumed/);
    });

    it("refuses acknowledgement from a foreign owner", () => {
        const harness = createHarness();
        readyWait(harness);
        harness.store.recordEvidenceRead({
            waitId: "wait-build",
            generation: 1,
            owner: workerOwner,
            operationId: "op-build-1",
            terminalRevision: 1,
        });

        expectStoreError(
            () => harness.store.acknowledgeResult({
                waitId: "wait-build",
                generation: 1,
                owner: otherWorkerOwner,
                disposition: "assignment-complete",
                note: "Not my assignment.",
                terminalRevisions: [{ operationId: "op-build-1", revision: 1 }],
            }),
            "foreign-owner",
            /acknowledgement must come from the owner/,
        );
        assert.equal(harness.store.getWait({ waitId: "wait-build" })?.phase, "ready");
    });

    it("refuses acknowledgement while a parked attempt is still committing", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        settleOperation(harness.store, "op-build-1");
        harness.store.registerWait({
            waitId: "wait-build",
            owner: workerOwner,
            dependencies: [{ operationId: "op-build-1" }],
            continuationNote: "Read the result.",
            park: parkIntent,
        });

        expectStoreError(
            () => acknowledge(harness),
            "wait-phase",
            /still registering/,
        );
    });
});

describe("evidence pins", () => {
    it("pins a bounded summary once per reference and releases it explicitly", () => {
        const harness = createHarness();
        readyWait(harness);

        const pinned = harness.store.recordEvidencePin({
            waitId: "wait-build",
            generation: 1,
            operationId: "op-build-1",
            terminalRevision: 1,
            kind: "summary",
            ref: "artifact:build-summary",
            summary: "12 files changed, release candidate built",
            bytes: 44,
        });
        assert.equal(pinned.recorded, true);
        assert.equal(pinned.pin.detailLost, false);

        const replay = harness.store.recordEvidencePin({
            waitId: "wait-build",
            generation: 1,
            operationId: "op-build-1",
            terminalRevision: 1,
            kind: "summary",
            ref: "artifact:build-summary",
            summary: "12 files changed, release candidate built",
        });
        assert.equal(replay.recorded, false);
        assert.equal(replay.pin.pinId, pinned.pin.pinId);

        expectStoreError(
            () => harness.store.recordEvidencePin({
                waitId: "wait-build",
                generation: 1,
                operationId: "op-build-1",
                terminalRevision: 9,
                kind: "log",
                ref: "artifact:stale",
            }),
            "stale-evidence",
        );

        const released = harness.store.releaseEvidencePins(
            { waitId: "wait-build", generation: 1 },
            "log retention already handled outside the coordinator",
        );
        assert.equal(released.length, 3);
        assert.equal(harness.store.listEvidencePins({ waitId: "wait-build" }).length, 0);
    });
});

describe("outbox delivery", () => {
    it("claims, releases with a recovery reason and delivers without consuming", () => {
        const harness = createHarness();
        readyWait(harness);

        const claimed = harness.store.claimOutbox({
            waitId: "wait-build",
            generation: 1,
            claimToken: "dispatch-1",
            claimedBy: "host-1",
        });
        assert.equal(claimed.length, 1);
        assert.equal(claimed[0].state, "claimed");
        assert.equal(claimed[0].attempts, 1);
        assert.equal(claimed[0].dispatchClaim?.token, "dispatch-1");

        expectStoreError(
            () => harness.store.releaseOutbox({
                eventId: claimed[0].eventId,
                claimToken: "dispatch-other",
                reason: "wrong token",
            }),
            "outbox-state",
            /different dispatch token/,
        );

        const released = harness.store.releaseOutbox({
            eventId: claimed[0].eventId,
            claimToken: "dispatch-1",
            reason: "the recipient session was not activated yet",
        });
        assert.equal(released.state, "pending");
        assert.equal(released.attempts, 1);
        assert.equal(released.reason, "the recipient session was not activated yet");
        assert.equal(released.dispatchClaim, null);

        const reclaimed = harness.store.claimOutbox({
            waitId: "wait-build",
            generation: 1,
            claimToken: "dispatch-2",
            claimedBy: "host-1",
        });
        assert.equal(reclaimed[0].attempts, 2);
        const delivered = harness.store.markOutboxDelivered({
            eventId: reclaimed[0].eventId,
            claimToken: "dispatch-2",
        });
        assert.equal(delivered.state, "delivered");
        assert.equal(
            harness.store.getWait({ waitId: "wait-build" })?.phase,
            "ready",
            "delivery alone does not consume the wait",
        );

        harness.store.recordEvidenceRead({
            waitId: "wait-build",
            generation: 1,
            owner: workerOwner,
            operationId: "op-build-1",
            terminalRevision: 1,
        });
        acknowledge(harness);
        assert.equal(harness.store.listOutbox({ waitId: "wait-build" })[0].state, "acknowledged");
    });

    it("fences dispatch on the claim token field, not token-shaped text", () => {
        const harness = createHarness();
        readyWait(harness);

        const claimed = harness.store.claimOutbox({
            waitId: "wait-build",
            generation: 1,
            claimToken: "dispatch-real",
            claimedBy: "dispatch-decoy",
        });
        assert.equal(claimed.length, 1);
        assert.equal(claimed[0].dispatchClaim?.claimedBy, "dispatch-decoy");

        expectStoreError(
            () => harness.store.releaseOutbox({
                eventId: claimed[0].eventId,
                claimToken: "dispatch-decoy",
                reason: "the claimant label is not a held token",
            }),
            "outbox-state",
            /different dispatch token/,
        );
        expectStoreError(
            () => harness.store.markOutboxDelivered({
                eventId: claimed[0].eventId,
                claimToken: "dispatch-decoy",
            }),
            "outbox-state",
            /different dispatch token/,
        );

        const delivered = harness.store.markOutboxDelivered({
            eventId: claimed[0].eventId,
            claimToken: "dispatch-real",
        });
        assert.equal(delivered.state, "delivered");
    });

    it("does not reserve a claim token because it appears as another claim's claimant", () => {
        const harness = createHarness();
        readyWait(harness, "wait-worker");
        registerOperation(harness.store, { operationId: "op-parent", owner: parentOwner, taskId: "bg_parent" });
        settleOperation(harness.store, "op-parent", "succeeded", parentOwner);
        const parentWait = harness.store.registerWait({
            waitId: "wait-parent",
            owner: parentOwner,
            dependencies: [{ operationId: "op-parent" }],
            continuationNote: "Parent interprets its own delivery.",
        });
        assert.equal(parentWait.wait.phase, "ready");

        harness.store.claimOutbox({
            waitId: "wait-worker",
            generation: 1,
            claimToken: "dispatch-a",
            claimedBy: "dispatch-b",
        });

        // `dispatch-b` is only a claimant label on the first claim; it is a fresh token.
        const parentClaimed = harness.store.claimOutbox({
            waitId: "wait-parent",
            generation: parentWait.wait.generation,
            claimToken: "dispatch-b",
            claimedBy: "host-1",
        });
        assert.equal(parentClaimed.length, 1);

        expectStoreError(
            () => harness.store.claimOutbox({
                waitId: "wait-worker",
                generation: 1,
                claimToken: "dispatch-a",
                claimedBy: "host-1",
            }),
            "outbox-state",
            /already held/,
        );
    });

    it("refuses to reuse a dispatch token that is still held", () => {
        const harness = createHarness();
        readyWait(harness);
        harness.store.claimOutbox({
            waitId: "wait-build",
            generation: 1,
            claimToken: "dispatch-1",
            claimedBy: "host-1",
        });

        expectStoreError(
            () => harness.store.claimOutbox({
                waitId: "wait-build",
                generation: 1,
                claimToken: "dispatch-1",
                claimedBy: "host-1",
            }),
            "outbox-state",
            /already held/,
        );
    });

    it("delivers nothing while the generation is held", () => {
        const harness = createHarness();
        readyWait(harness);
        harness.store.transitionWaitPhase({
            waitId: "wait-build",
            generation: 1,
            from: "ready",
            to: "held",
            reason: "parent session is inactive",
        });

        assert.deepEqual(
            harness.store.claimOutbox({
                waitId: "wait-build",
                generation: 1,
                claimToken: "dispatch-inactive",
                claimedBy: "host-1",
            }),
            [],
        );
        assert.equal(harness.store.listOutbox({ waitId: "wait-build" })[0].state, "pending");
    });

    it("addresses delivery to the exact owner identity and branch", () => {
        const harness = createHarness();
        registerOperation(harness.store, { operationId: "op-parent", owner: parentOwner, taskId: "bg_parent" });
        settleOperation(harness.store, "op-parent", "succeeded", parentOwner);
        harness.store.registerWait({
            waitId: "wait-delivery",
            owner: parentOwner,
            dependencies: [{ operationId: "op-parent" }],
            continuationNote: "Parent interprets the delivery verdict.",
        });

        const forBranch = harness.store.listOutbox({
            recipient: { ...parentOwner, branchId: "main" },
        });
        assert.equal(forBranch.length, 1);
        assert.deepEqual(forBranch[0].recipient, parentOwner);
        assert.deepEqual(
            harness.store.listOutbox({ recipient: { ...parentOwner, branchId: "side-branch" } }),
            [],
        );
    });
});
