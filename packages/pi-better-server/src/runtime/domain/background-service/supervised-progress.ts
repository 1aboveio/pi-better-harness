import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { backgroundTaskStallThresholds, formatBackgroundTaskStall } from "./stall.js";
import { observeStall } from "./shared-stall-detector.js";

interface ProgressSource {
  status: string;
  kind: string;
  claim?: { claimedAt: number };
  logs: { stdout: string; stderr?: string };
}

export function supervisedProgress(source: ProgressSource | undefined, now = Date.now()) {
  if (source?.status !== "running" || !source.claim) return;
  let observedAt: number;
  try {
    observedAt = JSON.parse(readFileSync(join(dirname(source.logs.stdout), "progress.json"), "utf8")).observedAt;
    if (!Number.isFinite(observedAt) || observedAt < source.claim.claimedAt) return;
  } catch (error) {
    // Older process runners still have separate append-only streams. Older watches
    // appended every poll, so their logs cannot establish a meaningful progress time.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || source.kind !== "process") return;
    observedAt = source.claim.claimedAt;
    for (const path of [source.logs.stdout, source.logs.stderr]) {
      if (!path) continue;
      try {
        const stat = statSync(path, { throwIfNoEntry: false });
        if (stat?.size) observedAt = Math.max(observedAt, Math.trunc(stat.mtimeMs));
      } catch { return; }
    }
  }
  const { state, thresholds } = observeStall({ now, lastProgressAt: observedAt, thresholds: backgroundTaskStallThresholds() });
  const quietAt = observedAt + thresholds.quietMs;
  const stalledAt = observedAt + thresholds.stallMs;
  const alertAt = stalledAt + 60_000;
  return { observedAt, state, alertDue: now >= alertAt, nextDeadline: [quietAt, stalledAt, alertAt].find(time => time > now) };
}

export type SupervisedProgress = NonNullable<ReturnType<typeof supervisedProgress>>;

export function describeSupervisedProgress(progress: SupervisedProgress, now = Date.now()) {
  return formatBackgroundTaskStall({ ...progress, ageMs: now - progress.observedAt });
}
