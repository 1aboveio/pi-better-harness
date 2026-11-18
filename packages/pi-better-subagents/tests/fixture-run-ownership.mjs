import assert from "node:assert/strict";

/** Register cleanup only with the fixture that holds the actual exit observer. */
export function registerFixtureRun(run, ownedExits, liveRuns, teardownOwner) {
    if (teardownOwner === "continuation-fixture") {
        assert.equal(ownedExits.has(run.id), false, "a run cannot have two fixture teardown owners");
        return;
    }
    const owned = ownedExits.get(run.id);
    assert.ok(owned?.completion && owned.pid === run.pid, "local cleanup requires the exact owned exit acknowledgement");
    liveRuns.push(run);
}

/** Called only after successful acknowledged removal, never after a timeout. */
export function retireFixtureRun(run, receipt, ownedExits, liveRuns) {
    assert.equal(ownedExits.get(run.id), receipt, "retirement must match the exact exit owner receipt");
    assert.equal(receipt.pid, run.pid, "retirement must match the original child");
    for (let index = liveRuns.length - 1; index >= 0; index--) {
        if (liveRuns[index].id === run.id && liveRuns[index].pid === run.pid) liveRuns.splice(index, 1);
    }
    ownedExits.delete(run.id);
}

/** Original two-second teardown budget covers finalization and callback writes. */
export async function settleFixtureRun(receipt, batcher, assertQuiescent) {
    batcher.cancel();
    let timeout;
    try {
        await Promise.race([(async () => {
            await receipt.completion;
            batcher.cancel(); await batcher.settled(); batcher.cancel();
            assertQuiescent();
        })(), new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Owned timing finalizer did not settle")), 2000);
        })]);
    } finally { clearTimeout(timeout); }
}
