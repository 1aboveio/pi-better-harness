/**
 * Caller-side API for detached local supervision: `start`, `inspect`, `stop`.
 *
 * What this module owns:
 * - the immutable launch record, written before any execution and never edited;
 * - a task id derived from the caller's token, so one token names one execution;
 * - spawning the runner as an independent process group;
 * - reconciliation from durable evidence (claim, result, lost) instead of from
 *   the caller's memory.
 *
 * What it deliberately does not own: admission and sandbox confinement. The
 * caller passes an already-admitted executable argv; this module executes it
 * verbatim and never widens permission or bypasses a sandbox wrapper. No
 * environment values are persisted — the runner inherits the launch environment.
 *
 * Every ambiguity resolves towards *not executing again*: a launch with a
 * missing claim is reported and reconciled, never retried, and a runner that
 * disappeared without terminal evidence is `lost`, not successful.
 */

import { spawn } from "node:child_process";
import { closeSync, openSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { validateCondition } from "../conditions.ts";
import { stopProcessGroup } from "../process.ts";
import { identityAlive, identityAllowsSignals, processGroupAlive, readStartToken, verifyProcessIdentity } from "./identity.ts";
import type { ProcessIdentityVerdict } from "./identity.ts";
import { supervisorRunnerInvocation } from "./invocation.ts";
import {
  appendEvent,
  ensureSupervisorTaskDir,
  launchRequestHash,
  readClaimRecord,
  readCleanupRecord,
  readCommandRecord,
  readLaunchRecord,
  readLostRecord,
  readStopRequest,
  readTerminalRecord,
  resolveSupervisorDirectory,
  supervisorPaths,
  supervisorTaskIdForToken,
  SupervisorFenceBusyError,
  withStateFence,
  writeCleanupRecord,
  writeLaunchRecord,
  writeLostRecord,
  writeStopRequest,
  writeTerminalRecord,
} from "./store.ts";
import {
  DEFAULT_CLAIM_GRACE_MS,
  DEFAULT_CLAIM_WAIT_MS,
  DEFAULT_MAX_LOG_BYTES,
  DEFAULT_STOP_WAIT_MS,
  DEFAULT_WATCH_INTERVAL_MS,
  DEFAULT_WATCH_TIMEOUT_MS,
  SUPERVISOR_GROUP_CLEANUP_DEADLINE_MS,
  SUPERVISOR_INSPECT_FENCE_WAIT_MS,
  SUPERVISOR_POLL_MS,
  SUPERVISOR_RECORD_VERSION,
  SUPERVISOR_TERMINATION_GRACE_MS,
} from "./types.ts";
import type {
  LocalSupervisor,
  LocalSupervisorOptions,
  SupervisorClaimRecord,
  SupervisorCleanupRecord,
  SupervisorInspectOptions,
  SupervisorInspection,
  SupervisorLaunchRecord,
  SupervisorLaunchSummary,
  SupervisorLostRecord,
  SupervisorStartOptions,
  SupervisorStartResult,
  SupervisorStopOptions,
  SupervisorStopResult,
  SupervisorTaskStatus,
  SupervisorTerminalRecord,
} from "./types.ts";

export type * from "./types.ts";

/** Default durable directory: beside this package's runtime task registry, not inside a log sweep. */
export function defaultSupervisorDirectory(): string {
  const pool = process.env.VITEST_POOL_ID;
  const root = pool && /^\d+$/.test(pool)
    ? `pi-better-background-tasks-vitest-${pool}`
    : "pi-better-background-tasks";
  return join(tmpdir(), root, "supervisor");
}

function tokenProblem(token: unknown): string | undefined {
  if (typeof token !== "string" || token.length === 0) return "token must be a non-empty string";
  if (token.length > 512) return "token must be at most 512 characters";
  if (/[\0\r\n]/.test(token)) return "token must not contain NUL or line breaks";
  return undefined;
}

function optionalText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const text = value.trim();
  if (text.length === 0) return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

/** Seconds to milliseconds; `0` disables an optional whole-task deadline, as in Background tasks. */
function secondsToMs(value: unknown, name: string, options: { allowZero: boolean }): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number of seconds`);
  }
  if (value === 0) {
    if (options.allowZero) return undefined;
    throw new Error(`${name} must be greater than 0`);
  }
  return Math.max(1, Math.round(value * 1000));
}

function validatedArgv(argv: unknown): string[] {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error("argv must be a non-empty array");
  return argv.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) throw new Error(`argv[${index}] must be a non-empty string`);
    if (entry.includes("\0")) throw new Error(`argv[${index}] must not contain a NUL byte`);
    return entry;
  });
}

function validatedCwd(cwd: unknown): string {
  const resolved = resolve(typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd());
  let isDirectory = false;
  try {
    isDirectory = statSync(resolved).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) throw new Error(`cwd does not exist or is not a directory: ${resolved}`);
  return resolved;
}

/**
 * Build and validate the immutable launch record. Everything is checked before
 * any record, directory or process exists, so a refused launch leaves nothing
 * behind — the same rule the Background tasks launcher follows.
 */
function buildLaunchRecord(directory: string, options: SupervisorStartOptions): SupervisorLaunchRecord {
  const tokenProblemText = tokenProblem(options.token);
  if (tokenProblemText) throw new Error(tokenProblemText);
  const argv = validatedArgv(options.argv);
  const cwd = validatedCwd(options.cwd);
  const kind = options.kind ?? "process";
  if (kind !== "process" && kind !== "watch") throw new Error(`kind must be "process" or "watch", not ${JSON.stringify(kind)}`);

  const commandTimeoutMs = secondsToMs(options.commandTimeoutSeconds, "commandTimeoutSeconds", { allowZero: false });
  // A watch keeps the Background tasks default lifetime unless the caller says
  // otherwise; `0` explicitly disables that deadline instead of silently restoring it.
  const taskTimeoutMs = kind === "watch"
    ? (options.timeoutSeconds === undefined
      ? DEFAULT_WATCH_TIMEOUT_MS
      : secondsToMs(options.timeoutSeconds, "timeoutSeconds", { allowZero: true }))
    : secondsToMs(options.timeoutSeconds, "timeoutSeconds", { allowZero: true });
  const intervalMs = kind === "watch"
    ? (secondsToMs(options.intervalSeconds, "intervalSeconds", { allowZero: false }) ?? DEFAULT_WATCH_INTERVAL_MS)
    : undefined;
  if (kind === "process" && options.intervalSeconds !== undefined) {
    throw new Error("intervalSeconds is a watch cadence; a process launch has no poll loop");
  }
  if (kind === "process" && (options.successWhen !== undefined || options.failureWhen !== undefined)) {
    throw new Error("successWhen/failureWhen belong to a watch; a process launch reports its own exit code");
  }
  if (kind === "watch" && options.successWhen === undefined) {
    throw new Error("A watch launch requires successWhen: the condition that ends it as succeeded");
  }
  for (const [name, condition] of [["successWhen", options.successWhen], ["failureWhen", options.failureWhen]] as const) {
    if (condition === undefined) continue;
    const invalid = validateCondition(condition);
    if (invalid) throw new Error(`${name}: ${invalid}`);
  }

  const maxLogBytes = options.maxLogBytes === undefined
    ? DEFAULT_MAX_LOG_BYTES
    : options.maxLogBytes;
  if (typeof maxLogBytes !== "number" || !Number.isInteger(maxLogBytes) || maxLogBytes <= 0) {
    throw new Error("maxLogBytes must be a positive integer");
  }

  const request = {
    kind,
    command: { argv, cwd },
    ...(commandTimeoutMs === undefined ? {} : { commandTimeoutMs }),
    ...(taskTimeoutMs === undefined ? {} : { taskTimeoutMs }),
    ...(intervalMs === undefined ? {} : { intervalMs }),
    ...(options.successWhen === undefined ? {} : { successWhen: options.successWhen }),
    ...(options.failureWhen === undefined ? {} : { failureWhen: options.failureWhen }),
    maxLogBytes,
  };
  const taskId = supervisorTaskIdForToken(options.token);
  const name = optionalText(options.name, "name", 200);
  const operationId = optionalText(options.operationId, "operationId", 200);
  const record: SupervisorLaunchRecord = {
    version: SUPERVISOR_RECORD_VERSION,
    taskId,
    token: options.token,
    kind,
    command: { argv, cwd },
    requestHash: launchRequestHash(request),
    createdAt: Date.now(),
    ...(commandTimeoutMs === undefined ? {} : { commandTimeoutMs }),
    ...(taskTimeoutMs === undefined ? {} : { taskTimeoutMs }),
    ...(intervalMs === undefined ? {} : { intervalMs }),
    ...(options.successWhen === undefined ? {} : { successWhen: options.successWhen }),
    ...(options.failureWhen === undefined ? {} : { failureWhen: options.failureWhen }),
    maxLogBytes,
    environment: "inherited",
    ...(name === undefined ? {} : { name }),
    ...(operationId === undefined ? {} : { operationId }),
  };
  return record;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function launchSummary(record: SupervisorLaunchRecord): SupervisorLaunchSummary {
  return {
    taskId: record.taskId,
    token: record.token,
    kind: record.kind,
    ...(record.name === undefined ? {} : { name: record.name }),
    ...(record.operationId === undefined ? {} : { operationId: record.operationId }),
    createdAt: record.createdAt,
    argv: record.command.argv,
    cwd: record.command.cwd,
    ...(record.commandTimeoutMs === undefined ? {} : { commandTimeoutSeconds: record.commandTimeoutMs / 1000 }),
    ...(record.taskTimeoutMs === undefined ? {} : { timeoutSeconds: record.taskTimeoutMs / 1000 }),
    ...(record.intervalMs === undefined ? {} : { intervalSeconds: record.intervalMs / 1000 }),
    ...(record.successWhen === undefined ? {} : { successWhen: record.successWhen }),
    ...(record.failureWhen === undefined ? {} : { failureWhen: record.failureWhen }),
    requestHash: record.requestHash,
  };
}

class Supervisor implements LocalSupervisor {
  private readonly directory: string;
  private readonly runnerPath?: string;
  private readonly claimWaitMs: number;
  private readonly readToken: (pid: number) => string | undefined;

  constructor(options: LocalSupervisorOptions) {
    this.directory = resolveSupervisorDirectory(options.directory);
    this.runnerPath = options.runnerPath;
    this.claimWaitMs = options.claimWaitMs ?? DEFAULT_CLAIM_WAIT_MS;
    this.readToken = options.readStartToken ?? readStartToken;
  }

  async start(options: SupervisorStartOptions): Promise<SupervisorStartResult> {
    const launch = buildLaunchRecord(this.directory, options);
    const existing = readLaunchRecord(this.directory, launch.taskId);
    if (!existing.missing) {
      if (!existing.value) {
        throw new Error(`The supervisor launch record for ${launch.taskId} is unreadable (${existing.error}); refusing to launch again.`);
      }
      return this.reconcileDuplicate(existing.value, launch);
    }
    if (!writeLaunchRecord(this.directory, launch)) {
      // A concurrent start with the same token won the exclusive create.
      const winner = readLaunchRecord(this.directory, launch.taskId);
      if (!winner.value) {
        throw new Error(`A concurrent launch claimed ${launch.taskId} but its record is unreadable (${winner.error}).`);
      }
      return this.reconcileDuplicate(winner.value, launch);
    }
    return this.spawnRunner(launch, options);
  }

  /**
   * A token can only ever name one request. The same request reports the
   * existing execution; a different request is refused, because executing it
   * would be a second, hidden command under one token.
   */
  private reconcileDuplicate(existing: SupervisorLaunchRecord, requested: SupervisorLaunchRecord): SupervisorStartResult {
    if (existing.requestHash !== requested.requestHash) {
      throw new Error(
        `Launch token ${JSON.stringify(requested.token)} was already used for a different request (task ${existing.taskId}); `
          + "refusing to execute a second command under one token. Use a new token.",
      );
    }
    const inspection = this.inspect(existing.taskId)!;
    return {
      taskId: existing.taskId,
      token: existing.token,
      started: false,
      claimed: inspection.claim !== undefined,
      status: inspection.status,
      taskDir: inspection.taskDir,
      inspection,
    };
  }

  private async spawnRunner(launch: SupervisorLaunchRecord, options: SupervisorStartOptions): Promise<SupervisorStartResult> {
    const invocation = supervisorRunnerInvocation(this.directory, launch.taskId, {
      runnerPath: options.runnerPath ?? this.runnerPath,
    });
    const paths = ensureSupervisorTaskDir(this.directory, launch.taskId);
    // The runner's own stdout/stderr land in events.log: a crash before the claim
    // must leave a diagnosable trace, and the runner has no terminal record yet.
    const eventsFd = openSync(paths.events, "a", 0o600);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(invocation.execPath, invocation.args, {
        cwd: launch.command.cwd,
        // Launch environment only: values are inherited, never written to a record.
        env: { ...process.env, ...(options.env ?? {}) },
        detached: true,
        stdio: ["ignore", eventsFd, eventsFd],
        windowsHide: process.platform === "win32",
      });
    } finally {
      closeSync(eventsFd);
    }
    child.unref();
    let spawnError: Error | undefined;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    child.on("error", (error) => { spawnError = error; });
    child.on("exit", (code, signal) => { exit = { code, signal }; });

    const until = Date.now() + this.claimWaitMs;
    while (Date.now() < until) {
      if (readClaimRecord(this.directory, launch.taskId).value) break;
      if (spawnError || exit) break;
      await delay(SUPERVISOR_POLL_MS);
    }
    if (spawnError) {
      throw new Error(
        `The supervisor runner could not start for ${launch.taskId}: ${spawnError.message}. `
          + `The launch record is kept and the token will not execute again. Evidence: ${paths.events}`,
      );
    }
    const inspection = this.inspect(launch.taskId);
    if (!inspection) {
      throw new Error(`The supervisor launch record for ${launch.taskId} disappeared after it was written.`);
    }
    const claimed = inspection.claim !== undefined;
    if (!claimed && exit && !inspection.terminal && exit.code !== 0) {
      throw new Error(
        `The supervisor runner for ${launch.taskId} exited with code ${exit.code ?? "unknown"} before claiming the launch token; `
          + `no command was executed. The launch record is kept and the token will not execute again. Evidence: ${paths.events}`,
      );
    }
    return {
      taskId: launch.taskId,
      token: launch.token,
      started: true,
      claimed,
      status: inspection.status,
      taskDir: inspection.taskDir,
      inspection,
    };
  }

  inspect(taskId: string, options: SupervisorInspectOptions = {}): SupervisorInspection | undefined {
    const launchRead = readLaunchRecord(this.directory, taskId);
    if (launchRead.missing) return undefined;
    if (!launchRead.value) {
      throw new Error(`Unreadable supervisor launch record for ${taskId}: ${launchRead.error}`);
    }
    const launch = launchRead.value;
    const paths = supervisorPaths(this.directory, taskId);
    const result = readTerminalRecord(this.directory, taskId).value;
    const lostRecord = readLostRecord(this.directory, taskId).value;
    const claim = readClaimRecord(this.directory, taskId).value;
    const command = readCommandRecord(this.directory, taskId).value;
    const stop = readStopRequest(this.directory, taskId);
    const cleanup = readCleanupRecord(this.directory, taskId);
    // One identity source per instance: liveness and signalling agree.
    const claimAlive = claim ? identityAlive(claim.pid, claim.pidStartTime, claim.claimedAt, this.readToken) : false;
    const commandAlive = command ? identityAlive(command.pid, command.pidStartTime, command.startedAt, this.readToken) : false;

    // A published terminal/lost record needs no fence. Anything else is decided
    // under the fence, so a `lost` attestation and a claim cannot both win.
    let state: { status: SupervisorTaskStatus; terminal: boolean; result?: SupervisorTerminalRecord; lost?: SupervisorLostRecord; fenceBusy?: true };
    if (result) {
      state = { status: result.status as SupervisorTaskStatus, terminal: true, result };
    } else if (lostRecord) {
      state = { status: "lost", terminal: true, lost: lostRecord };
    } else {
      state = this.reconcile(launch, options);
    }
    // The reconciliation may observe the terminal record the outer read missed.
    const terminalRecord = result ?? state.result;

    return {
      taskId,
      token: launch.token,
      kind: launch.kind,
      status: state.status,
      terminal: state.terminal,
      launch: launchSummary(launch),
      ...(claim === undefined
        ? {}
        : { claim: { pid: claim.pid, pidStartTime: claim.pidStartTime, claimedAt: claim.claimedAt, alive: claimAlive } }),
      ...(command === undefined
        ? {}
        : {
          command: {
            pid: command.pid,
            pgid: command.pgid,
            pidStartTime: command.pidStartTime,
            startedAt: command.startedAt,
            attempt: command.attempt ?? 1,
            alive: commandAlive,
          },
        }),
      ...(terminalRecord === undefined ? {} : { result: terminalRecord }),
      ...(state.lost === undefined ? {} : { lost: state.lost }),
      ...(cleanup === undefined ? {} : { cleanup }),
      ...(state.fenceBusy === true ? { fenceBusy: true as const } : {}),
      ...(stop === undefined ? {} : { stopRequestedAt: stop.requestedAt }),
      taskDir: paths.dir,
      logs: { stdout: paths.stdout, stderr: paths.stderr, events: paths.events },
      observedAt: Date.now(),
    };
  }

  /**
   * Decide the state of a launch with no terminal result, under the cross-process
   * fence. This is the only place a `lost` record is published, so it can never
   * race a claim into "lost and executed".
   */
  private reconcile(
    launch: SupervisorLaunchRecord,
    options: SupervisorInspectOptions,
  ): { status: SupervisorTaskStatus; terminal: boolean; result?: SupervisorTerminalRecord; lost?: SupervisorLostRecord; fenceBusy?: true } {
    let transition: { status: SupervisorTaskStatus; terminal: boolean; result?: SupervisorTerminalRecord; lost?: SupervisorLostRecord };
    try {
      transition = this.applyReconciliation(launch, options);
    } catch (error) {
      if (!(error instanceof SupervisorFenceBusyError)) throw error;
      // Never steal a fence to publish a loss. Report the unreconciled state so a
      // later inspection (after the holder releases) can record it.
      const claim = readClaimRecord(this.directory, launch.taskId).value;
      return { status: claim === undefined ? "starting" : "running", terminal: false, fenceBusy: true };
    }
    return transition;
  }

  private applyReconciliation(
    launch: SupervisorLaunchRecord,
    options: SupervisorInspectOptions,
  ): { status: SupervisorTaskStatus; terminal: boolean; result?: SupervisorTerminalRecord; lost?: SupervisorLostRecord } {
    return withStateFence(this.directory, launch.taskId, () => {
      const result = readTerminalRecord(this.directory, launch.taskId).value;
      if (result) return { status: result.status as SupervisorTaskStatus, terminal: true, result };

      const existingLost = readLostRecord(this.directory, launch.taskId).value;
      if (existingLost) return { status: "lost" as const, terminal: true, lost: existingLost };

      const claim = readClaimRecord(this.directory, launch.taskId).value;
      if (claim) {
        if (identityAlive(claim.pid, claim.pidStartTime, claim.claimedAt, this.readToken)) {
          return { status: "running" as const, terminal: false };
        }
        return { status: "lost" as const, terminal: true, lost: this.publishLost(launch, claim, options) };
      }

      const graceMs = options.claimGraceMs ?? DEFAULT_CLAIM_GRACE_MS;
      if (Date.now() - launch.createdAt < graceMs) {
        // A runner may still be starting. Never launch again on this token.
        return { status: "starting" as const, terminal: false };
      }
      return { status: "lost" as const, terminal: true, lost: this.publishLost(launch, undefined, options) };
    }, { waitMs: options.fenceWaitMs ?? SUPERVISOR_INSPECT_FENCE_WAIT_MS });
  }

  /** Caller of {@link reconcile}'s fence; records why the evidence is gone. */
  private publishLost(
    launch: SupervisorLaunchRecord,
    claim: SupervisorClaimRecord | undefined,
    options: SupervisorInspectOptions,
  ): SupervisorLostRecord {
    const reason = claim === undefined
      ? `no runner claimed the launch token within ${options.claimGraceMs ?? DEFAULT_CLAIM_GRACE_MS}ms of the launch; `
        + "no command execution was witnessed and the launch will not be retried"
      : `the runner (pid ${claim.pid}) exited without recording a terminal result`;
    const record: SupervisorLostRecord = {
      version: SUPERVISOR_RECORD_VERSION,
      taskId: launch.taskId,
      token: launch.token,
      status: "lost",
      reason,
      recordedAt: Date.now(),
      ...(claim === undefined ? {} : { runner: { pid: claim.pid, pidStartTime: claim.pidStartTime } }),
    };
    if (options.recordLost === false) return record;
    writeLostRecord(this.directory, record);
    // Another observer may have recorded the same loss first; return the durable one.
    return readLostRecord(this.directory, launch.taskId).value ?? record;
  }

  private async inspectionAfter(taskId: string, waitMs: number): Promise<SupervisorInspection> {
    const until = Date.now() + waitMs;
    let inspection = this.inspect(taskId)!;
    while (!inspection.terminal && Date.now() < until) {
      await delay(SUPERVISOR_POLL_MS);
      inspection = this.inspect(taskId)!;
    }
    return inspection;
  }

  /**
   * Stop a supervised task.
   *
   * The durable stop request is what reaches the runner; nothing is signalled
   * from here on a guess. When the task already ended `lost`, a surviving
   * command is cleaned only if its identity is provable, and the lost evidence
   * is never replaced. Unknown identity is refused rather than signalled.
   */
  async stop(taskId: string, options: SupervisorStopOptions = {}): Promise<SupervisorStopResult | undefined> {
    const launchRead = readLaunchRecord(this.directory, taskId);
    if (launchRead.missing) return undefined;
    if (!launchRead.value) {
      throw new Error(`Unreadable supervisor launch record for ${taskId}: ${launchRead.error}`);
    }
    const launch = launchRead.value;
    if (options.token !== undefined && options.token !== launch.token) {
      throw new Error(`Refusing to stop ${taskId}: the supplied token does not match the launch token.`);
    }

    let inspection = this.inspect(taskId)!;
    if (inspection.terminal) {
      // A terminal record whose group cleanup was not proven may still have a
      // live command. An explicit stop may clean it with a verified identity, and
      // the recorded verdict (lost, cancelled, timed_out) is never rewritten.
      const leftoverGroup = inspection.command?.alive === true
        && (inspection.status === "lost" || inspection.result?.groupCleanup === "unproven");
      if (leftoverGroup) {
        const cleanup = await this.cleanupSurvivingCommand(launch, inspection, options);
        inspection = this.inspect(taskId)!;
        return { taskId, status: inspection.status, terminal: true, stopRequested: false, cleanup, inspection };
      }
      return { taskId, status: inspection.status, terminal: true, stopRequested: false, inspection };
    }

    // A durable request works across processes and survives the caller exiting.
    writeStopRequest(this.directory, {
      version: SUPERVISOR_RECORD_VERSION,
      taskId,
      token: launch.token,
      requestedAt: Date.now(),
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    });
    inspection = await this.inspectionAfter(taskId, options.waitMs ?? DEFAULT_STOP_WAIT_MS);

    if (!inspection.terminal && inspection.command?.alive) {
      // The runner normally acts on the request itself. Only a provable identity
      // may be signalled from here.
      const cleanup = await this.cleanupSurvivingCommand(launch, inspection, options);
      inspection = await this.inspectionAfter(taskId, SUPERVISOR_TERMINATION_GRACE_MS);
      if (!inspection.terminal && (cleanup.outcome === "killed" || cleanup.groupEmpty === true)) {
        inspection = this.publishSupervisorCancellation(launch, inspection, cleanup, options.reason);
      }
      if (inspection.terminal) {
        return { taskId, status: inspection.status, terminal: true, stopRequested: true, cleanup, inspection };
      }
      return { taskId, status: inspection.status, terminal: false, stopRequested: true, cleanup, inspection };
    }

    if (inspection.terminal) {
      return { taskId, status: inspection.status, terminal: true, stopRequested: true, inspection };
    }

    if (inspection.claim === undefined && inspection.command === undefined) {
      // Nothing was witnessed running: cancellation is provable without a signal.
      inspection = this.publishSupervisorCancellation(launch, inspection, undefined, options.reason);
      return { taskId, status: inspection.status, terminal: inspection.terminal, stopRequested: true, inspection };
    }

    // A claimed runner has not spawned yet. The stop request is durable and the
    // runner checks it before executing; report the observation instead of
    // inventing a terminal state.
    return { taskId, status: inspection.status, terminal: false, stopRequested: true, inspection };
  }

  /**
   * Kill a surviving command group from outside the runner, only with a provable
   * identity, and record what happened in `cleanup.json`.
   *
   * The lost/terminal evidence is untouched: this is a cleanup fact, not a new
   * verdict, and it can never turn a `lost` task into a success.
   */
  private async cleanupSurvivingCommand(
    launch: SupervisorLaunchRecord,
    inspection: SupervisorInspection,
    options: SupervisorStopOptions,
  ): Promise<SupervisorCleanupRecord> {
    const command = inspection.command!;
    const pgid = command.pgid ?? command.pid;
    const verdict: ProcessIdentityVerdict = verifyProcessIdentity(command.pid, command.pidStartTime, this.readToken);
    const signals: string[] = [];
    let groupEmpty: boolean | undefined;
    let outcome: SupervisorCleanupRecord["outcome"];

    if (!identityAllowsSignals(verdict)) {
      // Unknown identity cannot authorize an external signal. A recorded process
      // that is gone is only "already gone" when its group is gone too; survivors
      // in a group whose leader died cannot be verified, so they are refused.
      const groupStillAlive = processGroupAlive(pgid);
      outcome = (verdict === "dead" || verdict === "absent") && !groupStillAlive ? "already-gone" : "refused-unknown-identity";
      groupEmpty = outcome === "already-gone" ? true : false;
    } else {
      /**
       * Every group signal re-verifies the leader first. Once the leader is gone
       * the pgid is only addressable evidence that *a* group exists, so an
       * external escalation is refused and the cleanup is reported unproven.
       */
      let signalledWhileVerified = false;
      const signalGroup = (signal: NodeJS.Signals): boolean => {
        const current = verifyProcessIdentity(command.pid, command.pidStartTime, this.readToken);
        if (!identityAllowsSignals(current)) return false;
        try {
          stopProcessGroup(command.pid, pgid, signal);
          signals.push(signal);
          signalledWhileVerified = true;
          return true;
        } catch {
          return false;
        }
      };
      signalGroup("SIGTERM");
      const termDeadline = Date.now() + SUPERVISOR_TERMINATION_GRACE_MS;
      while (Date.now() < termDeadline && processGroupAlive(pgid)) {
        await delay(25);
      }
      if (processGroupAlive(pgid)) signalGroup("SIGKILL");
      const killDeadline = Date.now() + SUPERVISOR_GROUP_CLEANUP_DEADLINE_MS;
      while (Date.now() < killDeadline && processGroupAlive(pgid)) {
        await delay(25);
      }
      groupEmpty = !processGroupAlive(pgid);
      outcome = !groupEmpty ? "unproven" : signalledWhileVerified ? "killed" : "already-gone";
    }

    const reason = outcome === "killed"
      ? `stopped the surviving command group ${pgid}`
      : outcome === "already-gone"
        ? "the recorded command and its process group are already gone"
        : outcome === "refused-unknown-identity"
          ? `refused to signal process group ${pgid}: its recorded leader cannot be verified, so its members cannot be proven to be this task's`
          : "cleanup did not prove the process group empty";
    const record: SupervisorCleanupRecord = {
      version: SUPERVISOR_RECORD_VERSION,
      taskId: launch.taskId,
      token: launch.token,
      at: Date.now(),
      outcome,
      identity: verdict,
      signals,
      ...(groupEmpty === undefined ? {} : { groupEmpty }),
      pid: command.pid,
      pgid,
      reason: options.reason ? `${reason} (${options.reason})` : reason,
    };
    writeCleanupRecord(this.directory, record);
    appendEvent(inspection.logs.events, `cleanup outcome=${outcome} identity=${verdict} signals=[${signals.join(",")}] group_empty=${groupEmpty ?? "unknown"}`);
    return record;
  }

  /**
   * Publish a cancellation only when nothing is left running: no claim and no
   * command (nothing executed), or a group that a verified cleanup proved empty.
   * A supervisor attestation is never used to replace a lost record.
   */
  private publishSupervisorCancellation(
    launch: SupervisorLaunchRecord,
    inspection: SupervisorInspection,
    cleanup: SupervisorCleanupRecord | undefined,
    reasonOverride?: string,
  ): SupervisorInspection {
    const reason = reasonOverride ?? (inspection.claim === undefined && inspection.command === undefined
      ? "stop requested before a runner claimed the launch token; no command was executed"
      : "stopped by the supervisor after proving the command group empty");
    const published = withStateFence(this.directory, launch.taskId, () => {
      if (readTerminalRecord(this.directory, launch.taskId).value) return false;
      if (readLostRecord(this.directory, launch.taskId).value) return false;
      const record: SupervisorTerminalRecord = {
        version: SUPERVISOR_RECORD_VERSION,
        taskId: launch.taskId,
        token: launch.token,
        kind: launch.kind,
        status: "cancelled",
        attestedBy: "supervisor",
        reason,
        exitCode: null,
        signal: null,
        timedOut: false,
        startedAt: launch.createdAt,
        endedAt: Date.now(),
        ...(cleanup === undefined ? {} : { groupCleanup: cleanup.groupEmpty === true ? "empty" : "unproven" }),
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutDiscardedBytes: 0,
        stderrDiscardedBytes: 0,
        logs: inspection.logs,
        ...(inspection.claim === undefined
          ? {}
          : { runner: { pid: inspection.claim.pid, pidStartTime: inspection.claim.pidStartTime } }),
        ...(inspection.command === undefined
          ? {}
          : { command: { pid: inspection.command.pid, pgid: inspection.command.pgid, pidStartTime: inspection.command.pidStartTime } }),
      };
      // The event line precedes the authoritative record for the same reason the
      // runner writes it first: a visible terminal record implies a visible trace.
      appendEvent(inspection.logs.events, `terminal status=cancelled attested_by=supervisor reason=${oneLine(reason)}`);
      return writeTerminalRecord(this.directory, record);
    });
    if (published) return this.inspect(launch.taskId)!;
    // Lost or a runner result won the race: report the durable evidence as-is.
    return this.inspect(launch.taskId)!;
  }
}

export function createLocalSupervisor(options: LocalSupervisorOptions): LocalSupervisor {
  return new Supervisor(options);
}

export { supervisorTaskIdForToken, supervisorPaths };
