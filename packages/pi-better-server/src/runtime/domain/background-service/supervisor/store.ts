/**
 * Durable record storage for the detached local supervisor.
 *
 * Layout (all under the caller-configured directory):
 *
 * ```
 * tasks/<taskId>/launch.json    written once by the caller, before execution
 * tasks/<taskId>/claim.json     created exclusively by the runner before it runs anything
 * tasks/<taskId>/command.json   identity of the live command or watch check
 * tasks/<taskId>/stop.json      stop request, readable from any process
 * tasks/<taskId>/result.json    runner-attested (or stop-attested) terminal evidence
 * tasks/<taskId>/lost.json      no terminal evidence exists and none can appear
 * tasks/<taskId>/stdout.log     raw stdout bytes
 * tasks/<taskId>/stderr.log     raw stderr bytes
 * tasks/<taskId>/events.log     runner lifecycle lines plus inherited runner stderr
 * ```
 *
 * Two rules hold everywhere here:
 *
 * 1. **Claims are exclusive.** `claim.json` is opened with `O_EXCL`, so two
 *    runners for one token cannot both execute. Duplicate launches reconcile
 *    against the existing record instead of running again.
 * 2. **Terminal evidence is written once.** `result.json`/`lost.json` are
 *    exclusive too; the first terminal record wins and a later write cannot
 *    rewrite it as success.
 *
 * This module is imported by the runner executable, so it must stay runnable
 * under Node's own TypeScript type stripping: only erasable syntax, and every
 * relative import names the real `.ts` file. `../conditions.ts` qualifies
 * because its only import is type-only.
 */

import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { validateCondition } from "../conditions.ts";
import {
  SUPERVISOR_FENCE_WAIT_MS,
  SUPERVISOR_RECORD_VERSION,
  SUPERVISOR_TASK_ID_PATTERN,
  SUPERVISOR_TASK_ID_PREFIX,
} from "./types.ts";
import type {
  SupervisorClaimRecord,
  SupervisorCleanupRecord,
  SupervisorCommandRecord,
  SupervisorLaunchRecord,
  SupervisorLostRecord,
  SupervisorStopRequest,
  SupervisorTerminalRecord,
} from "./types.ts";

export interface SupervisorPaths {
  dir: string;
  launch: string;
  claim: string;
  command: string;
  stop: string;
  result: string;
  lost: string;
  cleanup: string;
  /** Per-task SQLite database whose write transaction is the state fence. */
  fenceDb: string;
  stdout: string;
  stderr: string;
  events: string;
}

/** The task id is derived from the token, so one token can only ever name one execution. */
export function supervisorTaskIdForToken(token: string): string {
  const digest = createHash("sha256").update(token, "utf8").digest("hex");
  return `${SUPERVISOR_TASK_ID_PREFIX}${digest.slice(0, 20)}`;
}

/** Refuse an id that did not come from {@link supervisorTaskIdForToken}; it is also a path segment. */
export function assertSupervisorTaskId(taskId: string): void {
  if (!SUPERVISOR_TASK_ID_PATTERN.test(taskId)) {
    throw new Error(`Invalid supervisor task id ${JSON.stringify(taskId)}; expected ${SUPERVISOR_TASK_ID_PREFIX}<20 hex>.`);
  }
}

export function resolveSupervisorDirectory(directory: string): string {
  if (typeof directory !== "string" || directory.trim().length === 0) {
    throw new Error("A supervisor directory is required.");
  }
  return resolve(directory);
}

export function supervisorPaths(directory: string, taskId: string): SupervisorPaths {
  assertSupervisorTaskId(taskId);
  const dir = join(resolveSupervisorDirectory(directory), "tasks", taskId);
  return {
    dir,
    launch: join(dir, "launch.json"),
    claim: join(dir, "claim.json"),
    command: join(dir, "command.json"),
    stop: join(dir, "stop.json"),
    result: join(dir, "result.json"),
    lost: join(dir, "lost.json"),
    cleanup: join(dir, "cleanup.json"),
    fenceDb: join(dir, "state.db"),
    stdout: join(dir, "stdout.log"),
    stderr: join(dir, "stderr.log"),
    events: join(dir, "events.log"),
  };
}

export function ensureSupervisorTaskDir(directory: string, taskId: string): SupervisorPaths {
  const paths = supervisorPaths(directory, taskId);
  mkdirSync(paths.dir, { recursive: true });
  return paths;
}

/** Deterministic JSON so a request hash never depends on property order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(",")}}`;
}

export function launchRequestHash(request: {
  kind: string;
  command: { argv: string[]; cwd: string };
  commandTimeoutMs?: number;
  taskTimeoutMs?: number;
  intervalMs?: number;
  successWhen?: unknown;
  failureWhen?: unknown;
  maxLogBytes: number;
}): string {
  return createHash("sha256").update(stableStringify(request), "utf8").digest("hex");
}

export interface RecordRead<T> {
  value?: T;
  missing: boolean;
  error?: string;
}

// --- low-level durable writes -------------------------------------------------

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

/** Best effort: the rename is what makes the file atomic; the directory fsync only adds durability. */
function fsyncDirectoryOf(path: string): void {
  try {
    const fd = openSync(dirname(path), "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch {
    // Some platforms refuse fsync on a directory fd; atomicity is unaffected.
  }
}

function tempPathFor(path: string): string {
  // `basename`, not `split("/")`: a Windows path has no `/`, so the whole path
  // would become the temp file name.
  return join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
}

/** Write a durable temp file; the caller publishes it. */
function writeDurableTemp(path: string, text: string): string {
  ensureParent(path);
  const temp = tempPathFor(path);
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return temp;
}

/** Write a complete file atomically and durably: temp file, fsync, rename. */
export function writeTextAtomic(path: string, text: string): void {
  const temp = writeDurableTemp(path, text);
  try {
    renameSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
  fsyncDirectoryOf(path);
}

/**
 * Publish a file only if it does not exist yet, atomically across processes.
 *
 * `open(path, "wx")` is exclusive but publishes an empty file before its bytes
 * arrive, so a concurrent reader can observe a partial record. A hard link from
 * a fully written temp file is atomic in both directions: the target either
 * holds the complete record or does not exist. False means another writer won.
 *
 * A filesystem without hard links fails closed: there is no fallback that would
 * make an exclusive publication atomic, and a known path to a partial record is
 * worse than a refused write.
 */
export function writeTextExclusive(path: string, text: string): boolean {
  const temp = writeDurableTemp(path, text);
  const cleanupTemp = (): void => { try { unlinkSync(temp); } catch { /* best effort */ } };
  try {
    linkSync(temp, path);
  } catch (error) {
    cleanupTemp();
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    throw new Error(
      `Cannot publish ${path} atomically: the filesystem refused a hard link (${code ?? "unknown"}). `
        + "An exclusive record is never published partially; the write was not applied.",
      { cause: error },
    );
  }
  cleanupTemp();
  fsyncDirectoryOf(path);
  return true;
}

export type FenceBusyReason = "busy" | "unavailable";

/**
 * A transition could not be applied because the state fence was held longer than
 * the bounded wait (`busy`), or because `node:sqlite` is unavailable
 * (`unavailable`). Callers never take a live holder's lock; they report or retry.
 */
export class SupervisorFenceBusyError extends Error {
  readonly taskId: string;
  readonly verdict: FenceBusyReason;

  constructor(taskId: string, verdict: FenceBusyReason, detail: string) {
    super(`The supervisor state fence for ${taskId} was not available (${verdict}); the transition was not applied. ${detail}`);
    this.name = "SupervisorFenceBusyError";
    this.taskId = taskId;
    this.verdict = verdict;
  }
}

interface SqliteDatabase {
  exec(sql: string): void;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

/**
 * `node:sqlite` is built into Node 22.5+, but a static import would make this
 * module unloadable on an older runtime. It is therefore resolved on first use;
 * when it is unavailable the fence fails closed and no transition is applied.
 * Loading it adds no permission: SQLite only opens the database under the
 * supervisor directory this module already owns.
 */
let sqliteModule: SqliteModule | undefined | null;

function loadSqlite(): SqliteModule | undefined {
  if (sqliteModule !== undefined) return sqliteModule ?? undefined;
  try {
    const requireForModule = createRequire(import.meta.url);
    sqliteModule = requireForModule("node:sqlite") as SqliteModule;
  } catch {
    sqliteModule = null;
  }
  return sqliteModule ?? undefined;
}

/** SQLite reports lock contention as SQLITE_BUSY (errcode 5) / "database is locked". */
function isSqliteBusy(error: unknown): boolean {
  const candidate = error as { errcode?: unknown; code?: unknown; message?: unknown };
  if (candidate?.errcode === 5) return true;
  if (candidate?.code === "SQLITE_BUSY") return true;
  return typeof candidate?.message === "string" && /database is locked|SQLITE_BUSY/i.test(candidate.message);
}

function fenceFailure(taskId: string, busyMs: number, error: unknown): unknown {
  if (!isSqliteBusy(error)) return error;
  return new SupervisorFenceBusyError(
    taskId,
    "busy",
    `Another process held the fence for longer than ${busyMs}ms; it is still alive, so nothing was taken over.`,
  );
}

/**
 * Serialize a state transition across processes (claim vs lost publication, and
 * supervisor-attested terminal writes).
 *
 * The fence is a SQLite `BEGIN IMMEDIATE` transaction on a per-task database.
 * That primitive already provides exactly the two guarantees this needs:
 *
 * - **Exclusion** is decided by the database's write lock, so two contenders can
 *   never both be inside the critical section — there is no observation window
 *   between "is it held?" and "take it".
 * - **Dead-owner release** is the operating system releasing the file lock when
 *   the holder's process ends; SQLite rolls the open transaction back. No age,
 *   identity or quarantine heuristic participates, because a live holder is
 *   simply waited for (up to `busy_timeout`) and then reported busy.
 *
 * `fn` is synchronous and runs inside the transaction. Any error rolls back and
 * propagates unchanged, so a transition is applied atomically or not at all.
 */
export function withStateFence<T>(
  directory: string,
  taskId: string,
  fn: () => T,
  options: { waitMs?: number } = {},
): T {
  const paths = supervisorPaths(directory, taskId);
  mkdirSync(paths.dir, { recursive: true });
  const sqlite = loadSqlite();
  if (!sqlite) {
    throw new SupervisorFenceBusyError(
      taskId,
      "unavailable",
      "Node's built-in node:sqlite (Node 22.5+) is unavailable and there is no non-atomic fallback fence.",
    );
  }
  const busyMs = Math.max(1, Math.floor(options.waitMs ?? SUPERVISOR_FENCE_WAIT_MS));
  let db: SqliteDatabase | undefined;
  try {
    db = new sqlite.DatabaseSync(paths.fenceDb);
    db.exec(`PRAGMA busy_timeout = ${busyMs}`);
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw fenceFailure(taskId, busyMs, error);
    }
    let result: T;
    try {
      result = fn();
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* the transaction may already be gone */ }
      throw error;
    }
    try {
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* best effort */ }
      throw fenceFailure(taskId, busyMs, error);
    }
    return result;
  } finally {
    try { db?.close(); } catch { /* the OS releases the lock with the connection */ }
  }
}

export type ClaimOutcome =
  | { status: "claimed"; claim: SupervisorClaimRecord }
  | { status: "already-claimed"; claim: SupervisorClaimRecord }
  | { status: "terminal"; result: SupervisorTerminalRecord }
  | { status: "lost"; lost: SupervisorLostRecord };

/**
 * Claim a launch token only if nothing terminal and nothing lost was published.
 *
 * The fence is what removes the check-then-write race: a lost attestation
 * published first makes this claim fail, and a claim published first makes the
 * reconciler see a live execution instead of recording a loss.
 */
export function claimLaunch(directory: string, taskId: string, claim: SupervisorClaimRecord): ClaimOutcome {
  return withStateFence(directory, taskId, () => {
    const result = readTerminalRecord(directory, taskId).value;
    if (result) return { status: "terminal", result };
    const lost = readLostRecord(directory, taskId).value;
    if (lost) return { status: "lost", lost };
    const existing = readClaimRecord(directory, taskId).value;
    if (existing) return { status: "already-claimed", claim: existing };
    if (!writeClaimRecord(directory, claim)) {
      const racer = readClaimRecord(directory, taskId).value;
      if (racer) return { status: "already-claimed", claim: racer };
      throw new Error(`Could not claim the launch token for ${taskId} under the state fence.`);
    }
    return { status: "claimed", claim };
  });
}

function readText(path: string): RecordRead<string> {
  try {
    return { value: readFileSync(path, "utf8"), missing: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { missing: true };
    return { missing: true, error: error instanceof Error ? error.message : String(error) };
  }
}

function readJsonRecord<T>(path: string, problem: (value: unknown) => string | undefined): RecordRead<T> {
  const read = readText(path);
  if (read.missing) return { missing: true, error: read.error };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.value!);
  } catch (error) {
    return { missing: false, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const invalid = problem(parsed);
  if (invalid) return { missing: false, error: invalid };
  return { value: parsed as T, missing: false };
}

export function appendEvent(eventsPath: string, message: string): void {
  try {
    ensureParent(eventsPath);
    appendFileSync(eventsPath, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // A log we cannot write must never decide the verdict; the terminal record carries it.
  }
}

export function appendStreamBytes(path: string, chunk: Buffer): void {
  if (chunk.length === 0) return;
  try {
    ensureParent(path);
    appendFileSync(path, chunk);
  } catch {
    // Same rule as appendEvent: losing log detail must not fail the task.
  }
}

// --- shape validation ---------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveMs(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function commandProblem(value: unknown): string | undefined {
  if (!isObject(value)) return "command must be an object";
  if (!Array.isArray(value.argv) || value.argv.length === 0) return "command.argv must be a non-empty array";
  for (const [index, entry] of value.argv.entries()) {
    if (!nonEmptyString(entry)) return `command.argv[${index}] must be a non-empty string`;
    if (entry.includes("\0")) return `command.argv[${index}] must not contain a NUL byte`;
  }
  if (!nonEmptyString(value.cwd) || !isAbsolute(value.cwd)) return "command.cwd must be an absolute path";
  return undefined;
}

function conditionProblem(name: string, value: unknown, required: boolean): string | undefined {
  if (value === undefined || value === null) {
    return required ? `${name} is required for a watch` : undefined;
  }
  if (!isObject(value) || !nonEmptyString(value.type)) return `${name} must be a condition object`;
  const invalid = validateCondition(value as Parameters<typeof validateCondition>[0]);
  return invalid === undefined ? undefined : `${name}: ${invalid}`;
}

function launchRecordProblem(taskId: string): (value: unknown) => string | undefined {
  return (value) => {
    if (!isObject(value)) return "launch record must be an object";
    if (value.version !== SUPERVISOR_RECORD_VERSION) {
      return `unsupported launch record version ${JSON.stringify(value.version)}; this build reads version ${SUPERVISOR_RECORD_VERSION}`;
    }
    if (value.taskId !== taskId) return `launch record taskId ${JSON.stringify(value.taskId)} does not match ${JSON.stringify(taskId)}`;
    if (!nonEmptyString(value.token)) return "launch record token is missing";
    if (supervisorTaskIdForToken(value.token) !== taskId) return "launch record token does not derive this task id";
    if (value.kind !== "process" && value.kind !== "watch") return "launch record kind must be \"process\" or \"watch\"";
    const command = commandProblem(value.command);
    if (command) return command;
    if (!nonEmptyString(value.requestHash)) return "launch record requestHash is missing";
    if (!isFiniteNumber(value.createdAt)) return "launch record createdAt is missing";
    if (!isPositiveMs(value.maxLogBytes)) return "launch record maxLogBytes is missing";
    if (value.environment !== "inherited") return "launch record must declare environment: \"inherited\"";
    if (value.commandTimeoutMs !== undefined && !isPositiveMs(value.commandTimeoutMs)) return "launch record commandTimeoutMs must be positive";
    if (value.taskTimeoutMs !== undefined && !isPositiveMs(value.taskTimeoutMs)) return "launch record taskTimeoutMs must be positive";
    if (value.intervalMs !== undefined && !isPositiveMs(value.intervalMs)) return "launch record intervalMs must be positive";
    if (value.kind === "watch") {
      const success = conditionProblem("successWhen", value.successWhen, true);
      if (success) return success;
      const failure = conditionProblem("failureWhen", value.failureWhen, false);
      if (failure) return failure;
    } else if (value.successWhen !== undefined || value.failureWhen !== undefined || value.intervalMs !== undefined) {
      return "a process launch record must not carry watch conditions or a cadence";
    }
    return undefined;
  };
}

export function readLaunchRecord(directory: string, taskId: string): RecordRead<SupervisorLaunchRecord> {
  return readJsonRecord<SupervisorLaunchRecord>(supervisorPaths(directory, taskId).launch, launchRecordProblem(taskId));
}

/** True when this caller wrote the launch record; false when another launch already owns the token. */
export function writeLaunchRecord(directory: string, record: SupervisorLaunchRecord): boolean {
  return writeTextExclusive(supervisorPaths(directory, record.taskId).launch, `${JSON.stringify(record, null, 2)}\n`);
}

// --- claim --------------------------------------------------------------------

function claimRecordProblem(taskId: string): (value: unknown) => string | undefined {
  return (value) => {
    if (!isObject(value)) return "claim record must be an object";
    if (value.version !== SUPERVISOR_RECORD_VERSION) return "unsupported claim record version";
    if (value.taskId !== taskId) return "claim record taskId mismatch";
    if (!nonEmptyString(value.token)) return "claim record token is missing";
    if (!Number.isInteger(value.pid) || (value.pid as number) <= 0) return "claim record runner pid is missing";
    if (!isFiniteNumber(value.claimedAt)) return "claim record claimedAt is missing";
    return undefined;
  };
}

export function readClaimRecord(directory: string, taskId: string): RecordRead<SupervisorClaimRecord> {
  return readJsonRecord<SupervisorClaimRecord>(supervisorPaths(directory, taskId).claim, claimRecordProblem(taskId));
}

/** Durably claim a token before executing. False means another runner already owns it. */
export function writeClaimRecord(directory: string, record: SupervisorClaimRecord): boolean {
  return writeTextExclusive(supervisorPaths(directory, record.taskId).claim, `${JSON.stringify(record, null, 2)}\n`);
}

// --- live command identity ----------------------------------------------------

function commandRecordProblem(taskId: string): (value: unknown) => string | undefined {
  return (value) => {
    if (!isObject(value)) return "command record must be an object";
    if (value.version !== SUPERVISOR_RECORD_VERSION) return "unsupported command record version";
    if (value.taskId !== taskId) return "command record taskId mismatch";
    if (!nonEmptyString(value.token)) return "command record token is missing";
    if (!Number.isInteger(value.pid) || (value.pid as number) <= 0) return "command record pid is missing";
    if (!isFiniteNumber(value.startedAt)) return "command record startedAt is missing";
    return undefined;
  };
}

export function readCommandRecord(directory: string, taskId: string): RecordRead<SupervisorCommandRecord> {
  return readJsonRecord<SupervisorCommandRecord>(supervisorPaths(directory, taskId).command, commandRecordProblem(taskId));
}

/** Overwritten per attempt, so a stop can verify the live command identity. */
export function writeCommandRecord(directory: string, record: SupervisorCommandRecord): void {
  writeTextAtomic(supervisorPaths(directory, record.taskId).command, `${JSON.stringify(record, null, 2)}\n`);
}

// --- stop requests ------------------------------------------------------------

function stopRequestProblem(taskId: string): (value: unknown) => string | undefined {
  return (value) => {
    if (!isObject(value)) return "stop request must be an object";
    if (value.version !== SUPERVISOR_RECORD_VERSION) return "unsupported stop request version";
    if (value.taskId !== taskId) return "stop request taskId mismatch";
    if (!isFiniteNumber(value.requestedAt)) return "stop request requestedAt is missing";
    return undefined;
  };
}

export function readStopRequest(directory: string, taskId: string): SupervisorStopRequest | undefined {
  return readJsonRecord<SupervisorStopRequest>(supervisorPaths(directory, taskId).stop, stopRequestProblem(taskId)).value;
}

/** Keep the earliest request time when a stop is repeated. */
export function writeStopRequest(directory: string, request: SupervisorStopRequest): SupervisorStopRequest {
  const existing = readStopRequest(directory, request.taskId);
  const effective = existing && existing.requestedAt <= request.requestedAt
    ? { ...request, requestedAt: existing.requestedAt, reason: existing.reason ?? request.reason }
    : request;
  writeTextAtomic(supervisorPaths(directory, request.taskId).stop, `${JSON.stringify(effective, null, 2)}\n`);
  return effective;
}

// --- terminal and lost evidence ----------------------------------------------

function terminalRecordProblem(taskId: string): (value: unknown) => string | undefined {
  return (value) => {
    if (!isObject(value)) return "terminal record must be an object";
    if (value.version !== SUPERVISOR_RECORD_VERSION) return "unsupported terminal record version";
    if (value.taskId !== taskId) return "terminal record taskId mismatch";
    const status = value.status;
    if (status !== "succeeded" && status !== "failed" && status !== "timed_out" && status !== "cancelled") {
      return "terminal record status is not terminal";
    }
    if (value.attestedBy !== "runner" && value.attestedBy !== "supervisor") return "terminal record attestedBy is invalid";
    if (!nonEmptyString(value.reason)) return "terminal record reason is missing";
    if (!isFiniteNumber(value.startedAt) || !isFiniteNumber(value.endedAt)) return "terminal record timestamps are missing";
    return undefined;
  };
}

export function readTerminalRecord(directory: string, taskId: string): RecordRead<SupervisorTerminalRecord> {
  return readJsonRecord<SupervisorTerminalRecord>(supervisorPaths(directory, taskId).result, terminalRecordProblem(taskId));
}

/** First terminal writer wins; a later write can never turn evidence into a different outcome. */
export function writeTerminalRecord(directory: string, record: SupervisorTerminalRecord): boolean {
  return writeTextExclusive(supervisorPaths(directory, record.taskId).result, `${JSON.stringify(record, null, 2)}\n`);
}

function lostRecordProblem(taskId: string): (value: unknown) => string | undefined {
  return (value) => {
    if (!isObject(value)) return "lost record must be an object";
    if (value.version !== SUPERVISOR_RECORD_VERSION) return "unsupported lost record version";
    if (value.taskId !== taskId) return "lost record taskId mismatch";
    if (value.status !== "lost") return "lost record status must be lost";
    if (!nonEmptyString(value.reason)) return "lost record reason is missing";
    return undefined;
  };
}

export function readLostRecord(directory: string, taskId: string): RecordRead<SupervisorLostRecord> {
  return readJsonRecord<SupervisorLostRecord>(supervisorPaths(directory, taskId).lost, lostRecordProblem(taskId));
}

export function writeLostRecord(directory: string, record: SupervisorLostRecord): boolean {
  return writeTextExclusive(supervisorPaths(directory, record.taskId).lost, `${JSON.stringify(record, null, 2)}\n`);
}

function cleanupRecordProblem(taskId: string): (value: unknown) => string | undefined {
  return (value) => {
    if (!isObject(value)) return "cleanup record must be an object";
    if (value.version !== SUPERVISOR_RECORD_VERSION) return "unsupported cleanup record version";
    if (value.taskId !== taskId) return "cleanup record taskId mismatch";
    if (!isFiniteNumber(value.at)) return "cleanup record timestamp is missing";
    if (typeof value.outcome !== "string") return "cleanup record outcome is missing";
    return undefined;
  };
}

export function readCleanupRecord(directory: string, taskId: string): SupervisorCleanupRecord | undefined {
  return readJsonRecord<SupervisorCleanupRecord>(supervisorPaths(directory, taskId).cleanup, cleanupRecordProblem(taskId)).value;
}

/** Latest explicit-stop cleanup wins; this is evidence about an action, not a verdict. */
export function writeCleanupRecord(directory: string, record: SupervisorCleanupRecord): void {
  writeTextAtomic(supervisorPaths(directory, record.taskId).cleanup, `${JSON.stringify(record, null, 2)}\n`);
}
