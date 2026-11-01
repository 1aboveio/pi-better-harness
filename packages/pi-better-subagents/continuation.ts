/**
 * Completed-subagent continuation.
 *
 * A subagent attempt is one detached `pi -p` process; its conversation is a
 * saved native session JSONL that outlives the process. Continuation keeps the
 * conversation and allocates a NEW attempt, so old logs, results, callback
 * markers, and timing records stay intact under their own run id.
 *
 * This module owns the four seams that decision needs and that the rest of the
 * package must not duplicate:
 *
 * 1. **Saved-conversation identity.** Find the exact JSONL for a session id and
 *    prove its header still names that id and the expected workspace. Pi's
 *    `--session` opens a missing path by creating a fresh conversation, so a
 *    continuation validates first and refuses instead of silently replacing
 *    history.
 * 2. **Launch recipe.** Capture the effective launch (tools, exclusions,
 *    clean/nesting/approval intent, confinement, model, effort, role identity,
 *    workspace intent) on run metadata.
 * 3. **Explicit retention.** `retain_session` records a bounded promise that a
 *    completed conversation and its workspace stay out of cleanup until a
 *    foreground session releases it. Retention lives in the existing runtime
 *    storage, so system-temp reaping can still remove it; a missing
 *    conversation refuses.
 *
 * Foreground-session ownership is provenance, not an authorization boundary:
 * Pi sessions are ordinary files on disk, so any foreground session that can
 * name a completed attempt with a verifiable saved conversation, workspace, and
 * launch recipe may continue it (or release its optional retention). The new
 * attempt records the INVOKING foreground as its callback origin and its
 * permission admission is re-resolved from the current profile, so continuing
 * transfers the run to the caller instead of borrowing the original owner's
 * authority.
 * 4. **Conversation writer lease.** A cross-process token lease held from
 *    admission through child lifetime and finalization. Duplicate continuations
 *    of one conversation admit exactly one writer. Lease-path and retention
 *    mutations run inside a short kernel-owned per-conversation transaction, so
 *    stale recovery cannot expose an empty path to a competing admission.
 *    Stale leases are recovered only with process-identity or terminal-attempt
 *    evidence, and never while the attempt's own detached child is still alive:
 *    the lease holder and the writer are different processes, so the holder
 *    dying is not quiescence. Missing attempt metadata is also not quiescence —
 *    the launch path spawns before publishing it — so that state needs an
 *    explicit operator recovery.
 *
 * No worker, RPC daemon, or new poller exists between attempts: the next
 * attempt is an ordinary detached launch, and a parked owner occupies no
 * capacity slot.
 */

import { randomBytes } from "node:crypto";
import {
    closeSync,
    linkSync,
    mkdirSync,
    openSync,
    readFileSync,
    readSync,
    readdirSync,
    realpathSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import {
    baseDir,
    listMetas,
    processStartToken,
    readMeta,
    type LaunchRecipe,
    type RunCallbackOrigin,
    type RunMeta,
    type RunStatus,
} from "./registry.ts";
import { processExists } from "./spawn.ts";
import { durableSubagentRoot } from "./session-store.ts";

const nodeRequire = createRequire(import.meta.url);

/** A continuation that cannot proceed. The message is the model-facing refusal. */
export class ContinuationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ContinuationError";
    }
}

// ---- saved conversation identity -----------------------------------------

/** Native conversation that a continuation reopens. */
export interface SavedConversation {
    sessionId: string;
    /** Exact session JSONL path handed to `--session`. */
    path: string;
    /** Canonical workspace recorded in the session header. */
    cwd: string;
}

export type ConversationLookup =
    | { kind: "ok"; conversation: SavedConversation }
    | { kind: "missing" }
    | { kind: "ambiguous"; paths: string[] }
    | { kind: "mismatch"; detail: string }
    | { kind: "invalid"; detail: string };

/** Header lines are small; this bound only prevents reading a whole session. */
const SESSION_HEADER_BYTES = 256 * 1024;

function canonicalPath(path: string): string {
    try {
        return realpathSync.native(path);
    } catch {
        return path;
    }
}

/** First JSON line of a session file, or undefined when it is not a session header. */
export function readSessionHeader(path: string): Record<string, unknown> | undefined {
    let fd: number | undefined;
    try {
        fd = openSync(path, "r");
        const buffer = Buffer.alloc(SESSION_HEADER_BYTES);
        const read = readSync(fd, buffer, 0, buffer.length, 0);
        if (read <= 0) return undefined;
        const text = buffer.subarray(0, read).toString("utf-8");
        const newline = text.indexOf("\n");
        const line = (newline === -1 ? text : text.slice(0, newline)).trim();
        if (!line) return undefined;
        const parsed = JSON.parse(line) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : undefined;
    } catch {
        return undefined;
    } finally {
        if (fd !== undefined) {
            try { closeSync(fd); } catch { /* read-only handle */ }
        }
    }
}

/**
 * Find the saved conversation for `sessionId` and prove it still belongs to
 * this attempt's workspace. Ambiguity is refused, never guessed: a wrong file
 * would silently continue someone else's history.
 */
export function findSavedConversation(options: {
    sessionDir: string;
    sessionId: string;
    expectedCwd: string;
}): ConversationLookup {
    const { sessionDir, sessionId, expectedCwd } = options;
    if (!isSafeRunId(sessionId)) return { kind: "invalid", detail: `session id ${JSON.stringify(sessionId)} is not a valid run id` };
    let names: string[];
    try {
        names = readdirSync(sessionDir);
    } catch {
        return { kind: "missing" };
    }
    const matches: string[] = [];
    let headerCwd: string | undefined;
    // Pi names session files `<timestamp>_<sessionId>.jsonl`. Try that exact
    // suffix first so a resume does not read the header prefix of every
    // conversation in a busy session directory; fall back to a header scan for
    // renamed or foreign layouts instead of guessing.
    const direct = names.filter((name) => name.endsWith(`_${sessionId}.jsonl`));
    if (direct.length > 1) return { kind: "ambiguous", paths: direct.map((name) => join(sessionDir, name)).sort() };
    const candidates = direct.length === 1 ? direct : names.filter((name) => name.endsWith(".jsonl"));
    for (const name of candidates) {
        const path = join(sessionDir, name);
        const header = readSessionHeader(path);
        if (!header || header.type !== "session") {
            if (direct.length === 1) return { kind: "invalid", detail: `${path} is not a saved Pi session` };
            continue;
        }
        if (header.id !== sessionId) {
            if (direct.length === 1) return { kind: "invalid", detail: `${path} names session ${JSON.stringify(header.id)}` };
            continue;
        }
        matches.push(path);
        if (headerCwd === undefined && typeof header.cwd === "string") headerCwd = header.cwd;
    }
    if (matches.length === 0) return { kind: "missing" };
    if (matches.length > 1) return { kind: "ambiguous", paths: matches.sort() };
    const path = matches[0]!;
    const expected = canonicalPath(expectedCwd);
    if (headerCwd === undefined || headerCwd.trim() === "") {
        return { kind: "mismatch", detail: `saved conversation ${path} records no workspace` };
    }
    const recorded = canonicalPath(headerCwd);
    if (recorded !== expected) {
        return { kind: "mismatch", detail: `saved conversation ${path} belongs to workspace ${recorded}, not ${expected}` };
    }
    return { kind: "ok", conversation: { sessionId, path, cwd: recorded } };
}

// ---- launch recipe -------------------------------------------------------

/** Freeze the effective launch of one attempt for later continuation. */
export function buildLaunchRecipe(input: Omit<LaunchRecipe, "version">): LaunchRecipe {
    const recipe: LaunchRecipe = { version: 1, ...input };
    if (input.excludeTools === "") delete recipe.excludeTools;
    if (input.sandboxDir === "") delete recipe.sandboxDir;
    return recipe;
}

/** Compare implementation identity separately from current permission admission. */
export function assertContinuationExtensions(
    priorId: string,
    recipe: LaunchRecipe,
    baseArgs: readonly string[],
    trusted: readonly { name: string; package: string; loadPath: string }[],
): void {
    const expected = recipe.baseExtensionArgs ?? recipe.extensionArgs;
    if (expected && JSON.stringify(baseArgs) !== JSON.stringify(expected)) {
        throw new ContinuationError(`Cannot continue ${priorId}: resolved extension implementations changed; launch a new run rather than changing this conversation's runtime silently.`);
    }
    if (!recipe.trustedExtensions) return;
    for (const current of trusted) {
        const original = recipe.trustedExtensions.find((tool) => tool.name === current.name);
        if (!original || original.package !== current.package
            || canonicalPath(original.loadPath) !== canonicalPath(current.loadPath)) {
            throw new ContinuationError(`Cannot continue ${priorId}: resolved extension implementation changed for ${current.name}; launch a new run instead.`);
        }
    }
}

// ---- explicit retention --------------------------------------------------

/**
 * Durable retention for one conversation. `retainedAt` is the first request;
 * later attempts refresh `lastAttemptId` without extending the promise, which
 * stays bounded by the existing runtime-storage cleanup rules.
 */
export interface RetentionRecord {
    version: 1;
    sessionId: string;
    /** First attempt of the conversation's lineage. */
    ownerRunId: string;
    /** Canonical workspace kept available for continuation. */
    workspace: string;
    /**
     * Foreground session that first retained this conversation. Provenance for
     * diagnostics only: retention is optional convenience, not a tenancy
     * boundary, so any foreground session may release it.
     */
    ownerOrigin: RunCallbackOrigin;
    retainedAt: number;
    lastAttemptId: string;
    releasedAt?: number;
    releasedBy?: RunCallbackOrigin;
}

export function retentionDir(): string {
    return join(baseDir(), "retained");
}

function retentionPath(sessionId: string): string {
    if (!isSafeRunId(sessionId)) throw new Error("Invalid session id.");
    return join(retentionDir(), `${sessionId}.json`);
}

function isSafeRunId(id: unknown): id is string {
    return typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id);
}

function parseRetention(raw: string, sessionId: string): RetentionRecord | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Partial<RetentionRecord>;
    if (record.version !== 1 || record.sessionId !== sessionId) return undefined;
    if (typeof record.ownerRunId !== "string" || typeof record.workspace !== "string") return undefined;
    if (typeof record.retainedAt !== "number" || typeof record.lastAttemptId !== "string") return undefined;
    const origin = record.ownerOrigin;
    if (!origin || typeof origin.cwd !== "string") return undefined;
    return record as RetentionRecord;
}

export function readRetention(sessionId: string): RetentionRecord | undefined {
    if (!isSafeRunId(sessionId)) return undefined;
    try {
        return parseRetention(readFileSync(retentionPath(sessionId), "utf-8"), sessionId);
    } catch {
        return undefined;
    }
}

function writeRetention(record: RetentionRecord): void {
    const path = retentionPath(record.sessionId);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = join(dirname(path), `.${randomBytes(8).toString("hex")}.tmp`);
    try {
        writeFileSync(temp, JSON.stringify(record, null, 2), { mode: 0o600, flag: "wx" });
        renameSync(temp, path);
    } catch (error) {
        try { unlinkSync(temp); } catch { /* best effort */ }
        throw error;
    }
}

/** Every parseable retention record, including released ones. */
export function listRetentionRecords(): RetentionRecord[] {
    let names: string[];
    try {
        names = readdirSync(retentionDir());
    } catch {
        return [];
    }
    const records: RetentionRecord[] = [];
    for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const sessionId = name.slice(0, -5);
        if (!isSafeRunId(sessionId)) continue;
        const record = readRetention(sessionId);
        if (record) records.push(record);
    }
    return records;
}

/** Session ids whose conversation and workspace must survive cleanup. */
export function retainedSessionIds(): Set<string> {
    const ids = new Set<string>();
    for (const record of listRetentionRecords()) {
        if (record.releasedAt === undefined) ids.add(record.sessionId);
    }
    return ids;
}

/** Run ids belonging to a retained conversation (every attempt, not just the root). */
export function retainedRunIds(metas: readonly RunMeta[] = listMetas()): Set<string> {
    const sessions = retainedSessionIds();
    const ids = new Set<string>();
    if (sessions.size === 0) return ids;
    for (const meta of metas) {
        if (sessions.has(meta.sessionId)) ids.add(meta.id);
    }
    return ids;
}

/** Record an explicit retention request. An existing record keeps its first timestamp. */
export function retainConversation(options: {
    sessionId: string;
    ownerRunId: string;
    workspace: string;
    ownerOrigin: RunCallbackOrigin;
    attemptId: string;
    now?: number;
}): RetentionRecord {
    return withConversationMutation(options.sessionId, () => {
        const existing = readRetention(options.sessionId);
        const record: RetentionRecord = existing
            ? { ...existing, lastAttemptId: options.attemptId }
            : {
                version: 1,
                sessionId: options.sessionId,
                ownerRunId: options.ownerRunId,
                workspace: canonicalPath(options.workspace),
                ownerOrigin: { cwd: options.ownerOrigin.cwd, sessionId: options.ownerOrigin.sessionId },
                retainedAt: options.now ?? Date.now(),
                lastAttemptId: options.attemptId,
            };
        writeRetention(record);
        return record;
    }, { waitMs: RETENTION_LOCK_WAIT_MS });
}

/** Extend retention to a continuation attempt, but never revive a released one. */
export function refreshRetentionForAttempt(options: {
    sessionId: string;
    attemptId: string;
}): RetentionRecord | undefined {
    return withConversationMutation(options.sessionId, () => {
        // Read and write inside one critical section: a release acknowledged by
        // another process before this section began is visible to the re-read
        // and is never overwritten by an attempt refresh.
        const existing = readRetention(options.sessionId);
        if (!existing || existing.releasedAt !== undefined) return undefined;
        const record: RetentionRecord = { ...existing, lastAttemptId: options.attemptId };
        writeRetention(record);
        return record;
    }, { waitMs: RETENTION_LOCK_WAIT_MS });
}

/** Mark a validated retention record released. Deletion is left to normal cleanup. */
export function markRetentionReleased(
    record: RetentionRecord,
    origin: RunCallbackOrigin,
    now: number = Date.now(),
): RetentionRecord {
    return withConversationMutation(record.sessionId, () => {
        // Re-read under the same lock the refresh path uses. An acknowledged
        // release is monotonic: it is never revived by a stale attempt refresh
        // that was planned before this section.
        const current = readRetention(record.sessionId) ?? record;
        if (current.releasedAt !== undefined) return current;
        const released: RetentionRecord = {
            ...current,
            releasedAt: now,
            releasedBy: { cwd: origin.cwd, sessionId: origin.sessionId },
        };
        writeRetention(released);
        return released;
    }, { waitMs: RETENTION_LOCK_WAIT_MS });
}

// ---- ownership and continuation plan ------------------------------------

/**
 * True when `origin` is the foreground session recorded on the run.
 *
 * This is a provenance/labelling helper, deliberately NOT an admission gate: a
 * different foreground session may continue a completed attempt (see the
 * module header). Callers that need to route a notification use it to decide
 * which foreground a run belongs to, not to deny an operation.
 */
export function ownedByOrigin(meta: RunMeta, origin: RunCallbackOrigin | undefined): boolean {
    const recorded = meta.callbackOrigin;
    if (!origin?.sessionId || typeof origin.cwd !== "string") return false;
    if (!recorded?.sessionId) return false;
    return recorded.cwd === origin.cwd && recorded.sessionId === origin.sessionId;
}

export interface ContinuationPlan {
    prior: RunMeta;
    recipe: LaunchRecipe;
    conversation: SavedConversation;
    /** First attempt of the conversation's lineage. */
    rootRunId: string;
}

function refusal(id: string, reason: string): ContinuationError {
    return new ContinuationError(`Cannot continue ${id}: ${reason}`);
}

function effectiveAttemptStatus(meta: RunMeta): RunStatus | "exited" {
    if (meta.status !== "running") return meta.status;
    return processExists(meta.pid) ? "running" : "exited";
}

function isActiveAttempt(meta: RunMeta): boolean {
    const status = effectiveAttemptStatus(meta);
    return status === "running" || status === "orphaned";
}

/**
 * Validate one completed attempt for continuation and return the exact
 * conversation plus frozen recipe to relaunch. Every refusal is fail-closed:
 * nothing is spawned and no history is created or replaced.
 */
export function planContinuation(options: {
    id: string;
    prior: RunMeta | undefined;
    origin: RunCallbackOrigin | undefined;
    others: readonly RunMeta[];
}): ContinuationPlan {
    const { id, prior, origin, others } = options;
    if (!prior) throw refusal(id, "no such run id.");
    // The invoking foreground is still required, because the new attempt's
    // completion callback and navigator entry are routed to it. It is not
    // required to be the attempt's original owner: the saved session, workspace,
    // and recipe are the thing being continued, and Pi sessions are shared
    // on-disk state rather than a per-foreground boundary.
    if (!origin?.sessionId) throw refusal(id, "the active foreground session identity is unavailable.");
    if (prior.status !== "completed") {
        throw refusal(id, `its status is ${prior.status}; only a completed run can be continued. Stop or launch a new run instead.`);
    }
    const recipe = prior.recipe;
    if (!recipe || recipe.version !== 1) throw refusal(id, "it was launched before continuation support, so no launch recipe was saved.");
    if (recipe.sessionId !== prior.sessionId) throw refusal(id, "its launch recipe and metadata disagree about the conversation identity.");
    if (canonicalPath(recipe.cwd) !== canonicalPath(prior.cwd)) throw refusal(id, "its launch recipe and metadata disagree about the workspace.");

    const active = others.find((meta) => meta.sessionId === prior.sessionId && meta.id !== prior.id && isActiveAttempt(meta));
    if (active) throw refusal(id, `attempt ${active.id} is still active in the same conversation; stop it first.`);

    let workspaceIsDir = false;
    try { workspaceIsDir = statSync(recipe.cwd).isDirectory(); } catch { workspaceIsDir = false; }
    if (!workspaceIsDir) throw refusal(id, `its workspace ${recipe.cwd} is missing.`);
    if (recipe.sandboxDir !== undefined) {
        let sandboxIsDir = false;
        try { sandboxIsDir = statSync(recipe.sandboxDir).isDirectory(); } catch { sandboxIsDir = false; }
        if (!sandboxIsDir) throw refusal(id, `its sandbox workspace ${recipe.sandboxDir} is missing.`);
    }

    const lookup: ConversationLookup = findSavedConversation({
        sessionDir: recipe.sessionDir,
        sessionId: recipe.sessionId,
        expectedCwd: recipe.cwd,
    });
    switch (lookup.kind) {
        case "ok":
            return { prior, recipe, conversation: lookup.conversation, rootRunId: prior.rootRunId ?? prior.id };
        case "missing":
            throw refusal(id, `its saved conversation is gone (session ${recipe.sessionId} under ${recipe.sessionDir}). Retained history lives in temporary storage and can be removed; launch a new run instead.`);
        case "ambiguous":
            throw refusal(id, `its saved conversation is ambiguous (${lookup.paths.length} files name session ${recipe.sessionId}); refusing to guess which history to continue.`);
        case "invalid":
        case "mismatch":
            throw refusal(id, `its saved conversation cannot be verified: ${lookup.detail}.`);
    }
}

/** Validate an explicit retention release. Returns the record to mark released. */
export function planRetentionRelease(options: {
    id: string;
    prior: RunMeta | undefined;
    origin: RunCallbackOrigin | undefined;
    others: readonly RunMeta[];
}): RetentionRecord {
    const { id, prior, origin, others } = options;
    if (!prior) throw new ContinuationError(`Cannot release ${id}: no such run id.`);
    // Release is the same on-disk convenience promise as continuation: any
    // foreground that can name the attempt may drop optional retention. The
    // invoking identity is still required, because the record keeps `releasedBy`
    // and the decision must be attributable to a real foreground session.
    if (!origin?.sessionId) throw new ContinuationError(`Cannot release ${id}: the active foreground session identity is unavailable.`);
    const record = readRetention(prior.sessionId);
    if (!record) throw new ContinuationError(`Cannot release ${id}: it was not launched with retain_session, so it has no retained conversation.`);
    if (record.releasedAt !== undefined) {
        throw new ContinuationError(`Cannot release ${id}: its retention was already released at ${new Date(record.releasedAt).toISOString()}.`);
    }
    const active = others.find((meta) => meta.sessionId === prior.sessionId && isActiveAttempt(meta));
    if (active) throw new ContinuationError(`Cannot release ${id}: attempt ${active.id} is still active in the same conversation. Stop it first.`);
    return record;
}

// ---- cross-process conversation writer lease -----------------------------

export class ConversationBusyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConversationBusyError";
    }
}

export interface ConversationLease {
    sessionId: string;
    attemptId: string;
    token: string;
    path: string;
    /** Idempotent; only removes the lease this holder published. */
    release(): void;
}

interface LeasePayload {
    pid: number;
    start?: string;
    token: string;
    sessionId: string;
    attemptId: string;
    at: number;
}

/** A live holder must be visible for this long before its terminal attempt frees the lease. */
const TERMINAL_ATTEMPT_RECLAIM_MS = 5_000;
const UNPARSABLE_LEASE_GRACE_MS = 1_000;
/** Admission is fail-fast: another foreground mutation is a refusal, not a wait. */
const ADMISSION_LOCK_WAIT_MS = 0;
/** Release and retention are short cleanup decisions; wait briefly for their lock. */
const RELEASE_LOCK_WAIT_MS = 1_000;
const RETENTION_LOCK_WAIT_MS = 1_000;

/**
 * Stable writer-lease root, independent of TMPDIR: a conversation is ordinary
 * on-disk Pi state, so a foreground that restarts under a different temp root
 * must still see the one writer slot. Retention records stay in the volatile
 * registry as before.
 */
export function conversationLeaseDir(): string {
    return join(durableSubagentRoot(), "conversation-leases");
}

function leasePathFor(sessionId: string): string {
    return join(conversationLeaseDir(), `${sessionId}.lock`);
}

function errnoOf(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException).code;
}

// ---- per-conversation mutation lock --------------------------------------

/**
 * Refuse rather than proceed when the kernel lock that makes lease and
 * retention mutations serial cannot be created. Node 24 ships `node:sqlite`;
 * on a runtime without it the one-writer guarantee is unavailable, so every
 * admission, release, and retention write fails closed instead of racing.
 */
export class ConversationLockUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConversationLockUnavailableError";
    }
}

interface MutationDb {
    exec(sql: string): void;
    close(): void;
}

const sqliteWarningFilter = Symbol.for("pi-better-subagents.continuation-sqlite-warning-filter");

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

let databaseSyncCtor: (new (path: string) => MutationDb) | null | undefined;

function databaseSync(): (new (path: string) => MutationDb) | null {
    if (databaseSyncCtor !== undefined) return databaseSyncCtor;
    installSqliteWarningFilter();
    try {
        const loaded = nodeRequire("node:sqlite") as { DatabaseSync?: new (path: string) => MutationDb };
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

function isSqliteBusy(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /database is locked|SQLITE_BUSY/i.test(message);
}

/**
 * Stable transaction file for one conversation. It is never renamed or deleted
 * while the conversation is in use: SQLite's reserved lock lives in this file,
 * and the kernel drops that lock when its holder exits.
 */
function conversationMutationPath(sessionId: string): string {
    return join(conversationLeaseDir(), `${sessionId}.mutations.sqlite`);
}

export interface ConversationMutationOptions {
    /** How long SQLite may wait for a concurrent holder. Default 0 (fail fast). */
    waitMs?: number;
}

/**
 * Serialize one conversation's lease-path and retention mutations across
 * processes with a short kernel-owned critical section.
 *
 * The body runs while SQLite holds `BEGIN IMMEDIATE` on the conversation's
 * stable transaction file. No other process can enter a conversation mutation
 * at the same time, so a reclaim cannot expose an empty lease path to an
 * admission, and a retention refresh cannot publish a stale unreleased record
 * over an acknowledged release. The transaction is released immediately after
 * the body returns: it covers the mutation, never the detached child's lifetime.
 *
 * `waitMs` defaults to 0 so admission fails fast. Callers that own cleanup may
 * pass a small budget. A body must not call another public conversation
 * mutation for the same conversation; private `*Unlocked` helpers exist for
 * that reason and keep the lock non-reentrant.
 */
export function withConversationMutation<T>(
    sessionId: string,
    body: () => T,
    options: ConversationMutationOptions = {},
): T {
    if (!isSafeRunId(sessionId)) throw new Error("Invalid session id for a conversation mutation.");
    const Ctor = databaseSync();
    if (!Ctor) {
        throw new ConversationLockUnavailableError(
            `Cannot update conversation ${sessionId}: this Pi runtime does not provide node:sqlite, so the cross-process conversation lock required for one-writer continuation is unavailable. Upgrade to Node 24 or newer.`,
        );
    }
    const directory = conversationLeaseDir();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const db = new Ctor(conversationMutationPath(sessionId));
    const requestedWait = options.waitMs ?? 0;
    const waitMs = Number.isFinite(requestedWait)
        ? Math.min(60_000, Math.max(0, Math.floor(requestedWait)))
        : 0;
    try {
        db.exec(`PRAGMA busy_timeout = ${waitMs}`);
        try {
            db.exec("BEGIN IMMEDIATE");
        } catch (error) {
            if (isSqliteBusy(error)) {
                throw new ConversationBusyError(
                    `Cannot update conversation ${sessionId}: another foreground process is inside a conversation mutation.`,
                );
            }
            throw error;
        }
    } catch (error) {
        try { db.close(); } catch { /* preserve the lock error */ }
        throw error;
    }
    let result: T;
    try {
        result = body();
    } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* closing rolls back too */ }
        try { db.close(); } catch { /* preserve the body error */ }
        throw error;
    }
    try {
        db.exec("ROLLBACK");
    } finally {
        db.close();
    }
    return result;
}

function parseLeasePayload(raw: string): LeasePayload | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const payload = parsed as Partial<LeasePayload>;
    if (typeof payload.pid !== "number" || !Number.isInteger(payload.pid) || payload.pid <= 0) return undefined;
    if (typeof payload.token !== "string" || typeof payload.sessionId !== "string") return undefined;
    if (typeof payload.attemptId !== "string" || typeof payload.at !== "number") return undefined;
    return payload as LeasePayload;
}

/** Process-identity seam for the lease. Production uses the OS probe. */
export interface LeaseProbe {
    startToken?(pid: number): string | undefined;
}

/** Metadata of the attempt a lease names, when that id is a real run id. */
function readAttemptMeta(attemptId: string): RunMeta | undefined {
    if (!isSafeRunId(attemptId)) return undefined;
    try {
        return readMeta(attemptId);
    } catch {
        return undefined;
    }
}

/**
 * Whether the attempt's recorded child may still be writing the conversation.
 *
 * The lease is taken by the supervising pi process, but the writer is the
 * detached child it spawned: a supervisor can exit — normally, by crash, or as a
 * `killed`/`lost` record whose kill has not landed — while its child keeps
 * appending to the saved session. Recorded process-start identity is compared so
 * a recycled pid cannot stand in for the old writer; an unavailable token proves
 * nothing and counts as alive.
 *
 * The process group is deliberately not writer evidence: only the child pi writes
 * the session, and treating a surviving tool descendant as a writer would strand
 * the conversation until that descendant exits.
 */
function recordedWriterLive(meta: RunMeta, probe?: LeaseProbe): boolean {
    const pid = meta.pid;
    if (typeof pid !== "number" || pid <= 0 || !processExists(pid)) return false;
    if (meta.pidStartTime === undefined) return true;
    const current = (probe?.startToken ?? processStartToken)(pid);
    if (current === undefined) return true;
    return current === meta.pidStartTime;
}

/** True when the held pid now belongs to an unrelated process. */
function holderRecycled(payload: LeasePayload, probe?: LeaseProbe): boolean {
    if (payload.start === undefined) return false;
    const current = (probe?.startToken ?? processStartToken)(payload.pid);
    return current !== undefined && current !== payload.start;
}

/**
 * Whether an existing lease may be recovered. Conservative by design: a live
 * holder keeps its lease unless its recorded start identity proves pid
 * recycling, and a dead or recycled holder is still not quiescence while the
 * attempt's own child is alive. That child outlives the process that took the
 * lease, so it is checked before any creator-death or terminal-status
 * conclusion, including `killed`/`lost` whose kill may not have landed yet.
 *
 * A missing attempt record proves nothing about the child: the launch sequence
 * acquires the lease, spawns the detached child, and only then publishes
 * metadata. A dead holder with no record can therefore be a live writer whose
 * supervisor crashed in that window. Such a lease is refused until an operator
 * explicitly recovers the conversation or starts a new one.
 */
function leaseReclaimable(
    leasePath: string,
    raw: string,
    now: number,
    probe?: LeaseProbe,
    explicitRecovery = false,
): boolean {
    const payload = parseLeasePayload(raw);
    if (!payload) {
        try {
            return now - statSync(leasePath).mtimeMs > UNPARSABLE_LEASE_GRACE_MS;
        } catch (error) {
            if (errnoOf(error) === "ENOENT") return true;
            return false;
        }
    }
    const own = payload.pid === process.pid;
    if (!own && processExists(payload.pid) && !holderRecycled(payload, probe)) return false;
    const meta = readAttemptMeta(payload.attemptId);
    if (!meta) {
        if (!explicitRecovery) return false;
        // Even an explicit recovery keeps the same grace for this process's own
        // just-published lease, so an in-flight admission is not stolen from.
        if (own && now - payload.at < TERMINAL_ATTEMPT_RECLAIM_MS) return false;
        return true;
    }
    if (recordedWriterLive(meta, probe)) return false;
    if (!own) return true;
    if (now - payload.at < TERMINAL_ATTEMPT_RECLAIM_MS) return false;
    return isTerminalStatus(meta.status);
}

function isTerminalStatus(status: RunStatus): boolean {
    return status === "completed" || status === "failed" || status === "killed" || status === "lost";
}

function conversationBusy(sessionId: string, attemptId: string): ConversationBusyError {
    return new ConversationBusyError(
        `Cannot continue ${attemptId}: conversation ${sessionId} is already being written by another attempt.`,
    );
}

function readLeaseRaw(leasePath: string): string | undefined {
    try {
        return readFileSync(leasePath, "utf-8");
    } catch (error) {
        if (errnoOf(error) === "ENOENT") return undefined;
        throw error;
    }
}

/**
 * Publish one complete lease at its path. The caller holds the conversation
 * mutation lock, so an existing lease was either judged recoverable or
 * admission already refused.
 *
 * A fresh path is published with a hard link (never overwriting an unknown
 * holder). Reclaiming an existing path atomically renames the new complete
 * lease over it, so no reader — including cleanup, which does not take this
 * lock — can observe an empty path while a stale holder is being replaced.
 */
function publishLeaseUnlocked(leasePath: string, serialized: string, replace: boolean): void {
    const creating = join(dirname(leasePath), `.${randomBytes(8).toString("hex")}.creating`);
    writeFileSync(creating, serialized, { mode: 0o600, flag: "wx" });
    try {
        if (replace) renameSync(creating, leasePath);
        else linkSync(creating, leasePath);
    } catch (error) {
        try { unlinkSync(creating); } catch { /* best effort */ }
        if (errnoOf(error) === "EEXIST") {
            throw new ConversationBusyError("Conversation lease changed during a serialized admission.");
        }
        throw error;
    }
    if (!replace) {
        try { unlinkSync(creating); } catch { /* best effort */ }
    }
}

/** Remove only the exact lease this holder published. Caller holds the lock. */
function releaseLeaseUnlocked(leasePath: string, serialized: string): void {
    const observed = readLeaseRaw(leasePath);
    if (observed === undefined || observed !== serialized) return;
    try {
        unlinkSync(leasePath);
    } catch (error) {
        if (errnoOf(error) !== "ENOENT") throw error;
    }
}

/**
 * Acquire the conversation writer lease.
 *
 * Admission is one serialized critical section: existing bytes are inspected
 * and a recoverable lease is replaced atomically with this holder's complete
 * lease before the transaction ends. No other admission can enter the section,
 * and the path is never empty during replacement, which is what makes stale
 * recovery unable to displace a newer holder or admit a second writer.
 *
 * `waitMs` defaults to 0 so duplicate admission fails fast instead of stalling
 * the foreground event loop. `explicitRecovery` is an operator escape for a
 * conversation whose writer evidence is permanently unavailable (for example a
 * supervisor killed between spawning its child and publishing metadata); it is
 * never used by ordinary continuation.
 */
export function acquireConversationLease(options: {
    sessionId: string;
    attemptId: string;
    waitMs?: number;
    now?: () => number;
    probe?: LeaseProbe;
    explicitRecovery?: boolean;
}): ConversationLease {
    const { sessionId, attemptId } = options;
    if (!isSafeRunId(sessionId)) throw new Error("Invalid session id for a conversation lease.");
    const now = options.now ?? Date.now;
    try {
        return withConversationMutation(sessionId, () => {
            const leasePath = leasePathFor(sessionId);
            const payload: LeasePayload = {
                pid: process.pid,
                start: processStartToken(process.pid),
                token: randomBytes(16).toString("hex"),
                sessionId,
                attemptId,
                at: now(),
            };
            if (payload.start === undefined) delete (payload as { start?: string }).start;
            const serialized = JSON.stringify(payload);
            const existing = readLeaseRaw(leasePath);
            let replace = false;
            if (existing !== undefined) {
                if (!leaseReclaimable(leasePath, existing, now(), options.probe, options.explicitRecovery)) {
                    throw conversationBusy(sessionId, attemptId);
                }
                replace = true;
            }
            publishLeaseUnlocked(leasePath, serialized, replace);
            let released = false;
            return {
                sessionId,
                attemptId,
                token: payload.token,
                path: leasePath,
                release() {
                    if (released) return;
                    withConversationMutation(
                        sessionId,
                        () => releaseLeaseUnlocked(leasePath, serialized),
                        { waitMs: RELEASE_LOCK_WAIT_MS },
                    );
                    released = true;
                },
            };
        }, { waitMs: Math.max(0, options.waitMs ?? ADMISSION_LOCK_WAIT_MS) });
    } catch (error) {
        if (error instanceof ConversationBusyError) throw conversationBusy(sessionId, attemptId);
        throw error;
    }
}

/** Test/diagnostic seam: the lease currently published for a conversation. */
export function readConversationLease(sessionId: string): (LeasePayload & { raw: string }) | undefined {
    if (!isSafeRunId(sessionId)) return undefined;
    try {
        const raw = readFileSync(leasePathFor(sessionId), "utf-8");
        const payload = parseLeasePayload(raw);
        return payload ? { ...payload, raw } : undefined;
    } catch {
        return undefined;
    }
}
