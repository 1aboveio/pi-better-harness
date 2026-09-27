/**
 * Harness-owned run timing: a soft deadline with grace, a hard ceiling, and
 * no-progress (stuck) detection for every subagent run.
 *
 * Timeout control belongs to the harness, not to the prompt or the skill that
 * launched the run: an orchestrator's "30-minute attempt" written in prose is
 * enforced by nothing, and a parent that only notices at 38 minutes kills a
 * child that was still making progress. This module keeps the policy pure:
 *
 * - `resolveRunTiming` turns spawn parameters, settings, and environment into
 *   the durable `RunMeta.timing` record written at launch (so /reload keeps it);
 * - `foldProgress` reads the child's own `--mode json` event stream into a
 *   progress state (what counts as progress is defined once, below);
 * - `decideTiming` says what is due at `now` (steer, one parent wake, a stop);
 * - `describeTiming` renders the reason for list/output/result/callbacks.
 *
 * The host (index.ts) performs the side effects: writing the steer request the
 * child's control extension delivers, the urgent parent wake, and the stop.
 *
 * Progress, defined simply: any successful tool call that is not an exact
 * repeat of an earlier call in this run (same tool name and same arguments,
 * with null/absent optional fields treated alike as in #336). A successful
 * `edit`/`write`, a `git commit`, and a success directly after a failure always
 * count, even when repeated. Re-reading the same file or re-running the same
 * command with the same arguments does not. Time spent waiting on a running tool call does not count toward
 * the stuck window, so a child in the middle of a 20-minute test run is not
 * stuck; a hung command is bounded by the deadline and the ceiling instead.
 */

import { createHash } from "node:crypto";

export type TimingStopReason = "deadline" | "ceiling";
export type TimingReason = TimingStopReason | "stuck";

/** Built-in defaults, in minutes. `0` disables that control. */
export const DEFAULT_TIMING_MINUTES = Object.freeze({
    deadline: 30,
    grace: 5,
    max: 90,
    stuck: 10,
});

/** Durable timing policy and one-shot markers, stored on RunMeta at launch. */
export interface RunTiming {
    /** Soft deadline (epoch ms): the child is told to wrap up. Absent = none. */
    deadlineAt?: number;
    /** Grace after the soft deadline before the run is stopped. */
    graceMs: number;
    /** Hard ceiling (epoch ms): stopped without grace. Absent = none. */
    ceilingAt?: number;
    /** No-progress window. Absent = stuck detection off. */
    stuckMs?: number;
    /** When the wrap-up steer was requested from the child. */
    steerRequestedAt?: number;
    /** When the steer entered the child's conversation (grace starts here). */
    steerDeliveredAt?: number;
    /** When the parent wake for the deadline was handed off (or suppressed). */
    deadlineWakeSentAt?: number;
    /** When the stuck wake was handed off (or suppressed). */
    stuckWakeSentAt?: number;
    /** Progress anchor the stuck wake was about; a later progress re-arms it. */
    stuckAnchorAt?: number;
    /** Latest progress seen by the parent (floor for a reload whose log read is bounded). */
    lastProgressAt?: number;
    /** Set when the harness stopped the run. */
    stopReason?: TimingStopReason;
    stoppedAt?: number;
}

export interface TimingParams {
    deadline_minutes?: number | null;
    grace_minutes?: number | null;
    max_minutes?: number | null;
    stuck_minutes?: number | null;
}

export interface TimingSettings {
    deadlineMinutes?: number | null;
    graceMinutes?: number | null;
    maxMinutes?: number | null;
    stuckMinutes?: number | null;
}

export const TIMING_ENV = Object.freeze({
    deadline: "PI_SUBAGENT_DEADLINE_MINUTES",
    grace: "PI_SUBAGENT_GRACE_MINUTES",
    max: "PI_SUBAGENT_MAX_MINUTES",
    stuck: "PI_SUBAGENT_STUCK_MINUTES",
});

const PARAM_KEYS = ["deadline_minutes", "grace_minutes", "max_minutes", "stuck_minutes"] as const;
const MAX_MINUTES = 7 * 24 * 60;
const MINUTE = 60_000;

/**
 * One optional minutes value. `undefined`, `null`, and (for env) an empty
 * string mean "not set". Anything else must be a finite number from 0 to a
 * week; `0` disables.
 */
function minutes(value: unknown, label: string): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === "string") {
        if (value.trim() === "") return undefined;
        value = Number(value);
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_MINUTES) {
        throw new Error(`${label} must be a number of minutes from 0 to ${MAX_MINUTES} (0 disables); got ${JSON.stringify(value)}.`);
    }
    return value;
}

/** Validate the four spawn timing parameters without resolving them. Throws on a bad value. */
export function assertTimingParams(params: TimingParams | undefined, label = ""): void {
    for (const key of PARAM_KEYS) minutes(params?.[key], `${label}${key}`);
}

/**
 * Effective minutes for one control: spawn parameter, then environment, then
 * settings (config.json), then the built-in default.
 */
function pick(param: unknown, env: unknown, setting: unknown, fallback: number, names: [string, string, string]): number {
    return minutes(param, names[0]) ?? minutes(env, names[1]) ?? minutes(setting, names[2]) ?? fallback;
}

/** The durable timing record for a run starting at `startedAt`. */
export function resolveRunTiming(input: {
    params?: TimingParams;
    settings?: TimingSettings | null;
    env?: Record<string, string | undefined>;
    startedAt: number;
}): RunTiming {
    const p = input.params ?? {};
    const s = input.settings ?? {};
    const env = input.env ?? {};
    const deadline = pick(p.deadline_minutes, env[TIMING_ENV.deadline], s.deadlineMinutes, DEFAULT_TIMING_MINUTES.deadline,
        ["deadline_minutes", TIMING_ENV.deadline, "deadlineMinutes"]);
    const grace = pick(p.grace_minutes, env[TIMING_ENV.grace], s.graceMinutes, DEFAULT_TIMING_MINUTES.grace,
        ["grace_minutes", TIMING_ENV.grace, "graceMinutes"]);
    const max = pick(p.max_minutes, env[TIMING_ENV.max], s.maxMinutes, DEFAULT_TIMING_MINUTES.max,
        ["max_minutes", TIMING_ENV.max, "maxMinutes"]);
    const stuck = pick(p.stuck_minutes, env[TIMING_ENV.stuck], s.stuckMinutes, DEFAULT_TIMING_MINUTES.stuck,
        ["stuck_minutes", TIMING_ENV.stuck, "stuckMinutes"]);
    return {
        ...(deadline > 0 ? { deadlineAt: input.startedAt + Math.round(deadline * MINUTE) } : {}),
        graceMs: Math.round(grace * MINUTE),
        ...(max > 0 ? { ceilingAt: input.startedAt + Math.round(max * MINUTE) } : {}),
        ...(stuck > 0 ? { stuckMs: Math.round(stuck * MINUTE) } : {}),
    };
}

// ---- tool parameters -------------------------------------------------------

const TIMING_DESCRIPTIONS = {
    deadline_minutes: "Soft deadline in minutes (default 30; 0 = none; null or omitted = inherit: in a batch job the shared value, otherwise the default). At the deadline the child is told to stop starting new work, commit what is done, and report, and you get one wake. Grace starts when the message reaches the child (after its current tool call); if it has not finished by then, the harness stops it with reason deadline.",
    grace_minutes: "Minutes after the wrap-up message reaches the child before the run is stopped (default 5; null or omitted = inherit).",
    max_minutes: "Hard ceiling in minutes (default 90; 0 = none; null or omitted = inherit). The run is stopped at once, without grace, with reason ceiling.",
    stuck_minutes: "No-progress window in minutes (default 10; 0 = off; null or omitted = inherit). Progress is any successful tool call that is not an exact repeat of an earlier one (same tool, same arguments); edits, writes, commits, and a success after a failure always count. Time inside a running tool call does not count. Wakes you once per stuck spell; never stops the run.",
} as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the host's TypeBox builder types its own schemas
type SchemaBuilder = { Optional: (schema: never) => any; Unsafe?: (schema: Record<string, unknown>) => unknown };

/**
 * The four timing parameters for subagent_spawn and each batch job / shared block.
 * Each admits an explicit null ("use the default"): plain JSON Schema `anyOf`
 * (Type.Unsafe), null first, because models send optional fields as null and
 * Pi 0.82 coerces a null through a TypeBox union (#336). No provider-rejected
 * keywords (scripts/provider-schema-compat.mjs).
 */
export function timingParameterSchemas(Type: SchemaBuilder): Record<keyof typeof TIMING_DESCRIPTIONS, ReturnType<SchemaBuilder["Optional"]>> {
    // Test hosts may stub a builder without Unsafe; the raw schema is the same JSON either way.
    const raw = (schema: Record<string, unknown>) => (typeof Type.Unsafe === "function" ? Type.Unsafe(schema) : schema) as never;
    const field = (description: string) => Type.Optional(raw({ anyOf: [{ type: "null" }, { type: "number", minimum: 0 }], description }));
    return {
        deadline_minutes: field(TIMING_DESCRIPTIONS.deadline_minutes),
        grace_minutes: field(TIMING_DESCRIPTIONS.grace_minutes),
        max_minutes: field(TIMING_DESCRIPTIONS.max_minutes),
        stuck_minutes: field(TIMING_DESCRIPTIONS.stuck_minutes),
    };
}

// ---- progress --------------------------------------------------------------

/** Progress folded from the child's event stream. Rebuildable from the log. */
export interface ProgressState {
    startedAt: number;
    lastProgressAt?: number;
    /** Latest event timestamp seen (message provenance only). */
    lastEventAt?: number;
    /** Tool calls started and not yet finished. */
    open: Map<string, { name: string; command?: string; novel: boolean }>;
    /** Hashes of tool name + normalized arguments already seen in this run (bounded, oldest evicted). */
    seen: Set<string>;
    /** When the open set last went from empty to non-empty. */
    inFlightSince?: number;
    /** Tool-call time since the last progress (closed intervals). */
    pausedMs: number;
    lastToolFailed: boolean;
}

export function emptyProgress(startedAt: number): ProgressState {
    return { startedAt, open: new Map(), seen: new Set(), pausedMs: 0, lastToolFailed: false };
}


const GIT_COMMIT = /(^|[\s;&|(])git(\s+-[cC]\s+\S+)*\s+commit\b/;

/** Most distinct calls remembered per run. Past the cap the oldest is forgotten, so a very old call repeated counts again. */
export const MAX_SEEN_CALLS = 4096;

/** Drop null/absent fields (recursively in objects), sort keys: one spelling per logical call (#336). */
function normalizeArgs(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(normalizeArgs);
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value).sort()) {
            const v = (value as Record<string, unknown>)[key];
            if (v === null || v === undefined) continue;
            out[key] = normalizeArgs(v);
        }
        return out;
    }
    return value;
}

/** Stable identity of one tool call: hash of the tool name and its normalized arguments. */
export function callKey(name: string, args: unknown): string {
    return createHash("sha256").update(name).update("\u0000").update(JSON.stringify(normalizeArgs(args ?? {})) ?? "").digest("base64url").slice(0, 22);
}

function remember(state: ProgressState, key: string): boolean {
    if (state.seen.has(key)) return false;
    state.seen.add(key);
    if (state.seen.size > MAX_SEEN_CALLS) {
        const oldest = state.seen.values().next().value;
        if (oldest !== undefined) state.seen.delete(oldest);
    }
    return true;
}

/**
 * File-mutating tools by name: edit, write, multi_edit, apply_patch, str_replace,
 * str_replace_editor, write_file, edit_file, and the like. A successful call always
 * counts as progress, even when it repeats an earlier one.
 */
export function isMutatingTool(name: string): boolean {
    return /(?:^|[_-])(?:edit|write|patch|replace)(?:$|[_-])|^multi_?edit$/i.test(name);
}

function isProgressResult(name: string, command: string | undefined, afterFailure: boolean, novel: boolean): boolean {
    if (afterFailure || novel) return true;
    if (isMutatingTool(name)) return true;
    return name === "bash" && typeof command === "string" && GIT_COMMIT.test(command);
}

/** Cheap pre-filter: only these rows can change progress state. */
export function isProgressRelevantLine(line: string): boolean {
    const head = line.slice(0, 160);
    return head.includes('"tool_execution_start"') || head.includes('"message_end"');
}

/** Fold one parsed child event into the progress state. */
export function foldProgress(state: ProgressState, event: Record<string, unknown>): void {
    const type = event.type;
    if (type === "tool_execution_start") {
        const id = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
        if (!id) return;
        const args = event.args as { command?: unknown } | undefined;
        if (state.open.size === 0) state.inFlightSince = state.lastEventAt ?? state.startedAt;
        const name = String(event.toolName ?? "");
        state.open.set(id, { name, command: typeof args?.command === "string" ? args.command : undefined, novel: remember(state, callKey(name, event.args)) });
        return;
    }
    if (type !== "message_end") return;
    const message = event.message as Record<string, unknown> | undefined;
    const at = typeof message?.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : undefined;
    if (at === undefined) return;
    state.lastEventAt = Math.max(state.lastEventAt ?? at, at);
    if (message?.role !== "toolResult") return;
    const id = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
    const started = id ? state.open.get(id) : undefined;
    if (id) state.open.delete(id);
    if (state.open.size === 0 && state.inFlightSince !== undefined) {
        state.pausedMs += Math.max(0, at - state.inFlightSince);
        state.inFlightSince = undefined;
    }
    const failed = message.isError === true;
    const name = String(message.toolName ?? started?.name ?? "");
    if (!failed && isProgressResult(name, started?.command, state.lastToolFailed, started?.novel === true)) {
        state.lastProgressAt = Math.max(state.lastProgressAt ?? at, at);
        state.pausedMs = 0;
        if (state.open.size > 0) state.inFlightSince = at;
    }
    state.lastToolFailed = failed;
}

/**
 * Time without progress that counts toward the stuck window, or undefined
 * while a tool call is running (waiting on a command is not being stuck).
 */
export function stuckAge(state: ProgressState, now: number, durableProgressAt?: number): number | undefined {
    if (state.open.size > 0) return undefined;
    // pausedMs counts tool time since the folded progress; against a later durable anchor it can
    // only overcount the pause, which delays a wake rather than inventing one.
    return Math.max(0, now - progressAnchor(state, durableProgressAt) - state.pausedMs);
}

/** The latest progress the parent knows of, falling back to the run start. */
export function progressAnchor(state: ProgressState, durableProgressAt?: number): number {
    return Math.max(state.startedAt, state.lastProgressAt ?? 0, durableProgressAt ?? 0);
}

// ---- decisions ---------------------------------------------------------------

export interface TimingActions {
    /** Ask the child to wrap up (once). */
    steer?: boolean;
    /** Wake the parent about the deadline (once; retried until handed off). */
    deadlineWake?: boolean;
    /** Wake the parent about no progress (once per stuck episode). */
    stuckWake?: { anchorAt: number; ageMs: number };
    /** Stop the run now. */
    stop?: TimingStopReason;
}

/** What is due for a running run at `now`. Pure. */
export function decideTiming(timing: RunTiming | undefined, progress: ProgressState | undefined, now: number): TimingActions {
    if (!timing || timing.stopReason) return {};
    if (timing.ceilingAt !== undefined && now >= timing.ceilingAt) return { stop: "ceiling" };
    const actions: TimingActions = {};
    if (timing.deadlineAt !== undefined && now >= timing.deadlineAt) {
        if (timing.steerRequestedAt === undefined) actions.steer = true;
        if (timing.deadlineWakeSentAt === undefined) actions.deadlineWake = true;
        // Grace starts when the steer enters the child's conversation, not when it was queued: Pi
        // delivers a steer only after the current tool call, so a 20-minute test that began just
        // before the deadline must not be killed mid-run. While the steer is undelivered and a tool
        // call is open, the deadline stop is held (the ceiling still bounds the run). Undelivered
        // with no tool open (e.g. a child without the steer extension), grace runs from the request.
        const deliveredAt = timing.steerDeliveredAt;
        if (deliveredAt !== undefined) {
            if (now >= deliveredAt + timing.graceMs) actions.stop = "deadline";
        } else if (timing.steerRequestedAt !== undefined && !(progress && progress.open.size > 0)
            && now >= timing.steerRequestedAt + timing.graceMs) {
            actions.stop = "deadline";
        }
        // Past the deadline the wrap-up flow governs; a stuck wake would only repeat it.
        return actions;
    }
    if (timing.stuckMs !== undefined && progress) {
        const age = stuckAge(progress, now, timing.lastProgressAt);
        const anchorAt = progressAnchor(progress, timing.lastProgressAt);
        const alreadyWoken = timing.stuckWakeSentAt !== undefined && (timing.stuckAnchorAt ?? 0) >= anchorAt;
        if (age !== undefined && age >= timing.stuckMs && !alreadyWoken) actions.stuckWake = { anchorAt, ageMs: age };
    }
    return actions;
}

// ---- rendering ---------------------------------------------------------------

function fmtMinutes(ms: number): string {
    const m = ms / MINUTE;
    return Number.isInteger(m) ? `${m}m` : m >= 1 ? `${m.toFixed(1)}m` : `${Math.max(1, Math.round(ms / 1000))}s`;
}

/** Wrap-up instruction delivered into the child session at the soft deadline. */
export function steerText(timing: RunTiming, startedAt: number): string {
    const limit = timing.deadlineAt !== undefined ? fmtMinutes(timing.deadlineAt - startedAt) : "the";
    const grace = timing.graceMs > 0 ? `about ${fmtMinutes(timing.graceMs)}` : "no time";
    return `[harness] You have reached this run's ${limit} soft deadline. Do not start new work. ` +
        `Finish or stop the step you are on, commit or save what is done, and end with a short report: ` +
        `what is complete, what is not, and where the work is (branch, commit, files). ` +
        `You have ${grace} before this run is stopped.`;
}

/** The current timing reason for a run, if any. */
export function timingReason(meta: { timing?: RunTiming }): TimingReason | undefined {
    const t = meta.timing;
    if (!t) return undefined;
    if (t.stopReason) return t.stopReason;
    if (t.steerRequestedAt !== undefined) return "deadline";
    if (t.stuckWakeSentAt !== undefined && (t.stuckAnchorAt ?? 0) >= (t.lastProgressAt ?? 0)) return "stuck";
    return undefined;
}

/**
 * One-line surface text: the reason plus what it means. Undefined when no
 * timing control has fired (limits alone are not news on every surface).
 */
export function describeTiming(meta: { timing?: RunTiming; startedAt: number; status?: string }): { reason: TimingReason; short: string; line: string } | undefined {
    const t = meta.timing;
    const reason = timingReason(meta);
    if (!t || !reason) return undefined;
    const deadline = t.deadlineAt !== undefined ? fmtMinutes(t.deadlineAt - meta.startedAt) : undefined;
    const ceiling = t.ceilingAt !== undefined ? fmtMinutes(t.ceilingAt - meta.startedAt) : undefined;
    const grace = fmtMinutes(t.graceMs);
    if (reason === "ceiling") {
        return { reason, short: "stopped: ceiling", line: `Timing: stopped: ceiling — the harness stopped this run at its ${ceiling} hard ceiling, without grace.` };
    }
    if (reason === "deadline" && t.stopReason === "deadline") {
        return { reason, short: "stopped: deadline", line: `Timing: stopped: deadline — the run passed its ${deadline} soft deadline, was told to wrap up, and had not finished ${grace} after the message reached it, so the harness stopped it.` };
    }
    if (reason === "deadline") {
        if (meta.status === undefined || meta.status === "running") {
            const pending = t.steerDeliveredAt === undefined ? " once the message reaches it (after its current tool call)" : "";
            return { reason, short: "deadline: wrapping up", line: `Timing: deadline — past its ${deadline} soft deadline; the child was told to wrap up and will be stopped ${grace} later${pending} if it has not finished.` };
        }
        if (meta.status === "completed") {
            return { reason, short: "deadline: finished in grace", line: `Timing: deadline — passed its ${deadline} soft deadline and finished within the ${grace} grace.` };
        }
        // Crashed, stopped by a user, orphaned, or lost after the deadline: the harness did not stop it.
        return { reason, short: "deadline: passed", line: `Timing: deadline — passed its ${deadline} soft deadline and was told to wrap up; it then ended ${meta.status} before the harness stopped it.` };
    }
    const window = t.stuckMs !== undefined ? fmtMinutes(t.stuckMs) : "?";
    return { reason, short: "stuck", line: `Timing: stuck — no progress (a successful tool call that is not an exact repeat of an earlier one) for ${window} outside running tool calls.` };
}

/** Short spawn-response line describing the limits in force. */
export function formatTimingLimits(timing: RunTiming, startedAt: number): string {
    const parts = [
        timing.deadlineAt !== undefined ? `soft deadline ${fmtMinutes(timing.deadlineAt - startedAt)} (+${fmtMinutes(timing.graceMs)} grace)` : "no soft deadline",
        timing.ceilingAt !== undefined ? `ceiling ${fmtMinutes(timing.ceilingAt - startedAt)}` : "no ceiling",
        timing.stuckMs !== undefined ? `stuck wake after ${fmtMinutes(timing.stuckMs)} without progress` : "no stuck wake",
    ];
    return `Timing: ${parts.join(", ")}.`;
}
