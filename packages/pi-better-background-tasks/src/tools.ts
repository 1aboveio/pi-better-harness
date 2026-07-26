import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readLog } from "./logs.js";
import { refreshBackgroundTasksNavigator } from "./navigator-provider.js";
import { listMetas, readMeta } from "./registry.js";
import { resumeRunningTask, spawnTask, startWatchTask, stopTask } from "./runtime.js";
import type { BackgroundTaskCallbackOrigin, BackgroundTaskMeta } from "./types.js";

const ConditionSchema = Type.Union([
  Type.Object({ type: Type.Literal("exit_code"), equals: Type.Number() }),
  Type.Object({ type: Type.Literal("stdout_contains"), value: Type.String() }),
  Type.Object({ type: Type.Literal("stderr_contains"), value: Type.String() }),
  Type.Object({ type: Type.Literal("json_path_equals"), path: Type.String(), value: Type.Any() }),
  Type.Object({ type: Type.Literal("json_path_exists"), path: Type.String() }),
]);

const CommandFields = {
  name: Type.Optional(Type.String({ description: "Human-readable task label." })),
  command: Type.Optional(Type.String({ description: "Shell command to run. Required unless shell:false with argv is used." })),
  argv: Type.Optional(Type.Array(Type.String(), { description: "Argument vector. Use with shell:false to avoid shell parsing." })),
  shell: Type.Optional(Type.Boolean({ description: "Run command through the package's bash-compatible shell. Default true." })),
  cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the current pi cwd." })),
  env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Extra environment variables." })),
  callback: Type.Optional(Type.Boolean({ description: "Queue a follow-up when the task reaches a terminal state. Default true." })),
  timeout_seconds: Type.Optional(Type.Number({ description: "Optional timeout in seconds." })),
};

const SpawnParams = Type.Object(CommandFields);

const WatchParams = Type.Object({
  ...CommandFields,
  interval_seconds: Type.Optional(Type.Number({ description: "Polling interval in seconds. Default 30." })),
  success_when: ConditionSchema,
  failure_when: Type.Optional(ConditionSchema),
});

const IdParams = Type.Object({ id: Type.String({ description: "Background task id." }) });
const ListParams = Type.Object({
  status: Type.Optional(Type.Array(Type.String({ description: "Statuses to include." }))),
  limit: Type.Optional(Type.Number({ description: "Maximum tasks to show. Default 20." })),
});
const LogParams = Type.Object({
  id: Type.String({ description: "Background task id." }),
  tail_lines: Type.Optional(Type.Number({ description: "Number of trailing lines. Omit or set <=0 for full log." })),
});

const ActionParams = Type.Object({
  action: Type.Union([
    Type.Literal("spawn"),
    Type.Literal("watch"),
    Type.Literal("list"),
    Type.Literal("status"),
    Type.Literal("log"),
    Type.Literal("stop"),
  ]),
  id: Type.Optional(Type.String()),
  status: Type.Optional(Type.Array(Type.String())),
  limit: Type.Optional(Type.Number()),
  tail_lines: Type.Optional(Type.Number()),
  ...CommandFields,
  interval_seconds: Type.Optional(Type.Number()),
  success_when: Type.Optional(ConditionSchema),
  failure_when: Type.Optional(ConditionSchema),
});

const StatusActionParams = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("status"), Type.Literal("log"), Type.Literal("stop")]),
  id: Type.Optional(Type.String()),
  status: Type.Optional(Type.Array(Type.String())),
  limit: Type.Optional(Type.Number()),
  tail_lines: Type.Optional(Type.Number()),
});

export function registerTools(pi: ExtensionAPI): void {
  let activeSession: BackgroundTaskCallbackOrigin | undefined;
  const getActiveSession = () => activeSession;

  pi.on("session_start", async (_event, ctx) => {
    activeSession = getCallbackOrigin(ctx);
    for (const meta of listMetas()) resumeRunningTask(pi, meta, getActiveSession);
  });
  pi.on("session_before_switch", () => {
    activeSession = undefined;
  });
  pi.on("session_shutdown", () => {
    activeSession = undefined;
  });

  pi.registerTool({
    name: "bg_task_spawn",
    label: "BG Spawn",
    description: "Start a long-running background process and return immediately with its task id. Never wait or poll in the foreground.",
    parameters: SpawnParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      activeSession = getCallbackOrigin(ctx);
      const meta = spawnTask(pi, params, ctx.cwd, activeSession, getActiveSession);
      refreshBackgroundTasksNavigator(ctx);
      return text(formatLaunch(meta));
    },
  });

  pi.registerTool({
    name: "bg_task_watch",
    label: "BG Watch",
    description: "Poll a command in the background until success_when, failure_when, or timeout matches. Returns immediately with its task id.",
    parameters: WatchParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      activeSession = getCallbackOrigin(ctx);
      const meta = startWatchTask(pi, params, ctx.cwd, activeSession, getActiveSession);
      refreshBackgroundTasksNavigator(ctx);
      return text(formatLaunch(meta));
    },
  });

  pi.registerTool({
    name: "bg_task_list",
    label: "BG List",
    description: "List durable background tasks. Nonblocking.",
    parameters: ListParams,
    async execute(_toolCallId, params) {
      return text(formatList(resolveList(params.status, params.limit)));
    },
  });

  pi.registerTool({
    name: "bg_task_status",
    label: "BG Status",
    description: "Inspect one background task metadata record. Nonblocking.",
    parameters: IdParams,
    async execute(_toolCallId, params) {
      const meta = readMeta(params.id);
      return text(meta ? formatStatus(meta) : `No background task found for id ${params.id}.`);
    },
  });

  pi.registerTool({
    name: "bg_task_log",
    label: "BG Log",
    description: "Read a background task log. Use tail_lines for bounded output. Nonblocking.",
    parameters: LogParams,
    renderResult(result: unknown, options: unknown, theme: unknown) {
      return renderBackgroundTaskLogDisplay(result, options, theme);
    },
    async execute(_toolCallId, params) {
      return logText(params.id, params.tail_lines);
    },
  });

  pi.registerTool({
    name: "bg_task_stop",
    label: "BG Stop",
    description: "Cancel a watcher or terminate a background process group. Nonblocking.",
    parameters: IdParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      activeSession = getCallbackOrigin(ctx);
      const result = formatStop(pi, params.id, ctx, getActiveSession);
      refreshBackgroundTasksNavigator(ctx);
      return text(result);
    },
  });

  pi.registerTool({
    name: "bg_task",
    label: "BG Task",
    description: "Action wrapper for background tasks: spawn, watch, list, status, log, or stop. Spawn/watch return immediately; do not poll in foreground.",
    parameters: ActionParams,
    renderResult(result: unknown, options: unknown, theme: unknown) {
      return renderBackgroundTaskLogDisplay(result, options, theme);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      activeSession = getCallbackOrigin(ctx);
      return actionText(pi, params, ctx, activeSession, getActiveSession);
    },
  });

  pi.registerTool({
    name: "bg_status",
    label: "BG Status",
    description: "Action wrapper for inspecting background tasks: list, status, log, or stop. Nonblocking.",
    parameters: StatusActionParams,
    renderResult(result: unknown, options: unknown, theme: unknown) {
      return renderBackgroundTaskLogDisplay(result, options, theme);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      activeSession = getCallbackOrigin(ctx);
      return actionText(pi, params, ctx, activeSession, getActiveSession);
    },
  });
}

export function text(textValue: string, details?: unknown) {
  return { content: [{ type: "text" as const, text: textValue }], details };
}

function actionText(
  pi: ExtensionAPI,
  params: Record<string, unknown>,
  ctx: ExtensionContext,
  callbackOrigin: BackgroundTaskCallbackOrigin,
  getActiveSession: () => BackgroundTaskCallbackOrigin | undefined,
) {
  if (params.action === "log" && params.id) {
    return logText(String(params.id), params.tail_lines as number | undefined);
  }
  return text(runAction(pi, params, ctx, callbackOrigin, getActiveSession));
}

function runAction(
  pi: ExtensionAPI,
  params: Record<string, unknown>,
  ctx: ExtensionContext,
  callbackOrigin: BackgroundTaskCallbackOrigin,
  getActiveSession: () => BackgroundTaskCallbackOrigin | undefined,
): string {
  switch (params.action) {
    case "spawn":
      return withNavigatorRefresh(ctx, formatLaunch(spawnTask(pi, params, ctx.cwd, callbackOrigin, getActiveSession)));
    case "watch":
      if (!params.success_when) return "Invalid parameters: watch requires success_when.";
      return withNavigatorRefresh(ctx, formatLaunch(startWatchTask(pi, params as never, ctx.cwd, callbackOrigin, getActiveSession)));
    case "list":
      return formatList(resolveList(params.status as string[] | undefined, params.limit as number | undefined));
    case "status":
      if (!params.id) return "Invalid parameters: status requires id.";
      return formatStatus(readMeta(String(params.id)) ?? undefined, String(params.id));
    case "log":
      if (!params.id) return "Invalid parameters: log requires id.";
      return formatLog(String(params.id), params.tail_lines as number | undefined);
    case "stop":
      if (!params.id) return "Invalid parameters: stop requires id.";
      return withNavigatorRefresh(ctx, formatStop(pi, String(params.id), ctx, getActiveSession));
    default:
      return `Unknown action: ${String(params.action)}`;
  }
}

function withNavigatorRefresh(ctx: ExtensionContext, result: string): string {
  refreshBackgroundTasksNavigator(ctx);
  return result;
}

function getCallbackOrigin(ctx: ExtensionContext): BackgroundTaskCallbackOrigin {
  let sessionId: string | undefined;
  try {
    sessionId = ctx.sessionManager?.getSessionId();
  } catch {
    sessionId = undefined;
  }
  return { cwd: ctx.cwd, sessionId };
}

function resolveList(statuses?: string[], limit?: number): BackgroundTaskMeta[] {
  let metas = listMetas();
  if (statuses && statuses.length > 0) {
    const wanted = new Set(statuses);
    metas = metas.filter((meta) => wanted.has(meta.status));
  }
  return metas.slice(0, Math.max(1, Math.min(limit ?? 20, 100)));
}

function formatLaunch(meta: BackgroundTaskMeta): string {
  const label = meta.name ? `${meta.name} (${meta.id})` : meta.id;
  return `Started background ${meta.kind} ${label}. Status: ${meta.status}. Log: ${meta.logPath}`;
}

function formatList(metas: BackgroundTaskMeta[]): string {
  if (metas.length === 0) return "No background tasks found.";
  return metas.map((meta) => {
    const age = formatDuration((meta.endedAt ?? Date.now()) - meta.startedAt);
    const label = meta.name ? `${meta.name} ` : "";
    return `${meta.id} ${label}${meta.kind} ${meta.status} ${age}`;
  }).join("\n");
}

function formatStatus(meta: BackgroundTaskMeta | undefined, id?: string): string {
  if (!meta) return `No background task found${id ? ` for id ${id}` : ""}.`;
  return JSON.stringify(meta, null, 2);
}

function formatLog(id: string, tailLines?: number): string {
  const meta = readMeta(id);
  if (!meta) return `No background task found for id ${id}.`;
  const log = readLog(meta.logPath, tailLines ?? 80);
  const prefix = log.truncated ? `[showing tail of ${meta.logPath}]\n` : `[${meta.logPath}]\n`;
  return prefix + (log.text || "(log is empty)");
}

function logText(id: string, tailLines?: number) {
  const body = formatLog(id, tailLines);
  if (!readMeta(id)) return text(body);
  return text(body, buildBackgroundTaskLogDisplayDetails(body));
}

export function buildBackgroundTaskLogDisplayDetails(body: string) {
  const fullLines = String(body ?? "").split(/\r?\n/);
  const head = fullLines[0] || "bg_task_log";
  const rest = fullLines.slice(1);
  const compactLines = nonEmptyPreviewLines(rest);
  return {
    kind: "background-task-log-display",
    head,
    fullLineCount: fullLines.length,
    compactLines,
    foldedLineCount: Math.max(0, rest.length - compactLines.length),
  };
}

export function renderBackgroundTaskLogDisplay(result: unknown, options: unknown = {}, theme: unknown = {}) {
  const fullText = resultTextContent(result);
  const details = ((result as { details?: unknown })?.details as ReturnType<typeof buildBackgroundTaskLogDisplayDetails> | undefined);
  if (!details || details.kind !== "background-task-log-display") return renderLines(fullText.split(/\r?\n/));
  const expanded = (options as { expanded?: boolean })?.expanded === true;
  const meta = `${details.fullLineCount} lines`;

  if (expanded) {
    return renderLines([
      `${themed(theme, "accent", "bg_task_log")} ${themed(theme, "dim", `· ${meta}`)}`,
      themed(theme, "dim", "Full displayed log. Click or collapse to fold."),
      "",
      ...fullText.split(/\r?\n/),
    ], "wrap");
  }

  const folded = details.foldedLineCount > 0
    ? themed(theme, "dim", `Folded ${details.foldedLineCount} display lines. Click or expand for full log. Model payload unchanged.`)
    : themed(theme, "dim", "Compact log. Expand for full display if needed.");
  return renderLines([
    `${themed(theme, "accent", "bg_task_log")} ${themed(theme, "dim", `· ${meta}`)}`,
    details.head,
    "",
    themed(theme, "dim", "preview"),
    ...details.compactLines,
    folded,
  ]);
}

function resultTextContent(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> })?.content;
  if (!Array.isArray(content)) return String(result ?? "");
  return content.map((part) => part.text ?? "").join("\n");
}

function nonEmptyPreviewLines(lines: string[]): string[] {
  const nonEmpty = lines.filter((line) => line.trim().length > 0).slice(0, 8);
  return nonEmpty.length ? nonEmpty : lines.slice(0, 3);
}

function themed(theme: unknown, color: string, value: string): string {
  const fg = (theme as { fg?: (color: string, text: string) => string })?.fg;
  return typeof fg === "function" ? fg(color, value) : value;
}

function renderLines(lines: string[], mode: "truncate" | "wrap" = "truncate") {
  return {
    render(width: number = 80) {
      return mode === "wrap"
        ? lines.flatMap((line) => wrapLineToVisibleWidth(line, width))
        : lines.map((line) => truncateToVisibleWidth(line, width));
    },
    invalidate() { /* stateless */ },
  };
}

function wrapLineToVisibleWidth(line: string, width: number): string[] {
  const str = String(line ?? "");
  const max = Math.max(1, Number(width) || 80);
  if (truncateToVisibleWidth(str, max) === str) return [str];
  const out: string[] = [];
  let current = "";
  let visible = 0;
  for (const char of str) {
    if (visible >= max) {
      out.push(current);
      current = "";
      visible = 0;
    }
    current += char;
    visible += 1;
  }
  out.push(current);
  return out;
}

function truncateToVisibleWidth(value: string, width: number): string {
  const max = Math.max(0, Math.floor(width || 0));
  return String(value ?? "").slice(0, max);
}

function formatStop(
  pi: ExtensionAPI,
  id: string,
  _ctx: ExtensionContext,
  getActiveSession?: () => BackgroundTaskCallbackOrigin | undefined,
): string {
  const meta = stopTask(pi, id, getActiveSession);
  if (!meta) return `No background task found for id ${id}.`;
  return `Background task ${id} is ${meta.status}.`;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m${rest.toString().padStart(2, "0")}s`;
}