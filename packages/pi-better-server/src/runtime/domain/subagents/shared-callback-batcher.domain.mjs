// Generated fixed launch domain from packages/pi-better-subagents/shared-callback-batcher.ts. Do not edit directly.
// Generated from packages/callback-batcher/index.ts. Do not edit directly.
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { harnessSettingsPath, readHarnessSetting, updateHarnessSetting, } from "./shared-harness-settings.domain.mjs";
export const CALLBACK_SETTINGS_ENTRY = "pi-better-callback-settings";
const CALLBACK_PREFERENCES_FILE = "pi-better-callback-preferences.json";
function isDeliveryMode(mode) {
    return mode === "hold" || mode === "steer";
}
function validCallbackPreferences(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const data = value;
    return Object.keys(data).length === 2 && Object.hasOwn(data, "version") && Object.hasOwn(data, "mode")
        && data.version === 1 && isDeliveryMode(data.mode);
}
function parseCallbackPreferences(value) {
    if (!validCallbackPreferences(value))
        throw new Error('Expected { version: 1, mode: "hold" | "steer" }');
    return value;
}
function legacyCallbackPreferencesPath(seams) {
    return join((seams.agentDir ?? getAgentDir)(), "extensions", CALLBACK_PREFERENCES_FILE);
}
/** Branch history is authoritative; abandoned branches and invalid entries are ignored. */
export function getCallbackSettings(ctx, seams = {}) {
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (entry?.type === "custom" && entry.customType === CALLBACK_SETTINGS_ENTRY && validCallbackPreferences(entry.data)) {
            return { mode: entry.data.mode, source: "session" };
        }
    }
    return getSessionDefault(ctx, seams);
}
function getSessionDefault(ctx, seams) {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    const defaults = globalState().sessionDefaults ??= new WeakMap();
    const initial = ctx.sessionManager ? defaults.get(ctx.sessionManager) : undefined;
    if (initial && initial.sessionId === sessionId)
        return { mode: initial.mode, source: "default" };
    const snapshot = (mode) => {
        if (ctx.sessionManager)
            defaults.set(ctx.sessionManager, { sessionId, mode });
        return { mode, source: "default" };
    };
    const path = harnessSettingsPath(seams);
    try {
        const data = readHarnessSetting("callbacks", seams, {
            path: legacyCallbackPreferencesPath(seams),
            parse: parseCallbackPreferences,
        });
        return snapshot(data === undefined ? "hold" : parseCallbackPreferences(data).mode);
    }
    catch (error) {
        const prefix = error.code ? "Cannot read" : "Invalid";
        throw new Error(`${prefix} callback default at ${path}: ${String(error)}`, { cause: error });
    }
}
/** Saves only the future-session default; never changes the active branch or batcher. */
export function saveCallbackDefault(mode, seams = {}) {
    if (!isDeliveryMode(mode))
        throw new Error("Invalid callback delivery mode. Nothing saved.");
    const path = harnessSettingsPath(seams);
    try {
        updateHarnessSetting("callbacks", () => ({ version: 1, mode }), seams);
    }
    catch (error) {
        throw new Error(`Cannot save callback default at ${path}: ${String(error)}`, { cause: error });
    }
}
/** Persist first so a failed append cannot become a transient delivery-mode change. */
export function changeCallbackSetting(host, ctx, mode) {
    if (!isDeliveryMode(mode))
        throw new Error("Invalid callback delivery mode. Nothing changed.");
    const data = { version: 1, mode };
    try {
        host.appendEntry(CALLBACK_SETTINGS_ENTRY, data);
    }
    catch (error) {
        // Pi advances its in-memory branch before disk persistence. Invalidate
        // our payload so that failed entry cannot become a restored setting.
        data.version = 0;
        throw error;
    }
    const batcher = bindCallbackBatcher(host, ctx);
    batcher.setWhileBusy(mode);
    batcher.setAvailability(() => ctx.isIdle());
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
const RETRIEVAL_FOOTER = "Retrieve durable results/status with the listed tools using cursor/limit. Full results and logs are intentionally omitted.";
export const CALLBACK_BATCH_WINDOW_ENV = "PI_BETTER_CALLBACK_BATCH_MS";
export const DEFAULT_CALLBACK_BATCH_WINDOW_MS = DEFAULT_WINDOW_MS;
export function resolveCallbackBatchWindowMs(value = process.env[CALLBACK_BATCH_WINDOW_ENV]) {
    if (value === undefined || value === null || value === "")
        return DEFAULT_WINDOW_MS;
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return DEFAULT_WINDOW_MS;
    return Math.max(0, Math.min(5_000, Math.floor(parsed)));
}
export function utf8ByteLength(text) {
    return encoder.encode(text).byteLength;
}
export function callbackBatchBudget(requested) {
    const parsed = typeof requested === "number" ? requested
        : typeof requested === "string" && requested.trim() !== "" ? Number(requested)
            : Number.NaN;
    if (!Number.isFinite(parsed) || parsed <= 0)
        return CALLBACK_BATCH_BUDGET_BYTES;
    return Math.min(Math.max(1, Math.floor(parsed)), CALLBACK_BATCH_MAX_BYTES);
}
function completeUtf8End(bytes, to) {
    if (to <= 0)
        return 0;
    if (to >= bytes.length)
        return bytes.length;
    let seqStart = to - 1;
    while (seqStart > 0 && (bytes[seqStart] & 0xc0) === 0x80)
        seqStart -= 1;
    if ((bytes[seqStart] & 0xc0) === 0x80)
        return to;
    const lead = bytes[seqStart];
    const needed = lead <= 0x7f ? 1
        : (lead & 0xe0) === 0xc0 ? 2
            : (lead & 0xf0) === 0xe0 ? 3
                : (lead & 0xf8) === 0xf0 ? 4
                    : 1;
    return seqStart + needed > to ? seqStart : to;
}
function clipUtf8Prefix(text, maxBytes) {
    if (maxBytes <= 0)
        return "";
    const bytes = encoder.encode(text);
    if (bytes.byteLength <= maxBytes)
        return text;
    return decoder.decode(bytes.subarray(0, completeUtf8End(bytes, Math.min(maxBytes, bytes.byteLength))));
}
function boundedField(value, maxBytes) {
    const oneLine = String(value ?? "").replace(/\s+/g, " ").trim();
    if (utf8ByteLength(oneLine) <= maxBytes)
        return oneLine;
    const ellipsis = "...";
    return `${clipUtf8Prefix(oneLine, Math.max(0, maxBytes - utf8ByteLength(ellipsis)))}${ellipsis}`;
}
/**
 * The status field under MAX_STATUS_BYTES without losing meaning: the leading
 * lifecycle note is always kept, later `; `-separated notes are kept whole
 * while they fit, and anything left out is named with a count and the inspect
 * tool rather than an ellipsis.
 */
function boundedStatus(value) {
    const status = String(value ?? "").replace(/\s+/g, " ").trim();
    if (utf8ByteLength(status) <= MAX_STATUS_BYTES)
        return status;
    const notes = status.split(/;\s+/).filter(Boolean);
    const omission = (count) => ` (+${count} more status note${count === 1 ? "" : "s"}; see inspect)`;
    const reserve = utf8ByteLength(omission(notes.length));
    let kept = notes[0] ?? "";
    if (utf8ByteLength(kept) + reserve > MAX_STATUS_BYTES) {
        const suffix = " (clipped; see inspect)";
        return `${clipUtf8Prefix(kept, MAX_STATUS_BYTES - utf8ByteLength(suffix))}${suffix}`;
    }
    let count = 1;
    for (const note of notes.slice(1)) {
        const next = `${kept}; ${note}`;
        if (utf8ByteLength(next) + reserve > MAX_STATUS_BYTES)
            break;
        kept = next;
        count += 1;
    }
    return count < notes.length ? `${kept}${omission(notes.length - count)}` : kept;
}
function inspectFor(event) {
    const id = boundedField(event.inspectId ?? event.id, MAX_ID_BYTES);
    return event.detailTool === "bg_task_status"
        ? `bg_task_status id=${id}`
        : `subagent_result id=${JSON.stringify(id)}`;
}
/**
 * Whole incident rows that fit `maxBytes`, one per line. A first row that does
 * not fit is shown as a clipped prefix and is NOT counted as shown.
 */
function incidentLines(rows, total, maxBytes, indent) {
    const lines = [];
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
function countsLine(incidents, inspect) {
    if (incidents.total <= 0)
        return undefined;
    const omitted = Math.max(0, incidents.total - incidents.shown);
    return `  incidents=${incidents.total} shown=${incidents.shown}` +
        (omitted > 0 ? ` omittedIncidents=${omitted} retrieve: ${inspect} (incident pages via cursor)` : "");
}
function eventIncidents(event, failureBytes) {
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
function formatRow(event, detailBytes = MAX_FAILURE_BYTES + MAX_DECISION_BYTES) {
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
        if (outcome && outcome !== status)
            lines.push(`  outcome=${outcome}`);
    }
    const decisionBytes = Math.min(MAX_DECISION_BYTES, Math.floor(detailBytes / 2));
    if (event.decision && decisionBytes > 24)
        lines.push(`  decision: ${boundedField(event.decision, decisionBytes)}`);
    const incidents = eventIncidents(event, Math.max(0, Math.min(MAX_FAILURE_BYTES * 2, detailBytes - decisionBytes)));
    lines.push(...incidents.lines);
    const counts = countsLine(incidents, inspect);
    if (counts)
        lines.push(counts);
    return lines.join("\n");
}
function renderBatch(represented, omitted, detailBytes) {
    const count = represented.length;
    const heading = `${count} background completion${count === 1 ? " is" : "s are"} ready:`;
    const omittedLine = omitted > 0
        ? `${omitted} more completion${omitted === 1 ? "" : "s"} omitted from this batch (not receipted; still queued).`
        : undefined;
    return [heading, ...represented.map((event) => formatRow(event, detailBytes)), omittedLine, RETRIEVAL_FOOTER]
        .filter((line) => Boolean(line))
        .join("\n");
}
function clipRendered(text, maxBytes) {
    if (utf8ByteLength(text) <= maxBytes)
        return text;
    const suffix = "\n[clipped to callback budget]";
    const budget = maxBytes - utf8ByteLength(suffix);
    if (budget < 24)
        return clipUtf8Prefix(text, maxBytes);
    return `${clipUtf8Prefix(text, budget)}${suffix}`;
}
function eventPriority(event) {
    if (event.failure || event.failureRows?.length || (event.omittedIncidents ?? 0) > 0 || (event.incidentCount ?? 0) > 0)
        return 0;
    if (event.decision)
        return 1;
    const status = String(event.status ?? "").toLowerCase();
    if (/(?:fail|orphan|lost|timed_out|timeout|unresolved|incomplete|observation incomplete)/.test(status))
        return 0;
    return 2;
}
/**
 * Urgent health/failure callback under the total budget. Order: header,
 * explanation, whole incident rows that fit, the incident count line (total,
 * shown, omitted, retrieval), and the inspect line. The count and inspect
 * lines are never dropped; unshown explanation bytes are counted.
 */
export function formatUrgentCallback(event, options = {}) {
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
    const counts = (shown) => {
        if (total <= 0)
            return undefined;
        const omitted = rows.length ? total - shown : legacyOmitted;
        const shownPart = rows.length ? ` shown=${shown}` : "";
        return `incidents=${total}${shownPart}` +
            (omitted > 0 ? ` omittedIncidents=${omitted} retrieve: ${inspectTarget} (incident pages via cursor)` : "");
    };
    const render = (body, note, shownRows) => [header, body, note, ...shownRows, counts(shownRows.length), inspect]
        .filter((part) => Boolean(part && part.length > 0))
        .join("\n");
    const fixed = utf8ByteLength(render("", undefined, [])) + 16;
    const room = Math.max(0, maxBytes - fixed);
    // The explanation keeps at least half the room when incident rows compete.
    const contentShare = rows.length ? Math.floor(room / 2) : room;
    let body = source;
    let note;
    if (utf8ByteLength(source) > contentShare) {
        const noteFor = (omitted) => `omittedBytes=${omitted} retrieve: ${inspectTarget}`;
        const clipped = clipUtf8Prefix(source, Math.max(0, contentShare - utf8ByteLength(noteFor(utf8ByteLength(source))) - 1));
        body = clipped;
        note = noteFor(utf8ByteLength(source) - utf8ByteLength(clipped));
    }
    const shown = [];
    for (const row of rows) {
        const line = String(row).replace(/\s+/g, " ").trim();
        if (utf8ByteLength(render(body, note, [...shown, line])) + 8 > maxBytes)
            break;
        shown.push(line);
    }
    const rendered = render(body, note, shown);
    if (utf8ByteLength(rendered) <= maxBytes)
        return rendered;
    const minimal = render("", source ? `omittedBytes=${utf8ByteLength(source)} retrieve: ${inspectTarget}` : undefined, []);
    return clipRendered(minimal, maxBytes);
}
export function packCallbackBatch(events, options = {}) {
    const maxBytes = callbackBatchBudget(options.maxBytes);
    if (events.length === 0) {
        return { text: renderBatch([], 0), represented: [], omitted: 0 };
    }
    const ranked = events.map((event, index) => ({ event, index }))
        .sort((a, b) => eventPriority(a.event) - eventPriority(b.event) || a.index - b.index);
    const selected = new Set();
    const renderSelected = () => {
        const represented = events.filter((_, index) => selected.has(index));
        return renderBatch(represented, events.length - selected.size);
    };
    for (const { index } of ranked) {
        selected.add(index);
        if (utf8ByteLength(renderSelected()) <= maxBytes)
            continue;
        selected.delete(index);
        if (selected.size === 0) {
            // One row alone exceeds the budget: shrink its detail, never its counts.
            const event = events[index];
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
export function formatCallbackBatch(events, options = {}) {
    return packCallbackBatch(events, options).text;
}
export function createCallbackBatcher(host, options = {}) {
    const windowMs = options.windowMs ?? resolveCallbackBatchWindowMs();
    const retryMs = Math.max(0, options.retryMs ?? DEFAULT_RETRY_MS);
    let whileBusy = options.whileBusy ?? "hold";
    const maxBytes = callbackBatchBudget(options.maxBytes);
    const pending = new Map();
    const inFlight = new Set();
    const urgentInFlight = new Set();
    const urgentSettlements = new Set();
    const handedOff = new Map();
    const activeTools = new Set();
    let sequence = 0;
    let timer;
    let flushPromise;
    let isAvailable = options.isAvailable ?? (() => true);
    let gated = options.isAvailable !== undefined;
    let awaitingRun = false;
    let cancelled = false;
    let foregroundRunning = false;
    const deliveryMode = () => {
        if (cancelled)
            return undefined;
        try {
            if (!isAvailable()) {
                awaitingRun = false;
                return whileBusy === "steer" && foregroundRunning && activeTools.size === 0 ? "steer" : undefined;
            }
            return !awaitingRun ? "followUp" : undefined;
        }
        catch {
            return undefined;
        }
    };
    const cancelTimer = () => {
        if (timer)
            clearTimeout(timer);
        timer = undefined;
    };
    const schedule = (delayMs) => {
        if (timer || pending.size === 0)
            return;
        // Some idle transitions (manual compaction) have no agent_settled event.
        const delay = deliveryMode() ? delayMs : retryMs;
        timer = setTimeout(() => {
            timer = undefined;
            void api.flush();
        }, Math.max(1, delay));
        timer.unref?.();
    };
    const enqueue = (event) => {
        if (event.callback === false)
            return false;
        const key = completionKey(event);
        if (pending.has(key) || inFlight.has(key))
            return false;
        pending.set(key, { event, sequence: sequence++ });
        schedule(windowMs);
        return true;
    };
    const performFlush = async () => {
        cancelTimer();
        const mode = deliveryMode();
        if (!mode) {
            schedule(retryMs);
            return false;
        }
        const snapshot = [...pending.entries()]
            .sort((a, b) => a[1].sequence - b[1].sequence);
        pending.clear();
        for (const [key] of snapshot)
            inFlight.add(key);
        const deliverable = [];
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
            if (pending.size > 0)
                schedule(deferred ? retryMs : windowMs);
            return !deferred;
        }
        const packed = packCallbackBatch(deliverable.map(([, item]) => item.event), { maxBytes });
        const representedSet = new Set(packed.represented);
        const representedItems = deliverable.filter(([, item]) => representedSet.has(item.event));
        const overflowItems = deliverable.filter(([, item]) => !representedSet.has(item.event));
        const receiptDetails = { completionEventIds: representedItems.map(([, item]) => item.event.receiptId).filter((id) => Boolean(id)) };
        try {
            // Pi may defer the requested run while settled handlers finish, leaving
            // isIdle() true. Permit no second handoff until a run starts.
            awaitingRun = mode === "followUp" && gated;
            await host.sendMessage({
                customType: "background-completion-batch",
                content: packed.text,
                display: true,
                ...(receiptDetails.completionEventIds.length ? { details: receiptDetails } : {}),
            }, 
            // Newer Pi requires triggerTurn for steering too; false only appends
            // a custom message at the turn boundary without continuing the agent.
            { deliverAs: mode, triggerTurn: true });
        }
        catch {
            receiptDetails.completionEventIds.length = 0;
            awaitingRun = false;
            for (const [key] of deliverable)
                inFlight.delete(key);
            const retryItems = [...deliverable, ...pending.entries()]
                .sort((a, b) => a[1].sequence - b[1].sequence);
            pending.clear();
            for (const [key, item] of retryItems) {
                if (!pending.has(key))
                    pending.set(key, item);
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
        if (pending.size > 0)
            schedule(deferred ? retryMs : windowMs);
        return !deferred;
    };
    const flush = () => {
        if (flushPromise)
            return flushPromise;
        flushPromise = performFlush().finally(() => {
            flushPromise = undefined;
        });
        return flushPromise;
    };
    const deliverUrgent = (event) => {
        const key = eventKey(event);
        if (urgentInFlight.has(key))
            return false;
        const priorHandoff = handedOff.get(key);
        if (priorHandoff !== undefined)
            return invokeDelivered(event, priorHandoff);
        const acknowledge = () => {
            const at = Date.now();
            handedOff.set(key, at);
            return invokeDelivered(event, at);
        };
        const disposition = eventDisposition(event);
        if (disposition.kind === "deferred")
            return false;
        if (disposition.kind === "delivered")
            return true;
        if (disposition.kind === "suppressed") {
            invokeSuppressed(event, disposition.reason, Date.now());
            return true;
        }
        urgentInFlight.add(key);
        try {
            const handoff = host.sendMessage({ customType: event.customType, content: formatUrgentCallback(event, { maxBytes }), display: true,
                ...(event.receiptId ? { details: { urgentEventId: event.receiptId } } : {}) }, { deliverAs: "followUp", triggerTurn: true });
            if (isPromiseLike(handoff)) {
                const settlement = Promise.resolve(handoff).then(() => acknowledge(), () => false).finally(() => { urgentInFlight.delete(key); urgentSettlements.delete(settlement); });
                urgentSettlements.add(settlement);
                return settlement;
            }
            const acknowledged = acknowledge();
            urgentInFlight.delete(key);
            return acknowledged;
        }
        catch {
            urgentInFlight.delete(key);
            return false;
        }
    };
    const api = {
        enqueue,
        flush,
        setHost(next) { host = next; },
        setAvailability(check) {
            gated = true;
            isAvailable = check;
            cancelled = false;
            deliveryMode();
            cancelTimer();
            schedule(windowMs);
        },
        setWhileBusy(mode) {
            if (!isDeliveryMode(mode))
                throw new Error("Invalid callback delivery mode. Nothing changed.");
            whileBusy = mode;
            cancelTimer();
            schedule(windowMs);
        },
        setForegroundRunning(running) {
            foregroundRunning = running;
            cancelTimer();
            schedule(windowMs);
        },
        toolStarted(toolCallId) {
            activeTools.add(toolCallId);
        },
        async toolEnded(toolCallId) {
            const ended = activeTools.delete(toolCallId);
            if (activeTools.size > 0 || whileBusy !== "steer" || cancelled)
                return false;
            if (!ended)
                return flushPromise ?? false;
            // A timer may still be completing a deferred flush. Recheck after it so
            // the tool boundary cannot lose the pending batch to that older attempt.
            if (flushPromise)
                await flushPromise;
            return pending.size > 0 ? api.flush() : true;
        },
        deliverUrgent,
        async settled() {
            await flushPromise;
            await Promise.all([...urgentSettlements]);
        },
        cancel() {
            cancelTimer();
            pending.clear();
            awaitingRun = false;
            activeTools.clear();
            foregroundRunning = false;
            cancelled = true;
        },
        pendingCount() {
            return pending.size;
        },
    };
    return api;
}
export function getCallbackBatcher(host, options = {}) {
    const state = globalState();
    const key = host.events ?? host;
    const existing = state.byHost.get(key);
    if (existing) {
        existing.setHost(host);
        return existing;
    }
    const created = createCallbackBatcher(host, options);
    state.byHost.set(key, created);
    return created;
}
export function cancelCallbackBatch(host) {
    const batcher = globalState().byHost.get(host.events ?? host);
    batcher?.setAvailability(() => false);
    batcher?.cancel();
}
/** Restore current branch/default mode without resetting foreground tools or receipts. */
export function setCallbackBatchContext(host, ctx, seams = {}) {
    const batcher = bindCallbackBatcher(host, ctx);
    let mode = "hold";
    try {
        const settings = getCallbackSettings(ctx, seams);
        if (settings.source === "session") {
            // Capture the initial default even when an override currently hides it,
            // so navigating to an unconfigured branch cannot inherit a later save.
            try {
                getSessionDefault(ctx, seams);
            }
            catch {
                if (ctx.sessionManager) {
                    const defaults = globalState().sessionDefaults ??= new WeakMap();
                    defaults.set(ctx.sessionManager, { sessionId: ctx.sessionManager.getSessionId?.(), mode: "hold" });
                }
            }
        }
        mode = settings.mode;
    }
    catch (error) {
        try {
            ctx.ui?.notify(`Callback delivery restored to hold: ${String(error)}`, "error");
        }
        catch { /* A failing UI must not retain the prior session's delivery mode. */ }
    }
    batcher.setWhileBusy(mode);
    // Schedule rather than await delivery inside agent_settled: its handlers are
    // still settling the previous run, and sendMessage may start a new one.
    batcher.setAvailability(() => ctx.isIdle());
}
function bindCallbackBatcher(host, ctx) {
    const state = globalState();
    const bySession = state.bySession ??= new WeakMap();
    const shared = ctx.sessionManager ? bySession.get(ctx.sessionManager) : undefined;
    const batcher = shared ?? getCallbackBatcher(host);
    if (ctx.sessionManager)
        bySession.set(ctx.sessionManager, batcher);
    state.byHost.set(host.events ?? host, batcher);
    batcher.setHost(host);
    return batcher;
}
function globalState() {
    const root = globalThis;
    root[GLOBAL_STATE_KEY] ??= { byHost: new WeakMap() };
    return root[GLOBAL_STATE_KEY];
}
function eventKey(event) {
    return `${event.source}\u0000${event.id}\u0000${event.status}`;
}
/**
 * Ordinary completion identity is the run/task id, not the status wording (#624).
 *
 * The status field is a snapshot taken when a notification is enqueued (failure
 * notes, observation gaps, timing reason). Including it in the key meant a
 * not-yet-delivered run whose status changed between enqueues entered the
 * pending map twice; one flush then rendered both rows and the caller saw one
 * completion twice. Urgent events keep the status in their key: those are
 * distinct transitions (orphaned, lost, a timing wake, a failure key), not
 * restatements of a single ordinary completion. The first queued snapshot is the
 * one delivered; a later status wording for the same id is dropped rather than
 * re-queued, and the durable result stays the authority for failure detail.
 */
function completionKey(event) {
    return `${event.source}\u0000${event.id}`;
}
function eventDisposition(event) {
    try {
        if (event.isDelivered?.())
            return { kind: "delivered" };
    }
    catch {
        return { kind: "deferred" };
    }
    try {
        const reason = event.getSuppressionReason?.();
        return reason ? { kind: "suppressed", reason } : { kind: "deliver" };
    }
    catch {
        return { kind: "deferred" };
    }
}
function invokeDelivered(event, at) {
    try {
        event.onDelivered?.(at);
        return true;
    }
    catch {
        return false;
    }
}
function invokeSuppressed(event, reason, at) {
    try {
        event.onSuppressed?.(reason, at);
    }
    catch { /* best effort durable suppression */ }
}
function isPromiseLike(value) {
    return (typeof value === "object" || typeof value === "function")
        && value !== null
        && typeof value.then === "function";
}
