import { statSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendLine, appendTaskOutput, appendWatchResult, retainLogTail, resolveMaxLogBytes } from "./logs.js";
import { evaluateCondition } from "./conditions.js";
import { processExists, runCommandOnce, spawnCommand, stopProcessGroup } from "./process.js";
import { DEFAULT_TMUX_BOOTSTRAP_TIMEOUT_MS, expandSshRemoteTaskPreset } from "./remote-task-preset.js";
import type { RemoteRunner, ResolvedSshRemoteTask } from "./remote-task-preset.js";
import { ensureTaskDir, logPathFor, nextTaskId, readMeta, sandboxProfilePathFor, writeMeta } from "./registry.js";
import { confineCommandSpec, resolveForegroundSandboxPlan } from "./sandbox.js";
import { getCallbackBatcher } from "./shared-callback-batcher.js";
import type {
  BackgroundTaskCallbackOrigin,
  BackgroundTaskMeta,
  CommandResult,
  CommandSpec,
  Condition,
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
const activePolls = new Set<string>();
const logRetentionTimers = new Map<string, ReturnType<typeof setInterval>>();
const LOG_RETENTION_CHECK_MS = 1000;
const REMOTE_SESSION_POLL_MS = 100;

export const DEFAULT_WATCH_TIMEOUT_SECONDS = 15 * 60;

/** Remote SSH launches never consult the local foreground sandbox policy. */
const UNCONFINED_LAUNCH = { confined: false } as const;

export type ActiveSessionProvider = () => BackgroundTaskCallbackOrigin | undefined;

export interface SpawnTaskParams extends CommandSpec {
  name?: string;
  callback?: boolean;
  timeout_seconds?: number;
  max_log_bytes?: number;
  ssh?: SshConnectionParams;
  remote?: RemoteTaskParams;
}

export interface WatchTaskParams extends CommandSpec {
  name?: string;
  callback?: boolean;
  interval_seconds?: number;
  timeout_seconds?: number;
  max_log_bytes?: number;
  success_when: Condition;
  failure_when?: Condition;
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
  // launch leaves nothing behind. Remote SSH work is not a local execution path
  // and keeps its existing remote semantics untouched.
  const sandboxPlan = params.ssh ? UNCONFINED_LAUNCH : resolveForegroundSandboxPlan(pi);
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
  const launchSpec = remoteTask
    ? commandSpec
    : confineCommandSpec(commandSpec, sandboxPlan, sandboxProfilePathFor(id));
  const tmuxBacked = remoteTask?.metadata.remote.session === "tmux";
  const spawned = tmuxBacked
    ? undefined
    : remoteTask
      ? remoteTask.spawn(logPath, true)
      : spawnCommand(launchSpec, logPath, true);
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
    pgid: spawned?.pgid,
    spawnPid: process.pid,
    ssh: remoteTask?.metadata.ssh,
    remote: remoteTask?.metadata.remote,
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
      latest.error = bootstrap.message;
      finalize(latest, { status: "failed", reason: bootstrap.message }, pi, getActiveSession);
      return;
    }

    const startAttempt = remoteTask.startTmuxSession(bootstrap.tmuxPath);
    remoteSessionStarts.set(id, startAttempt);
    let started: CommandResult;
    try {
      started = await startAttempt;
    } finally {
      if (remoteSessionStarts.get(id) === startAttempt) remoteSessionStarts.delete(id);
    }
    const afterStart = readMeta(id);
    if (!afterStart || afterStart.status !== "running" || afterStart.stopRequestedAt) return;
    if (started.exitCode !== 0) {
      const detail = started.stderr.trim() || started.stdout.trim() || "remote tmux returned no diagnostic";
      const reason = `Could not create remote tmux session ${afterStart.remote?.sessionName} on ${afterStart.ssh?.target} (exit ${started.exitCode ?? "unknown"}): ${detail}`;
      afterStart.error = reason;
      finalize(afterStart, { status: "failed", reason, commandResult: started }, pi, getActiveSession);
      return;
    }
    appendLine(afterStart.logPath, `--- remote tmux session ${afterStart.remote?.sessionName} started on ${afterStart.ssh?.target} ---`);
    afterStart.remote = { ...afterStart.remote!, sessionStarted: true };
    afterStart.lastProgressAt = Date.now();
    writeMeta(afterStart);
    scheduleRemoteSessionPoll(pi, id, 0, getActiveSession);
  } catch (error) {
    failRemoteTask(pi, id, error, getActiveSession);
  }
}

function scheduleRemoteSessionPoll(
  pi: ExtensionAPI,
  id: string,
  delayMs: number,
  getActiveSession?: ActiveSessionProvider,
): void {
  clearRemoteSessionTimer(id);
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
      latest.error = reason;
      finalize(latest, { status: "failed", reason }, pi, getActiveSession);
      return;
    }
    const commandResult = { ...poll.commandResult, exitCode: poll.status, stdout: poll.output };
    latest.lastExitCode = poll.status;
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
  const sandboxPlan = params.ssh ? UNCONFINED_LAUNCH : resolveForegroundSandboxPlan(pi);
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
  const launchSpec = remoteTask
    ? commandSpec
    : confineCommandSpec(commandSpec, sandboxPlan, sandboxProfilePathFor(id));
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
    successWhen: params.success_when,
    failureWhen: params.failure_when,
    notifyOn: "terminal",
    ssh: remoteTask?.metadata.ssh,
    remote: remoteTask?.metadata.remote,
  };
  ensureTaskDir(id);
  appendLine(meta.logPath, `--- watch ${new Date(now).toISOString()} interval_ms=${meta.intervalMs} ---`);
  writeMeta(meta);
  scheduleWatch(pi, id, 0, getActiveSession, remoteTask
    ? (timeoutMs) => remoteTask.runOnce(undefined, timeoutMs)
    : undefined);
  return meta;
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
    return meta;
  }
  if (meta.pid && !processExists(meta.pid)) {
    meta.status = "failed";
    meta.endedAt = Date.now();
    meta.error = "process is no longer alive; exit result was not captured by this pi session";
    meta.result = { reason: meta.error };
    writeMeta(meta);
    void notifyTerminal(pi, meta, getActiveSession);
    return meta;
  }
  if (meta.deadlineAt) scheduleProcessTimeout(pi, meta.id, meta.deadlineAt, getActiveSession);
  return meta;
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
    try { await remoteStartAttempt; } catch { /* A failed SSH result can still leave the detached session running. */ }
  }

  if (remoteSessionMayExist) {
    const remoteTask = activeRemoteTasks.get(id);
    if (!remoteTask) {
      meta.stopRequestedAt = undefined;
      meta.error = `Cannot stop remote tmux session ${remote.sessionName}: its active SSH controller is unavailable.`;
      writeMeta(meta);
      scheduleRemoteSessionPoll(pi, id, REMOTE_SESSION_POLL_MS, getActiveSession);
      return meta;
    }
    try {
      const stopped = await remoteTask.killTmuxSession();
      if (stopped.exitCode !== 0) {
        const detail = stopped.stderr.trim() || stopped.stdout.trim() || "remote tmux returned no diagnostic";
        meta.stopRequestedAt = undefined;
        meta.error = `Could not kill remote tmux session ${remote.sessionName} on ${meta.ssh?.target} (exit ${stopped.exitCode ?? "unknown"}): ${detail}`;
        writeMeta(meta);
        scheduleRemoteSessionPoll(pi, id, REMOTE_SESSION_POLL_MS, getActiveSession);
        return meta;
      }
      remote.stopMessage = `Killed remote tmux session ${remote.sessionName} on ${meta.ssh?.target}.`;
      appendLine(meta.logPath, `--- ${remote.stopMessage} ---`);
    } catch (error) {
      meta.stopRequestedAt = undefined;
      meta.error = error instanceof Error ? error.message : String(error);
      writeMeta(meta);
      scheduleRemoteSessionPoll(pi, id, REMOTE_SESSION_POLL_MS, getActiveSession);
      return meta;
    }
  } else if (meta.kind === "process" && meta.pid) {
    try {
      stopProcessGroup(meta.pid, meta.pgid);
    } catch (error) {
      meta.stopRequestedAt = undefined;
      meta.error = error instanceof Error ? error.message : String(error);
      writeMeta(meta);
      if (meta.deadlineAt && meta.deadlineAt > Date.now()) {
        scheduleProcessTimeout(pi, id, meta.deadlineAt, getActiveSession);
      }
      return meta;
    }
  }

  meta.status = "cancelled";
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

function scheduleWatch(
  pi: ExtensionAPI,
  id: string,
  delayMs: number,
  getActiveSession?: ActiveSessionProvider,
  runOnce?: WatchPollRunner,
): void {
  clearWatchTimer(id);
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
    appendWatchResult(meta.logPath, result);
    const latest = readMeta(id);
    if (!latest || latest.status !== "running") return;
    enforceLogRetention(latest);
    latest.lastCheckedAt = Date.now();
    latest.lastProgressAt = latest.lastCheckedAt;
    latest.lastExitCode = result.exitCode;
    latest.lastSignal = result.signal;
    latest.lastState = extractLastState(result);

    if (result.timedOut) {
      finalize(latest, { status: "timed_out", reason: watchTimeoutReason(latest), commandResult: result }, pi, getActiveSession);
      return;
    }

    if (latest.failureWhen) {
      const failure = evaluateCondition(latest.failureWhen, result);
      if (failure.matched) {
        finalize(latest, { status: "failed", reason: "failure condition matched", matchedCondition: latest.failureWhen, commandResult: result }, pi, getActiveSession);
        return;
      }
    }

    const transportFailure = sshTransportFailure(latest, result);
    if (transportFailure) {
      latest.error = transportFailure;
      finalize(latest, { status: "failed", reason: transportFailure, commandResult: result }, pi, getActiveSession);
      return;
    }

    if (latest.successWhen) {
      const success = evaluateCondition(latest.successWhen, result);
      if (success.matched) {
        finalize(latest, { status: "succeeded", reason: "success condition matched", matchedCondition: latest.successWhen, commandResult: result }, pi, getActiveSession);
        return;
      }
    }

    writeMeta(latest);
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
      finalize(meta, { status: "failed", reason }, pi, getActiveSession);
    }
  } finally {
    activePolls.delete(id);
  }
}

function finalize(
  meta: BackgroundTaskMeta,
  terminal: TerminalResult,
  pi: ExtensionAPI,
  getActiveSession?: ActiveSessionProvider,
): void {
  meta.status = terminal.status;
  meta.endedAt = Date.now();
  meta.result = {
    reason: terminal.reason,
    matchedCondition: terminal.matchedCondition,
    exitCode: terminal.commandResult?.exitCode,
    signal: terminal.commandResult?.signal,
  };
  if (terminal.commandResult) {
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
        meta.error = reason;
        writeMeta(meta);
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
  const label = latest.name ? `${latest.name} (${latest.id})` : latest.id;
  getCallbackBatcher(pi).enqueue({
    source: "background-task",
    id: latest.id,
    label,
    status: latest.status,
    detailTool: "bg_task_status",
    callback: true,
    isDelivered: () => {
      const current = readMeta(latest.id);
      return current?.callbackSentAt !== undefined || current?.callbackSuppressedAt !== undefined;
    },
    getSuppressionReason: () => {
      const current = readMeta(latest.id);
      if (!current) return "background task metadata is unavailable";
      return getCallbackSuppressionReason(current, getActiveSession?.());
    },
    onDelivered: (at) => {
      const current = readMeta(latest.id);
      if (!current || current.callbackSentAt !== undefined || current.callbackSuppressedAt !== undefined) return;
      current.callbackSentAt = at;
      writeMeta(current);
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
  writeMeta(meta);
}

function extractLastState(result: { stdout: string }): unknown {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return result.stdout.slice(0, 4000);
  }
}