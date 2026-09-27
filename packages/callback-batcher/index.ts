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
  /** Structured failure summary already reduced by the observation owner. */
  failure?: string;
  /** Matched-condition, stop-error, or observation-gap facts. */
  decision?: string;
  /** Active incidents represented (or counted) on this row. */
  incidentCount?: number;
  /**
   * Incidents omitted from this row's text but still retained.
   * Counted here so a receipt may record the row without claiming those
   * incidents were fully inlined.
   */
  omittedIncidents?: number;
  isDelivered?: () => boolean;
  getSuppressionReason?: () => string | undefined;
  onDelivered?: (at: number) => void;
  onSuppressed?: (reason: string, at: number) => void;
}

export interface UrgentCallbackEvent {
  source: CallbackSource;
  id: string;
  label: string;
  status: "orphaned" | "lost" | string;
  customType: string;
  content: string;
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
const MAX_STATUS_BYTES = 80;
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

function clipUtf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  let end = Math.min(maxBytes, bytes.byteLength);
  while (end > 0 && (bytes[end - 1]! & 0xc0) === 0x80) end -= 1;
  if (end > 0) {
    const lead = bytes[end - 1]!;
    const needed = lead <= 0x7f ? 1
      : (lead & 0xe0) === 0xc0 ? 2
      : (lead & 0xf0) === 0xe0 ? 3
      : (lead & 0xf8) === 0xf0 ? 4
      : 1;
    if (end - 1 + needed > maxBytes) end -= 1;
  }
  return decoder.decode(bytes.subarray(0, end));
}

function boundedField(value: unknown, maxBytes: number): string {
  const oneLine = String(value ?? "").replace(/\s+/g, " ").trim();
  if (utf8ByteLength(oneLine) <= maxBytes) return oneLine;
  const ellipsis = "...";
  return `${clipUtf8Prefix(oneLine, Math.max(0, maxBytes - utf8ByteLength(ellipsis)))}${ellipsis}`;
}

function inspectFor(event: CallbackBatchEvent): string {
  const id = boundedField(event.id, MAX_ID_BYTES);
  return event.detailTool === "bg_task_status"
    ? `bg_task_status id=${id}`
    : `subagent_result id=${JSON.stringify(id)}`;
}

function formatRow(event: CallbackBatchEvent): string {
  const source = boundedField(event.source, 40);
  const id = boundedField(event.id, MAX_ID_BYTES);
  const label = boundedField(event.label, MAX_LABEL_BYTES);
  const status = boundedField(event.status, MAX_STATUS_BYTES);
  const lines = [
    `- source=${source} | id=${id} | label=${JSON.stringify(label)} | status=${status} | inspect: ${inspectFor(event)}`,
  ];
  if (event.outcome) {
    const outcome = boundedField(event.outcome, 80);
    if (outcome && outcome !== status) lines.push(`  outcome=${outcome}`);
  }
  if (event.failure) lines.push(`  failure: ${boundedField(event.failure, MAX_FAILURE_BYTES)}`);
  if (event.decision) lines.push(`  decision: ${boundedField(event.decision, MAX_DECISION_BYTES)}`);
  if (event.incidentCount && event.incidentCount > 0) {
    lines.push(`  incidents=${event.incidentCount}`);
  }
  if (event.omittedIncidents && event.omittedIncidents > 0) {
    lines.push(`  omittedIncidents=${event.omittedIncidents} (counted; inspect with cursor/limit)`);
  }
  return lines.join("\n");
}

function renderBatch(represented: readonly CallbackBatchEvent[], omitted: number): string {
  const count = represented.length;
  const heading = `${count} background completion${count === 1 ? " is" : "s are"} ready:`;
  const omittedLine = omitted > 0
    ? `${omitted} more completion${omitted === 1 ? "" : "s"} omitted from this batch (not receipted; still queued).`
    : undefined;
  return [heading, ...represented.map(formatRow), omittedLine, RETRIEVAL_FOOTER]
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
  if (event.failure || (event.omittedIncidents ?? 0) > 0 || (event.incidentCount ?? 0) > 0) return 0;
  if (event.decision) return 1;
  const status = String(event.status ?? "").toLowerCase();
  if (/(?:fail|orphan|lost|timed_out|timeout|unresolved|incomplete|observation incomplete)/.test(status)) return 0;
  return 2;
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
      selected.add(index);
      const represented = [events[index]!];
      return {
        text: clipRendered(renderBatch(represented, events.length - 1), maxBytes),
        represented,
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
        { customType: event.customType, content: event.content, display: true },
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
