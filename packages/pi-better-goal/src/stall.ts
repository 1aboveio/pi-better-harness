import { observeStall, type StallObservation, type StallThresholds } from "./shared-stall-detector.js";
import type { ContinuationState } from "./goal-state.js";
import type { GoalSnapshot } from "./types.js";

function durationEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export function goalStallThresholds(): Partial<StallThresholds> {
  const thresholds: Partial<StallThresholds> = {};
  const quietMs = durationEnv("PI_BETTER_STALL_QUIET_MS");
  const stallMs = durationEnv("PI_BETTER_STALL_MS");
  if (quietMs !== undefined) thresholds.quietMs = quietMs;
  if (stallMs !== undefined) thresholds.stallMs = stallMs;
  return thresholds;
}

export function observeGoalStall(
  goal: GoalSnapshot | null,
  continuation: ContinuationState | null,
  options: { now?: number; foregroundRunning?: boolean; backgroundRunning?: boolean } = {},
): StallObservation | null {
  if (!goal) return null;
  return observeStall({
    now: options.now ?? Date.now(),
    ...(continuation?.lastProgressAt !== undefined ? { lastProgressAt: continuation.lastProgressAt } : {}),
    startedAt: goal.createdAt * 1000,
    exempt: goal.status !== "active" || options.foregroundRunning === true || options.backgroundRunning === true,
    thresholds: goalStallThresholds(),
  });
}