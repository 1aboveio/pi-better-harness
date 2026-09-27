import { createHash } from "node:crypto";
import { activeFailures, formatFailureSummary, readFailureState } from "./shared-failure-observations.js";
import {
  assemblePriorityEnvelope,
  clampBudgetBytes,
  formatUnchangedEvidence,
  inspectStatusRevision,
  pageVerbatimText,
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
import { captureGapsFor, pageTaskLog, readLog } from "./logs.js";
import { belongsToOrigin, inspectMeta, listTaskRecords, originOf, type MetaInspection } from "./registry.js";
import type { BackgroundTaskCallbackOrigin, BackgroundTaskMeta, Condition } from "./types.js";

/**
 * Issue #312 consumer budgets. Defaults follow OUTPUT-POLICY / shared
 * `OUTPUT_BUDGET_BYTES`. Explicit larger pages clamp to `OUTPUT_BUDGET_MAX_BYTES`
 * (hard caps), not the new smaller defaults. Totals are UTF-8 bytes of the
 * whole model-facing `content`, including headers, failures, gaps, and
 * continuation.
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
}

export function backgroundBudget(surface: BackgroundOutputSurface, requested?: number): number {
  const fallback = BACKGROUND_OUTPUT_BUDGET_BYTES[surface];
  const hard = BACKGROUND_OUTPUT_HARD_CAP_BYTES[surface];
  return Math.min(clampBudgetBytes(requested, fallback), hard);
}


function newestVerbatim(text: string, maxBytes: number): VerbatimPage {
  const total = utf8ByteLength(text);
  if (total <= maxBytes) return { text, hasMore: false, omittedBytes: 0 };
  const start = Math.max(0, total - maxBytes);
  const slice = sliceUtf8Bytes(text, start, maxBytes, false);
  let body = slice.text;
  if (slice.startByte > 0) {
    const newline = body.indexOf("\n");
    if (newline >= 0 && newline < body.length - 1) body = body.slice(newline + 1);
  }
  return {
    text: body,
    hasMore: true,
    omittedBytes: total - utf8ByteLength(body),
  };
}

function revisionToken(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 32);
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

function scopeKey(options: OutputOptions): string {
  if (options.all) return "all";
  const origin = options.origin;
  if (!origin) return "none";
  return revisionToken([origin.cwd, origin.sessionId ?? ""]);
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

function failureSummaryText(id: string): string | undefined {
  const summary = formatFailureSummary(readFailureState(failurePath(id)));
  return summary || undefined;
}

function failureCountLine(id: string): string | undefined {
  const active = activeFailures(readFailureState(failurePath(id)));
  if (active.length <= 5) return undefined;
  const omitted = active.length - 5;
  return `${active.length} unresolved incidents · ${omitted} omitted from this summary`;
}

function leadIdentity(id: string, identity: string): string {
  const summary = failureSummaryText(id);
  return summary ? `${summary}\n${identity}` : identity;
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

function formatDecision(meta: BackgroundTaskMeta): string | undefined {
  const lines: string[] = [];
  if (meta.status === "running" && meta.stopError) {
    lines.push(meta.stopError);
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
  return lines.length ? lines.join("\n") : undefined;
}

/** Compact decision/gap facts for completion callbacks (no env/command dump). */
export function formatCallbackFacts(meta: BackgroundTaskMeta): {
  outcome: string;
  failure?: string;
  decision?: string;
  incidentCount?: number;
  omittedIncidents?: number;
} {
  const state = readFailureState(failurePath(meta.id));
  const active = activeFailures(state);
  const failure = formatFailureSummary(state) || undefined;
  const gapLines = [
    meta.logDiscardedBytes ? `retention discarded ${meta.logDiscardedBytes} bytes; not recoverable` : undefined,
    meta.captureDiscardedBytes ? `capture overflow discarded ${meta.captureDiscardedBytes} bytes; not full history` : undefined,
  ].filter((line): line is string => Boolean(line));
  const decision = [formatDecision(meta), ...gapLines].filter(Boolean).join("\n") || undefined;
  return {
    outcome: meta.status,
    failure,
    decision: decision || undefined,
    incidentCount: active.length || undefined,
    omittedIncidents: active.length > 5 ? active.length - 5 : undefined,
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

function contentRevision(meta: BackgroundTaskMeta): string {
  return revisionToken([
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
  ]);
}

function failureRevision(id: string): string {
  const state = readFailureState(failurePath(id));
  return revisionToken({
    seen: state.seen.length,
    observations: Object.values(state.observations).map((item) => [
      item.id, item.status, item.count, item.lastSequence ?? 0, item.summary,
    ]),
  });
}

export function assembleBackgroundContent(input: {
  surface: BackgroundOutputSurface;
  maxBytes?: number;
  sections?: EnvelopeSections;
  verbatim?: (budget: number) => VerbatimPage;
  gaps?: EvidenceGap[];
}): string {
  return assemblePriorityEnvelope({
    maxBytes: backgroundBudget(input.surface, input.maxBytes),
    sections: input.sections,
    verbatim: input.verbatim,
    gaps: input.gaps,
  }).text;
}

export function formatMissingTask(inspection: MetaInspection): string {
  if (inspection.found || inspection.error) {
    return assembleBackgroundContent({
      surface: "status",
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
    sections: {
      identity: `No background task found for id ${inspection.id}.`,
    },
  });
}

function formatOwnershipGap(id: string, kind: "foreign" | "unknown"): string {
  const detail = kind === "foreign"
    ? "This task belongs to another session. Pass all:true to inspect it."
    : "Task ownership is unavailable or unreadable. Cannot treat this as nonexistent or healthy. Pass all:true to inspect.";
  return assembleBackgroundContent({
    surface: "status",
    sections: {
      identity: `Background task ${id} is outside the current session scope.`,
      diagnostics: detail,
    },
    gaps: [{ kind: "read", detail }],
  });
}

type Ownership = "allow" | "foreign" | "unknown";

function classifyOwnership(meta: BackgroundTaskMeta, origin: BackgroundTaskCallbackOrigin | undefined, all: boolean): Ownership {
  if (all || !origin) return "allow";
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
      identity: leadIdentity(meta.id, `Started background ${meta.kind} ${label}. Status: ${meta.status}.`),
      failure: failureCountLine(meta.id),
      decision: formatDecision(meta),
      diagnostics: remoteLines.join("\n") || undefined,
      progress: `Log: ${meta.logPath}`,
    },
    gaps: taskGaps(meta),
  });
}

function redactedVerbose(meta: BackgroundTaskMeta): unknown {
  const { env, ...rest } = meta;
  const state = readFailureState(failurePath(meta.id));
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

export function formatStatus(
  inspection: MetaInspection | BackgroundTaskMeta | undefined,
  idOrOptions?: string | OutputOptions,
  maybeOptions?: OutputOptions,
): string {
  const inspectionValue = asInspection(inspection, idOrOptions);
  const options = (typeof idOrOptions === "string" ? maybeOptions : idOrOptions) ?? {};
  if (!inspectionValue.meta) return formatMissingTask(inspectionValue);
  const meta = inspectionValue.meta;
  const ownership = classifyOwnership(meta, options.origin, options.all === true);
  if (ownership !== "allow") return formatOwnershipGap(meta.id, ownership);
  if (options.verbose) {
    return JSON.stringify(redactedVerbose(meta), null, 2);
  }
  const resource = `status:${scopeKey(options)}:${meta.id}`;
  const revision = inspectStatusRevision({
    resource,
    contentRevision: contentRevision(meta),
    failureRevision: failureRevision(meta.id),
    cursor: options.cursor,
  });
  if (options.cursor && revision.change === "none") {
    return assembleBackgroundContent({
      surface: "status",
      maxBytes: options.maxBytes,
      sections: {
        identity: leadIdentity(meta.id, `${identityLine(meta)} · unchanged`),
      },
      verbatim: () => ({
        text: formatUnchangedEvidence(options.cursor!),
        hasMore: false,
        omittedBytes: 0,
        nextCursor: revision.nextCursor,
      }),
    });
  }
  const log = readLog(meta.logPath, 3);
  const extraDiagnostics = [
    `cursor=${revision.nextCursor}`,
    ...(revision.change === "failure" ? ["change=failure"] : []),
    ...(revision.reset ? [`reset=${revision.reset}`] : []),
    ...(log.error ? [`log unreadable: ${log.error}`] : []),
  ];
  return assembleBackgroundContent({
    surface: "status",
    maxBytes: options.maxBytes,
    sections: {
      identity: leadIdentity(meta.id, identityLine(meta)),
      failure: failureCountLine(meta.id),
      decision: formatDecision(meta),
      diagnostics: formatDiagnostics(meta, extraDiagnostics),
      progress: formatProgress(meta),
    },
    verbatim: log.error || !log.text
      ? undefined
      : (remaining) => newestVerbatim(log.text, remaining),
    gaps: [
      ...taskGaps(meta),
      ...(log.error ? [{ kind: "read" as const, detail: log.error }] : []),
    ],
  });
}

export function formatLog(id: string, options: OutputOptions = {}): string {
  const inspection = inspectMeta(id);
  if (!inspection.meta) return formatMissingTask(inspection);
  const meta = inspection.meta;
  const ownership = classifyOwnership(meta, options.origin, options.all === true);
  if (ownership !== "allow") return formatOwnershipGap(meta.id, ownership);
  const raw = options.raw === true || options.tailLines === 0;
  const failure = failureCountLine(id);
  if (raw) {
    return assembleBackgroundContent({
      surface: "rawPage",
      maxBytes: options.maxBytes,
      sections: {
        identity: leadIdentity(meta.id, `${meta.id} raw log`),
        failure,
        decision: formatDecision(meta),
        diagnostics: formatDiagnostics(meta, [
          "Raw retained bytes; capture/retention loss is not recoverable as full history.",
        ]),
      },
      verbatim: (remaining) => pageTaskLog(meta, { cursor: options.cursor, maxBytes: remaining }),
    });
  }
  const tailLines = options.tailLines && options.tailLines > 0 ? Math.floor(options.tailLines) : DEFAULT_LOG_TAIL_ROWS;
  const log = readLog(meta.logPath, tailLines);
  if (log.error) {
    return assembleBackgroundContent({
      surface: "log",
      maxBytes: options.maxBytes,
      sections: {
        identity: leadIdentity(meta.id, `${meta.id} log`),
        failure,
        diagnostics: `log unreadable: ${log.error}\nCannot treat this as an empty healthy log.`,
      },
      gaps: [{ kind: "read", detail: log.error }, ...taskGaps(meta)],
    });
  }
  const excerpt = log.text || "(log is empty)";
  return assembleBackgroundContent({
    surface: "log",
    maxBytes: options.maxBytes,
    sections: {
      identity: leadIdentity(meta.id, `${meta.id} log`),
      failure,
      decision: formatDecision(meta),
      diagnostics: formatDiagnostics(meta),
    },
    verbatim: (remaining) => options.cursor
      ? pageVerbatimText(excerpt, { cursor: options.cursor, maxBytes: remaining })
      : newestVerbatim(excerpt, remaining),
    gaps: taskGaps(meta),
  });
}

function compactRow(meta: BackgroundTaskMeta): string {
  const age = formatDuration((meta.endedAt ?? Date.now()) - meta.startedAt);
  const label = meta.name ? `${meta.name} ` : "";
  const remote = meta.ssh ? ` ${meta.ssh.target}${meta.remote?.session ? ` ${meta.remote.session}` : ""}` : "";
  const incidents = activeFailures(readFailureState(failurePath(meta.id))).length;
  const incident = incidents > 0 ? ` · ${incidents} incident${incidents === 1 ? "" : "s"}` : "";
  return `${meta.id} ${label}${meta.kind} ${meta.status} ${age}${remote}${incident}`;
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
  const unreadable: MetaInspection[] = [];
  const unknown: MetaInspection[] = [];
  const allowed: Array<MetaInspection & { meta: BackgroundTaskMeta }> = [];
  for (const record of index.records) {
    if (!record.meta) {
      unreadable.push(record);
      continue;
    }
    const ownership = classifyOwnership(record.meta, options.origin, options.all === true);
    if (ownership === "allow") {
      if (!wanted || wanted.has(record.meta.status)) allowed.push(record as MetaInspection & { meta: BackgroundTaskMeta });
    } else if (ownership === "unknown") {
      unknown.push(record);
    }
  }
  const scope = scopeKey(options);
  const statusesKey = (options.statuses ?? []).join(",");
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIST_ENTRIES, MAX_LIST_ENTRIES));
  const pageRows = allowed.slice(0, limit);
  const remainingEntries = Math.max(0, allowed.length - pageRows.length);
  const contentRev = revisionToken(allowed.map((record) => [record.meta.id, record.meta.status, record.meta.lastCheckedAt ?? null]));
  const failRev = revisionToken(allowed.map((record) => [
    record.meta.id,
    activeFailures(readFailureState(failurePath(record.meta.id))).map((item) => [item.id, item.status, item.count]),
  ]));
  const resource = `list:${scope}:${statusesKey}:${limit}`;
  const revision = inspectStatusRevision({
    resource,
    contentRevision: contentRev,
    failureRevision: failRev,
    cursor: options.cursor,
  });
  if (options.cursor && revision.change === "none") {
    return assembleBackgroundContent({
      surface: "list",
      maxBytes: options.maxBytes,
      sections: {
        identity: `${pageRows.length} background task${pageRows.length === 1 ? "" : "s"} · unchanged`,
      },
      verbatim: () => ({
        text: formatUnchangedEvidence(options.cursor!),
        hasMore: false,
        omittedBytes: 0,
        nextCursor: revision.nextCursor,
      }),
    });
  }
  const pagingBody = Boolean(options.cursor && revision.reset === "stale-cursor");
  if (pageRows.length === 0 && unreadable.length === 0 && unknown.length === 0) {
    return assembleBackgroundContent({
      surface: "list",
      maxBytes: options.maxBytes,
      sections: { identity: "No background tasks found." },
    });
  }
  const incidentTasks = pageRows.filter((record) => activeFailures(readFailureState(failurePath(record.meta.id))).length > 0);
  const leadingFailure = pageRows.map((record) => failureSummaryText(record.meta.id)).find(Boolean);
  const body = pageRows.map((record) => compactRow(record.meta)).join("\n") + (pageRows.length ? "\n" : "");
  const unreadLines = [
    ...(unreadable.length ? [`${unreadable.length} unreadable metadata file(s); cannot treat as empty or healthy`] : []),
    ...(unknown.length ? [`${unknown.length} task(s) with unavailable ownership; pass all:true to inspect`] : []),
    ...(remainingEntries > 0 ? [`${remainingEntries} more task${remainingEntries === 1 ? "" : "s"} not in this page; pass a higher limit`] : []),
    `cursor=${revision.nextCursor}`,
    ...(revision.change === "failure" ? ["change=failure"] : []),
    ...(revision.reset ? [`reset=${revision.reset}`] : []),
  ];
  const gaps: EvidenceGap[] = [
    ...(unreadable.length ? [{ kind: "read" as const, bytes: unreadable.length, detail: `${unreadable.length} unreadable metadata file(s)` }] : []),
    ...(unknown.length ? [{ kind: "read" as const, bytes: unknown.length, detail: `${unknown.length} task(s) with unavailable ownership` }] : []),
  ];
  return assembleBackgroundContent({
    surface: "list",
    maxBytes: options.maxBytes,
    sections: {
      identity: leadingFailure
        ? `${leadingFailure}\n${pageRows.length} background task${pageRows.length === 1 ? "" : "s"}`
        : `${pageRows.length} background task${pageRows.length === 1 ? "" : "s"}`,
      failure: incidentTasks.length
        ? `${incidentTasks.length} listed task${incidentTasks.length === 1 ? "" : "s"} with unresolved incidents`
        : undefined,
      diagnostics: unreadLines.join("\n") || undefined,
    },
    verbatim: (remaining) => {
      const page = pageVerbatimText(body, { cursor: pagingBody ? options.cursor : undefined, maxBytes: remaining });
      if (remainingEntries <= 0) return page;
      return {
        ...page,
        hasMore: true,
        omittedBytes: page.omittedBytes + utf8ByteLength(allowed.slice(limit).map((record) => compactRow(record.meta)).join("\n")),
      };
    },
    gaps,
  });
}

export function formatStopResult(inspection: MetaInspection, options: OutputOptions = {}): string {
  if (!inspection.meta) return formatMissingTask(inspection);
  return formatStatus(inspection, options);
}

export { inspectMeta, utf8ByteLength };
