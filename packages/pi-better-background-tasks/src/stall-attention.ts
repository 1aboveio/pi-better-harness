import { failurePath, recordFailure, recoverFailure } from "./failures.js";
import { failureIdentity, readFailureState } from "./shared-failure-observations.js";
import { formatBackgroundTaskStall, observeBackgroundTaskStall } from "./stall.js";
import type { BackgroundTaskMeta } from "./types.js";

const STALL_OPERATION = "suspected-stall";

/** Record silent spells for inspection, without escalating silence into a failure notification. */
export function observeTaskStallAttention(meta: BackgroundTaskMeta, now = Date.now()): boolean {
  if (meta.status !== "running") {
    recoverFailure(meta, STALL_OPERATION, ["terminal", meta.status], now);
    return false;
  }
  const observation = observeBackgroundTaskStall(meta, now);
  if (observation.observedAt === undefined || observation.state === "unknown") return false;

  const path = failurePath(meta.id);
  const before = readFailureState(path);
  const prior = before.observations[failureIdentity(STALL_OPERATION)];
  const eventKey = observation.observedAt;
  const incidentId = failureIdentity(meta.id, STALL_OPERATION, eventKey);

  // A new progress anchor ends the previous spell, even if the monitor missed the healthy interval.
  if (prior && prior.id !== incidentId) recoverFailure(meta, STALL_OPERATION, eventKey, now);
  if (observation.state !== "stalled") return false;

  if (prior?.id !== incidentId) {
    recordFailure(meta, STALL_OPERATION, formatBackgroundTaskStall(observation)!, eventKey, { category: "stall", at: now });
  }
  // This remains an inspectable observation; silence alone never wakes the parent.
  return false;
}
