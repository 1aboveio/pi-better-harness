// Generated from packages/failure-observations/index.ts. Do not edit directly.
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
  represented: number;
  omitted: number;
  cursor: string;
  nextCursor: string;
  hasMore: boolean;
  reset?: "stale-cursor" | "source-replaced";
}

function incidentRevision(state: FailureState): string {
  return failureIdentity(activeFailures(state).map((item) => [item.id, item.status, item.count, item.summary]));
}

function encodeIncidentCursor(offset: number, revision: string, total: number): string {
  return INCIDENT_CURSOR_PREFIX + Buffer.from(JSON.stringify({ k: "i", o: offset, v: revision, n: total }), "utf8").toString("base64url");
}

function decodeIncidentCursor(cursor: string | undefined): { o: number; v: string; n: number } | undefined {
  if (!cursor || !cursor.startsWith(INCIDENT_CURSOR_PREFIX)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor.slice(INCIDENT_CURSOR_PREFIX.length), "base64url").toString("utf8")) as { k?: string; o?: number; v?: string; n?: number };
    if (parsed?.k === "i" && typeof parsed.v === "string") {
      return { o: Math.max(0, Math.floor(parsed.o ?? 0)), v: parsed.v, n: Math.max(0, Math.floor(parsed.n ?? 0)) };
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

/** Caller-owned incident pages. Consecutive pages concatenate to formatFailureLines(). */
export function pageFailureIncidents(state: FailureState, request: { cursor?: string; maxBytes?: number } = {}): FailureIncidentPage {
  const lines = formatFailureLines(state);
  const revision = incidentRevision(state);
  const total = lines.length;
  let offset = 0;
  let reset: FailureIncidentPage["reset"];
  if (request.cursor) {
    const parsed = decodeIncidentCursor(request.cursor);
    if (!parsed) reset = "stale-cursor";
    else if (parsed.v !== revision) reset = "source-replaced";
    else offset = Math.min(total, parsed.o);
  }
  const maxBytes = Number.isFinite(request.maxBytes) && (request.maxBytes ?? 0) > 0
    ? Math.floor(request.maxBytes as number)
    : 2 * 1024;
  const included: string[] = [];
  for (let i = offset; i < lines.length; i += 1) {
    const row = lines[i]!;
    const candidate = included.length ? `${included.join("\n")}\n${row}` : row;
    if (utf8Length(candidate) <= maxBytes) {
      included.push(row);
      continue;
    }
    if (included.length === 0) {
      // One incident always makes forward progress so reconstruction does not skip it.
      included.push(row);
    }
    break;
  }
  const represented = included.length;
  const nextOffset = Math.min(total, offset + represented);
  return {
    text: included.join("\n"),
    total,
    represented,
    omitted: Math.max(0, total - nextOffset),
    cursor: encodeIncidentCursor(offset, revision, total),
    nextCursor: encodeIncidentCursor(nextOffset, revision, total),
    hasMore: nextOffset < total,
    ...(reset ? { reset } : {}),
  };
}

export function incidentCursorAt(state: FailureState, offset: number): string {
  const lines = formatFailureLines(state);
  return encodeIncidentCursor(Math.max(0, Math.floor(offset)), incidentRevision(state), lines.length);
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
