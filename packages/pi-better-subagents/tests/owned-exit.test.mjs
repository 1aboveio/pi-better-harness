import test from "node:test";
import assert from "node:assert/strict";
import { completeOwnedExit } from "../owned-exit.ts";
import { createCallbackBatcher } from "../shared-callback-batcher.ts";
import { registerFixtureRun } from "./fixture-run-ownership.mjs";

const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

test("fixture cleanup registration follows the actual exit observer, not the tool caller", () => {
    const run = { id: "local", pid: 123 }, liveRuns = [];
    const owned = new Map([[run.id, { pid: run.pid, completion: Promise.resolve() }]]);
    registerFixtureRun(run, owned, liveRuns);
    assert.deepEqual(liveRuns, [run]);
    registerFixtureRun({ id: "remote", pid: 456 }, owned, liveRuns, "continuation-fixture");
    assert.deepEqual(liveRuns, [run], "remote fixture close, not the local reaper, owns its managed child");
    assert.throws(() => registerFixtureRun({ id: "unknown", pid: 789 }, owned, liveRuns), /exact owned exit/);
    assert.throws(() => registerFixtureRun({ ...run, pid: 999 }, owned, liveRuns), /exact owned exit/);
    assert.throws(() => registerFixtureRun(run, owned, liveRuns, "continuation-fixture"), /two fixture teardown owners/);
    assert.deepEqual(liveRuns, [run], "refused ownership must not register a kill or deletion");
});

test("owned exit acknowledgement waits beyond lease release and rejects failed finalization", async () => {
    const exit = deferred(), settlement = deferred();
    const order = [];
    const completion = completeOwnedExit(exit.promise, code => order.push(`finalize:${code}`),
        () => order.push("release"), async () => { await settlement.promise; order.push("settled"); });
    let removable = false;
    void completion.then(() => { removable = true; });
    exit.resolve(0);
    await new Promise(resolve => setImmediate(resolve));
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
    await assert.rejects(completeOwnedExit(Promise.resolve(0), () => {}, () => {},
        async () => { throw new Error("park settlement refused"); }), /park settlement refused/);
});

for (const urgent of [true, false]) test(`cancelled callback owner waits for its ${urgent ? "urgent" : "ordinary"} handoff acknowledgement`, async () => {
    const handoff = deferred();
    const batcher = createCallbackBatcher({ sendMessage: () => handoff.promise });
    // Urgent handoffs write their durable delivery marker after sendMessage resolves.
    let delivered = false;
    const event = { id: "owned", source: "subagent", label: "owned", status: "orphaned", customType: "health", content: "health",
        onDelivered: () => { delivered = true; } };
    let pending;
    if (urgent) pending = batcher.deliverUrgent(event);
    else { batcher.enqueue(event); pending = batcher.flush(); }
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
