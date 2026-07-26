/**
 * Pure helpers for the live subagent status widget.
 *
 * Kept free of TUI / registry I/O so unit tests can pin the flicker-related
 * contracts (dirty-check, fixed-width geometry, undefined clear) without a
 * live pi session.
 *
 * Host note: pi's setWidget(string[]) path disposes + rebuilds the component
 * tree on every call. Callers must skip identical frames and keep line geometry
 * stable so neighboring ▶ job-* rows do not jump.
 */

import { formatWidgetHealthSuffix } from "./health-surface.mjs";

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Default ticker cadence (ms). */
export const TICK_MS = 1000;

/**
 * How often to re-parse a run log for spend/tool on the UI hot path.
 * Elapsed still updates every tick; spend may lag by this much (AC3).
 */
export const SPEND_REFRESH_MS = 5000;

/**
 * Value that clears the widget. pi only clears on `undefined`; `[]` leaves an
 * empty residual widget node.
 */
export const WIDGET_CLEAR = undefined;

/** Fixed field widths so line geometry does not jump as values grow. */
export const ELAPSED_WIDTH = 8; // "999h 59m", "99m 59s", "9999s"
export const TOKENS_WIDTH = 6; // "999.9k", "99.9M"
export const COST_WIDTH = 7; // "$999.99", "$0.0000"

/** "45s" · "2m 03s" · "1h 04m" — variable width (list/finalize paths). */
export function fmtElapsed(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rs = s % 60;
    if (m < 60) return `${m}m ${String(rs).padStart(2, "0")}s`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `${h}h ${String(rm).padStart(2, "0")}m`;
}

/** Fixed-width elapsed for the live widget (right-pad to ELAPSED_WIDTH). */
export function fmtElapsedFixed(ms) {
    return fmtElapsed(ms).padEnd(ELAPSED_WIDTH, " ");
}

/** "412" · "1.2k" · "27.9k" · "1.4M". */
export function fmtTokens(n) {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtTokensFixed(n) {
    return fmtTokens(n).padStart(TOKENS_WIDTH, " ");
}

/** Compact USD cost, e.g. "$0.0057" or "$1.23". */
export function fmtCost(usd) {
    if (usd <= 0) return "$0";
    return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** Compact model label for the widget: drop the provider prefix. */
export function shortModel(model) {
    return model ? (model.split("/").pop() ?? model) : "?";
}

export function fmtCostFixed(usd) {
    return fmtCost(usd).padStart(COST_WIDTH, " ");
}

/**
 * One-line spend summary, or "" when nothing has been spent yet.
 * Variable-width form used by list/finalize (not the live widget).
 */
export function fmtSpend(u) {
    if (!u || (u.total <= 0 && u.costUSD <= 0)) return "";
    return `${fmtTokens(u.total)} tok (↑${fmtTokens(u.input)} ↓${fmtTokens(u.output)}) · ${fmtCost(u.costUSD)}`;
}

/**
 * Fixed-width spend for the live widget. Empty string when no spend yet —
 * callers should still reserve geometry via a stable suffix policy if needed;
 * once spend appears, widths stay constant as digits grow within the caps.
 */
export function fmtSpendFixed(u) {
    if (!u || (u.total <= 0 && u.costUSD <= 0)) return "";
    return (
        `${fmtTokensFixed(u.total)} tok` +
        ` (↑${fmtTokensFixed(u.input)} ↓${fmtTokensFixed(u.output)})` +
        ` · ${fmtCostFixed(u.costUSD)}`
    );
}

/** Deep equality for widget line arrays. */
export function linesEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/**
 * Decide what setWidget should receive for this frame.
 *
 * @param {string[]|undefined|null} prevLines - last lines sent to setWidget
 * @param {string[]|null} nextLines - newly built lines, or null when idle
 * @returns {{ op: 'skip' } | { op: 'set', lines: string[] } | { op: 'clear' }}
 */
export function nextWidgetAction(prevLines, nextLines) {
    if (nextLines === null || nextLines === undefined) {
        // Already cleared / never painted — nothing to do.
        if (prevLines === undefined || prevLines === null) return { op: "skip" };
        // Had visible content (or a mistaken [] residual) → clear with undefined.
        return { op: "clear" };
    }
    if (linesEqual(prevLines, nextLines)) return { op: "skip" };
    return { op: "set", lines: nextLines };
}

/**
 * Build the widget lines for currently-running subagents.
 *
 * Healthy/quiet health is silent (issue #67). Degraded observations may append
 * a short suffix via `healthById` without making the widget interactive.
 *
 * @param {object} p
 * @param {Array<{ id: string, name?: string|null, model?: string|null, startedAt: number }>} p.running
 * @param {number} p.frame - spinner frame index
 * @param {number} p.now - Date.now()
 * @param {Record<string, { usage?: object, tool?: string|null }>} [p.spendById]
 * @param {Record<string, object>|undefined} [p.healthById] - optional #66 observations
 * @param {string|null} [p.affordanceHint] - left-arrow affordance shown on the title line
 * @param {string|null} [p.selectedId] - selected run id while the main-window list is focused
 * @returns {string[]}
 */
export function buildWidgetLines(p) {
    const running = p.running ?? [];
    const frame = p.frame ?? 0;
    const now = p.now ?? Date.now();
    const spendById = p.spendById ?? {};
    const healthById = p.healthById ?? {};
    const selectedId = p.selectedId ?? null;
    const spin = SPINNER[((frame % SPINNER.length) + SPINNER.length) % SPINNER.length];
    const hint = p.affordanceHint ? `  ${p.affordanceHint}` : "";
    const lines = [`Subagents · ${running.length} running${hint}`];
    for (const m of running) {
        const el = fmtElapsedFixed(now - m.startedAt);
        const snap = spendById[m.id] ?? {};
        const spend = fmtSpendFixed(snap.usage);
        const tool = snap.tool ? ` · ${snap.tool}` : "";
        const health = formatWidgetHealthSuffix(healthById[m.id]);
        const nm = m.name ?? m.id;
        const prefix = selectedId === m.id ? "› " : "  ";
        // Preserve list-show-model (#14): "name · shortModel" before fixed elapsed.
        // Two spaces before elapsed keep a stable gap; elapsed itself is fixed-width.
        lines.push(`${prefix}${spin} ${nm} · ${shortModel(m.model)}  ${el}${tool}${spend ? `  ${spend}` : ""}${health}`);
    }
    return lines;
}

/**
 * Whether a cached spend snapshot is still fresh enough for the UI tick.
 *
 * @param {{ refreshedAt: number, logSize?: number }|null|undefined} cached
 * @param {number} now
 * @param {number} [logSize]
 * @param {number} [ttlMs]
 */
export function isSpendCacheFresh(cached, now, logSize, ttlMs = SPEND_REFRESH_MS) {
    if (!cached) return false;
    if (typeof logSize === "number" && cached.logSize !== logSize) return false;
    return now - cached.refreshedAt < ttlMs;
}

/**
 * Whether a cached health-log parse is still valid for the widget tick.
 * Invalidates on log size or mtime change so growth/rewrite re-extracts, while
 * unchanged logs skip the synchronous full-log reparse on every 1 Hz frame.
 *
 * @param {{ logSize?: number, mtimeMs?: number }|null|undefined} cached
 * @param {number} logSize
 * @param {number} [mtimeMs]
 */
export function isHealthLogCacheFresh(cached, logSize, mtimeMs) {
    if (!cached) return false;
    if (cached.logSize !== logSize) return false;
    if (typeof mtimeMs === "number" && cached.mtimeMs !== mtimeMs) return false;
    return true;
}

/**
 * Resolve child-event facts via size/mtime cache. Calls `extract` only on miss
 * so the widget hot path can bound full-log reparses across frames.
 *
 * @param {{ facts: unknown, rawLog: unknown, logSize?: number, mtimeMs?: number }|null|undefined} cached
 * @param {{ logSize: number, mtimeMs?: number }} identity
 * @param {() => { facts: unknown, rawLog: unknown }} extract
 * @returns {{ facts: unknown, rawLog: unknown, hit: boolean }}
 */
export function resolveHealthLogExtraction(cached, identity, extract) {
    if (isHealthLogCacheFresh(cached, identity.logSize, identity.mtimeMs)) {
        return { facts: cached.facts, rawLog: cached.rawLog, hit: true };
    }
    const { facts, rawLog } = extract();
    return { facts, rawLog, hit: false };
}
