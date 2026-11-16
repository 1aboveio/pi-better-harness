// Generated from packages/pi-better-subagents/health-observation.ts. Do not edit directly.
/**
 * Multi-dimensional subagent health observations (issue #66).
 *
 * Pure seam: accepts durable status, process-liveness facts, parsed child-event
 * facts, optional raw-log diagnostics, thresholds, and `now`, then produces an
 * observation. Never writes metadata and never kills processes.
 *
 * Event vocabulary follows docs/evidence/issue-64/NOTES.md. Stale is residual:
 * open tools, compaction, and active model-error/retry phases explain silence
 * and must not collapse into stale. Raw log mtime/size is diagnostic only.
 */
import { statSync } from "node:fs";
import { DEFAULT_MAX_READ_BYTES, readAppendedLines, parseLogEvent, logReadMetrics } from "./log-cursor.mjs";
import { logPathFor } from "./log-paths.mjs";
import { observeStall } from "./shared-stall-detector.mjs";
/** Defaults tuned for coordinator workloads; override per call or via config. */
export const DEFAULT_HEALTH_THRESHOLDS = Object.freeze({
    quietMs: 60_000,
    staleMs: 5 * 60_000,
    longToolMs: 2 * 60_000,
    longCompactionMs: 2 * 60_000,
});
function positiveMs(n, fallback) {
    const v = Number(n);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}
function envDuration(name) {
    const raw = process.env[name];
    if (!raw || raw.trim() === "")
        return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}
/** Merge partial thresholds / config keys onto defaults. */
export function resolveHealthThresholds(partial) {
    const p = (partial ?? {});
    return {
        quietMs: positiveMs(p.quietMs ?? p.healthQuietMs, DEFAULT_HEALTH_THRESHOLDS.quietMs),
        staleMs: positiveMs(p.staleMs ?? p.healthStaleMs, DEFAULT_HEALTH_THRESHOLDS.staleMs),
        longToolMs: positiveMs(p.longToolMs ?? p.healthLongToolMs, DEFAULT_HEALTH_THRESHOLDS.longToolMs),
        longCompactionMs: positiveMs(p.longCompactionMs ?? p.healthLongCompactionMs, DEFAULT_HEALTH_THRESHOLDS.longCompactionMs),
    };
}
export function healthThresholdsForConfig(config) {
    return resolveHealthThresholds({
        ...config,
        healthQuietMs: config.healthQuietMs ?? envDuration("PI_BETTER_STALL_QUIET_MS"),
        healthStaleMs: config.healthStaleMs ?? envDuration("PI_BETTER_STALL_MS"),
    });
}
function emptyFacts() {
    return {
        activeTools: [],
        compacting: false,
        model: { state: "ok", errorHistory: [] },
        sawAgentSettled: false,
        longModelCallSupported: false,
    };
}
/**
 * Wall-clock time from parsed event provenance only.
 * Never invents timestamps from raw log mtime, `Date.now()`, or stream ordinals —
 * those would promote diagnostic writes into healthy activity.
 */
function eventTime(e) {
    if (typeof e.at === "number" && Number.isFinite(e.at))
        return e.at;
    if (typeof e.timestamp === "number" && Number.isFinite(e.timestamp))
        return e.timestamp;
    const msg = e.message;
    if (msg && typeof msg.timestamp === "number" && Number.isFinite(msg.timestamp)) {
        return msg.timestamp;
    }
    return undefined;
}
/** Clear latched retry intent after later successful child progress. */
function markRecovered(state) {
    if (state.lastError || state.errorHistory.length > 0 || state.retrying || state.willRetry === true) {
        state.recoveredAfterError = true;
    }
    state.retrying = false;
    if (state.willRetry === true)
        state.willRetry = false;
}
function bumpMeaningful(state, at) {
    if (typeof at !== "number" || !Number.isFinite(at))
        return;
    if (state.last === undefined || at >= state.last)
        state.last = at;
}
function isAssistantMessage(msg) {
    return !!msg && typeof msg === "object" && msg.role === "assistant";
}
function assistantIsError(msg) {
    return msg.stopReason === "error" || typeof msg.errorMessage === "string";
}
function pushError(history, entry, max = 8) {
    if (!entry.message)
        return;
    history.push(entry);
    while (history.length > max)
        history.shift();
}
/**
 * Every event type `extractChildEventFacts` below branches on. The fold has no
 * default branch — an event of any other type (`message_update` and friends,
 * which are 98% of a log by volume) cannot move a single fact — so incremental
 * readers may drop unlisted types before parsing them without changing any
 * observation. Keep in step with the fold: `health_observation.test.mjs` fails
 * if the fold branches on a type this set does not name, or names one the fold
 * no longer reads.
 */
export const CHILD_EVENT_FACT_TYPES = new Set([
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "compaction_start",
    "compaction_end",
    "auto_retry_start",
    "auto_retry_end",
    "message_end",
    "turn_end",
    "agent_end",
    "agent_settled",
]);
/** Leading `{"type":"…"` of an NDJSON event line, read without parsing it. */
const LEADING_TYPE = /^\s*\{\s*"type"\s*:\s*"([A-Za-z0-9_.-]+)"/;
/**
 * Whether a raw log line could move any fact. Lines whose type we can read
 * cheaply and that the fold ignores are rejected without a `JSON.parse`; a line
 * whose shape we cannot read cheaply is kept, so the fold stays authoritative.
 */
export function mayAffectChildEventFacts(line) {
    const match = LEADING_TYPE.exec(line);
    if (!match)
        return true;
    return CHILD_EVENT_FACT_TYPES.has(match[1]);
}
/**
 * Extract health-relevant facts from an in-memory event list (tests / callers
 * that already parsed NDJSON). Skips non-objects; ignores raw non-JSON noise.
 */
export function extractChildEventFacts(events) {
    return createChildEventFactFold()(events);
}
function createChildEventFactFold() {
    const openTools = new Map();
    let anonymous = 0;
    const meaningful = {};
    let lastToolAt;
    let compacting = false;
    let compactionStartedAt;
    let lastCompaction;
    let sawAgentSettled = false;
    let retry;
    const recovery = {
        recoveredAfterError: false,
        retrying: false,
        willRetry: undefined,
        lastError: undefined,
        errorHistory: [],
    };
    return (events) => {
        for (const raw of events) {
            logReadMetrics.healthFolded++;
            if (!raw || typeof raw !== "object")
                continue;
            const e = raw;
            const type = typeof e.type === "string" ? e.type : undefined;
            if (!type)
                continue;
            // Only parsed-event write provenance counts as wall-clock activity.
            const at = eventTime(e);
            if (type === "tool_execution_start") {
                const toolName = typeof e.toolName === "string" ? e.toolName : "unknown";
                const toolCallId = typeof e.toolCallId === "string" ? e.toolCallId : undefined;
                const key = toolCallId ?? `anonymous:${anonymous++}`;
                openTools.set(key, { toolCallId, toolName, startedAt: at });
                lastToolAt = at ?? lastToolAt;
                bumpMeaningful(meaningful, at);
                continue;
            }
            if (type === "tool_execution_update") {
                lastToolAt = at ?? lastToolAt;
                bumpMeaningful(meaningful, at);
                continue;
            }
            if (type === "tool_execution_end") {
                const toolCallId = typeof e.toolCallId === "string" ? e.toolCallId : undefined;
                if (toolCallId) {
                    openTools.delete(toolCallId);
                }
                else if (typeof e.toolName === "string") {
                    const match = [...openTools].find(([, t]) => t.toolName === e.toolName);
                    if (match)
                        openTools.delete(match[0]);
                }
                lastToolAt = at ?? lastToolAt;
                bumpMeaningful(meaningful, at);
                // Successful tool completion supersedes prior retry intent (AC9).
                if (e.isError !== true)
                    markRecovered(recovery);
                continue;
            }
            if (type === "compaction_start") {
                compacting = true;
                compactionStartedAt = at;
                bumpMeaningful(meaningful, at);
                continue;
            }
            if (type === "compaction_end") {
                compacting = false;
                lastCompaction = {
                    reason: typeof e.reason === "string" ? e.reason : undefined,
                    aborted: typeof e.aborted === "boolean" ? e.aborted : undefined,
                    willRetry: typeof e.willRetry === "boolean" ? e.willRetry : undefined,
                    errorMessage: typeof e.errorMessage === "string" ? e.errorMessage : undefined,
                    at,
                };
                compactionStartedAt = undefined;
                bumpMeaningful(meaningful, at);
                continue;
            }
            if (type === "auto_retry_start") {
                recovery.retrying = true;
                recovery.recoveredAfterError = false;
                recovery.willRetry = true;
                retry = {
                    attempt: typeof e.attempt === "number" ? e.attempt : undefined,
                    maxAttempts: typeof e.maxAttempts === "number" ? e.maxAttempts : undefined,
                    startedAt: at,
                };
                const msg = typeof e.errorMessage === "string" ? e.errorMessage : "model retry";
                recovery.lastError = { message: msg, at };
                pushError(recovery.errorHistory, recovery.lastError);
                bumpMeaningful(meaningful, at);
                continue;
            }
            if (type === "auto_retry_end") {
                recovery.retrying = false;
                const success = e.success === true;
                if (success) {
                    markRecovered(recovery);
                }
                else {
                    const msg = typeof e.finalError === "string"
                        ? e.finalError
                        : (recovery.lastError?.message ?? "model retry exhausted");
                    recovery.lastError = { message: msg, at };
                    pushError(recovery.errorHistory, recovery.lastError);
                    recovery.recoveredAfterError = false;
                }
                bumpMeaningful(meaningful, at);
                continue;
            }
            if (type === "message_end") {
                const msg = e.message;
                if (isAssistantMessage(msg)) {
                    if (assistantIsError(msg)) {
                        const message = typeof msg.errorMessage === "string"
                            ? msg.errorMessage
                            : "assistant stopReason=error";
                        recovery.lastError = { message, at };
                        pushError(recovery.errorHistory, recovery.lastError);
                        recovery.recoveredAfterError = false;
                        // Model-error evidence is meaningful for timing, not healthy progress.
                        bumpMeaningful(meaningful, at);
                    }
                    else {
                        bumpMeaningful(meaningful, at);
                        // Later successful assistant evidence clears retry/warning (AC9).
                        markRecovered(recovery);
                    }
                }
                // user message_end is not child progress
                continue;
            }
            if (type === "turn_end") {
                const msg = e.message;
                if (isAssistantMessage(msg) && !assistantIsError(msg)) {
                    bumpMeaningful(meaningful, at);
                    markRecovered(recovery);
                }
                continue;
            }
            if (type === "agent_end") {
                if (typeof e.willRetry === "boolean")
                    recovery.willRetry = e.willRetry;
                if (recovery.willRetry === true) {
                    recovery.retrying = true;
                    recovery.recoveredAfterError = false;
                    bumpMeaningful(meaningful, at);
                }
                continue;
            }
            if (type === "agent_settled") {
                sawAgentSettled = true;
                // Settled ends the active retry phase; retain error history for detail.
                recovery.retrying = false;
                if (recovery.willRetry === true)
                    recovery.willRetry = false;
                bumpMeaningful(meaningful, at);
                continue;
            }
            // message_update is noisy; intentionally NOT meaningful for stale detection.
        }
        let modelState = "ok";
        if (recovery.retrying || recovery.willRetry === true)
            modelState = "retrying";
        else if (recovery.lastError && !recovery.recoveredAfterError)
            modelState = "error";
        else
            modelState = "ok";
        return {
            lastMeaningfulAt: meaningful.last,
            activeTools: [...openTools.values()],
            lastToolAt,
            compacting,
            compactionStartedAt,
            lastCompaction,
            model: {
                state: modelState,
                lastError: recovery.lastError,
                errorHistory: [...recovery.errorHistory],
                retry,
            },
            sawAgentSettled,
            willRetry: recovery.willRetry,
            longModelCallSupported: false,
        };
    };
}
/** Parse the fact-relevant events out of raw NDJSON lines. */
function parseFactEvents(lines) {
    const events = [];
    const sizes = [];
    for (const line of lines) {
        const s = line.trim();
        if (!s || s[0] !== "{")
            continue;
        if (!mayAffectChildEventFacts(s))
            continue;
        try {
            events.push(parseLogEvent(s));
            sizes.push(s.length);
        }
        catch {
            // bad JSON — ignore (noise / partial line)
        }
    }
    return { events, sizes };
}
// ---- incremental log reading ----------------------------------------------
//
// Retain structural facts, not source events. Only newly completed lines enter
// the fold; a skipped byte window remains explicitly reported in rawLog.
function maxHealthReadBytes() {
    const raw = process.env.PI_SUBAGENT_MAX_HEALTH_READ_BYTES;
    if (!raw)
        return DEFAULT_MAX_READ_BYTES;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_READ_BYTES;
}
/**
 * Runs tracked at once. A backstop, not a policy: callers are expected to reset
 * a dismissed run, and this bounds the leak if one forgets.
 */
const MAX_TRACKED_RUNS = 64;
const factLogStates = new Map();
/**
 * Forget the incremental read position for a run (or all runs). Call after a run
 * is dismissed, and in tests that rewrite a log under a reused id.
 */
export function resetChildEventLogCursor(id) {
    if (id === undefined)
        factLogStates.clear();
    else
        factLogStates.delete(id);
}
function rememberState(id, state) {
    // Re-insert so the map orders least-recently-read first.
    factLogStates.delete(id);
    factLogStates.set(id, state);
    while (factLogStates.size > MAX_TRACKED_RUNS) {
        const oldest = factLogStates.keys().next();
        if (oldest.done)
            break;
        factLogStates.delete(oldest.value);
    }
}
/**
 * Read a run log for event facts + raw mtime/size diagnostics.
 * Raw log write time never promotes activity health by itself.
 *
 * Reads incrementally: only bytes appended since the previous call for this id
 * are parsed, so a hot-path caller never re-reads a whole multi-gigabyte log.
 * Pass `logText` to fold a caller-supplied log instead, which bypasses the
 * cursor entirely.
 */
export function extractChildEventFactsFromLog(id, opts = {}) {
    const path = opts.logPath ?? logPathFor(id);
    const rawLog = {};
    try {
        const st = statSync(path);
        rawLog.mtimeMs = Math.trunc(st.mtimeMs);
        rawLog.sizeBytes = st.size;
    }
    catch (err) {
        rawLog.error = err instanceof Error ? err.message : String(err);
    }
    // Do not synthesise wall-clock timestamps from raw mtime / now. Untimestamped
    // events still contribute structural facts (open tools, compacting, model
    // phase); activity age only moves on parsed-event write provenance.
    // `opts.now` is accepted for API symmetry with callers but must not mint times.
    void opts.now;
    if (opts.logText !== undefined) {
        const { events } = parseFactEvents(opts.logText.split("\n"));
        return { facts: extractChildEventFacts(events), rawLog };
    }
    const key = opts.logPath ?? id;
    const states = opts.states ?? factLogStates;
    const previous = states.get(key);
    const read = readAppendedLines(path, previous?.cursor, maxHealthReadBytes());
    if (read.error !== undefined) {
        rawLog.error = rawLog.error ?? read.error;
        if (!previous)
            return { facts: emptyFacts(), rawLog };
    }
    const state = read.restarted || !previous
        ? { cursor: read.cursor, fold: createChildEventFactFold(), truncated: false }
        : previous;
    state.cursor = read.cursor;
    state.truncated = state.truncated || read.truncated;
    const parsed = parseFactEvents(read.lines);
    const facts = state.fold(parsed.events);
    if (opts.states)
        states.set(key, state);
    else
        rememberState(key, state);
    if (state.truncated)
        rawLog.windowTruncated = true;
    return { facts, rawLog };
}
function processLiveness(status, supervised) {
    if (status === "orphaned")
        return "orphaned";
    if (status === "lost")
        return "lost";
    if (status === "completed" || status === "failed" || status === "killed" || status === "exited") {
        return "terminal";
    }
    if (status === "running")
        return supervised === false ? "unknown" : "supervised";
    return "unknown";
}
function fmtAge(ms) {
    let value = ms;
    if (!Number.isFinite(value) || value < 0)
        value = 0;
    const s = Math.floor(value / 1000);
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}m`;
    const h = Math.floor(m / 60);
    return `${h}h${m % 60}m`;
}
/**
 * Compute a multi-dimensional health observation. Pure.
 */
export function observeRunHealth(input) {
    const thresholds = resolveHealthThresholds(input.thresholds);
    const now = input.now;
    const facts = input.facts;
    const rawLog = input.rawLog ?? {};
    // ---- tool dimension
    const active = facts.activeTools[facts.activeTools.length - 1];
    let toolState = "idle";
    let toolAge;
    if (active) {
        const start = active.startedAt ?? facts.lastToolAt ?? facts.lastMeaningfulAt;
        toolAge = typeof start === "number" ? Math.max(0, now - start) : undefined;
        toolState = toolAge !== undefined && toolAge >= thresholds.longToolMs
            ? "long_running"
            : "running";
    }
    // ---- compaction dimension
    let compactionState = "idle";
    let compactionAge;
    if (facts.compacting) {
        const start = facts.compactionStartedAt ?? facts.lastMeaningfulAt;
        compactionAge = typeof start === "number" ? Math.max(0, now - start) : undefined;
        compactionState = compactionAge !== undefined && compactionAge >= thresholds.longCompactionMs
            ? "long_compacting"
            : "compacting";
    }
    // ---- model dimension
    const modelState = facts.model.state;
    let listWarning;
    if (modelState === "retrying")
        listWarning = "model retrying";
    else if (modelState === "error")
        listWarning = "model error";
    // recovered → listWarning stays undefined (cleared from compact/list)
    // ---- activity (residual stale)
    const anchor = facts.lastMeaningfulAt ?? input.startedAt;
    const meaningfulAgeMs = typeof anchor === "number" ? Math.max(0, now - anchor) : undefined;
    const explainedByPhase = toolState !== "idle"
        || compactionState !== "idle"
        || modelState === "retrying"
        || modelState === "error";
    const terminal = input.status === "failed"
        || input.status === "completed"
        || input.status === "killed"
        || input.status === "lost"
        || input.status === "exited";
    const stall = observeStall({
        now,
        lastProgressAt: facts.lastMeaningfulAt,
        startedAt: input.startedAt,
        // Terminal work and explicit model/tool/compaction phases can be quiet,
        // but neither is an unexplained stalled worker.
        exempt: terminal || explainedByPhase,
        thresholds: { quietMs: thresholds.quietMs, stallMs: thresholds.staleMs },
    });
    const activity = stall.state === "stalled"
        ? "stale"
        : stall.state === "quiet"
            ? "quiet"
            // Legacy metadata without any timestamp remains conservative.
            : stall.state === "unknown" && !terminal && !explainedByPhase
                ? "stale"
                : "healthy";
    const process = {
        liveness: processLiveness(input.status, input.process?.supervised),
        supervised: input.process?.supervised,
    };
    const compaction = {
        state: compactionState,
        startedAt: facts.compactionStartedAt,
        ageMs: compactionAge,
        last: facts.lastCompaction,
    };
    const tool = {
        state: toolState,
        active,
        ageMs: toolAge,
    };
    const model = {
        state: modelState,
        listWarning,
        lastError: facts.model.lastError,
        errorHistory: [...facts.model.errorHistory],
        retry: facts.model.retry,
        // longModelCall omitted — unsupported without explicit lifecycle events (#64)
    };
    const compactFacts = buildCompactFacts({
        activity,
        compaction,
        tool,
        model,
    });
    return {
        status: input.status,
        process,
        activity,
        lastMeaningfulAt: facts.lastMeaningfulAt,
        meaningfulAgeMs,
        compaction,
        tool,
        model,
        rawLog,
        compactFacts,
        thresholds,
    };
}
function buildCompactFacts(p) {
    const facts = [];
    if (p.compaction.state === "long_compacting") {
        const age = p.compaction.ageMs !== undefined ? ` ${fmtAge(p.compaction.ageMs)}` : "";
        facts.push(`long compacting${age}`.trim());
    }
    else if (p.compaction.state === "compacting") {
        const age = p.compaction.ageMs !== undefined ? ` ${fmtAge(p.compaction.ageMs)}` : "";
        facts.push(`compacting${age}`.trim());
    }
    if (p.tool.state !== "idle" && p.tool.active) {
        const age = p.tool.ageMs !== undefined ? ` ${fmtAge(p.tool.ageMs)}` : "";
        const name = p.tool.active.toolName;
        facts.push(p.tool.state === "long_running" ? `long ${name}${age}`.trim() : `${name}${age}`.trim());
    }
    if (p.model.listWarning)
        facts.push(p.model.listWarning);
    // Residual stale only when nothing more specific is already listed.
    if (p.activity === "stale" && facts.length === 0)
        facts.push("stale");
    return facts.slice(0, 2);
}
