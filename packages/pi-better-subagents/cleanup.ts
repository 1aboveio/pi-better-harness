import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import {
    baseDir,
    listMetas,
    readMeta,
    runDir,
    sessionsDir,
    type RunMeta,
    type RunStatus,
} from "./registry.ts";
import type { SubagentConfig } from "./config.ts";

export const DEFAULT_CLEANUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface CleanupState {
    lastLocalDate?: string;
    lastRunAt?: number;
}

export interface DailyCleanupResult {
    ran: boolean;
    dateKey: string;
    removedRunDirs: number;
    removedSessionPaths: number;
    errors: string[];
}

export interface DailyCleanupOptions {
    now?: number;
    config?: Pick<SubagentConfig, "cleanupTerminalRunRetentionMs" | "cleanupSessionRetentionMs">;
    terminalRunRetentionMs?: number;
    sessionRetentionMs?: number;
}

const TERMINAL_CLEANUP_STATUSES = new Set<RunStatus>(["completed", "failed", "killed", "lost"]);

export function cleanupStatePath(): string {
    return join(baseDir(), "cleanup-state.json");
}

export function localDateKey(now: number = Date.now()): string {
    const d = new Date(now);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function readCleanupState(): CleanupState {
    try {
        return JSON.parse(readFileSync(cleanupStatePath(), "utf8")) as CleanupState;
    } catch {
        return {};
    }
}

function writeCleanupState(state: CleanupState): void {
    mkdirSync(baseDir(), { recursive: true });
    writeFileSync(cleanupStatePath(), JSON.stringify(state, null, 2));
}

function retentionMs(explicit: number | undefined, configured: number | null | undefined): number {
    const raw = explicit ?? configured;
    return Number.isFinite(raw) && raw! >= 0 ? raw! : DEFAULT_CLEANUP_RETENTION_MS;
}

function terminalTimestamp(meta: RunMeta): number {
    return meta.endedAt ?? meta.lostAt ?? meta.startedAt;
}

function safeStatMtime(path: string): number | undefined {
    try {
        return statSync(path).mtimeMs;
    } catch {
        return undefined;
    }
}

function removePath(path: string, errors: string[]): boolean {
    try {
        rmSync(path, { recursive: true, force: true });
        return true;
    } catch (err) {
        errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}

function cleanRunDirs(cutoff: number, errors: string[]): number {
    let removed = 0;
    let ids: string[];
    try {
        ids = readdirSync(join(baseDir(), "runs"));
    } catch {
        return 0;
    }

    for (const id of ids) {
        const dir = runDir(id);
        const meta = readMeta(id);
        if (meta) {
            if (!TERMINAL_CLEANUP_STATUSES.has(meta.status)) continue;
            if (terminalTimestamp(meta) >= cutoff) continue;
            if (removePath(dir, errors)) removed += 1;
            continue;
        }

        const mtimeMs = safeStatMtime(dir);
        if (mtimeMs !== undefined && mtimeMs < cutoff && removePath(dir, errors)) removed += 1;
    }
    return removed;
}

function activeSessionIds(metas: RunMeta[]): Set<string> {
    const active = new Set<string>();
    for (const meta of metas) {
        if (meta.status === "running" || meta.status === "orphaned") active.add(meta.sessionId);
    }
    return active;
}

function pathMentionsActiveSession(path: string, active: Set<string>): boolean {
    if (active.size === 0) return false;
    const rel = relative(sessionsDir(), path);
    for (const sessionId of active) {
        if (sessionId && rel.includes(sessionId)) return true;
    }
    return false;
}

function cleanSessionTree(cutoff: number, active: Set<string>, errors: string[]): number {
    const root = sessionsDir();
    if (!existsSync(root)) return 0;
    let removed = 0;

    const visit = (dir: string): boolean => {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch (err) {
            errors.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }

        let empty = true;
        for (const entry of entries) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                const childEmpty = visit(path);
                if (childEmpty && !pathMentionsActiveSession(path, active)) {
                    const mtimeMs = safeStatMtime(path);
                    if (mtimeMs !== undefined && mtimeMs < cutoff && removePath(path, errors)) {
                        removed += 1;
                        continue;
                    }
                }
                empty = false;
                continue;
            }

            if (pathMentionsActiveSession(path, active)) {
                empty = false;
                continue;
            }
            const mtimeMs = safeStatMtime(path);
            if (mtimeMs !== undefined && mtimeMs < cutoff && removePath(path, errors)) {
                removed += 1;
                continue;
            }
            empty = false;
        }
        return empty;
    };

    visit(root);
    return removed;
}

export function runDailyCleanupOnce(options: DailyCleanupOptions = {}): DailyCleanupResult {
    const now = options.now ?? Date.now();
    const dateKey = localDateKey(now);
    const state = readCleanupState();
    if (state.lastLocalDate === dateKey) {
        return { ran: false, dateKey, removedRunDirs: 0, removedSessionPaths: 0, errors: [] };
    }

    const errors: string[] = [];
    const terminalRetention = retentionMs(options.terminalRunRetentionMs, options.config?.cleanupTerminalRunRetentionMs);
    const sessionRetention = retentionMs(options.sessionRetentionMs, options.config?.cleanupSessionRetentionMs);
    const metas = listMetas();
    const removedRunDirs = cleanRunDirs(now - terminalRetention, errors);
    const removedSessionPaths = cleanSessionTree(now - sessionRetention, activeSessionIds(metas), errors);

    try {
        writeCleanupState({ lastLocalDate: dateKey, lastRunAt: now });
    } catch (err) {
        errors.push(`${cleanupStatePath()}: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { ran: true, dateKey, removedRunDirs, removedSessionPaths, errors };
}
