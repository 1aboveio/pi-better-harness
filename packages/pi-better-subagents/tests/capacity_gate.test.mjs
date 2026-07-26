// @covers subagent-spawn-batch.capacity-admission
// @level unit
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    availableSlots,
    createCapacityGate,
    formatCapacityRejectMessage,
} from "../capacity.mjs";
import { planBatchLaunches } from "../batch.mjs";

describe("capacity gate — shared admission accounting", () => {
    it("availableSlots subtracts both running and pending reservations", () => {
        assert.equal(availableSlots({ runningCount: 1, pendingCount: 1, maxConcurrent: 4 }), 2);
        assert.equal(availableSlots({ runningCount: 4, pendingCount: 0, maxConcurrent: 4 }), 0);
        assert.equal(availableSlots({ runningCount: 0, pendingCount: 2, maxConcurrent: 2 }), 0);
    });

    it("tryReserve is all-or-nothing for the requested count", () => {
        let running = 0;
        const gate = createCapacityGate(() => running);
        assert.equal(gate.tryReserve(2, 2), true);
        assert.equal(gate.pending, 2);
        // Cannot oversubscribe with another reservation while slots are held.
        assert.equal(gate.tryReserve(1, 2), false);
        assert.equal(gate.pending, 2);
    });

    it("commit converts a reservation into a running slot without freeing capacity", () => {
        let running = 0;
        const gate = createCapacityGate(() => running);
        assert.equal(gate.tryReserve(2, 2), true);
        running += 1;
        gate.commit(1);
        assert.equal(gate.pending, 1);
        assert.equal(gate.tryReserve(1, 2), false);
        running += 1;
        gate.commit(1);
        assert.equal(gate.pending, 0);
        assert.equal(running, 2);
        assert.equal(gate.tryReserve(1, 2), false);
    });

    it("release frees capacity for backfill after a pre-spawn failure", () => {
        let running = 1;
        const gate = createCapacityGate(() => running);
        // One free slot.
        assert.equal(gate.tryReserve(1, 2), true);
        // Simulated pre-spawn failure: release without creating a running meta.
        gate.release(1);
        assert.equal(gate.pending, 0);
        // Later job can take the same slot (launch-available backfill).
        assert.equal(gate.tryReserve(1, 2), true);
        running += 1;
        gate.commit(1);
        assert.equal(running, 2);
    });

    it("models reject-mode batch vs interleaved single-spawn without oversubscribe", () => {
        // Counterexample from review: maxConcurrent=2, batch of 2, concurrent single.
        let running = 0;
        const gate = createCapacityGate(() => running);
        const max = 2;

        // Batch admits first and reserves the whole batch.
        assert.equal(gate.tryReserve(2, max), true);

        // Single-spawn interleaves before any batch job commits — must be refused.
        assert.equal(gate.tryReserve(1, max), false);

        // Batch launches job 1 (yield point would be here in async code).
        running += 1;
        gate.commit(1);

        // Single-spawn still must not sneak into the second reserved slot.
        assert.equal(gate.tryReserve(1, max), false);

        // Batch launches job 2.
        running += 1;
        gate.commit(1);

        assert.equal(running, 2);
        assert.equal(gate.pending, 0);
        assert.ok(running <= max, "must never exceed maxConcurrent");
    });

    it("models single-spawn first: reject batch stays all-or-nothing", () => {
        let running = 0;
        const gate = createCapacityGate(() => running);
        const max = 2;

        assert.equal(gate.tryReserve(1, max), true); // single
        // Batch of 2 cannot partially admit into the remaining 1 slot.
        assert.equal(gate.tryReserve(2, max), false);
        running += 1;
        gate.commit(1);
        assert.equal(running, 1);
        assert.equal(gate.pending, 0);
    });

    it("planBatchLaunches reject accounts for pending reservations", () => {
        assert.throws(
            () =>
                planBatchLaunches({
                    jobs: [{ name: "a" }, { name: "b" }],
                    runningCount: 0,
                    pendingCount: 1,
                    maxConcurrent: 2,
                    onCapacity: "reject",
                }),
            /Batch of 2 jobs exceeds available capacity \(1\/2 subagent slots free\)/,
        );
    });

    it("formatCapacityRejectMessage matches planBatchLaunches wording", () => {
        const msg = formatCapacityRejectMessage({
            jobCount: 3,
            runningCount: 2,
            pendingCount: 0,
            maxConcurrent: 4,
        });
        assert.match(msg, /Batch of 3 jobs exceeds available capacity \(2\/4 subagent slots free\)/);
    });
});
