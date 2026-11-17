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
