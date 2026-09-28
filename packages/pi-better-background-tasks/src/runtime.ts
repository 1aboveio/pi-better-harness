import { statSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendLine, appendTaskOutput, appendWatchResult, retainLogTail, resolveMaxLogBytes } from "./logs.js";
import { evaluateCondition, validateCondition } from "./conditions.js";
import { processExists, runCommandOnce, spawnCommand, stopProcessGroup } from "./process.js";
import { currentProcessStartToken, readProcessStartToken } from "./process-identity.js";
import { DEFAULT_TMUX_BOOTSTRAP_TIMEOUT_MS, expandSshRemoteTaskPreset } from "./remote-task-preset.js";
import type { RemoteRunner, ResolvedSshRemoteTask } from "./remote-task-preset.js";
import { ensureTaskDir, logPathFor, nextTaskId, readMeta, sandboxProfilePathFor, writeMeta } from "./registry.js";
import { confineCommandSpec, resolveForegroundSandboxPlan } from "./sandbox.js";
import { takeRecoverySnapshot } from "./shared-sandbox-core.js";
import { failurePath, readTaskIntent, recordExitFailure, recordFailure, recoverDeclaredOperation, recoverFailure, resumeFailureAttention, scheduleFailureAttention, stopFailureAttention, suspendFailureAttention, terminalFailureAttention } from "./failures.js";
import { markFailureAttentionDelivered } from "./shared-failure-observations.js";
import { getCallbackBatcher } from "./shared-callback-batcher.js";
import { formatCallbackFacts } from "./output.js";
import type {
  BackgroundTaskCallbackOrigin,
  BackgroundTaskMeta,
  CommandResult,
  CommandSpec,
  Condition,
  FirstWatchCheck,
  RemoteTaskParams,
  SshConnectionParams,
  TerminalResult,
} from "./types.js";
import { isTerminalStatus } from "./types.js";

const watcherTimers = new Map<string, ReturnType<typeof setTimeout>>();
const remoteSessionTimers = new Map<string, ReturnType<typeof setTimeout>>();
const processTimeoutTimers = new Map<string, ReturnType<typeof setTimeout>>();
const activeProcessTimeouts = new Set<string>();
const activeRemoteTasks = new Map<string, ResolvedSshRemoteTask>();
const remoteSessionStarts = new Map<string, Promise<CommandResult>>();
/** Tasks whose stop in this instance is waiting on an in-flight tmux start, and kills the session itself. */
const remoteStopsAwaitingStart = new Set<string>();
const activePolls = new Set<string>();
const logRetentionTimers = new Map<string, ReturnType<typeof setInterval>>();
const LOG_RETENTION_CHECK_MS = 1000;
const handoffTimers = new Map<string, ReturnType<typeof setTimeout>>();
// The handoff check backs off from 250 ms to 4 s while the task keeps running,
// and returns to 250 ms once its process is gone so the grace period is timed closely.
const HANDOFF_CHECK_MS = 250;
const HANDOFF_MAX_CHECK_MS = 4_000;
const HANDOFF_LOST_GRACE_MS = 5_000;
let scheduledWorkSuspended = false;
const REMOTE_SESSION_POLL_MS = 100;

export const DEFAULT_WATCH_TIMEOUT_SECONDS = 15 * 60;
/** Consecutive blind checks (exit 0, stderr, no condition matched) before a watch is flagged (#359). */
export const DEFAULT_BLIND_CHECKS = 3;
/** How long bg_task_watch waits for the first check before returning (#359). */
export const FIRST_WATCH_CHECK_WAIT_MS = 15_000;
const BLIND_OPERATION = "watch-blind";
/** How to fix a false alarm: some tools write progress or warnings to stderr on success. */
export const BLIND_CHECK_HINT = "If the stderr is expected (progress or warnings), redirect it (2>/dev/null) or set blind_checks:0.";

/**
 * Why the launch stopped waiting before the first check finished (#359): the bounded wait
 * ran out, the tool call was aborted (Esc), or the session shut down.
 */
export type FirstCheckWaitEnd = "timeout" | "aborted" | "suspended";
/** A first check's outcome, or why it is not known yet; undefined when the watch ended without one. */
export type FirstCheckOutcome = FirstWatchCheck | { pending: FirstCheckWaitEnd; waitedMs: number } | undefined;

/** In-flight first checks of watches launched by this instance, keyed by task id. */
const firstCheckWaiters = new Map<string, { promise: Promise<FirstWatchCheck | "suspended" | undefined>; resolve: (check: FirstWatchCheck | "suspended" | undefined) => void }>();

/**
 * Wait for a watch's first check, bounded by `timeoutMs` and `signal` (#359). Resolves a pending
 * outcome when the wait ends first, and undefined when this instance did not launch the watch
 * or the watch ended without a check.
 */
export async function awaitFirstWatchCheck(id: string, timeoutMs = FIRST_WATCH_CHECK_WAIT_MS, signal?: AbortSignal): Promise<FirstCheckOutcome> {
  const waiter = firstCheckWaiters.get(id);
  if (!waiter) return undefined;
  const started = Date.now();
  const pending = (reason: FirstCheckWaitEnd) => ({ pending: reason, waitedMs: Date.now() - started });
  if (signal?.aborted) return pending("aborted");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    // Kept referenced: the launching tool call is waiting on it, and the watch timers are
    // unref'd, so an unref'd wait could let the event loop drain before the first check.
    timer = setTimeout(() => resolve("timeout"), Math.max(0, timeoutMs));
  });
  const aborted = new Promise<"aborted">((resolve) => {
    onAbort = () => resolve("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const outcome = await Promise.race([waiter.promise, timeout, aborted]);
    if (outcome === "timeout" || outcome === "aborted" || outcome === "suspended") return pending(outcome);
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

function settleFirstCheck(id: string, check: FirstWatchCheck | "suspended" | undefined): void {
  const waiter = firstCheckWaiters.get(id);
  if (!waiter) return;
  firstCheckWaiters.delete(id);
  waiter.resolve(check);
}

/**
 * Stop this extension instance's scheduled work when its session shuts down (#324).
 *
 * Pi emits session_shutdown for /reload, /new, /resume, fork, session switch,
 * and quit, and the next session loads a fresh extension instance. Work left in
 * the old instance runs with no active session, so a task finishing there used to
 * have its completion callback durably suppressed ("active session identity is
 * unavailable") and the next session never heard about it.
 *
 * After suspension this instance schedules nothing and notifies nothing. Work
 * already in flight (a child's close listener, a remote tmux bootstrap/start, a
 * timeout kill) still records its result in metadata, but leaves the callback to
 * the instance that resumes the task. Processes are not stopped.
 *
 * Resume is per callback origin: session_start resumes only tasks whose origin
 * (cwd and session id) matches the new session. After /reload that is every task
 * of the session. After switching to another session, the previous session's
 * tasks keep running, but their watches do not poll, remote tmux output is not
 * collected, and their `timeout_seconds` deadlines are not enforced until that
 * session is active again; an overdue deadline is enforced immediately on resume.
 * A local process that exits meanwhile, while this Pi process is still running,
 * is recorded as terminal and its callback is delivered when its session resumes;
 * after Pi quits, a resumed task whose process is gone is marked lost instead.
 */
export function suspendScheduledWork(): void {
  scheduledWorkSuspended = true;
  for (const timer of watcherTimers.values()) clearTimeout(timer);
  for (const timer of remoteSessionTimers.values()) clearTimeout(timer);
  for (const timer of processTimeoutTimers.values()) clearTimeout(timer);
  for (const timer of logRetentionTimers.values()) clearInterval(timer);
  for (const timer of handoffTimers.values()) clearTimeout(timer);
  handoffTimers.clear();
  watcherTimers.clear();
  remoteSessionTimers.clear();
  processTimeoutTimers.clear();
  logRetentionTimers.clear();
  // A launch still waiting on a first check that will not run here reports it as still running.
  for (const id of [...firstCheckWaiters.keys()]) settleFirstCheck(id, "suspended");
  suspendFailureAttention();
}

/** Allow scheduling again; called at session_start before running tasks are resumed. */
export function resumeScheduledWork(): void {
  scheduledWorkSuspended = false;
  resumeFailureAttention();
}



export type ActiveSessionProvider = () => BackgroundTaskCallbackOrigin | undefined;

/** Structured intent (#325), declared by the launching agent and shared by spawns and watchers. */
export interface TaskIntentParams {
  /** Stable id shared by modified retries of one operation. */
  operation_id?: string | null;
  /** Non-zero exit codes declared intentional before launch. */
  expected_exit_codes?: number[] | null;
}

export interface SpawnTaskParams extends CommandSpec, TaskIntentParams {
  name?: string;
  callback?: boolean;
  timeout_seconds?: number;
  max_log_bytes?: number;
  ssh?: SshConnectionParams;
  remote?: RemoteTaskParams;
}

export interface WatchTaskParams extends CommandSpec, TaskIntentParams {
  name?: string;
  callback?: boolean;
  interval_seconds?: number;
  timeout_seconds?: number;
  max_log_bytes?: number;
  success_when: Condition;
  failure_when?: Condition;
  /** Consecutive blind checks before the watch is flagged (#359). Default 3; 0 turns it off. */
  blind_checks?: number;
  ssh?: SshConnectionParams;
  remote?: RemoteTaskParams;
}

export interface TaskRuntimeDependencies {
  remoteRunner?: RemoteRunner;
}

type WatchPollRunner = (timeoutMs?: number) => Promise<CommandResult>;

export function spawnTask(
  pi: ExtensionAPI,
  params: SpawnTaskParams,
  defaultCwd: string,
  callbackOrigin?: BackgroundTaskCallbackOrigin,
  getActiveSession?: ActiveSessionProvider,
  dependencies: TaskRuntimeDependencies = {},
): BackgroundTaskMeta {
  // Resolved before any task directory, log, or metadata exists so a blocked
  // launch leaves nothing behind. Structured SSH must also honor launch restrictions.
  const intent = readTaskIntent(params);
  const sandboxPlan = resolveForegroundSandboxPlan(pi, !!params.ssh);
  const id = nextTaskId();
  const cwd = params.cwd ?? defaultCwd;
  const logPath = logPathFor(id);
  ensureTaskDir(id);
  const remoteTask = params.ssh
    ? expandSshRemoteTaskPreset({
      operation: "spawn",
      taskId: id,
      command: params.command,
      cwd,
      env: params.env,
      ssh: params.ssh,
      remote: params.remote,
    }, dependencies.remoteRunner)
    : undefined;
  const commandSpec: CommandSpec = remoteTask?.commandSpec ?? { ...params, cwd, shell: params.shell ?? true };
  const sandboxNotices: string[] = [];
  const launchSpec = remoteTask
    ? commandSpec
    : confineCommandSpec(commandSpec, sandboxPlan, sandboxProfilePathFor(id), {}, (line) => sandboxNotices.push(line));
  const tmuxBacked = remoteTask?.metadata.remote.session === "tmux";
  // Outside project = Write or Write & delete can change files outside the
  // project: start an APFS local snapshot (macOS, background, never blocks).
  const snapshot = !remoteTask && sandboxPlan.confined ? takeRecoverySnapshot(sandboxPlan.permissions) : undefined;
  const spawned = tmuxBacked
    ? undefined
    : remoteTask
      ? remoteTask.spawn(logPath, true)
      : spawnCommand(launchSpec, logPath, true);
  for (const line of sandboxNotices) {
    try { appendLine(logPath, `--- ${line} ---`); } catch { /* log gone */ }
  }
  if (snapshot?.started) {
    void snapshot.done.then((outcome) => {
      if (!outcome.ok) {
        try { appendLine(logPath, `--- recovery snapshot failed (task continues): ${outcome.detail} ---`); } catch { /* log gone */ }
      }
    });
  }
  const now = Date.now();
  const meta: BackgroundTaskMeta = {
    id,
    name: params.name,
    kind: "process",
    status: "running",
    startedAt: now,
    lastProgressAt: now,
    deadlineAt: params.timeout_seconds ? now + params.timeout_seconds * 1000 : undefined,
    logPath,
    callback: params.callback,
    callbackOrigin,
    command: params.command,
    argv: commandSpec.argv,
    shell: commandSpec.shell,
    cwd,
    env: params.env,
    launchArgv: launchArgvOf(commandSpec, launchSpec),
    maxLogBytes: resolveMaxLogBytes(params.max_log_bytes),
    pid: spawned?.child.pid,
    pidStartTime: spawned?.child.pid ? readProcessStartToken(spawned.child.pid) : undefined,
    pgid: spawned?.pgid,
    spawnPid: process.pid,
    spawnPidStartTime: currentProcessStartToken(),
    ssh: remoteTask?.metadata.ssh,
    remote: remoteTask?.metadata.remote,
    ...intent,
  };
  writeMeta(meta);
  scheduleLogRetention(id);
  if (tmuxBacked && remoteTask) {
    activeRemoteTasks.set(id, remoteTask);
    appendLine(logPath, `--- remote tmux bootstrap ${new Date(now).toISOString()} target=${remoteTask.metadata.ssh.target} session=${remoteTask.metadata.remote.sessionName} ---`);
    void launchRemoteTmux(pi, id, remoteTask, getActiveSession);
  } else if (spawned) {
    spawned.child.unref();
    spawned.child.on("close", (exitCode, signal) => {
      clearProcessTimeout(id);
      stopLogRetention(id);
      const latest = readMeta(id);
      if (!latest) return;
      enforceLogRetention(latest);
      if (isTerminalStatus(latest.status)) return;
      if (exitCode !== 0) recordExitFailure(latest, "execution", `Process exited with code ${exitCode ?? "unknown"}${signal ? ` (${signal})` : ""}`, exitCode, "close", { at: Date.now() });
      else {
        recoverFailure(latest, "execution", "close");
        recoverDeclaredOperation(latest);
      }
      latest.status = exitCode === 0 ? "succeeded" : "failed";
      latest.endedAt = Date.now();
      latest.lastExitCode = exitCode;
      latest.lastSignal = signal;
      latest.result = { exitCode, signal };
      writeMeta(latest);
      void notifyTerminal(pi, latest, getActiveSession);
    });
  }
  if (meta.deadlineAt) scheduleProcessTimeout(pi, id, meta.deadlineAt, getActiveSession);
  return meta;
}

async function launchRemoteTmux(
  pi: ExtensionAPI,
  id: string,
  remoteTask: ResolvedSshRemoteTask,
  getActiveSession?: ActiveSessionProvider,
): Promise<void> {
  try {
    const beforeBootstrap = readMeta(id);
    const remainingMs = remainingDeadlineMs(beforeBootstrap?.deadlineAt);
    const bootstrap = await remoteTask.bootstrapTmux(remainingMs === undefined
      ? undefined
      : { timeoutMs: Math.min(DEFAULT_TMUX_BOOTSTRAP_TIMEOUT_MS, remainingMs) });
    const latest = readMeta(id);
    if (!latest || latest.status !== "running" || latest.stopRequestedAt) return;
    latest.remote = {
      ...latest.remote!,
      bootstrapStatus: bootstrap.status,
      bootstrapMessage: bootstrap.message,
      tmuxInstalled: bootstrap.status === "installed",
    };
    appendLine(latest.logPath, `--- remote setup: ${bootstrap.message} ---`);
    writeMeta(latest);
    if (bootstrap.status !== "present" && bootstrap.status !== "installed") {
      recordFailure(latest, "remote-bootstrap", bootstrap.message, "bootstrap", { category: "ssh" });
      latest.error = bootstrap.message;
      finalize(latest, { status: "failed", reason: bootstrap.message }, pi, getActiveSession);
      return;
    }

    recoverFailure(latest, "remote-bootstrap", "bootstrap");
    const startAttempt = remoteTask.startTmuxSession(bootstrap.tmuxPath);
    remoteSessionStarts.set(id, startAttempt);
    let started: CommandResult;
    try {
      started = await startAttempt;
    } finally {
      if (remoteSessionStarts.get(id) === startAttempt) remoteSessionStarts.delete(id);
    }
    const afterStart = readMeta(id);
    if (!afterStart) return;
    if (afterStart.status !== "running" || afterStart.stopRequestedAt) {
      // Stopped (or timed out) while the start was in flight. A stop in this instance awaited the
      // attempt and kills the session itself. Anything else could not see the attempt: a stop from
      // an instance loaded by /reload, or a deadline that found the session not yet started. Only
      // this launch can still reach the session it may just have created, so it kills it (#332).
      if (!remoteStopsAwaitingStart.has(id)) await killSessionStartedAfterStop(afterStart, remoteTask);
      return;
    }
    if (started.exitCode !== 0) {
      const detail = started.stderr.trim() || started.stdout.trim() || "remote tmux returned no diagnostic";
      const reason = `Could not create remote tmux session ${afterStart.remote?.sessionName} on ${afterStart.ssh?.target} (exit ${started.exitCode ?? "unknown"}): ${detail}`;
      afterStart.error = reason;
      recordFailure(afterStart, "remote-start", reason, "start", { category: "ssh", at: started.endedAt });
      finalize(afterStart, { status: "failed", reason, commandResult: started }, pi, getActiveSession);
      return;
    }
    recoverFailure(afterStart, "remote-start", "start");
    appendLine(afterStart.logPath, `--- remote tmux session ${afterStart.remote?.sessionName} started on ${afterStart.ssh?.target} ---`);
    afterStart.remote = { ...afterStart.remote!, sessionStarted: true };
    afterStart.lastProgressAt = Date.now();
    writeMeta(afterStart);
    scheduleRemoteSessionPoll(pi, id, 0, getActiveSession);
  } catch (error) {
    failRemoteTask(pi, id, error, getActiveSession);
  }
}

/** Kill a tmux session whose start completed after its task stopped; a failed start may still have left it running. */
async function killSessionStartedAfterStop(meta: BackgroundTaskMeta, remoteTask: ResolvedSshRemoteTask): Promise<void> {
  const session = `remote tmux session ${meta.remote?.sessionName} on ${meta.ssh?.target}`;
  try {
    const stopped = await remoteTask.killTmuxSession();
    appendLine(meta.logPath, stopped.exitCode === 0
      ? `--- Killed ${session}: it started after the task was ${meta.status === "running" ? "stopped" : meta.status} ---`
      : `--- Could not kill ${session} that started after the task stopped (exit ${stopped.exitCode ?? "unknown"}) ---`);
  } catch (error) {
    appendLine(meta.logPath, `--- Could not kill ${session} that started after the task stopped: ${error instanceof Error ? error.message : String(error)} ---`);
  }
}

function scheduleRemoteSessionPoll(
  pi: ExtensionAPI,
  id: string,
  delayMs: number,
  getActiveSession?: ActiveSessionProvider,
): void {
  clearRemoteSessionTimer(id);
  if (scheduledWorkSuspended) return;
  const timer = setTimeout(() => void pollRemoteSession(pi, id, getActiveSession), delayMs);
  timer.unref();
  remoteSessionTimers.set(id, timer);
}

function clearRemoteSessionTimer(id: string): void {
  const timer = remoteSessionTimers.get(id);
  if (timer) clearTimeout(timer);
  remoteSessionTimers.delete(id);
}

async function pollRemoteSession(
  pi: ExtensionAPI,
  id: string,
  getActiveSession?: ActiveSessionProvider,
): Promise<void> {
  if (activePolls.has(id)) return;
  activePolls.add(id);
  try {
    const meta = readMeta(id);
    const remoteTask = activeRemoteTasks.get(id);
    if (!meta || meta.status !== "running" || meta.remote?.session !== "tmux" || !remoteTask) return;
    const poll = await remoteTask.pollTmuxSession(meta.remote.logOffset ?? 0, remainingDeadlineMs(meta.deadlineAt));
    if (scheduledWorkSuspended) return;
    appendTaskOutput(meta.logPath, poll.output);
    if (poll.status === "timed_out") {
      clearProcessTimeout(id);
      await timeoutProcess(pi, id, getActiveSession);
      return;
    }
    const latest = readMeta(id);
    if (!latest || latest.status !== "running") return;
    latest.remote = { ...latest.remote!, logOffset: poll.logSize };
    latest.lastCheckedAt = poll.commandResult.endedAt;
    if (poll.output) latest.lastProgressAt = poll.commandResult.endedAt;
    enforceLogRetention(latest);
    if (latest.stopRequestedAt) {
      writeMeta(latest);
      return;
    }
    if (poll.status === "running") {
      writeMeta(latest);
      scheduleRemoteSessionPoll(pi, id, REMOTE_SESSION_POLL_MS, getActiveSession);
      return;
    }
    if (poll.status === "missing") {
      const reason = `Remote tmux session ${latest.remote?.sessionName} disappeared on ${latest.ssh?.target} before an exit status was captured.`;
      recordFailure(latest, "remote-session", reason, "missing", { incomplete: true });
      latest.error = reason;
      finalize(latest, { status: "failed", reason }, pi, getActiveSession);
      return;
    }
    const commandResult = { ...poll.commandResult, exitCode: poll.status, stdout: poll.output };
    latest.lastExitCode = poll.status;
    if (poll.status !== 0) recordExitFailure(latest, "execution", `Remote command exited with code ${poll.status}`, poll.status, "exit");
    else recoverFailure(latest, "execution", "exit");
    finalize(latest, {
      status: poll.status === 0 ? "succeeded" : "failed",
      reason: `remote command exited with code ${poll.status}`,
      commandResult,
    }, pi, getActiveSession);
  } catch (error) {
    const latest = readMeta(id);
    if (latest?.status === "running" && latest.deadlineAt !== undefined && Date.now() >= latest.deadlineAt) {
      clearProcessTimeout(id);
      await timeoutProcess(pi, id, getActiveSession);
    } else {
      failRemoteTask(pi, id, error, getActiveSession);
    }
  } finally {
    activePolls.delete(id);
  }
}

function failRemoteTask(
  pi: ExtensionAPI,
  id: string,
  error: unknown,
  getActiveSession?: ActiveSessionProvider,
): void {
  const meta = readMeta(id);
  if (!meta || meta.status !== "running" || meta.stopRequestedAt) return;
  const reason = error instanceof Error ? error.message : String(error);
  meta.error = reason;
  recordFailure(meta, "remote-control", reason, "error", { category: "ssh" });
  finalize(meta, { status: "failed", reason }, pi, getActiveSession);
}

export function startWatchTask(
  pi: ExtensionAPI,
  params: WatchTaskParams,
  defaultCwd: string,
  callbackOrigin?: BackgroundTaskCallbackOrigin,
  getActiveSession?: ActiveSessionProvider,
  dependencies: TaskRuntimeDependencies = {},
): BackgroundTaskMeta {
  for (const [name, condition] of [["success_when", params.success_when], ["failure_when", params.failure_when]] as const) {
    const error = condition && validateCondition(condition);
    if (error) throw new Error(`${name}: ${error}`);
  }
  const blindChecks = readBlindChecks(params.blind_checks);
  const intent = readTaskIntent(params);
  const sandboxPlan = resolveForegroundSandboxPlan(pi, !!params.ssh);
  const id = nextTaskId();
  const cwd = params.cwd ?? defaultCwd;
  const now = Date.now();
  const timeoutSeconds = resolveWatchTimeoutSeconds(params.timeout_seconds);
  const remoteTask = params.ssh
    ? expandSshRemoteTaskPreset({
      operation: "watch",
      command: params.command,
      cwd,
      env: params.env,
      ssh: params.ssh,
      remote: params.remote,
    }, dependencies.remoteRunner)
    : undefined;
  const commandSpec: CommandSpec = remoteTask?.commandSpec ?? { ...params, cwd, shell: params.shell ?? true };
  const sandboxNotices: string[] = [];
  const launchSpec = remoteTask
    ? commandSpec
    : confineCommandSpec(commandSpec, sandboxPlan, sandboxProfilePathFor(id), {}, (line) => sandboxNotices.push(line));
  const meta: BackgroundTaskMeta = {
    id,
    name: params.name,
    kind: "command_watch",
    status: "running",
    startedAt: now,
    lastProgressAt: now,
    deadlineAt: timeoutSeconds ? now + timeoutSeconds * 1000 : undefined,
    intervalMs: Math.max(1, params.interval_seconds ?? 30) * 1000,
    logPath: logPathFor(id),
    callback: params.callback,
    callbackOrigin,
    command: params.command,
    argv: commandSpec.argv,
    shell: commandSpec.shell,
    cwd,
    env: params.env,
    launchArgv: launchArgvOf(commandSpec, launchSpec),
    maxLogBytes: resolveMaxLogBytes(params.max_log_bytes),
    spawnPid: process.pid,
    spawnPidStartTime: currentProcessStartToken(),
    successWhen: params.success_when,
    failureWhen: params.failure_when,
    ...(blindChecks !== undefined ? { blindChecks } : {}),
    notifyOn: "terminal",
    ssh: remoteTask?.metadata.ssh,
    remote: remoteTask?.metadata.remote,
    ...intent,
  };
  ensureTaskDir(id);
  appendLine(meta.logPath, `--- watch ${new Date(now).toISOString()} interval_ms=${meta.intervalMs} ---`);
  for (const line of sandboxNotices) appendLine(meta.logPath, `--- ${line} ---`);
  writeMeta(meta);
  let resolveFirst!: (check: FirstWatchCheck | "suspended" | undefined) => void;
  const firstCheck = new Promise<FirstWatchCheck | "suspended" | undefined>((resolve) => { resolveFirst = resolve; });
  firstCheckWaiters.set(id, { promise: firstCheck, resolve: resolveFirst });
  scheduleWatch(pi, id, 0, getActiveSession, remoteTask
    ? (timeoutMs) => remoteTask.runOnce(undefined, timeoutMs)
    : undefined);
  return meta;
}

function readBlindChecks(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("blind_checks must be a non-negative integer (0 turns the blind-check rule off).");
  }
  return value;
}

function resolveWatchTimeoutSeconds(timeoutSeconds: number | undefined): number | undefined {
  if (timeoutSeconds === undefined) return DEFAULT_WATCH_TIMEOUT_SECONDS;
  if (timeoutSeconds <= 0) return undefined;
  return timeoutSeconds;
}

export function resumeRunningTask(
  pi: ExtensionAPI,
  meta: BackgroundTaskMeta,
  getActiveSession?: ActiveSessionProvider,
  dependencies: TaskRuntimeDependencies = {},
): BackgroundTaskMeta {
  if (meta.status !== "running") {
    void notifyTerminal(pi, meta, getActiveSession);
    return meta;
  }
  scheduleFailureAttention(pi, meta.id, getActiveSession);

  // Same Pi process: an earlier (reloaded or switched-away) extension instance may
  // still hold this task's child or in-flight remote work and record its result.
  const ownedByThisProcess = meta.spawnPid === process.pid && meta.spawnPidStartTime === currentProcessStartToken();
  if (meta.spawnPid !== process.pid || meta.spawnPidStartTime !== currentProcessStartToken()) {
    meta.spawnPid = process.pid;
    meta.spawnPidStartTime = currentProcessStartToken();
    writeMeta(meta);
  }

  const remoteTask = resolvePersistedRemoteTask(meta, dependencies.remoteRunner);
  if (meta.kind === "command_watch") {
    scheduleWatch(pi, meta.id, 0, getActiveSession, remoteTask
      ? (timeoutMs) => remoteTask.runOnce(undefined, timeoutMs)
      : undefined);
    return meta;
  }

  scheduleLogRetention(meta.id);
  if (meta.remote?.session === "tmux" && meta.remote.sessionStarted !== false && remoteTask) {
    activeRemoteTasks.set(meta.id, remoteTask);
    scheduleRemoteSessionPoll(pi, meta.id, 0, getActiveSession);
    if (meta.deadlineAt) scheduleProcessTimeout(pi, meta.id, meta.deadlineAt, getActiveSession);
    // An earlier instance's in-flight timeout kill may still finalize it.
    if (ownedByThisProcess) scheduleHandoff(pi, meta.id, getActiveSession);
    return meta;
  }
  if (ownedByThisProcess) {
    // A dead pid is not yet "lost" here: the earlier instance's close listener may
    // still record the real exit. The handoff marks it lost after a grace period.
    scheduleHandoff(pi, meta.id, getActiveSession, remoteTask);
  } else if (meta.pid && !processExists(meta.pid)) {
    markProcessLost(pi, meta, getActiveSession);
    return meta;
  }
  if (meta.deadlineAt) scheduleProcessTimeout(pi, meta.id, meta.deadlineAt, getActiveSession);
  return meta;
}

/**
 * Watch a task whose driver may still be an earlier instance in this process: a
 * local child's close listener, or a remote tmux launch that was mid-bootstrap.
 * Deliver the completion once it is recorded terminal, and take over remote
 * polling once the tmux session is recorded as started (#324).
 */
function scheduleHandoff(
  pi: ExtensionAPI,
  id: string,
  getActiveSession?: ActiveSessionProvider,
  remoteTask?: ResolvedSshRemoteTask,
): void {
  stopHandoff(id);
  if (scheduledWorkSuspended) return;
  let deadSince: number | undefined;
  let delayMs = HANDOFF_CHECK_MS;
  const check = () => {
    handoffTimers.delete(id);
    const meta = readMeta(id);
    if (!meta) {
      stopHandoff(id);
      return;
    }
    if (meta.status !== "running") {
      stopHandoff(id);
      clearProcessTimeout(id);
      stopLogRetention(id);
      void notifyTerminal(pi, meta, getActiveSession);
      return;
    }
    if (meta.remote?.session === "tmux" && meta.remote.sessionStarted === true && remoteTask && !activeRemoteTasks.has(id)) {
      stopHandoff(id);
      activeRemoteTasks.set(id, remoteTask);
      scheduleRemoteSessionPoll(pi, id, 0, getActiveSession);
      return;
    }
    if (meta.remote?.session !== "tmux" && meta.pid && !processExists(meta.pid)) {
      deadSince ??= Date.now();
      if (Date.now() - deadSince >= HANDOFF_LOST_GRACE_MS) {
        stopHandoff(id);
        clearProcessTimeout(id);
        stopLogRetention(id);
        markProcessLost(pi, meta, getActiveSession);
        return;
      }
      delayMs = HANDOFF_CHECK_MS;
    } else {
      delayMs = Math.min(HANDOFF_MAX_CHECK_MS, delayMs * 2);
    }
    arm();
  };
  const arm = () => {
    if (scheduledWorkSuspended) return;
    const timer = setTimeout(check, delayMs);
    timer.unref();
    handoffTimers.set(id, timer);
  };
  arm();
}

function stopHandoff(id: string): void {
  const timer = handoffTimers.get(id);
  if (timer) clearTimeout(timer);
  handoffTimers.delete(id);
}

function markProcessLost(pi: ExtensionAPI, meta: BackgroundTaskMeta, getActiveSession?: ActiveSessionProvider): void {
  meta.status = "failed";
  meta.endedAt = Date.now();
  meta.error = "process is no longer alive; exit result was not captured by this pi session";
  meta.result = { reason: meta.error };
  recordFailure(meta, "execution", meta.error, "lost", { incomplete: true });
  writeMeta(meta);
  void notifyTerminal(pi, meta, getActiveSession);
}

function resolvePersistedRemoteTask(
  meta: BackgroundTaskMeta,
  remoteRunner?: RemoteRunner,
): ResolvedSshRemoteTask | undefined {
  if (!meta.ssh || !meta.remote?.session) return undefined;
  return expandSshRemoteTaskPreset({
    operation: meta.kind === "command_watch" ? "watch" : "spawn",
    taskId: meta.id,
    sessionName: meta.remote.sessionName,
    command: meta.remote.command || meta.command,
    cwd: meta.cwd,
    env: meta.env,
    ssh: {
      host: meta.ssh.host,
      user: meta.ssh.user,
      port: meta.ssh.port,
      identity_file: meta.ssh.identityFile,
      jump: meta.ssh.jump,
      options: meta.ssh.options,
    },
    remote: {
      session: meta.remote.session,
      install_tmux: meta.remote.installTmux,
      workdir: meta.remote.workdir,
    },
  }, remoteRunner);
}

export async function stopTask(
  pi: ExtensionAPI,
  id: string,
  getActiveSession?: ActiveSessionProvider,
): Promise<BackgroundTaskMeta | undefined> {
  const meta = readMeta(id);
  if (!meta) return undefined;
  if (isTerminalStatus(meta.status)) return meta;

  meta.stopRequestedAt = Date.now();
  writeMeta(meta);
  clearWatchTimer(id);
  clearRemoteSessionTimer(id);
  clearProcessTimeout(id);

  const remoteStartAttempt = remoteSessionStarts.get(id);
  const remote = meta.remote;
  const remoteSessionMayExist = remote?.session === "tmux"
    && (remote.sessionStarted !== false || remoteStartAttempt !== undefined);
  if (remoteStartAttempt) {
    remoteStopsAwaitingStart.add(id);
    try { await remoteStartAttempt; } catch { /* A failed SSH result can still leave the detached session running. */ }
    finally { remoteStopsAwaitingStart.delete(id); }
  }

  if (remoteSessionMayExist) {
    const remoteTask = activeRemoteTasks.get(id);
    if (!remoteTask) {
      recordStopError(meta, `Cannot stop remote tmux session ${remote.sessionName}: its active SSH controller is unavailable.`);
      scheduleRemoteSessionPoll(pi, id, REMOTE_SESSION_POLL_MS, getActiveSession);
      return meta;
    }
    try {
      const stopped = await remoteTask.killTmuxSession();
      if (stopped.exitCode !== 0) {
        const detail = stopped.stderr.trim() || stopped.stdout.trim() || "remote tmux returned no diagnostic";
        recordStopError(meta, `Could not kill remote tmux session ${remote.sessionName} on ${meta.ssh?.target} (exit ${stopped.exitCode ?? "unknown"}): ${detail}`);
        scheduleRemoteSessionPoll(pi, id, REMOTE_SESSION_POLL_MS, getActiveSession);
        return meta;
      }
      remote.stopMessage = `Killed remote tmux session ${remote.sessionName} on ${meta.ssh?.target}.`;
      appendLine(meta.logPath, `--- ${remote.stopMessage} ---`);
    } catch (error) {
      recordStopError(meta, error instanceof Error ? error.message : String(error));
      scheduleRemoteSessionPoll(pi, id, REMOTE_SESSION_POLL_MS, getActiveSession);
      return meta;
    }
  } else if (meta.kind === "process" && meta.pid) {
    try {
      stopProcessGroup(meta.pid, meta.pgid);
    } catch (error) {
      recordStopError(meta, error instanceof Error ? error.message : String(error));
      if (meta.deadlineAt && meta.deadlineAt > Date.now()) {
        scheduleProcessTimeout(pi, id, meta.deadlineAt, getActiveSession);
      }
      return meta;
    }
  }

  stopFailureAttention(id);
  meta.status = "cancelled";
  meta.stopError = undefined;
  meta.endedAt = Date.now();
  meta.result = {
    reason: meta.remote?.session === "direct"
      ? "cancelled local SSH client; the remote process may still be running"
      : "cancelled",
  };
  writeMeta(meta);
  stopLogRetention(id);
  activeRemoteTasks.delete(id);
  void notifyTerminal(pi, meta, getActiveSession);
  return meta;
}

function recordStopError(meta: BackgroundTaskMeta, message: string): void {
  meta.stopRequestedAt = undefined;
  meta.stopError = message;
  meta.error = message;
  writeMeta(meta);
}

function scheduleWatch(
  pi: ExtensionAPI,
  id: string,
  delayMs: number,
  getActiveSession?: ActiveSessionProvider,
  runOnce?: WatchPollRunner,
): void {
  clearWatchTimer(id);
  if (scheduledWorkSuspended) return;
  const timer = setTimeout(() => void pollWatch(pi, id, getActiveSession, runOnce), delayMs);
  timer.unref();
  watcherTimers.set(id, timer);
}

function clearWatchTimer(id: string): void {
  const timer = watcherTimers.get(id);
  if (timer) clearTimeout(timer);
  watcherTimers.delete(id);
}

async function pollWatch(
  pi: ExtensionAPI,
  id: string,
  getActiveSession?: ActiveSessionProvider,
  runOnce?: WatchPollRunner,
): Promise<void> {
  if (activePolls.has(id)) return;
  activePolls.add(id);
  let checked: FirstWatchCheck | undefined;
  try {
    const meta = readMeta(id);
    if (!meta || meta.status !== "running" || meta.kind !== "command_watch") return;
    const now = Date.now();
    if (meta.deadlineAt && now >= meta.deadlineAt) {
      finalize(meta, { status: "timed_out", reason: watchTimeoutReason(meta) }, pi, getActiveSession);
      return;
    }
    const timeoutMs = remainingDeadlineMs(meta.deadlineAt);
    const result = runOnce
      ? await runOnce(timeoutMs)
      : await runCommandOnce(commandSpecFromMeta(meta), undefined, timeoutMs);
    checked = {
      exitCode: result.exitCode, signal: result.signal, durationMs: Math.max(0, result.endedAt - result.startedAt),
      ...(result.timedOut ? { timedOut: true } : {}), stdout: result.stdout, stderr: result.stderr,
    };
    // A poll that was in flight when the session shut down belongs to a stale instance.
    if (scheduledWorkSuspended) return;
    appendWatchResult(meta.logPath, result);
    const latest = readMeta(id);
    if (!latest || latest.status !== "running") return;
    applyCaptureOverflow(latest, result);
    enforceLogRetention(latest);
    latest.lastCheckedAt = Date.now();
    latest.lastProgressAt = latest.lastCheckedAt;
    latest.lastExitCode = result.exitCode;
    latest.lastSignal = result.signal;
    latest.lastState = extractLastState(result);

    const pollKey = result.startedAt;
    if (result.timedOut) {
      finalize(latest, { status: "timed_out", reason: watchTimeoutReason(latest), commandResult: result }, pi, getActiveSession);
      return;
    }

    const conditionErrors: string[] = [];
    delete latest.error;
    for (const [name, condition] of [["success_when", latest.successWhen], ["failure_when", latest.failureWhen]] as const) {
      const error = condition && validateCondition(condition);
      if (error) {
        latest.error = `${name}: ${error}`;
        if (result.exitCode !== 0) recordExitFailure(latest, "watch-poll", `Watch poll exited with code ${result.exitCode ?? "unknown"}`, result.exitCode, pollKey,
          { at: result.endedAt });
        recordFailure(latest, name, latest.error, pollKey, { incomplete: true, at: result.endedAt });
        finalize(latest, { status: "failed", reason: latest.error, commandResult: result }, pi, getActiveSession);
        return;
      }
    }

    // Evaluate both conditions before deciding whether either can terminate the watch.
    const failure = latest.failureWhen ? evaluateCondition(latest.failureWhen, result) : undefined;
    const success = latest.successWhen ? evaluateCondition(latest.successWhen, result) : undefined;
    for (const [name, match] of [["failure_when", failure], ["success_when", success]] as const) {
      if (match?.error) {
        conditionErrors.push(`${name}: ${match.error}`);
        recordFailure(latest, name, `${name}: ${match.error}`, pollKey, { incomplete: true, at: result.endedAt });
      } else if (match) {
        recoverFailure(latest, name, pollKey, result.endedAt);
      }
    }
    const transportFailure = sshTransportFailure(latest, result);
    const expectedPollExit = !transportFailure && !conditionErrors.length && failure?.matched !== true &&
      success?.matched === true && latest.successWhen?.type === "exit_code";
    if (expectedPollExit) recoverFailure(latest, "watch-poll", pollKey, result.endedAt);
    if (transportFailure) recordFailure(latest, "watch-poll", transportFailure, pollKey, { category: "ssh", at: result.endedAt });
    else if (result.exitCode !== 0) recordExitFailure(latest, "watch-poll", `Watch poll exited with code ${result.exitCode ?? "unknown"}`, result.exitCode, pollKey,
      { expected: expectedPollExit, at: result.endedAt });
    else recoverFailure(latest, "watch-poll", pollKey, result.endedAt);
    observeBlindCheck(latest, result, pollKey, {
      clean: !transportFailure && !conditionErrors.length,
      matched: failure?.matched === true || success?.matched === true,
    });
    if (conditionErrors.length) latest.error = conditionErrors.join("; ");
    if (failure?.matched) {
      recordFailure(latest, "failure_when", "failure condition matched", pollKey, { category: "condition", at: result.endedAt });
      finalize(latest, {
        status: "failed",
        reason: "failure condition matched",
        matchedCondition: latest.failureWhen,
        matchedValue: failure.value,
        commandResult: result,
      }, pi, getActiveSession);
      return;
    }
    if (transportFailure) {
      latest.error = transportFailure;
      finalize(latest, { status: "failed", reason: transportFailure, commandResult: result }, pi, getActiveSession);
      return;
    }
    if (conditionErrors.length) {
      writeMeta(latest);
      scheduleFailureAttention(pi, id, getActiveSession);
      scheduleWatch(pi, id, nextWatchDelayMs(latest), getActiveSession, runOnce);
      return;
    }
    if (success?.matched) {
      finalize(latest, {
        status: "succeeded",
        reason: "success condition matched",
        matchedCondition: latest.successWhen,
        matchedValue: success.value,
        commandResult: result,
      }, pi, getActiveSession);
      return;
    }
    writeMeta(latest);
    scheduleFailureAttention(pi, id, getActiveSession);
    scheduleWatch(pi, id, nextWatchDelayMs(latest), getActiveSession, runOnce);
  } catch (error) {
    const meta = readMeta(id);
    if (meta && meta.status === "running") {
      const detail = readableError(error);
      const reason = meta.ssh ? `SSH poll to ${meta.ssh.target} failed: ${detail}` : detail;
      if (meta.ssh) {
        meta.error = reason;
        appendLine(meta.logPath, `--- poll error ${new Date().toISOString()} ---\n${reason}`);
      }
      recordFailure(meta, "watch-poll", reason, `throw:${meta.lastCheckedAt ?? meta.startedAt}`, { category: meta.ssh ? "ssh" : "execution" });
      finalize(meta, { status: "failed", reason }, pi, getActiveSession);
      checked ??= { exitCode: null, signal: null, durationMs: 0, stdout: "", stderr: "", error: reason };
    }
  } finally {
    activePolls.delete(id);
    if (firstCheckWaiters.has(id)) {
      if (checked) settleFirstCheck(id, checked);
      else if (readMeta(id)?.status !== "running") settleFirstCheck(id, undefined);
    }
  }
}

/**
 * Blind-check rule (#359). A check that exits 0, writes stderr, and matches neither condition
 * is probably broken: it prints an error and then reports "still pending" forever (the real
 * incident was a gcloud --format error followed by `exit 0`). After `blindChecks` such checks
 * in a row, record one actionable incident; the existing attention path wakes the parent once.
 * The watch keeps running. A later check with empty stderr, whatever its exit code (including a
 * non-zero, SSH-transport-failed or condition-error check), or one matching a condition,
 * recovers it; those failures are recorded as their own incidents. Any other check (non-zero
 * with stderr) resets the count and leaves the incident open. A clean pending check (exit 0,
 * no stderr) never counts.
 */
function observeBlindCheck(meta: BackgroundTaskMeta, result: CommandResult, pollKey: unknown,
  check: { clean: boolean; matched: boolean }): void {
  const threshold = meta.blindChecks ?? DEFAULT_BLIND_CHECKS;
  const stderr = result.stderr.trim();
  const blind = threshold > 0 && check.clean && !check.matched && result.exitCode === 0 && stderr.length > 0;
  if (!blind) {
    meta.blindCheckStreak = 0;
    if (!stderr || check.matched) recoverFailure(meta, BLIND_OPERATION, pollKey, result.endedAt);
    return;
  }
  const streak = (meta.blindCheckStreak ?? 0) + 1;
  meta.blindCheckStreak = streak;
  if (streak !== threshold) return;
  const lastLine = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  const clipped = lastLine.length > 240 ? `${lastLine.slice(0, 239)}…` : lastLine;
  // The summary is capped in compact rows; the stderr line rides as evidence, which rows show whole.
  recordFailure(meta, BLIND_OPERATION,
    `Blind watch check: ${streak} checks in a row exited 0 with stderr and matched no condition; the check may be broken. The watch keeps running.`,
    pollKey, { category: "blind-check", at: result.endedAt, evidence: `latest stderr: ${clipped} · ${BLIND_CHECK_HINT}` });
}

function finalize(
  meta: BackgroundTaskMeta,
  terminal: TerminalResult,
  pi: ExtensionAPI,
  getActiveSession?: ActiveSessionProvider,
): void {
  stopFailureAttention(meta.id);
  if (terminal.status === "timed_out") recordFailure(meta, "timeout", terminal.reason, "deadline", { category: "timeout" });
  if (terminal.status === "succeeded") recoverDeclaredOperation(meta);
  meta.status = terminal.status;
  meta.endedAt = Date.now();
  meta.result = {
    reason: terminal.reason,
    matchedCondition: terminal.matchedCondition,
    matchedValue: terminal.matchedValue,
    exitCode: terminal.commandResult?.exitCode,
    signal: terminal.commandResult?.signal,
  };
  if (terminal.commandResult) {
    applyCaptureOverflow(meta, terminal.commandResult);
    meta.lastExitCode = terminal.commandResult.exitCode;
    meta.lastSignal = terminal.commandResult.signal;
    meta.lastCheckedAt = terminal.commandResult.endedAt;
    meta.lastState = extractLastState(terminal.commandResult);
  }
  writeMeta(meta);
  clearWatchTimer(meta.id);
  clearRemoteSessionTimer(meta.id);
  clearProcessTimeout(meta.id);
  activeRemoteTasks.delete(meta.id);
  stopLogRetention(meta.id);
  void notifyTerminal(pi, meta, getActiveSession);
}

function sshTransportFailure(meta: BackgroundTaskMeta, result: CommandResult): string | undefined {
  if (!meta.ssh || result.exitCode !== 255) return undefined;
  const detail = readableError(result.stderr || result.stdout);
  return `SSH poll to ${meta.ssh.target} failed with exit 255${detail ? `: ${detail}` : ""}`;
}

function readableError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function watchTimeoutReason(meta: BackgroundTaskMeta): string {
  return meta.ssh ? `timeout waiting for SSH watch condition on ${meta.ssh.target}` : "timeout";
}

function nextWatchDelayMs(meta: BackgroundTaskMeta): number {
  const intervalMs = meta.intervalMs ?? 30_000;
  if (!meta.deadlineAt) return intervalMs;
  return Math.max(0, Math.min(intervalMs, meta.deadlineAt - Date.now()));
}

function remainingDeadlineMs(deadlineAt: number | undefined): number | undefined {
  if (deadlineAt === undefined) return undefined;
  return Math.max(1, deadlineAt - Date.now());
}

function scheduleProcessTimeout(
  pi: ExtensionAPI,
  id: string,
  deadlineAt: number,
  getActiveSession?: ActiveSessionProvider,
): void {
  clearProcessTimeout(id);
  if (scheduledWorkSuspended) return;
  const delay = Math.max(0, deadlineAt - Date.now());
  const timer = setTimeout(() => void timeoutProcess(pi, id, getActiveSession), delay);
  timer.unref();
  processTimeoutTimers.set(id, timer);
}

function clearProcessTimeout(id: string): void {
  const timer = processTimeoutTimers.get(id);
  if (timer) clearTimeout(timer);
  processTimeoutTimers.delete(id);
}

async function timeoutProcess(
  pi: ExtensionAPI,
  id: string,
  getActiveSession?: ActiveSessionProvider,
): Promise<void> {
  if (activeProcessTimeouts.has(id)) return;
  activeProcessTimeouts.add(id);
  try {
    await finalizeProcessTimeout(pi, id, getActiveSession);
  } finally {
    activeProcessTimeouts.delete(id);
  }
}

async function finalizeProcessTimeout(
  pi: ExtensionAPI,
  id: string,
  getActiveSession?: ActiveSessionProvider,
): Promise<void> {
  const meta = readMeta(id);
  if (!meta || meta.status !== "running" || meta.kind !== "process") return;

  let reason = "timeout";
  if (meta.remote?.session === "tmux" && meta.remote.sessionStarted !== true) {
    reason = `timeout before remote tmux session ${meta.remote.sessionName} started on ${meta.ssh?.target}`;
  } else if (meta.remote?.session === "tmux") {
    const remoteTask = activeRemoteTasks.get(id);
    if (!remoteTask) {
      reason = `timeout; remote tmux session ${meta.remote.sessionName} on ${meta.ssh?.target} could not be killed because its SSH controller is unavailable`;
      meta.error = reason;
    } else {
      try {
        const stopped = await remoteTask.killTmuxSession();
        if (stopped.exitCode === 0) {
          meta.remote.stopMessage = `Killed remote tmux session ${meta.remote.sessionName} on ${meta.ssh?.target} after timeout.`;
          appendLine(meta.logPath, `--- ${meta.remote.stopMessage} ---`);
          reason = `timeout; killed remote tmux session ${meta.remote.sessionName} on ${meta.ssh?.target}`;
        } else {
          const detail = stopped.stderr.trim() || stopped.stdout.trim() || "remote tmux returned no diagnostic";
          reason = `timeout; could not kill remote tmux session ${meta.remote.sessionName} on ${meta.ssh?.target} (exit ${stopped.exitCode ?? "unknown"}): ${detail}`;
          meta.error = reason;
        }
      } catch (error) {
        reason = `timeout; could not kill remote tmux session ${meta.remote.sessionName} on ${meta.ssh?.target}: ${readableError(error)}`;
        meta.error = reason;
      }
    }
  } else {
    if (meta.pid) {
      try {
        stopProcessGroup(meta.pid, meta.pgid);
      } catch (error) {
        reason = `timeout; could not terminate local process tree: ${readableError(error)}`;
        // The task is still running: this is a stop failure, reported as such.
        recordStopError(meta, reason);
        return;
      }
    }
    if (meta.remote?.session === "direct") {
      reason = "timeout; terminated local SSH client, but the remote process may still be running";
    }
  }

  const latest = readMeta(id);
  if (!latest || latest.status !== "running") return;
  latest.remote = latest.remote && meta.remote
    ? { ...latest.remote, stopMessage: meta.remote.stopMessage }
    : meta.remote;
  latest.error = meta.error;
  finalize(latest, { status: "timed_out", reason }, pi, getActiveSession);
}

async function notifyTerminal(
  pi: ExtensionAPI,
  meta: BackgroundTaskMeta,
  getActiveSession?: ActiveSessionProvider,
): Promise<void> {
  // A suspended instance has no active session: delivering or suppressing here would
  // be wrong either way. The instance that resumes the task delivers it (#324).
  if (scheduledWorkSuspended) return;
  if (meta.callback === false || meta.callbackSentAt || meta.callbackSuppressedAt) return;
  const latest = readMeta(meta.id) ?? meta;
  if (latest.callback === false || latest.callbackSentAt || latest.callbackSuppressedAt) return;
  // Cancellation is an explicit action by the agent or user, so a completion
  // wakeup would be noise. Record the suppression durably so the session_start
  // replay path never fires a callback for a cancelled task either.
  if (latest.status === "cancelled") {
    latest.callbackSuppressedAt = Date.now();
    latest.callbackSuppressedReason = "task was cancelled; no completion callback is needed";
    writeMeta(latest);
    return;
  }
  const pending = terminalFailureAttention(latest.id);
  const label = latest.name ? `${latest.name} (${latest.id})` : latest.id;
  const facts = formatCallbackFacts(latest);
  getCallbackBatcher(pi).enqueue({
    source: "background-task",
    id: latest.id,
    label,
    // Lifecycle plus an attention count; the incident text rides failureRows
    // with exact counts, so the status field is never a clipped summary (#323).
    status: pending
      ? `${latest.status}; ${pending.incidents.length} incident${pending.incidents.length === 1 ? "" : "s"} need${pending.incidents.length === 1 ? "s" : ""} attention`
      : latest.status,
    detailTool: "bg_task_status",
    outcome: facts.outcome,
    failureRows: facts.failureRows,
    decision: facts.decision,
    incidentCount: facts.incidentCount,
    callback: true,
    isDelivered: () => {
      const current = readMeta(latest.id);
      return current?.callbackSentAt !== undefined || current?.callbackSuppressedAt !== undefined;
    },
    getSuppressionReason: () => {
      const current = readMeta(latest.id);
      if (!current) throw new Error("Background task metadata is unavailable; defer completion");
      return getCallbackSuppressionReason(current, getActiveSession?.());
    },
    onDelivered: (at) => {
      const current = readMeta(latest.id);
      if (!current || current.callbackSentAt !== undefined || current.callbackSuppressedAt !== undefined) return;
      current.callbackSentAt = at;
      writeMeta(current);
      if (pending) markFailureAttentionDelivered(failurePath(latest.id), pending, at);
    },
    onSuppressed: (reason, at) => {
      const current = readMeta(latest.id);
      if (!current || current.callbackSentAt !== undefined || current.callbackSuppressedAt !== undefined) return;
      current.callbackSuppressedAt = at;
      current.callbackSuppressedReason = reason;
      writeMeta(current);
    },
  });
}

function getCallbackSuppressionReason(
  meta: BackgroundTaskMeta,
  activeSession: BackgroundTaskCallbackOrigin | undefined,
): string | undefined {
  const origin = meta.callbackOrigin;
  if (origin) {
    if (!activeSession) return "active session identity is unavailable";
    if (origin.cwd !== activeSession.cwd) return `origin cwd ${origin.cwd} does not match active cwd ${activeSession.cwd}`;
    if (origin.sessionId && origin.sessionId !== activeSession.sessionId) {
      return `origin session ${origin.sessionId} does not match active session ${activeSession.sessionId ?? "unknown"}`;
    }
    return undefined;
  }

  if (activeSession && meta.cwd !== activeSession.cwd) {
    return `legacy task cwd ${meta.cwd} does not match active cwd ${activeSession.cwd}`;
  }
  return undefined;
}

function commandSpecFromMeta(meta: BackgroundTaskMeta): CommandSpec {
  // A task that launched under a sandbox re-runs the wrapper it captured then,
  // not whatever the foreground policy says now — including after a resume in a
  // later Pi session.
  if (meta.launchArgv?.length) {
    return {
      argv: meta.launchArgv,
      shell: false,
      cwd: meta.cwd,
      env: meta.env,
    };
  }
  return {
    command: meta.command,
    argv: meta.argv,
    shell: meta.shell,
    cwd: meta.cwd,
    env: meta.env,
  };
}

/** Record a launch vector only when confinement actually rewrote the spec. */
function launchArgvOf(commandSpec: CommandSpec, launchSpec: CommandSpec): string[] | undefined {
  return launchSpec === commandSpec ? undefined : launchSpec.argv;
}

function scheduleLogRetention(id: string): void {
  stopLogRetention(id);
  if (scheduledWorkSuspended) return;
  const timer = setInterval(() => {
    const meta = readMeta(id);
    if (!meta || meta.status !== "running" || meta.kind !== "process") {
      stopLogRetention(id);
      return;
    }
    enforceLogRetention(meta);
  }, LOG_RETENTION_CHECK_MS);
  timer.unref();
  logRetentionTimers.set(id, timer);
}

function stopLogRetention(id: string): void {
  const timer = logRetentionTimers.get(id);
  if (timer) clearInterval(timer);
  logRetentionTimers.delete(id);
}

function enforceLogRetention(meta: BackgroundTaskMeta): void {
  try {
    const mtimeMs = Math.trunc(statSync(meta.logPath).mtimeMs);
    if (mtimeMs > (meta.lastProgressAt ?? meta.startedAt)) {
      meta.lastProgressAt = mtimeMs;
      writeMeta(meta);
    }
  } catch {
    // Logs are optional progress evidence; retention still proceeds if absent.
  }
  const compacted = retainLogTail(meta.logPath, resolveMaxLogBytes(meta.maxLogBytes));
  if (!compacted) return;
  meta.logDiscardedBytes = (meta.logDiscardedBytes ?? 0) + compacted.discardedBytes;
  meta.logRetentionEvents = (meta.logRetentionEvents ?? 0) + 1;
  meta.logGeneration = (meta.logGeneration ?? 0) + 1;
  writeMeta(meta);
}

/** Results whose capture loss is already counted; one poll result is counted once. */
const countedCaptureResults = new WeakSet<CommandResult>();

function applyCaptureOverflow(meta: BackgroundTaskMeta, result: CommandResult): void {
  const stdout = result.stdoutDiscardedBytes ?? 0;
  const stderr = result.stderrDiscardedBytes ?? 0;
  if (!result.captureTruncated && stdout === 0 && stderr === 0) return;
  // pollWatch counts a result before evaluating conditions, and finalize sees
  // the same result again when that poll ends the watch.
  if (countedCaptureResults.has(result)) return;
  countedCaptureResults.add(result);
  meta.stdoutDiscardedBytes = (meta.stdoutDiscardedBytes ?? 0) + stdout;
  meta.stderrDiscardedBytes = (meta.stderrDiscardedBytes ?? 0) + stderr;
  meta.captureDiscardedBytes = (meta.captureDiscardedBytes ?? 0) + stdout + stderr;
  meta.captureOverflowEvents = (meta.captureOverflowEvents ?? 0) + 1;
}

function extractLastState(result: { stdout: string }): unknown {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return result.stdout.slice(0, 4000);
  }
}