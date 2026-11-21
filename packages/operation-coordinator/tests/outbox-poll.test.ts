import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
    cleanupHarnesses,
    createHarness,
    otherWorkerOwner,
    parentOwner,
    registerOperation,
    settleOperation,
    workerOwner,
} from "./support.ts";

afterEach(cleanupHarnesses);

test("dispatch polling groups only pending dependency events whose waits can receive them", () => {
    const h = createHarness();
    for (const [operationId, owner] of [
        ["op-worker-a", workerOwner],
        ["op-worker-b", workerOwner],
        ["op-parent", parentOwner],
        ["op-held", otherWorkerOwner],
    ] as const) {
        registerOperation(h.store, { operationId, owner });
        settleOperation(h.store, operationId, "succeeded", owner);
    }

    h.store.registerWait({
        waitId: "wait-worker",
        owner: workerOwner,
        dependencies: [{ operationId: "op-worker-a" }, { operationId: "op-worker-b" }],
        continuationNote: "Inspect both results.",
    });
    h.store.registerWait({
        waitId: "wait-parent",
        owner: parentOwner,
        dependencies: [{ operationId: "op-parent" }],
        continuationNote: "Inspect the parent result.",
    });
    const { wait: held } = h.store.registerWait({
        waitId: "wait-held",
        owner: otherWorkerOwner,
        dependencies: [{ operationId: "op-held" }],
        continuationNote: "Inspect after the owner returns.",
    });
    h.store.transitionWaitPhase({
        waitId: held.waitId,
        generation: held.generation,
        from: "ready",
        to: "held",
        reason: "owner inactive",
    });

    assert.equal(h.store.listOutbox({ state: "pending" }).length, 4);
    assert.deepEqual(
        h.store.listDispatchableOutboxRecipients().sort((a, b) => a.recipient.sessionId.localeCompare(b.recipient.sessionId)),
        [
            { recipient: parentOwner, count: 1 },
            { recipient: workerOwner, count: 2 },
        ].sort((a, b) => a.recipient.sessionId.localeCompare(b.recipient.sessionId)),
    );

    assert.equal(h.store.claimOutbox({ recipient: parentOwner, type: "dependency-ready", claimToken: "parent-claim", claimedBy: "host-1" }).length, 1);
    assert.deepEqual(h.store.listDispatchableOutboxRecipients(), [{ recipient: workerOwner, count: 2 }]);
});
