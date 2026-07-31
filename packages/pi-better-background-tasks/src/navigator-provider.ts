import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  ensureBackgroundWorkNavigator,
  refreshBackgroundWorkNavigator,
  registerBackgroundWorkProvider,
  type BackgroundWorkDetail,
  type BackgroundWorkProvider,
  type BackgroundWorkRow,
} from "./shared-navigator.ts";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { readLog } from "./logs.js";
import { listMetas, readMeta, writeMeta } from "./registry.js";
import { stopTask } from "./runtime.js";
import type { BackgroundTaskCallbackOrigin, BackgroundTaskMeta, BackgroundTaskStatus } from "./types.js";

let unregister: (() => void) | undefined;
let piRef: ExtensionAPI | undefined;
let activeNavigatorOrigin: BackgroundTaskCallbackOrigin | undefined;
const TERMINAL_NAVIGATOR_RETENTION_MS = 30_000;

export function ensureBackgroundTasksNavigatorProvider(pi: ExtensionAPI): void {
  piRef = pi;
  if (unregister) return;
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
  visibleCount: () => visibleMetas(Date.now()).filter((meta) => meta.status === "running").length,
  listRows: (now) => visibleMetas(now).map((meta) => rowFromMeta(meta, now)),
  detail: (id, now, options) => detailFromMeta(readMeta(id), now, options),
  armCloseLabel: (row) => row.status === "running" ? "x again to stop" : "x again to dismiss",
  close: (id) => {
    const meta = readMeta(id);
    if (!meta) return { action: "missing", providerId: "background-tasks", id };
    if (meta.status === "running") {
      const stopped = stopTask(piRef as ExtensionAPI, id);
      return { action: "stopped", providerId: "background-tasks", id, status: stopped?.status };
    }
    meta.dismissedAt = Date.now();
    writeMeta(meta);
    return { action: "dismissed", providerId: "background-tasks", id, status: meta.status };
  },
};

function visibleMetas(now = Date.now()): BackgroundTaskMeta[] {
  return listMetas().filter((meta) => meta.dismissedAt === undefined && belongsToActiveNavigatorSession(meta) && !isExpiredTerminalNavigatorRow(meta, now));
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
  const elapsed = formatDuration((meta.endedAt ?? now) - meta.startedAt);
  return {
    providerId: "background-tasks",
    id: meta.id,
    name: meta.name,
    status: meta.status,
    statusTone: toneForStatus(meta.status),
    kind: meta.kind === "command_watch" ? "watch" : "process",
    elapsed,
    primary: compactCommandLabel(meta),
    command: commandLabel(meta),
    tool: compactCommandLabel(meta),
    secondary: secondaryLabel(meta),
    facts: factsForMeta(meta, now),
    sortStartedAt: meta.startedAt,
  };
}

function detailFromMeta(meta: BackgroundTaskMeta | undefined, now: number, options?: { logTailLines?: number }): BackgroundWorkDetail | null {
  if (!meta) return null;
  const log = readLog(meta.logPath, options?.logTailLines ?? 10);
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
  if (meta.deadlineAt) metadata.push({ label: "deadline", value: formatDuration(meta.deadlineAt - now) });
  if (meta.lastCheckedAt) metadata.push({ label: "checked", value: `${formatDuration(now - meta.lastCheckedAt)} ago` });
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
    subtitle: compactCommandLabel(meta),
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
      text: log.text || "(log is empty)",
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
  const value = commandLabel(meta).trim();
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length <= 3) return value;
  return parts.slice(0, 3).join(" ");
}

function secondaryLabel(meta: BackgroundTaskMeta): string | undefined {
  const parts = [];
  if (meta.cwd) parts.push(meta.cwd);
  if (meta.pid != null) parts.push(`pid ${meta.pid}`);
  if (meta.lastExitCode !== undefined) parts.push(`exit ${meta.lastExitCode}`);
  return parts.length ? parts.join(" · ") : undefined;
}

function factsForMeta(meta: BackgroundTaskMeta, now: number): string[] {
  const facts: string[] = [];
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
