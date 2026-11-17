import test from "node:test";
import assert from "node:assert/strict";
import { completeOwnedExit } from "../owned-exit.ts";
import { createCallbackBatcher } from "../shared-callback-batcher.ts";

const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

test("owned exit acknowledgement waits beyond lease release and rejects failed finalization", async () => {
    const exit = deferred(), settlement = deferred();
    const order = [];
    const completion = completeOwnedExit(exit.promise, code => order.push(`finalize:${code}`),
        () => order.push("release"), async () => { await settlement.promise; order.push("settled"); });
    let removable = false;
    void completion.then(() => { removable = true; });
    exit.resolve(0);
    await Promise.resolve();
    assert.deepEqual(order, ["finalize:0", "release"]);
    assert.equal(removable, false, "released lease is not permission to remove the directory");
    settlement.resolve();
    await completion;
    assert.equal(removable, true);
    assert.deepEqual(order, ["finalize:0", "release", "settled"]);
    let released = false, settled = false;
    await assert.rejects(completeOwnedExit(Promise.resolve(null), () => { throw new Error("terminal refused"); },
        () => { released = true; }, async () => { settled = true; }), /terminal refused/);
    assert.equal(released, true);
    assert.equal(settled, false, "failed finalization must not acknowledge quiescence");
});

test("cancelled callback owner waits for its already-started handoff acknowledgement", async () => {
    const handoff = deferred();
    const batcher = createCallbackBatcher({ sendMessage: () => handoff.promise });
    // Urgent handoffs write their durable delivery marker after sendMessage resolves.
    let delivered = false;
    const pending = batcher.deliverUrgent({ id: "owned", source: "subagent", label: "owned", status: "orphaned", customType: "health", content: "health",
        onDelivered: () => { delivered = true; } });
    batcher.cancel();
    let quiescent = false;
    const completion = batcher.settled().then(() => { quiescent = true; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(quiescent, false);
    handoff.resolve();
    await pending; await completion;
    assert.equal(delivered, true);
    assert.equal(quiescent, true);
});
