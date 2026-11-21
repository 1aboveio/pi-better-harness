// Generated fixed launch domain from packages/pi-better-background-tasks/src/maintenance.ts. Do not edit directly.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordFailure } from "./failures.domain.mjs";
import { baseDir, listMetas, removeMeta, writeMeta } from "./registry.domain.mjs";
import { processIdentityAlive as defaultProcessIdentityAlive } from "./process-identity.domain.mjs";
import { isTerminalStatus } from "./types.domain.mjs";
export const DEFAULT_TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_MAINTENANCE_LOCK_MS = 10 * 60 * 1000;
export function runTaskMaintenance(options = {}) {
    const now = options.now ?? Date.now();
    const date = new Date(now).toISOString().slice(0, 10);
    const statePath = join(baseDir(), "maintenance-state.json");
    const lockPath = join(baseDir(), "maintenance.lock");
    if (!options.force && readState(statePath).lastDate === date)
        return { ran: false, reconciled: 0, removed: 0 };
    if (!options.force && !acquireMaintenanceLock(lockPath, now))
        return { ran: false, reconciled: 0, removed: 0 };
    let reconciled = 0;
    let removed = 0;
    try {
        const identityAlive = options.processIdentityAlive ?? defaultProcessIdentityAlive;
        const metas = options.metas ?? listMetas();
        for (const meta of metas) {
            if (meta.status !== "running" || belongsToOrigin(meta, options.activeOrigin))
                continue;
            if (identityAlive(meta.spawnPid, meta.spawnPidStartTime, meta.startedAt))
                continue;
            if (meta.remote?.session === "tmux")
                continue;
            if (meta.kind === "process" && identityAlive(meta.pid, meta.pidStartTime, meta.startedAt))
                continue;
            meta.status = "failed";
            meta.endedAt = now;
            meta.error = "task supervisor is no longer alive; execution result is unavailable";
            meta.result = { reason: meta.error };
            recordFailure(meta, "execution", meta.error, "supervisor-lost", { incomplete: true, at: now });
            writeMeta(meta);
            reconciled += 1;
        }
        const cutoff = now - (options.retentionMs ?? DEFAULT_TASK_RETENTION_MS);
        for (const meta of metas) {
            if (!isTerminalStatus(meta.status))
                continue;
            if ((meta.endedAt ?? meta.startedAt) >= cutoff)
                continue;
            if (removeMeta(meta))
                removed += 1;
        }
        if (!options.force)
            writeFileSync(statePath, JSON.stringify({ lastDate: date }));
        return { ran: true, reconciled, removed };
    }
    finally {
        if (!options.force)
            rmSync(lockPath, { recursive: true, force: true });
    }
}
function readState(path) {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return {};
    }
}
function acquireMaintenanceLock(path, now) {
    mkdirSync(baseDir(), { recursive: true });
    try {
        mkdirSync(path);
        return true;
    }
    catch {
        try {
            if (now - statSync(path).mtimeMs <= STALE_MAINTENANCE_LOCK_MS)
                return false;
            rmSync(path, { recursive: true, force: true });
            mkdirSync(path);
            return true;
        }
        catch {
            return false;
        }
    }
}
function belongsToOrigin(meta, active) {
    if (!active)
        return false;
    const origin = meta.callbackOrigin ?? { cwd: meta.cwd };
    if (origin.cwd !== active.cwd)
        return false;
    if (origin.sessionId || active.sessionId)
        return origin.sessionId === active.sessionId;
    return true;
}
