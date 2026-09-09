import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseDir, listMetas, removeMeta, writeMeta } from "./registry.js";
import { processIdentityAlive as defaultProcessIdentityAlive } from "./process-identity.js";
import type { BackgroundTaskCallbackOrigin, BackgroundTaskMeta } from "./types.js";
import { isTerminalStatus } from "./types.js";

export const DEFAULT_TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_MAINTENANCE_LOCK_MS = 10 * 60 * 1000;

interface MaintenanceState {
  lastDate?: string;
}

export interface TaskMaintenanceOptions {
  now?: number;
  activeOrigin?: BackgroundTaskCallbackOrigin;
  retentionMs?: number;
  processIdentityAlive?: (pid: number | undefined, token?: string, recordedAt?: number) => boolean;
  metas?: BackgroundTaskMeta[];
  force?: boolean;
}

export interface TaskMaintenanceResult {
  ran: boolean;
  reconciled: number;
  removed: number;
}

export function runTaskMaintenance(options: TaskMaintenanceOptions = {}): TaskMaintenanceResult {
  const now = options.now ?? Date.now();
  const date = new Date(now).toISOString().slice(0, 10);
  const statePath = join(baseDir(), "maintenance-state.json");
  const lockPath = join(baseDir(), "maintenance.lock");
  if (!options.force && readState(statePath).lastDate === date) return { ran: false, reconciled: 0, removed: 0 };
  if (!options.force && !acquireMaintenanceLock(lockPath, now)) return { ran: false, reconciled: 0, removed: 0 };

  let reconciled = 0;
  let removed = 0;
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
      writeMeta(meta);
      reconciled += 1;
    }

    const cutoff = now - (options.retentionMs ?? DEFAULT_TASK_RETENTION_MS);
    for (const meta of metas) {
      if (!isTerminalStatus(meta.status)) continue;
      if ((meta.endedAt ?? meta.startedAt) >= cutoff) continue;
      if (removeMeta(meta)) removed += 1;
    }
    if (!options.force) writeFileSync(statePath, JSON.stringify({ lastDate: date } satisfies MaintenanceState));
    return { ran: true, reconciled, removed };
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