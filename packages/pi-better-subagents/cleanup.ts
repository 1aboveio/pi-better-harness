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
    ownedByThisParent,
    readMeta,
    runDir,
    sessionsDir,
    type RunMeta,
    type RunStatus,
} from "./registry.ts";
import type { SubagentConfig } from "./config.ts";

export const DEFAULT_CLEANUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Total registry budget. Age alone cannot bound this directory: 63 GB
 * accumulated inside five days, so a seven-day window never saw it. A
 * `message_update` event re-serialises the whole accumulated message, so one
 * long-running subagent can write gigabytes in an afternoon.
 *
 * Deliberately tight. A single run's log has been observed past 3 GB, so a
 * budget generous enough to hold several of those defeats the purpose: what a
 * developer wants back is the disk, and what they lose is a log nothing reads
 * once its result has been delivered.
 */
export const DEFAULT_MAX_REGISTRY_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

/**
 * How often the size bound may be enforced. Independent of the daily marker:
 * the point of a size cap is to react inside a day, and it only stats run
 * directories rather than walking the session tree.
 */
export const SIZE_SWEEP_INTERVAL_MS = 10 * 60 * 1000; // 10min

interface CleanupState {
    lastLocalDate?: string;
    lastRunAt?: number;
    lastSizeSweepAt?: number;
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

export interface SizeCapEntry {
    id: string;
    status?: RunStatus;
    /** End of the run, when recorded; oldest-first ordering uses it. */
    endedAt?: number;
    dirMtimeMs: number;
    bytes: number;
}

export interface SizeCapPlan {
    remove: string[];
    reclaimedBytes: number;
    keptBytes: number;
    /** The cap could not be met without deleting live or protected runs. */
    overBudget: boolean;
}

export interface SizeCapLimits {
    maxBytes: number;
    /**
     * Runs the calling pi owns. Never removed: unlike the age bound, a size
     * sweep goes after the NEWEST large runs once a cap is exceeded, which is
     * exactly the live session's own work — the session can still deliver their
     * callbacks and answer `subagent_result` for them.
     */
    protectedIds?: ReadonlySet<string>;
}

/**
 * Choose run directories to retire so the registry fits `maxBytes`,
 * oldest-terminal-first. Pure; the caller supplies the entries.
 */
export function planRegistrySizeCap(
    entries: readonly SizeCapEntry[],
    limits: SizeCapLimits,
): SizeCapPlan {
    let kept = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    const remove: string[] = [];
    if (kept <= limits.maxBytes) {
        return { remove, reclaimedBytes: 0, keptBytes: kept, overBudget: false };
    }

    const candidates = entries
        .filter((entry) => entry.status !== undefined
            && TERMINAL_CLEANUP_STATUSES.has(entry.status)
            && !limits.protectedIds?.has(entry.id))
        .sort((a, b) => (a.endedAt ?? a.dirMtimeMs) - (b.endedAt ?? b.dirMtimeMs));

    let reclaimed = 0;
    for (const candidate of candidates) {
        if (kept <= limits.maxBytes) break;
        remove.push(candidate.id);
        kept -= candidate.bytes;
        reclaimed += candidate.bytes;
    }
    return { remove, reclaimedBytes: reclaimed, keptBytes: kept, overBudget: kept > limits.maxBytes };
}

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

/** Bytes held under one run directory. Best-effort; unreadable entries count 0. */
function dirBytes(dir: string): number {
    let bytes = 0;
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return 0;
    }
    for (const entry of entries) {
        const path = join(dir, entry.name);
        try {
            bytes += entry.isDirectory() ? dirBytes(path) : statSync(path).size;
        } catch { /* vanished mid-scan */ }
    }
    return bytes;
}

/** Read the registry into size-cap entries. */
export function collectSizeCapEntries(): SizeCapEntry[] {
    let ids: string[];
    try {
        ids = readdirSync(join(baseDir(), "runs"));
    } catch {
        return [];
    }
    const entries: SizeCapEntry[] = [];
    for (const id of ids) {
        const dir = runDir(id);
        const meta = readMeta(id);
        entries.push({
            id,
            status: meta?.status,
            endedAt: meta ? terminalTimestamp(meta) : undefined,
            dirMtimeMs: safeStatMtime(dir) ?? 0,
            bytes: dirBytes(dir),
        });
    }
    return entries;
}

export interface SizeCapResult extends SizeCapPlan {
    ran: boolean;
    removed: string[];
    errors: string[];
}

export interface SizeCapOptions {
    now?: number;
    config?: Pick<SubagentConfig, "maxRegistryBytes">;
    maxBytes?: number;
    /** Bypass the interval marker (tests, explicit operator sweeps). */
    force?: boolean;
    protectedIds?: ReadonlySet<string>;
}

/**
 * Enforce the registry byte budget, at most once per SIZE_SWEEP_INTERVAL_MS.
 * Complements the daily age sweep: age retires history, this bounds the peak a
 * single busy day can reach. Best-effort; never throws into a caller.
 */
export function enforceRegistrySizeCapOnce(options: SizeCapOptions = {}): SizeCapResult {
    const now = options.now ?? Date.now();
    const idle: SizeCapResult = {
        ran: false,
        remove: [],
        removed: [],
        reclaimedBytes: 0,
        keptBytes: 0,
        overBudget: false,
        errors: [],
    };

    const state = readCleanupState();
    if (!options.force
        && typeof state.lastSizeSweepAt === "number"
        && now - state.lastSizeSweepAt >= 0
        && now - state.lastSizeSweepAt < SIZE_SWEEP_INTERVAL_MS) {
        return idle;
    }

    const configured = options.config?.maxRegistryBytes;
    const maxBytes = options.maxBytes
        ?? (Number.isFinite(configured) && configured! > 0 ? configured! : DEFAULT_MAX_REGISTRY_BYTES);

    const errors: string[] = [];
    const protectedIds = options.protectedIds ?? ownRunIds();
    const plan = planRegistrySizeCap(collectSizeCapEntries(), { maxBytes, protectedIds });
    const removed: string[] = [];
    for (const id of plan.remove) {
        if (removePath(runDir(id), errors)) removed.push(id);
    }

    try {
        writeCleanupState({ ...state, lastSizeSweepAt: now });
    } catch (err) {
        errors.push(`${cleanupStatePath()}: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { ...plan, ran: true, removed, errors };
}

/** Run ids owned by this pi process, which a size sweep must never remove. */
function ownRunIds(): Set<string> {
    const own = new Set<string>();
    try {
        for (const meta of listMetas()) {
            if (ownedByThisParent(meta)) own.add(meta.id);
        }
    } catch { /* registry unreadable: protect nothing, remove nothing new */ }
    return own;
}
