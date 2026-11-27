// Generated from packages/stall-detector/index.ts. Do not edit directly.
export interface StallThresholds {
  /** Age of observable progress before work becomes quiet. */
  quietMs: number;
  /** Age of observable progress before work becomes stalled. */
  stallMs: number;
}

export type StallState = "healthy" | "quiet" | "stalled" | "unknown";

export interface StallObservation {
  state: StallState;
  /** Most recent meaningful evidence, falling back to the start time. */
  observedAt?: number;
  ageMs?: number;
  thresholds: StallThresholds;
}

export interface ObserveStallInput {
  now: number;
  /** Explicit meaningful progress, never a timer tick or metadata write. */
  lastProgressAt?: number;
  /** Fallback anchor for work that has not produced progress yet. */
  startedAt?: number;
  /** Known active phases that explain a lack of observable progress. */
  exempt?: boolean;
  thresholds?: Partial<StallThresholds>;
}

export const DEFAULT_STALL_THRESHOLDS: Readonly<StallThresholds> = Object.freeze({
  quietMs: 60_000,
  stallMs: 5 * 60_000,
});

function positiveMs(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Normalize caller config and ensure quiet never exceeds the stall threshold. */
export function resolveStallThresholds(partial?: Partial<StallThresholds> | null): StallThresholds {
  const quietMs = positiveMs(partial?.quietMs, DEFAULT_STALL_THRESHOLDS.quietMs);
  const stallMs = positiveMs(partial?.stallMs, DEFAULT_STALL_THRESHOLDS.stallMs);
  return { quietMs: Math.min(quietMs, stallMs), stallMs: Math.max(quietMs, stallMs) };
}

/**
 * Classify the age of observable progress. This is deliberately observational:
 * it does not claim a live process is broken and never performs recovery.
 */
export function observeStall(input: ObserveStallInput): StallObservation {
  const thresholds = resolveStallThresholds(input.thresholds);
  const observedAt = input.lastProgressAt ?? input.startedAt;
  if (typeof observedAt !== "number" || !Number.isFinite(observedAt)) {
    return { state: "unknown", thresholds };
  }

  const ageMs = Math.max(0, input.now - observedAt);
  if (input.exempt) {
    return { state: ageMs >= thresholds.quietMs ? "quiet" : "healthy", observedAt, ageMs, thresholds };
  }
  if (ageMs >= thresholds.stallMs) {
    return { state: "stalled", observedAt, ageMs, thresholds };
  }
  if (ageMs >= thresholds.quietMs) {
    return { state: "quiet", observedAt, ageMs, thresholds };
  }
  return { state: "healthy", observedAt, ageMs, thresholds };
}