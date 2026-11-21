import { failurePath, recordFailure, recoverFailure } from "./failures.js";
import { actionableFailures, failureIdentity, readFailureState } from "./shared-failure-observations.js";
import { formatBackgroundTaskStall, observeBackgroundTaskStall } from "./stall.js";
import type { BackgroundTaskMeta } from "./types.js";

const STALL_OPERATION = "suspected-stall";

/** Observe silence without changing lifecycle. The caller schedules existing failure attention on true. */
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

  recordFailure(meta, STALL_OPERATION, formatBackgroundTaskStall(observation)!, eventKey, { category: "stall", at: now });
  const previousActionable = new Set(actionableFailures(before).map((incident) => incident.id));
  return actionableFailures(readFailureState(path))
    .some((incident) => incident.id === incidentId && !previousActionable.has(incident.id));
}
