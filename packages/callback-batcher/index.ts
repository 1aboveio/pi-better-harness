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
}

export interface CallbackBatcher {
  enqueue(event: CallbackBatchEvent): boolean;
  flush(): Promise<boolean>;
  deliverUrgent(event: UrgentCallbackEvent): boolean | Promise<boolean>;
  cancel(): void;
  pendingCount(): number;
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
const MAX_LABEL_CHARS = 160;
const MAX_ID_CHARS = 200;
const MAX_STATUS_CHARS = 80;

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

export function formatCallbackBatch(events: readonly CallbackBatchEvent[]): string {
  const count = events.length;
  const heading = `${count} background completion${count === 1 ? " is" : "s are"} ready:`;
  const rows = events.map((event) => {
    const source = boundedField(event.source, 40);
    const id = boundedField(event.id, MAX_ID_CHARS);
    const label = boundedField(event.label, MAX_LABEL_CHARS);
    const status = boundedField(event.status, MAX_STATUS_CHARS);
    const detail = event.detailTool === "bg_task_status"
      ? `bg_task_status id=${id}`
      : `subagent_result id=${JSON.stringify(id)}`;
    return `- source=${source} | id=${id} | label=${JSON.stringify(label)} | status=${status} | inspect: ${detail}`;
  });
  return [
    heading,
    ...rows,
    "Retrieve durable results/status with the listed tools. Full results and logs are intentionally omitted.",
  ].join("\n");
}

export function createCallbackBatcher(
  host: CallbackBatchHost,
  options: CallbackBatcherOptions = {},
): CallbackBatcher {
  const windowMs = options.windowMs ?? resolveCallbackBatchWindowMs();
  const retryMs = Math.max(0, options.retryMs ?? DEFAULT_RETRY_MS);
  const pending = new Map<string, PendingEvent>();
  const inFlight = new Set<string>();
  const urgentInFlight = new Set<string>();
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
    for (const item of snapshot) {
      const [key, pendingEvent] = item;
      const disposition = eventDisposition(pendingEvent.event);
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
      if (pending.size > 0) schedule(windowMs);
      return true;
    }

    try {
      await host.sendMessage(
        {
          customType: "background-completion-batch",
          content: formatCallbackBatch(deliverable.map(([, item]) => item.event)),
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
    for (const [key, item] of deliverable) {
      invokeDelivered(item.event, deliveredAt);
      inFlight.delete(key);
    }
    if (pending.size > 0) schedule(windowMs);
    return true;
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
    const disposition = eventDisposition(event);
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
          () => {
            invokeDelivered(event, Date.now());
            return true;
          },
          () => false,
        ).finally(() => urgentInFlight.delete(key));
      }
      invokeDelivered(event, Date.now());
      urgentInFlight.delete(key);
      return true;
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
): { kind: "deliver" } | { kind: "delivered" } | { kind: "suppressed"; reason: string } {
  try {
    if (event.isDelivered?.()) return { kind: "delivered" };
  } catch {
    return { kind: "suppressed", reason: "durable delivery state could not be verified" };
  }
  try {
    const reason = event.getSuppressionReason?.();
    return reason ? { kind: "suppressed", reason } : { kind: "deliver" };
  } catch {
    return { kind: "suppressed", reason: "callback ownership could not be verified" };
  }
}

function invokeDelivered(
  event: Pick<CallbackBatchEvent, "onDelivered">,
  at: number,
): void {
  try { event.onDelivered?.(at); } catch { /* handoff already succeeded */ }
}

function invokeSuppressed(
  event: Pick<CallbackBatchEvent, "onSuppressed">,
  reason: string,
  at: number,
): void {
  try { event.onSuppressed?.(reason, at); } catch { /* best effort durable suppression */ }
}

function boundedField(value: unknown, maxChars: number): string {
  const oneLine = String(value ?? "").replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxChars) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxChars - 3))}...`;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" || typeof value === "function")
    && value !== null
    && typeof (value as PromiseLike<unknown>).then === "function";
}
