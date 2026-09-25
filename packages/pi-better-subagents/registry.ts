/**
 * Run registry — durable metadata for each spawned subagent.
 *
 * The authoritative record for every run is a `meta.json` sidecar on disk, so
 * `list` / `output` / `result` keep working across foreground turns, `/reload`,
 * and even a full pi restart. In-memory state holds only the live exit handlers
 * for runs this process spawned.
 *
 * Catalog launches may attach an optional immutable `catalog` snapshot to that
 * same record. Display-label reservations live under `{baseDir()}/labels`
 * (see catalog-identity.ts). They are not a second registry, and removing a
 * run directory does not delete them.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { processExists } from "./spawn.ts";
import type { LifecycleClassification } from "./lifecycle.ts";

/**
 * Terminal + live statuses as recorded on disk. `orphaned` is durable and
 * NON-terminal (supervision broke, but related processes may still be alive);
 * `lost` is durable and terminal (no related process evidence remains).
 */
export type RunStatus = "running" | "completed" | "failed" | "killed" | "orphaned" | "lost";

export interface RunCallbackOrigin {
    cwd: string;
    sessionId?: string;
}

/**
 * JSON value inside a catalog launch snapshot. The snapshot is structurally
 * flexible: known sections are identity, effective configuration, and
 * provenance, and callers may add further JSON fields without a schema bump.
 */
export type CatalogJson =
    | null
    | boolean
    | number
    | string
    | CatalogJson[]
    | { [key: string]: CatalogJson | undefined };

/**
 * Launch-time catalog record stored on the run. Every section is optional so
 * a partial snapshot still round-trips; legacy metadata simply omits `catalog`.
 * Once `writeMeta` has persisted a snapshot, later writes keep that value.
 */
export interface CatalogLaunchSnapshot {
    /** Role/agent identity, display label, and alias captured at launch. */
    identity?: CatalogJson;
    /** Effective instructions, model, effort, and related launch configuration. */
    effective?: CatalogJson;
    /** Why the definition, model, and effort won. */
    provenance?: CatalogJson;
    [key: string]: CatalogJson | undefined;
}

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
    /**
     * Start-identity token of the SPAWNING pi, captured at spawn where the OS
     * exposes one. Optional and additive: older metadata parses unchanged. Only
     * equality is meaningful — a different token proves the parent pid was
     * recycled by an unrelated process, which is how `isAbandonedByParent` tells
     * a dead session's leftovers from a live session's runs.
     */
    spawnPidStartTime?: string;
    /**
     * When another pi adopted this record because its own spawning pi was gone
     * (status reconciliation only — no callback was delivered). Additive and
     * diagnostic: it explains a `lost` record nobody's session reported.
     */
    adoptedFromLostParentAt?: number;
    model?: string;
    /** Reasoning effort passed to the child via Pi's --thinking option. */
    effort?: string;
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
    /** Child subagent session id. */
    sessionId: string;
    /** Foreground session that is allowed to receive unsolicited callbacks. */
    callbackOrigin?: RunCallbackOrigin;
    /** Durable ordinary-completion callback recovery and successful-handoff markers. */
    completionCallbackPendingAt?: number;
    completionCallbackSentAt?: number;
    completionCallbackSuppressedAt?: number;
    completionCallbackSuppressedReason?: string;
    orphanedCallbackSuppressedAt?: number;
    orphanedCallbackSuppressedReason?: string;
    lostCallbackSuppressedAt?: number;
    lostCallbackSuppressedReason?: string;
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
    /**
     * Optional catalog launch snapshot. Additive: metadata written before the
     * catalog has no `catalog` key and still parses. The first launch
     * publication freezes `name` and `catalog` together, including when
     * catalog is absent or null. Later status, result, and stop writes keep
     * that whole snapshot and must not fill a missing catalog.
     */
    catalog?: CatalogLaunchSnapshot;
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

/**
 * Name and catalog from a single launch publication.
 * `catalogKnown` is false when the winning snapshot omitted `catalog`.
 * Explicit null is known and must not be replaced by a later object.
 */
interface LaunchRecord {
    name?: string;
    catalogKnown: boolean;
    catalog?: CatalogLaunchSnapshot | null;
}

function launchRecordPath(id: string): string {
    return join(runDir(id), ".launch.json");
}

function launchFromSource(source: { name?: unknown; catalog?: CatalogLaunchSnapshot | null }): LaunchRecord {
    const name = typeof source.name === "string" && source.name.length > 0 ? source.name : undefined;
    const catalogKnown = Object.prototype.hasOwnProperty.call(source, "catalog") && source.catalog !== undefined;
    return { name, catalogKnown, catalog: catalogKnown ? source.catalog : undefined };
}

function serializeLaunch(record: LaunchRecord): string {
    const payload: { name?: string; catalog?: CatalogLaunchSnapshot | null } = {};
    if (record.name !== undefined) payload.name = record.name;
    if (record.catalogKnown) payload.catalog = record.catalog ?? null;
    return JSON.stringify(payload);
}

function parseLaunch(raw: string, id: string): LaunchRecord {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        if (error instanceof SyntaxError) throw new Error(`Unreadable launch record for ${id}`);
        throw error;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Unreadable launch record for ${id}`);
    }
    return launchFromSource(parsed as { name?: unknown; catalog?: CatalogLaunchSnapshot | null });
}

/** A committed meta.json is one historical launch. A truncated file is not. */
function readCommittedMetaLaunch(id: string): LaunchRecord | undefined {
    let raw: string;
    try {
        raw = readFileSync(metaPathFor(id), "utf-8");
    } catch (error) {
        if (errnoOf(error) === "ENOENT") return undefined;
        throw error;
    }
    try {
        const parsed = JSON.parse(raw) as { name?: unknown; catalog?: CatalogLaunchSnapshot | null };
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
        return launchFromSource(parsed);
    } catch (error) {
        if (error instanceof SyntaxError) return undefined;
        throw error;
    }
}

function applyLaunchRecord(meta: RunMeta, record: LaunchRecord): void {
    if (record.name !== undefined) meta.name = record.name;
    else delete meta.name;
    if (record.catalogKnown) meta.catalog = record.catalog as CatalogLaunchSnapshot;
    else delete meta.catalog;
}

/**
 * Publish `contents` at `target` so the first complete file wins.
 *
 * `link` of an fsynced temp is atomic: callers either see the winner's
 * bytes or no file. A later link gets EEXIST and leaves the winner in place.
 * This is not another lock. Token recovery can still rename `.meta.lock`
 * after a stale observation (the rename syscall moves whatever inode is at
 * that path), so the lock pathname is not a safe place to remember the
 * first snapshot.
 */
function publishImmutable(target: string, contents: string): void {
    try {
        statSync(target);
        return;
    } catch (error) {
        if (errnoOf(error) !== "ENOENT") throw error;
    }
    const temp = join(dirname(target), `.immutable.${randomBytes(8).toString("hex")}.tmp`);
    const fd = openSync(temp, "wx");
    try {
        writeFileSync(fd, contents);
        fsyncSync(fd);
    } catch (error) {
        try {
            closeSync(fd);
        } catch (closeError) {
            if (errnoOf(closeError) !== "EBADF") throw closeError;
        }
        try {
            unlinkSync(temp);
        } catch (cleanup) {
            if (errnoOf(cleanup) !== "ENOENT") throw cleanup;
        }
        throw error;
    }
    closeSync(fd);
    try {
        linkSync(temp, target);
    } catch (error) {
        try {
            unlinkSync(temp);
        } catch (cleanup) {
            if (errnoOf(cleanup) !== "ENOENT") throw cleanup;
        }
        if (errnoOf(error) !== "EEXIST") throw error;
        return;
    }
    try {
        unlinkSync(temp);
    } catch (error) {
        if (errnoOf(error) !== "ENOENT") throw error;
    }
}

function readOptionalUtf8(target: string): string | undefined {
    try {
        return readFileSync(target, "utf-8");
    } catch (error) {
        if (errnoOf(error) === "ENOENT") return undefined;
        throw error;
    }
}

/**
 * Freeze one coherent launch snapshot before `meta.json` is replaced.
 *
 * The exclusive link is the publication. A pause or crash before it leaves
 * no snapshot; a pause or crash after it leaves the whole snapshot. Orphan
 * split anchors are not read: pairing those files is the bug this replaces.
 * A legacy `meta.json` is copied in as one record first, so its name and
 * catalog (including absence or null) beat this writer without being
 * reconciled field by field. The caller's object is then rewritten from
 * whichever record won the link.
 */
function applyFrozenLaunch(meta: RunMeta): void {
    const path = launchRecordPath(meta.id);
    let raw = readOptionalUtf8(path);
    if (raw === undefined) {
        const committed = readCommittedMetaLaunch(meta.id) ?? launchFromSource(meta);
        publishImmutable(path, serializeLaunch(committed));
        raw = readOptionalUtf8(path);
        if (raw === undefined) throw new Error(`Missing launch record for ${meta.id}`);
    }
    applyLaunchRecord(meta, parseLaunch(raw, meta.id));
}

const META_LOCK_WAIT_MS = 5_000;
const UNPARSABLE_LOCK_GRACE_MS = 1_000;
const nodeRequire = createRequire(import.meta.url);
const lockPause = new Int32Array(new SharedArrayBuffer(4));
const sqliteWarningFilter = Symbol.for("pi-better-subagents.sqlite-warning-filter");

class MetadataLockLost extends Error {
    constructor() {
        super("metadata lock lost");
        this.name = "MetadataLockLost";
    }
}

interface LockOwner {
    pid: number;
    token: string;
    start?: string;
}

interface LockDb {
    exec(sql: string): void;
    close(): void;
}

function errnoOf(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException).code;
}

function sleepMs(ms: number): void {
    Atomics.wait(lockPause, 0, 0, ms);
}

function lockTimeout(id: string): Error {
    return new Error(`Timed out writing metadata for ${id}`);
}

let ownStartKnown = false;
let ownStartCache: string | undefined;
const foreignStartCache = new Map<number, { token: string | undefined; at: number }>();

/** Best-effort process start identity. Unavailable does not prove the pid is dead. */
function readStartToken(pid: number): string | undefined {
    if (process.platform === "linux") {
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
            const close = stat.lastIndexOf(") ");
            if (close >= 0) {
                const starttime = stat.slice(close + 2).split(" ")[19];
                if (starttime && /^\d+$/.test(starttime)) return starttime;
            }
        } catch (error) {
            if (errnoOf(error) !== "ENOENT" && errnoOf(error) !== "EACCES") return undefined;
        }
    }
    try {
        const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
            encoding: "utf-8",
            timeout: 1_000,
            env: { ...process.env, LC_ALL: "C" },
            stdio: ["ignore", "pipe", "ignore"],
        }).trim().replace(/\s+/g, " ");
        return out === "" ? undefined : out;
    } catch {
        return undefined;
    }
}

function ownStartToken(): string | undefined {
    if (ownStartKnown) return ownStartCache;
    ownStartCache = readStartToken(process.pid);
    ownStartKnown = true;
    return ownStartCache;
}

function cachedStartToken(pid: number): string | undefined {
    const now = Date.now();
    const hit = foreignStartCache.get(pid);
    if (hit && now - hit.at < 200) return hit.token;
    const token = readStartToken(pid);
    foreignStartCache.set(pid, { token, at: now });
    return token;
}

function makeOwner(): LockOwner {
    return { pid: process.pid, token: randomBytes(16).toString("hex"), start: ownStartToken() };
}

function serializeOwner(owner: LockOwner): string {
    return JSON.stringify({ pid: owner.pid, token: owner.token, start: owner.start ?? null });
}

function parseOwner(raw: string): LockOwner | undefined {
    const trimmed = raw.trim();
    if (/^[1-9]\d*$/.test(trimmed)) {
        const pid = Number(trimmed);
        return Number.isSafeInteger(pid) ? { pid, token: "" } : undefined;
    }
    try {
        const parsed = JSON.parse(raw) as { pid?: unknown; token?: unknown; start?: unknown };
        if (!parsed || typeof parsed !== "object") return undefined;
        if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return undefined;
        if (typeof parsed.token !== "string") return undefined;
        const start = typeof parsed.start === "string" && parsed.start.length > 0 ? parsed.start : undefined;
        return { pid: parsed.pid, token: parsed.token, start };
    } catch {
        return undefined;
    }
}

/** A live pid is never stale, including when that process is stopped or paused. */
function ownerIsLive(owner: LockOwner): boolean {
    if (owner.pid === process.pid) return true;
    if (!processExists(owner.pid)) return false;
    if (!owner.start) return true;
    const current = cachedStartToken(owner.pid);
    if (!current) return true;
    return current === owner.start;
}

function isStaleLock(lockPath: string, raw: string): boolean {
    const owner = parseOwner(raw);
    if (!owner) {
        try {
            return Date.now() - statSync(lockPath).mtimeMs > UNPARSABLE_LOCK_GRACE_MS;
        } catch (error) {
            if (errnoOf(error) === "ENOENT") return false;
            throw error;
        }
    }
    return !ownerIsLive(owner);
}

function restoreDisplacedLock(grave: string, lockPath: string): void {
    try {
        linkSync(grave, lockPath);
    } catch (error) {
        if (errnoOf(error) !== "EEXIST") throw error;
        let displaced: string;
        try {
            displaced = readFileSync(grave, "utf-8");
        } catch (readError) {
            if (errnoOf(readError) === "ENOENT") return;
            throw readError;
        }
        if (!isStaleLock(grave, displaced)) return;
        try {
            unlinkSync(grave);
        } catch (cleanup) {
            if (errnoOf(cleanup) !== "ENOENT") throw cleanup;
        }
        return;
    }
    try {
        unlinkSync(grave);
    } catch (error) {
        if (errnoOf(error) !== "ENOENT") throw error;
    }
}

/** Drop the lock file only when `predicate` still matches the inode we moved aside. */
function removeLockIf(lockPath: string, predicate: (raw: string, path: string) => boolean): void {
    let observed: string;
    try {
        observed = readFileSync(lockPath, "utf-8");
    } catch (error) {
        if (errnoOf(error) === "ENOENT") return;
        throw error;
    }
    if (!predicate(observed, lockPath)) return;
    const grave = join(dirname(lockPath), `.meta.lock.${randomBytes(8).toString("hex")}.displaced`);
    try {
        renameSync(lockPath, grave);
    } catch (error) {
        if (errnoOf(error) === "ENOENT") return;
        throw error;
    }
    let moved: string;
    try {
        moved = readFileSync(grave, "utf-8");
    } catch (error) {
        let restoreError: unknown;
        try {
            restoreDisplacedLock(grave, lockPath);
        } catch (restore) {
            restoreError = restore;
        }
        if (restoreError) throw restoreError;
        throw error;
    }
    if (moved === observed && predicate(moved, grave)) {
        try {
            unlinkSync(grave);
        } catch (error) {
            if (errnoOf(error) !== "ENOENT") throw error;
        }
        return;
    }
    restoreDisplacedLock(grave, lockPath);
}

function lockPayloadMatches(lockPath: string, payload: string): boolean {
    try {
        return readFileSync(lockPath, "utf-8") === payload;
    } catch (error) {
        if (errnoOf(error) === "ENOENT") return false;
        throw error;
    }
}

let databaseSyncCtor: (new (path: string) => LockDb) | null | undefined;

function databaseSync(): (new (path: string) => LockDb) | null {
    if (databaseSyncCtor !== undefined) return databaseSyncCtor;
    installSqliteWarningFilter();
    try {
        const loaded = nodeRequire("node:sqlite") as { DatabaseSync?: new (path: string) => LockDb };
        databaseSyncCtor = loaded.DatabaseSync ?? null;
    } catch (error) {
        const code = errnoOf(error);
        const message = error instanceof Error ? error.message : String(error);
        const missing = code === "ERR_UNKNOWN_BUILTIN_MODULE"
            || message.includes("Cannot find package")
            || message.includes("Cannot find module")
            || message.includes("No such built-in module");
        if (!missing) throw error;
        databaseSyncCtor = null;
    }
    return databaseSyncCtor;
}

function installSqliteWarningFilter(): void {
    const marked = process as typeof process & { [sqliteWarningFilter]?: boolean };
    if (marked[sqliteWarningFilter]) return;
    marked[sqliteWarningFilter] = true;
    const emit = process.emitWarning.bind(process);
    process.emitWarning = ((warning: unknown, ...args: unknown[]) => {
        const message = typeof warning === "string"
            ? warning
            : (warning as { message?: unknown } | undefined)?.message;
        if (typeof message === "string" && message.includes("SQLite is an experimental feature")) return;
        return (emit as (warning: unknown, ...args: unknown[]) => void)(warning, ...args);
    }) as typeof process.emitWarning;
}

function isSqliteBusy(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /database is locked|SQLITE_BUSY/i.test(message);
}

/**
 * Cross-process critical section. Node's built-in SQLite reserved lock is
 * held for the whole section, including while this process is stopped, and
 * the kernel drops it if the process dies. Waiters give up at 5s instead of
 * blocking forever or stealing a live holder.
 */
function acquireProcessLock(directory: string): () => void {
    const Ctor = databaseSync();
    if (!Ctor) return () => {};
    const db = new Ctor(join(directory, ".meta.lock.sqlite"));
    try {
        db.exec("PRAGMA busy_timeout = 5000");
        db.exec("BEGIN IMMEDIATE");
    } catch (error) {
        try {
            db.close();
        } catch (closeError) {
            if (!isSqliteBusy(error)) throw closeError;
        }
        if (isSqliteBusy(error)) throw lockTimeout(directory);
        throw error;
    }
    return () => {
        let rollbackError: unknown;
        try {
            db.exec("ROLLBACK");
        } catch (error) {
            rollbackError = error;
        }
        try {
            db.close();
        } catch (error) {
            if (!rollbackError) throw error;
        }
        if (rollbackError) throw rollbackError;
    };
}

function takeToken(lockPath: string, payload: string, deadline: number, id: string): void {
    for (;;) {
        const creating = join(dirname(lockPath), `.meta.lock.${randomBytes(8).toString("hex")}.creating`);
        writeFileSync(creating, payload, { flag: "wx" });
        try {
            linkSync(creating, lockPath);
        } catch (error) {
            const code = errnoOf(error);
            try {
                unlinkSync(creating);
            } catch (cleanup) {
                if (errnoOf(cleanup) !== "ENOENT") throw cleanup;
            }
            if (code !== "EEXIST") throw error;
            removeLockIf(lockPath, (raw, path) => isStaleLock(path, raw));
            if (Date.now() > deadline) throw lockTimeout(id);
            sleepMs(5);
            continue;
        }
        try {
            unlinkSync(creating);
        } catch (error) {
            if (errnoOf(error) !== "ENOENT") throw error;
        }
        return;
    }
}

/**
 * Serialize one run's read-modify-write. The owner token, not the lock's age,
 * decides who may recover or release it. A live pid — even one paused well
 * past two seconds — is not stolen. Release renames the lock aside and deletes
 * it only when the moved bytes are still ours, so a newer owner's lock stays.
 * The lock is per run and is not a second registry.
 */
function withRunMetaLock(id: string, body: (owns: () => boolean) => void): void {
    const directory = runDir(id);
    let releaseProcessLock: () => void;
    try {
        releaseProcessLock = acquireProcessLock(directory);
    } catch (error) {
        if (isSqliteBusy(error) || (error instanceof Error && error.message === `Timed out writing metadata for ${directory}`)) {
            throw lockTimeout(id);
        }
        throw error;
    }
    try {
        const lockPath = join(directory, ".meta.lock");
        const payload = serializeOwner(makeOwner());
        const deadline = Date.now() + META_LOCK_WAIT_MS;
        for (;;) {
            let ownsLock = false;
            try {
                takeToken(lockPath, payload, deadline, id);
                ownsLock = true;
                const owns = (): boolean => {
                    if (!ownsLock) return false;
                    if (!lockPayloadMatches(lockPath, payload)) {
                        ownsLock = false;
                        return false;
                    }
                    return true;
                };
                if (!owns()) continue;
                body(owns);
                return;
            } catch (error) {
                if (error instanceof MetadataLockLost) {
                    ownsLock = false;
                    if (Date.now() > deadline) throw lockTimeout(id);
                    continue;
                }
                throw error;
            } finally {
                if (ownsLock) removeLockIf(lockPath, (raw) => raw === payload);
            }
        }
    } finally {
        releaseProcessLock();
    }
}

function writeMetaFile(meta: RunMeta): void {
    applyFrozenLaunch(meta);
    const target = metaPathFor(meta.id);
    const json = JSON.stringify(meta, null, 2);
    if (process.platform === "win32") {
        writeFileSync(target, json);
        return;
    }
    const temp = join(runDir(meta.id), `.meta.${randomBytes(8).toString("hex")}.tmp`);
    const fd = openSync(temp, "wx");
    try {
        writeFileSync(fd, json);
        fsyncSync(fd);
    } catch (error) {
        try {
            closeSync(fd);
        } catch (closeError) {
            if (errnoOf(closeError) !== "EBADF") throw closeError;
        }
        try {
            unlinkSync(temp);
        } catch (cleanup) {
            if (errnoOf(cleanup) !== "ENOENT") throw cleanup;
        }
        throw error;
    }
    closeSync(fd);
    try {
        renameSync(temp, target);
    } catch (error) {
        try {
            unlinkSync(temp);
        } catch (cleanup) {
            if (errnoOf(cleanup) !== "ENOENT") throw cleanup;
        }
        throw error;
    }
}

let seq = 0;
const metaCache = new Map<string, RunMeta>();
/** Test-only pause/check after the run lock is held and before `meta.json` is replaced. */
let metaWriteBarrier: (() => void) | undefined;

export function setMetaWriteBarrierForTests(barrier: (() => void) | undefined): void {
    metaWriteBarrier = barrier;
}
// Owned snapshots are process-resident. A cheap directory signature catches
// cross-process index changes before any cached IDs are reused.
const indexIdsCache = new Map<string, { ids: Set<string>; signature: string }>();
const initializedIndexes = new Set<string>();
const metaChangedListeners = new Set<() => void>();
const registryIo = { fullDirectoryReads: 0, indexDirectoryReads: 0, metadataFileReads: 0, indexRevisionChecks: 0 };

export interface RegistryIoMetrics {
    fullDirectoryReads: number;
    indexDirectoryReads: number;
    metadataFileReads: number;
    indexRevisionChecks: number;
}

export function getRegistryIoMetrics(): RegistryIoMetrics {
    return { ...registryIo };
}

export function resetRegistryIoMetrics(): void {
    registryIo.fullDirectoryReads = 0;
    registryIo.indexDirectoryReads = 0;
    registryIo.metadataFileReads = 0;
    registryIo.indexRevisionChecks = 0;
}
/** Monotonic, readable, collision-free run id: `sa_<base36-time>_<seq>`. */
export function nextRunId(): string {
    seq += 1;
    return `sa_${Date.now().toString(36)}_${seq}`;
}

export function writeMeta(meta: RunMeta): void {
    mkdirSync(runDir(meta.id), { recursive: true });
    withRunMetaLock(meta.id, (owns) => {
        metaWriteBarrier?.();
        if (!owns()) throw new MetadataLockLost();
        writeMetaFile(meta);
        metaCache.set(meta.id, meta);
        indexMeta(meta);
        owns();
    });
    for (const listener of metaChangedListeners) {
        try { listener(); } catch { /* best effort */ }
    }
}

export function onMetaChanged(listener: () => void): () => void {
    metaChangedListeners.add(listener);
    return () => metaChangedListeners.delete(listener);
}

export function readMeta(id: string): RunMeta | undefined {
    try {
        registryIo.metadataFileReads += 1;
        const meta = JSON.parse(readFileSync(metaPathFor(id), "utf-8")) as RunMeta;
        metaCache.set(id, meta);
        return meta;
    } catch {
        metaCache.delete(id);
        return undefined;
    }
}

/**
 * Delete one run directory and its index entries.
 *
 * Catalog label reservations under `{baseDir()}/labels` are intentionally
 * kept. Age and size sweeps call this and therefore also leave reservations
 * in place, so a purged run does not free its display label for reuse.
 * Deleting the whole registry root is what clears them.
 */
export function removeMetaArtifacts(meta: RunMeta): boolean {
    try {
        rmSync(runDir(meta.id), { recursive: true, force: true });
        metaCache.delete(meta.id);
        removeIndexEntry(join(baseDir(), "by-parent", String(meta.spawnPid)), meta.id);
        removeIndexEntry(join(baseDir(), "by-parent-active", String(meta.spawnPid)), meta.id);
        removeIndexEntry(join(baseDir(), "by-origin", originKey(originOf(meta))), meta.id);
        for (const listener of metaChangedListeners) {
            try { listener(); } catch { /* best effort */ }
        }
        return true;
    } catch {
        return false;
    }
}

/** All runs, newest first. */
export function listMetas(): RunMeta[] {
    let ids: string[];
    try {
        registryIo.fullDirectoryReads += 1;
        ids = readdirSync(join(baseDir(), "runs"));
    } catch {
        return [];
    }
    return ids
        .map(readMetaForSweep)
        .filter((m): m is RunMeta => m !== undefined)
        .sort((a, b) => b.startedAt - a.startedAt);
}

export function listMetasForParent(parentPid: number): RunMeta[] {
    const directory = join(baseDir(), "by-parent", String(parentPid));
    ensureIndex(directory, (meta) => meta.spawnPid === parentPid);
    return readIndexedMetas(directory).filter((meta) => meta.spawnPid === parentPid);
}

export function listActiveMetasForParent(parentPid: number): RunMeta[] {
    const directory = join(baseDir(), "by-parent-active", String(parentPid));
    ensureActiveParentIndex(directory, parentPid);
    return readIndexedMetas(directory)
        .filter((meta) => meta.spawnPid === parentPid && isActiveStatus(meta.status));
}

export function listMetasForOrigin(origin: RunCallbackOrigin): RunMeta[] {
    const directory = join(baseDir(), "by-origin", originKey(origin));
    ensureIndex(directory, (meta) => belongsToOrigin(meta, origin));
    return readIndexedMetas(directory).filter((meta) => belongsToOrigin(meta, origin));
}

function readMetaForSweep(id: string): RunMeta | undefined {
    const cached = metaCache.get(id);
    if (cached && cached.status !== "running" && cached.status !== "orphaned") return cached;
    return readMeta(id);
}

function readIndexedMetas(directory: string): RunMeta[] {
    return readIndexIds(directory)
        .map((id) => metaCache.get(id) ?? readMeta(id))
        .filter((meta): meta is RunMeta => meta !== undefined)
        .sort((a, b) => b.startedAt - a.startedAt);
}

function indexMeta(meta: RunMeta): void {
    try {
        writeIndexEntry(join(baseDir(), "by-parent", String(meta.spawnPid)), meta.id);
        const activeDirectory = join(baseDir(), "by-parent-active", String(meta.spawnPid));
        if (isActiveStatus(meta.status)) writeIndexEntry(activeDirectory, meta.id);
        else removeIndexEntry(activeDirectory, meta.id);
        writeIndexEntry(join(baseDir(), "by-origin", originKey(originOf(meta))), meta.id);
    } catch {
        // Indexes are accelerators; meta.json remains authoritative.
    }
}

function writeIndexEntry(directory: string, id: string): void {
    mkdirSync(directory, { recursive: true });
    const cached = indexIdsCache.get(directory);
    const cacheWasCurrent = cached ? cached.signature === indexDirectorySignature(directory) : false;
    try {
        writeFileSync(join(directory, id), "", { flag: "wx" });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (cached && cacheWasCurrent) {
        cached.ids.add(id);
        cached.signature = indexDirectorySignature(directory);
    } else if (cached) {
        indexIdsCache.delete(directory);
    }
}

function removeIndexEntry(directory: string, id: string): void {
    const cached = indexIdsCache.get(directory);
    const cacheWasCurrent = cached ? cached.signature === indexDirectorySignature(directory) : false;
    try { unlinkSync(join(directory, id)); } catch { /* stale index entries are harmless */ }
    if (cached && cacheWasCurrent) {
        cached.ids.delete(id);
        cached.signature = indexDirectorySignature(directory);
    } else if (cached) {
        indexIdsCache.delete(directory);
    }
}

function readIndexIds(directory: string): string[] {
    const signature = indexDirectorySignature(directory);
    const cached = indexIdsCache.get(directory);
    if (cached && cached.signature === signature) return [...cached.ids];
    try {
        registryIo.indexDirectoryReads += 1;
        const ids = new Set(readdirSync(directory).filter((id) => id !== ".initialized"));
        indexIdsCache.set(directory, { ids, signature: indexDirectorySignature(directory) });
        return [...ids];
    } catch {
        indexIdsCache.delete(directory);
        return [];
    }
}

function isActiveStatus(status: RunStatus): boolean {
    return status === "running" || status === "orphaned";
}

function indexDirectorySignature(directory: string): string {
    registryIo.indexRevisionChecks += 1;
    try {
        const stat = statSync(directory);
        return `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch {
        return "missing";
    }
}

function ensureIndex(directory: string, matches: (meta: RunMeta) => boolean): void {
    if (initializedIndexes.has(directory)) return;
    try {
        readFileSync(join(directory, ".initialized"));
        initializedIndexes.add(directory);
        return;
    } catch {
        // Existing registries are backfilled once for each owner.
    }
    indexIdsCache.delete(directory);
    const owned = listMetas().filter(matches);
    mkdirSync(directory, { recursive: true });
    for (const meta of owned) writeIndexEntry(directory, meta.id);
    writeFileSync(join(directory, ".initialized"), "1");
    initializedIndexes.add(directory);
}

function ensureActiveParentIndex(directory: string, parentPid: number): void {
    if (initializedIndexes.has(directory)) return;
    try {
        readFileSync(join(directory, ".initialized"));
        initializedIndexes.add(directory);
        return;
    } catch {
        // Build the active set from the already owner-scoped parent index.
    }
    indexIdsCache.delete(directory);
    const active = listMetasForParent(parentPid).filter((meta) => isActiveStatus(meta.status));
    mkdirSync(directory, { recursive: true });
    for (const meta of active) writeIndexEntry(directory, meta.id);
    writeFileSync(join(directory, ".initialized"), "1");
    initializedIndexes.add(directory);
}

function originOf(meta: RunMeta): RunCallbackOrigin {
    return meta.callbackOrigin ?? { cwd: meta.cwd };
}

function belongsToOrigin(meta: RunMeta, origin: RunCallbackOrigin): boolean {
    const candidate = originOf(meta);
    if (candidate.cwd !== origin.cwd) return false;
    if (candidate.sessionId || origin.sessionId) return candidate.sessionId === origin.sessionId;
    return true;
}

function originKey(origin: RunCallbackOrigin): string {
    return createHash("sha256")
        .update(origin.cwd)
        .update("\0")
        .update(origin.sessionId ?? "")
        .digest("hex")
        .slice(0, 24);
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
