/**
 * Shared capacity admission for subagent_spawn and subagent_spawn_batch.
 *
 * Running metas alone are not enough: between "admit" and "writeMeta" an
 * async yield can let another spawn oversubscribe maxConcurrent. This gate
 * keeps in-process pending reservations that count against the same cap for
 * every spawn path in the parent process.
 *
 * Contract:
 *   - tryReserve(n) is all-or-nothing for n slots.
 *   - commit(n) after a run becomes "running" (pending → running).
 *   - release(n) after a pre-spawn failure (pending freed for backfill).
 *   - available = max(0, maxConcurrent - running - pending).
 */

/**
 * Free slots after subtracting durable running metas and in-flight reservations.
 */
export function availableSlots({ runningCount, pendingCount = 0, maxConcurrent }) {
    return Math.max(0, maxConcurrent - runningCount - pendingCount);
}

/**
 * Error text for reject-mode whole-batch capacity failure. Kept identical to
 * planBatchLaunches so callers can throw without re-planning.
 */
export function formatCapacityRejectMessage({
    jobCount,
    runningCount,
    pendingCount = 0,
    maxConcurrent,
}) {
    const available = availableSlots({ runningCount, pendingCount, maxConcurrent });
    return (
        `Batch of ${jobCount} jobs exceeds available capacity ` +
        `(${available}/${maxConcurrent} subagent slots free). ` +
        'Stop some runs or set onCapacity to "launch-available".'
    );
}

/**
 * Process-local capacity gate. One instance is shared by single-spawn and
 * batch-spawn so reservations cannot race each other inside the parent.
 *
 * @param {() => number} countRunning durable running metas owned by this parent
 */
export function createCapacityGate(countRunning) {
    let pending = 0;

    return {
        get pending() {
            return pending;
        },

        /**
         * Reserve `count` slots atomically against current running+pending.
         * Returns false without mutating state when capacity is insufficient.
         */
        tryReserve(count, maxConcurrent) {
            if (count <= 0) return true;
            const available = availableSlots({
                runningCount: countRunning(),
                pendingCount: pending,
                maxConcurrent,
            });
            if (count > available) return false;
            pending += count;
            return true;
        },

        /** Convert reserved slots into durable running occupancy. */
        commit(count = 1) {
            if (count <= 0) return;
            if (count > pending) {
                throw new Error(
                    `capacity commit(${count}) exceeds pending reservations (${pending})`,
                );
            }
            pending -= count;
        },

        /** Free reserved slots that never became a running run (pre-spawn failure). */
        release(count = 1) {
            if (count <= 0) return;
            if (count > pending) {
                throw new Error(
                    `capacity release(${count}) exceeds pending reservations (${pending})`,
                );
            }
            pending -= count;
        },
    };
}

/** Singleton used by the extension so single and batch tools share one ledger. */
let sharedGate;

/**
 * Return the process-wide gate, creating it with `countRunning` on first use.
 * Tests may call `_resetSharedCapacityGateForTests` between cases.
 */
export function getSharedCapacityGate(countRunning) {
    if (!sharedGate) {
        sharedGate = createCapacityGate(countRunning);
    }
    return sharedGate;
}

/** Test-only: drop the singleton so a suite starts from a clean ledger. */
export function _resetSharedCapacityGateForTests() {
    sharedGate = undefined;
}
