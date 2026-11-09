import { statSync } from "node:fs";

import { observeStall, type StallObservation, type StallThresholds } from "./shared-stall-detector.js";
import type { BackgroundTaskMeta } from "./types.js";

function durationEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export function backgroundTaskStallThresholds(): Partial<StallThresholds> {
  return {
    quietMs: durationEnv("PI_BETTER_STALL_QUIET_MS"),
    stallMs: durationEnv("PI_BETTER_STALL_MS"),
  };
}

/**
 * Process logs are the only external progress evidence available for detached
 * commands. Watches instead advance only when a poll observes a changed
 * outcome: poll scheduling and a watch's own poll log writes are activity, not
 * progress, so a watch that reports the same thing can still go quiet.
 */
export function backgroundTaskProgressAt(meta: BackgroundTaskMeta): number | undefined {
  if (meta.kind === "command_watch") return meta.lastProgressAt ?? meta.startedAt;
  const recorded = Math.max(meta.lastProgressAt ?? 0, meta.lastCheckedAt ?? 0, meta.startedAt);
  if (meta.kind !== "process") return recorded;
  try {
    const log = statSync(meta.logPath);
    const mtimeMs = Math.trunc(log.mtimeMs);
    if (meta.logMaintenance?.mtimeMs === mtimeMs && meta.logMaintenance.size === log.size) return recorded;
    return Math.max(recorded, mtimeMs);
  } catch {
    return recorded;
  }
}

export function observeBackgroundTaskStall(meta: BackgroundTaskMeta, now = Date.now()): StallObservation {
  return observeStall({
    now,
    lastProgressAt: backgroundTaskProgressAt(meta),
    startedAt: meta.startedAt,
    exempt: meta.status !== "running",
    thresholds: backgroundTaskStallThresholds(),
  });
}

/** Silence is an observation, not proof that the process is hung. */
export function formatBackgroundTaskStall(observation: StallObservation): string | undefined {
  if (observation.state !== "quiet" && observation.state !== "stalled") return undefined;
  const seconds = Math.max(0, Math.round((observation.ageMs ?? 0) / 1000));
  const duration = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${(seconds % 60).toString().padStart(2, "0")}s`;
  const label = observation.state === "stalled" ? "suspected stall" : "quiet";
  return `${label}; no observed progress for ${duration}`;
}
