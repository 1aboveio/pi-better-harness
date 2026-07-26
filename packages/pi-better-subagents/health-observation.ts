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

import { readFileSync, statSync } from "node:fs";
import { logPathFor } from "./registry.ts";
import type { RunStatus } from "./registry.ts";
import { loadConfig, type SubagentConfig } from "./config.ts";

// ---- thresholds -----------------------------------------------------------

export interface HealthThresholds {
    /** Age of last meaningful activity before activity becomes `quiet`. */
    quietMs: number;
    /** Age of last meaningful activity before residual `stale` (if unexplained). */
    staleMs: number;
    /** Open-tool age before `long_running`. */
    longToolMs: number;
    /** Open-compaction age before `long_compacting`. */
    longCompactionMs: number;
}

/** Defaults tuned for coordinator workloads; override per call or via config. */
export const DEFAULT_HEALTH_THRESHOLDS: Readonly<HealthThresholds> = Object.freeze({
    quietMs: 60_000,
    staleMs: 5 * 60_000,
    longToolMs: 2 * 60_000,
    longCompactionMs: 2 * 60_000,
});

function positiveMs(n: unknown, fallback: number): number {
    const v = Number(n);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/** Merge partial thresholds / config keys onto defaults. */
export function resolveHealthThresholds(
    partial?: Partial<HealthThresholds> | Pick<
        SubagentConfig,
        "healthQuietMs" | "healthStaleMs" | "healthLongToolMs" | "healthLongCompactionMs"
    > | null,
): HealthThresholds {
    const p = (partial ?? {}) as Partial<HealthThresholds> & SubagentConfig;
    return {
        quietMs: positiveMs(p.quietMs ?? p.healthQuietMs, DEFAULT_HEALTH_THRESHOLDS.quietMs),
        staleMs: positiveMs(p.staleMs ?? p.healthStaleMs, DEFAULT_HEALTH_THRESHOLDS.staleMs),
        longToolMs: positiveMs(p.longToolMs ?? p.healthLongToolMs, DEFAULT_HEALTH_THRESHOLDS.longToolMs),
        longCompactionMs: positiveMs(
            p.longCompactionMs ?? p.healthLongCompactionMs,
            DEFAULT_HEALTH_THRESHOLDS.longCompactionMs,
        ),
    };
}

/** Load thresholds from extension config.json (best-effort). */
export function loadHealthThresholdsFromConfig(config: SubagentConfig = loadConfig()): HealthThresholds {
    return resolveHealthThresholds(config);
}

// ---- event facts ----------------------------------------------------------

export interface ActiveToolFact {
    toolCallId?: string;
    toolName: string;
    startedAt?: number;
}

export interface ModelErrorEntry {
    message: string;
    at?: number;
}

export interface ModelFacts {
    /** Current model dimension before observation thresholds. */
    state: "ok" | "error" | "retrying";
    lastError?: ModelErrorEntry;
    errorHistory: ModelErrorEntry[];
    retry?: { attempt?: number; maxAttempts?: number; startedAt?: number };
}

export interface CompactionEndFact {
    reason?: string;
    aborted?: boolean;
    willRetry?: boolean;
    errorMessage?: string;
    at?: number;
}

/**
 * Parsed facts from a child JSON event stream. Pure; no filesystem.
 * Timestamps prefer event `at` / message.timestamp when present.
 */
export interface ChildEventFacts {
    lastMeaningfulAt?: number;
    activeTools: ActiveToolFact[];
    lastToolAt?: number;
    compacting: boolean;
    compactionStartedAt?: number;
    lastCompaction?: CompactionEndFact;
    model: ModelFacts;
    sawAgentSettled: boolean;
    willRetry?: boolean;
    /**
     * Explicit model-call lifecycle support. #64 found no model_call_start/end;
     * always false until evidence lands.
     */
    longModelCallSupported: boolean;
}

export interface RawLogDiagnostic {
    mtimeMs?: number;
    sizeBytes?: number;
    error?: string;
}

type LooseEvent = Record<string, unknown>;

function emptyFacts(): ChildEventFacts {
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
function eventTime(e: LooseEvent): number | undefined {
    if (typeof e.at === "number" && Number.isFinite(e.at)) return e.at;
    if (typeof e.timestamp === "number" && Number.isFinite(e.timestamp)) return e.timestamp;
    const msg = e.message as LooseEvent | undefined;
    if (msg && typeof msg.timestamp === "number" && Number.isFinite(msg.timestamp)) {
        return msg.timestamp;
    }
    return undefined;
}

interface RetryRecoveryState {
    recoveredAfterError: boolean;
    retrying: boolean;
    willRetry: boolean | undefined;
    lastError?: ModelErrorEntry;
    errorHistory: ModelErrorEntry[];
}

/** Clear latched retry intent after later successful child progress. */
function markRecovered(state: RetryRecoveryState): void {
    if (state.lastError || state.errorHistory.length > 0 || state.retrying || state.willRetry === true) {
        state.recoveredAfterError = true;
    }
    state.retrying = false;
    if (state.willRetry === true) state.willRetry = false;
}

function bumpMeaningful(state: { last?: number }, at: number | undefined): void {
    if (typeof at !== "number" || !Number.isFinite(at)) return;
    if (state.last === undefined || at >= state.last) state.last = at;
}

function isAssistantMessage(msg: unknown): msg is LooseEvent {
    return !!msg && typeof msg === "object" && (msg as LooseEvent).role === "assistant";
}

function assistantIsError(msg: LooseEvent): boolean {
    return msg.stopReason === "error" || typeof msg.errorMessage === "string";
}

function pushError(history: ModelErrorEntry[], entry: ModelErrorEntry, max = 8): void {
    if (!entry.message) return;
    history.push(entry);
    while (history.length > max) history.shift();
}

/**
 * Extract health-relevant facts from an in-memory event list (tests / callers
 * that already parsed NDJSON). Skips non-objects; ignores raw non-JSON noise.
 */
export function extractChildEventFacts(events: ReadonlyArray<unknown>): ChildEventFacts {
    const openTools = new Map<string, ActiveToolFact>();
    let anonymous = 0;
    const meaningful: { last?: number } = {};
    let lastToolAt: number | undefined;
    let compacting = false;
    let compactionStartedAt: number | undefined;
    let lastCompaction: CompactionEndFact | undefined;
    let sawAgentSettled = false;
    let retry: ModelFacts["retry"];
    const recovery: RetryRecoveryState = {
        recoveredAfterError: false,
        retrying: false,
        willRetry: undefined,
        lastError: undefined,
        errorHistory: [],
    };

    for (const raw of events) {
        if (!raw || typeof raw !== "object") continue;
        const e = raw as LooseEvent;
        const type = typeof e.type === "string" ? e.type : undefined;
        if (!type) continue;
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
            } else if (typeof e.toolName === "string") {
                const match = [...openTools].find(([, t]) => t.toolName === e.toolName);
                if (match) openTools.delete(match[0]);
            }
            lastToolAt = at ?? lastToolAt;
            bumpMeaningful(meaningful, at);
            // Successful tool completion supersedes prior retry intent (AC9).
            if (e.isError !== true) markRecovered(recovery);
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
            } else {
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
                } else {
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
            if (typeof e.willRetry === "boolean") recovery.willRetry = e.willRetry;
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
            if (recovery.willRetry === true) recovery.willRetry = false;
            bumpMeaningful(meaningful, at);
            continue;
        }

        // message_update is noisy; intentionally NOT meaningful for stale detection.
    }

    let modelState: ModelFacts["state"] = "ok";
    if (recovery.retrying || recovery.willRetry === true) modelState = "retrying";
    else if (recovery.lastError && !recovery.recoveredAfterError) modelState = "error";
    else modelState = "ok";

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
}

/**
 * Read a run log for event facts + raw mtime/size diagnostics.
 * Raw log write time never promotes activity health by itself.
 */
export function extractChildEventFactsFromLog(
    id: string,
    opts: { now?: number; logText?: string } = {},
): { facts: ChildEventFacts; rawLog: RawLogDiagnostic } {
    const path = logPathFor(id);
    const rawLog: RawLogDiagnostic = {};
    try {
        const st = statSync(path);
        rawLog.mtimeMs = Math.trunc(st.mtimeMs);
        rawLog.sizeBytes = st.size;
    } catch (err) {
        rawLog.error = err instanceof Error ? err.message : String(err);
    }

    let text = opts.logText;
    if (text === undefined) {
        try {
            text = readFileSync(path, "utf-8");
        } catch (err) {
            rawLog.error = rawLog.error ?? (err instanceof Error ? err.message : String(err));
            return { facts: emptyFacts(), rawLog };
        }
    }

    const events: unknown[] = [];
    for (const line of text.split("\n")) {
        const s = line.trim();
        if (!s || s[0] !== "{") continue;
        try {
            events.push(JSON.parse(s));
        } catch {
            // bad JSON — ignore (noise / partial line)
        }
    }

    // Do not synthesise wall-clock timestamps from raw mtime / now. Untimestamped
    // events still contribute structural facts (open tools, compacting, model
    // phase); activity age only moves on parsed-event write provenance.
    // `opts.now` is accepted for API symmetry with callers but must not mint times.
    void opts.now;
    return { facts: extractChildEventFacts(events), rawLog };
}

// ---- observation ----------------------------------------------------------

export type ActivityHealth = "healthy" | "quiet" | "stale";
export type CompactionHealthState = "idle" | "compacting" | "long_compacting";
export type ToolHealthState = "idle" | "running" | "long_running";
export type ProcessLiveness = "supervised" | "orphaned" | "lost" | "terminal" | "unknown";

export interface ProcessObservation {
    liveness: ProcessLiveness;
    supervised?: boolean;
}

export interface CompactionObservation {
    state: CompactionHealthState;
    startedAt?: number;
    ageMs?: number;
    last?: CompactionEndFact;
}

export interface ToolObservation {
    state: ToolHealthState;
    active?: ActiveToolFact;
    ageMs?: number;
}

export interface ModelObservation {
    state: "ok" | "error" | "retrying";
    /** Present on compact/list surfaces while unrecovered. */
    listWarning?: string;
    lastError?: ModelErrorEntry;
    /** Detail history — retained after recovery. */
    errorHistory: ModelErrorEntry[];
    retry?: ModelFacts["retry"];
    /**
     * Only set when explicit lifecycle evidence supports it. #64: unsupported,
     * so this property is never populated by observeRunHealth today.
     */
    longModelCall?: { startedAt?: number; ageMs?: number };
}

/** Durable run status plus transient display `exited` (dead pid, still `running` on disk). */
export type ObservationStatus = RunStatus | "exited";

export interface HealthObservation {
    status: ObservationStatus;
    process: ProcessObservation;
    activity: ActivityHealth;
    lastMeaningfulAt?: number;
    meaningfulAgeMs?: number;
    compaction: CompactionObservation;
    tool: ToolObservation;
    model: ModelObservation;
    rawLog: RawLogDiagnostic;
    /** At most a couple of compact facts for list/navigator consumers. */
    compactFacts: string[];
    thresholds: HealthThresholds;
}

export interface ObserveRunHealthInput {
    /** Prefer effective/display status so liveness matches what the UI shows. */
    status: ObservationStatus;
    now: number;
    facts: ChildEventFacts;
    rawLog?: RawLogDiagnostic;
    thresholds?: Partial<HealthThresholds>;
    process?: { supervised?: boolean };
    /** Fallback anchor when no meaningful events exist yet. */
    startedAt?: number;
}

function processLiveness(status: ObservationStatus, supervised?: boolean): ProcessLiveness {
    if (status === "orphaned") return "orphaned";
    if (status === "lost") return "lost";
    if (status === "completed" || status === "failed" || status === "killed" || status === "exited") {
        return "terminal";
    }
    if (status === "running") return supervised === false ? "unknown" : "supervised";
    return "unknown";
}

function fmtAge(ms: number): string {
    let value = ms;
    if (!Number.isFinite(value) || value < 0) value = 0;
    const s = Math.floor(value / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return `${h}h${m % 60}m`;
}

/**
 * Compute a multi-dimensional health observation. Pure.
 */
export function observeRunHealth(input: ObserveRunHealthInput): HealthObservation {
    const thresholds = resolveHealthThresholds(input.thresholds);
    const now = input.now;
    const facts = input.facts;
    const rawLog = input.rawLog ?? {};

    // ---- tool dimension
    const active = facts.activeTools[facts.activeTools.length - 1];
    let toolState: ToolHealthState = "idle";
    let toolAge: number | undefined;
    if (active) {
        const start = active.startedAt ?? facts.lastToolAt ?? facts.lastMeaningfulAt;
        toolAge = typeof start === "number" ? Math.max(0, now - start) : undefined;
        toolState = toolAge !== undefined && toolAge >= thresholds.longToolMs
            ? "long_running"
            : "running";
    }

    // ---- compaction dimension
    let compactionState: CompactionHealthState = "idle";
    let compactionAge: number | undefined;
    if (facts.compacting) {
        const start = facts.compactionStartedAt ?? facts.lastMeaningfulAt;
        compactionAge = typeof start === "number" ? Math.max(0, now - start) : undefined;
        compactionState = compactionAge !== undefined && compactionAge >= thresholds.longCompactionMs
            ? "long_compacting"
            : "compacting";
    }

    // ---- model dimension
    const modelState = facts.model.state;
    let listWarning: string | undefined;
    if (modelState === "retrying") listWarning = "model retrying";
    else if (modelState === "error") listWarning = "model error";
    // recovered → listWarning stays undefined (cleared from compact/list)

    // ---- activity (residual stale)
    const anchor = facts.lastMeaningfulAt ?? input.startedAt;
    const meaningfulAgeMs = typeof anchor === "number" ? Math.max(0, now - anchor) : undefined;

    const explainedByPhase =
        toolState !== "idle"
        || compactionState !== "idle"
        || modelState === "retrying"
        || modelState === "error";

    let activity: ActivityHealth = "healthy";
    if (
        input.status === "failed"
        || input.status === "completed"
        || input.status === "killed"
        || input.status === "lost"
        || input.status === "exited"
    ) {
        // Terminal runs are not residual-stale workers.
        if (meaningfulAgeMs !== undefined && meaningfulAgeMs >= thresholds.quietMs) activity = "quiet";
        else activity = "healthy";
    } else if (explainedByPhase) {
        // Active known phase: never residual stale.
        if (meaningfulAgeMs !== undefined && meaningfulAgeMs >= thresholds.quietMs) activity = "quiet";
        else activity = "healthy";
    } else if (meaningfulAgeMs === undefined) {
        if (input.startedAt !== undefined) {
            const age = Math.max(0, now - input.startedAt);
            if (age >= thresholds.staleMs) activity = "stale";
            else if (age >= thresholds.quietMs) activity = "quiet";
            else activity = "healthy";
        } else {
            activity = "stale";
        }
    } else if (meaningfulAgeMs >= thresholds.staleMs) {
        activity = "stale";
    } else if (meaningfulAgeMs >= thresholds.quietMs) {
        activity = "quiet";
    } else {
        activity = "healthy";
    }

    const process: ProcessObservation = {
        liveness: processLiveness(input.status, input.process?.supervised),
        supervised: input.process?.supervised,
    };

    const compaction: CompactionObservation = {
        state: compactionState,
        startedAt: facts.compactionStartedAt,
        ageMs: compactionAge,
        last: facts.lastCompaction,
    };

    const tool: ToolObservation = {
        state: toolState,
        active,
        ageMs: toolAge,
    };

    const model: ModelObservation = {
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

function buildCompactFacts(p: {
    activity: ActivityHealth;
    compaction: CompactionObservation;
    tool: ToolObservation;
    model: ModelObservation;
}): string[] {
    const facts: string[] = [];

    if (p.compaction.state === "long_compacting") {
        const age = p.compaction.ageMs !== undefined ? ` ${fmtAge(p.compaction.ageMs)}` : "";
        facts.push(`long compacting${age}`.trim());
    } else if (p.compaction.state === "compacting") {
        const age = p.compaction.ageMs !== undefined ? ` ${fmtAge(p.compaction.ageMs)}` : "";
        facts.push(`compacting${age}`.trim());
    }

    if (p.tool.state !== "idle" && p.tool.active) {
        const age = p.tool.ageMs !== undefined ? ` ${fmtAge(p.tool.ageMs)}` : "";
        const name = p.tool.active.toolName;
        facts.push(p.tool.state === "long_running" ? `long ${name}${age}`.trim() : `${name}${age}`.trim());
    }

    if (p.model.listWarning) facts.push(p.model.listWarning);

    // Residual stale only when nothing more specific is already listed.
    if (p.activity === "stale" && facts.length === 0) facts.push("stale");

    return facts.slice(0, 2);
}
