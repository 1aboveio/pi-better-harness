import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { refreshBackgroundTasksNavigator } from "./navigator-provider.js";
import {
  classifyOwnership,
  formatLaunch,
  formatList,
  formatLog,
  formatMissingTask,
  formatMutationRefusal,
  formatStatus,
  formatStopResult,
  type OutputOptions,
} from "./output.js";
import { readOutputControls } from "./shared-log-utils.js";
import { cancelCallbackBatch, setCallbackBatchContext } from "./shared-callback-batcher.js";
import { inspectMeta, listMetasForOrigin, readMeta, writeMeta } from "./registry.js";
import { awaitFirstWatchCheck, FIRST_WATCH_CHECK_WAIT_MS, resumeRunningTask, spawnTask, startWatchTask, stopTask, type WatchTaskParams } from "./runtime.js";
import { runTaskMaintenance } from "./maintenance.js";
import { ForegroundSandboxBlockedError } from "./sandbox.js";
import type { BackgroundTaskCallbackOrigin, BackgroundTaskMeta } from "./types.js";
import { isTerminalStatus } from "./types.js";

export { formatLaunch } from "./output.js";

const JsonPathSchema = Type.String({
  pattern: "^\\$",
  description: "Root-prefixed JSON path, e.g. $.status, $.terminalFailure, or $.steps[0].status. Bare keys and wildcards are unsupported.",
});

const ConditionSchema = Type.Union([
  Type.Object({ type: Type.Literal("exit_code"), equals: Type.Number() }),
  Type.Object({ type: Type.Literal("stdout_contains"), value: Type.String() }),
  Type.Object({ type: Type.Literal("stderr_contains"), value: Type.String() }),
  Type.Object({ type: Type.Literal("json_path_equals"), path: JsonPathSchema, value: Type.Any() }),
  Type.Object({ type: Type.Literal("json_path_exists"), path: JsonPathSchema }),
]);

/**
 * String-to-string map declared with additionalProperties. Equivalent to
 * Type.Record(Type.String(), Type.String()) for accepted values; kept as the
 * plainer JSON Schema form.
 */
function StringMap(description: string) {
  return Type.Unsafe<Record<string, string>>({ type: "object", additionalProperties: { type: "string" }, description });
}

const SshSchema = Type.Object({
  host: Type.String({ description: "SSH host. Required when ssh is set." }),
  user: Type.Optional(Type.String({ description: "SSH user." })),
  port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_535, description: "SSH port." })),
  identity_file: Type.Optional(Type.String({ description: "SSH identity file path." })),
  jump: Type.Optional(Type.String({ description: "SSH jump host passed with -J." })),
  options: Type.Optional(StringMap("Additional SSH -o key/value options. Agent-safe defaults remain enforced.")),
}, {
  description: "Structured SSH connection for remote background tasks. Set ssh instead of wrapping command in a hand-written ssh command; command is the remote command, and Pi keeps durable local logs, status, callbacks, and remote stop semantics.",
});

const RemoteSchema = Type.Object({
  session: Type.Optional(Type.Union([Type.Literal("tmux"), Type.Literal("direct")], { description: "Remote session mode. SSH spawn defaults to durable tmux. Watch always uses direct one-shot polls. Explicit direct spawn has weaker stop semantics." })),
  install_tmux: Type.Optional(Type.Boolean({ description: "Allow SSH spawn to install tmux non-interactively when missing. Defaults true in tmux mode and is ignored for watch and direct spawn." })),
  workdir: Type.Optional(Type.String({ description: "Remote working directory for the spawned command." })),
}, {
  description: "Remote execution controls used with ssh. Omit session for SSH spawn to get the durable tmux default; SSH watch runs direct one-shot polls regardless of session and does not install tmux.",
});

// Structured intent (#325). Validated in code before launch (no uniqueItems/pattern: some providers reject them).
// Each field also admits null, which means "not declared": models send optional fields as explicit
// null, and readTaskIntent treats null exactly like an omitted field on every Pi version. Plain
// JSON Schema `anyOf` (Type.Unsafe), not Type.Union: Pi 0.82 converts a null to "" or [] through a
// TypeBox union, and a Null-first union reports a malformed array as "must be null".
const IntentFields = {
  operation_id: Type.Optional(Type.Unsafe<string | null>({ anyOf: [{ type: "null" }, { type: "string" }], description: "Optional stable id (letters, digits, . _ : / -; up to 64) for one logical operation. Reuse it when you retry with a changed command, scope, or timeout: when a later task with the same operation_id succeeds, earlier failures of that operation in this session are recovered." })),
  expected_exit_codes: Type.Optional(Type.Unsafe<number[] | null>({ anyOf: [{ type: "array", items: { type: "integer", minimum: 0, maximum: 255 }, minItems: 1, maxItems: 16 }, { type: "null" }], description: "Optional distinct non-zero exit codes that are intentional for this command (e.g. [1] for a no-match probe). 0 is allowed and ignored: exit 0 is already success. Declared before launch; recorded as expected failures, not incidents needing action. Signals and timeouts are never expected." })),
};

const CommandFields = {
  name: Type.Optional(Type.String({ description: "Human-readable task label." })),
  command: Type.Optional(Type.String({ description: "Shell command to run, or the remote command when ssh is set. Required unless shell:false with argv is used." })),
  argv: Type.Optional(Type.Array(Type.String(), { description: "Argument vector. Use with shell:false to avoid shell parsing." })),
  shell: Type.Optional(Type.Boolean({ description: "Run command through the package's bash-compatible shell. Default true." })),
  cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the current pi cwd." })),
  env: Type.Optional(StringMap("Extra environment variables.")),
  max_log_bytes: Type.Optional(Type.Number({ description: "Maximum retained raw-log bytes. Default 4194304 (4 MiB). Older output is compacted while the task runs." })),
  callback: Type.Optional(Type.Boolean({ description: "Queue a follow-up when the task reaches a terminal state. Default true." })),
  timeout_seconds: Type.Optional(Type.Number({ description: "Optional timeout in seconds. Command watchers default to 900 seconds when omitted; pass 0 to disable. Spawned processes have no default timeout." })),
  ssh: Type.Optional(SshSchema),
  remote: Type.Optional(RemoteSchema),
  ...IntentFields,
};

const SpawnParams = Type.Object(CommandFields);

const BlindChecksField = Type.Optional(Type.Integer({ minimum: 0, description: "Flag the watch as possibly blind after this many checks in a row exit 0, write stderr, and match neither success_when nor failure_when: one incident that needs action, with the latest stderr line. The watch keeps running; a check with no stderr or a matched condition recovers it. Default 3; 0 turns it off." }));

/**
 * How to write a watch check (#359): a check that swallows its own errors reports "pending"
 * forever. Shared by bg_task_watch and the bg_task wrapper.
 */
const WATCH_CHECK_GUIDANCE = "Waits up to 15s for the first check and returns its exit code with stdout and stderr tails; if it is still running, says so. "
  + "Write the check so a broken check is visible: do not end it with `exit 0` or `|| true`, because a check that exits non-zero is recorded and escalates. "
  + "Map an unknown or unparseable state to failure (exit non-zero), not to pending. Prefer structured output, e.g. `--format=json | jq -er '.status'`, over fragile format strings. "
  + "A check that exits 0 but writes stderr without matching a condition for blind_checks (default 3) checks in a row is flagged as needing action; if that stderr is expected, redirect it (2>/dev/null) or set blind_checks:0.";

const WatchParams = Type.Object({
  ...CommandFields,
  interval_seconds: Type.Optional(Type.Number({ description: "Polling interval in seconds. Default 30." })),
  success_when: ConditionSchema,
  failure_when: Type.Optional(ConditionSchema),
  blind_checks: BlindChecksField,
});

const CursorFields = {
  cursor: Type.Optional(Type.String({ description: "Caller-owned continuation cursor from a previous page. Replay returns the same page or a no-change/failure-only notice; nextCursor continues. Independent callers do not consume each other. Cursors are bound to the selected session scope." })),
  max_bytes: Type.Optional(Type.Number({ description: "Optional UTF-8 byte budget. Defaults: status/log/list 1 KiB, raw evidence 16 KiB. Larger explicit pages are allowed up to the shared hard cap (status 2 KiB, log/list 4 KiB, raw 64 KiB). Hard caps are OUTPUT_BUDGET_MAX_BYTES." })),
  maxBytes: Type.Optional(Type.Number({ description: "Deprecated alias for max_bytes. max_bytes wins when both are given." })),
  all: Type.Optional(Type.Boolean({ description: "Inspect, list, stop, or clear-by-id tasks across every session. Default false is current-session only. Unknown ownership is reported as a gap, never as missing or healthy; stop and clear refuse tasks outside the current session." })),
};

const IdParams = Type.Object({
  id: Type.String({ description: "Background task id." }),
  verbose: Type.Optional(Type.Boolean({ description: "Return raw metadata JSON with environment values omitted, bounded like raw evidence (16 KiB default, max_bytes up to 64 KiB, paged with cursor when larger). Default false returns the compact model-facing summary. Use true only for debugging or explicit recovery." })),
  ...CursorFields,
});
const HistoryField = {
  history: Type.Optional(Type.Boolean({ description: "If true, return an incident page that also lists failure history: expected failures and recovered or superseded incidents. Default output lists only failures that need action and counts the rest." })),
};
const StatusParams = Type.Object({
  id: Type.String({ description: "Background task id." }),
  verbose: Type.Optional(Type.Boolean({ description: "Return raw metadata JSON with environment values omitted, bounded like raw evidence (16 KiB default, max_bytes up to 64 KiB, paged with cursor when larger). Default false returns the compact model-facing summary. Use true only for debugging or explicit recovery." })),
  ...HistoryField,
  ...CursorFields,
});
const ListParams = Type.Object({
  status: Type.Optional(Type.Array(Type.String({ description: "Statuses to include." }))),
  limit: Type.Optional(Type.Number({ description: "Maximum tasks to show. Default 10, max 100." })),
  ...CursorFields,
});
const LogParams = Type.Object({
  id: Type.String({ description: "Background task id." }),
  lines: Type.Optional(Type.Number({ description: "Number of trailing display rows. Default 10 for compact model ingestion. Set 0 to page retained raw bytes from the oldest retained offset." })),
  tail_lines: Type.Optional(Type.Number({ description: "Deprecated alias for lines. lines wins when both are given." })),
  raw: Type.Optional(Type.Boolean({ description: "Page retained raw log bytes (16 KiB default, 64 KiB hard cap) instead of the compact excerpt. Capture and retention loss are disclosed; this is not a full-history archive." })),
  ...CursorFields,
});

const ActionParams = Type.Object({
  action: Type.Union([
    Type.Literal("spawn"),
    Type.Literal("watch"),
    Type.Literal("list"),
    Type.Literal("status"),
    Type.Literal("log"),
    Type.Literal("stop"),
    Type.Literal("clear"),
  ]),
  id: Type.Optional(Type.String()),
  status: Type.Optional(Type.Array(Type.String())),
  limit: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number({ description: "action:log trailing display rows (default 10; 0 pages raw bytes)." })),
  tail_lines: Type.Optional(Type.Number({ description: "Deprecated alias for lines." })),
  verbose: Type.Optional(Type.Boolean()),
  ...CommandFields,
  interval_seconds: Type.Optional(Type.Number()),
  success_when: Type.Optional(ConditionSchema),
  failure_when: Type.Optional(ConditionSchema),
  blind_checks: BlindChecksField,
  raw: Type.Optional(Type.Boolean()),
  ...HistoryField,
  ...CursorFields,
});

const StatusActionParams = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("status"), Type.Literal("log"), Type.Literal("stop"), Type.Literal("clear")]),
  id: Type.Optional(Type.String()),
  status: Type.Optional(Type.Array(Type.String())),
  limit: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number({ description: "action:log trailing display rows (default 10; 0 pages raw bytes)." })),
  tail_lines: Type.Optional(Type.Number({ description: "Deprecated alias for lines." })),
  verbose: Type.Optional(Type.Boolean()),
  raw: Type.Optional(Type.Boolean()),
  ...HistoryField,
  ...CursorFields,
});

const BACKGROUND_ORCHESTRATION_GUIDELINES = [
  "Use background tasks for genuinely long-running processes or repeated checks. Run short commands in the foreground.",
  "When a structured plan is active, keep it as the coordinator ledger: launch relevant background work early, continue unblocked foreground work without polling, and update the plan after inspecting each terminal result or failure.",
  "Do not treat launch as completion of the parent milestone; relevant background work must be terminal, inspected, and integrated before verification or completion.",
];

export function registerTools(pi: ExtensionAPI): void {
  let activeSession: BackgroundTaskCallbackOrigin | undefined;
  const getActiveSession = () => activeSession;

  pi.on("session_start", async (_event, ctx) => {
    setCallbackBatchContext(pi, ctx);
    activeSession = getCallbackOrigin(ctx);
    for (const meta of listMetasForOrigin(activeSession)) {
      if (meta.status === "running" || (meta.callback !== false && !meta.callbackSentAt && !meta.callbackSuppressedAt)) {
        resumeRunningTask(pi, meta, getActiveSession);
      }
    }
    runTaskMaintenance({ activeOrigin: activeSession });
  });
  pi.on("agent_start", (_event, ctx) => { setCallbackBatchContext(pi, ctx); });
  pi.on("agent_settled", (_event, ctx) => { setCallbackBatchContext(pi, ctx); });
  pi.on("session_before_switch", () => {
    activeSession = undefined;
    cancelCallbackBatch(pi);
  });
  pi.on("session_shutdown", () => {
    activeSession = undefined;
    cancelCallbackBatch(pi);
  });

  pi.registerTool({
    name: "bg_task_spawn",
    label: "BG Spawn",
    description: "Start a long-running background process and return immediately with its task id. For remote work, prefer structured ssh: pass ssh:{host,user} and put the remote command in command; spawn defaults to a remote tmux session with durable local logs and real remote stop. For short synchronous remote commands that should return output now, use remote_bash from pi-better-ssh. If tmux is missing, the preset attempts to install tmux non-interactively and fails closed with operator guidance when setup cannot proceed. Explicit remote.session=direct skips tmux, but direct mode has weaker stop semantics and may leave the remote process running. Never wait or poll in the foreground.",
    promptGuidelines: BACKGROUND_ORCHESTRATION_GUIDELINES,
    parameters: SpawnParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      activeSession = getCallbackOrigin(ctx);
      const launched = reportLaunch(() => spawnTask(pi, params, ctx.cwd, activeSession, getActiveSession));
      refreshBackgroundTasksNavigator(ctx);
      return text(launched);
    },
  });

  pi.registerTool({
    name: "bg_task_watch",
    label: "BG Watch",
    description: `Poll a command in the background until success_when, failure_when, or timeout matches. For remote work, prefer structured ssh: pass ssh:{host,user} and provide the remote command in command; each interval opens a direct one-shot SSH poll without tmux installation. For short synchronous remote commands that should return output now, use remote_bash from pi-better-ssh. Returns its task id once the first check finishes. ${WATCH_CHECK_GUIDANCE} Default timeout 900 seconds; pass timeout_seconds:0 to disable.`,
    promptGuidelines: BACKGROUND_ORCHESTRATION_GUIDELINES,
    parameters: WatchParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      activeSession = getCallbackOrigin(ctx);
      const launched = await launchWatch(pi, params, ctx.cwd, activeSession, getActiveSession, FIRST_WATCH_CHECK_WAIT_MS, signal);
      refreshBackgroundTasksNavigator(ctx);
      return text(launched);
    },
  });

  pi.registerTool({
    name: "bg_task_list",
    label: "BG List",
    description: "List durable background tasks as compact rows under a 1 KiB UTF-8 budget (10 entries default), newest first. Current-session only unless all:true. Nonblocking. Pass the returned nextCursor as cursor to page further (every task is reachable), or statusCursor to get a small no-change response or failure-only updates; a higher limit/max_bytes gives a larger explicit page.",
    parameters: ListParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      activeSession = getCallbackOrigin(ctx);
      return text(formatList(listOptions(params, activeSession)));
    },
  });

  pi.registerTool({
    name: "bg_task_status",
    label: "BG Status",
    description: "Inspect one background task. Default output is a compact model-facing summary (1 KiB UTF-8) with matched condition, exit/signal, stop error, and failure counts before progress. Current-session only unless all:true; unknown ownership is a gap, not missing or healthy. Pass verbose:true only when full raw metadata is explicitly needed. Environment values are omitted. A raw log nextCursor passed as cursor continues the raw log page; an incidentCursor pages incidents that need action; history:true lists failure history too. After a terminal callback, call this first and call bg_task_log only if the summary is insufficient.",
    parameters: StatusParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      activeSession = getCallbackOrigin(ctx);
      return text(formatStatus(inspectMeta(params.id), statusOptions(params, activeSession)));
    },
  });

  pi.registerTool({
    name: "bg_task_log",
    label: "BG Log",
    description: "Read a background task log. Default output is a compact 10-line terminal-aware tail for model ingestion (1 KiB UTF-8). Current-session only unless all:true. Pass lines for a bounded tail (tail_lines is a deprecated alias); lines:0 pages the retained raw log from the oldest retained offset (16 KiB pages, 64 KiB hard cap) with a caller-owned cursor. Capture and retention loss are disclosed; this is not a full-history archive. Nonblocking.",
    parameters: LogParams,
    renderResult(result: unknown, options: unknown, theme: unknown) {
      return renderBackgroundTaskLogDisplay(result, options, theme);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      activeSession = ctx ? getCallbackOrigin(ctx) : activeSession;
      return logText(params.id, logOptions(params, activeSession));
    },
  });

  pi.registerTool({
    name: "bg_task_stop",
    label: "BG Stop",
    description: "Cancel a watcher or terminate a background task. Only a task owned by the current session stops; a foreign-session or unverifiable task is refused unless all:true. For a tmux-backed SSH task, stop kills its remote tmux session before marking it cancelled. Direct SSH stop only tears down the local client and may leave the remote process running.",
    parameters: IdParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      activeSession = getCallbackOrigin(ctx);
      const result = await formatStop(pi, params.id, ctx, getActiveSession, statusOptions(params, activeSession));
      refreshBackgroundTasksNavigator(ctx);
      return text(result);
    },
  });

  pi.registerTool({
    name: "bg_task",
    label: "BG Task",
    description: "Action wrapper for background tasks: spawn, watch, list, status, log, stop, or clear. For remote work, prefer structured ssh: pass ssh:{host,user} and provide the remote command in command. For short synchronous remote commands that should return output now, use remote_bash from pi-better-ssh. SSH spawn defaults to durable tmux; SSH watches use direct one-shot polls without tmux installation; remote.session=direct is a weaker-stop spawn escape hatch. Spawn returns immediately; do not poll in foreground. For action:watch: " + WATCH_CHECK_GUIDANCE + " For action:status, default compact output and use verbose:true only for full metadata. For action:log, default compact tail and use lines:0 to page retained raw bytes. Standalone tools and these wrappers share the same output assembler. List/status/log default to the current session; pass all:true to override. Stop and clear change only current-session tasks: clear dismisses every owned terminal task, or one task with id (all:true allows another session's task by id).",
    promptGuidelines: BACKGROUND_ORCHESTRATION_GUIDELINES,
    parameters: ActionParams,
    renderResult(result: unknown, options: unknown, theme: unknown) {
      return renderBackgroundTaskLogDisplay(result, options, theme);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      activeSession = getCallbackOrigin(ctx);
      return actionText(pi, params, ctx, activeSession, getActiveSession, signal);
    },
  });

  pi.registerTool({
    name: "bg_status",
    label: "BG Status",
    description: "Action wrapper for inspecting background tasks: list, status, log, stop, or clear. Nonblocking. Status is compact by default; log returns a compact tail by default. Use verbose:true or lines:0 only for explicit full-data recovery. Shares the same output assembler as the standalone tools. Current-session default; pass all:true to override. Stop and clear change only current-session tasks (clear with id and all:true for another session's task).",
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

/** Requested byte budget: canonical `max_bytes`, else the deprecated `maxBytes` alias (#321). */
function requestedMaxBytes(params: Record<string, unknown>): number | undefined {
  const value = readOutputControls(params).maxBytes;
  return typeof value === "number" ? value : undefined;
}

function statusOptions(params: Record<string, unknown>, origin?: BackgroundTaskCallbackOrigin): OutputOptions {
  return {
    verbose: params.verbose === true,
    history: params.history === true,
    cursor: typeof params.cursor === "string" ? params.cursor : undefined,
    maxBytes: requestedMaxBytes(params),
    all: params.all === true,
    ...scopeOptions(origin),
  };
}

function logOptions(params: Record<string, unknown>, origin?: BackgroundTaskCallbackOrigin): OutputOptions {
  // Canonical `lines`, else the deprecated `tail_lines` alias (#321).
  const lines = readOutputControls(params).lines;
  return {
    tailLines: typeof lines === "number" ? lines : undefined,
    raw: params.raw === true,
    cursor: typeof params.cursor === "string" ? params.cursor : undefined,
    maxBytes: requestedMaxBytes(params),
    all: params.all === true,
    ...scopeOptions(origin),
  };
}

function listOptions(params: Record<string, unknown>, origin?: BackgroundTaskCallbackOrigin): OutputOptions {
  return {
    statuses: params.status as string[] | undefined,
    limit: typeof params.limit === "number" ? params.limit : undefined,
    cursor: typeof params.cursor === "string" ? params.cursor : undefined,
    maxBytes: requestedMaxBytes(params),
    all: params.all === true,
    ...scopeOptions(origin),
  };
}

async function actionText(
  pi: ExtensionAPI,
  params: Record<string, unknown>,
  ctx: ExtensionContext,
  callbackOrigin: BackgroundTaskCallbackOrigin,
  getActiveSession: () => BackgroundTaskCallbackOrigin | undefined,
  signal?: AbortSignal,
) {
  if (params.action === "log" && params.id) {
    return logText(String(params.id), logOptions(params, callbackOrigin));
  }
  return text(await runAction(pi, params, ctx, callbackOrigin, getActiveSession, signal));
}

async function runAction(
  pi: ExtensionAPI,
  params: Record<string, unknown>,
  ctx: ExtensionContext,
  callbackOrigin: BackgroundTaskCallbackOrigin,
  getActiveSession: () => BackgroundTaskCallbackOrigin | undefined,
  signal?: AbortSignal,
): Promise<string> {
  switch (params.action) {
    case "spawn":
      return withNavigatorRefresh(ctx, reportLaunch(() => spawnTask(pi, params, ctx.cwd, callbackOrigin, getActiveSession)));
    case "watch":
      if (!params.success_when) return "Invalid parameters: watch requires success_when.";
      return withNavigatorRefresh(ctx, await launchWatch(pi, params as unknown as WatchTaskParams, ctx.cwd, callbackOrigin, getActiveSession, FIRST_WATCH_CHECK_WAIT_MS, signal));
    case "list":
      return formatList(listOptions(params, callbackOrigin));
    case "status":
      if (!params.id) return "Invalid parameters: status requires id.";
      return formatStatus(inspectMeta(String(params.id)), statusOptions(params, callbackOrigin));
    case "log":
      if (!params.id) return "Invalid parameters: log requires id.";
      return formatLog(String(params.id), logOptions(params, callbackOrigin));
    case "stop":
      if (!params.id) return "Invalid parameters: stop requires id.";
      return withNavigatorRefresh(ctx, await formatStop(pi, String(params.id), ctx, getActiveSession, statusOptions(params, callbackOrigin)));
    case "clear":
      return withNavigatorRefresh(ctx, formatClear(params, statusOptions(params, callbackOrigin)));
    default:
      return `Unknown action: ${String(params.action)}`;
  }
}

/**
 * Report a launch, or why the foreground sandbox refused it.
 *
 * A blocked launch is an operator-facing answer, not a tool crash: the task was
 * never started, and nothing about it is retried unconfined.
 */
function reportLaunch(launch: () => BackgroundTaskMeta): string {
  try {
    return formatLaunch(launch());
  } catch (error) {
    if (error instanceof ForegroundSandboxBlockedError) return error.message;
    throw error;
  }
}

/**
 * Start a watch and wait, bounded by `waitMs`, for its first check, so the launch result
 * shows what the check really prints (#359). Local and SSH watches share this path.
 */
export async function launchWatch(
  pi: ExtensionAPI,
  params: WatchTaskParams,
  cwd: string,
  callbackOrigin: BackgroundTaskCallbackOrigin | undefined,
  getActiveSession: () => BackgroundTaskCallbackOrigin | undefined,
  waitMs = FIRST_WATCH_CHECK_WAIT_MS,
  signal?: AbortSignal,
): Promise<string> {
  let meta: BackgroundTaskMeta;
  try {
    meta = startWatchTask(pi, params, cwd, callbackOrigin, getActiveSession);
  } catch (error) {
    if (error instanceof ForegroundSandboxBlockedError) return error.message;
    throw error;
  }
  // Esc (the tool's abort signal) ends the wait at once; the watch itself keeps running.
  const outcome = await awaitFirstWatchCheck(meta.id, waitMs, signal);
  const latest = readMeta(meta.id) ?? meta;
  if (outcome && !("pending" in outcome && isTerminalStatus(latest.status))) return formatLaunch(latest, outcome);
  return formatLaunch(latest);
}

function withNavigatorRefresh(ctx: ExtensionContext, result: string): string {
  refreshBackgroundTasksNavigator(ctx);
  return result;
}

/** Origins whose session identity could not be read (the host threw). */
const unavailableSessionOrigins = new WeakSet<BackgroundTaskCallbackOrigin>();

function getCallbackOrigin(ctx: ExtensionContext | undefined): BackgroundTaskCallbackOrigin {
  let sessionId: string | undefined;
  let unavailable = false;
  try {
    sessionId = ctx?.sessionManager?.getSessionId();
  } catch {
    sessionId = undefined;
    unavailable = true;
  }
  const origin = { cwd: ctx?.cwd ?? "", sessionId };
  if (unavailable) unavailableSessionOrigins.add(origin);
  return origin;
}

function scopeOptions(origin?: BackgroundTaskCallbackOrigin): Pick<OutputOptions, "origin" | "sessionUnavailable"> {
  return {
    origin,
    ...(origin && unavailableSessionOrigins.has(origin) ? { sessionUnavailable: true } : {}),
  };
}

function logText(id: string, options: OutputOptions) {
  const body = formatLog(id, options);
  if (!inspectMeta(id).meta) return text(body);
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
    ? themed(theme, "dim", `Folded ${details.foldedLineCount} display lines. Click or expand for the requested log payload.`)
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
  if (Array.isArray(content)) return content.map((part) => part.text ?? "").join("\n");
  return String(result ?? "");
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

async function formatStop(
  pi: ExtensionAPI,
  id: string,
  _ctx: ExtensionContext,
  getActiveSession?: () => BackgroundTaskCallbackOrigin | undefined,
  options: OutputOptions = {},
): Promise<string> {
  const existing = inspectMeta(id);
  if (!existing.meta && !existing.found) return formatStopResult(existing, options);
  if (!existing.meta) return formatMissingTask(existing, options);
  // Same ownership rule as reads (#322): only a task owned by the current
  // session stops unless the caller passes all:true.
  const ownership = classifyOwnership(existing.meta, options);
  if (ownership !== "allow") return formatMutationRefusal(id, ownership, "stop", options);
  const meta = await stopTask(pi, id, getActiveSession);
  if (!meta) return formatStopResult({ id, found: existing.found, readable: false, error: existing.error }, options);
  return formatStopResult({ id: meta.id, meta, found: true, readable: true }, options);
}

/**
 * Dismiss terminal tasks with the same ownership rule as reads (#322). Bulk
 * clear never crosses the current session scope (stricter than reads, which
 * accept all:true for a list); clear with an id honours all:true like a read
 * by id. Tasks whose ownership cannot be verified are counted, not dismissed.
 */
function formatClear(params: Record<string, unknown>, options: OutputOptions): string {
  if (typeof params.id === "string" && params.id) return formatClearById(params.id, options);
  const statuses = params.status as string[] | undefined;
  const wanted = statuses && statuses.length > 0 ? new Set(statuses) : undefined;
  const statusLabel = wanted ? ` matching ${Array.from(wanted).join(",")}` : "";
  const origin = options.origin;
  if (!origin || options.sessionUnavailable) {
    return "Dismissed 0 terminal background tasks: the current session identity is unavailable, so no task's ownership can be verified. Clear one task with id and all:true.";
  }
  const scoped: OutputOptions = { ...options, all: false };
  const now = Date.now();
  let cleared = 0;
  let unverified = 0;
  for (const meta of listMetasForOrigin(origin)) {
    if (meta.dismissedAt !== undefined) continue;
    if (!isTerminalStatus(meta.status)) continue;
    if (wanted && !wanted.has(meta.status)) continue;
    if (classifyOwnership(meta, scoped) !== "allow") {
      unverified += 1;
      continue;
    }
    meta.dismissedAt = now;
    writeMeta(meta);
    cleared += 1;
  }
  const skipped = unverified
    ? ` ${unverified} terminal task${unverified === 1 ? "" : "s"} with unverifiable ownership ${unverified === 1 ? "was" : "were"} not dismissed; clear one with id and all:true.`
    : "";
  return `Dismissed ${cleared} terminal background task${cleared === 1 ? "" : "s"}${statusLabel}.${skipped}`;
}

function formatClearById(id: string, options: OutputOptions): string {
  const inspection = inspectMeta(id);
  if (!inspection.meta) return formatMissingTask(inspection, options);
  const meta = inspection.meta;
  const ownership = classifyOwnership(meta, options);
  if (ownership !== "allow") return formatMutationRefusal(id, ownership, "clear", options);
  if (!isTerminalStatus(meta.status)) return `Background task ${id} is ${meta.status}; only terminal tasks can be dismissed. Stop it first.`;
  if (meta.dismissedAt !== undefined) return `Background task ${id} was already dismissed.`;
  meta.dismissedAt = Date.now();
  writeMeta(meta);
  return `Dismissed terminal background task ${id} (${meta.status}).`;
}
