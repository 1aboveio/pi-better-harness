/**
 * Run registry — durable metadata for each spawned subagent.
 *
 * The authoritative record for every run is a `meta.json` sidecar on disk, so
 * `list` / `output` / `result` keep working across foreground turns, `/reload`,
 * and even a full pi restart. In-memory state holds only the live exit handlers
 * for runs this process spawned.
 */

import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processExists } from "./spawn.ts";
import type { LifecycleClassification } from "./lifecycle.ts";

/**
 * Terminal + live statuses as recorded on disk. `orphaned` is durable and
 * NON-terminal (supervision broke, but related processes may still be alive);
 * `lost` is durable and terminal (no related process evidence remains).
 */
export type RunStatus = "running" | "completed" | "failed" | "killed" | "orphaned" | "lost";

/**
 * True when coherent child-exit evidence may finalize a run in this status.
 * `running` is the normal path; `orphaned`/`lost` are PROVISIONAL
 * reconciliation verdicts (a health tick can observe the just-exited pid
 * before the close handler runs) that the real exit — the stronger evidence —
 * supersedes. True terminal records are never overwritten: finalization is
 * idempotent (`completed`/`failed`) and a deliberate `subagent_stop` kill
 * (`killed`) is not undone by the resulting exit.
 */
export function canExitFinalize(status: RunStatus): boolean {
    return status === "running" || status === "orphaned" || status === "lost";
}

export interface RunMeta {
    id: string;
    name?: string;
    status: RunStatus;
    /** Child process PID. */
    pid: number;
    /** Child's process group id, captured at spawn where available (#63). */
    pgid?: number;
    /**
     * Opaque process-start identity token captured at spawn where available
     * (#63). Only equality is meaningful: a different token means the pid was
     * recycled by an unrelated process.
     */
    pidStartTime?: string;
    /** Consecutive pid-gone health ticks with no related evidence (old metadata). */
    probeMisses?: number;
    /** When supervision was observed broken (transition to `orphaned`). */
    orphanedAt?: number;
    /** When the last related process evidence disappeared (transition to `lost`). */
    lostAt?: number;
    /**
     * Durable per-status health-callback handoff markers (#65).
     * Written only after a successful coordinator handoff (sendMessage returned,
     * or callback:false suppressed the model path intentionally). Once set,
     * repeated health ticks and /reload must not re-fire that status. A missing
     * marker on orphaned/lost means recovery must still attempt delivery.
     * Independent of completion callbacks.
     */
    orphanedCallbackSentAt?: number;
    lostCallbackSentAt?: number;
    /** PID of the pi process that launched this run (for cross-restart ownership). */
    spawnPid: number;
    model?: string;
    cwd: string;
    /** First ~200 chars of the task prompt, for listings. */
    promptPreview: string;
    startedAt: number;
    endedAt?: number;
    exitCode?: number | null;
    /** Why an otherwise-zero exit is recorded as a non-success. */
    failureReason?: "incomplete-stream";
    /** Named lifecycle quality from exit/stream validation. */
    lifecycleClassification?: LifecycleClassification;
    logPath: string;
    sessionId: string;
    /** Writable dir the child is OS-sandboxed to, if any. */
    sandbox?: string;
    /** Whether completion posts the result back to the main session (default true). */
    callback?: boolean;
    /** Batch ID for runs launched via subagent_spawn_batch. */
    batchId?: string;
    /** Optional batch display name. */
    batchName?: string;
    /**
     * Durable navigator-dismissal timestamp (ms since epoch). Optional and
     * additive: pre-existing metadata without this field parses unchanged, so
     * no migration is required. Dismissal is navigator-organization ONLY — it
     * never deletes logs, prompt, session data, metadata, or id-based tool
     * access (`subagent_output` / `subagent_result` / `subagent_stop` /
     * `subagent_list` keep working for dismissed runs).
     */
    dismissedAt?: number;
}

/** Root runtime dir, deliberately OUTSIDE any repo. */
export function baseDir(): string {
    return join(tmpdir(), "pi-better-subagents");
}
export function sessionsDir(): string {
    return join(baseDir(), "sessions");
}
export function runDir(id: string): string {
    return join(baseDir(), "runs", id);
}
export function logPathFor(id: string): string {
    return join(runDir(id), "output.log");
}
export function promptPathFor(id: string): string {
    return join(runDir(id), "prompt.md");
}
function metaPathFor(id: string): string {
    return join(runDir(id), "meta.json");
}

let seq = 0;
/** Monotonic, readable, collision-free run id: `sa_<base36-time>_<seq>`. */
export function nextRunId(): string {
    seq += 1;
    return `sa_${Date.now().toString(36)}_${seq}`;
}

export function writeMeta(meta: RunMeta): void {
    mkdirSync(runDir(meta.id), { recursive: true });
    writeFileSync(metaPathFor(meta.id), JSON.stringify(meta, null, 2));
}

export function readMeta(id: string): RunMeta | undefined {
    try {
        return JSON.parse(readFileSync(metaPathFor(id), "utf-8")) as RunMeta;
    } catch {
        return undefined;
    }
}

/** All runs, newest first. */
export function listMetas(): RunMeta[] {
    let ids: string[];
    try {
        ids = readdirSync(join(baseDir(), "runs"));
    } catch {
        return [];
    }
    return ids
        .map(readMeta)
        .filter((m): m is RunMeta => m !== undefined)
        .sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Reconcile the recorded status with reality for display. A run marked
 * "running" whose PID is no longer alive exited without our handler firing
 * (foreground pi was closed / restarted) — surface that as "exited".
 */
export function effectiveStatus(meta: RunMeta): RunStatus | "exited" {
    if (meta.status !== "running") return meta.status;
    if (processExists(meta.pid)) return "running";
    return "exited";
}

/**
 * True when a status can yield a FINAL result: everything except `running`
 * and the non-terminal `orphaned`. `lost` is terminal (best-available
 * artifacts, never a completion); `exited` keeps its historic resultable
 * treatment. Used by subagent_result's gate.
 */
export function isFinalResultStatus(status: RunStatus | "exited"): boolean {
    return status !== "running" && status !== "orphaned";
}

/** True when this meta was spawned by the given parent pi PID (default: this process). */
export function ownedByThisParent(
    meta: Pick<RunMeta, "spawnPid">,
    parentPid: number = process.pid,
): boolean {
    return meta.spawnPid === parentPid;
}

/** True when the run has been dismissed from the human navigator. */
export function isDismissed(meta: Pick<RunMeta, "dismissedAt">): boolean {
    return typeof meta.dismissedAt === "number";
}

/**
 * Mark a run dismissed from the navigator, durably. Idempotent: the first
 * dismissal timestamp wins. Returns the updated meta, or undefined for an
 * unknown id. Only the timestamp changes — all other metadata is preserved.
 */
export function dismissRun(id: string, at: number = Date.now()): RunMeta | undefined {
    const meta = readMeta(id);
    if (!meta) return undefined;
    if (meta.dismissedAt === undefined) {
        meta.dismissedAt = at;
        writeMeta(meta);
    }
    return meta;
}

/**
 * Visible navigator runs: current-parent runs that are not dismissed. This is
 * the single visibility calculation shared by the navigator list and the
 * footer count, so they can never drift apart. `subagent_list` does NOT use
 * this — the model-facing list keeps showing dismissed runs.
 */
export function navigatorVisibleRuns(
    metas: RunMeta[],
    parentPid: number = process.pid,
): RunMeta[] {
    return metas.filter((m) => ownedByThisParent(m, parentPid) && !isDismissed(m));
}

/** Footer-count seam: how many runs the navigator affordance advertises. */
export function navigatorVisibleCount(
    metas: RunMeta[],
    parentPid: number = process.pid,
): number {
    return navigatorVisibleRuns(metas, parentPid).length;
}
