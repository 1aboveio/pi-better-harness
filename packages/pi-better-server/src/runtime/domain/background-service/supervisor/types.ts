/**
 * Durable records and public result types for the detached local supervisor.
 *
 * Scope: local processes and local command watches only. The supervisor is the
 * slice-2 runtime from [ADR 0020](../../../../docs/adr/0020-observed-waits-retain-an-owner.md)
 * and [the observed-waits design](../../../../docs/plans/observed-waits-design.md):
 * execution and terminal evidence survive the process that launched them. It
 * does not implement the coordinator store, dependency waits, continuation or
 * any remote adapter, and it never widens permission: callers pass a command
 * that was already admitted and confined.
 *
 * Environment values are never written to a durable record. A record may name
 * that the launch environment is inherited, and only the runner process carries
 * the actual values.
 */

import type { Condition } from "../types.js";

/** Bumped when a record shape changes in a way an older reader must refuse. */
export const SUPERVISOR_RECORD_VERSION = 1;

/** Bumped with the runner's own behaviour, not the record schema. */
export const SUPERVISOR_RUNNER_VERSION = "2";

export const SUPERVISOR_TASK_ID_PREFIX = "bgs_";
export const SUPERVISOR_TASK_ID_PATTERN = /^bgs_[0-9a-f]{20}$/;

/** Mirror of the Background tasks watch defaults, so a supervised watch keeps them. */
export const DEFAULT_WATCH_INTERVAL_MS = 30_000;
export const DEFAULT_WATCH_TIMEOUT_MS = 15 * 60_000;
/** Per-stream log cap; mirrors the Background tasks task-log retention default. */
export const DEFAULT_MAX_LOG_BYTES = 4 * 1024 * 1024;
/** How much of the last check/output is kept in the durable terminal record. */
export const DEFAULT_TERMINAL_TAIL_BYTES = 8 * 1024;
/** How long a launch may exist before an unclaimed launch is reported lost. */
export const DEFAULT_CLAIM_GRACE_MS = 30_000;
/** How long `start` waits for the runner's durable claim before returning. */
export const DEFAULT_CLAIM_WAIT_MS = 2_000;
/** How long `stop` waits for runner-attested evidence before escalating. */
export const DEFAULT_STOP_WAIT_MS = 5_000;
/** Poll cadence for stop requests, in the runner and in the caller's wait loops. */
export const SUPERVISOR_POLL_MS = 50;
/** SIGTERM-to-SIGKILL grace for a timed-out or stopped command group. */
export const SUPERVISOR_TERMINATION_GRACE_MS = 2_000;
/** How long group cleanup may run before it must be reported as unproven. */
export const SUPERVISOR_GROUP_CLEANUP_DEADLINE_MS = 7_000;
/** Cross-process state fence: how long a waiter holds on before erroring (never steals). */
export const SUPERVISOR_FENCE_WAIT_MS = 5_000;
/**
 * `inspect` is an observation path: it waits only briefly for the fence and then
 * reports `fenceBusy` rather than blocking a status loop on a wedged holder.
 */
export const SUPERVISOR_INSPECT_FENCE_WAIT_MS = 250;


export type SupervisorTaskKind = "process" | "watch";

/**
 * `starting` and `running` are observations, not durable record statuses:
 * - `starting`  the launch record exists but no runner has claimed the token yet
 * - `running`   a runner owns the claim and has not recorded a terminal result
 * - `lost`      no terminal evidence exists and none can now appear
 */
export type SupervisorTaskStatus =
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "lost";

export type SupervisorTerminalStatus = Extract<
  SupervisorTaskStatus,
  "succeeded" | "failed" | "timed_out" | "cancelled"
>;

/** Who recorded a terminal result: the owning runner, or the caller's stop escalation. */
export type SupervisorAttestation = "runner" | "supervisor";

/**
 * What happened to the process group when execution ended.
 *
 * - `none`: the command ended on its own; descendants were not cleaned (production
 *   local processes behave the same way).
 * - `empty`: a stop/timeout killed the group and it was proven empty afterwards.
 * - `taskkill`: Windows tree termination via `taskkill /T /F`.
 * - `unproven`: cleanup ran but no evidence proved the group empty.
 */
export type SupervisorGroupCleanup = "none" | "empty" | "taskkill" | "unproven";

/** What an explicit stop did about a surviving command. */
export type SupervisorCleanupOutcome =
  | "none"
  | "already-gone"
  | "killed"
  | "refused-unknown-identity"
  | "unproven";

export interface SupervisorCommandRequest {
  /** Already-admitted executable and arguments; the supervisor executes them verbatim. */
  argv: string[];
  /** Absolute launch directory. */
  cwd: string;
}

/** Immutable launch record: written once by the caller, before any execution. */
export interface SupervisorLaunchRecord {
  version: number;
  taskId: string;
  /** Caller-supplied idempotency token. The task id is derived from it. */
  token: string;
  kind: SupervisorTaskKind;
  name?: string;
  /** Caller intent for retry correlation, never an execution identity. */
  operationId?: string;
  command: SupervisorCommandRequest;
  /** Hash of the normalized request, so a reused token cannot silently mean another command. */
  requestHash: string;
  createdAt: number;
  /** Per-command cap in milliseconds. Each watch check gets the same cap. */
  commandTimeoutMs?: number;
  /** Whole-task deadline: one process, or a watch's lifetime, in milliseconds. */
  taskTimeoutMs?: number;
  /** Watch cadence in milliseconds. */
  intervalMs?: number;
  successWhen?: Condition;
  failureWhen?: Condition;
  maxLogBytes: number;
  /** Records never hold environment values; the runner inherits the launch environment. */
  environment: "inherited";
}

/** Written once, exclusively, by the runner before it executes anything. */
export interface SupervisorClaimRecord {
  version: number;
  taskId: string;
  token: string;
  /** Runner process identity. */
  pid: number;
  pidStartTime?: string;
  claimedAt: number;
}

/** The currently running process or watch check, so `stop` can verify before signalling. */
export interface SupervisorCommandRecord {
  version: number;
  taskId: string;
  token: string;
  runnerPid: number;
  pid: number;
  pgid?: number;
  pidStartTime?: string;
  startedAt: number;
  /** 1 for a process task; incremented for each watch check. */
  attempt: number;
}

export interface SupervisorStopRequest {
  version: number;
  taskId: string;
  token: string;
  requestedAt: number;
  reason?: string;
}

/** Bounded evidence from the command or watch check that ended the task. */
export interface SupervisorCheckEvidence {
  startedAt: number;
  endedAt: number;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut?: boolean;
  stdout: string;
  stderr: string;
  stdoutDiscardedBytes?: number;
  stderrDiscardedBytes?: number;
  matchedCondition?: Condition;
  matchedValue?: unknown;
}

export interface SupervisorTerminalRecord {
  version: number;
  taskId: string;
  token: string;
  kind: SupervisorTaskKind;
  status: SupervisorTerminalStatus;
  attestedBy: SupervisorAttestation;
  reason: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  startedAt: number;
  endedAt: number;
  /** Watch checks completed, when the task was a watch. */
  checks?: number;
  matchedCondition?: Condition;
  matchedValue?: unknown;
  /** Evidence from the command or last check; stdout and stderr stay separate. */
  lastCheck?: SupervisorCheckEvidence;
  /** Last observed output for a streamed process command (bounded tails). */
  lastOutput?: { stdout: string; stderr: string };
  stdoutBytes: number;
  stderrBytes: number;
  stdoutDiscardedBytes: number;
  stderrDiscardedBytes: number;
  logs: { stdout: string; stderr: string; events: string };
  /** Absent only when the stop escalation could not observe a claimed runner. */
  runner?: { pid: number; pidStartTime?: string };
  command?: { pid?: number; pgid?: number; pidStartTime?: string };
  /** Group cleanup evidence for a stop or timeout terminal. */
  groupCleanup?: SupervisorGroupCleanup;
  error?: string;
}

/**
 * Durable record of an explicit stop that had to touch a surviving command
 * outside runner supervision (for example an orphan whose runner is gone).
 * It never replaces the lost or terminal evidence; it only says what the stop
 * did about the process group.
 */
export interface SupervisorCleanupRecord {
  version: number;
  taskId: string;
  token: string;
  at: number;
  outcome: SupervisorCleanupOutcome;
  identity: "verified" | "unknown" | "mismatched" | "dead" | "absent";
  signals: string[];
  groupEmpty?: boolean;
  pid?: number;
  pgid?: number;
  reason: string;
}

/** Attested by the supervisor when no runner could record a terminal result. */
export interface SupervisorLostRecord {
  version: number;
  taskId: string;
  token: string;
  status: "lost";
  reason: string;
  recordedAt: number;
  runner?: { pid: number; pidStartTime?: string };
  command?: { pid: number; pgid?: number; pidStartTime?: string };
}

/** Public, env-free summary of a launch. */
export interface SupervisorLaunchSummary {
  taskId: string;
  token: string;
  kind: SupervisorTaskKind;
  name?: string;
  operationId?: string;
  createdAt: number;
  argv: string[];
  cwd: string;
  commandTimeoutSeconds?: number;
  timeoutSeconds?: number;
  intervalSeconds?: number;
  successWhen?: Condition;
  failureWhen?: Condition;
  requestHash: string;
}

export interface SupervisorInspection {
  taskId: string;
  token: string;
  kind: SupervisorTaskKind;
  status: SupervisorTaskStatus;
  /** True when a durable terminal or lost record exists; no further execution can be witnessed. */
  terminal: boolean;
  launch: SupervisorLaunchSummary;
  claim?: { pid: number; pidStartTime?: string; claimedAt: number; alive: boolean };
  command?: { pid: number; pgid?: number; pidStartTime?: string; startedAt: number; attempt: number; alive: boolean };
  result?: SupervisorTerminalRecord;
  lost?: SupervisorLostRecord;
  /** Last explicit stop cleanup, when one ran. */
  cleanup?: SupervisorCleanupRecord;
  /**
   * Set when a `lost` attestation could not be published because another process
   * holds the state fence. The observation is reported as unreconciled
   * (`running`/`starting`, `terminal: false`); a later inspection publishes.
   */
  fenceBusy?: true;
  stopRequestedAt?: number;
  taskDir: string;
  logs: { stdout: string; stderr: string; events: string };
  observedAt: number;
}

export interface SupervisorStartOptions {
  /** Idempotency token. A second launch with the same token never executes again. */
  token: string;
  /**
   * The executable and arguments to run. The caller must already have applied
   * admission and sandbox confinement; the supervisor neither widens nor
   * re-derives permission.
   */
  argv: readonly string[];
  /** Defaults to the caller's working directory; must exist. */
  cwd?: string;
  kind?: SupervisorTaskKind;
  name?: string;
  operationId?: string;
  /** Per-command cap; a watch applies it to every check. */
  commandTimeoutSeconds?: number;
  /** Whole-task deadline; `0` means none. A watch defaults to 15 minutes. */
  timeoutSeconds?: number;
  /** Watch cadence. Watch only; fractional values are allowed for tight checks. */
  intervalSeconds?: number;
  /** Watch only, required: the condition that ends the watch as succeeded. */
  successWhen?: Condition;
  /** Watch only: the condition that ends the watch as failed. */
  failureWhen?: Condition;
  maxLogBytes?: number;
  /**
   * Extra environment for the runner process only. Values are inherited by the
   * command and are never persisted in the launch record.
   */
  env?: Record<string, string>;
  /** Test seam: override the runner entrypoint. */
  runnerPath?: string;
}

export interface SupervisorStartResult {
  taskId: string;
  token: string;
  /** False when this token was already launched: the existing execution was reported, never re-run. */
  started: boolean;
  /** True once the runner has durably claimed the launch token. */
  claimed: boolean;
  status: SupervisorTaskStatus;
  taskDir: string;
  inspection: SupervisorInspection;
}

export interface SupervisorInspectOptions {
  /** How long an unclaimed launch may live before it is reported lost. */
  claimGraceMs?: number;
  /** Set false to observe without recording a lost result. */
  recordLost?: boolean;
  /** How long to wait for the state fence before reporting `fenceBusy`. */
  fenceWaitMs?: number;
}

export interface SupervisorStopOptions {
  /** Opt-in token check; a mismatch refuses the stop instead of guessing the task. */
  token?: string;
  reason?: string;
  waitMs?: number;
}

export interface SupervisorStopResult {
  taskId: string;
  status: SupervisorTaskStatus;
  terminal: boolean;
  /** True when this call asked the task to stop. */
  stopRequested: boolean;
  /** What the stop did about a surviving command, when it had to act outside the runner. */
  cleanup?: SupervisorCleanupRecord;
  inspection: SupervisorInspection;
}

export interface LocalSupervisorOptions {
  /** Durable record directory. Any writable directory; namespaced by this module. */
  directory: string;
  /** Runner entrypoint override, mainly for tests. */
  runnerPath?: string;
  /** How long `start` waits for the durable claim. */
  claimWaitMs?: number;
  /**
   * Test/portability seam for reading a process start token. Production reads
   * `ps -o lstart=`; a stop refuses to signal when identity cannot be verified.
   */
  readStartToken?: (pid: number) => string | undefined;
}

export interface LocalSupervisor {
  start(options: SupervisorStartOptions): Promise<SupervisorStartResult>;
  inspect(taskId: string, options?: SupervisorInspectOptions): SupervisorInspection | undefined;
  /**
   * Read-only projection of the durable records: no state fence, no lost
   * publication and no process-identity probe.
   *
   * This is the rendering path. `inspect` may take a cross-process SQLite fence
   * and spawn `ps` per task, which must not happen once per task per frame. A
   * snapshot reports what the records already say — `running` for a claim,
   * `starting` before one — and leaves reconciliation to the caller's cadence.
   */
  snapshot(taskId: string): SupervisorInspection | undefined;
  stop(taskId: string, options?: SupervisorStopOptions): Promise<SupervisorStopResult | undefined>;
}
