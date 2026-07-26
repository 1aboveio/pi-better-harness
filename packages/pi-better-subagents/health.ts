/**
 * Subagent health reconciliation (issue #63) — durable supervision statuses.
 *
 * Process-group-only contract (ADR 0002): `reconcileRun` takes run metadata
 * plus a `ProcessProbe` and decides the next durable status. A supervised run
 * stays `running`; a run whose recorded child is gone but whose captured
 * process group still has live members becomes durable non-terminal
 * `orphaned`; a run with no credible process-group evidence becomes durable
 * terminal `lost`. Escaped/reparented descendants are out of contract — this
 * slice never scans the process tree for related work. Nothing here kills
 * processes — reconciliation only writes truth.
 *
 * `realProcessProbe` is the OS-backed probe used in production; unit tests
 * inject fakes so supervised/orphaned/lost/recycled cases are deterministic.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { processExists } from "./spawn.ts";
import { ownedByThisParent, type RunMeta, type RunStatus } from "./registry.ts";

/** Consecutive pid-gone ticks required before OLD metadata may be written `lost`. */
export const OLD_METADATA_LOST_CONFIRM_TICKS = 2;

/**
 * Process evidence probe. Every method is best-effort and never throws.
 *
 * #63 deliberately exposes only process-group evidence. There is no
 * `descendants` method: escaped/reparented children are not related work for
 * this slice (see docs/adr/0002-process-group-only-subagent-health.md).
 */
export interface ProcessProbe {
    /** The pid currently exists (signal 0; EPERM counts as existing). */
    pidExists(pid: number): boolean;
    /**
     * Opaque process-start identity token for a live pid, or undefined when
     * unavailable. Equality is the only supported operation: a DIFFERENT token
     * proves the pid was recycled; an unavailable token proves nothing.
     */
    startToken(pid: number): string | undefined;
    /** Process group id of a live pid, or undefined when unavailable. */
    groupId(pid: number): number | undefined;
    /** Any member of process group `pgid` is alive (EPERM counts as alive). */
    groupAlive(pgid: number): boolean;
}

/** Process identity recorded on a new run's metadata (all best-effort). */
export interface ProcessIdentity {
    pgid?: number;
    pidStartTime?: string;
}

/** Capture process identity for a freshly spawned child. Never throws. */
export function captureProcessIdentity(pid: number, probe: ProcessProbe = realProcessProbe): ProcessIdentity {
    const identity: ProcessIdentity = {};
    try {
        const pgid = probe.groupId(pid);
        if (typeof pgid === "number" && pgid > 0) identity.pgid = pgid;
    } catch { /* unavailable */ }
    try {
        const token = probe.startToken(pid);
        if (typeof token === "string" && token !== "") identity.pidStartTime = token;
    } catch { /* unavailable */ }
    return identity;
}

/** The subset of run metadata reconciliation reads and writes. */
export type ReconcileInput = Pick<
    RunMeta,
    "status" | "pid" | "pgid" | "pidStartTime" | "probeMisses"
>;

export interface ReconcileResult {
    /** Next durable status (unchanged unless `transition`). */
    status: RunStatus;
    /** Meta must be rewritten (status and/or patch fields changed). */
    changed: boolean;
    /** Durable status transitioned (notify-worthy). */
    transition: boolean;
    /** Fields to merge into the persisted meta. */
    patch: Partial<Pick<RunMeta, "probeMisses" | "orphanedAt" | "lostAt" | "endedAt">>;
    /** Machine-readable reason, for diagnostics and tests. */
    reason:
        | "terminal-untouched"
        | "supervised"
        | "orphaned-group-alive"
        | "orphaned-kept"
        | "lost-no-evidence"
        | "lost-confirmed-old-metadata"
        | "lost-suspected-old-metadata";
}

/**
 * Supervised ⇔ the recorded pid exists AND its start-time identity still
 * matches when both sides of the comparison are available. A missing recorded
 * token (old metadata) or an unavailable probe token can disprove nothing.
 */
function isSupervised(meta: ReconcileInput, probe: ProcessProbe): boolean {
    if (!probe.pidExists(meta.pid)) return false;
    if (meta.pidStartTime === undefined) return true;
    const token = probe.startToken(meta.pid);
    if (token === undefined) return true;
    return token === meta.pidStartTime;
}

/**
 * Related work for #63 is live process-group evidence only.
 *
 * Uses the recorded pgid, falling back to the pid itself — detached children
 * are expected to be process-group leaders (pgid == pid), so the fallback is
 * valid for old metadata too. That inference is conservative: it may delay
 * `lost`, but it never manufactures completion or failure. No process-tree /
 * descendant scan is consulted.
 */
function hasProcessGroupEvidence(meta: ReconcileInput, probe: ProcessProbe): boolean {
    const pgid = meta.pgid ?? meta.pid;
    return typeof pgid === "number" && pgid > 0 && probe.groupAlive(pgid);
}

/**
 * Reconcile one run's durable status against process reality. Pure: the
 * caller persists. Only `running` and `orphaned` are reconciled — `lost`,
 * `completed`, `failed`, and `killed` are durable terminal and never revert.
 */
export function reconcileRun(meta: ReconcileInput, probe: ProcessProbe, now: number): ReconcileResult {
    const stay = (reason: ReconcileResult["reason"]): ReconcileResult =>
        ({ status: meta.status, changed: false, transition: false, patch: {}, reason });

    if (meta.status !== "running" && meta.status !== "orphaned") {
        return stay("terminal-untouched");
    }

    // Orphaned is durable non-terminal: it never auto-reverts to running. It
    // only advances to lost when the last process-group evidence disappears.
    // A live, identity-matched child is itself conclusive related evidence —
    // an earlier orphaned write based on a transient probe failure must never
    // degrade a supervised-alive child to lost.
    if (meta.status === "orphaned") {
        if (isSupervised(meta, probe) || hasProcessGroupEvidence(meta, probe)) {
            return stay("orphaned-kept");
        }
        return {
            status: "lost", changed: true, transition: true,
            patch: { lostAt: now, endedAt: now, probeMisses: 0 },
            reason: "lost-no-evidence",
        };
    }

    if (isSupervised(meta, probe)) {
        if ((meta.probeMisses ?? 0) > 0) {
            return {
                status: "running", changed: true, transition: false,
                patch: { probeMisses: 0 }, reason: "supervised",
            };
        }
        return stay("supervised");
    }

    if (hasProcessGroupEvidence(meta, probe)) {
        return {
            status: "orphaned", changed: true, transition: true,
            patch: { orphanedAt: now, probeMisses: 0 },
            reason: "orphaned-group-alive",
        };
    }

    // No process-group evidence. Metadata WITH recorded process identity is
    // conclusive on its own; OLD metadata (no pgid, no start token) must
    // confirm the loss across health ticks before the terminal write.
    // Evidence quality — not file age — drives that confirmation.
    const hasIdentity = meta.pgid !== undefined || meta.pidStartTime !== undefined;
    if (hasIdentity) {
        return {
            status: "lost", changed: true, transition: true,
            patch: { lostAt: now, endedAt: now, probeMisses: 0 },
            reason: "lost-no-evidence",
        };
    }
    const misses = (meta.probeMisses ?? 0) + 1;
    if (misses >= OLD_METADATA_LOST_CONFIRM_TICKS) {
        return {
            status: "lost", changed: true, transition: true,
            patch: { lostAt: now, endedAt: now, probeMisses: misses },
            reason: "lost-confirmed-old-metadata",
        };
    }
    return {
        status: "running", changed: true, transition: false,
        patch: { probeMisses: misses },
        reason: "lost-suspected-old-metadata",
    };
}

/**
 * True while any current-parent run still needs the health ticker:
 * - `running` / `orphaned` for process-group reconciliation (#63), or
 * - `lost` without a successful health-callback handoff marker, so durable
 *   coordinator recovery can still fire after reload (#65).
 * The scheduler stops when false.
 */
export function needsMonitoring(
    metas: ReadonlyArray<Pick<RunMeta, "spawnPid" | "status" | "lostCallbackSentAt">>,
    parentPid: number = process.pid,
): boolean {
    return metas.some(
        (m) => ownedByThisParent(m, parentPid) && (
            m.status === "running"
            || m.status === "orphaned"
            || (m.status === "lost" && m.lostCallbackSentAt === undefined)
        ),
    );
}

// ---- real OS-backed probe -------------------------------------------------

/** Linux: start-time identity from /proc/<pid>/stat field 22 (jiffies since boot). */
function linuxStartToken(pid: number): string | undefined {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
        // comm (field 2) may contain spaces/parens; fields resume after ") ".
        const close = stat.lastIndexOf(") ");
        if (close < 0) return undefined;
        const rest = stat.slice(close + 2).split(" ");
        // rest[0] is field 3 (state); field 22 (starttime) is index 19.
        const starttime = rest[19];
        return starttime && /^\d+$/.test(starttime) ? starttime : undefined;
    } catch {
        return undefined;
    }
}

/** Portable fallback: `ps -o lstart=` (locale-pinned, whitespace-normalized). */
function psStartToken(pid: number): string | undefined {
    try {
        const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
            encoding: "utf-8",
            timeout: 3000,
            env: { ...process.env, LC_ALL: "C" },
            stdio: ["ignore", "pipe", "ignore"],
        }).trim().replace(/\s+/g, " ");
        return out === "" ? undefined : out;
    } catch {
        return undefined;
    }
}

/** Run `ps <args>` and parse a single integer from stdout. undefined on failure. */
function psNumber(args: string[]): number | undefined {
    try {
        const out = execFileSync("ps", args, {
            encoding: "utf-8",
            timeout: 3000,
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        const n = Number(out);
        return Number.isInteger(n) && n > 0 ? n : undefined;
    } catch {
        return undefined;
    }
}

// Re-export observation seam so health consumers can import from one module.
export {
    DEFAULT_HEALTH_THRESHOLDS,
    extractChildEventFacts,
    extractChildEventFactsFromLog,
    loadHealthThresholdsFromConfig,
    observeRunHealth,
    resolveHealthThresholds,
} from "./health-observation.ts";
export type {
    ActivityHealth,
    ChildEventFacts,
    HealthObservation,
    HealthThresholds,
    ObserveRunHealthInput,
    RawLogDiagnostic,
} from "./health-observation.ts";

export const realProcessProbe: ProcessProbe = {
    pidExists: (pid) => processExists(pid),
    startToken: (pid) => linuxStartToken(pid) ?? psStartToken(pid),
    groupId: (pid) => {
        try {
            if (typeof process.getpgid === "function") return process.getpgid(pid);
        } catch {
            return undefined;
        }
        // process.getpgid is missing on some builds (e.g. macOS); fall back to ps.
        return psNumber(["-o", "pgid=", "-p", String(pid)]);
    },
    groupAlive: (pgid) => {
        if (typeof pgid !== "number" || pgid <= 0) return false;
        try {
            process.kill(-pgid, 0);
            return true;
        } catch (err) {
            // EPERM: the group exists but is not ours to signal — still alive,
            // and "alive" is the safe direction (it can only delay `lost`).
            return (err as NodeJS.ErrnoException).code === "EPERM";
        }
    },
};
