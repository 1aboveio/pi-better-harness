import { statSync } from "node:fs";
import {
  activeFailures,
  failureRevision,
  formatFailureLines,
  formatFailureSummary,
  formatIncidentSummary,
  isIncidentCursor,
  pageFailureIncidents,
  readFailureState,
  type FailureState,
} from "./shared-failure-observations.js";
import {
  assemblePriorityEnvelope,
  clampBudgetBytes,
  cursorKind,
  formatUnchangedEvidence,
  inspectStatusRevision,
  pageRows,
  pageVerbatimText,
  revisionOf,
  sliceUtf8Bytes,
  utf8ByteLength,
  OUTPUT_BUDGET_BYTES,
  OUTPUT_BUDGET_MAX_BYTES,
  OUTPUT_PAGE_DEFAULTS,
  type EnvelopeSections,
  type EvidenceGap,
  type VerbatimPage,
} from "./shared-log-utils.js";
import { failurePath } from "./failures.js";
import { captureGapsFor, pageTaskLog, readLog, type LogRead } from "./logs.js";
import { belongsToOrigin, inspectMeta, listTaskRecords, originOf, type MetaInspection } from "./registry.js";
import type { BackgroundTaskCallbackOrigin, BackgroundTaskMeta, Condition } from "./types.js";

/**
 * Issue #312 consumer budgets. Defaults follow OUTPUT-POLICY / shared
 * `OUTPUT_BUDGET_BYTES`. Explicit larger pages clamp to `OUTPUT_BUDGET_MAX_BYTES`
 * (hard caps). Totals are UTF-8 bytes of the whole model-facing `content`,
 * including headers, failures, gaps, and continuation.
 */
export const BACKGROUND_OUTPUT_BUDGET_BYTES = {
  status: OUTPUT_BUDGET_BYTES.status,
  log: OUTPUT_BUDGET_BYTES.log,
  list: OUTPUT_BUDGET_BYTES.list,
  rawPage: OUTPUT_BUDGET_BYTES.rawPage,
} as const;

export const BACKGROUND_OUTPUT_HARD_CAP_BYTES = {
  status: OUTPUT_BUDGET_MAX_BYTES.status,
  log: OUTPUT_BUDGET_MAX_BYTES.log,
  list: OUTPUT_BUDGET_MAX_BYTES.list,
  rawPage: OUTPUT_BUDGET_MAX_BYTES.rawPage,
} as const;

export const DEFAULT_LOG_TAIL_ROWS = OUTPUT_PAGE_DEFAULTS.logLines;
export const DEFAULT_LIST_ENTRIES = OUTPUT_PAGE_DEFAULTS.listEntries;
const MAX_LIST_ENTRIES = 100;
const STATUS_EXCERPT_ROWS = 3;

export type BackgroundOutputSurface = keyof typeof BACKGROUND_OUTPUT_BUDGET_BYTES;

export interface OutputOptions {
  cursor?: string;
  maxBytes?: number;
  verbose?: boolean;
  tailLines?: number;
  raw?: boolean;
  statuses?: string[];
  limit?: number;
  origin?: BackgroundTaskCallbackOrigin;
  all?: boolean;
  /**
   * The current session's identity could not be read. Without `all`, every
   * task's ownership is then unverifiable: reads report an ownership gap and
   * lists hide rows while counting them.
   */
  sessionUnavailable?: boolean;
}

export function backgroundBudget(surface: BackgroundOutputSurface, requested?: number): number {
  const fallback = BACKGROUND_OUTPUT_BUDGET_BYTES[surface];
  const hard = BACKGROUND_OUTPUT_HARD_CAP_BYTES[surface];
  return Math.min(clampBudgetBytes(requested, fallback), hard);
}

function oneLine(value: unknown, maxLength: number): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const single = String(raw ?? "").replace(/\s+/g, " ").trim();
  return single.length <= maxLength ? single : `${single.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m${rest.toString().padStart(2, "0")}s`;
}

function stringifyObserved(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return oneLine(value, 200);
  try {
    return oneLine(JSON.stringify(value), 200);
  } catch {
    return oneLine(String(value), 200);
  }
}

/** Cursor scope: pagination and revision cursors never cross session scopes. */
function scopeKey(options: OutputOptions): string {
  if (options.all) return "all";
  if (options.sessionUnavailable) return "unavailable";
  const origin = options.origin;
  if (!origin) return "none";
  return revisionOf([origin.cwd, origin.sessionId ?? ""]);
}

function taskGaps(meta: BackgroundTaskMeta): EvidenceGap[] {
  const gaps: EvidenceGap[] = [];
  if (meta.logDiscardedBytes) {
    gaps.push({
      kind: "retention",
      bytes: meta.logDiscardedBytes,
      detail: `${meta.logRetentionEvents ?? 1} compaction(s); discarded bytes are not recoverable`,
    });
  }
  for (const gap of captureGapsFor(meta)) {
    gaps.push({ kind: "capture", bytes: gap.bytes, detail: gap.detail });
  }
  return gaps;
}

function failureStateFor(id: string): FailureState {
  return readFailureState(failurePath(id));
}

/**
 * Failure section computed for the exact bytes the envelope grants it: whole
 * incident rows when they fit, otherwise a count line (total / shown /
 * omitted) with an incident cursor that resumes at the first byte not shown.
 */
function incidentSection(id: string, options: OutputOptions, state = failureStateFor(id)): ((budget: number) => string | undefined) | undefined {
  if (activeFailures(state).length === 0) return undefined;
  const resource = `incidents:${scopeKey(options)}:${id}`;
  return (budget) => formatIncidentSummary(state, {
    maxBytes: budget,
    resource,
    retrieval: `pass as cursor to bg_task_status id=${id}`,
  }).text || undefined;
}

function assembleIncidentPage(meta: BackgroundTaskMeta, options: OutputOptions): string {
  const state = failureStateFor(meta.id);
  const resource = `incidents:${scopeKey(options)}:${meta.id}`;
  const total = activeFailures(state).length;
  return assembleBackgroundContent({
    surface: "status",
    maxBytes: options.maxBytes,
    sections: {
      identity: `${identityLine(meta)} Incident page of ${total} active failure observation${total === 1 ? "" : "s"}.`,
      decision: formatDecision(meta),
    },
    verbatim: (budget) => {
      const page = pageFailureIncidents(state, { cursor: options.cursor, maxBytes: budget, resource });
      return {
        text: page.text || (page.total === 0 ? "No active failure observations." : ""),
        hasMore: page.hasMore,
        cursor: page.cursor,
        nextCursor: page.nextCursor,
        omittedBytes: 0,
        omittedRows: page.omitted,
        reset: page.reset,
      };
    },
  });
}

function formatCondition(condition: Condition, observed: unknown): string {
  switch (condition.type) {
    case "exit_code":
      return `Condition matched: exit_code = ${condition.equals}\nobserved: ${stringifyObserved(observed ?? condition.equals)}`;
    case "json_path_equals":
      return `Condition matched: ${condition.path} = ${stringifyObserved(condition.value)}\nobserved: ${stringifyObserved(observed)}`;
    case "json_path_exists":
      return `Condition matched: ${condition.path} exists\nobserved: ${stringifyObserved(observed)}`;
    case "stdout_contains":
      return `Condition matched: stdout_contains ${JSON.stringify(condition.value)}`;
    case "stderr_contains":
      return `Condition matched: stderr_contains ${JSON.stringify(condition.value)}`;
  }
}

function resultFields(meta: BackgroundTaskMeta): {
  reason?: string;
  matchedCondition?: Condition;
  matchedValue?: unknown;
} {
  if (!meta.result || typeof meta.result !== "object") return {};
  return meta.result as { reason?: string; matchedCondition?: Condition; matchedValue?: unknown };
}

/** Decision facts: stop error, matched condition and observed value, exit/signal, recorded error. */
function formatDecision(meta: BackgroundTaskMeta): string | undefined {
  const lines: string[] = [];
  if (meta.status === "running" && meta.stopError) {
    lines.push(`stop failed: ${oneLine(meta.stopError, 300)}`);
    lines.push("The task may still be executing.");
  }
  const result = resultFields(meta);
  if (result.matchedCondition) {
    lines.push(formatCondition(result.matchedCondition, result.matchedValue));
  }
  if (meta.lastExitCode !== undefined || meta.lastSignal) {
    lines.push(`exit=${meta.lastExitCode ?? "null"}${meta.lastSignal ? ` signal=${meta.lastSignal}` : ""}`);
  }
  if (result.reason && !result.matchedCondition) lines.push(oneLine(result.reason, 240));
  if (meta.error && meta.error !== meta.stopError && meta.error !== result.reason) {
    lines.push(`error: ${oneLine(meta.error, 300)}`);
  }
  return lines.length ? lines.join("\n") : undefined;
}

/**
 * Completion-callback facts (no env/command dump). Incident rows are passed
 * whole so the batch can count exactly which it shows.
 */
export function formatCallbackFacts(meta: BackgroundTaskMeta): {
  outcome: string;
  failureRows?: string[];
  decision?: string;
  incidentCount?: number;
} {
  const state = failureStateFor(meta.id);
  const rows = formatFailureLines(state);
  const gapLines = [
    meta.logDiscardedBytes ? `retention discarded ${meta.logDiscardedBytes} bytes; not recoverable` : undefined,
    meta.captureDiscardedBytes ? `capture overflow discarded ${meta.captureDiscardedBytes} bytes; not full history` : undefined,
  ].filter((line): line is string => Boolean(line));
  const decision = [formatDecision(meta), ...gapLines].filter(Boolean).join("\n") || undefined;
  return {
    outcome: meta.status,
    ...(rows.length ? { failureRows: rows, incidentCount: rows.length } : {}),
    decision,
  };
}

function formatDiagnostics(meta: BackgroundTaskMeta, extra: string[] = []): string | undefined {
  const lines = [...extra];
  if (meta.ssh) lines.push(`remote: ${meta.ssh.target}`);
  if (meta.remote?.session) lines.push(`remote mode: ${meta.remote.session}`);
  if (meta.remote?.sessionName) lines.push(`remote session: ${meta.remote.sessionName}`);
  if (meta.remote?.bootstrapMessage) lines.push(`remote setup: ${oneLine(meta.remote.bootstrapMessage, 180)}`);
  if (meta.remote?.warning) lines.push(`warning: ${oneLine(meta.remote.warning, 180)}`);
  if (meta.remote?.stopMessage) lines.push(`remote stop: ${oneLine(meta.remote.stopMessage, 180)}`);
  if (meta.logDiscardedBytes) {
    lines.push(`retention discarded ${meta.logDiscardedBytes} bytes in ${meta.logRetentionEvents ?? 1} compaction(s); not recoverable`);
  }
  if (meta.captureDiscardedBytes) {
    lines.push(`capture overflow discarded ${meta.captureDiscardedBytes} bytes in ${meta.captureOverflowEvents ?? 1} event(s); not full history`);
  }
  return lines.length ? lines.join("\n") : undefined;
}

function formatProgress(meta: BackgroundTaskMeta): string | undefined {
  const lines = [`kind: ${meta.kind}`];
  if (meta.name) lines.push(`name: ${oneLine(meta.name, 80)}`);
  lines.push(`elapsed: ${formatDuration((meta.endedAt ?? Date.now()) - meta.startedAt)}`);
  if (meta.deadlineAt && meta.status === "running") {
    lines.push(`deadline: ${formatDuration(meta.deadlineAt - Date.now())} left`);
  }
  if (meta.lastCheckedAt) lines.push(`last check: ${formatDuration(Date.now() - meta.lastCheckedAt)} ago`);
  if (meta.lastState !== undefined) lines.push(`last state: ${oneLine(meta.lastState, 120)}`);
  return lines.join("\n");
}

function identityLine(meta: BackgroundTaskMeta): string {
  const stop = meta.status === "running" && meta.stopError ? " · stop failed" : "";
  return `Background task ${meta.id} is ${meta.status}${stop}.`;
}

/** Lifecycle, result, and retained-log facts. A deleted or rewritten log is a change. */
function contentRevision(meta: BackgroundTaskMeta): string {
  let log: unknown;
  try {
    const stats = statSync(meta.logPath);
    log = [stats.dev, stats.ino, stats.size, Math.trunc(stats.mtimeMs)];
  } catch (error) {
    log = ["unreadable", (error as NodeJS.ErrnoException).code ?? String(error)];
  }
  return revisionOf([
    meta.status,
    meta.endedAt ?? null,
    meta.lastCheckedAt ?? null,
    meta.lastProgressAt ?? null,
    meta.lastExitCode ?? null,
    meta.lastSignal ?? null,
    meta.error ?? null,
    meta.stopError ?? null,
    meta.logGeneration ?? 0,
    meta.logDiscardedBytes ?? 0,
    meta.captureDiscardedBytes ?? 0,
    meta.result ?? null,
    meta.lastState ?? null,
    meta.remote?.bootstrapStatus ?? null,
    meta.remote?.stopMessage ?? null,
    log,
  ]);
}

export function assembleBackgroundContent(input: {
  surface: BackgroundOutputSurface;
  maxBytes?: number;
  sections?: EnvelopeSections;
  verbatim?: (budget: number) => VerbatimPage;
  gaps?: EvidenceGap[];
  statusCursor?: string;
}): string {
  const maxBytes = backgroundBudget(input.surface, input.maxBytes);
  return assemblePriorityEnvelope({
    maxBytes,
    sections: input.sections,
    verbatim: input.verbatim,
    // Explicit evidence pages always advance: half the page is held for bytes.
    verbatimReserve: input.surface === "rawPage" ? Math.floor(maxBytes / 2) : undefined,
    gaps: input.gaps,
    statusCursor: input.statusCursor,
    // ADR 0006 surface contract: background summaries lead with failures.
    failureFirst: true,
  }).text;
}

export function formatMissingTask(inspection: MetaInspection, options: OutputOptions = {}): string {
  if (inspection.found || inspection.error) {
    return assembleBackgroundContent({
      surface: "status",
      maxBytes: options.maxBytes,
      sections: {
        identity: `Background task ${inspection.id} metadata is unreadable.`,
        diagnostics: [
          inspection.error ?? "metadata could not be read",
          "Cannot treat this as an empty or nonexistent task.",
        ].join("\n"),
      },
      gaps: [{ kind: "read", detail: inspection.error ?? "unreadable metadata" }],
    });
  }
  return assembleBackgroundContent({
    surface: "status",
    maxBytes: options.maxBytes,
    sections: {
      identity: `No background task found for id ${inspection.id}.`,
    },
  });
}

function formatOwnershipGap(id: string, kind: "foreign" | "unknown", options: OutputOptions): string {
  const detail = kind === "foreign"
    ? "This task belongs to another session. Pass all:true to inspect it."
    : options.sessionUnavailable
      ? "The current session identity is unavailable, so ownership cannot be verified. Cannot treat this as nonexistent or healthy. Pass all:true to inspect."
      : "Task ownership is unavailable or unreadable. Cannot treat this as nonexistent or healthy. Pass all:true to inspect.";
  return assembleBackgroundContent({
    surface: "status",
    maxBytes: options.maxBytes,
    sections: {
      identity: `Background task ${id} is outside the current session scope.`,
      diagnostics: detail,
    },
    gaps: [{ kind: "read", detail: kind === "foreign" ? "foreign-session" : "ownership-unavailable" }],
  });
}

type Ownership = "allow" | "foreign" | "unknown";

function classifyOwnership(meta: BackgroundTaskMeta, options: OutputOptions): Ownership {
  if (options.all === true) return "allow";
  if (options.sessionUnavailable) return "unknown";
  const origin = options.origin;
  if (!origin) return "allow";
  if (belongsToOrigin(meta, origin)) return "allow";
  const taskOrigin = originOf(meta);
  if (!meta.callbackOrigin || (!taskOrigin.sessionId && origin.sessionId)) return "unknown";
  return "foreign";
}

function asInspection(inspection: MetaInspection | BackgroundTaskMeta | undefined, idOrOptions?: string | OutputOptions): MetaInspection {
  if (!inspection) {
    return { id: typeof idOrOptions === "string" ? idOrOptions : "", found: false, readable: false };
  }
  if (typeof inspection === "object" && ("found" in inspection || "readable" in inspection)) {
    return inspection as MetaInspection;
  }
  const meta = inspection as BackgroundTaskMeta;
  return { id: meta.id, meta, found: true, readable: true };
}

export function formatLaunch(meta: BackgroundTaskMeta): string {
  const label = meta.name ? `${meta.name} (${meta.id})` : meta.id;
  const remoteLines = [
    ...(meta.ssh ? [`Remote: ${meta.ssh.target}${meta.remote?.session ? ` mode=${meta.remote.session}` : ""}${meta.remote?.sessionName ? ` session=${meta.remote.sessionName}` : ""}.`] : []),
    ...(meta.remote?.bootstrapMessage ? [`Remote setup: ${meta.remote.bootstrapMessage}`] : []),
    ...(meta.remote?.warning ? [`Warning: ${meta.remote.warning}`] : []),
  ];
  return assembleBackgroundContent({
    surface: "status",
    sections: {
      identity: `Started background ${meta.kind} ${label}. Status: ${meta.status}.`,
      failure: incidentSection(meta.id, {}),
      decision: formatDecision(meta),
      diagnostics: remoteLines.join("\n") || undefined,
      progress: `Log: ${meta.logPath}`,
    },
    gaps: taskGaps(meta),
  });
}

function redactedVerbose(meta: BackgroundTaskMeta): unknown {
  const { env, ...rest } = meta;
  const state = failureStateFor(meta.id);
  const observations = Object.values(state.observations);
  const body = {
    ...rest,
    ...(env ? { env: { omitted: true, keyCount: Object.keys(env).length } } : {}),
  };
  if (!observations.length) return body;
  return {
    failureSummary: formatFailureSummary(state),
    failureJournal: failurePath(meta.id),
    failureObservations: observations.map((observation) => ({
      ...observation,
      attentionDeliveredAt: state.delivered[observation.id],
    })),
    ...body,
  };
}

/**
 * Verbose metadata is explicit evidence under the raw-page budget. When the
 * whole document fits it is returned as plain JSON; otherwise it is paged
 * with a caller cursor like any other retained evidence.
 */
function formatVerbose(meta: BackgroundTaskMeta, options: OutputOptions): string {
  const json = JSON.stringify(redactedVerbose(meta), null, 2);
  const resource = `verbose:${scopeKey(options)}:${meta.id}`;
  if (!options.cursor && utf8ByteLength(json) <= backgroundBudget("rawPage", options.maxBytes)) return json;
  return assembleBackgroundContent({
    surface: "rawPage",
    maxBytes: options.maxBytes,
    sections: {
      identity: `Background task ${meta.id} metadata (environment values omitted).`,
    },
    verbatim: (budget) => pageVerbatimText(json, { cursor: options.cursor, maxBytes: budget, resource }),
  });
}

/** Retained raw log pages for this task in this scope. */
function rawLogPage(meta: BackgroundTaskMeta, options: OutputOptions, cursor: string | undefined, budget: number): VerbatimPage {
  return pageTaskLog(meta, { cursor, maxBytes: budget, resource: `log:${scopeKey(options)}:${meta.id}` });
}

/**
 * A compact newest-rows excerpt. When earlier rows, older bytes, or a long
 * line's prefix are not shown, the page says so and its cursor starts a raw
 * page at the oldest retained byte (bg_task_log), so nothing is hidden.
 */
function excerptPage(meta: BackgroundTaskMeta, options: OutputOptions, log: LogRead, budget: number): VerbatimPage {
  const text = log.text || "(log is empty)";
  const encoded = utf8ByteLength(text);
  let body = text;
  if (encoded > budget) {
    const slice = sliceUtf8Bytes(text, encoded - budget, budget, false);
    body = slice.bytes <= budget ? slice.text : "";
    if (slice.startByte > 0) {
      const newline = body.indexOf("\n");
      if (newline >= 0 && newline < body.length - 1) body = body.slice(newline + 1);
    }
  }
  const shownBytes = log.text ? utf8ByteLength(body) : 0;
  const omittedSomething = Boolean(log.truncated) || shownBytes < utf8ByteLength(log.text);
  if (!omittedSomething) return { text: body, hasMore: false, omittedBytes: 0 };
  const start = rawLogPage(meta, options, undefined, 0);
  const rows = log.omittedRows ? `; ${log.omittedRows} earlier display row(s)` : "";
  return {
    text: body,
    hasMore: true,
    omittedBytes: Math.max(0, (log.totalBytes ?? 0) - shownBytes),
    nextCursor: start.nextCursor,
    via: `pass to bg_task_log id=${meta.id}: raw pages from the oldest retained byte${rows}`,
  };
}

export function formatStatus(
  inspection: MetaInspection | BackgroundTaskMeta | undefined,
  idOrOptions?: string | OutputOptions,
  maybeOptions?: OutputOptions,
): string {
  const inspectionValue = asInspection(inspection, idOrOptions);
  const options = (typeof idOrOptions === "string" ? maybeOptions : idOrOptions) ?? {};
  if (!inspectionValue.meta) return formatMissingTask(inspectionValue, options);
  const meta = inspectionValue.meta;
  const ownership = classifyOwnership(meta, options);
  if (ownership !== "allow") return formatOwnershipGap(meta.id, ownership, options);
  if (isIncidentCursor(options.cursor)) return assembleIncidentPage(meta, options);
  if (options.verbose) return formatVerbose(meta, options);
  const state = failureStateFor(meta.id);
  const resource = `status:${scopeKey(options)}:${meta.id}`;
  const revision = inspectStatusRevision({
    resource,
    contentRevision: contentRevision(meta),
    failureRevision: failureRevision(state),
    cursor: options.cursor,
  });
  if (options.cursor && revision.change === "none") {
    return assembleBackgroundContent({
      surface: "status",
      maxBytes: options.maxBytes,
      sections: {
        identity: `${identityLine(meta)} · unchanged`,
        failure: activeFailures(state).length
          ? `${activeFailures(state).length} active failure observation(s), unchanged.`
          : undefined,
        decision: formatUnchangedEvidence(options.cursor),
      },
      statusCursor: revision.nextCursor,
    });
  }
  const log = readLog(meta.logPath, STATUS_EXCERPT_ROWS);
  const extraDiagnostics = [
    ...(revision.change === "failure" ? ["change=failure"] : []),
    ...(revision.reset ? [`reset=${revision.reset}`] : []),
    ...(log.error ? [`log unreadable: ${log.error}`, "Cannot treat this as an empty healthy log."] : []),
  ];
  return assembleBackgroundContent({
    surface: "status",
    maxBytes: options.maxBytes,
    sections: {
      identity: identityLine(meta),
      failure: incidentSection(meta.id, options, state),
      decision: formatDecision(meta),
      diagnostics: formatDiagnostics(meta, extraDiagnostics),
      progress: formatProgress(meta),
    },
    verbatim: log.error ? undefined : (budget) => excerptPage(meta, options, log, budget),
    gaps: [
      ...taskGaps(meta),
      ...(log.error ? [{ kind: "read" as const, detail: log.error }] : []),
    ],
    statusCursor: revision.nextCursor,
  });
}

export function formatLog(id: string, options: OutputOptions = {}): string {
  const inspection = inspectMeta(id);
  if (!inspection.meta) return formatMissingTask(inspection, options);
  const meta = inspection.meta;
  const ownership = classifyOwnership(meta, options);
  if (ownership !== "allow") return formatOwnershipGap(meta.id, ownership, options);
  const fileCursor = cursorKind(options.cursor) === "f";
  const raw = options.raw === true || options.tailLines === 0 || fileCursor;
  const failure = incidentSection(id, options);
  if (raw) {
    return assembleBackgroundContent({
      surface: "rawPage",
      maxBytes: options.maxBytes,
      sections: {
        identity: `${meta.id} raw log (${meta.status})`,
        failure,
        decision: formatDecision(meta),
        diagnostics: formatDiagnostics(meta, [
          "Raw retained bytes; capture/retention loss is not recoverable as full history.",
        ]),
      },
      verbatim: (budget) => rawLogPage(meta, options, options.cursor, budget),
    });
  }
  const tailLines = options.tailLines && options.tailLines > 0 ? Math.floor(options.tailLines) : DEFAULT_LOG_TAIL_ROWS;
  const log = readLog(meta.logPath, tailLines);
  const staleCursor = options.cursor ? ["reset=stale-cursor (compact tails have no cursor; pass a raw nextCursor or tail_lines:0)"] : [];
  if (log.error) {
    return assembleBackgroundContent({
      surface: "log",
      maxBytes: options.maxBytes,
      sections: {
        identity: `${meta.id} log (${meta.status})`,
        failure,
        diagnostics: [...staleCursor, `log unreadable: ${log.error}`, "Cannot treat this as an empty healthy log."].join("\n"),
      },
      gaps: [{ kind: "read", detail: log.error }, ...taskGaps(meta)],
    });
  }
  return assembleBackgroundContent({
    surface: "log",
    maxBytes: options.maxBytes,
    sections: {
      identity: `${meta.id} log (${meta.status}) · newest ${tailLines} display row${tailLines === 1 ? "" : "s"}`,
      failure,
      decision: formatDecision(meta),
      diagnostics: formatDiagnostics(meta, staleCursor),
    },
    verbatim: (budget) => excerptPage(meta, options, log, budget),
    gaps: taskGaps(meta),
  });
}

function compactRow(meta: BackgroundTaskMeta, incidents: number): string {
  const age = formatDuration((meta.endedAt ?? Date.now()) - meta.startedAt);
  const remote = meta.ssh ? ` ${oneLine(meta.ssh.target, 60)}${meta.remote?.session ? ` ${meta.remote.session}` : ""}` : "";
  const incident = incidents > 0 ? ` · ${incidents} incident${incidents === 1 ? "" : "s"}` : "";
  const label = meta.name ? ` ${oneLine(meta.name, 60)}` : "";
  return `${meta.id} ${meta.status} ${meta.kind} ${age}${incident}${remote}${label}`;
}

export function formatList(options: OutputOptions = {}): string {
  const index = listTaskRecords();
  if (index.indexError) {
    return assembleBackgroundContent({
      surface: "list",
      maxBytes: options.maxBytes,
      sections: {
        identity: "Cannot list background tasks.",
        diagnostics: `Task index is unreadable: ${index.indexError}. Cannot treat the registry as empty.`,
      },
      gaps: [{ kind: "read", detail: index.indexError }],
    });
  }
  if (!options.all && !options.origin) {
    return assembleBackgroundContent({
      surface: "list",
      maxBytes: options.maxBytes,
      sections: {
        identity: "Current session is unavailable.",
        diagnostics: "Pass all:true to list tasks across sessions. Cannot treat the registry as empty.",
      },
      gaps: [{ kind: "read", detail: "session scope unavailable" }],
    });
  }
  const wanted = options.statuses && options.statuses.length > 0 ? new Set(options.statuses) : undefined;
  let unreadable = 0;
  let unknown = 0;
  const allowed: BackgroundTaskMeta[] = [];
  for (const record of index.records) {
    if (!record.meta) {
      if (record.found) unreadable += 1;
      continue;
    }
    const ownership = classifyOwnership(record.meta, options);
    if (ownership === "allow") {
      if (!wanted || wanted.has(record.meta.status)) allowed.push(record.meta);
    } else if (ownership === "unknown") {
      unknown += 1;
    }
  }
  const scope = scopeKey(options);
  const statusesKey = [...(options.statuses ?? [])].sort().join(",");
  const resource = `list:${scope}:${statusesKey}`;
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? DEFAULT_LIST_ENTRIES), MAX_LIST_ENTRIES));
  const states = new Map(allowed.map((meta) => [meta.id, failureStateFor(meta.id)] as const));
  const incidentsOf = (id: string) => activeFailures(states.get(id)!).length;
  const revision = inspectStatusRevision({
    resource,
    contentRevision: revisionOf(allowed.map((meta) => [meta.id, meta.status, meta.endedAt ?? null])),
    failureRevision: revisionOf(allowed.map((meta) => [meta.id, failureRevision(states.get(meta.id)!)])),
    cursor: cursorKind(options.cursor) === "s" ? options.cursor : undefined,
  });
  const scopeLabel = options.all ? "all sessions" : "current session";
  if (options.cursor && cursorKind(options.cursor) === "s" && revision.change === "none") {
    return assembleBackgroundContent({
      surface: "list",
      maxBytes: options.maxBytes,
      sections: {
        identity: `${allowed.length} background task${allowed.length === 1 ? "" : "s"} (${scopeLabel}) · unchanged`,
        decision: formatUnchangedEvidence(options.cursor),
      },
      statusCursor: revision.nextCursor,
    });
  }
  const failing = allowed.filter((meta) => incidentsOf(meta.id) > 0);
  const withIncidents = failing.length;
  // One leading incident (the newest failing task's top row), then a count:
  // failures lead the surface without repeating a paragraph per task.
  const listFailure = (budget: number): string | undefined => {
    const newest = failing[0];
    if (!newest) return undefined;
    const count = `${withIncidents} task${withIncidents === 1 ? "" : "s"} with unresolved incidents; newest ${newest.id} has ${incidentsOf(newest.id)}. Inspect with bg_task_status.`;
    const top = formatFailureLines(states.get(newest.id)!)[0] ?? "";
    const room = budget - utf8ByteLength(count) - 1;
    if (room < 48 || !top) return count;
    const shown = utf8ByteLength(top) <= room ? top : `${sliceUtf8Bytes(top, 0, room - 12, false).text} (clipped)`;
    return `${shown}\n${count}`;
  };
  const notes = [
    ...(unreadable ? [`${unreadable} task record(s) with unreadable metadata; cannot treat as empty or healthy`] : []),
    ...(unknown ? [`${unknown} task(s) with unavailable ownership hidden; pass all:true to inspect`] : []),
    ...(revision.change === "failure" ? ["change=failure"] : []),
  ];
  const gaps: EvidenceGap[] = [
    ...(unreadable ? [{ kind: "read" as const, detail: `${unreadable} unreadable metadata file(s)` }] : []),
    ...(unknown ? [{ kind: "read" as const, detail: `${unknown} task(s) with unverifiable ownership` }] : []),
  ];
  const pageCursor = options.cursor && cursorKind(options.cursor) !== "s" ? options.cursor : undefined;
  return assembleBackgroundContent({
    surface: "list",
    maxBytes: options.maxBytes,
    sections: {
      identity: options.sessionUnavailable && !options.all
        ? "Current session identity is unavailable; task ownership cannot be verified."
        : allowed.length === 0
          ? `No background tasks found (${scopeLabel}).`
          : `${allowed.length} background task${allowed.length === 1 ? "" : "s"} (${scopeLabel}), newest first`,
      failure: withIncidents ? listFailure : undefined,
      diagnostics: notes.join("\n") || undefined,
    },
    verbatim: allowed.length === 0 && !pageCursor
      ? undefined
      : (budget) => pageRows(allowed, {
        cursor: pageCursor,
        resource,
        limit,
        maxBytes: budget,
        keyOf: (meta) => ({ time: meta.startedAt, id: meta.id }),
        render: (meta) => compactRow(meta, incidentsOf(meta.id)),
      }),
    gaps,
    statusCursor: revision.nextCursor,
  });
}

export function formatStopResult(inspection: MetaInspection, options: OutputOptions = {}): string {
  if (!inspection.meta) return formatMissingTask(inspection, options);
  return formatStatus(inspection, options);
}

export { inspectMeta, utf8ByteLength };
