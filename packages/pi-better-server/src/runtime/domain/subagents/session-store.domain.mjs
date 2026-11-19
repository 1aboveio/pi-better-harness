// Generated fixed launch domain from packages/pi-better-subagents/session-store.ts. Do not edit directly.
/**
 * Durable native-session storage for subagents.
 *
 * A subagent conversation is an ordinary Pi session file. Its history and the
 * launch recipe needed to continue it therefore belong with the user's Pi agent
 * state, not in the volatile runtime registry under `os.tmpdir()`: changing
 * TMPDIR, a restart, or the age/size sweeps must not strand a completed
 * attempt's saved conversation. This module owns the two durable locations and
 * nothing else:
 *
 * - `<agent dir>/subagents/sessions` — the `--session-dir` of NEW child
 *   launches. Pi's own SessionManager writes there, so no copy or mirror exists.
 * - `<agent dir>/subagents/attempts/<run id>.json` — a compact continuation
 *   record (metadata + frozen launch recipe) published atomically when an
 *   attempt completes. Raw logs, results, timing and callback markers stay in
 *   the volatile registry and are reclaimed by the existing sweeps.
 *
 * The durable store deliberately has no expiry, size cap, or recovery design:
 * cleanup never removes a durable conversation's saved history or attempt
 * record, and a missing saved conversation refuses continuation instead of being
 * recreated. Deleting them is an explicit operator action. Recipes written by
 * older versions that point at the old temporary session directory are legacy:
 * they are read as recorded and never migrated or guessed at.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
/**
 * Test-isolation override for the whole durable root. Production resolves the
 * Pi agent directory; the package's tests point this at a private directory so
 * they never touch the machine's real `~/.pi/agent/subagents`.
 */
const DURABLE_ROOT_ENV = "PI_SUBAGENT_DURABLE_DIR";
const ARCHIVE_VERSION = 1;
/**
 * Durable "the conversation's newest attempt did not complete" marker. It is
 * published before that attempt's volatile metadata is reclaimed, so an older
 * completed archive can no longer speak for the conversation.
 */
const ARCHIVE_STATUS_VERSION = 1;
/** Terminal statuses that leave a conversation unavailable for continuation. */
const NON_RESUMABLE_STATUSES = new Set(["failed", "killed", "lost"]);
/** Fields copied into the compact record: what discovery, display, and continuation read. */
const ARCHIVE_META_KEYS = [
    "id", "name", "status", "pid", "startedAt", "endedAt", "exitCode", "failureReason",
    "lifecycleClassification", "cwd", "promptPreview", "logPath", "sessionId",
    "rootRunId", "resumedFrom", "recipe", "sandbox", "taskRuntime", "callback",
    "batchId", "batchName", "model", "effort", "spawnPid", "spawnPidStartTime",
    "dismissedAt",
    // A parked attempt's disposition and operation binding outlive the volatile
    // run directory: the resume path and cleanup protection read this record.
    "park", "operations", "assignment", "pidStartTime",
];
function isSafeRunId(id) {
    return typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id);
}
/**
 * Root of durable subagent state: `<agent dir>/subagents`, honoring
 * `PI_CODING_AGENT_DIR`. Resolved per call so a foreground that changes its
 * agent directory (and every test) sees the same value the launcher used.
 */
export function durableSubagentRoot(env = process.env, home = homedir()) {
    const override = env[DURABLE_ROOT_ENV]?.trim();
    if (override) {
        if (!isAbsolute(override))
            throw new Error(`${DURABLE_ROOT_ENV} must be an absolute path.`);
        return override;
    }
    const agentDir = env.PI_CODING_AGENT_DIR?.trim();
    return join(agentDir || join(home, ".pi", "agent"), "subagents");
}
/** Durable `--session-dir` for new child launches. */
export function durableSessionsDir() {
    return join(durableSubagentRoot(), "sessions");
}
/** Durable compact continuation records for completed attempts. */
export function durableAttemptsDir() {
    return join(durableSubagentRoot(), "attempts");
}
/**
 * Durable per-conversation markers for the newest attempt that ended WITHOUT a
 * completion (see `recordArchiveStatusTombstone`).
 */
export function durableSessionStateDir() {
    return join(durableSubagentRoot(), "session-state");
}
/** True when `path` is the durable session root or lies beneath it. */
export function isDurableSessionsPath(path) {
    const root = durableSessionsDir();
    return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
function attemptPath(id) {
    if (!isSafeRunId(id))
        throw new Error("Invalid run ID.");
    return join(durableAttemptsDir(), `${id}.json`);
}
/** Copy the compact fields of one attempt; the raw log and volatile markers stay behind. */
function compactAttempt(meta) {
    const compact = {};
    for (const key of ARCHIVE_META_KEYS) {
        const value = meta[key];
        if (value !== undefined)
            compact[key] = value;
    }
    return compact;
}
/**
 * Whether this record is the compact durable record of a completed attempt of a
 * durable-layout conversation. Only a completed attempt is archived: a legacy
 * attempt whose recipe points at the old temporary session directory, or a
 * fixture without a recipe, keeps the pre-existing reclaimable behavior, and a
 * failed/killed attempt is not resumable, so archiving it would only pin its
 * clone. The recipe and the attempt must agree about the conversation identity,
 * so a record can never become a second, contradicting source of truth.
 */
function durableCompletion(meta) {
    if (meta.status !== "completed")
        return false;
    const recipe = meta.recipe;
    if (!recipe || recipe.version !== 1)
        return false;
    if (recipe.sessionId !== meta.sessionId)
        return false;
    return isDurableSessionsPath(recipe.sessionDir);
}
/**
 * Whether a completed durable-layout attempt still has no published compact
 * record. Its volatile run directory then holds the ONLY copy of the recipe, so
 * the age and size bounds must retain the whole run rather than reclaim it.
 */
export function archivePublicationPending(meta) {
    if (!durableCompletion(meta) || !isSafeRunId(meta.id))
        return false;
    // Cleanup can publish several attempts in one pass. Each atomic rename
    // invalidates the archive listing, so verify only this attempt's record.
    try {
        return readPublishedAttempt(meta.id, true) === undefined;
    }
    catch (error) {
        const code = error.code;
        if (code !== "ENOENT" && code !== "ENOTDIR")
            throw error;
        return true;
    }
}
/**
 * Publish the compact record for a completed attempt, atomically.
 *
 * Returns true when this call published or verified an identical record and
 * false when the attempt is not archivable at all. Missing, corrupt or changed
 * records are atomically replaced; redundant retries preserve source identity.
 * IO failures throw:
 * the caller decides whether the volatile record is retained.
 */
export function archiveCompletedAttempt(meta) {
    if (!durableCompletion(meta))
        return false;
    if (!isSafeRunId(meta.id))
        throw new Error("Invalid run ID.");
    const directory = durableAttemptsDir();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = attemptPath(meta.id);
    const record = { version: ARCHIVE_VERSION, meta: compactAttempt(meta) };
    const payload = JSON.stringify(record);
    let previous;
    try {
        previous = readFileSync(path, "utf8");
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    let identical = false;
    if (previous !== undefined) {
        try {
            identical = isDeepStrictEqual(JSON.parse(previous), JSON.parse(payload));
        }
        catch { /* A corrupt record must be repaired by the real writer. */ }
    }
    if (!identical) {
        const temp = join(directory, `.${randomBytes(8).toString("hex")}.tmp`);
        try {
            writeFileSync(temp, payload, { mode: 0o600, flag: "wx" });
            renameSync(temp, path);
        }
        catch (error) {
            try {
                unlinkSync(temp);
            }
            catch { /* best effort */ }
            throw error;
        }
    }
    // The published record now speaks for this conversation, so a marker left by
    // an older non-completing attempt no longer applies.
    clearSupersededArchiveStatus(meta);
    return true;
}
/**
 * Validate one archived record against the run id it was asked for. Anything
 * that does not match is treated as absent: guessing a conversation identity
 * from a damaged or foreign record would continue the wrong history.
 */
export function parseArchivedAttempt(raw, id, sessionRoot = durableSessionsDir()) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return undefined;
    const record = parsed;
    if (record.version !== ARCHIVE_VERSION)
        return undefined;
    const meta = record.meta;
    if (!meta || typeof meta !== "object" || Array.isArray(meta))
        return undefined;
    if (meta.id !== id)
        return undefined;
    // Only a completed attempt is ever archived; a record that claims otherwise
    // cannot speak for the conversation.
    if (meta.status !== "completed")
        return undefined;
    if (typeof meta.startedAt !== "number" || !Number.isFinite(meta.startedAt))
        return undefined;
    if (typeof meta.sessionId !== "string" || !isSafeRunId(meta.sessionId))
        return undefined;
    if (typeof meta.cwd !== "string" || meta.cwd === "")
        return undefined;
    const recipe = meta.recipe;
    if (!recipe || typeof recipe !== "object" || recipe.version !== 1)
        return undefined;
    if (recipe.sessionId !== meta.sessionId)
        return undefined;
    if (typeof recipe.sessionDir !== "string" || !(recipe.sessionDir === sessionRoot || recipe.sessionDir.startsWith(sessionRoot.endsWith(sep) ? sessionRoot : `${sessionRoot}${sep}`)))
        return undefined;
    if (typeof recipe.cwd !== "string" || recipe.cwd === "")
        return undefined;
    return meta;
}
/** One published archived completed attempt, ignoring staleness. */
function readPublishedAttempt(id, requireReadable = false) {
    if (!isSafeRunId(id))
        return undefined;
    let raw;
    try {
        raw = readFileSync(attemptPath(id), "utf-8");
    }
    catch (error) {
        // A direct lookup can refuse continuation as absent. A list also
        // authorizes tombstone/cleanup decisions, so partial history is unsafe.
        if (requireReadable)
            throw error;
        return undefined;
    }
    return parseArchivedAttempt(raw, id);
}
/**
 * One archived completed attempt that may still speak for its conversation, or
 * undefined. A conversation whose newest attempt ended without completing is not
 * resumable, and this record must not offer an older completion as one.
 */
export function readArchivedAttempt(id) {
    const meta = readPublishedAttempt(id);
    return meta && !archiveSuperseded(meta) ? meta : undefined;
}
let archiveListCache;
let archiveFiles = new Map();
function attemptsSignature() {
    try {
        const stat = statSync(durableAttemptsDir());
        return `${durableAttemptsDir()}:${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`;
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        return `${durableAttemptsDir()}:missing`;
    }
}
/**
 * Every published compact record, staleness not applied. The directory
 * signature (which changes when a record is atomically replaced) keeps repeated
 * `listMetas` calls cheap. After a publication, reuse unchanged file identities
 * rather than parsing the entire history again. Markers have their own boundary.
 */
function archivedAttempts() {
    const signature = attemptsSignature();
    if (archiveListCache?.signature === signature)
        return archiveListCache.metas;
    let names = [];
    try {
        names = readdirSync(durableAttemptsDir());
    }
    catch (error) {
        const code = error.code;
        // A missing directory (or a file at that path) contains no archives.
        // Permission and I/O refusals cannot establish that same absence.
        if (code !== "ENOENT" && code !== "ENOTDIR")
            throw error;
        names = [];
    }
    const metas = [];
    const files = new Map();
    for (const name of names) {
        if (!name.endsWith(".json"))
            continue;
        const path = join(durableAttemptsDir(), name);
        const fileSignature = stateSignature(path);
        const cached = archiveFiles.get(path);
        const entry = cached?.signature === fileSignature ? cached : {
            signature: fileSignature,
            meta: readPublishedAttempt(name.slice(0, -".json".length), true),
        };
        // Retain successful observations even if a later file refuses a read.
        // The list signature is committed only after the entire scan succeeds.
        archiveFiles.set(path, entry);
        files.set(path, entry);
        if (entry.meta)
            metas.push(entry.meta);
    }
    archiveFiles = files;
    archiveListCache = { signature, metas };
    return metas;
}
let visibleArchiveCache;
/** Every archived completed attempt that may still speak for its conversation. */
export function listArchivedAttempts() {
    const metas = archivedAttempts();
    const directory = durableSessionStateDir();
    const signature = `${directory}:${stateSignature(directory)}`;
    if (visibleArchiveCache?.metas === metas && visibleArchiveCache.signature === signature) {
        return visibleArchiveCache.visible;
    }
    // Atomic marker add/replace/delete changes the directory identity. Enumerate
    // published markers once; missing markers never need one stat per archive.
    let names;
    try {
        names = readdirSync(directory);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        names = [];
    }
    const sessions = new Set(names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)));
    const visible = metas.filter((meta) => !sessions.has(meta.sessionId) || !archiveSuperseded(meta));
    visibleArchiveCache = { metas, signature, visible };
    return visible;
}
/** Whether this conversation has any published compact record at all. */
export function hasArchivedAttemptForSession(sessionId) {
    return archivedAttempts().some((meta) => meta.sessionId === sessionId);
}
function statePath(sessionId) {
    if (!isSafeRunId(sessionId))
        throw new Error("Invalid session ID.");
    return join(durableSessionStateDir(), `${sessionId}.json`);
}
function stateSignature(path) {
    try {
        const stat = statSync(path);
        return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        return "missing";
    }
}
/** Anything that does not match the requested conversation is treated as absent. */
export function parseArchivedSessionState(raw, sessionId) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return undefined;
    const record = parsed;
    if (record.version !== ARCHIVE_STATUS_VERSION)
        return undefined;
    if (record.sessionId !== sessionId)
        return undefined;
    if (!isSafeRunId(record.attemptId))
        return undefined;
    if (typeof record.status !== "string" || !NON_RESUMABLE_STATUSES.has(record.status))
        return undefined;
    if (typeof record.startedAt !== "number" || !Number.isFinite(record.startedAt))
        return undefined;
    return record;
}
/** One marker file, re-read only when its inode, size, or timestamps change. */
const stateCache = new Map();
function readArchivedSessionState(sessionId) {
    if (!isSafeRunId(sessionId))
        return undefined;
    const path = statePath(sessionId);
    const signature = stateSignature(path);
    const cached = stateCache.get(path);
    if (cached && cached.signature === signature)
        return cached.state;
    let state;
    try {
        state = parseArchivedSessionState(readFileSync(path, "utf-8"), sessionId);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        state = undefined;
    }
    stateCache.set(path, { signature, state });
    return state;
}
/**
 * Whether a marker for a strictly later attempt of this conversation hides this
 * archive. A record at least as new as the marker is unaffected, so the newest
 * completed attempt is always resumable.
 */
function archiveSuperseded(meta) {
    const state = readArchivedSessionState(meta.sessionId);
    if (!state)
        return false;
    return state.attemptId !== meta.id && state.startedAt >= meta.startedAt;
}
/**
 * Publish the "newest attempt did not complete" marker for one conversation,
 * before that attempt's volatile metadata is reclaimed.
 *
 * Without it, reclaiming a failed/killed attempt's record would let an older
 * completed archive look like the conversation's last word and be offered for
 * continuation again. The marker never makes an attempt resumable.
 *
 * Returns false when the record needs no marker (not a non-completing attempt,
 * or the conversation has no published completion to invalidate). IO failures
 * throw so the caller retains the volatile record instead of losing the fact.
 */
export function recordArchiveStatusTombstone(meta) {
    if (!NON_RESUMABLE_STATUSES.has(meta.status))
        return false;
    if (!isSafeRunId(meta.sessionId) || !isSafeRunId(meta.id))
        return false;
    if (typeof meta.startedAt !== "number" || !Number.isFinite(meta.startedAt))
        return false;
    if (!hasArchivedAttemptForSession(meta.sessionId))
        return false;
    const existing = readArchivedSessionState(meta.sessionId);
    // A newer attempt is already marked; its marker is the stronger evidence.
    if (existing && existing.startedAt >= meta.startedAt)
        return true;
    const directory = durableSessionStateDir();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = statePath(meta.sessionId);
    const temp = join(directory, `.${randomBytes(8).toString("hex")}.tmp`);
    const record = {
        version: ARCHIVE_STATUS_VERSION,
        sessionId: meta.sessionId,
        attemptId: meta.id,
        status: meta.status,
        startedAt: meta.startedAt,
        at: Date.now(),
    };
    try {
        writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
        renameSync(temp, path);
    }
    catch (error) {
        try {
            unlinkSync(temp);
        }
        catch { /* best effort */ }
        throw error;
    }
    return true;
}
/**
 * Drop a marker the published record supersedes: a completion at least as new as
 * the marker is the conversation's newest attempt, so the marker's claim is no
 * longer true. Best effort — a marker left behind only hides older records.
 */
function clearSupersededArchiveStatus(meta) {
    const state = readArchivedSessionState(meta.sessionId);
    if (!state)
        return;
    if (state.attemptId !== meta.id && state.startedAt > meta.startedAt)
        return;
    try {
        unlinkSync(statePath(meta.sessionId));
    }
    catch { /* already gone */ }
}
