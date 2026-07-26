/**
 * Shared stop / orphaned-cleanup semantics for subagent runs.
 *
 * `stopRun` is the single stop path used by BOTH the model-facing
 * `subagent_stop` tool and the TUI navigator close action (issues #44/#47/#68),
 * so process-group termination and terminal-status recording can never diverge
 * between the two surfaces.
 *
 * Race safety: the run's metadata and effective status are re-read from disk
 * at call time, never taken from a caller's cached copy. A run that finished
 * while a confirmation was pending is reported as not-running instead of
 * being "terminated" against stale state.
 *
 * Orphaned cleanup (#68): when related process-group work is still alive,
 * SIGTERM the recorded group and record durable `killed`. When no related
 * process-group evidence remains, reread the child log and finalize from
 * coherent terminal evidence (`completed` / `failed`) or record `lost`.
 *
 * Process-group-only contract (ADR 0002): related work is the captured
 * process group (pgid, falling back to pid for old metadata). Escaped /
 * reparented descendants outside that group are out of contract and are
 * never scanned for.
 */

import { realProcessProbe, type ProcessProbe } from "./health.ts";
import { parseRunForLifecycle } from "./parse.ts";
import {
    effectiveStatus,
    readMeta,
    writeMeta,
    type RunMeta,
} from "./registry.ts";
import { killProcessTree } from "./spawn.ts";

export type StopOutcome =
    | { action: "stopped"; id: string }
    | { action: "finalized"; id: string; status: "completed" | "failed" | "lost" }
    | { action: "not-running"; id: string; status: string };

export interface StopDeps {
    /** OS process probe; defaults to the real probe. Tests inject fakes. */
    probe?: ProcessProbe;
    /** Clock seam for durable timestamps. */
    now?: () => number;
}

/** Recorded process group for related-work signals (ADR 0002). */
export function relatedProcessGroupId(meta: Pick<RunMeta, "pid" | "pgid">): number | undefined {
    const pgid = meta.pgid ?? meta.pid;
    return typeof pgid === "number" && pgid > 0 ? pgid : undefined;
}

/**
 * True when stop/close may still act on this effective status.
 * `running` is the supervised path; `orphaned` is the #68 cleanup path.
 */
export function isStoppableStatus(status: string): boolean {
    return status === "running" || status === "orphaned";
}

/** SIGTERM the run's related process group. Returns whether a group target existed. */
function terminateRelatedWork(meta: Pick<RunMeta, "pid" | "pgid">): number | undefined {
    const pgid = relatedProcessGroupId(meta);
    if (pgid === undefined) return undefined;
    killProcessTree(pgid, "SIGTERM");
    return pgid;
}

function recordKilled(meta: RunMeta, now: number): StopOutcome {
    meta.status = "killed";
    meta.lifecycleClassification = "killed";
    meta.endedAt = now;
    writeMeta(meta);
    return { action: "stopped", id: meta.id };
}

/**
 * No related process-group evidence remains. Reread logs, then finalize from
 * coherent terminal stream evidence or record durable `lost`.
 */
function finalizeOrphanedWithoutProcess(meta: RunMeta, now: number): StopOutcome {
    // Log authority is reread at cleanup time — never trust a cached parse.
    const run = parseRunForLifecycle(meta.id);

    if (run.sawEnd && run.unmatchedToolCalls.length === 0) {
        meta.status = "completed";
        meta.lifecycleClassification = "complete";
        if (meta.exitCode === undefined) meta.exitCode = 0;
        meta.endedAt = now;
        writeMeta(meta);
        return { action: "finalized", id: meta.id, status: "completed" };
    }

    if (run.sawEnd && run.unmatchedToolCalls.length > 0) {
        meta.status = "failed";
        meta.lifecycleClassification = "incomplete_open_tools";
        meta.failureReason = "incomplete-stream";
        meta.endedAt = now;
        writeMeta(meta);
        return { action: "finalized", id: meta.id, status: "failed" };
    }

    // No coherent terminal completion evidence and no related process remains.
    meta.status = "lost";
    meta.lifecycleClassification = "lost";
    meta.lostAt = now;
    meta.endedAt = now;
    writeMeta(meta);
    return { action: "finalized", id: meta.id, status: "lost" };
}

/**
 * Cleanup path for a durable orphaned run (#68).
 * Shares kill + killed recording with the running-run stop path when the
 * captured process group is still alive; otherwise finalizes from logs.
 */
function cleanupOrphanedRun(meta: RunMeta, probe: ProcessProbe, now: number): StopOutcome {
    const pgid = relatedProcessGroupId(meta);
    if (pgid !== undefined && probe.groupAlive(pgid)) {
        terminateRelatedWork(meta);
        return recordKilled(meta, now);
    }
    return finalizeOrphanedWithoutProcess(meta, now);
}

/**
 * Stop or resolve a run by id.
 *
 * - `running` → SIGTERM related process group, durable `killed`.
 * - `orphaned` → terminate identifiable process-group members when alive;
 *   otherwise reread logs and finalize completed/failed/lost.
 * - other statuses → not-running (on-disk record untouched).
 *
 * Throws on an unknown id (same contract as the stop tool).
 */
export function stopRun(id: string, deps: StopDeps = {}): StopOutcome {
    const meta = readMeta(id);
    if (!meta) throw new Error(`Unknown run id: ${id}`);
    const probe = deps.probe ?? realProcessProbe;
    const now = typeof deps.now === "function" ? deps.now() : Date.now();
    const status = effectiveStatus(meta);

    if (status === "running") {
        // Supervised path: same process-group kill + killed write as before.
        // Prefer recorded pgid so running and orphaned share one target rule.
        terminateRelatedWork(meta);
        return recordKilled(meta, now);
    }

    if (status === "orphaned") {
        return cleanupOrphanedRun(meta, probe, now);
    }

    return { action: "not-running", id, status };
}
