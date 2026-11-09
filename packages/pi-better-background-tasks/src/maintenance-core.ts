/**
 * Legacy task-registry maintenance, separated from failure journal imports so
 * the shared Background Tasks coordinator can run the same daily pass inside its
 * emitted standalone closure.
 *
 * Removal is still gated by an explicit authority callback. The coordinator
 * passes the coordinator store's protection check; callers without durable
 * records keep the historical behavior by omitting it.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseDir, listMetas, removeMeta, writeMeta } from "./registry.ts";
import { processIdentityAlive as defaultProcessIdentityAlive } from "./process-identity.ts";
import type { BackgroundTaskCallbackOrigin, BackgroundTaskMeta } from "./types.ts";
import { isTerminalStatus } from "./types.ts";

export const DEFAULT_TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_MAINTENANCE_LOCK_MS = 10 * 60 * 1000;

interface MaintenanceState {
    lastDate?: string;
}

export interface RemovalDecision {
    allowed: boolean;
    reason?: string;
}

export interface TaskMaintenanceCoreOptions {
    now?: number;
    activeOrigin?: BackgroundTaskCallbackOrigin;
    retentionMs?: number;
    processIdentityAlive?: (pid: number | undefined, token?: string, recordedAt?: number) => boolean;
    metas?: BackgroundTaskMeta[];
    force?: boolean;
    /**
     * Retention authority. Returning `{ allowed: false }` keeps the task and
     * reports it as protected instead of deleting it.
     */
    authorizeRemoval?: (meta: BackgroundTaskMeta) => RemovalDecision;
    /** Optional failure-journal hook used by the extension wrapper. */
    onReconciled?: (meta: BackgroundTaskMeta, error: string, at: number) => void;
}

export interface TaskMaintenanceCoreResult {
    ran: boolean;
    reconciled: number;
    removed: number;
    protected: number;
    protectedReasons: string[];
}

export function runTaskMaintenanceCore(options: TaskMaintenanceCoreOptions = {}): TaskMaintenanceCoreResult {
    const now = options.now ?? Date.now();
    const date = new Date(now).toISOString().slice(0, 10);
    const statePath = join(baseDir(), "maintenance-state.json");
    const lockPath = join(baseDir(), "maintenance.lock");
    if (!options.force && readState(statePath).lastDate === date) {
        return { ran: false, reconciled: 0, removed: 0, protected: 0, protectedReasons: [] };
    }
    if (!options.force && !acquireMaintenanceLock(lockPath, now)) {
        return { ran: false, reconciled: 0, removed: 0, protected: 0, protectedReasons: [] };
    }

    let reconciled = 0;
    let removed = 0;
    let protectedCount = 0;
    const protectedReasons: string[] = [];
    try {
        const identityAlive = options.processIdentityAlive ?? defaultProcessIdentityAlive;
        const metas = options.metas ?? listMetas();
        for (const meta of metas) {
            if (meta.status !== "running" || belongsToOrigin(meta, options.activeOrigin)) continue;
            if (identityAlive(meta.spawnPid, meta.spawnPidStartTime, meta.startedAt)) continue;
            if (meta.remote?.session === "tmux") continue;
            if (meta.kind === "process" && identityAlive(meta.pid, meta.pidStartTime, meta.startedAt)) continue;
            meta.status = "failed";
            meta.endedAt = now;
            meta.error = "task supervisor is no longer alive; execution result is unavailable";
            meta.result = { reason: meta.error };
            options.onReconciled?.(meta, meta.error, now);
            writeMeta(meta);
            reconciled += 1;
        }

        const cutoff = now - (options.retentionMs ?? DEFAULT_TASK_RETENTION_MS);
        for (const meta of metas) {
            if (!isTerminalStatus(meta.status)) continue;
            if ((meta.endedAt ?? meta.startedAt) >= cutoff) continue;
            const decision = options.authorizeRemoval?.(meta) ?? {
                allowed: false,
                reason: "retention authority was not supplied; deletion is refused",
            };
            if (!decision.allowed) {
                protectedCount += 1;
                protectedReasons.push(`${meta.id}: ${decision.reason ?? "protected by retention authority"}`);
                continue;
            }
            if (removeMeta(meta)) removed += 1;
        }
        if (!options.force) writeFileSync(statePath, JSON.stringify({ lastDate: date } satisfies MaintenanceState));
        return { ran: true, reconciled, removed, protected: protectedCount, protectedReasons };
    } finally {
        if (!options.force) rmSync(lockPath, { recursive: true, force: true });
    }
}

function readState(path: string): MaintenanceState {
    try { return JSON.parse(readFileSync(path, "utf8")) as MaintenanceState; } catch { return {}; }
}

function acquireMaintenanceLock(path: string, now: number): boolean {
    mkdirSync(baseDir(), { recursive: true });
    try {
        mkdirSync(path);
        return true;
    } catch {
        try {
            if (now - statSync(path).mtimeMs <= STALE_MAINTENANCE_LOCK_MS) return false;
            rmSync(path, { recursive: true, force: true });
            mkdirSync(path);
            return true;
        } catch {
            return false;
        }
    }
}

function belongsToOrigin(meta: BackgroundTaskMeta, active: BackgroundTaskCallbackOrigin | undefined): boolean {
    if (!active) return false;
    const origin = meta.callbackOrigin ?? { cwd: meta.cwd };
    if (origin.cwd !== active.cwd) return false;
    if (origin.sessionId || active.sessionId) return origin.sessionId === active.sessionId;
    return true;
}
