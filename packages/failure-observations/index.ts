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
/** Shared priority text, placed BEFORE assistant progress on every consumer surface. */
export function formatFailureSummary(state: FailureState): string {
  const failures = activeFailures(state);
  if (!failures.length) return "";
  const rows = failures.slice(0, 5).map((x) => {
    const label = x.status === "expected" ? "Expected failure" :
      x.category === "observation-incomplete" ? "Observation incomplete" : "Unresolved failure";
    const time = x.at === undefined ? `observed ${new Date(x.firstObservedAt).toISOString()}` : new Date(x.at).toISOString();
    return `${label} · ${time} · ${x.summary}${x.count > 1 ? ` (${x.count} occurrences)` : ""}${x.evidence ? ` · evidence: ${text(x.evidence, "")}` : ""}`;
  });
  if (failures.length > 5) rows.push(`${failures.length - 5} additional active failure observations retained in the failure journal.`);
  return rows.join("\n");
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
