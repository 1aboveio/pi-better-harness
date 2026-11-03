import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_LOG_TAIL_ROWS as NAVIGATOR_DETAIL_ROWS,
  ensureBackgroundWorkNavigator,
  refreshBackgroundWorkNavigator,
  registerBackgroundWorkProvider,
  type BackgroundWorkDetail,
  type BackgroundWorkProvider,
  type BackgroundWorkRow,
} from "./shared-navigator.ts";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { actionableFailures, failureLabel, readFailureState } from "./shared-failure-observations.js";
import { failurePath, failureView } from "./failures.js";
import { readLog } from "./logs.js";
import { listMetasForOrigin, onMetaChanged, readMeta, writeMeta } from "./registry.js";
import { getObservedWaitHost, type DurableTaskProjection } from "./observed-waits.js";
import { stopTask } from "./runtime.js";
import { formatBackgroundTaskStall, observeBackgroundTaskStall } from "./stall.js";
import type { BackgroundTaskCallbackOrigin, BackgroundTaskMeta, BackgroundTaskStatus } from "./types.js";

let unregister: (() => void) | undefined;
let piRef: ExtensionAPI | undefined;
let activeNavigatorOrigin: BackgroundTaskCallbackOrigin | undefined;
const TERMINAL_NAVIGATOR_RETENTION_MS = 30_000;

export function ensureBackgroundTasksNavigatorProvider(pi: ExtensionAPI): void {
  // A reloaded or replaced extension instance gets a fresh host. Re-register so
  // the provider's durable-change subscription targets that host, not the one
  // captured by the previous instance.
  if (piRef === pi && unregister) return;
  if (unregister) {
    try { unregister(); } catch { /* ignore */ }
    unregister = undefined;
  }
  piRef = pi;
  unregister = registerBackgroundWorkProvider(provider);
}

export function ensureBackgroundTasksNavigator(ctx: ExtensionContext): void {
  activeNavigatorOrigin = getNavigatorOrigin(ctx);
  ensureBackgroundWorkNavigator(ctx, {
    createDefaultEditor: (tui, theme, keybindings) => new CustomEditor(tui as never, theme as never, keybindings as never),
    isOpenTrigger: (data) => matchesKey(data, Key.left),
    matchKey: (data, keyId) => matchesKey(data, keyId as Parameters<typeof matchesKey>[1]),
    truncate: truncateToWidth,
  });
}

export function clearBackgroundTasksNavigatorSession(): void {
  activeNavigatorOrigin = undefined;
}

export function refreshBackgroundTasksNavigator(ctx?: ExtensionContext): void {
  refreshBackgroundWorkNavigator(ctx);
}

const provider: BackgroundWorkProvider = {
  id: "background-tasks",
  label: "Background Tasks",
  priority: 20,
  visibleCount: () => {
    const now = Date.now();
    return visibleMetas(now).filter((meta) => meta.status === "running").length
      + visibleDurableTasks(now).filter((task) => task.active).length;
  },
  listRows: (now) => [
    ...visibleMetas(now).map((meta) => rowFromMeta(meta, now)),
    ...visibleDurableTasks(now).map((task) => rowFromDurable(task, now)),
  ],
  detail: (id, now, options) => {
    const durable = durableTask(id);
    if (durable) return detailFromDurable(durable, options);
    return detailFromMeta(readMeta(id), now, options);
  },
  armCloseLabel: (row) => row.status === "running" || row.status === "starting" ? "x again to stop" : "x again to dismiss",
  close: (id) => {
    const durable = durableTask(id);
    if (durable) {
      const host = navigatorHost();
      const origin = activeNavigatorOrigin;
      if (!host || !origin) return { action: "missing", providerId: "background-tasks", id };
      if (durable.active) {
        void host.stopDurableTask(origin, id);
        return { action: "stopped", providerId: "background-tasks", id, status: "stopping" };
      }
      if (host.dismissDurableTask(origin, id)) {
        return { action: "dismissed", providerId: "background-tasks", id, status: durable.status };
      }
      return { action: "denied", providerId: "background-tasks", id };
    }
    const meta = readMeta(id);
    if (!meta) return { action: "missing", providerId: "background-tasks", id };
    if (meta.status === "running") {
      void stopTask(piRef as ExtensionAPI, id);
      return { action: "stopped", providerId: "background-tasks", id, status: "stopping" };
    }
    meta.dismissedAt = Date.now();
    writeMeta(meta);
    return { action: "dismissed", providerId: "background-tasks", id, status: meta.status };
  },
  onVisibleChanged: (notify) => {
    const offMeta = onMetaChanged(notify);
    const offDurable = getObservedWaitHost(piRef)?.onDurableTaskChange(notify);
    return () => {
      offMeta();
      offDurable?.();
    };
  },
};

function navigatorHost() {
  return piRef ? getObservedWaitHost(piRef) : undefined;
}

function visibleDurableTasks(now = Date.now()): DurableTaskProjection[] {
  const active = activeNavigatorOrigin;
  const host = navigatorHost();
  if (!active || !host) return [];
  const listed = host.listDurableTasks(active, { retentionMs: TERMINAL_NAVIGATOR_RETENTION_MS });
  return listed
    .filter((task) => task.dismissedAt === undefined && !isExpiredDurableRow(task, now));
}

function durableTask(id: string): DurableTaskProjection | undefined {
  const active = activeNavigatorOrigin;
  const host = navigatorHost();
  if (!active || !host) return undefined;
  return host.readDurableTask(active, id);
}

function isExpiredDurableRow(task: DurableTaskProjection, now: number): boolean {
  if (!task.terminal || task.endedAt === undefined) return false;
  return now - task.endedAt >= TERMINAL_NAVIGATOR_RETENTION_MS;
}

function rowFromDurable(task: DurableTaskProjection, now: number): BackgroundWorkRow {
  const command = durableCommandLabel(task);
  const elapsed = formatDuration((task.endedAt ?? now) - task.startedAt);
  const facts: string[] = [];
  if (task.attention && task.reason) facts.push(task.reason);
  else if (task.attention) facts.push(task.status);
  if (task.kind === "watch" && task.intervalSeconds) facts.push(`every ${formatDuration(task.intervalSeconds * 1000)}`);
  if (task.active && task.deadlineAt) facts.push(`${formatDuration(task.deadlineAt - now)} left`);
  if (task.waits.length) facts.push(`${task.waits.length} wait${task.waits.length === 1 ? "" : "s"}`);
  return {
    providerId: "background-tasks",
    id: task.id,
    name: task.name,
    status: task.status,
    statusTone: toneForDurableStatus(task.status),
    kind: task.kind,
    elapsed,
    primary: compactDurableLabel(task),
    command,
    tool: compactDurableLabel(task),
    secondary: [task.cwd, task.exitCode !== null ? `exit ${task.exitCode}` : undefined].filter(Boolean).join(" · ") || undefined,
    facts: facts.slice(0, 2),
    sortStartedAt: task.startedAt,
    expiresAt: task.terminal && task.endedAt !== undefined
      ? task.endedAt + TERMINAL_NAVIGATOR_RETENTION_MS
      : undefined,
  };
}

function detailFromDurable(task: DurableTaskProjection, options?: { logTailLines?: number }): BackgroundWorkDetail {
  const active = activeNavigatorOrigin;
  const host = navigatorHost();
  const lines = options?.logTailLines ?? NAVIGATOR_DETAIL_ROWS;
  const log = active && host ? host.readDurableTaskLog(active, task.id, lines) : undefined;
  const metadata = [
    { label: "provider", value: "Background Tasks (durable)" },
    { label: "kind", value: task.kind },
    { label: "operation", value: task.operationId },
    { label: "status", value: `${task.status}${task.terminalOutcome ? ` (${task.terminalOutcome})` : ""}` },
    { label: "started", value: new Date(task.startedAt).toISOString() },
    ...(task.endedAt !== undefined ? [{ label: "ended", value: new Date(task.endedAt).toISOString() }] : []),
    { label: "cwd", value: task.cwd },
    ...(task.exitCode !== null || task.signal ? [{ label: "exit", value: `${task.exitCode ?? "null"}${task.signal ? ` signal ${task.signal}` : ""}` }] : []),
    ...(task.reason ? [{ label: "reason", value: task.reason }] : []),
    ...(task.stepGateFailure ? [{ label: "step gate", value: `${task.stepGateFailure.command} exited ${task.stepGateFailure.stepExitCode}` }] : []),
    { label: "stdout", value: task.logPaths.stdout },
    { label: "stderr", value: task.logPaths.stderr },
    { label: "events", value: task.logPaths.events },
    ...(task.waits.length
      ? [{ label: "waits", value: task.waits.map((wait) => `${wait.waitId} ${wait.phase}`).join(", ") }]
      : []),
  ];
  const evidenceText = log
    ? [log.stdout, log.stderr ? `stderr:\n${log.stderr}` : "", log.events ? `events:\n${log.events}` : ""]
      .filter(Boolean).join("\n") || "(log is empty)"
    : "(durable log is unavailable)";
  return {
    providerId: "background-tasks",
    id: task.id,
    title: task.name || task.id,
    status: task.status,
    statusTone: toneForDurableStatus(task.status),
    subtitle: task.stepGateFailure?.command ?? task.reason ?? compactDurableLabel(task),
    metadata,
    foldedSections: [{
      id: "command",
      label: "command",
      text: task.command ?? (task.argv ? task.argv.join(" ") : "(no command recorded)"),
      collapsedText: compactDurableLabel(task),
      expandedByDefault: true,
    }],
    evidence: {
      label: log?.truncated ? "log tail" : "log",
      text: evidenceText,
    },
    footerActions: [task.active ? "x stop" : "x dismiss"],
  };
}

function durableCommandLabel(task: DurableTaskProjection): string {
  if (task.command) return task.command;
  if (task.argv?.length) return task.argv.join(" ");
  return task.name ?? "(no command recorded)";
}

function compactDurableLabel(task: DurableTaskProjection): string {
  const value = durableCommandLabel(task).trim();
  const parts = value.split(/\s+/).filter(Boolean);
  return parts.length <= 3 ? value : parts.slice(0, 3).join(" ");
}

function toneForDurableStatus(status: string): BackgroundWorkRow["statusTone"] {
  switch (status) {
    case "running":
    case "starting": return "running";
    case "succeeded": return "success";
    case "failed":
    case "timed_out":
    case "lost": return "failed";
    case "cancelled": return "warning";
    default: return "muted";
  }
}

function visibleMetas(now = Date.now()): BackgroundTaskMeta[] {
  const active = activeNavigatorOrigin;
  if (!active) return [];
  return listMetasForOrigin(active).filter((meta) => meta.dismissedAt === undefined && belongsToActiveNavigatorSession(meta) && !isExpiredTerminalNavigatorRow(meta, now));
}

function getNavigatorOrigin(ctx: ExtensionContext): BackgroundTaskCallbackOrigin {
  let sessionId: string | undefined;
  try {
    sessionId = ctx.sessionManager?.getSessionId();
  } catch {
    sessionId = undefined;
  }
  return { cwd: ctx.cwd, sessionId };
}

function belongsToActiveNavigatorSession(meta: BackgroundTaskMeta): boolean {
  const active = activeNavigatorOrigin;
  if (!active) return false;
  const origin = meta.callbackOrigin;
  if (origin) {
    if (origin.cwd !== active.cwd) return false;
    if (origin.sessionId || active.sessionId) return origin.sessionId === active.sessionId;
    return true;
  }
  if (active.sessionId) return false;
  return meta.cwd === active.cwd;
}

function isExpiredTerminalNavigatorRow(meta: BackgroundTaskMeta, now: number): boolean {
  if (meta.status === "running") return false;
  const endedAt = meta.endedAt;
  return typeof endedAt === "number" && now - endedAt >= TERMINAL_NAVIGATOR_RETENTION_MS;
}

function rowFromMeta(meta: BackgroundTaskMeta, now: number): BackgroundWorkRow {
  // Only a failure that needs action replaces the row's command; history stays in the detail view (#332).
  const view = failureView(meta.id);
  const failure = view.actionable ? view.text : "";
  const elapsed = formatDuration((meta.endedAt ?? now) - meta.startedAt);
  return {
    providerId: "background-tasks",
    id: meta.id,
    name: meta.name ?? (meta.ssh ? `${meta.ssh.target}${meta.remote?.session ? ` ${meta.remote.session}` : ""}` : undefined),
    status: meta.status,
    statusTone: toneForStatus(meta.status),
    kind: meta.kind === "command_watch" ? "watch" : "process",
    elapsed,
    primary: failure ? failure.split("\n")[0]! : compactCommandLabel(meta),
    command: commandLabel(meta),
    tool: compactCommandLabel(meta),
    secondary: secondaryLabel(meta),
    facts: factsForMeta(meta, now),
    sortStartedAt: meta.startedAt,
    expiresAt: meta.status === "running" || meta.endedAt === undefined
      ? undefined
      : meta.endedAt + TERMINAL_NAVIGATOR_RETENTION_MS,
  };
}

function detailFromMeta(meta: BackgroundTaskMeta | undefined, now: number, options?: { logTailLines?: number }): BackgroundWorkDetail | null {
  if (!meta) return null;
  const view = failureView(meta.id);
  const failure = view.text;
  const log = readLog(meta.logPath, options?.logTailLines ?? NAVIGATOR_DETAIL_ROWS);
  const command = commandLabel(meta);
  const metadata = [
    { label: "provider", value: "Background Tasks" },
    { label: "kind", value: meta.kind === "command_watch" ? "watch" : "process" },
    { label: "elapsed", value: formatDuration((meta.endedAt ?? now) - meta.startedAt) },
    { label: "cwd", value: meta.cwd },
    { label: "pid", value: meta.pid != null ? String(meta.pid) : "-" },
    { label: "pgid", value: meta.pgid != null ? String(meta.pgid) : "-" },
    { label: "log", value: meta.logPath },
  ];
  if (meta.ssh) metadata.push({ label: "remote", value: meta.ssh.target });
  if (meta.remote?.session) metadata.push({ label: "remote mode", value: meta.remote.session });
  if (meta.remote?.sessionName) metadata.push({ label: "remote session", value: meta.remote.sessionName });
  if (meta.remote?.bootstrapMessage) metadata.push({ label: "remote setup", value: meta.remote.bootstrapMessage });
  if (meta.remote?.warning) metadata.push({ label: "warning", value: meta.remote.warning });
  if (meta.deadlineAt) metadata.push({ label: "deadline", value: formatDuration(meta.deadlineAt - now) });
  if (meta.lastCheckedAt) metadata.push({ label: "checked", value: `${formatDuration(now - meta.lastCheckedAt)} ago` });
  if (meta.status === "running") {
    const activity = formatBackgroundTaskStall(observeBackgroundTaskStall(meta, now));
    if (activity) metadata.push({ label: "activity", value: activity });
  }
  if (meta.lastExitCode !== undefined) metadata.push({ label: "exit", value: String(meta.lastExitCode) });
  if (meta.error) metadata.push({ label: "error", value: meta.error });
  if (meta.logDiscardedBytes) {
    const count = meta.logRetentionEvents ?? 1;
    metadata.push({ label: "log dropped", value: `${formatBytes(meta.logDiscardedBytes)} in ${count} compaction${count === 1 ? "" : "s"}` });
  }
  return {
    providerId: "background-tasks",
    id: meta.id,
    title: meta.name || meta.id,
    status: meta.status,
    statusTone: toneForStatus(meta.status),
    subtitle: view.actionable ? failure.split("\n")[0]! : compactCommandLabel(meta),
    metadata,
    foldedSections: [{
      id: "command",
      label: "command",
      text: command,
      collapsedText: compactCommandLabel(meta),
      expandedByDefault: true,
    }],
    evidence: {
      label: log.truncated ? "log tail" : "log",
      text: [failure, log.text || "(log is empty)"].filter(Boolean).join("\n"),
    },
    footerActions: [meta.status === "running" ? "x stop" : "x dismiss"],
  };
}

function toneForStatus(status: BackgroundTaskStatus): BackgroundWorkRow["statusTone"] {
  switch (status) {
    case "running": return "running";
    case "succeeded": return "success";
    case "failed":
    case "timed_out": return "failed";
    case "cancelled": return "warning";
    default: return "muted";
  }
}

function commandLabel(meta: BackgroundTaskMeta): string {
  if (meta.command) return meta.command;
  if (meta.argv?.length) return meta.argv.join(" ");
  return "(no command recorded)";
}

function compactCommandLabel(meta: BackgroundTaskMeta): string {
  if (meta.ssh) return `${meta.ssh.target}${meta.remote?.session ? ` ${meta.remote.session}` : ""}`;
  const value = commandLabel(meta).trim();
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length <= 3) return value;
  return parts.slice(0, 3).join(" ");
}

function secondaryLabel(meta: BackgroundTaskMeta): string | undefined {
  const parts = [];
  if (meta.cwd) parts.push(meta.cwd);
  if (meta.remote?.session) parts.push(meta.remote.session);
  if (meta.pid != null) parts.push(`pid ${meta.pid}`);
  if (meta.lastExitCode !== undefined) parts.push(`exit ${meta.lastExitCode}`);
  return parts.length ? parts.join(" · ") : undefined;
}

function factsForMeta(meta: BackgroundTaskMeta, now: number): string[] {
  const facts: string[] = [];
  const incident = actionableFailures(readFailureState(failurePath(meta.id)))[0];
  if (incident) facts.push(`${failureLabel(incident)}: ${incident.summary}`);
  if (meta.status === "running") {
    const activity = formatBackgroundTaskStall(observeBackgroundTaskStall(meta, now));
    if (activity) facts.push(activity);
  }
  if (meta.kind === "command_watch" && meta.intervalMs) facts.push(`every ${formatDuration(meta.intervalMs)}`);
  if (meta.deadlineAt && meta.status === "running") facts.push(`${formatDuration(meta.deadlineAt - now)} left`);
  if (meta.result && meta.status !== "running") {
    const reason = typeof meta.result === "object" && meta.result && "reason" in meta.result
      ? String((meta.result as { reason?: unknown }).reason)
      : "result";
    facts.push(reason);
  }
  return facts.slice(0, 2);
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rest.toString().padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const min = minutes % 60;
  return `${hours}h ${min.toString().padStart(2, "0")}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
