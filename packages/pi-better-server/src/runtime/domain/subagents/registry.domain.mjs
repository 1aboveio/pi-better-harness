// Generated fixed launch domain from packages/pi-better-subagents/registry.ts. Do not edit directly.
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
import { assignmentRetainsEvidence } from "./assignment-outcomes.domain.mjs";
import { processStartToken } from "./process-identity.mjs";
export { processStartToken } from "./process-identity.mjs";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { processExists } from "./spawn.domain.mjs";
import { archiveCompletedAttempt, durableSessionsDir, listArchivedAttempts, readArchivedAttempt, recordArchiveStatusTombstone, } from "./session-store.domain.mjs";
import { failureIdentity, observeFailures, readFailureState } from "./shared-failure-observations.domain.mjs";
/**
 * True when coherent child-exit evidence may finalize a run in this status.
 * `running` is the normal path; `orphaned`/`lost` are PROVISIONAL
 * reconciliation verdicts (a health tick can observe the just-exited pid
 * before the close handler runs) that the real exit — the stronger evidence —
 * supersedes. True terminal records are never overwritten: finalization is
 * idempotent (`completed`/`failed`) and a deliberate `subagent_stop` kill
 * (`killed`) is not undone by the resulting exit.
 */
export function canExitFinalize(status) {
    return status === "running" || status === "orphaned" || status === "lost";
}
/** Root of the VOLATILE runtime registry, deliberately OUTSIDE any repo. */
export function baseDir() {
    return join(realpathSync(tmpdir()), "pi-better-subagents");
}
/**
 * `--session-dir` for NEW child launches: the durable Pi agent directory
 * (`<agent dir>/subagents/sessions`), not the volatile registry. Saved
 * conversations are ordinary Pi session files, so changing TMPDIR or a restart
 * must not move them. Recipes recorded before this layout keep pointing at the
 * old temporary directory and are read exactly as recorded.
 */
export function sessionsDir() {
    return durableSessionsDir();
}
export function taskWorkspaceDir(id) {
    if (!/^sa_[a-z0-9]+_[a-z0-9]+$/i.test(id))
        throw new Error("Invalid task workspace run ID.");
    return join(realpathSync(tmpdir()), "pi-better-subagent-workspaces", id);
}
export function runDir(id) {
    return join(baseDir(), "runs", id);
}
export function logPathFor(id) {
    return join(runDir(id), "output.log");
}
export function promptPathFor(id) {
    return join(runDir(id), "prompt.md");
}
function metaPathFor(id) {
    return join(runDir(id), "meta.json");
}
export function parkRecordPath(id) {
    return join(runDir(id), "park.json");
}
/** Verify the shape before trusting a record read from disk. */
function parseParkRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const record = value;
    if (record.version !== 1)
        return undefined;
    if (typeof record.waitId !== "string" || !record.waitId)
        return undefined;
    if (!Number.isSafeInteger(record.generation) || (record.generation ?? 0) < 1)
        return undefined;
    if (typeof record.attemptId !== "string" || !record.attemptId)
        return undefined;
    if (typeof record.parkedAt !== "number" || !Number.isFinite(record.parkedAt))
        return undefined;
    const phases = ["parking", "waiting", "ready", "resuming", "held", "consumed", "cancelled"];
    if (!phases.includes(record.phase))
        return undefined;
    return record;
}
/**
 * Write the park disposition atomically and mirror it into the run's metadata.
 * The mirror keeps listings, the Goal provider and cleanup from needing a second
 * read; the file remains the authoritative copy for this attempt.
 */
export function writeParkRecord(id, record, options = {}) {
    if (!/^[A-Za-z0-9_-]+$/.test(id))
        throw new Error("Invalid run ID.");
    mkdirSync(runDir(id), { recursive: true });
    const path = parkRecordPath(id);
    const temp = join(dirname(path), `.park.${randomBytes(6).toString("hex")}.tmp`);
    writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    if (options.ifAbsent) {
        try {
            linkSync(temp, path);
        }
        catch (error) {
            if (error.code === "EEXIST")
                return;
            throw error;
        }
        finally {
            unlinkSync(temp);
        }
    }
    else
        renameSync(temp, path);
    const meta = readMeta(id);
    if (meta && (meta.park?.phase !== record.phase
        || meta.park?.heldReason !== record.heldReason
        || meta.park?.resumedBy !== record.resumedBy
        || meta.park?.resumeExitReconciledClaimId !== record.resumeExitReconciledClaimId)) {
        meta.park = record;
        writeMeta(meta);
    }
}
/** Read the attempt's park disposition; absent for an ordinary run. */
export function readParkRecord(id) {
    try {
        return parseParkRecord(JSON.parse(readFileSync(parkRecordPath(id), "utf-8")));
    }
    catch (error) {
        if (error.code !== "ENOENT")
            return undefined;
        // The volatile run directory may already be reclaimed; the durable
        // completed-attempt record carries the park snapshot taken at finalization.
        return readMeta(id)?.park;
    }
}
/** Merge one phase/reason change into the park disposition. */
export function updateParkRecord(id, patch) {
    const current = readParkRecord(id);
    if (!current)
        return undefined;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    writeParkRecord(id, next);
    return next;
}
/** A park still owns a pending continuation: `parking`, `waiting`, `ready`, `resuming` or `held`. */
export function isPendingPark(record) {
    return record.phase !== "consumed" && record.phase !== "cancelled";
}
/**
 * Runs whose park disposition can still resume. Used by cleanup protection and
 * by resume reconciliation; a consumed or cancelled park is not included.
 */
export function listPendingParkedRuns(metas = listMetas()) {
    return listParkRecordCandidates(metas).filter((meta) => {
        const record = meta.park ?? readParkRecord(meta.id);
        return record !== undefined && isPendingPark(record);
    });
}
/** Include a park file that was published just before its metadata mirror was lost. */
export function listParkRecordCandidates(metas = listMetas()) {
    let volatileIds;
    try {
        volatileIds = new Set(readdirSync(join(baseDir(), "runs")));
    }
    catch {
        volatileIds = new Set();
    }
    return metas.filter((meta) => meta.park !== undefined
        || (volatileIds.has(meta.id) && existsSync(parkRecordPath(meta.id))));
}
/**
 * How long a launch attempt that never produced a child is kept before a sweep
 * reclaims it. Launch preparation takes seconds; the grace only exists so a
 * paused or unusually slow launch in another process is never reclaimed under
 * it. A record this old has no metadata and no log, so it can never become a run.
 */
export const ABANDONED_LAUNCH_GRACE_MS = 60 * 60 * 1000;
/**
 * Parent-authored provenance for a run launched on the trusted task runtime (#325).
 *
 * `meta.taskRuntime` alone lives in the run directory. The parent only honours a child's
 * structured intent and `failure_disposition` calls when this separate record, written by the
 * parent before the child starts, also exists. It sits outside every run directory, under the
 * registry root that the task runtime's policy denies to the child (`runtimeRoots`), so a future
 * child-writable run directory cannot forge trust by rewriting its own metadata.
 */
export function taskRuntimeProvenancePath(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(id))
        throw new Error("Invalid run ID.");
    return join(baseDir(), "task-runtime", `${id}.json`);
}
export function recordTaskRuntimeProvenance(id) {
    const path = taskRuntimeProvenancePath(id);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ version: 1, id }), { mode: 0o600 });
}
/**
 * Remove a run directory together with its provenance record (#325). Every run-removal path
 * uses this, so no provenance outlives its run. Throws when the run directory cannot be removed.
 */
export function removeRunDirectory(id) {
    const meta = readMeta(id);
    if (meta && assignmentRetainsEvidence(meta))
        throw new Error("Assignment outcome or uncertain writer still retains this run's evidence.");
    rmSync(runDir(id), { recursive: true, force: true });
    removeTaskRuntimeProvenance(id);
}
/**
 * Undo everything a launch prepared before its child failed to spawn (#325, #332). Nothing references
 * the run yet (no metadata), so its run directory and provenance go, plus the per-run session
 * directory and disposable clone workspace of a sandboxed launch and the task scratch. Only the
 * run's own paths are removed: a shared sessions directory or a caller-chosen sandbox_dir is kept.
 */
export function discardFailedLaunch(id, prepared = {}) {
    try {
        removeRunDirectory(id);
    }
    catch { /* best effort */ }
    const remove = (path) => { try {
        rmSync(path, { recursive: true, force: true });
    }
    catch { /* best effort */ } };
    if (prepared.sessionDir && prepared.sessionDir === join(sessionsDir(), id))
        remove(prepared.sessionDir);
    if (prepared.workspaceDir && /^sa_[a-z0-9]+_[a-z0-9]+$/i.test(id) && prepared.workspaceDir === taskWorkspaceDir(id))
        remove(prepared.workspaceDir);
    if (prepared.scratch)
        remove(prepared.scratch);
}
/** Best-effort removal of a run's provenance record (e.g. after a failed launch). */
export function removeTaskRuntimeProvenance(id) {
    try {
        rmSync(taskRuntimeProvenancePath(id), { force: true });
    }
    catch { /* invalid id or already gone */ }
}
/**
 * Provenance records whose run directory no longer exists (e.g. removed by an older version). Only a
 * definite ENOENT counts as gone: any other stat error (permissions, I/O) keeps the record, since
 * deleting a live run's provenance would silently drop it to the exact-retry rule (#332).
 */
export function orphanedTaskRuntimeProvenance() {
    let names;
    try {
        names = readdirSync(join(baseDir(), "task-runtime"));
    }
    catch {
        return [];
    }
    return names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5))
        .filter((id) => { try {
        statSync(runDir(id));
        return false;
    }
    catch (error) {
        return error.code === "ENOENT";
    } });
}
/**
 * Whether the parent may honour structured intent for this run. `unknown` means the answer could
 * not be read right now (unreadable metadata or provenance); callers retry instead of caching it.
 * A missing or mismatched provenance record is a definite `unconfined` (the exact-retry rule).
 */
export function taskRuntimeTrust(id) {
    let raw;
    try {
        raw = readFileSync(taskRuntimeProvenancePath(id), "utf-8");
    }
    catch (error) {
        return error.code === "ENOENT" ? "unconfined" : "unknown";
    }
    let record;
    try {
        record = JSON.parse(raw);
    }
    catch {
        return "unconfined";
    }
    if (!record || typeof record !== "object" || record.id !== id)
        return "unconfined";
    const inspected = inspectRunMeta(id);
    if (inspected.kind !== "ok")
        return "unknown";
    return inspected.meta.taskRuntime === true ? "trusted" : "unconfined";
}
function launchRecordPath(id) {
    return join(runDir(id), ".launch.json");
}
function launchFromSource(source) {
    const name = typeof source.name === "string" && source.name.length > 0 ? source.name : undefined;
    const catalogKnown = Object.prototype.hasOwnProperty.call(source, "catalog") && source.catalog !== undefined;
    return { name, catalogKnown, catalog: catalogKnown ? source.catalog : undefined };
}
function serializeLaunch(record) {
    const payload = {};
    if (record.name !== undefined)
        payload.name = record.name;
    if (record.catalogKnown)
        payload.catalog = record.catalog ?? null;
    return JSON.stringify(payload);
}
function parseLaunch(raw, id) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        if (error instanceof SyntaxError)
            throw new Error(`Unreadable launch record for ${id}`);
        throw error;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Unreadable launch record for ${id}`);
    }
    return launchFromSource(parsed);
}
/** A committed meta.json is one historical launch. A truncated file is not. */
function readCommittedMetaLaunch(id) {
    let raw;
    try {
        raw = readFileSync(metaPathFor(id), "utf-8");
    }
    catch (error) {
        if (errnoOf(error) === "ENOENT")
            return undefined;
        throw error;
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return undefined;
        return launchFromSource(parsed);
    }
    catch (error) {
        if (error instanceof SyntaxError)
            return undefined;
        throw error;
    }
}
function applyLaunchRecord(meta, record) {
    if (record.name !== undefined)
        meta.name = record.name;
    else
        delete meta.name;
    if (record.catalogKnown)
        meta.catalog = record.catalog;
    else
        delete meta.catalog;
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
function publishImmutable(target, contents) {
    try {
        statSync(target);
        return;
    }
    catch (error) {
        if (errnoOf(error) !== "ENOENT")
            throw error;
    }
    const temp = join(dirname(target), `.immutable.${randomBytes(8).toString("hex")}.tmp`);
    const fd = openSync(temp, "wx");
    try {
        writeFileSync(fd, contents);
        fsyncSync(fd);
    }
    catch (error) {
        try {
            closeSync(fd);
        }
        catch (closeError) {
            if (errnoOf(closeError) !== "EBADF")
                throw closeError;
        }
        try {
            unlinkSync(temp);
        }
        catch (cleanup) {
            if (errnoOf(cleanup) !== "ENOENT")
                throw cleanup;
        }
        throw error;
    }
    closeSync(fd);
    try {
        linkSync(temp, target);
    }
    catch (error) {
        try {
            unlinkSync(temp);
        }
        catch (cleanup) {
            if (errnoOf(cleanup) !== "ENOENT")
                throw cleanup;
        }
        if (errnoOf(error) !== "EEXIST")
            throw error;
        return;
    }
    try {
        unlinkSync(temp);
    }
    catch (error) {
        if (errnoOf(error) !== "ENOENT")
            throw error;
    }
}
function readOptionalUtf8(target) {
    try {
        return readFileSync(target, "utf-8");
    }
    catch (error) {
        if (errnoOf(error) === "ENOENT")
            return undefined;
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
function applyFrozenLaunch(meta) {
    const path = launchRecordPath(meta.id);
    let raw = readOptionalUtf8(path);
    if (raw === undefined) {
        const committed = readCommittedMetaLaunch(meta.id) ?? launchFromSource(meta);
        publishImmutable(path, serializeLaunch(committed));
        raw = readOptionalUtf8(path);
        if (raw === undefined)
            throw new Error(`Missing launch record for ${meta.id}`);
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
function errnoOf(error) {
    return error.code;
}
function sleepMs(ms) {
    Atomics.wait(lockPause, 0, 0, ms);
}
function lockTimeout(id) {
    return new Error(`Timed out writing metadata for ${id}`);
}
let ownStartKnown = false;
let ownStartCache;
const foreignStartCache = new Map();
function ownStartToken() {
    if (ownStartKnown)
        return ownStartCache;
    ownStartCache = processStartToken(process.pid);
    ownStartKnown = true;
    return ownStartCache;
}
function cachedStartToken(pid) {
    const now = Date.now();
    const hit = foreignStartCache.get(pid);
    if (hit && now - hit.at < 200)
        return hit.token;
    const token = processStartToken(pid);
    foreignStartCache.set(pid, { token, at: now });
    return token;
}
function makeOwner() {
    return { pid: process.pid, token: randomBytes(16).toString("hex"), start: ownStartToken() };
}
function serializeOwner(owner) {
    return JSON.stringify({ pid: owner.pid, token: owner.token, start: owner.start ?? null });
}
function parseOwner(raw) {
    const trimmed = raw.trim();
    if (/^[1-9]\d*$/.test(trimmed)) {
        const pid = Number(trimmed);
        return Number.isSafeInteger(pid) ? { pid, token: "" } : undefined;
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object")
            return undefined;
        if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0)
            return undefined;
        if (typeof parsed.token !== "string")
            return undefined;
        const start = typeof parsed.start === "string" && parsed.start.length > 0 ? parsed.start : undefined;
        return { pid: parsed.pid, token: parsed.token, start };
    }
    catch {
        return undefined;
    }
}
/** A live pid is never stale, including when that process is stopped or paused. */
function ownerIsLive(owner) {
    if (owner.pid === process.pid)
        return true;
    if (!processExists(owner.pid))
        return false;
    if (!owner.start)
        return true;
    const current = cachedStartToken(owner.pid);
    if (!current)
        return true;
    return current === owner.start;
}
function isStaleLock(lockPath, raw) {
    const owner = parseOwner(raw);
    if (!owner) {
        try {
            return Date.now() - statSync(lockPath).mtimeMs > UNPARSABLE_LOCK_GRACE_MS;
        }
        catch (error) {
            if (errnoOf(error) === "ENOENT")
                return false;
            throw error;
        }
    }
    return !ownerIsLive(owner);
}
function restoreDisplacedLock(grave, lockPath) {
    try {
        linkSync(grave, lockPath);
    }
    catch (error) {
        if (errnoOf(error) !== "EEXIST")
            throw error;
        let displaced;
        try {
            displaced = readFileSync(grave, "utf-8");
        }
        catch (readError) {
            if (errnoOf(readError) === "ENOENT")
                return;
            throw readError;
        }
        if (!isStaleLock(grave, displaced))
            return;
        try {
            unlinkSync(grave);
        }
        catch (cleanup) {
            if (errnoOf(cleanup) !== "ENOENT")
                throw cleanup;
        }
        return;
    }
    try {
        unlinkSync(grave);
    }
    catch (error) {
        if (errnoOf(error) !== "ENOENT")
            throw error;
    }
}
/** Drop the lock file only when `predicate` still matches the inode we moved aside. */
function removeLockIf(lockPath, predicate) {
    let observed;
    try {
        observed = readFileSync(lockPath, "utf-8");
    }
    catch (error) {
        if (errnoOf(error) === "ENOENT")
            return;
        throw error;
    }
    if (!predicate(observed, lockPath))
        return;
    const grave = join(dirname(lockPath), `.meta.lock.${randomBytes(8).toString("hex")}.displaced`);
    try {
        renameSync(lockPath, grave);
    }
    catch (error) {
        if (errnoOf(error) === "ENOENT")
            return;
        throw error;
    }
    let moved;
    try {
        moved = readFileSync(grave, "utf-8");
    }
    catch (error) {
        let restoreError;
        try {
            restoreDisplacedLock(grave, lockPath);
        }
        catch (restore) {
            restoreError = restore;
        }
        if (restoreError)
            throw restoreError;
        throw error;
    }
    if (moved === observed && predicate(moved, grave)) {
        try {
            unlinkSync(grave);
        }
        catch (error) {
            if (errnoOf(error) !== "ENOENT")
                throw error;
        }
        return;
    }
    restoreDisplacedLock(grave, lockPath);
}
function lockPayloadMatches(lockPath, payload) {
    try {
        return readFileSync(lockPath, "utf-8") === payload;
    }
    catch (error) {
        if (errnoOf(error) === "ENOENT")
            return false;
        throw error;
    }
}
let databaseSyncCtor;
function databaseSync() {
    if (databaseSyncCtor !== undefined)
        return databaseSyncCtor;
    installSqliteWarningFilter();
    try {
        const loaded = nodeRequire("node:sqlite");
        databaseSyncCtor = loaded.DatabaseSync ?? null;
    }
    catch (error) {
        const code = errnoOf(error);
        const message = error instanceof Error ? error.message : String(error);
        const missing = code === "ERR_UNKNOWN_BUILTIN_MODULE"
            || message.includes("Cannot find package")
            || message.includes("Cannot find module")
            || message.includes("No such built-in module");
        if (!missing)
            throw error;
        databaseSyncCtor = null;
    }
    return databaseSyncCtor;
}
function installSqliteWarningFilter() {
    const marked = process;
    if (marked[sqliteWarningFilter])
        return;
    marked[sqliteWarningFilter] = true;
    const emit = process.emitWarning.bind(process);
    process.emitWarning = ((warning, ...args) => {
        const message = typeof warning === "string"
            ? warning
            : warning?.message;
        if (typeof message === "string" && message.includes("SQLite is an experimental feature"))
            return;
        return emit(warning, ...args);
    });
}
function isSqliteBusy(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /database is locked|SQLITE_BUSY/i.test(message);
}
/**
 * Cross-process critical section. Node's built-in SQLite reserved lock is
 * held for the whole section, including while this process is stopped, and
 * the kernel drops it if the process dies. Waiters give up at 5s instead of
 * blocking forever or stealing a live holder.
 */
function acquireProcessLock(directory) {
    const Ctor = databaseSync();
    if (!Ctor)
        return () => { };
    const db = new Ctor(join(directory, ".meta.lock.sqlite"));
    try {
        db.exec("PRAGMA busy_timeout = 5000");
        db.exec("BEGIN IMMEDIATE");
    }
    catch (error) {
        try {
            db.close();
        }
        catch (closeError) {
            if (!isSqliteBusy(error))
                throw closeError;
        }
        if (isSqliteBusy(error))
            throw lockTimeout(directory);
        throw error;
    }
    return () => {
        let rollbackError;
        try {
            db.exec("ROLLBACK");
        }
        catch (error) {
            rollbackError = error;
        }
        try {
            db.close();
        }
        catch (error) {
            if (!rollbackError)
                throw error;
        }
        if (rollbackError)
            throw rollbackError;
    };
}
function takeToken(lockPath, payload, deadline, id) {
    for (;;) {
        const creating = join(dirname(lockPath), `.meta.lock.${randomBytes(8).toString("hex")}.creating`);
        writeFileSync(creating, payload, { flag: "wx" });
        try {
            linkSync(creating, lockPath);
        }
        catch (error) {
            const code = errnoOf(error);
            try {
                unlinkSync(creating);
            }
            catch (cleanup) {
                if (errnoOf(cleanup) !== "ENOENT")
                    throw cleanup;
            }
            if (code !== "EEXIST")
                throw error;
            removeLockIf(lockPath, (raw, path) => isStaleLock(path, raw));
            if (Date.now() > deadline)
                throw lockTimeout(id);
            sleepMs(5);
            continue;
        }
        try {
            unlinkSync(creating);
        }
        catch (error) {
            if (errnoOf(error) !== "ENOENT")
                throw error;
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
function withRunMetaLock(id, body) {
    const directory = runDir(id);
    let releaseProcessLock;
    try {
        releaseProcessLock = acquireProcessLock(directory);
    }
    catch (error) {
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
                const owns = () => {
                    if (!ownsLock)
                        return false;
                    if (!lockPayloadMatches(lockPath, payload)) {
                        ownsLock = false;
                        return false;
                    }
                    return true;
                };
                if (!owns())
                    continue;
                body(owns);
                return;
            }
            catch (error) {
                if (error instanceof MetadataLockLost) {
                    ownsLock = false;
                    if (Date.now() > deadline)
                        throw lockTimeout(id);
                    continue;
                }
                throw error;
            }
            finally {
                if (ownsLock)
                    removeLockIf(lockPath, (raw) => raw === payload);
            }
        }
    }
    finally {
        releaseProcessLock();
    }
}
function writeMetaFile(meta) {
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
    }
    catch (error) {
        try {
            closeSync(fd);
        }
        catch (closeError) {
            if (errnoOf(closeError) !== "EBADF")
                throw closeError;
        }
        try {
            unlinkSync(temp);
        }
        catch (cleanup) {
            if (errnoOf(cleanup) !== "ENOENT")
                throw cleanup;
        }
        throw error;
    }
    closeSync(fd);
    try {
        renameSync(temp, target);
    }
    catch (error) {
        try {
            unlinkSync(temp);
        }
        catch (cleanup) {
            if (errnoOf(cleanup) !== "ENOENT")
                throw cleanup;
        }
        throw error;
    }
}
let seq = 0;
const metaCache = new Map();
/** Test-only pause/check after the run lock is held and before `meta.json` is replaced. */
let metaWriteBarrier;
export function setMetaWriteBarrierForTests(barrier) {
    metaWriteBarrier = barrier;
}
// Owned snapshots are process-resident. A cheap directory signature catches
// cross-process index changes before any cached IDs are reused.
const indexIdsCache = new Map();
const initializedIndexes = new Set();
const metaChangedListeners = new Set();
const registryIo = { fullDirectoryReads: 0, indexDirectoryReads: 0, metadataFileReads: 0, indexRevisionChecks: 0 };
export function getRegistryIoMetrics() {
    return { ...registryIo };
}
export function resetRegistryIoMetrics() {
    registryIo.fullDirectoryReads = 0;
    registryIo.indexDirectoryReads = 0;
    registryIo.metadataFileReads = 0;
    registryIo.indexRevisionChecks = 0;
}
/** Monotonic, readable, collision-free run id: `sa_<base36-time>_<seq>`. */
export function nextRunId() {
    seq += 1;
    return `sa_${Date.now().toString(36)}_${seq}`;
}
/** Failure-journal operation for durable archive publication. */
const ARCHIVE_OPERATION = "durable-archive";
/**
 * Journal the outcome of publishing one attempt's compact durable record in the
 * run's existing failures journal (`failures.jsonl`, read by the output and
 * result payloads). `undefined` reports a verified recovery.
 *
 * While publication keeps failing, the volatile run directory still holds the
 * only copy of the recipe, so both sweeps retain it; this incident is what makes
 * that state visible instead of silent. Best-effort: journaling never throws
 * into finalization or a sweep, and an untouched run keeps no journal.
 */
export function observeArchivePublication(id, error) {
    try {
        if (!/^[A-Za-z0-9_-]+$/.test(id))
            return;
        const path = join(runDir(id), "failures.jsonl");
        const key = failureIdentity(ARCHIVE_OPERATION);
        const open = readFailureState(path).observations[key];
        const at = Date.now();
        if (error === undefined) {
            if (!open || open.status !== "unresolved")
                return;
            observeFailures(path, [{
                    id: `archive-published:${id}:${at}`,
                    operation: ARCHIVE_OPERATION,
                    kind: "recovered",
                    at,
                    incidents: [open.id],
                    summary: "the compact durable continuation record was published",
                }]);
            return;
        }
        // One open incident per run: repeated sweeps retry the same publication and
        // must not fill the journal with the same failure.
        if (open && open.status === "unresolved")
            return;
        const detail = error instanceof Error ? error.message : String(error);
        observeFailures(path, [{
                id: `archive-failed:${id}:${at}`,
                operation: ARCHIVE_OPERATION,
                kind: "failure",
                at,
                category: "storage",
                summary: `durable continuation record could not be published (${detail}); this attempt's log and recipe are retained until it is`,
                evidence: `compact record for ${id}`,
            }]);
    }
    catch { /* the journal is best-effort; retaining the run is the safety net */ }
}
export function writeMeta(meta, options = {}) {
    if (options.patch && !readMeta(meta.id))
        return;
    mkdirSync(runDir(meta.id), { recursive: true });
    let written = false;
    withRunMetaLock(meta.id, (owns) => {
        if (options.ifAbsent && existsSync(metaPathFor(meta.id)))
            return;
        if (options.patch) {
            const current = readMeta(meta.id);
            if (!current)
                return;
            const patch = options.patch(current);
            if (!patch)
                return;
            meta = { ...current, ...patch, id: meta.id };
        }
        metaWriteBarrier?.();
        if (!owns())
            throw new MetadataLockLost();
        writeMetaFile(meta);
        metaCache.set(meta.id, meta);
        indexMeta(meta);
        // Publish the compact durable continuation record in the same critical
        // section, so a completed attempt is never visible only in volatile
        // storage. Best-effort: a durable write failure must not break a launch
        // or finalization (the volatile record still exists). It is journaled
        // instead, and both sweeps retain the run until publication succeeds.
        if (meta.status === "completed") {
            try {
                if (archiveCompletedAttempt(meta))
                    observeArchivePublication(meta.id);
            }
            catch (error) {
                observeArchivePublication(meta.id, error);
            }
        }
        owns();
        written = true;
    });
    if (options.patch && !written)
        return;
    for (const listener of metaChangedListeners) {
        try {
            listener();
        }
        catch { /* best effort */ }
    }
}
export function onMetaChanged(listener) {
    metaChangedListeners.add(listener);
    return () => metaChangedListeners.delete(listener);
}
export function readMeta(id) {
    try {
        registryIo.metadataFileReads += 1;
        const meta = JSON.parse(readFileSync(metaPathFor(id), "utf-8"));
        metaCache.set(id, meta);
        return meta;
    }
    catch (error) {
        metaCache.delete(id);
        // Only a MISSING volatile record falls back to the durable copy. An
        // unreadable or corrupt `meta.json` stays authoritative and is reported
        // as absent: a possibly stale archive must never replace it.
        if (error.code !== "ENOENT")
            return undefined;
        const archived = readArchivedAttempt(id);
        if (archived)
            metaCache.set(id, archived);
        return archived;
    }
}
export function removeMetaArtifacts(meta, options = {}) {
    try {
        // A newer failed/killed attempt's volatile record is about to be the only
        // evidence that the conversation's newest attempt did not complete. Leave
        // a durable marker first, or an older completed archive would become the
        // conversation's visible last word and could be continued as if this
        // attempt had never happened. A marker that cannot be published retains
        // the run (the throw below): the unsafe direction is deleting both.
        recordArchiveStatusTombstone(meta);
        removeRunDirectory(meta.id);
        if (!options.keepWorkspace
            && meta.taskRuntime && /^sa_[a-z0-9]+_[a-z0-9]+$/i.test(meta.id) && meta.cwd === taskWorkspaceDir(meta.id)) {
            rmSync(taskWorkspaceDir(meta.id), { recursive: true, force: true });
        }
        if (meta.taskRuntime && meta.taskScratch && dirname(meta.taskScratch) === realpathSync(tmpdir()) && /^pi-task-scratch-[a-z0-9]{6}$/i.test(basename(meta.taskScratch))) {
            rmSync(meta.taskScratch, { recursive: true, force: true });
        }
        metaCache.delete(meta.id);
        removeIndexEntry(join(baseDir(), "by-parent", String(meta.spawnPid)), meta.id);
        removeIndexEntry(join(baseDir(), "by-parent-active", String(meta.spawnPid)), meta.id);
        removeIndexEntry(join(baseDir(), "by-origin", originKey(originOf(meta))), meta.id);
        for (const listener of metaChangedListeners) {
            try {
                listener();
            }
            catch { /* best effort */ }
        }
        return true;
    }
    catch {
        return false;
    }
}
/**
 * All runs, newest first: the volatile registry plus durable archived attempts
 * whose raw log/run directory was already reclaimed. The volatile record wins
 * whenever both exist, so a reclaimed log never hides the live one.
 */
export function listMetas(options = {}) {
    let ids = [];
    try {
        registryIo.fullDirectoryReads += 1;
        ids = readdirSync(join(baseDir(), "runs"));
    }
    catch {
        ids = [];
    }
    const seen = new Set();
    const metas = [];
    for (const id of ids) {
        seen.add(id); // A corrupt volatile record must not be hidden by an older archive.
        const meta = readMetaForSweep(id);
        if (!meta)
            continue;
        metas.push(meta);
    }
    for (const meta of options.includeArchived === false ? [] : listArchivedAttempts()) {
        if (seen.has(meta.id))
            continue;
        seen.add(meta.id);
        metas.push(meta);
    }
    return metas.sort((a, b) => b.startedAt - a.startedAt);
}
/** Why parsed metadata is not a usable run record, or undefined when it is. */
export function runMetaShapeProblem(meta, id) {
    if (!meta || typeof meta !== "object" || Array.isArray(meta))
        return "not an object";
    const value = meta;
    if (value.id !== id)
        return `id ${JSON.stringify(value.id ?? null)} does not match ${JSON.stringify(id)}`;
    if (typeof value.status !== "string" || !value.status)
        return "missing status";
    if (typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt))
        return "missing startedAt";
    return undefined;
}
function launchAttemptClaimPath(id) {
    return join(runDir(id), ".launch-attempt.json");
}
/** Claim this run directory for a launch in progress. The directory must exist. */
export function recordLaunchAttempt(id) {
    const claim = { version: 1, id, pid: process.pid, at: Date.now() };
    const start = processStartToken(process.pid);
    if (start)
        claim.start = start;
    writeFileSync(launchAttemptClaimPath(id), JSON.stringify(claim), { mode: 0o600 });
}
/** Drop the claim once `meta.json` is the run's record. Best effort. */
export function clearLaunchAttempt(id) {
    try {
        unlinkSync(launchAttemptClaimPath(id));
    }
    catch { /* no claim, or the attempt's directory is already gone */ }
}
/**
 * Whether a launch claim is still owned by a live process. Conservative for one
 * direction only: an unreadable, malformed, or token-less claim counts as live,
 * so the attempt's artifacts are preserved. A dead pid, or a pid whose start
 * token no longer matches (recycled), is a dead attempt.
 */
function launchAttemptClaimIsLive(id) {
    let raw;
    try {
        raw = readFileSync(launchAttemptClaimPath(id), "utf-8");
    }
    catch (error) {
        return errnoOf(error) !== "ENOENT";
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return true;
    }
    if (!parsed || typeof parsed !== "object")
        return true;
    const pid = parsed.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
        return true;
    if (!processExists(pid))
        return false;
    const start = parsed.start;
    if (typeof start !== "string" || start.length === 0)
        return true;
    const current = cachedStartToken(pid);
    // An unavailable token does not prove the pid is dead, so the claim stays live.
    return current === undefined || current === start;
}
/**
 * True when a launch is preparing this run id right now, so its directory must
 * not be treated as debris. Unreadable state counts as in progress.
 */
export function launchAttemptInProgress(id) {
    if (!/^sa_[a-z0-9]+_[a-z0-9]+$/i.test(id))
        return false;
    return launchAttemptClaimIsLive(id);
}
/**
 * Read one run directory as an abandoned launch attempt, or `undefined`.
 *
 * A launch creates the directory, claims it, writes `prompt.md`, and prepares
 * the sandbox `control/` dir before the child starts and `meta.json` is
 * committed. When that preparation throws, or pi dies in that window, only
 * those artifacts remain: no metadata (nothing was committed) and no
 * `output.log` (the log is created at spawn and removed when the spawn itself
 * fails). Such a directory was never a run: it has no owner, no status, no log
 * and no result, and it can never gain any, so it must not be reported as
 * unreadable run evidence forever.
 *
 * The rule is deliberately narrow in the other direction too. A live launch
 * claim means the attempt is still being prepared and is never debris; a
 * directory WITH a log is not debris either, because a child may have started
 * and its output is real evidence; and a directory without the launch artifacts
 * is left to the age sweep rather than guessed at.
 */
export function abandonedLaunchRecord(id) {
    if (!/^sa_[a-z0-9]+_[a-z0-9]+$/i.test(id))
        return undefined;
    let mtimeMs;
    try {
        mtimeMs = statSync(runDir(id)).mtimeMs;
    }
    catch {
        return undefined;
    }
    // Metadata absence is the claim of debris, so it is re-established as late as
    // possible: the launch shape first, then every piece of run evidence.
    if (!existsSync(promptPathFor(id)) && !existsSync(join(runDir(id), "control")))
        return undefined;
    if (launchAttemptClaimIsLive(id))
        return undefined;
    try {
        statSync(metaPathFor(id));
        return undefined;
    }
    catch (error) {
        if (errnoOf(error) !== "ENOENT")
            return undefined;
    }
    try {
        statSync(logPathFor(id));
        return undefined;
    }
    catch (error) {
        if (errnoOf(error) !== "ENOENT")
            return undefined;
    }
    return { id, mtimeMs };
}
/**
 * Reclaim one abandoned launch attempt: its run directory, the per-run session
 * directory a confined launch prepared, and the clone workspace it owned. Only
 * paths named by the attempt's own id are removed (shared sessions and a
 * caller-chosen `sandbox_dir` are never touched), exactly like a failed launch.
 *
 * Classification runs again inside the same per-run lock `writeMeta` publishes
 * under, and the removal happens there, so a launch that commits metadata while
 * the purger waits is preserved instead of deleted. A held or unavailable lock
 * is a live writer, so it is preserved too. This closes the race the earlier
 * shape-only rule lost (#623 review R1): no deletion of a live attempt's
 * metadata or log, and no orphaned child left behind by a purge.
 */
export function purgeAbandonedLaunch(id) {
    if (!abandonedLaunchRecord(id))
        return "not-debris";
    let outcome = "retained";
    try {
        withRunMetaLock(id, (owns) => {
            if (!owns())
                throw new MetadataLockLost();
            // Re-establish the negative evidence under the publication exclusion.
            if (!abandonedLaunchRecord(id)) {
                outcome = "not-debris";
                return;
            }
            discardFailedLaunch(id, { sessionDir: join(sessionsDir(), id), workspaceDir: taskWorkspaceDir(id) });
            outcome = "purged";
        });
    }
    catch {
        // A live writer (or an unreadable run directory) is never safe to delete.
        // A directory that disappeared meanwhile is no longer debris.
        return abandonedLaunchRecord(id) ? "retained" : "not-debris";
    }
    if (outcome === "purged") {
        try {
            statSync(runDir(id));
            outcome = "retained";
        }
        catch (error) {
            if (errnoOf(error) !== "ENOENT")
                outcome = "retained";
        }
    }
    return outcome;
}
/**
 * Inspect one run's metadata without collapsing "missing" and "corrupt":
 * `missing` only when neither metadata nor the run directory exists.
 */
export function inspectRunMeta(id) {
    let raw;
    try {
        registryIo.metadataFileReads += 1;
        raw = readFileSync(metaPathFor(id), "utf-8");
    }
    catch (error) {
        metaCache.delete(id);
        const code = error.code;
        if (code === "ENOENT") {
            try {
                statSync(runDir(id));
                return { kind: "unreadable", detail: "metadata file is missing; the run directory and its evidence are retained" };
            }
            catch {
                const archived = readArchivedAttempt(id);
                return archived ? { kind: "ok", meta: archived } : { kind: "missing" };
            }
        }
        return { kind: "unreadable", detail: error instanceof Error ? error.message : String(error) };
    }
    let meta;
    try {
        meta = JSON.parse(raw);
    }
    catch (error) {
        metaCache.delete(id);
        return { kind: "unreadable", detail: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
    const invalid = runMetaShapeProblem(meta, id);
    if (invalid) {
        metaCache.delete(id);
        return { kind: "unreadable", detail: `invalid metadata: ${invalid}` };
    }
    metaCache.set(id, meta);
    return { kind: "ok", meta };
}
/** Every run directory, counting unreadable records instead of dropping them. */
export function listRunRecords() {
    let ids = [];
    try {
        registryIo.fullDirectoryReads += 1;
        ids = readdirSync(join(baseDir(), "runs"));
    }
    catch (error) {
        const code = error.code;
        if (code !== "ENOENT")
            return { metas: [], unreadable: [], abandoned: [], indexError: error instanceof Error ? error.message : String(error) };
    }
    const metas = [];
    const unreadable = [];
    const abandoned = [];
    for (const id of ids) {
        const cached = metaCache.get(id);
        if (cached && cached.status !== "running" && cached.status !== "orphaned") {
            metas.push(cached);
            continue;
        }
        const inspected = inspectRunMeta(id);
        if (inspected.kind === "ok")
            metas.push(inspected.meta);
        else if (inspected.kind === "unreadable") {
            if (abandonedLaunchRecord(id))
                abandoned.push(id);
            else
                unreadable.push({ id, detail: inspected.detail });
        }
    }
    const volatileIds = new Set(ids);
    for (const archived of listArchivedAttempts()) {
        if (!volatileIds.has(archived.id))
            metas.push(archived);
    }
    metas.sort((a, b) => b.startedAt - a.startedAt);
    return { metas, unreadable, abandoned };
}
export function listMetasForParent(parentPid) {
    const directory = join(baseDir(), "by-parent", String(parentPid));
    ensureIndex(directory, (meta) => meta.spawnPid === parentPid);
    return readIndexedMetas(directory).filter((meta) => meta.spawnPid === parentPid);
}
export function listActiveMetasForParent(parentPid) {
    const directory = join(baseDir(), "by-parent-active", String(parentPid));
    ensureActiveParentIndex(directory, parentPid);
    return readIndexedMetas(directory)
        .filter((meta) => meta.spawnPid === parentPid && isActiveStatus(meta.status));
}
export function listMetasForOrigin(origin) {
    const directory = join(baseDir(), "by-origin", originKey(origin));
    ensureIndex(directory, (meta) => belongsToOrigin(meta, origin));
    return readIndexedMetas(directory).filter((meta) => belongsToOrigin(meta, origin));
}
function readMetaForSweep(id) {
    const cached = metaCache.get(id);
    if (cached && cached.status !== "running" && cached.status !== "orphaned")
        return cached;
    return readMeta(id);
}
function readIndexedMetas(directory) {
    return readIndexIds(directory)
        .map((id) => metaCache.get(id) ?? readMeta(id))
        .filter((meta) => meta !== undefined)
        .sort((a, b) => b.startedAt - a.startedAt);
}
function indexMeta(meta) {
    try {
        writeIndexEntry(join(baseDir(), "by-parent", String(meta.spawnPid)), meta.id);
        const activeDirectory = join(baseDir(), "by-parent-active", String(meta.spawnPid));
        if (isActiveStatus(meta.status))
            writeIndexEntry(activeDirectory, meta.id);
        else
            removeIndexEntry(activeDirectory, meta.id);
        writeIndexEntry(join(baseDir(), "by-origin", originKey(originOf(meta))), meta.id);
    }
    catch {
        // Indexes are accelerators; meta.json remains authoritative.
    }
}
function writeIndexEntry(directory, id) {
    mkdirSync(directory, { recursive: true });
    const cached = indexIdsCache.get(directory);
    const cacheWasCurrent = cached ? cached.signature === indexDirectorySignature(directory) : false;
    try {
        writeFileSync(join(directory, id), "", { flag: "wx" });
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
    }
    if (cached && cacheWasCurrent) {
        cached.ids.add(id);
        cached.signature = indexDirectorySignature(directory);
    }
    else if (cached) {
        indexIdsCache.delete(directory);
    }
}
function removeIndexEntry(directory, id) {
    const cached = indexIdsCache.get(directory);
    const cacheWasCurrent = cached ? cached.signature === indexDirectorySignature(directory) : false;
    try {
        unlinkSync(join(directory, id));
    }
    catch { /* stale index entries are harmless */ }
    if (cached && cacheWasCurrent) {
        cached.ids.delete(id);
        cached.signature = indexDirectorySignature(directory);
    }
    else if (cached) {
        indexIdsCache.delete(directory);
    }
}
function readIndexIds(directory) {
    const signature = indexDirectorySignature(directory);
    const cached = indexIdsCache.get(directory);
    if (cached && cached.signature === signature)
        return [...cached.ids];
    try {
        registryIo.indexDirectoryReads += 1;
        const ids = new Set(readdirSync(directory).filter((id) => id !== ".initialized"));
        indexIdsCache.set(directory, { ids, signature: indexDirectorySignature(directory) });
        return [...ids];
    }
    catch {
        indexIdsCache.delete(directory);
        return [];
    }
}
function isActiveStatus(status) {
    return status === "running" || status === "orphaned";
}
function indexDirectorySignature(directory) {
    registryIo.indexRevisionChecks += 1;
    try {
        const stat = statSync(directory);
        return `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`;
    }
    catch {
        return "missing";
    }
}
function ensureIndex(directory, matches) {
    if (initializedIndexes.has(directory))
        return;
    try {
        readFileSync(join(directory, ".initialized"));
        initializedIndexes.add(directory);
        return;
    }
    catch {
        // Existing registries are backfilled once for each owner.
    }
    indexIdsCache.delete(directory);
    const owned = listMetas().filter(matches);
    mkdirSync(directory, { recursive: true });
    for (const meta of owned)
        writeIndexEntry(directory, meta.id);
    writeFileSync(join(directory, ".initialized"), "1");
    initializedIndexes.add(directory);
}
function ensureActiveParentIndex(directory, parentPid) {
    if (initializedIndexes.has(directory))
        return;
    try {
        readFileSync(join(directory, ".initialized"));
        initializedIndexes.add(directory);
        return;
    }
    catch {
        // Build the active set from the already owner-scoped parent index.
    }
    indexIdsCache.delete(directory);
    const active = listMetasForParent(parentPid).filter((meta) => isActiveStatus(meta.status));
    mkdirSync(directory, { recursive: true });
    for (const meta of active)
        writeIndexEntry(directory, meta.id);
    writeFileSync(join(directory, ".initialized"), "1");
    initializedIndexes.add(directory);
}
export function originOf(meta) {
    return meta.callbackOrigin ?? { cwd: meta.cwd };
}
export function belongsToOrigin(meta, origin) {
    const candidate = originOf(meta);
    if (candidate.cwd !== origin.cwd)
        return false;
    if (candidate.sessionId || origin.sessionId)
        return candidate.sessionId === origin.sessionId;
    return true;
}
export function originKey(origin) {
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
export function effectiveStatus(meta) {
    if (meta.status !== "running")
        return meta.status;
    if (processExists(meta.pid))
        return "running";
    return "exited";
}
/**
 * True when a status can yield a FINAL result: everything except `running`
 * and the non-terminal `orphaned`. `lost` is terminal (best-available
 * artifacts, never a completion); `exited` keeps its historic resultable
 * treatment. Used by subagent_result's gate.
 */
export function isFinalResultStatus(status) {
    return status !== "running" && status !== "orphaned";
}
/** True when this meta was spawned by the given parent pi PID (default: this process). */
export function ownedByThisParent(meta, parentPid = process.pid) {
    return meta.spawnPid === parentPid;
}
/** True when the run has been dismissed from the human navigator. */
export function isDismissed(meta) {
    return typeof meta.dismissedAt === "number";
}
/**
 * Mark a run dismissed from the navigator, durably. Idempotent: the first
 * dismissal timestamp wins. Returns the updated meta, or undefined for an
 * unknown id. Only the timestamp changes — all other metadata is preserved.
 */
export function dismissRun(id, at = Date.now()) {
    const meta = readMeta(id);
    if (!meta)
        return undefined;
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
export function navigatorVisibleRuns(metas, parentPid = process.pid) {
    return metas.filter((m) => ownedByThisParent(m, parentPid) && !isDismissed(m));
}
/** Footer-count seam: how many runs the navigator affordance advertises. */
export function navigatorVisibleCount(metas, parentPid = process.pid) {
    return navigatorVisibleRuns(metas, parentPid).length;
}
