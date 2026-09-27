import { appendFileSync, closeSync, existsSync, openSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

export interface FailureEvent {
  /** Stable source event identity: replay must reuse this id. */
  id: string;
  operation: string;
  kind: "failure" | "recovered" | "incomplete" | "delivered";
  /** Event time when known; never fabricate it from log mtime. */
  at?: number;
  summary?: string;
  category?: string;
  evidence?: string;
  expected?: boolean;
  /** Recovery/delivery must name the incidents it resolves/delivers. */
  incidents?: string[];
}
export interface FailureObservation {
  id: string;
  operation: string;
  status: "unresolved" | "expected" | "resolved";
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
}
export interface FailureState {
  version: 1;
  seen: string[];
  observations: Record<string, FailureObservation>;
  delivered: Record<string, number>;
  resolved?: Record<string, number>;
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
/** Pure transition. Lifecycle is deliberately not an input or an output. */
export function reduceFailure(state: FailureState, event: FailureEvent, observedAt: number): FailureState {
  if (state.seen.includes(event.id)) return state;
  const next: FailureState = { ...state, seen: [...state.seen, event.id],
    observations: { ...state.observations }, delivered: { ...state.delivered } };
  if (event.kind === "delivered") {
    for (const id of event.incidents ?? []) next.delivered = { ...next.delivered, [id]: observedAt };
    return next;
  }
  const key = failureIdentity(event.operation);
  const previous = state.observations[key];
  if (event.kind === "recovered") {
    if (previous && event.incidents?.includes(previous.id)) {
      next.observations[key] = { ...previous, status: "resolved", resolvedAt: event.at ?? observedAt };
      next.resolved = { ...state.resolved, [previous.id]: event.at ?? observedAt };
    }
    return next;
  }
  const active = previous && previous.status !== "resolved" &&
    !(previous.status === "expected" && !event.expected);
  next.observations[key] = {
    id: active ? previous.id : event.id, operation: event.operation,
    status: active ? previous.status : event.expected ? "expected" : "unresolved",
    category: event.kind === "incomplete" ? "observation-incomplete" : event.category ?? "operation",
    summary: text(event.summary, "Operation failed"), evidence: event.evidence,
    firstObservedAt: active ? previous.firstObservedAt : observedAt,
    lastObservedAt: observedAt, lastSequence: next.seen.length, at: event.at,
    count: active ? previous.count + 1 : 1,
  };
  return next;
}
export function activeFailures(state: FailureState): FailureObservation[] {
  const priority = (x: FailureObservation) => x.status === "expected" ? 2 : x.category === "observation-incomplete" ? 0 : 1;
  return Object.values(state.observations).filter((x) => x.status !== "resolved")
    .sort((a, b) => priority(a) - priority(b) || (b.lastSequence ?? 0) - (a.lastSequence ?? 0) || b.lastObservedAt - a.lastObservedAt);
}
const INCIDENT_CURSOR_PREFIX = "i1.";
const encoder = new TextEncoder();

function failureRow(x: FailureObservation): string {
  const label = x.status === "expected" ? "Expected failure" :
    x.category === "observation-incomplete" ? "Observation incomplete" : "Unresolved failure";
  const time = x.at === undefined ? `observed ${new Date(x.firstObservedAt).toISOString()}` : new Date(x.at).toISOString();
  return `${label} · ${time} · ${x.summary}${x.count > 1 ? ` (${x.count} occurrences)` : ""}${x.evidence ? ` · evidence: ${text(x.evidence, "")}` : ""}`;
}

/** Every active incident as a priority row. Consumers page these; they are not a lossy summary. */
export function formatFailureLines(state: FailureState): string[] {
  return activeFailures(state).map(failureRow);
}

/** Shared priority text, placed BEFORE assistant progress on every consumer surface. */
export function formatFailureSummary(state: FailureState): string {
  const lines = formatFailureLines(state);
  if (!lines.length) return "";
  const rows = lines.slice(0, 5);
  if (lines.length > 5) rows.push(`${lines.length - 5} additional active failure observations retained in the failure journal.`);
  return rows.join("\n");
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
    if (overflow <= 0 || rowBudget <= 0) {
      return { text, total: page.total, represented: page.represented, omitted: page.omitted, nextCursor: page.nextCursor };
    }
    rowBudget -= overflow;
  }
  const empty = pageFailureIncidents(state, { maxBytes: 0, resource: options.resource });
  return { text: header(empty), total: empty.total, represented: 0, omitted: empty.total, nextCursor: empty.nextCursor };
}
export function pendingFailureAttention(state: FailureState, now: number, options: { terminal?: boolean; graceMs?: number } = {}): { key: string; incidents: string[]; summary: string } | undefined {
  const due = activeFailures(state).filter((x) => x.status === "unresolved" && !Object.hasOwn(state.delivered, x.id) &&
    (options.terminal || x.category === "observation-incomplete" || now - x.firstObservedAt >= (options.graceMs ?? 60_000)));
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
          !["failure", "incomplete", "recovered", "delivered"].includes(e.kind) ||
          !Number.isFinite(row.observedAt) || Math.abs(row.observedAt) > 8.64e15 ||
          (e.at !== undefined && (!Number.isFinite(e.at) || Math.abs(e.at) > 8.64e15)) ||
          (e.incidents !== undefined && (!Array.isArray(e.incidents) || !e.incidents.every((id: unknown) => typeof id === "string"))) ||
          [e.summary, e.category, e.evidence].some((v) => v !== undefined && typeof v !== "string")) throw new Error("invalid record");
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
      if (!prior || prior.status === "resolved" || !raw.incidents?.includes(prior.id)) continue;
    }
    const event = { ...raw, ...(raw.summary ? { summary: text(raw.summary, "") } : {}),
      ...(raw.evidence ? { evidence: text(raw.evidence, "") } : {}) };
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
