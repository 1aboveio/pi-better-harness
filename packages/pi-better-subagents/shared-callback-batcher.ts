// Generated from packages/callback-batcher/index.ts. Do not edit directly.
export type CallbackSource = "subagent" | "background-task";
export type CallbackDetailTool = "subagent_result" | "bg_task_status";

export interface CallbackBatchHost {
  sendMessage(
    message: { customType: string; content: string; display: boolean },
    options: Record<string, unknown>,
  ): unknown;
}

export interface CallbackBatchEvent {
  source: CallbackSource;
  id: string;
  label: string;
  status: string;
  detailTool: CallbackDetailTool;
  callback?: boolean;
  /** Lifecycle/work outcome; independent of semantic task correctness. */
  outcome?: string;
  /**
   * Legacy single-string failure summary already reduced by the observation
   * owner. Prefer `failureRows` so shown/omitted incidents are counted exactly.
   */
  failure?: string;
  /** One row per active incident, priority order (failure-observations formatFailureLines). */
  failureRows?: string[];
  /** Matched-condition, stop-error, or observation-gap facts. */
  decision?: string;
  /** Active incidents for this row. Defaults to `failureRows.length`. */
  incidentCount?: number;
  /**
   * Legacy: incidents the caller already knows are not in `failure`. Ignored
   * when `failureRows` is given, because the batch then counts rows it shows.
   */
  omittedIncidents?: number;
  isDelivered?: () => boolean;
  getSuppressionReason?: () => string | undefined;
  onDelivered?: (at: number) => void;
  onSuppressed?: (reason: string, at: number) => void;
}

export interface UrgentCallbackEvent {
  source: CallbackSource;
  /** Notification identity (dedupe/receipts). */
  id: string;
  /** Retrieval identity for the inspect tool when it differs from `id`. */
  inspectId?: string;
  label: string;
  status: "orphaned" | "lost" | string;
  customType: string;
  /** Explanation text (health transition, attention reason). */
  content: string;
  detailTool?: CallbackDetailTool;
  /** One row per active incident, priority order. */
  failureRows?: string[];
  incidentCount?: number;
  /** Legacy: ignored when `failureRows` is given. */
  omittedIncidents?: number;
  isDelivered?: () => boolean;
  getSuppressionReason?: () => string | undefined;
  onDelivered?: (at: number) => void;
  onSuppressed?: (reason: string, at: number) => void;
}

export interface CallbackBatcherOptions {
  windowMs?: number;
  retryMs?: number;
  /** UTF-8 byte cap for one sendMessage payload. Defaults to 2 KiB. */
  maxBytes?: number;
}

export interface CallbackBatcher {
  enqueue(event: CallbackBatchEvent): boolean;
  flush(): Promise<boolean>;
  deliverUrgent(event: UrgentCallbackEvent): boolean | Promise<boolean>;
  cancel(): void;
  pendingCount(): number;
}

export interface CallbackBatchFormatOptions {
  maxBytes?: number;
}

export interface FormattedCallbackBatch {
  text: string;
  represented: CallbackBatchEvent[];
  omitted: number;
}

interface PendingEvent {
  event: CallbackBatchEvent;
  sequence: number;
}

interface SharedCallbackBatcherState {
  byHost: WeakMap<object, CallbackBatcher>;
}

const GLOBAL_STATE_KEY = Symbol.for("@1aboveio/pi-better-harness/callback-batcher");
const DEFAULT_WINDOW_MS = 100;
const DEFAULT_RETRY_MS = 1_000;
const MAX_LABEL_BYTES = 160;
const MAX_ID_BYTES = 200;
/**
 * Status field bound. Long statuses keep whole `; `-separated notes and say
 * how many were left out, instead of cutting mid-word (#323).
 */
const MAX_STATUS_BYTES = 160;
const MAX_FAILURE_BYTES = 400;
const MAX_DECISION_BYTES = 400;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

/** OUTPUT-POLICY default: UTF-8 bytes of one model-facing callback batch. */
export const CALLBACK_BATCH_BUDGET_BYTES = 2 * 1024;
/** Documented hard cap. Explicit larger pages clamp here. */
export const CALLBACK_BATCH_MAX_BYTES = 8 * 1024;

const RETRIEVAL_FOOTER =
  "Retrieve durable results/status with the listed tools using cursor/limit. Full results and logs are intentionally omitted.";

export const CALLBACK_BATCH_WINDOW_ENV = "PI_BETTER_CALLBACK_BATCH_MS";
export const DEFAULT_CALLBACK_BATCH_WINDOW_MS = DEFAULT_WINDOW_MS;

export function resolveCallbackBatchWindowMs(
  value: unknown = process.env[CALLBACK_BATCH_WINDOW_ENV],
): number {
  if (value === undefined || value === null || value === "") return DEFAULT_WINDOW_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_WINDOW_MS;
  return Math.max(0, Math.min(5_000, Math.floor(parsed)));
}

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

export function callbackBatchBudget(requested?: unknown): number {
  const parsed = typeof requested === "number" ? requested
    : typeof requested === "string" && requested.trim() !== "" ? Number(requested)
    : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return CALLBACK_BATCH_BUDGET_BYTES;
  return Math.min(Math.max(1, Math.floor(parsed)), CALLBACK_BATCH_MAX_BYTES);
}

function completeUtf8End(bytes: Uint8Array, to: number): number {
  if (to <= 0) return 0;
  if (to >= bytes.length) return bytes.length;
  let seqStart = to - 1;
  while (seqStart > 0 && (bytes[seqStart]! & 0xc0) === 0x80) seqStart -= 1;
  if ((bytes[seqStart]! & 0xc0) === 0x80) return to;
  const lead = bytes[seqStart]!;
  const needed = lead <= 0x7f ? 1
    : (lead & 0xe0) === 0xc0 ? 2
    : (lead & 0xf0) === 0xe0 ? 3
    : (lead & 0xf8) === 0xf0 ? 4
    : 1;
  return seqStart + needed > to ? seqStart : to;
}

function clipUtf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  return decoder.decode(bytes.subarray(0, completeUtf8End(bytes, Math.min(maxBytes, bytes.byteLength))));
}

function boundedField(value: unknown, maxBytes: number): string {
  const oneLine = String(value ?? "").replace(/\s+/g, " ").trim();
  if (utf8ByteLength(oneLine) <= maxBytes) return oneLine;
  const ellipsis = "...";
  return `${clipUtf8Prefix(oneLine, Math.max(0, maxBytes - utf8ByteLength(ellipsis)))}${ellipsis}`;
}

/**
 * The status field under MAX_STATUS_BYTES without losing meaning: the leading
 * lifecycle note is always kept, later `; `-separated notes are kept whole
 * while they fit, and anything left out is named with a count and the inspect
 * tool rather than an ellipsis.
 */
function boundedStatus(value: unknown): string {
  const status = String(value ?? "").replace(/\s+/g, " ").trim();
  if (utf8ByteLength(status) <= MAX_STATUS_BYTES) return status;
  const notes = status.split(/;\s+/).filter(Boolean);
  const omission = (count: number) => ` (+${count} more status note${count === 1 ? "" : "s"}; see inspect)`;
  const reserve = utf8ByteLength(omission(notes.length));
  let kept = notes[0] ?? "";
  if (utf8ByteLength(kept) + reserve > MAX_STATUS_BYTES) {
    const suffix = " (clipped; see inspect)";
    return `${clipUtf8Prefix(kept, MAX_STATUS_BYTES - utf8ByteLength(suffix))}${suffix}`;
  }
  let count = 1;
  for (const note of notes.slice(1)) {
    const next = `${kept}; ${note}`;
    if (utf8ByteLength(next) + reserve > MAX_STATUS_BYTES) break;
    kept = next;
    count += 1;
  }
  return count < notes.length ? `${kept}${omission(notes.length - count)}` : kept;
}

function inspectFor(event: Pick<CallbackBatchEvent, "id" | "detailTool">): string {
  const id = boundedField(event.id, MAX_ID_BYTES);
  return event.detailTool === "bg_task_status"
    ? `bg_task_status id=${id}`
    : `subagent_result id=${JSON.stringify(id)}`;
}

interface IncidentLines {
  lines: string[];
  shown: number;
  total: number;
}

/**
 * Whole incident rows that fit `maxBytes`, one per line. A first row that does
 * not fit is shown as a clipped prefix and is NOT counted as shown.
 */
function incidentLines(rows: readonly string[], total: number, maxBytes: number, indent: string): IncidentLines {
  const lines: string[] = [];
  let used = 0;
  let shown = 0;
  for (const row of rows) {
    const line = `${indent}${String(row).replace(/\s+/g, " ").trim()}`;
    const size = utf8ByteLength(line) + 1;
    if (used + size <= maxBytes) {
      lines.push(line);
      used += size;
      shown += 1;
      continue;
    }
    if (lines.length === 0 && maxBytes - indent.length > 48) {
      lines.push(`${indent}${boundedField(row, maxBytes - utf8ByteLength(indent) - 1)} (clipped)`);
    }
    break;
  }
  return { lines, shown, total: Math.max(total, rows.length) };
}

function countsLine(incidents: IncidentLines, inspect: string): string | undefined {
  if (incidents.total <= 0) return undefined;
  const omitted = Math.max(0, incidents.total - incidents.shown);
  return `  incidents=${incidents.total} shown=${incidents.shown}` +
    (omitted > 0 ? ` omittedIncidents=${omitted} retrieve: ${inspect} (incident pages via cursor)` : "");
}

function eventIncidents(event: CallbackBatchEvent, failureBytes: number): IncidentLines {
  if (event.failureRows && event.failureRows.length) {
    return incidentLines(event.failureRows, event.incidentCount ?? event.failureRows.length, failureBytes, "  failure: ");
  }
  if (event.failure) {
    const total = event.incidentCount ?? 1;
    const whole = incidentLines([event.failure], 1, failureBytes, "  failure: ");
    const legacyShown = whole.shown ? Math.max(0, total - (event.omittedIncidents ?? 0)) : 0;
    return { lines: whole.lines, shown: legacyShown, total };
  }
  const total = event.incidentCount ?? 0;
  return { lines: [], shown: 0, total };
}

function formatRow(event: CallbackBatchEvent, detailBytes = MAX_FAILURE_BYTES + MAX_DECISION_BYTES): string {
  const source = boundedField(event.source, 40);
  const id = boundedField(event.id, MAX_ID_BYTES);
  const label = boundedField(event.label, MAX_LABEL_BYTES);
  const status = boundedStatus(event.status);
  const inspect = inspectFor(event);
  const lines = [
    `- source=${source} | id=${id} | label=${JSON.stringify(label)} | status=${status} | inspect: ${inspect}`,
  ];
  if (event.outcome) {
    const outcome = boundedField(event.outcome, 80);
    if (outcome && outcome !== status) lines.push(`  outcome=${outcome}`);
  }
  const decisionBytes = Math.min(MAX_DECISION_BYTES, Math.floor(detailBytes / 2));
  if (event.decision && decisionBytes > 24) lines.push(`  decision: ${boundedField(event.decision, decisionBytes)}`);
  const incidents = eventIncidents(event, Math.max(0, Math.min(MAX_FAILURE_BYTES * 2, detailBytes - decisionBytes)));
  lines.push(...incidents.lines);
  const counts = countsLine(incidents, inspect);
  if (counts) lines.push(counts);
  return lines.join("\n");
}

function renderBatch(represented: readonly CallbackBatchEvent[], omitted: number, detailBytes?: number): string {
  const count = represented.length;
  const heading = `${count} background completion${count === 1 ? " is" : "s are"} ready:`;
  const omittedLine = omitted > 0
    ? `${omitted} more completion${omitted === 1 ? "" : "s"} omitted from this batch (not receipted; still queued).`
    : undefined;
  return [heading, ...represented.map((event) => formatRow(event, detailBytes)), omittedLine, RETRIEVAL_FOOTER]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function clipRendered(text: string, maxBytes: number): string {
  if (utf8ByteLength(text) <= maxBytes) return text;
  const suffix = "\n[clipped to callback budget]";
  const budget = maxBytes - utf8ByteLength(suffix);
  if (budget < 24) return clipUtf8Prefix(text, maxBytes);
  return `${clipUtf8Prefix(text, budget)}${suffix}`;
}

function eventPriority(event: CallbackBatchEvent): number {
  if (event.failure || event.failureRows?.length || (event.omittedIncidents ?? 0) > 0 || (event.incidentCount ?? 0) > 0) return 0;
  if (event.decision) return 1;
  const status = String(event.status ?? "").toLowerCase();
  if (/(?:fail|orphan|lost|timed_out|timeout|unresolved|incomplete|observation incomplete)/.test(status)) return 0;
  return 2;
}

/**
 * Urgent health/failure callback under the total budget. Order: header,
 * explanation, whole incident rows that fit, the incident count line (total,
 * shown, omitted, retrieval), and the inspect line. The count and inspect
 * lines are never dropped; unshown explanation bytes are counted.
 */
export function formatUrgentCallback(
  event: UrgentCallbackEvent,
  options: CallbackBatchFormatOptions = {},
): string {
  const maxBytes = callbackBatchBudget(options.maxBytes);
  const target = event.inspectId ?? event.id;
  const id = boundedField(target, MAX_ID_BYTES);
  const label = boundedField(event.label, MAX_LABEL_BYTES);
  const status = boundedStatus(event.status);
  const tool = event.detailTool
    ?? (event.source === "background-task" ? "bg_task_status" : "subagent_result");
  const inspectTarget = tool === "bg_task_status" ? `bg_task_status id=${id}` : `subagent_result id=${JSON.stringify(id)}`;
  const inspect = `Inspect: ${inspectTarget}`;
  const header = `${boundedField(event.source, 40)} id=${id} label=${JSON.stringify(label)} status=${status}`;
  const source = String(event.content ?? "").trim();
  const rows = event.failureRows ?? [];
  const total = rows.length ? Math.max(rows.length, event.incidentCount ?? 0) : event.incidentCount ?? 0;
  const legacyOmitted = rows.length ? 0 : event.omittedIncidents ?? 0;
  const counts = (shown: number): string | undefined => {
    if (total <= 0) return undefined;
    const omitted = rows.length ? total - shown : legacyOmitted;
    const shownPart = rows.length ? ` shown=${shown}` : "";
    return `incidents=${total}${shownPart}` +
      (omitted > 0 ? ` omittedIncidents=${omitted} retrieve: ${inspectTarget} (incident pages via cursor)` : "");
  };
  const render = (body: string, note: string | undefined, shownRows: string[]): string =>
    [header, body, note, ...shownRows, counts(shownRows.length), inspect]
      .filter((part): part is string => Boolean(part && part.length > 0))
      .join("\n");
  const fixed = utf8ByteLength(render("", undefined, [])) + 16;
  const room = Math.max(0, maxBytes - fixed);
  // The explanation keeps at least half the room when incident rows compete.
  const contentShare = rows.length ? Math.floor(room / 2) : room;
  let body = source;
  let note: string | undefined;
  if (utf8ByteLength(source) > contentShare) {
    const noteFor = (omitted: number) => `omittedBytes=${omitted} retrieve: ${inspectTarget}`;
    const clipped = clipUtf8Prefix(source, Math.max(0, contentShare - utf8ByteLength(noteFor(utf8ByteLength(source))) - 1));
    body = clipped;
    note = noteFor(utf8ByteLength(source) - utf8ByteLength(clipped));
  }
  const shown: string[] = [];
  for (const row of rows) {
    const line = String(row).replace(/\s+/g, " ").trim();
    if (utf8ByteLength(render(body, note, [...shown, line])) + 8 > maxBytes) break;
    shown.push(line);
  }
  const rendered = render(body, note, shown);
  if (utf8ByteLength(rendered) <= maxBytes) return rendered;
  const minimal = render("", source ? `omittedBytes=${utf8ByteLength(source)} retrieve: ${inspectTarget}` : undefined, []);
  return clipRendered(minimal, maxBytes);
}

export function packCallbackBatch(
  events: readonly CallbackBatchEvent[],
  options: CallbackBatchFormatOptions = {},
): FormattedCallbackBatch {
  const maxBytes = callbackBatchBudget(options.maxBytes);
  if (events.length === 0) {
    return { text: renderBatch([], 0), represented: [], omitted: 0 };
  }

  const ranked = events.map((event, index) => ({ event, index }))
    .sort((a, b) => eventPriority(a.event) - eventPriority(b.event) || a.index - b.index);

  const selected = new Set<number>();
  const renderSelected = (): string => {
    const represented = events.filter((_, index) => selected.has(index));
    return renderBatch(represented, events.length - selected.size);
  };

  for (const { index } of ranked) {
    selected.add(index);
    if (utf8ByteLength(renderSelected()) <= maxBytes) continue;
    selected.delete(index);
    if (selected.size === 0) {
      // One row alone exceeds the budget: shrink its detail, never its counts.
      const event = events[index]!;
      for (const detail of [MAX_FAILURE_BYTES, 200, 0]) {
        const text = renderBatch([event], events.length - 1, detail);
        if (utf8ByteLength(text) <= maxBytes) {
          return { text, represented: [event], omitted: events.length - 1 };
        }
      }
      return {
        text: clipRendered(renderBatch([event], events.length - 1, 0), maxBytes),
        represented: [event],
        omitted: events.length - 1,
      };
    }
  }

  const represented = events.filter((_, index) => selected.has(index));
  return {
    text: renderSelected(),
    represented,
    omitted: events.length - represented.length,
  };
}

export function formatCallbackBatch(
  events: readonly CallbackBatchEvent[],
  options: CallbackBatchFormatOptions = {},
): string {
  return packCallbackBatch(events, options).text;
}

export function createCallbackBatcher(
  host: CallbackBatchHost,
  options: CallbackBatcherOptions = {},
): CallbackBatcher {
  const windowMs = options.windowMs ?? resolveCallbackBatchWindowMs();
  const retryMs = Math.max(0, options.retryMs ?? DEFAULT_RETRY_MS);
  const maxBytes = callbackBatchBudget(options.maxBytes);
  const pending = new Map<string, PendingEvent>();
  const inFlight = new Set<string>();
  const urgentInFlight = new Set<string>();
  const handedOff = new Map<string, number>();
  let sequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushPromise: Promise<boolean> | undefined;

  const cancelTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const schedule = (delayMs: number): void => {
    if (timer || pending.size === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      void api.flush();
    }, Math.max(0, delayMs));
    timer.unref?.();
  };

  const enqueue = (event: CallbackBatchEvent): boolean => {
    if (event.callback === false) return false;
    const key = eventKey(event);
    if (pending.has(key) || inFlight.has(key)) return false;
    pending.set(key, { event, sequence: sequence++ });
    schedule(windowMs);
    return true;
  };

  const performFlush = async (): Promise<boolean> => {
    cancelTimer();
    const snapshot = [...pending.entries()]
      .sort((a, b) => a[1].sequence - b[1].sequence);
    pending.clear();
    for (const [key] of snapshot) inFlight.add(key);

    const deliverable: Array<[string, PendingEvent]> = [];
    let deferred = false;
    for (const item of snapshot) {
      const [key, pendingEvent] = item;
      const priorHandoff = handedOff.get(key);
      if (priorHandoff !== undefined) {
        if (!invokeDelivered(pendingEvent.event, priorHandoff)) {
          deferred = true;
          pending.set(key, pendingEvent);
        }
        inFlight.delete(key);
        continue;
      }
      const disposition = eventDisposition(pendingEvent.event);
      if (disposition.kind === "deferred") {
        deferred = true;
        pending.set(key, pendingEvent);
        inFlight.delete(key);
        continue;
      }
      if (disposition.kind === "delivered") {
        inFlight.delete(key);
        continue;
      }
      if (disposition.kind === "suppressed") {
        invokeSuppressed(pendingEvent.event, disposition.reason, Date.now());
        inFlight.delete(key);
        continue;
      }
      deliverable.push(item);
    }

    if (deliverable.length === 0) {
      if (pending.size > 0) schedule(deferred ? retryMs : windowMs);
      return !deferred;
    }

    const packed = packCallbackBatch(deliverable.map(([, item]) => item.event), { maxBytes });
    const representedSet = new Set(packed.represented);
    const representedItems = deliverable.filter(([, item]) => representedSet.has(item.event));
    const overflowItems = deliverable.filter(([, item]) => !representedSet.has(item.event));

    try {
      await host.sendMessage(
        {
          customType: "background-completion-batch",
          content: packed.text,
          display: true,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch {
      for (const [key] of deliverable) inFlight.delete(key);
      const retryItems = [...deliverable, ...pending.entries()]
        .sort((a, b) => a[1].sequence - b[1].sequence);
      pending.clear();
      for (const [key, item] of retryItems) {
        if (!pending.has(key)) pending.set(key, item);
      }
      schedule(retryMs);
      return false;
    }

    const deliveredAt = Date.now();
    for (const [key, item] of representedItems) {
      handedOff.set(key, deliveredAt);
      if (!invokeDelivered(item.event, deliveredAt)) {
        deferred = true;
        pending.set(key, item);
      }
      inFlight.delete(key);
    }
    for (const [key, item] of overflowItems) {
      pending.set(key, item);
      inFlight.delete(key);
    }
    if (pending.size > 0) schedule(deferred ? retryMs : windowMs);
    return !deferred;
  };

  const flush = (): Promise<boolean> => {
    if (flushPromise) return flushPromise;
    flushPromise = performFlush().finally(() => {
      flushPromise = undefined;
    });
    return flushPromise;
  };

  const deliverUrgent = (event: UrgentCallbackEvent): boolean | Promise<boolean> => {
    const key = eventKey(event);
    if (urgentInFlight.has(key)) return false;
    const priorHandoff = handedOff.get(key);
    if (priorHandoff !== undefined) return invokeDelivered(event, priorHandoff);
    const acknowledge = (): boolean => {
      const at = Date.now();
      handedOff.set(key, at);
      return invokeDelivered(event, at);
    };
    const disposition = eventDisposition(event);
    if (disposition.kind === "deferred") return false;
    if (disposition.kind === "delivered") return true;
    if (disposition.kind === "suppressed") {
      invokeSuppressed(event, disposition.reason, Date.now());
      return true;
    }

    urgentInFlight.add(key);
    try {
      const handoff = host.sendMessage(
        { customType: event.customType, content: formatUrgentCallback(event, { maxBytes }), display: true },
        { deliverAs: "followUp", triggerTurn: true },
      );
      if (isPromiseLike(handoff)) {
        return Promise.resolve(handoff).then(
          () => acknowledge(),
          () => false,
        ).finally(() => urgentInFlight.delete(key));
      }
      const acknowledged = acknowledge();
      urgentInFlight.delete(key);
      return acknowledged;
    } catch {
      urgentInFlight.delete(key);
      return false;
    }
  };

  const api: CallbackBatcher = {
    enqueue,
    flush,
    deliverUrgent,
    cancel() {
      cancelTimer();
      pending.clear();
    },
    pendingCount() {
      return pending.size;
    },
  };
  return api;
}

export function getCallbackBatcher(
  host: CallbackBatchHost,
  options: CallbackBatcherOptions = {},
): CallbackBatcher {
  const state = globalState();
  const key = host as object;
  const existing = state.byHost.get(key);
  if (existing) return existing;
  const created = createCallbackBatcher(host, options);
  state.byHost.set(key, created);
  return created;
}

export function cancelCallbackBatch(host: CallbackBatchHost): void {
  globalState().byHost.get(host as object)?.cancel();
}

function globalState(): SharedCallbackBatcherState {
  const root = globalThis as typeof globalThis & {
    [GLOBAL_STATE_KEY]?: SharedCallbackBatcherState;
  };
  root[GLOBAL_STATE_KEY] ??= { byHost: new WeakMap<object, CallbackBatcher>() };
  return root[GLOBAL_STATE_KEY];
}

function eventKey(event: Pick<CallbackBatchEvent, "source" | "id" | "status">): string {
  return `${event.source}\u0000${event.id}\u0000${event.status}`;
}

function eventDisposition(
  event: Pick<CallbackBatchEvent, "isDelivered" | "getSuppressionReason">,
):   | { kind: "deliver" } | { kind: "delivered" } | { kind: "deferred" } | { kind: "suppressed"; reason: string } {
  try {
    if (event.isDelivered?.()) return { kind: "delivered" };
  } catch {
    return { kind: "deferred" };
  }
  try {
    const reason = event.getSuppressionReason?.();
    return reason ? { kind: "suppressed", reason } : { kind: "deliver" };
  } catch {
    return { kind: "deferred" };
  }
}

function invokeDelivered(
  event: Pick<CallbackBatchEvent, "onDelivered">,
  at: number,
): boolean {
  try { event.onDelivered?.(at); return true; } catch { return false; }
}

function invokeSuppressed(
  event: Pick<CallbackBatchEvent, "onSuppressed">,
  reason: string,
  at: number,
): void {
  try { event.onSuppressed?.(reason, at); } catch { /* best effort durable suppression */ }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" || typeof value === "function")
    && value !== null
    && typeof (value as PromiseLike<unknown>).then === "function";
}
