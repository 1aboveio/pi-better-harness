// Generated fixed launch domain from packages/pi-better-background-tasks/src/supervised-progress.ts. Do not edit directly.
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { backgroundTaskStallThresholds, formatBackgroundTaskStall } from "./stall.domain.mjs";
import { observeStall } from "./shared-stall-detector.domain.mjs";
export function supervisedProgress(source, now = Date.now()) {
    if (source?.status !== "running" || !source.claim)
        return;
    let observedAt;
    try {
        observedAt = JSON.parse(readFileSync(join(dirname(source.logs.stdout), "progress.json"), "utf8")).observedAt;
        if (!Number.isFinite(observedAt) || observedAt < source.claim.claimedAt)
            return;
    }
    catch (error) {
        // Older process runners still have separate append-only streams. Older watches
        // appended every poll, so their logs cannot establish a meaningful progress time.
        if (error.code !== "ENOENT" || source.kind !== "process")
            return;
        observedAt = source.claim.claimedAt;
        for (const path of [source.logs.stdout, source.logs.stderr]) {
            if (!path)
                continue;
            try {
                const stat = statSync(path, { throwIfNoEntry: false });
                if (stat?.size)
                    observedAt = Math.max(observedAt, Math.trunc(stat.mtimeMs));
            }
            catch {
                return;
            }
        }
    }
    const { state, thresholds } = observeStall({ now, lastProgressAt: observedAt, thresholds: backgroundTaskStallThresholds() });
    const quietAt = observedAt + thresholds.quietMs;
    const stalledAt = observedAt + thresholds.stallMs;
    const alertAt = stalledAt + 60_000;
    return { observedAt, state, alertDue: now >= alertAt, nextDeadline: [quietAt, stalledAt, alertAt].find(time => time > now) };
}
export function describeSupervisedProgress(progress, now = Date.now()) {
    return formatBackgroundTaskStall({ ...progress, ageMs: now - progress.observedAt });
}
