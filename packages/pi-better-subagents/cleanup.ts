import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import {
    baseDir,
    listMetas,
    observeArchivePublication,
    ownedByThisParent,
    orphanedTaskRuntimeProvenance,
    processStartToken,
    readMeta,
    removeMetaArtifacts,
    removeRunDirectory,
    removeTaskRuntimeProvenance,
    runDir,
    sessionsDir,
    type RunMeta,
    type RunStatus,
} from "./registry.ts";
import type { SubagentConfig } from "./config.ts";
import {
    ConversationBusyError,
    ConversationLockUnavailableError,
    conversationLeaseDir,
    readConversationLease,
    readRetention,
    retainedRunIds,
    retainedSessionIds,
    withConversationMutation,
} from "./continuation.ts";
import { processExists } from "./spawn.ts";
import { archiveCompletedAttempt, archivePublicationPending, listArchivedAttempts } from "./session-store.ts";

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

/**
 * How long one conversation's cleanup step may wait for its mutation lock.
 * Admission fails fast (0) and release/retention wait a second; cleanup is a
 * background sweep, so it waits just long enough to lose gracefully to an
 * in-flight admission and then retains the resource.
 */
const CLEANUP_LOCK_WAIT_MS = 250;

/** Conversation ids the per-conversation mutation lock accepts. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

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
    /**
     * Artifacts a caller has already validated and is about to use. A launch
     * path that opens a saved conversation or runs inside a retained workspace
     * passes them so its own in-process sweep cannot remove what it just checked.
     *
     * Protection is a caller promise, not a lease: the caller owns the lifetime
     * it is asserting and passes nothing once the work is quiescent.
     */
    protect?: CleanupProtection;
}

/**
 * Artifacts one sweep must keep, identified by the three things continuation
 * cares about: the conversation, the individual attempt/root, and the exact
 * paths on disk (saved session file, shared workspace, task scratch).
 */
export interface CleanupProtection {
    /** Native session ids whose runs, saved history, and workspaces are in use. */
    sessionIds?: Iterable<string>;
    /** Individual run ids (attempt or root) that must not be removed. */
    runIds?: Iterable<string>;
    /** Exact paths to keep, e.g. a saved conversation file or a shared workspace. */
    paths?: Iterable<string>;
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

/** A metadata-less run directory, with its provenance record (#325). */
function removeRun(id: string, errors: string[]): boolean {
    try {
        removeRunDirectory(id);
        return true;
    } catch (err) {
        errors.push(`${runDir(id)}: ${err instanceof Error ? err.message : String(err)}`);
        return false;
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

/** True when `path` is `root` itself or lies beneath it. */
function pathWithin(path: string, root: string): boolean {
    return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function pathOverlapsProtected(path: string, protectedPaths: readonly string[]): boolean {
    for (const protectedPath of protectedPaths) {
        if (pathWithin(path, protectedPath) || pathWithin(protectedPath, path)) return true;
    }
    return false;
}

/**
 * Whether this attempt's recorded child may still be writing its conversation.
 *
 * A `running`/`orphaned` record is occupancy by itself. `killed` is recorded as
 * soon as the stop policy decides, while the child can still be alive and
 * appending; `lost` means supervision lost track, not that the process proved
 * gone. So only an actual process-identity match counts there, and an
 * unavailable start token proves nothing and counts as alive.
 */
function recordedChildMayWrite(meta: RunMeta): boolean {
    if (!TERMINAL_CLEANUP_STATUSES.has(meta.status)) return true;
    if (meta.status !== "killed" && meta.status !== "lost") return false;
    const pid = meta.pid;
    if (typeof pid !== "number" || pid <= 0 || !processExists(pid)) return false;
    if (meta.pidStartTime === undefined) return true;
    const current = processStartToken(pid);
    return current === undefined || current === meta.pidStartTime;
}

/**
 * Whether a writer lease says this conversation is in use.
 *
 * The lease is taken by the supervising foreground *before* the detached child
 * is spawned and before the attempt's metadata exists, so it is the only
 * evidence of occupancy during that admission window. This reads the same
 * record continuation admission uses without recovering or deleting it. A dead
 * supervisor can have spawned a child before publishing its attempt metadata;
 * missing writer evidence therefore keeps the shared workspace protected.
 */
function leaseMayHaveWriter(sessionId: string): boolean {
    const lease = readConversationLease(sessionId);
    if (!lease) return false;
    if (lease.pid === process.pid) return true;
    if (processExists(lease.pid)) {
        if (lease.start === undefined) return true;
        const current = processStartToken(lease.pid);
        if (current === undefined || current === lease.start) return true;
    }
    const writer = readMeta(lease.attemptId);
    return !writer || recordedChildMayWrite(writer);
}

interface CleanupOccupancy {
    /** Conversations with a possible writer, plus caller-protected conversations. */
    sessions: Set<string>;
    /** Every run id of an occupied conversation, plus caller-protected runs. */
    runIds: Set<string>;
    /** Caller-protected paths that neither sweep may remove. */
    paths: string[];
}

/**
 * Decide which conversations are live enough that no run of theirs (the shared
 * root clone/scratch and saved history included) may be retired yet.
 *
 * Continuation made the workspace and saved session outlive the attempt that
 * created them: a later attempt runs inside the root's clone and appends to the
 * root's history. Age and size sweeps therefore protect conversation-level
 * occupancy, not attempt-local status alone.
 */
function planCleanupOccupancy(
    metas: readonly RunMeta[],
    protect: CleanupProtection | undefined,
): CleanupOccupancy {
    const runIds = new Set<string>(protect?.runIds ?? []);
    const paths = [...(protect?.paths ?? [])];

    // A protected path may be the shared workspace or something inside it. The
    // run whose removal would delete it is protected instead, because
    // `removeMetaArtifacts` removes an owned workspace/scratch with its run.
    for (const meta of metas) {
        if (ownedResources(meta).some((owned) => paths.some((keep) => pathWithin(keep, owned)))) {
            runIds.add(meta.id);
        }
    }

    const sessions = new Set<string>(protect?.sessionIds ?? []);
    for (const meta of metas) {
        if (runIds.has(meta.id)) sessions.add(meta.sessionId);
        if (recordedChildMayWrite(meta) || leaseMayHaveWriter(meta.sessionId)) {
            sessions.add(meta.sessionId);
        }
    }
    for (const meta of metas) {
        if (sessions.has(meta.sessionId)) runIds.add(meta.id);
    }
    return { sessions, runIds, paths };
}

/**
 * What one sweep needs to make a removal decision that outlives its snapshot:
 * the run ids it knows per conversation (for a fresh re-read inside that
 * conversation's lock) and the snapshot occupancy the caller's protection was
 * folded into.
 */
interface CleanupScope {
    occupancy: CleanupOccupancy;
    runIdsBySession: Map<string, string[]>;
    /**
     * Conversations whose saved session and launch recipe live in durable
     * storage. Their history and owned clone workspace never age out; only the
     * volatile log, metadata, and task scratch are reclaimed.
     */
    persistent: ReadonlySet<string>;
    /**
     * Completed attempts whose compact durable record is still unpublished. The
     * volatile run directory holds the only copy of the recipe, so both bounds
     * retain the whole run until a sweep can publish it.
     */
    archivePending: ReadonlySet<string>;
}

/**
 * Conversations with a durable continuation record: a completed attempt saved
 * its compact metadata and frozen recipe under the Pi agent directory. Their
 * saved history and owned clone workspace are kept indefinitely; only the
 * volatile log, metadata, and task scratch are reclaimed.
 *
 * A completed durable-layout attempt whose compact record could not be published
 * belongs here too: it is not resumable yet, but its recipe, saved history, and
 * clone are the only copy of that conversation.
 *
 * Legacy attempts (recipes pointing at the old temporary session directory, or
 * fixtures without a recipe) never publish that record and keep the existing
 * reclaimable behavior. A conversation that only ever failed is not resumable,
 * so its artifacts stay ordinary aged history and do not pin a clone forever.
 */
function persistentSessionIds(
    metas: readonly RunMeta[],
    archivePending: ReadonlySet<string>,
): Set<string> {
    const sessions = new Set(listArchivedAttempts().map((meta) => meta.sessionId));
    for (const meta of metas) {
        if (archivePending.has(meta.id)) sessions.add(meta.sessionId);
    }
    return sessions;
}

/**
 * Retry publication of every completed attempt whose compact durable record is
 * missing, BEFORE either bound decides what to delete.
 *
 * The volatile run directory is the only place a completed attempt's recipe
 * lives until that record is published, so this pass is what makes the age and
 * size bounds safe: while it keeps failing, the runs it names are retained (see
 * `CleanupScope.archivePending`), and once it succeeds they are ordinary
 * persistent conversations whose raw logs may be reclaimed.
 *
 * Returns the run ids still unpublished.
 */
function retryPendingArchives(metas: readonly RunMeta[]): Set<string> {
    const pending = new Set<string>();
    for (const meta of metas) {
        if (!archivePublicationPending(meta)) continue;
        try {
            if (archiveCompletedAttempt(meta)) observeArchivePublication(meta.id);
        } catch (error) {
            observeArchivePublication(meta.id, error);
        }
        if (archivePublicationPending(meta)) pending.add(meta.id);
    }
    return pending;
}

function runIdsBySession(metas: readonly RunMeta[]): Map<string, string[]> {
    const bySession = new Map<string, string[]>();
    for (const meta of metas) {
        const ids = bySession.get(meta.sessionId);
        if (ids) ids.push(meta.id);
        else bySession.set(meta.sessionId, [meta.id]);
    }
    return bySession;
}

/** Session ids with a published writer lease file. */
function leasedSessionIds(): string[] {
    let names: string[];
    try {
        names = readdirSync(conversationLeaseDir());
    } catch {
        return [];
    }
    return names
        .filter((name) => name.endsWith(".lock"))
        .map((name) => name.slice(0, -".lock".length))
        .filter((id) => SESSION_ID_PATTERN.test(id));
}

/**
 * Conversations this sweep must serialize with admission: every conversation it
 * has a run record for, plus every retained and leased one. Admission for a
 * conversation always has either the run record of the attempt it continues or
 * the writer lease it just took, so history that resolves to none of these is
 * foreign and keeps the ordinary, unserialized cleanup path.
 */
function serializedConversations(metas: readonly RunMeta[]): Set<string> {
    const sessions = new Set<string>();
    for (const meta of metas) sessions.add(meta.sessionId);
    for (const sessionId of retainedSessionIds()) sessions.add(sessionId);
    for (const sessionId of leasedSessionIds()) sessions.add(sessionId);
    return sessions;
}

/**
 * Run `body` inside one conversation's mutation transaction — the same
 * kernel-owned critical section admission, lease release, and retention writes
 * take. A lock that is busy or unavailable retains the resource for this sweep
 * instead of blocking the foreground, stalling forever, or failing every other
 * deletion: keeping work is always the safe direction.
 */
function withConversationSerialization<T>(
    sessionId: string | undefined,
    body: () => T,
    retained: () => T,
): T {
    if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) return body();
    try {
        return withConversationMutation(sessionId, body, { waitMs: CLEANUP_LOCK_WAIT_MS });
    } catch (error) {
        if (error instanceof ConversationBusyError || error instanceof ConversationLockUnavailableError) {
            return retained();
        }
        throw error;
    }
}

/**
 * Is this conversation provably quiescent right now?
 *
 * Snapshot occupancy is not proof. Between the snapshot and a removal another
 * process can publish a writer lease, re-request retention, or re-write an
 * attempt, so this re-reads the same evidence inside the conversation's
 * mutation transaction: a successful admission can therefore only be seen here
 * (and retained) or happen after the removal it now follows.
 *
 * A brand-new attempt of the same conversation is admitted only under that
 * conversation's lease, so re-reading the lease also covers an attempt this
 * sweep has never seen in its snapshot.
 */
function conversationQuiescentUnderLock(sessionId: string, runIds: readonly string[]): boolean {
    if (leaseMayHaveWriter(sessionId)) return false;
    const retention = readRetention(sessionId);
    if (retention && retention.releasedAt === undefined) return false;
    for (const id of runIds) {
        const meta = readMeta(id);
        if (meta && recordedChildMayWrite(meta)) return false;
    }
    return true;
}

/** Paths whose removal follows this run's artifacts (see `removeMetaArtifacts`). */
function ownedResources(meta: RunMeta): string[] {
    return meta.taskScratch ? [meta.cwd, meta.taskScratch] : [meta.cwd];
}

function cleanRunDirs(cutoff: number, scope: CleanupScope, errors: string[]): number {
    let removed = 0;
    let ids: string[];
    try {
        ids = readdirSync(join(baseDir(), "runs"));
    } catch {
        return 0;
    }
    // Explicit retention (`retain_session`) pins every attempt of a
    // conversation, not just the attempt that requested it, so its saved
    // session and owned clone/scratch workspace stay available for a
    // continuation until the owner releases them.
    const retained = retainedSessionIds();

    for (const id of ids) {
        const dir = runDir(id);
        const meta = readMeta(id);
        if (meta) {
            if (!ageSweepEligible(meta, cutoff, retained, scope)) continue;
            if (removeAgedRunArtifacts(meta, cutoff, retained, scope, errors)) removed += 1;
            continue;
        }

        const mtimeMs = safeStatMtime(dir);
        if (mtimeMs !== undefined && mtimeMs < cutoff && removeRun(id, errors)) removed += 1;
    }
    // Provenance whose run is already gone (#325).
    for (const id of orphanedTaskRuntimeProvenance()) removeTaskRuntimeProvenance(id);
    return removed;
}

/**
 * Snapshot eligibility for the age bound. Re-applied to the fresh record inside
 * the conversation's lock, because a record can be rewritten between the two:
 * a run that finished later, or one another sweep already retired, is decided
 * on what it says now.
 */
function ageSweepEligible(
    meta: RunMeta,
    cutoff: number,
    retained: ReadonlySet<string>,
    scope: CleanupScope,
): boolean {
    if (!TERMINAL_CLEANUP_STATUSES.has(meta.status)) return false;
    if (retained.has(meta.sessionId)) return false;
    // The run directory still holds the only copy of this conversation's recipe.
    if (scope.archivePending.has(meta.id)) return false;
    // A released conversation can still be in use: a later attempt may run
    // inside this root's clone, or a stop/kill may not have landed.
    if (scope.occupancy.runIds.has(meta.id)) return false;
    return terminalTimestamp(meta) < cutoff;
}

/**
 * Remove one aged attempt's artifacts, serialized with its conversation.
 *
 * This is the deletion the snapshot cannot authorize: an admission that
 * published its writer lease after this sweep listed the registry would have
 * its shared workspace, task scratch, and saved history removed underneath it.
 * The recheck inside the lock sees that admission, so the attempt is retained.
 *
 * The removal itself is inside the transaction because it is the commit point:
 * `removeMetaArtifacts` unlinks the shared workspace, and splitting the
 * decision from that unlink would reopen the race. A conversation whose lock is
 * held by an admission or a retention write is therefore retained for this
 * sweep, and the holder's own bounded wait is what bounds this section.
 */
function removeAgedRunArtifacts(
    meta: RunMeta,
    cutoff: number,
    retained: ReadonlySet<string>,
    scope: CleanupScope,
    errors: string[],
): boolean {
    const runIds = scope.runIdsBySession.get(meta.sessionId) ?? [meta.id];
    return withConversationSerialization(meta.sessionId, () => {
        if (!conversationQuiescentUnderLock(meta.sessionId, runIds)) return false;
        const fresh = readMeta(meta.id) ?? meta;
        if (!ageSweepEligible(fresh, cutoff, retained, scope)) return false;
        if (removeMetaArtifacts(fresh, { keepWorkspace: scope.persistent.has(fresh.sessionId) })) return true;
        errors.push(`${runDir(meta.id)}: could not remove run artifacts`);
        return false;
    }, () => false);
}

/**
 * Conversation a session-tree path names, resolved against conversations this
 * sweep tracks: the per-run session directory `<runId>/`, a
 * `<timestamp>_<sessionId>.jsonl` name, or the bare conversation name. History
 * that resolves to nothing this sweep knows stays on the ordinary path.
 */
function sessionIdForPath(root: string, path: string, serialized: ReadonlySet<string>): string | undefined {
    const rel = relative(root, path);
    if (!rel || rel.startsWith("..")) return undefined;
    const known = [...new Set(pathNameCandidates(rel.split(sep)))].filter((candidate) => serialized.has(candidate));
    // Two different tracked conversations in one path is not a layout this
    // package writes. Refusing to remove it keeps both, instead of serializing
    // one and deleting under the other.
    return known.length === 1 ? known[0] : undefined;
}

function* pathNameCandidates(parts: readonly string[]): Generator<string> {
    yield parts[0]!; // per-run session directory
    const name = parts[parts.length - 1]!;
    const stem = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name;
    yield stem;
    // `<timestamp>_<sessionId>.jsonl`: the timestamp carries no underscore.
    const separator = stem.indexOf("_");
    if (separator > 0) yield stem.slice(separator + 1);
}

/**
 * Remove one aged session-tree entry, serialized with the conversation it names
 * when this sweep tracks that conversation.
 */
function removeSessionPath(
    root: string,
    path: string,
    serialized: ReadonlySet<string>,
    scope: CleanupScope,
    errors: string[],
): boolean {
    const sessionId = sessionIdForPath(root, path, serialized);
    if (!sessionId) return removePath(path, errors);
    const runIds = scope.runIdsBySession.get(sessionId) ?? [];
    return withConversationSerialization(sessionId, () => {
        if (!conversationQuiescentUnderLock(sessionId, runIds)) return false;
        return removePath(path, errors);
    }, () => false);
}

function activeSessionIds(metas: RunMeta[], occupancy: CleanupOccupancy, persistent: ReadonlySet<string>): Set<string> {
    const active = new Set<string>(occupancy.sessions);
    for (const meta of metas) {
        if (meta.status === "running" || meta.status === "orphaned") active.add(meta.sessionId);
    }
    // A retained completed conversation is not active work, but its saved
    // session file is the history a continuation reopens.
    for (const sessionId of retainedSessionIds()) active.add(sessionId);
    // Durable conversations never expire with the volatile sweeps either.
    for (const sessionId of persistent) active.add(sessionId);
    return active;
}

function pathMentionsActiveSession(root: string, path: string, active: Set<string>): boolean {
    if (active.size === 0) return false;
    const rel = relative(root, path);
    for (const sessionId of active) {
        if (sessionId && rel.includes(sessionId)) return true;
    }
    return false;
}

function cleanSessionTree(
    root: string,
    cutoff: number,
    active: Set<string>,
    protectedPaths: readonly string[],
    scope: CleanupScope,
    serialized: ReadonlySet<string>,
    errors: string[],
): number {
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
                if (childEmpty
                    && !pathMentionsActiveSession(root, path, active)
                    && !pathOverlapsProtected(path, protectedPaths)) {
                    const mtimeMs = safeStatMtime(path);
                    if (mtimeMs !== undefined && mtimeMs < cutoff && removeSessionPath(root, path, serialized, scope, errors)) {
                        removed += 1;
                        continue;
                    }
                }
                empty = false;
                continue;
            }

            if (pathMentionsActiveSession(root, path, active) || pathOverlapsProtected(path, protectedPaths)) {
                empty = false;
                continue;
            }
            const mtimeMs = safeStatMtime(path);
            if (mtimeMs !== undefined && mtimeMs < cutoff && removeSessionPath(root, path, serialized, scope, errors)) {
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
    // Publish any outstanding compact record before this sweep reclaims the only
    // copy of a completed attempt's recipe.
    const archivePending = retryPendingArchives(metas);
    const persistent = persistentSessionIds(metas, archivePending);
    const scope: CleanupScope = {
        occupancy: planCleanupOccupancy(metas, options.protect),
        runIdsBySession: runIdsBySession(metas),
        persistent,
        archivePending,
    };
    const removedRunDirs = cleanRunDirs(now - terminalRetention, scope, errors);
    // Native saved history is durable regardless of the latest attempt status.
    // Sweep only legacy temporary sessions; eligibility to resume must never
    // determine whether a durable native conversation is kept.
    const sessionRoots = [join(baseDir(), "sessions")];
    let removedSessionPaths = 0;
    for (const root of sessionRoots) {
        removedSessionPaths += cleanSessionTree(
            root,
            now - sessionRetention,
            activeSessionIds(metas, scope.occupancy, persistent),
            scope.occupancy.paths,
            scope,
            serializedConversations(metas),
            errors,
        );
    }

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
    /** Same caller-owned protection as `DailyCleanupOptions.protect`. */
    protect?: CleanupProtection;
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
    // Same ordering as the age sweep: retry archival first, so a run whose
    // recipe only exists in its volatile directory is never a removal candidate.
    const metas = listMetas();
    const archivePending = retryPendingArchives(metas);
    const entries = collectSizeCapEntries();
    // Retained conversations and their workspaces are exempt from the byte
    // bound until the owner releases them; a size sweep must not delete the
    // history or uncommitted workspace a continuation depends on. An occupied
    // conversation is protected the same way: its root clone may be the oldest
    // terminal run in the registry while a new attempt is still running in it.
    // Occupancy costs a metadata scan and lease reads, so it is only computed
    // when this sweep would actually remove something.
    const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    const occupancy = totalBytes > maxBytes ? planCleanupOccupancy(metas, options.protect) : undefined;
    const protectedIds = new Set([
        ...(options.protectedIds ?? ownRunIds(metas)),
        ...retainedRunIds(metas),
        ...(occupancy?.runIds ?? []),
        // An unpublished compact record is the recipe's only copy.
        ...archivePending,
    ]);
    const plan = planRegistrySizeCap(entries, { maxBytes, protectedIds });
    const scope: CleanupScope = {
        occupancy: occupancy ?? { sessions: new Set(), runIds: new Set(), paths: [] },
        runIdsBySession: runIdsBySession(metas),
        persistent: persistentSessionIds(metas, archivePending),
        archivePending,
    };
    const bytesById = new Map(entries.map((entry) => [entry.id, entry.bytes]));
    const removed: string[] = [];
    let retainedBytes = 0;
    for (const id of plan.remove) {
        const outcome = removeSizeCappedRun(id, scope, errors);
        if (outcome === "removed") removed.push(id);
        else if (outcome === "retained") retainedBytes += bytesById.get(id) ?? 0;
    }
    // A candidate the recheck retained is still on disk, so the byte account and
    // the shortfall it reports stay honest.
    const keptBytes = plan.keptBytes + retainedBytes;

    try {
        writeCleanupState({ ...state, lastSizeSweepAt: now });
    } catch (err) {
        errors.push(`${cleanupStatePath()}: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { ...plan, ran: true, removed, keptBytes, overBudget: keptBytes > maxBytes, errors };
}

/**
 * Remove one planned size-cap candidate, serialized with its conversation.
 *
 * The plan is a snapshot of both bytes and occupancy. Re-reading inside the
 * lock keeps a run that became active, retained, or newly leased since then:
 * a continuation admitted after planning runs inside the root the plan chose to
 * delete, and its shared workspace is exactly what a size sweep goes after.
 */
function removeSizeCappedRun(
    id: string,
    scope: CleanupScope,
    errors: string[],
): "removed" | "retained" | "failed" {
    const meta = readMeta(id);
    if (!meta) return removeRun(id, errors) ? "removed" : "failed";
    const runIds = scope.runIdsBySession.get(meta.sessionId) ?? [meta.id];
    return withConversationSerialization(meta.sessionId, () => {
        if (!conversationQuiescentUnderLock(meta.sessionId, runIds)) return "retained";
        const fresh = readMeta(id) ?? meta;
        if (!TERMINAL_CLEANUP_STATUSES.has(fresh.status)) return "retained";
        if (scope.occupancy.runIds.has(fresh.id)) return "retained";
        if (removeMetaArtifacts(fresh, { keepWorkspace: scope.persistent.has(fresh.sessionId) })) return "removed";
        errors.push(`${runDir(id)}: could not remove run artifacts`);
        return "failed";
    }, () => "retained");
}

/** Run ids owned by this pi process, which a size sweep must never remove. */
function ownRunIds(metas: readonly RunMeta[] = listMetas()): Set<string> {
    const own = new Set<string>();
    try {
        for (const meta of metas) {
            if (ownedByThisParent(meta)) own.add(meta.id);
        }
    } catch { /* registry unreadable: protect nothing, remove nothing new */ }
    return own;
}
