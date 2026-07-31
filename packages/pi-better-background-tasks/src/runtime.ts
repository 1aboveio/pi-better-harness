import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendLine, appendWatchResult, retainLogTail, resolveMaxLogBytes } from "./logs.js";
import { evaluateCondition } from "./conditions.js";
import { processExists, runCommandOnce, spawnCommand, stopProcessGroup } from "./process.js";
import { ensureTaskDir, logPathFor, nextTaskId, readMeta, writeMeta } from "./registry.js";
import type { BackgroundTaskCallbackOrigin, BackgroundTaskMeta, CommandSpec, Condition, TerminalResult } from "./types.js";
import { isTerminalStatus } from "./types.js";

const watcherTimers = new Map<string, ReturnType<typeof setTimeout>>();
const activePolls = new Set<string>();
const logRetentionTimers = new Map<string, ReturnType<typeof setInterval>>();
const LOG_RETENTION_CHECK_MS = 1000;

export const DEFAULT_WATCH_TIMEOUT_SECONDS = 15 * 60;

export type ActiveSessionProvider = () => BackgroundTaskCallbackOrigin | undefined;

export interface SpawnTaskParams extends CommandSpec {
  name?: string;
  callback?: boolean;
  timeout_seconds?: number;
  max_log_bytes?: number;
}

export interface WatchTaskParams extends CommandSpec {
  name?: string;
  callback?: boolean;
  interval_seconds?: number;
  timeout_seconds?: number;
  max_log_bytes?: number;
  success_when: Condition;
  failure_when?: Condition;
}

export function spawnTask(
  pi: ExtensionAPI,
  params: SpawnTaskParams,
  defaultCwd: string,
  callbackOrigin?: BackgroundTaskCallbackOrigin,
  getActiveSession?: ActiveSessionProvider,
): BackgroundTaskMeta {
  const id = nextTaskId();
  const cwd = params.cwd ?? defaultCwd;
  const logPath = logPathFor(id);
  ensureTaskDir(id);
  const spawned = spawnCommand({ ...params, cwd, shell: params.shell ?? true }, logPath, true);
  const now = Date.now();
  const meta: BackgroundTaskMeta = {
    id,
    name: params.name,
    kind: "process",
    status: "running",
    startedAt: now,
    deadlineAt: params.timeout_seconds ? now + params.timeout_seconds * 1000 : undefined,
    logPath,
    callback: params.callback,
    callbackOrigin,
    command: params.command,
    argv: params.argv,
    shell: params.shell ?? true,
    cwd,
    env: params.env,
    maxLogBytes: resolveMaxLogBytes(params.max_log_bytes),
    pid: spawned.child.pid,
    pgid: spawned.pgid,
    spawnPid: process.pid,
  };
  writeMeta(meta);
  scheduleLogRetention(id);
  spawned.child.unref();
  spawned.child.on("close", (exitCode, signal) => {
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
  if (meta.deadlineAt) scheduleProcessTimeout(pi, id, meta.deadlineAt, getActiveSession);
  return meta;
}

export function startWatchTask(
  pi: ExtensionAPI,
  params: WatchTaskParams,
  defaultCwd: string,
  callbackOrigin?: BackgroundTaskCallbackOrigin,
  getActiveSession?: ActiveSessionProvider,
): BackgroundTaskMeta {
  const id = nextTaskId();
  const cwd = params.cwd ?? defaultCwd;
  const now = Date.now();
  const timeoutSeconds = resolveWatchTimeoutSeconds(params.timeout_seconds);
  const meta: BackgroundTaskMeta = {
    id,
    name: params.name,
    kind: "command_watch",
    status: "running",
    startedAt: now,
    deadlineAt: timeoutSeconds ? now + timeoutSeconds * 1000 : undefined,
    intervalMs: Math.max(1, params.interval_seconds ?? 30) * 1000,
    logPath: logPathFor(id),
    callback: params.callback,
    callbackOrigin,
    command: params.command,
    argv: params.argv,
    shell: params.shell ?? true,
    cwd,
    env: params.env,
    maxLogBytes: resolveMaxLogBytes(params.max_log_bytes),
    spawnPid: process.pid,
    successWhen: params.success_when,
    failureWhen: params.failure_when,
    notifyOn: "terminal",
  };
  ensureTaskDir(id);
  appendLine(meta.logPath, `--- watch ${new Date(now).toISOString()} interval_ms=${meta.intervalMs} ---`);
  writeMeta(meta);
  scheduleWatch(pi, id, 0, getActiveSession);
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
): BackgroundTaskMeta {
  if (meta.status !== "running") {
    void notifyTerminal(pi, meta, getActiveSession);
    return meta;
  }
  if (meta.kind === "command_watch") {
    scheduleWatch(pi, meta.id, 0, getActiveSession);
    return meta;
  }
  if (meta.kind === "process") scheduleLogRetention(meta.id);
  if (meta.kind === "process" && meta.pid && !processExists(meta.pid)) {
    meta.status = "failed";
    meta.endedAt = Date.now();
    meta.error = "process is no longer alive; exit result was not captured by this pi session";
    meta.result = { reason: meta.error };
    writeMeta(meta);
    void notifyTerminal(pi, meta, getActiveSession);
    return meta;
  }
  if (meta.kind === "process" && meta.deadlineAt) scheduleProcessTimeout(pi, meta.id, meta.deadlineAt, getActiveSession);
  return meta;
}

export function stopTask(pi: ExtensionAPI, id: string, getActiveSession?: ActiveSessionProvider): BackgroundTaskMeta | undefined {
  const meta = readMeta(id);
  if (!meta) return undefined;
  if (isTerminalStatus(meta.status)) return meta;
  meta.status = "cancelled";
  meta.endedAt = Date.now();
  meta.stopRequestedAt = meta.endedAt;
  meta.result = { reason: "cancelled" };
  writeMeta(meta);
  clearWatchTimer(id);
  stopLogRetention(id);
  if (meta.kind === "process" && meta.pid) {
    try {
      stopProcessGroup(meta.pid, meta.pgid);
    } catch (error) {
      meta.error = error instanceof Error ? error.message : String(error);
      writeMeta(meta);
    }
  }
  void notifyTerminal(pi, meta, getActiveSession);
  return meta;
}

function scheduleWatch(pi: ExtensionAPI, id: string, delayMs: number, getActiveSession?: ActiveSessionProvider): void {
  clearWatchTimer(id);
  const timer = setTimeout(() => void pollWatch(pi, id, getActiveSession), delayMs);
  timer.unref();
  watcherTimers.set(id, timer);
}

function clearWatchTimer(id: string): void {
  const timer = watcherTimers.get(id);
  if (timer) clearTimeout(timer);
  watcherTimers.delete(id);
}

async function pollWatch(pi: ExtensionAPI, id: string, getActiveSession?: ActiveSessionProvider): Promise<void> {
  if (activePolls.has(id)) return;
  activePolls.add(id);
  try {
    const meta = readMeta(id);
    if (!meta || meta.status !== "running" || meta.kind !== "command_watch") return;
    const now = Date.now();
    if (meta.deadlineAt && now >= meta.deadlineAt) {
      finalize(meta, { status: "timed_out", reason: "timeout" }, pi, getActiveSession);
      return;
    }
    const result = await runCommandOnce(commandSpecFromMeta(meta));
    appendWatchResult(meta.logPath, result);
    const latest = readMeta(id);
    if (!latest || latest.status !== "running") return;
    enforceLogRetention(latest);
    latest.lastCheckedAt = Date.now();
    latest.lastExitCode = result.exitCode;
    latest.lastSignal = result.signal;
    latest.lastState = extractLastState(result);

    if (latest.failureWhen) {
      const failure = evaluateCondition(latest.failureWhen, result);
      if (failure.matched) {
        finalize(latest, { status: "failed", reason: "failure condition matched", matchedCondition: latest.failureWhen, commandResult: result }, pi, getActiveSession);
        return;
      }
    }

    if (latest.successWhen) {
      const success = evaluateCondition(latest.successWhen, result);
      if (success.matched) {
        finalize(latest, { status: "succeeded", reason: "success condition matched", matchedCondition: latest.successWhen, commandResult: result }, pi, getActiveSession);
        return;
      }
    }

    writeMeta(latest);
    scheduleWatch(pi, id, latest.intervalMs ?? 30_000, getActiveSession);
  } catch (error) {
    const meta = readMeta(id);
    if (meta && meta.status === "running") {
      finalize(meta, { status: "failed", reason: error instanceof Error ? error.message : String(error) }, pi, getActiveSession);
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
  stopLogRetention(meta.id);
  void notifyTerminal(pi, meta, getActiveSession);
}

function scheduleProcessTimeout(
  pi: ExtensionAPI,
  id: string,
  deadlineAt: number,
  getActiveSession?: ActiveSessionProvider,
): void {
  const delay = Math.max(0, deadlineAt - Date.now());
  const timer = setTimeout(() => {
    const meta = readMeta(id);
    if (!meta || meta.status !== "running" || meta.kind !== "process") return;
    if (meta.pid) {
      try { stopProcessGroup(meta.pid, meta.pgid); } catch { /* ignore */ }
    }
    meta.status = "timed_out";
    meta.endedAt = Date.now();
    meta.result = { reason: "timeout" };
    writeMeta(meta);
    void notifyTerminal(pi, meta, getActiveSession);
  }, delay);
  timer.unref();
}

async function notifyTerminal(
  pi: ExtensionAPI,
  meta: BackgroundTaskMeta,
  getActiveSession?: ActiveSessionProvider,
): Promise<void> {
  if (meta.callback === false || meta.callbackSentAt || meta.callbackSuppressedAt) return;
  const latest = readMeta(meta.id) ?? meta;
  if (latest.callback === false || latest.callbackSentAt || latest.callbackSuppressedAt) return;
  const suppressionReason = getCallbackSuppressionReason(latest, getActiveSession?.());
  if (suppressionReason) {
    latest.callbackSuppressedAt = Date.now();
    latest.callbackSuppressedReason = suppressionReason;
    writeMeta(latest);
    return;
  }
  const label = latest.name ? `${latest.name} (${latest.id})` : latest.id;
  try {
    await pi.sendUserMessage(
      `Background task ${label} reached terminal status ${latest.status}. Inspect the compact result with bg_task_status id=${latest.id}; call bg_task_log only if the status summary is insufficient.`,
      { deliverAs: "followUp" },
    );
    latest.callbackSentAt = Date.now();
    writeMeta(latest);
  } catch {
    // Leave callbackSentAt unset so the originating session can attempt delivery once.
  }
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
  return {
    command: meta.command,
    argv: meta.argv,
    shell: meta.shell,
    cwd: meta.cwd,
    env: meta.env,
  };
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