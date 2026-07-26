import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendLine, appendWatchResult } from "./logs.js";
import { evaluateCondition } from "./conditions.js";
import { processExists, runCommandOnce, spawnCommand, stopProcessGroup } from "./process.js";
import { ensureTaskDir, logPathFor, nextTaskId, readMeta, writeMeta } from "./registry.js";
import type { BackgroundTaskMeta, CommandSpec, Condition, TerminalResult } from "./types.js";
import { isTerminalStatus } from "./types.js";

const watcherTimers = new Map<string, ReturnType<typeof setTimeout>>();
const activePolls = new Set<string>();

export interface SpawnTaskParams extends CommandSpec {
  name?: string;
  callback?: boolean;
  timeout_seconds?: number;
}

export interface WatchTaskParams extends CommandSpec {
  name?: string;
  callback?: boolean;
  interval_seconds?: number;
  timeout_seconds?: number;
  success_when: Condition;
  failure_when?: Condition;
}

export function spawnTask(pi: ExtensionAPI, params: SpawnTaskParams, defaultCwd: string): BackgroundTaskMeta {
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
    command: params.command,
    argv: params.argv,
    shell: params.shell ?? true,
    cwd,
    env: params.env,
    pid: spawned.child.pid,
    pgid: spawned.pgid,
    spawnPid: process.pid,
  };
  writeMeta(meta);
  spawned.child.unref();
  spawned.child.on("close", (exitCode, signal) => {
    const latest = readMeta(id);
    if (!latest || isTerminalStatus(latest.status)) return;
    latest.status = exitCode === 0 ? "succeeded" : "failed";
    latest.endedAt = Date.now();
    latest.lastExitCode = exitCode;
    latest.lastSignal = signal;
    latest.result = { exitCode, signal };
    writeMeta(latest);
    void notifyTerminal(pi, latest);
  });
  if (meta.deadlineAt) scheduleProcessTimeout(pi, id, meta.deadlineAt);
  return meta;
}

export function startWatchTask(pi: ExtensionAPI, params: WatchTaskParams, defaultCwd: string): BackgroundTaskMeta {
  const id = nextTaskId();
  const cwd = params.cwd ?? defaultCwd;
  const now = Date.now();
  const meta: BackgroundTaskMeta = {
    id,
    name: params.name,
    kind: "command_watch",
    status: "running",
    startedAt: now,
    deadlineAt: params.timeout_seconds ? now + params.timeout_seconds * 1000 : undefined,
    intervalMs: Math.max(1, params.interval_seconds ?? 30) * 1000,
    logPath: logPathFor(id),
    callback: params.callback,
    command: params.command,
    argv: params.argv,
    shell: params.shell ?? true,
    cwd,
    env: params.env,
    spawnPid: process.pid,
    successWhen: params.success_when,
    failureWhen: params.failure_when,
    notifyOn: "terminal",
  };
  ensureTaskDir(id);
  appendLine(meta.logPath, `--- watch ${new Date(now).toISOString()} interval_ms=${meta.intervalMs} ---`);
  writeMeta(meta);
  scheduleWatch(pi, id, 0);
  return meta;
}

export function resumeRunningTask(pi: ExtensionAPI, meta: BackgroundTaskMeta): BackgroundTaskMeta {
  if (meta.status !== "running") {
    void notifyTerminal(pi, meta);
    return meta;
  }
  if (meta.kind === "command_watch") {
    scheduleWatch(pi, meta.id, 0);
    return meta;
  }
  if (meta.kind === "process" && meta.pid && !processExists(meta.pid)) {
    meta.status = "failed";
    meta.endedAt = Date.now();
    meta.error = "process is no longer alive; exit result was not captured by this pi session";
    meta.result = { reason: meta.error };
    writeMeta(meta);
    void notifyTerminal(pi, meta);
    return meta;
  }
  if (meta.kind === "process" && meta.deadlineAt) scheduleProcessTimeout(pi, meta.id, meta.deadlineAt);
  return meta;
}

export function stopTask(pi: ExtensionAPI, id: string): BackgroundTaskMeta | undefined {
  const meta = readMeta(id);
  if (!meta) return undefined;
  if (isTerminalStatus(meta.status)) return meta;
  meta.status = "cancelled";
  meta.endedAt = Date.now();
  meta.stopRequestedAt = meta.endedAt;
  meta.result = { reason: "cancelled" };
  writeMeta(meta);
  clearWatchTimer(id);
  if (meta.kind === "process" && meta.pid) {
    try {
      stopProcessGroup(meta.pid, meta.pgid);
    } catch (error) {
      meta.error = error instanceof Error ? error.message : String(error);
      writeMeta(meta);
    }
  }
  void notifyTerminal(pi, meta);
  return meta;
}

function scheduleWatch(pi: ExtensionAPI, id: string, delayMs: number): void {
  clearWatchTimer(id);
  const timer = setTimeout(() => void pollWatch(pi, id), delayMs);
  timer.unref();
  watcherTimers.set(id, timer);
}

function clearWatchTimer(id: string): void {
  const timer = watcherTimers.get(id);
  if (timer) clearTimeout(timer);
  watcherTimers.delete(id);
}

async function pollWatch(pi: ExtensionAPI, id: string): Promise<void> {
  if (activePolls.has(id)) return;
  activePolls.add(id);
  try {
    const meta = readMeta(id);
    if (!meta || meta.status !== "running" || meta.kind !== "command_watch") return;
    const now = Date.now();
    if (meta.deadlineAt && now >= meta.deadlineAt) {
      finalize(meta, { status: "timed_out", reason: "timeout" }, pi);
      return;
    }
    const result = await runCommandOnce(commandSpecFromMeta(meta));
    appendWatchResult(meta.logPath, result);
    const latest = readMeta(id);
    if (!latest || latest.status !== "running") return;
    latest.lastCheckedAt = Date.now();
    latest.lastExitCode = result.exitCode;
    latest.lastSignal = result.signal;
    latest.lastState = extractLastState(result);

    if (latest.failureWhen) {
      const failure = evaluateCondition(latest.failureWhen, result);
      if (failure.matched) {
        finalize(latest, { status: "failed", reason: "failure condition matched", matchedCondition: latest.failureWhen, commandResult: result }, pi);
        return;
      }
    }

    if (latest.successWhen) {
      const success = evaluateCondition(latest.successWhen, result);
      if (success.matched) {
        finalize(latest, { status: "succeeded", reason: "success condition matched", matchedCondition: latest.successWhen, commandResult: result }, pi);
        return;
      }
    }

    writeMeta(latest);
    scheduleWatch(pi, id, latest.intervalMs ?? 30_000);
  } catch (error) {
    const meta = readMeta(id);
    if (meta && meta.status === "running") {
      finalize(meta, { status: "failed", reason: error instanceof Error ? error.message : String(error) }, pi);
    }
  } finally {
    activePolls.delete(id);
  }
}

function finalize(meta: BackgroundTaskMeta, terminal: TerminalResult, pi: ExtensionAPI): void {
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
  void notifyTerminal(pi, meta);
}

function scheduleProcessTimeout(pi: ExtensionAPI, id: string, deadlineAt: number): void {
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
    void notifyTerminal(pi, meta);
  }, delay);
  timer.unref();
}

async function notifyTerminal(pi: ExtensionAPI, meta: BackgroundTaskMeta): Promise<void> {
  if (meta.callback === false || meta.callbackSentAt) return;
  const latest = readMeta(meta.id) ?? meta;
  if (latest.callback === false || latest.callbackSentAt) return;
  const label = latest.name ? `${latest.name} (${latest.id})` : latest.id;
  try {
    await pi.sendUserMessage(
      `Background task ${label} reached terminal status ${latest.status}. Inspect it with bg_task_status or bg_task_log before summarizing the result.`,
      { deliverAs: "followUp" },
    );
    latest.callbackSentAt = Date.now();
    writeMeta(latest);
  } catch {
    // Leave callbackSentAt unset so a later session can attempt delivery once.
  }
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

function extractLastState(result: { stdout: string }): unknown {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return result.stdout.slice(0, 4000);
  }
}