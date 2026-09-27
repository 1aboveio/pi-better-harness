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
 * Progress, defined simply: a successful `edit` or `write`, a successful `bash`
 * that runs `git commit`, or any successful tool call that directly follows a
 * failed one. Time spent waiting on a running tool call does not count toward
 * the stuck window, so a child in the middle of a 20-minute test run is not
 * stuck; a hung command is bounded by the deadline and the ceiling instead.
 */

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
    deadline_minutes: "Soft deadline in minutes (default 30; 0 = none; null = default). At the deadline the child is told to stop starting new work, commit what is done, and report, and you get one wake. If it has not finished after grace_minutes, the harness stops it with reason deadline.",
    grace_minutes: "Minutes after the soft deadline before the run is stopped (default 5; null = default).",
    max_minutes: "Hard ceiling in minutes (default 90; 0 = none; null = default). The run is stopped at once, without grace, with reason ceiling.",
    stuck_minutes: "No-progress window in minutes (default 10; 0 = off; null = default). Progress is a successful edit or write, a git commit, or a success after a failed tool call; time inside a running tool call does not count. Wakes you once per stuck spell; never stops the run.",
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
    open: Map<string, { name: string; command?: string }>;
    /** When the open set last went from empty to non-empty. */
    inFlightSince?: number;
    /** Tool-call time since the last progress (closed intervals). */
    pausedMs: number;
    lastToolFailed: boolean;
    /** The child reported delivering the wrap-up steer. */
    steerDelivered: boolean;
}

export function emptyProgress(startedAt: number): ProgressState {
    return { startedAt, open: new Map(), pausedMs: 0, lastToolFailed: false, steerDelivered: false };
}

/** Typed marker the child's control extension writes after delivering a steer. */
export const STEER_DELIVERED_EVENT = "subagent_steer_delivered";

const GIT_COMMIT = /(^|[\s;&|(])git(\s+-[cC]\s+\S+)*\s+commit\b/;

function isProgressResult(name: string, command: string | undefined, afterFailure: boolean): boolean {
    if (afterFailure) return true;
    if (name === "edit" || name === "write") return true;
    return name === "bash" && typeof command === "string" && GIT_COMMIT.test(command);
}

/** Cheap pre-filter: only these rows can change progress state. */
export function isProgressRelevantLine(line: string): boolean {
    const head = line.slice(0, 160);
    return head.includes('"tool_execution_start"') || head.includes('"message_end"') || head.includes(`"${STEER_DELIVERED_EVENT}"`);
}

/** Fold one parsed child event into the progress state. */
export function foldProgress(state: ProgressState, event: Record<string, unknown>): void {
    const type = event.type;
    if (type === STEER_DELIVERED_EVENT) { state.steerDelivered = true; return; }
    if (type === "tool_execution_start") {
        const id = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
        if (!id) return;
        const args = event.args as { command?: unknown } | undefined;
        if (state.open.size === 0) state.inFlightSince = state.lastEventAt ?? state.startedAt;
        state.open.set(id, { name: String(event.toolName ?? ""), command: typeof args?.command === "string" ? args.command : undefined });
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
    if (!failed && isProgressResult(name, started?.command, state.lastToolFailed)) {
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
        if (now >= timing.deadlineAt + timing.graceMs) actions.stop = "deadline";
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
        return { reason, short: "stopped: deadline", line: `Timing: stopped: deadline — the run passed its ${deadline} soft deadline, was told to wrap up, and had not finished after ${grace} grace, so the harness stopped it.` };
    }
    if (reason === "deadline") {
        const running = meta.status === undefined || meta.status === "running";
        return running
            ? { reason, short: "deadline: wrapping up", line: `Timing: deadline — past its ${deadline} soft deadline; the child was told to wrap up and will be stopped after ${grace} grace if it has not finished.` }
            : { reason, short: "deadline: finished in grace", line: `Timing: deadline — passed its ${deadline} soft deadline and finished within the ${grace} grace.` };
    }
    const window = t.stuckMs !== undefined ? fmtMinutes(t.stuckMs) : "?";
    return { reason, short: "stuck", line: `Timing: stuck — no progress (file edit/write, git commit, or a success after a failure) for ${window} outside running tool calls.` };
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
