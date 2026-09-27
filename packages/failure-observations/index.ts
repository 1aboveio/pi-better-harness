import { appendFileSync, closeSync, existsSync, openSync, readFileSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

/**
 * Explicit, append-only incident dispositions (#315).
 * - recovered: the same operation later passed (verified by the adapter).
 * - superseded: a different verification or remediation established the outcome.
 * - expected: the non-success result was intentional.
 * - open: explicitly classified as still needing action; the incident stays actionable.
 */
export type IncidentDisposition = "recovered" | "superseded" | "expected" | "open";
export const INCIDENT_DISPOSITIONS: readonly IncidentDisposition[] = Object.freeze(["recovered", "superseded", "expected", "open"]);

export interface FailureEvent {
  /** Stable source event identity: replay must reuse this id. */
  id: string;
  operation: string;
  kind: "failure" | "recovered" | "incomplete" | "delivered" | "disposition";
  /** Event time when known; never fabricate it from log mtime. */
  at?: number;
  summary?: string;
  category?: string;
  evidence?: string;
  expected?: boolean;
  /** Recovery/delivery/disposition must name the incidents it resolves/delivers/classifies. */
  incidents?: string[];
  /** Disposition events only. */
  disposition?: IncidentDisposition;
  /** Disposition events only: why the incidents are classified this way. */
  reason?: string;
}
export interface DispositionRecord {
  eventId: string;
  disposition: IncidentDisposition;
  incidents: string[];
  reason: string;
  evidence?: string;
  at: number;
}
export interface FailureObservation {
  id: string;
  operation: string;
  /** `resolved` is the historical name for a recovered incident. */
  status: "unresolved" | "expected" | "resolved" | "superseded";
  category: string;
  summary: string;
  evidence?: string;
  firstObservedAt: number;
  lastObservedAt: number;
  /** Journal order breaks timestamp ties without inventing an event time. */
  lastSequence?: number;
  at?: number;
  count: number;
  resolvedAt?: number;
  /** Latest explicit disposition applied to this incident. */
  disposition?: DispositionRecord;
}
export interface FailureState {
  version: 1;
  seen: string[];
  observations: Record<string, FailureObservation>;
  delivered: Record<string, number>;
  resolved?: Record<string, number>;
  /** Closed incidents replaced by a newer incident of the same operation. Never deleted. */
  history?: Record<string, FailureObservation>;
  /** Accepted disposition events in journal order. */
  dispositions?: DispositionRecord[];
}
export function emptyFailureState(): FailureState {
  return { version: 1, seen: [], observations: {}, delivered: {} };
}
export function failureIdentity(...parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}
function text(value: string | undefined, fallback: string): string {
  return (value || fallback).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 400);
}

/** Agent tool attempts: the agent handles its own tool errors, so one failure is not yet actionable. */
export const AGENT_TOOL_CATEGORY = "tool";
/** A command the confined intent bash refused before running (malformed or reused intent). Agent-owned, never grouped. */
export const REJECTED_INTENT_CATEGORY = "rejected-intent";
/** The same unresolved agent tool operation failing this many times is treated as stuck. */
export const REPEATED_FAILURE_THRESHOLD = 3;

/** The one current incident with this id, if it is still in the reduced state. */
export function findIncident(state: FailureState, id: string): FailureObservation | undefined {
  return Object.values(state.observations).find((item) => item.id === id);
}

/**
 * Current actionability, derived only from reduced structured state. Lifecycle is not an input.
 * Agent tool failures need an explicit `open` disposition or a repeated failure of the same
 * operation; other producer failures (exit, model, supervision, watch) are actionable at once.
 */
export function requiresAction(x: FailureObservation): boolean {
  if (x.status !== "unresolved" || x.category === "observation-incomplete") return false;
  if (x.category !== AGENT_TOOL_CATEGORY && x.category !== REJECTED_INTENT_CATEGORY) return true;
  return x.disposition?.disposition === "open" || x.count >= REPEATED_FAILURE_THRESHOLD;
}

export function failureLabel(x: FailureObservation): string {
  if (x.category === "observation-incomplete") return "Observation incomplete";
  if (x.status === "expected") return "Expected failure";
  if (x.status === "resolved") return "Recovered";
  if (x.status === "superseded") return "Superseded";
  return requiresAction(x) ? "Action required" : "Unclassified failure observation";
}

/** Validate a disposition against the reduced state. Returns the rejection reason, or undefined. */
export function validateDisposition(state: FailureState, event: FailureEvent): string | undefined {
  if (event.kind !== "disposition") return "Not a disposition event";
  if (!event.disposition || !INCIDENT_DISPOSITIONS.includes(event.disposition)) return `Unknown disposition ${JSON.stringify(event.disposition ?? "")}`;
  const ids = event.incidents;
  if (!Array.isArray(ids) || ids.length === 0) return "A disposition must name at least one incident";
  if (ids.some((id) => typeof id !== "string" || !id)) return "Incident ids must be non-empty strings";
  if (new Set(ids).size !== ids.length) return "A disposition names the same incident more than once";
  if (typeof event.reason !== "string" || !event.reason.trim()) return "A disposition requires a reason";
  if ((event.disposition === "recovered" || event.disposition === "superseded") && (typeof event.evidence !== "string" || !event.evidence.trim())) {
    return `A ${event.disposition} disposition requires evidence`;
  }
  for (const id of ids) {
    const current = findIncident(state, id);
    if (!current) {
      return Object.hasOwn(state.history ?? {}, id) || Object.hasOwn(state.resolved ?? {}, id)
        ? `Incident ${id} is already disposed` : `Unknown incident ${id}`;
    }
    if (current.category === "observation-incomplete") return `Incident ${id} is an observation gap; it cannot be disposed`;
    if (current.status !== "unresolved") return `Incident ${id} is already disposed (${failureLabel(current).toLowerCase()})`;
    if (event.disposition === "open" && current.disposition?.disposition === "open") return `Incident ${id} is already open`;
  }
  return undefined;
}

/** Pure transition. Lifecycle is deliberately not an input or an output. */
export function reduceFailure(state: FailureState, event: FailureEvent, observedAt: number): FailureState {
  if (state.seen.includes(event.id)) return state;
  // Invalid dispositions fail closed: nothing changes and the id is not consumed.
  if (event.kind === "disposition" && validateDisposition(state, event)) return state;
  const next: FailureState = { ...state, seen: [...state.seen, event.id],
    observations: { ...state.observations }, delivered: { ...state.delivered } };
  if (event.kind === "delivered") {
    for (const id of event.incidents ?? []) next.delivered = { ...next.delivered, [id]: observedAt };
    return next;
  }
  if (event.kind === "disposition") {
    const at = event.at ?? observedAt;
    const record: DispositionRecord = { eventId: event.id, disposition: event.disposition!, incidents: [...event.incidents!],
      reason: text(event.reason, ""), ...(event.evidence ? { evidence: text(event.evidence, "") } : {}), at };
    for (const id of record.incidents) {
      const [key, current] = Object.entries(next.observations).find(([, item]) => item.id === id)!;
      const status = record.disposition === "recovered" ? "resolved" : record.disposition === "superseded" ? "superseded"
        : record.disposition === "expected" ? "expected" : current.status;
      next.observations[key] = { ...current, status, disposition: record,
        ...(status === "resolved" || status === "superseded" ? { resolvedAt: at } : {}) };
      if (status === "resolved" || status === "superseded") next.resolved = { ...next.resolved, [id]: at };
    }
    next.dispositions = [...(state.dispositions ?? []), record];
    return next;
  }
  const key = failureIdentity(event.operation);
  const previous = state.observations[key];
  if (event.kind === "recovered") {
    // Only an unresolved incident recovers; an expected one keeps its classification.
    if (previous && previous.status === "unresolved" && event.incidents?.includes(previous.id)) {
      next.observations[key] = { ...previous, status: "resolved", resolvedAt: event.at ?? observedAt };
      next.resolved = { ...state.resolved, [previous.id]: event.at ?? observedAt };
    }
    return next;
  }
  const active = previous && previous.status !== "resolved" && previous.status !== "superseded" &&
    !(previous.status === "expected" && !event.expected);
  if (previous && !active) next.history = { ...state.history, [previous.id]: previous };
  next.observations[key] = {
    id: active ? previous.id : event.id, operation: event.operation,
    status: active ? previous.status : event.expected ? "expected" : "unresolved",
    category: event.kind === "incomplete" ? "observation-incomplete" : event.category ?? "operation",
    summary: text(event.summary, "Operation failed"), evidence: event.evidence,
    firstObservedAt: active ? previous.firstObservedAt : observedAt,
    lastObservedAt: observedAt, lastSequence: next.seen.length, at: event.at,
    count: active ? previous.count + 1 : 1,
    ...(active && previous.disposition ? { disposition: previous.disposition } : {}),
  };
  return next;
}
function priority(x: FailureObservation): number {
  if (x.category === "observation-incomplete") return 0;
  if (x.status === "expected") return 3;
  return requiresAction(x) ? 1 : 2;
}
/** Current (not recovered or superseded) incidents in priority order. History is excluded. */
export function activeFailures(state: FailureState): FailureObservation[] {
  return Object.values(state.observations).filter((x) => x.status !== "resolved" && x.status !== "superseded")
    .sort((a, b) => priority(a) - priority(b) || (b.lastSequence ?? 0) - (a.lastSequence ?? 0) || b.lastObservedAt - a.lastObservedAt);
}
/** Every incident ever reduced, current and closed. Nothing is removed. */
export function failureHistory(state: FailureState): FailureObservation[] {
  return [...Object.values(state.history ?? {}), ...Object.values(state.observations)];
}
export interface FailureCounts {
  actionRequired: number;
  unclassified: number;
  expected: number;
  incomplete: number;
  recovered: number;
  superseded: number;
}
/** Separate facts: current actionability, retained classification, and closed history. */
export function failureCounts(state: FailureState): FailureCounts {
  const counts: FailureCounts = { actionRequired: 0, unclassified: 0, expected: 0, incomplete: 0, recovered: 0, superseded: 0 };
  for (const x of failureHistory(state)) {
    if (x.status === "resolved") counts.recovered += 1;
    else if (x.status === "superseded") counts.superseded += 1;
    else if (x.category === "observation-incomplete") counts.incomplete += 1;
    else if (x.status === "expected") counts.expected += 1;
    else if (requiresAction(x)) counts.actionRequired += 1;
    else counts.unclassified += 1;
  }
  return counts;
}
const INCIDENT_CURSOR_PREFIX = "i1.";
const encoder = new TextEncoder();

function failureRow(x: FailureObservation): string {
  const time = x.at === undefined ? `observed ${new Date(x.firstObservedAt).toISOString()}` : new Date(x.at).toISOString();
  const disposition = x.disposition ? ` · ${x.disposition.disposition}: ${text(x.disposition.reason, "")}` : "";
  return `${failureLabel(x)} · ${time} · ${x.summary}${x.count > 1 ? ` (${x.count} occurrences)` : ""}${disposition}${x.evidence ? ` · evidence: ${text(x.evidence, "")}` : ""}`;
}

/** Every active incident as a priority row. Consumers page these; they are not a lossy summary. */
export function formatFailureLines(state: FailureState): string[] {
  return activeFailures(state).map(failureRow);
}

function closedHistoryLine(state: FailureState): string | undefined {
  const counts = failureCounts(state);
  if (!counts.recovered && !counts.superseded) return undefined;
  const parts = [counts.recovered ? `${counts.recovered} recovered` : "", counts.superseded ? `${counts.superseded} superseded` : ""].filter(Boolean);
  return `Closed incidents retained in history: ${parts.join(" · ")}.`;
}

/** Shared priority text, placed BEFORE assistant progress on every consumer surface. */
export function formatFailureSummary(state: FailureState): string {
  const lines = formatFailureLines(state);
  if (!lines.length) return "";
  const rows = lines.slice(0, 5);
  if (lines.length > 5) rows.push(`${lines.length - 5} additional active failure observations retained in the failure journal.`);
  const history = closedHistoryLine(state);
  if (history) rows.push(history);
  return rows.join("\n");
}

/** Incident rows for exactly `incidents`, priority order. Unknown ids fail closed. */
export function pendingAttentionRows(state: FailureState, incidents: readonly string[]): string[] {
  const wanted = new Set(incidents);
  const rows = activeFailures(state).filter((x) => wanted.has(x.id));
  if (rows.length !== wanted.size) throw new Error("Failure incident evidence is unavailable; defer notification delivery");
  return rows.map(failureRow);
}
/** Count of other active incidents, which a notification references but never re-lists. */
export function pendingAttentionNote(state: FailureState, incidents: readonly string[]): string | undefined {
  const wanted = new Set(incidents);
  const others = activeFailures(state).filter((x) => !wanted.has(x.id)).length;
  return others > 0 ? `${others} other active failure observation${others === 1 ? " was" : "s were"} reported earlier or not actionable; not repeated here.` : undefined;
}
/**
 * Attention text for exactly `incidents` (normally `pending.incidents`). Earlier delivered or
 * non-actionable incidents are counted, never re-listed. Unknown ids fail closed.
 */
export function formatPendingAttention(state: FailureState, incidents: readonly string[], options: { maxRows?: number } = {}): string {
  const rows = pendingAttentionRows(state, incidents);
  const max = options.maxRows ?? 5;
  const lines = rows.slice(0, max);
  if (rows.length > max) lines.push(`${rows.length - max} additional pending incidents retained in the failure journal.`);
  const note = pendingAttentionNote(state, incidents);
  if (note) lines.push(note);
  return lines.join("\n");
}

export interface TerminalFailureParts {
  /** Actionable and observation-incomplete incidents among `incidents`, one row each. */
  rows: string[];
  /** Counts and separate facts: earlier-reported, unclassified, expected, closed history, correctness. */
  notes: string[];
}
/**
 * Terminal/completion facts: actionable and incomplete incidents from `incidents` as rows,
 * unclassified agent tool failures as a count. Lifecycle is reported by the caller, separately.
 */
export function terminalFailureParts(state: FailureState, incidents: readonly string[] = []): TerminalFailureParts {
  const wanted = new Set(incidents);
  const reportable = (x: FailureObservation) => requiresAction(x) || x.category === "observation-incomplete";
  const rows = activeFailures(state).filter((x) => wanted.has(x.id) && reportable(x)).map(failureRow);
  const notes: string[] = [];
  const earlier = activeFailures(state).filter((x) => !wanted.has(x.id) && reportable(x)).length;
  if (earlier) notes.push(`${earlier} actionable incident${earlier === 1 ? " was" : "s were"} reported earlier; not repeated here.`);
  const counts = failureCounts(state);
  if (counts.unclassified) notes.push(`${counts.unclassified} earlier tool failure${counts.unclassified === 1 ? "" : "s"} remain${counts.unclassified === 1 ? "s" : ""} unclassified.`);
  if (counts.expected) notes.push(`${counts.expected} expected failure${counts.expected === 1 ? "" : "s"} recorded.`);
  const history = closedHistoryLine(state);
  if (history) notes.push(history);
  if (counts.unclassified || counts.actionRequired) notes.push("Work correctness was not inferred from lifecycle alone.");
  return { rows, notes };
}
export function formatTerminalFailureFacts(state: FailureState, incidents: readonly string[] = []): string {
  const { rows, notes } = terminalFailureParts(state, incidents);
  const lines = rows.slice(0, 5);
  if (rows.length > 5) lines.push(`${rows.length - 5} additional actionable incidents retained in the failure journal.`);
  return [...lines, ...notes].join("\n");
}

export interface FailureIncidentPage {
  text: string;
  total: number;
  /** Rows completed on this page (a row split across pages counts where it ends). */
  represented: number;
  /** Rows not fully shown through this page, including a partially shown row. */
  omitted: number;
  cursor: string;
  nextCursor: string;
  hasMore: boolean;
  reset?: "stale-cursor" | "source-replaced";
  /** The first line continues a row begun on an earlier page. */
  startsPartial: boolean;
  /** The last line is the start of a row that continues on the next page. */
  endsPartial: boolean;
}

/**
 * Signature of every observation's reportable state. A change here is a
 * failure-only change even when log bytes are unchanged; receipts and replay
 * bookkeeping do not change it.
 */
export function failureRevision(state: FailureState): string {
  return failureIdentity(Object.values(state.observations)
    .map((item) => [item.id, item.status, item.category, item.count, item.lastSequence ?? 0, item.summary, item.evidence ?? ""])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

function incidentRevision(state: FailureState): string {
  return failureIdentity(activeFailures(state).map((item) => [item.id, item.status, item.count, item.summary, item.evidence ?? ""])).slice(0, 16);
}

/** Cursors carry a digest of their resource/scope, not the scope text. */
function resourceTag(resource: string | undefined): string | undefined {
  return resource === undefined ? undefined : createHash("sha256").update(resource).digest("base64url").slice(0, 16);
}

interface IncidentCursor { o: number; b: number; v: string; n: number; r?: string }

function encodeIncidentCursor(cursor: IncidentCursor): string {
  return INCIDENT_CURSOR_PREFIX + Buffer.from(JSON.stringify({ k: "i", o: cursor.o, ...(cursor.b ? { b: cursor.b } : {}),
    v: cursor.v, n: cursor.n, ...(cursor.r !== undefined ? { r: cursor.r } : {}) }), "utf8").toString("base64url");
}

function decodeIncidentCursor(cursor: string | undefined): IncidentCursor | undefined {
  if (!cursor || !cursor.startsWith(INCIDENT_CURSOR_PREFIX)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor.slice(INCIDENT_CURSOR_PREFIX.length), "base64url").toString("utf8")) as { k?: string; o?: number; b?: number; v?: string; n?: number; r?: string };
    if (parsed?.k === "i" && typeof parsed.v === "string") {
      return { o: Math.max(0, Math.floor(parsed.o ?? 0)), b: Math.max(0, Math.floor(parsed.b ?? 0)), v: parsed.v,
        n: Math.max(0, Math.floor(parsed.n ?? 0)), ...(typeof parsed.r === "string" ? { r: parsed.r } : {}) };
    }
  } catch { /* stale */ }
  return undefined;
}

export function isIncidentCursor(cursor: string | undefined): boolean {
  return Boolean(cursor?.startsWith(INCIDENT_CURSOR_PREFIX));
}

function utf8Length(value: string): number {
  return encoder.encode(value).byteLength;
}

/** Largest prefix of `bytes` within `room` that does not split a code point. */
function utf8Prefix(bytes: Uint8Array, room: number): number {
  if (room <= 0) return 0;
  if (room >= bytes.length) return bytes.length;
  let end = room;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return end;
}

export interface IncidentPageRequest {
  cursor?: string;
  maxBytes?: number;
  /** Resource/scope bound into cursors; a cursor minted for another scope resets. */
  resource?: string;
}

/**
 * Caller-owned incident pages. Whole rows are preferred; a row larger than the
 * page is split at a code-point boundary and resumes at that byte, so pages
 * reconstruct formatFailureLines() exactly (join with "\n" except after a page
 * that `endsPartial`). A page never exceeds `maxBytes`.
 */
export function pageFailureIncidents(state: FailureState, request: IncidentPageRequest = {}): FailureIncidentPage {
  const lines = formatFailureLines(state);
  const revision = incidentRevision(state);
  const total = lines.length;
  const resource = resourceTag(request.resource);
  let offset = 0;
  let byte = 0;
  let reset: FailureIncidentPage["reset"];
  if (request.cursor) {
    const parsed = decodeIncidentCursor(request.cursor);
    if (!parsed || parsed.r !== resource) reset = "stale-cursor";
    else if (parsed.v !== revision) reset = "source-replaced";
    else { offset = Math.min(total, parsed.o); byte = offset < total ? parsed.b : 0; }
  }
  const maxBytes = Number.isFinite(request.maxBytes) && (request.maxBytes ?? -1) >= 0
    ? Math.floor(request.maxBytes as number)
    : 2 * 1024;
  const mint = (o: number, b: number) => encodeIncidentCursor({ o, b, v: revision, n: total, ...(resource !== undefined ? { r: resource } : {}) });
  const parts: string[] = [];
  let used = 0;
  let nextRow = offset;
  let nextByte = byte;
  let endsPartial = false;
  for (let i = offset; i < total; i += 1) {
    const encoded = encoder.encode(lines[i]!);
    const from = i === offset ? Math.min(byte, encoded.length) : 0;
    const rest = encoded.subarray(from);
    const sep = parts.length ? 1 : 0;
    if (used + sep + rest.length <= maxBytes) {
      parts.push(Buffer.from(rest).toString("utf8"));
      used += sep + rest.length;
      nextRow = i + 1;
      nextByte = 0;
      continue;
    }
    if (parts.length === 0) {
      const cut = utf8Prefix(rest, maxBytes);
      if (cut > 0) {
        parts.push(Buffer.from(rest.subarray(0, cut)).toString("utf8"));
        used += cut;
        nextRow = i;
        nextByte = from + cut;
        endsPartial = true;
      }
    }
    break;
  }
  const startsPartial = byte > 0 && offset < total;
  const represented = Math.max(0, nextRow - offset);
  return {
    text: parts.join("\n"),
    total,
    represented,
    omitted: Math.max(0, total - nextRow),
    cursor: mint(offset, byte),
    nextCursor: mint(nextRow, nextByte),
    hasMore: nextRow < total,
    ...(reset ? { reset } : {}),
    startsPartial,
    endsPartial,
  };
}

/** Cursor resource for one task/run's incidents in one session scope. */
export function incidentResource(scopeKey: string, id: string): string {
  return `incidents:${scopeKey}:${id}`;
}

/** Heading for an explicit incident page. */
export function incidentPageHeading(total: number): string {
  return `Incident page of ${total} active failure observation${total === 1 ? "" : "s"}.`;
}

/**
 * One explicit incident page shaped as an envelope verbatim page (log-utils
 * `VerbatimPage`): the shared body of every consumer's `incidentCursor`
 * response. Omitted counts are rows, never bytes.
 */
export function incidentVerbatimPage(state: FailureState, request: IncidentPageRequest = {}): {
  text: string;
  hasMore: boolean;
  cursor: string;
  nextCursor: string;
  omittedBytes: number;
  omittedRows: number;
  reset?: "stale-cursor" | "source-replaced";
} {
  const page = pageFailureIncidents(state, request);
  return {
    text: page.text || (page.total === 0 ? "No active failure observations." : ""),
    hasMore: page.hasMore,
    cursor: page.cursor,
    nextCursor: page.nextCursor,
    omittedBytes: 0,
    omittedRows: page.omitted,
    ...(page.reset ? { reset: page.reset } : {}),
  };
}

/**
 * Cheap change fingerprint of a failure journal: the file's identity and size
 * (or its read error), whether the durable existence marker is present, and
 * how many records are still awaiting persistence in this process. Every
 * journal append, truncation, deletion, or pending in-memory record changes
 * it, so a cache keyed by it never serves stale incident counts.
 */
export function failureJournalFingerprint(path: string): string {
  let file: string;
  try {
    const stats = statSync(path, { bigint: true });
    file = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
  } catch (error) {
    file = `unreadable:${(error as NodeJS.ErrnoException).code ?? "error"}`;
  }
  return `${file}|${existsSync(`${path}.observed`) ? 1 : 0}|${pendingWrites.get(path)?.length ?? 0}`;
}

export function incidentCursorAt(state: FailureState, offset: number, resource?: string): string {
  const lines = formatFailureLines(state);
  const tag = resourceTag(resource);
  return encodeIncidentCursor({ o: Math.max(0, Math.floor(offset)), b: 0, v: incidentRevision(state), n: lines.length,
    ...(tag !== undefined ? { r: tag } : {}) });
}

const MIN_PARTIAL_ROW_BYTES = 96;

export interface IncidentSummary {
  text: string;
  total: number;
  /** Rows fully shown. */
  represented: number;
  /** Rows not fully shown; retrievable from `nextCursor`. */
  omitted: number;
  nextCursor?: string;
}

/**
 * The shared priority failure section for a byte budget. When every active
 * incident fits, the rows are returned unchanged. Otherwise a count line leads:
 * total, fully shown, omitted, and the incident cursor that resumes at the
 * first byte not shown. Counts survive any budget that fits the count line.
 */
export function formatIncidentSummary(state: FailureState, options: { maxBytes: number; resource?: string; retrieval?: string }): IncidentSummary {
  const maxBytes = Math.max(0, Math.floor(options.maxBytes));
  const whole = pageFailureIncidents(state, { maxBytes, resource: options.resource });
  if (whole.total === 0) return { text: "", total: 0, represented: 0, omitted: 0 };
  if (!whole.hasMore) return { text: whole.text, total: whole.total, represented: whole.represented, omitted: 0 };
  const header = (page: FailureIncidentPage): string =>
    `${page.total} active failure observation${page.total === 1 ? "" : "s"} · ${page.represented} shown · ${page.omitted} omitted` +
    ` · incidentCursor=${page.nextCursor}${options.retrieval ? ` (${options.retrieval})` : ""}`;
  let rowBudget = maxBytes - utf8Length(header(whole)) - 1;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let page = pageFailureIncidents(state, { maxBytes: Math.max(0, rowBudget), resource: options.resource });
    // A few bytes of a clipped row are noise; show the count line alone and
    // let the cursor start at that row.
    if (page.represented === 0 && page.endsPartial && utf8Length(page.text) < MIN_PARTIAL_ROW_BYTES) {
      page = pageFailureIncidents(state, { maxBytes: 0, resource: options.resource });
    }
    const line = header(page);
    const text = page.text ? `${line}\n${page.text}` : line;
    const overflow = utf8Length(text) - maxBytes;
    if (overflow <= 0) {
      return { text, total: page.total, represented: page.represented, omitted: page.omitted, nextCursor: page.nextCursor };
    }
    if (rowBudget <= 0) break;
    rowBudget -= overflow;
  }
  // Not even the count line with its cursor fits. Never emit a clipped cursor:
  // keep the exact counts and drop the cursor token whole, saying so.
  const empty = pageFailureIncidents(state, { maxBytes: 0, resource: options.resource });
  const withCursor = header(empty);
  if (utf8Length(withCursor) <= maxBytes) {
    return { text: withCursor, total: empty.total, represented: 0, omitted: empty.total, nextCursor: empty.nextCursor };
  }
  const plural = empty.total === 1 ? "" : "s";
  for (const candidate of [
    `${empty.total} active failure observation${plural} · 0 shown · ${empty.total} omitted · incident cursor not shown (page too small; retry with a larger maxBytes${options.retrieval ? ` or ${options.retrieval}` : ""})`,
    `${empty.total} active failure observation${plural} · 0 shown · ${empty.total} omitted · incident cursor not shown (page too small)`,
    `${empty.total} active failure observation${plural} (page too small for details)`,
  ]) {
    if (utf8Length(candidate) <= maxBytes) return { text: candidate, total: empty.total, represented: 0, omitted: empty.total };
  }
  return { text: "", total: empty.total, represented: 0, omitted: empty.total };
}
/**
 * Terminal failure section for a byte budget (#315): lifecycle-independent facts. Actionable and
 * observation-incomplete incidents (which lead the priority order) are shown as whole rows;
 * unclassified, expected, and closed incidents are counts. When any active row is not shown, a
 * count line gives the exact total, shown, omitted, and an incident cursor at the first unshown row.
 */
export function formatTerminalIncidentSummary(state: FailureState, options: { maxBytes: number; resource?: string; retrieval?: string }): IncidentSummary {
  const active = activeFailures(state);
  const total = active.length;
  const { notes } = terminalFailureParts(state, active.map((x) => x.id));
  if (total === 0 && notes.length === 0) return { text: "", total: 0, represented: 0, omitted: 0 };
  const reportable = active.filter((x) => requiresAction(x) || x.category === "observation-incomplete").length;
  const lines = formatFailureLines(state).slice(0, reportable);
  const maxBytes = Math.max(0, Math.floor(options.maxBytes));
  const header = (shown: number): string | undefined => shown >= total ? undefined :
    `${total} active failure observation${total === 1 ? "" : "s"} · ${shown} shown · ${total - shown} omitted` +
    ` · incidentCursor=${incidentCursorAt(state, shown, options.resource)}${options.retrieval ? ` (${options.retrieval})` : ""}`;
  const render = (shown: number) => [header(shown), ...lines.slice(0, shown), ...notes].filter((x): x is string => Boolean(x)).join("\n");
  let shown = lines.length;
  while (shown > 0 && utf8Length(render(shown)) > maxBytes) shown -= 1;
  const omitted = total - shown;
  return { text: render(shown), total, represented: shown, omitted, ...(omitted > 0 ? { nextCursor: incidentCursorAt(state, shown, options.resource) } : {}) };
}
/**
 * Incidents due for a notification. Terminal: every current unresolved incident not yet delivered
 * (reported once, then receipted). Running: observation gaps immediately (unless the consumer
 * defers them to its terminal/health callback), actionable incidents after the grace period;
 * a single agent tool failure is left to the agent that owns it.
 */
export function pendingFailureAttention(state: FailureState, now: number,
  options: { terminal?: boolean; graceMs?: number; deferObservationGaps?: boolean } = {}): { key: string; incidents: string[]; summary: string } | undefined {
  const due = activeFailures(state).filter((x) => x.status === "unresolved" && !Object.hasOwn(state.delivered, x.id) &&
    (options.terminal || (x.category === "observation-incomplete" ? !options.deferObservationGaps
      : requiresAction(x) && now - x.firstObservedAt >= (options.graceMs ?? 60_000))));
  if (!due.length) return undefined;
  const incidents = due.map((x) => x.id).sort();
  return { key: failureIdentity(incidents), incidents,
    summary: due.map((x) => x.summary).join("; ").slice(0, 800) };
}
function storageProblem(state: FailureState, summary: string): FailureState {
  return reduceFailure(state, { id: failureIdentity("storage", summary), operation: "failure-observation-storage",
    kind: "incomplete", summary }, Date.now());
}
/** Append-only journal: individual bounded writes avoid lost read/modify/write snapshots. */
interface PendingRecord { event: FailureEvent; observedAt: number }
const pendingWrites = new Map<string, PendingRecord[]>();
const knownJournals = new Map<string, number>();
function appendRecord(path: string, record: PendingRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  // A durable existence marker distinguishes a lost journal from a run that has
  // never observed a failure, including after a process restart.
  try { closeSync(openSync(`${path}.observed`, "wx", 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  appendFileSync(path, "\n" + JSON.stringify(record) + "\n", { mode: 0o600 });
}
/** Retry unpersisted evidence and receipts on every observation/read. Pending
 * receipts count as handed off in this process, preventing notification storms. */
export function readFailureState(path: string): FailureState {
  const pending = pendingWrites.get(path);
  while (pending?.length) {
    try { appendRecord(path, pending[0]!); pending.shift(); }
    catch { break; }
  }
  if (!pending?.length) pendingWrites.delete(path);
  let state = readStoredState(path);
  const remaining = pendingWrites.get(path);
  for (const record of remaining ?? []) state = reduceFailure(state, record.event, record.observedAt);
  return remaining?.length ? storageProblem(state, "Failure evidence could not be persisted") : state;
}
function readStoredState(path: string): FailureState {
  let source: string;
  try { source = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !knownJournals.has(path) && !existsSync(`${path}.observed`)) return emptyFailureState();
    return storageProblem(emptyFailureState(), "Failure journal could not be read");
  }
  const bytes = Buffer.byteLength(source);
  const truncated = bytes < (knownJournals.get(path) ?? 0);
  if (bytes || knownJournals.has(path)) knownJournals.set(path, bytes);
  let state = truncated ? storageProblem(emptyFailureState(), "Failure journal was truncated; observations may be incomplete") : emptyFailureState();
  for (const line of source.split("\n")) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      const e = row.event;
      if (!e || typeof e.id !== "string" || !e.id || typeof e.operation !== "string" || !e.operation ||
          (e.expected !== undefined && typeof e.expected !== "boolean") ||
          !["failure", "incomplete", "recovered", "delivered", "disposition"].includes(e.kind) ||
          (e.disposition !== undefined && !INCIDENT_DISPOSITIONS.includes(e.disposition)) ||
          !Number.isFinite(row.observedAt) || Math.abs(row.observedAt) > 8.64e15 ||
          (e.at !== undefined && (!Number.isFinite(e.at) || Math.abs(e.at) > 8.64e15)) ||
          (e.incidents !== undefined && (!Array.isArray(e.incidents) || !e.incidents.every((id: unknown) => typeof id === "string"))) ||
          [e.summary, e.category, e.evidence, e.reason].some((v) => v !== undefined && typeof v !== "string")) throw new Error("invalid record");
      state = reduceFailure(state, e, row.observedAt);
    } catch { state = storageProblem(state, "Failure journal contains unreadable records; observations may be incomplete"); }
  }
  if (truncated) {
    const summary = "Failure journal was truncated; observations may be incomplete";
    const record: PendingRecord = { event: { id: failureIdentity("storage", summary), operation: "failure-observation-storage", kind: "incomplete", summary }, observedAt: Date.now() };
    try { appendRecord(path, record); }
    catch { pendingWrites.set(path, [...(pendingWrites.get(path) ?? []), record]); }
  }
  return state;
}
export function observeFailures(path: string, events: readonly FailureEvent[], now = Date.now()): FailureState {
  let state = readFailureState(path);
  for (const raw of events) {
    if (state.seen.includes(raw.id)) continue;
    if (raw.kind === "recovered") {
      const prior = state.observations[failureIdentity(raw.operation)];
      if (!prior || prior.status !== "unresolved" || !raw.incidents?.includes(prior.id)) continue;
    }
    // Rejected dispositions are never journaled or marked seen.
    if (raw.kind === "disposition" && validateDisposition(state, raw)) continue;
    const event = { ...raw, ...(raw.summary ? { summary: text(raw.summary, "") } : {}),
      ...(raw.evidence ? { evidence: text(raw.evidence, "") } : {}), ...(raw.reason ? { reason: text(raw.reason, "") } : {}) };
    try {
      if (pendingWrites.has(path)) throw new Error("Earlier evidence is awaiting persistence");
      appendRecord(path, { event, observedAt: now });
      state = reduceFailure(state, event, now);
    } catch {
      const pending = pendingWrites.get(path) ?? [];
      pending.push({ event, observedAt: now });
      pendingWrites.set(path, pending);
      state = storageProblem(reduceFailure(state, event, now), "Failure evidence could not be persisted");
    }
  }
  return state;
}
export function failureAttentionHandled(state: FailureState, incidents: readonly string[]): boolean {
  return incidents.every((id) => {
    if (Object.hasOwn(state.delivered, id) || Object.hasOwn(state.resolved ?? {}, id)) return true;
    const observation = Object.values(state.observations).find((item) => item.id === id);
    if (!observation) throw new Error("Failure incident evidence is unavailable; defer notification delivery");
    return observation.status !== "unresolved";
  });
}
export function markFailureAttentionDelivered(path: string, pending: { key: string; incidents: string[] }, at = Date.now()): FailureState {
  return observeFailures(path, [{ id: `delivered:${pending.key}`, operation: "attention-delivery", kind: "delivered", incidents: pending.incidents }], at);
}
export interface DispositionResult { accepted: boolean; error?: string; state: FailureState }
/**
 * Append one explicit disposition. Validation happens before the journal write; a rejected
 * request (unknown, already disposed, missing reason or evidence) writes nothing. Replaying an
 * already accepted event id is an idempotent success.
 */
export function disposeIncidents(path: string, event: FailureEvent, now = Date.now()): DispositionResult {
  const state = readFailureState(path);
  if (event.kind !== "disposition") return { accepted: false, error: "Not a disposition event", state };
  if (state.seen.includes(event.id)) return { accepted: true, state };
  const error = validateDisposition(state, event);
  if (error) return { accepted: false, error, state };
  const next = observeFailures(path, [event], now);
  return next.seen.includes(event.id) ? { accepted: true, state: next } : { accepted: false, error: "Disposition was not recorded", state: next };
}
