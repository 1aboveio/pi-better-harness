/**
 * Pure seams for the TUI subagent navigator (issues #45 list, #46 detail,
 * #47 two-press close, #69 health display).
 *
 * Kept free of pi / pi-tui imports (mirrors widget.mjs) so unit tests pin the
 * behavior contracts without a live TUI. index.ts injects the pi-specific
 * pieces (matchesKey, truncateToWidth, CustomEditor, ctx, getDetail, closeRun)
 * at the boundary.
 *
 * The navigator is a HUMAN organization surface: it reads the #44 registry
 * visibility seams (`navigatorVisibleRuns` / `navigatorVisibleCount`). List and
 * detail views are read-only; the #47 Close action is the sole mutator, and it
 * goes through the shared #44 stop/dismiss seams (never a second persistence
 * model). The passive live widget is untouched by this module.
 *
 * Detail view (#46) refreshes via an injected interval (default 1s) and must
 * dispose that timer on every exit path (back, Escape, overlay close, teardown).
 * Close arm timers (#47) dispose on the same paths plus selection change and
 * list↔detail transitions.
 *
 * Health (#69) reuses #66/#67 observation helpers: navigator rows keep the
 * scan order name/id · model[+effort] · elapsed · tool · spend, then append
 * durable status + ≤2 compact health facts. Status is colorized semantically
 * with visible-width-aware truncation.
 */

import {
    formatNavigatorHealthFacts,
    statusThemeColor,
    truncateToVisibleWidth,
    visibleWidth,
} from "./health-surface.mjs";

/** Detail-view refresh cadence (ms). Mirrors the live widget tick. */
export const DETAIL_TICK_MS = 1000;

/** Two-press Close confirmation window (ms). Exclusive at the boundary. */
export const CLOSE_ARM_MS = 3000;

/** Footer status key for the `← subagents · N` hint (default footer mechanism). */
export const NAVIGATOR_STATUS_KEY = "subagents-nav";

/** Footer status key for the Close confirmation hint (coexists with count hint). */
export const CLOSE_CONFIRM_STATUS_KEY = "subagents-close";

/**
 * Footer hint text: `← subagents · N` while at least one visible
 * current-parent run exists, null when none (caller clears the status).
 */
export function navigatorFooterHint(count) {
    return count > 0 ? `← subagents · ${count}` : null;
}

/**
 * Publish the footer hint through pi's default footer status mechanism.
 * Sets `← subagents · N` for count ≥ 1, clears the status at 0. Returns the
 * hint (or null) so callers can dirty-check. NEVER touches the footer itself.
 */
export function applyNavigatorFooter(ui, count) {
    const hint = navigatorFooterHint(count);
    ui.setStatus(NAVIGATOR_STATUS_KEY, hint ?? undefined);
    return hint;
}

// ---------------------------------------------------------------------------
// Close confirmation (issue #47)
// ---------------------------------------------------------------------------

/**
 * Footer confirmation hint while Close is armed.
 * Running/orphaned → `x again to stop <name>`; terminal → `x again to dismiss <name>`.
 * Name falls back to id when missing/null. Orphaned uses the stop wording because
 * Close runs the shared #68 cleanup path (kill related work or finalize).
 */
export function closeConfirmHint(row) {
    if (!row) return null;
    const label = (row.name != null && String(row.name).length > 0) ? String(row.name) : String(row.id);
    const stoppable = row.status === "running" || row.status === "orphaned";
    return stoppable ? `x again to stop ${label}` : `x again to dismiss ${label}`;
}

/**
 * Publish/clear the Close confirmation hint through pi's default footer status
 * mechanism (a dedicated key so it coexists with `← subagents · N`).
 * Pass null/undefined to clear.
 */
export function applyCloseConfirmFooter(ui, hint) {
    ui.setStatus(CLOSE_CONFIRM_STATUS_KEY, hint ?? undefined);
    return hint ?? null;
}

/** Mutable Close-arm record. `id` null means disarmed. */
export function createCloseArm(id, armedAt) {
    return { id: id ?? null, armedAt: armedAt ?? 0 };
}

/** True when `arm` is live for `id` at `now` (window is [armedAt, armedAt+CLOSE_ARM_MS)). */
export function isCloseArmed(arm, id, now, windowMs = CLOSE_ARM_MS) {
    if (!arm || arm.id == null || id == null) return false;
    if (arm.id !== id) return false;
    if (typeof now !== "number" || typeof arm.armedAt !== "number") return false;
    return now >= arm.armedAt && now < arm.armedAt + windowMs;
}

/** Clear an arm record in place. */
export function disarmClose(arm) {
    if (!arm) return arm;
    arm.id = null;
    arm.armedAt = 0;
    return arm;
}

/**
 * Perform Close on a run id: reread meta + effective status, then either
 * stop+dismiss (running / orphaned) or dismiss-only (terminal / finished-during-arm).
 *
 * Reuses #44/#68 `stopRun` / `dismissRun` — never invents a second kill path.
 * For orphaned runs, dismiss happens only AFTER `stopRun` writes a terminal
 * status (killed / completed / failed / lost).
 * Unknown ids return `{ action: "missing" }` without throwing.
 *
 * @param {string} id
 * @param {object} deps
 * @param {(id: string) => object|undefined} deps.readMeta
 * @param {(m: object) => string} deps.effectiveStatus
 * @param {(id: string) => { action: string, id: string, status?: string }} deps.stopRun
 * @param {(id: string, at?: number) => object|undefined} deps.dismissRun
 * @param {() => number} [deps.now]
 */
export function executeNavigatorClose(id, deps) {
    const meta = deps.readMeta(id);
    if (!meta) return { action: "missing", id };
    const status = deps.effectiveStatus(meta);
    const at = typeof deps.now === "function" ? deps.now() : Date.now();
    // running + orphaned share the stop path (#68). stopRun itself rereads;
    // we still branch on our fresh effective status so a finish-during-arm
    // never reaches the kill path from a stale row.
    if (status === "running" || status === "orphaned") {
        const outcome = deps.stopRun(id);
        // Dismiss only after a terminal write. stopRun always finalizes
        // orphaned runs (killed / completed / failed / lost) when accepted.
        const terminalStatus = outcome?.action === "stopped"
            ? "killed"
            : outcome?.action === "finalized"
                ? outcome.status
                : undefined;
        if (!terminalStatus) {
            // Defensive: stop declined (race to another terminal). Leave
            // non-terminal orphaned undismissed so Close can be retried.
            const after = deps.readMeta(id);
            const afterStatus = after ? deps.effectiveStatus(after) : status;
            if (afterStatus === "orphaned" || afterStatus === "running") {
                return { action: "not-closed", id, status: afterStatus };
            }
            deps.dismissRun(id, at);
            return { action: "dismissed", id, status: afterStatus };
        }
        deps.dismissRun(id, at);
        return { action: "stopped-and-dismissed", id, status: terminalStatus };
    }
    deps.dismissRun(id, at);
    return { action: "dismissed", id, status };
}

/**
 * True only in an interactive TUI session with a UI present. Every navigator
 * entry point is gated on this so print/RPC sessions stay untouched.
 *
 * Pi exposes `hasUI: true` (and a `ui` object) in BOTH TUI and RPC modes
 * (extensions.md: `hasUI` guards dialog/notification methods that work in
 * both). The navigator uses terminal-only features — the `custom()` overlay
 * and the editor component factory — so the guard must require an explicit
 * `ctx.mode === "tui"` on top of UI availability; `hasUI` alone would leak
 * `setStatus`/`setEditorComponent`/`custom` calls into RPC sessions.
 */
export function isNavigatorUiAvailable(ctx) {
    return Boolean(ctx && ctx.mode === "tui" && ctx.hasUI === true && ctx.ui);
}

/**
 * Display rows for the navigator list. Input order is preserved — callers pass
 * `navigatorVisibleRuns(listMetas())`, which is newest first and already
 * excludes dismissed and foreign-parent runs (running AND terminal included).
 *
 * @param {Array<object>} metas - visible RunMeta records (newest first)
 * @param {object} deps
 * @param {(m: object) => string} deps.effectiveStatus - registry effectiveStatus
 * @param {(model?: string) => string} deps.shortModel - widget shortModel
 * @param {(ms: number) => string} deps.fmtElapsed - widget fmtElapsed
 * @param {(m: object) => string} deps.spendFor - spend summary or "" (e.g. fmtSpend(parseRun(id).usage))
 * @param {(m: object) => string} [deps.toolFor] - current/used tool label or ""
 * @param {(m: object) => string|undefined} [deps.effortFor] - model effort when available
 * @param {(m: object) => object|undefined} [deps.healthFor] - #66 HealthObservation
 * @param {number} [deps.now]
 */
export function buildNavigatorRows(metas, deps) {
    const now = deps.now ?? Date.now();
    return metas.map((m) => {
        const status = deps.effectiveStatus(m);
        const health = typeof deps.healthFor === "function" ? deps.healthFor(m) : undefined;
        const effort = typeof deps.effortFor === "function" ? deps.effortFor(m) : (m.effort ?? m.modelEffort);
        const tool = typeof deps.toolFor === "function" ? (deps.toolFor(m) || "") : "";
        return {
            id: m.id,
            name: m.name,
            status,
            model: deps.shortModel(m.model),
            // Optional effort stays adjacent to model when the host exposes it.
            effort: effort ? String(effort) : undefined,
            // Terminal runs freeze elapsed at endedAt; running runs tick to now.
            elapsed: deps.fmtElapsed((m.endedAt ?? now) - m.startedAt),
            tool,
            spend: deps.spendFor(m) || "",
            // At most two compact facts; empty for healthy/quiet (#67/#69).
            healthFacts: formatNavigatorHealthFacts(health),
        };
    });
}

// ---------------------------------------------------------------------------
// Selection state
// ---------------------------------------------------------------------------

/** Navigator list state: the rows plus the selected index (starts at top). */
export function createNavigatorState(rows) {
    const state = { rows: rows ?? [], selected: 0 };
    clampSelection(state);
    return state;
}

/** Keep the selection inside the current row list. */
export function clampSelection(state) {
    if (state.rows.length === 0) state.selected = 0;
    else if (state.selected > state.rows.length - 1) state.selected = state.rows.length - 1;
    else if (state.selected < 0) state.selected = 0;
    return state.selected;
}

/**
 * Move the selection by delta (−1 up, +1 down), clamped at both ends.
 * Returns true when the selection actually changed (callers repaint then).
 */
export function moveSelection(state, delta) {
    const before = state.selected;
    state.selected = Math.min(
        Math.max(state.selected + delta, 0),
        Math.max(0, state.rows.length - 1),
    );
    return state.selected !== before;
}

// ---------------------------------------------------------------------------
// List rendering
// ---------------------------------------------------------------------------

const SHEET_RULE = "━";
const SECTION_RULE = "─";
const LIST_ROW_START = 3;

function repeatRule(glyph, width) {
    const n = Math.max(0, Math.floor(width));
    return glyph.repeat(n);
}

function commandSheetRule(label, width) {
    const w = Math.max(0, Math.floor(width));
    if (w <= 0) return "";
    const text = label != null && String(label).length > 0 ? String(label) : "";
    if (!text) return repeatRule(SHEET_RULE, w);
    const prefix = `${SHEET_RULE}${SHEET_RULE} ${text} `;
    if (visibleWidth(prefix) >= w) return truncateToVisibleWidth(prefix, w);
    return prefix + repeatRule(SHEET_RULE, w - visibleWidth(prefix));
}

function sectionRule(label, width) {
    const w = Math.max(0, Math.floor(width));
    if (w <= 0) return "";
    const prefix = `${SECTION_RULE}${SECTION_RULE} ${label} `;
    if (visibleWidth(prefix) >= w) return truncateToVisibleWidth(prefix, w);
    return prefix + repeatRule(SECTION_RULE, w - visibleWidth(prefix));
}

function stripSectionRule(line) {
    const plain = String(line ?? "");
    const match = plain.match(/^──\s+(.+?)\s+─*$/u);
    return match ? match[1] : null;
}

export function navigatorSectionLabel(line) {
    return stripSectionRule(line);
}

/**
 * Format one navigator row in scan order (#60/#69):
 *   name/id · model [· effort] · elapsed [· tool] [· spend] · status [· fact · fact]
 * Status is colorized when `opts.colorizeStatus` is true (overlay path).
 *
 * @param {object} r - buildNavigatorRows entry
 * @param {object} [opts]
 * @param {boolean} [opts.colorizeStatus]
 * @param {(color: string, s: string) => string} [opts.fg]
 */
export function formatNavigatorRowText(r, opts = {}) {
    const name = r.name ?? r.id ?? "?";
    const model = r.model ?? "?";
    const modelPart = r.effort ? `${model} ${r.effort}` : model;
    const parts = [name, modelPart, r.elapsed ?? "?"];
    if (r.tool) parts.push(r.tool);
    if (r.spend) parts.push(r.spend);

    const statusRaw = String(r.status ?? "?");
    const statusText = opts.colorizeStatus && typeof opts.fg === "function"
        ? opts.fg(statusThemeColor(statusRaw), statusRaw)
        : statusRaw;
    parts.push(statusText);

    const facts = Array.isArray(r.healthFacts) ? r.healthFacts.filter(Boolean).slice(0, 2) : [];
    for (const f of facts) parts.push(f);
    return parts.join(" · ");
}

/**
 * Plain-text navigator lines: title, one `> `/`  `-prefixed line per row, and
 * a help line. Every line is passed through a visible-width-aware truncate so
 * the TUI width contract holds even when status is ANSI-colorized. index.ts
 * injects pi-tui's truncateToWidth; when colorization is applied first we fall
 * back to `truncateToVisibleWidth` if the injected truncator is width-naive.
 *
 * @param {object} state
 * @param {object} [opts]
 * @param {number} [opts.width]
 * @param {(s: string, w: number) => string} [opts.truncate]
 * @param {boolean} [opts.colorizeStatus] - colorize durable status (overlay)
 * @param {(color: string, s: string) => string} [opts.fg]
 */
export function buildNavigatorLines(state, opts = {}) {
    const width = opts.width ?? 80;
    const truncate = opts.truncate ?? truncateToVisibleWidth;
    const rows = state.rows ?? [];
    const lines = [commandSheetRule(`Subagents · ${rows.length}`, width)];
    const selected = rows.length > 0 ? rows[state.selected] : null;
    const stoppable = selected?.status === "running" || selected?.status === "orphaned";
    const action = stoppable ? "x stop" : (selected ? "x dismiss" : null);
    lines.push(`   ${["↑↓ select", "Enter view", action, "Esc close"].filter(Boolean).join(" · ")}`);
    lines.push("");
    if (rows.length === 0) {
        lines.push("   (no visible subagent runs)");
    }
    const colorize = opts.colorizeStatus === true;
    const fg = opts.fg;
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const prefix = i === state.selected ? "›  " : "   ";
        const body = formatNavigatorRowText(r, { colorizeStatus: colorize, fg });
        lines.push(prefix + body);
    }
    lines.push("");
    lines.push(commandSheetRule("", width));
    return lines.map((l) => {
        const cut = truncate(l, width);
        // Guarantee visible width even if host truncator counts ANSI bytes.
        return visibleWidth(cut) > width ? truncateToVisibleWidth(cut, width) : cut;
    });
}

// ---------------------------------------------------------------------------
// Detail view (issue #46)
// ---------------------------------------------------------------------------

/**
 * Assemble a detail snapshot for one run. All I/O lives behind deps so the
 * seam stays unit-testable; index.ts wires readMeta/parseRun/fmt*.
 *
 * @param {string} id
 * @param {object} deps
 * @param {(id: string) => object|undefined} deps.readMeta
 * @param {(m: object) => string} deps.effectiveStatus
 * @param {(id: string) => { finalText: string, lastActivity: string, toolCalls: string[], usage: object }} deps.parseRun
 * @param {(model?: string) => string} deps.shortModel
 * @param {(ms: number) => string} deps.fmtElapsed
 * @param {(u: object) => string} deps.fmtSpend
 * @param {(meta: object) => object|undefined} [deps.healthFor] - #66 HealthObservation
 * @param {(meta: object) => string|undefined} [deps.effortFor]
 * @param {number} [deps.now]
 * @returns {object|null} detail fields, or null when the run is unknown
 */
export function buildNavigatorDetail(id, deps) {
    const meta = deps.readMeta(id);
    if (!meta) return null;
    const now = deps.now ?? Date.now();
    const parsed = deps.parseRun(id);
    const toolCalls = parsed.toolCalls ?? [];
    const status = deps.effectiveStatus(meta);
    const running = status === "running" || status === "orphaned";
    const health = typeof deps.healthFor === "function" ? deps.healthFor(meta) : undefined;
    const effortRaw = typeof deps.effortFor === "function"
        ? deps.effortFor(meta)
        : (meta.effort ?? meta.modelEffort);
    return {
        id: meta.id,
        name: meta.name,
        status,
        model: deps.shortModel(meta.model),
        effort: effortRaw ? String(effortRaw) : undefined,
        elapsed: deps.fmtElapsed((meta.endedAt ?? now) - meta.startedAt),
        tools: toolCalls.length ? toolCalls.join(", ") : "",
        // Only a live run has a "current" tool (the latest invocation).
        currentTool: running && toolCalls.length ? toolCalls[toolCalls.length - 1] : undefined,
        spend: deps.fmtSpend(parsed.usage) || "",
        // Terminal prefers the final answer; running shows the live activity.
        output: (running ? (parsed.lastActivity || parsed.finalText) : (parsed.finalText || parsed.lastActivity)) || "",
        // Process identity from durable metadata (#63).
        pid: meta.pid,
        pgid: meta.pgid,
        pidStartTime: meta.pidStartTime,
        orphanedAt: meta.orphanedAt,
        lostAt: meta.lostAt,
        orphanedCallbackSentAt: meta.orphanedCallbackSentAt,
        lostCallbackSentAt: meta.lostCallbackSentAt,
        // Full #66 observation for sectioned detail rendering (#69).
        health: health ?? null,
        now,
    };
}

/** Format a ms age as a short label, or "—" when unknown. */
function fmtDetailAge(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return `${h}h${m % 60}m`;
}

/** Format an absolute ms timestamp relative to `now`, or absolute ISO-ish. */
function fmtDetailTs(ts, now) {
    if (typeof ts !== "number" || !Number.isFinite(ts)) return "—";
    if (typeof now === "number" && Number.isFinite(now)) {
        return `${fmtDetailAge(Math.max(0, now - ts))} ago`;
    }
    return String(ts);
}

/**
 * Plain-text detail lines with sectioned health (#69). Truncated with
 * visible-width awareness so ANSI status colorization stays width-safe.
 *
 * Sections (when data is present):
 *   header (title, status, model/effort, elapsed, spend, tools summary)
 *   process / liveness
 *   activity
 *   compaction  (separate from tool + model)
 *   active tool
 *   model call / error
 *   last meaningful activity / last log write
 *   thresholds
 *   callbacks
 *   output
 */
export function buildDetailLines(detail, opts = {}) {
    const width = opts.width ?? 80;
    const truncate = opts.truncate ?? truncateToVisibleWidth;
    const fg = typeof opts.fg === "function" ? opts.fg : null;
    const colorize = opts.colorizeStatus === true && fg;
    if (!detail) {
        return [
            commandSheetRule("Run unavailable", width),
            "   ← back · Esc close",
            "",
            commandSheetRule("", width),
        ].map((l) => truncate(l, width));
    }
    const title = detail.name || detail.id || "?";
    const lines = [];
    lines.push(commandSheetRule(title, width));

    const statusRaw = String(detail.status ?? "?");
    const statusText = colorize ? fg(statusThemeColor(statusRaw), statusRaw) : statusRaw;

    const stoppable = detail.status === "running" || detail.status === "orphaned";
    const action = stoppable ? "x stop" : "x dismiss";
    lines.push(`   ← back · ${action} · Esc close`);
    lines.push("");
    lines.push(`   status  ${statusText}`);

    const model = detail.model ?? "?";
    lines.push(detail.effort ? `   model   ${model} · effort ${detail.effort}` : `   model   ${model}`);
    lines.push(`   elapsed ${detail.elapsed ?? "?"}`);

    // Legacy tools summary (still useful as a used-tools list).
    const toolsLabel = detail.currentTool
        ? `tools   current ${detail.currentTool}`
        : (detail.tools ? `tools   ${detail.tools}` : "tools   (none)");
    lines.push(`   ${toolsLabel}`);
    lines.push(detail.spend ? `   spend   ${detail.spend}` : "   spend   (none)");

    const h = detail.health;
    const now = detail.now;

    // Process / liveness.
    lines.push("");
    lines.push(sectionRule("process", width));
    const pid = detail.pid != null ? String(detail.pid) : "—";
    const pgid = detail.pgid != null ? String(detail.pgid) : "—";
    const startTok = detail.pidStartTime != null ? String(detail.pidStartTime) : "—";
    lines.push(`   pid ${pid} · pgid ${pgid}`);
    lines.push(`   start-token ${startTok}`);
    // Prefer observation liveness, but never claim "supervised" when the
    // detail header already shows a non-running effective status (legacy
    // dead-running metadata → effective "exited" must read as terminal).
    let live = h?.process?.liveness;
    if (!live || (detail.status !== "running" && live === "supervised")) {
        live = detail.status === "orphaned" ? "orphaned"
            : detail.status === "lost" ? "lost"
            : detail.status === "running" ? "supervised"
            : "terminal";
    }
    lines.push(`   liveness ${live}`);
    if (detail.orphanedAt != null) lines.push(`   orphaned ${fmtDetailTs(detail.orphanedAt, now)}`);
    if (detail.lostAt != null) lines.push(`   lost ${fmtDetailTs(detail.lostAt, now)}`);

    // Activity.
    lines.push(sectionRule("activity", width));
    lines.push(`   ${h?.activity ?? "—"}`);
    if (h?.meaningfulAgeMs != null) {
        lines.push(`   last meaningful ${fmtDetailAge(h.meaningfulAgeMs)} ago`);
    } else if (h?.lastMeaningfulAt != null) {
        lines.push(`   last meaningful ${fmtDetailTs(h.lastMeaningfulAt, now)}`);
    }

    // Compaction, separate from tool and model state.
    lines.push(sectionRule("compaction", width));
    if (h?.compaction) {
        const c = h.compaction;
        const age = c.ageMs != null ? ` · ${fmtDetailAge(c.ageMs)}` : "";
        lines.push(`   ${c.state}${age}`);
        if (c.last) {
            const bits = [];
            if (c.last.reason) bits.push(c.last.reason);
            if (c.last.aborted) bits.push("aborted");
            if (c.last.errorMessage) bits.push(c.last.errorMessage);
            if (bits.length) lines.push(`   last ${bits.join(" · ")}`);
        }
    } else {
        lines.push("   —");
    }

    // Active tool, separate from compaction and model state.
    lines.push(sectionRule("active tool", width));
    if (h?.tool) {
        const t = h.tool;
        if (t.state === "idle" || !t.active) {
            lines.push("   idle");
        } else {
            const age = t.ageMs != null ? ` · ${fmtDetailAge(t.ageMs)}` : "";
            lines.push(`   ${t.state} · ${t.active.toolName}${age}`);
        }
    } else if (detail.currentTool) {
        lines.push(`   ${detail.currentTool}`);
    } else {
        lines.push("   idle");
    }

    // Model call / error, separate from tool state.
    lines.push(sectionRule("model", width));
    if (h?.model) {
        const m = h.model;
        lines.push(`   state ${m.state}`);
        if (m.listWarning) lines.push(`   warning ${m.listWarning}`);
        if (m.retry) {
            const a = m.retry.attempt != null ? String(m.retry.attempt) : "?";
            const max = m.retry.maxAttempts != null ? String(m.retry.maxAttempts) : "?";
            lines.push(`   retry ${a}/${max}`);
        }
        if (m.lastError) {
            const age = m.lastError.at != null ? ` · ${fmtDetailTs(m.lastError.at, now)}` : "";
            lines.push(`   last error ${m.lastError.message}${age}`);
        }
        if (Array.isArray(m.errorHistory) && m.errorHistory.length > 0) {
            const recent = m.errorHistory.slice(-3);
            for (const e of recent) {
                const age = e.at != null ? ` · ${fmtDetailTs(e.at, now)}` : "";
                lines.push(`   history ${e.message}${age}`);
            }
        }
        if (m.longModelCall) {
            const age = m.longModelCall.ageMs != null ? ` · ${fmtDetailAge(m.longModelCall.ageMs)}` : "";
            lines.push(`   long call${age}`);
        }
    } else {
        lines.push("   —");
    }

    // Last log write.
    lines.push(sectionRule("log", width));
    if (h?.rawLog && (h.rawLog.mtimeMs != null || h.rawLog.sizeBytes != null || h.rawLog.error)) {
        if (h.rawLog.mtimeMs != null) lines.push(`   last write ${fmtDetailTs(h.rawLog.mtimeMs, now)}`);
        if (h.rawLog.sizeBytes != null) lines.push(`   size ${h.rawLog.sizeBytes}B`);
        if (h.rawLog.error) lines.push(`   error ${h.rawLog.error}`);
    } else {
        lines.push("   —");
    }

    // Thresholds.
    lines.push(sectionRule("thresholds", width));
    if (h?.thresholds) {
        const t = h.thresholds;
        lines.push(`   quiet ${fmtDetailAge(t.quietMs)} · stale ${fmtDetailAge(t.staleMs)}`);
        lines.push(`   long-tool ${fmtDetailAge(t.longToolMs)} · long-compact ${fmtDetailAge(t.longCompactionMs)}`);
    } else {
        lines.push("   —");
    }

    // Callback notification timestamps.
    lines.push(sectionRule("callbacks", width));
    const cbOrphan = detail.orphanedCallbackSentAt;
    const cbLost = detail.lostCallbackSentAt;
    if (cbOrphan != null || cbLost != null) {
        if (cbOrphan != null) lines.push(`   orphaned notified ${fmtDetailTs(cbOrphan, now)}`);
        if (cbLost != null) lines.push(`   lost notified ${fmtDetailTs(cbLost, now)}`);
    } else {
        lines.push("   (none)");
    }

    lines.push(sectionRule("output", width));
    const body = detail.output && String(detail.output).trim() ? String(detail.output) : "(no output yet)";
    for (const raw of body.split(/\r?\n/)) {
        lines.push(raw.length ? `   ${raw}` : "   ");
    }
    lines.push("");
    lines.push(`   ← back · ${action} · Esc close`);
    lines.push(commandSheetRule("", width));
    return lines.map((l) => {
        const cut = truncate(l, width);
        return visibleWidth(cut) > width ? truncateToVisibleWidth(cut, width) : cut;
    });
}

/** Keep selection on `id` when still present; otherwise clamp in place. */
export function selectById(state, id) {
    if (id == null) {
        clampSelection(state);
        return state.selected;
    }
    const idx = (state.rows ?? []).findIndex((r) => r && r.id === id);
    // Missing id: leave the index alone and clamp so a neighbor (or 0) is
    // selected — never leave selected out of range after a dismiss/disappear.
    state.selected = idx >= 0 ? idx : state.selected;
    return clampSelection(state);
}

/**
 * Replace the visible row list while keeping selection stable by run id.
 *
 * Status refreshes and dismissals rebuild the visible set (reorder, status
 * text change, or a run disappearing). Selection must follow the previously
 * selected id when it is still present; otherwise clamp safely. Returns the
 * resulting selected index.
 */
export function applyNavigatorRows(state, nextRows) {
    const prevId =
        state && state.rows && state.rows.length > 0 && state.selected >= 0
            ? state.rows[state.selected]?.id
            : null;
    state.rows = Array.isArray(nextRows) ? nextRows : [];
    return selectById(state, prevId);
}

// ---------------------------------------------------------------------------
// Overlay component (opened via ctx.ui.custom(..., { overlay: true }))
// ---------------------------------------------------------------------------

/**
 * Build the custom component pi renders as the focused navigator overlay.
 *
 * @param {Array<object>} rows - buildNavigatorRows output (newest first)
 * @param {object} deps
 * @param {(data: string, keyId: string) => boolean} deps.matchKey - pi-tui matchesKey
 * @param {(s: string, w: number) => string} deps.truncate - pi-tui truncateToWidth
 * @param {object} tui - pi TUI (requestRender)
 * @param {object} [theme] - pi theme (fg); optional in tests
 * @param {(v: null) => void} done - pi close callback
 */
export function createNavigatorOverlayComponent(rows, deps, tui, theme, done) {
    const state = createNavigatorState(rows);
    /** @type {'list' | 'detail'} */
    let mode = "list";
    /** @type {object|null} */
    let detail = null;
    /** @type {string|null} id of the run currently shown in detail */
    let detailId = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    let detailTimer = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let closeArmTimer = null;
    const closeArm = createCloseArm(null, 0);
    let closed = false;

    const setIntervalFn = deps.setInterval ?? globalThis.setInterval.bind(globalThis);
    const clearIntervalFn = deps.clearInterval ?? globalThis.clearInterval.bind(globalThis);
    const setTimeoutFn = deps.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    const clearTimeoutFn = deps.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
    const nowFn = deps.now ?? (() => Date.now());
    const tickMs = deps.tickMs ?? DETAIL_TICK_MS;

    const fg = (color, s) =>
        theme && typeof theme.fg === "function" ? theme.fg(color, s) : s;

    function publishCloseHint(hint) {
        if (typeof deps.onCloseConfirmHint === "function") {
            try { deps.onCloseConfirmHint(hint); } catch { /* ignore */ }
        }
    }

    function stopCloseArmTimer() {
        if (closeArmTimer != null) {
            try { clearTimeoutFn(closeArmTimer); } catch { /* ignore */ }
            closeArmTimer = null;
        }
    }

    function clearCloseArm() {
        const wasArmed = closeArm.id != null;
        stopCloseArmTimer();
        disarmClose(closeArm);
        if (wasArmed) publishCloseHint(null);
    }

    function armCloseFor(row) {
        if (!row || row.id == null) return;
        stopCloseArmTimer();
        const at = nowFn();
        closeArm.id = row.id;
        closeArm.armedAt = at;
        const hint = closeConfirmHint(row);
        publishCloseHint(hint);
        // Auto-disarm exactly at the window boundary.
        closeArmTimer = setTimeoutFn(() => {
            closeArmTimer = null;
            // Only clear if this arm is still the live one.
            if (closeArm.id === row.id && closeArm.armedAt === at) {
                disarmClose(closeArm);
                publishCloseHint(null);
                try { tui.requestRender(); } catch { /* ignore */ }
            }
        }, CLOSE_ARM_MS);
        try { tui.requestRender(); } catch { /* ignore */ }
    }

    function stopDetailTimer() {
        if (detailTimer != null) {
            try { clearIntervalFn(detailTimer); } catch { /* ignore */ }
            detailTimer = null;
        }
    }

    function loadDetail(id) {
        if (typeof deps.getDetail !== "function") return null;
        try {
            return deps.getDetail(id) ?? null;
        } catch {
            return null;
        }
    }

    function refreshRows() {
        if (typeof deps.getRows !== "function") return;
        try {
            const next = deps.getRows();
            // Keep selection by id across status refreshes / dismissals so the
            // highlight does not jump when the visible set reorders or shrinks.
            if (Array.isArray(next)) applyNavigatorRows(state, next);
        } catch { /* keep prior rows */ }
    }

    function currentTargetRow() {
        if (mode === "detail") {
            if (detailId == null) return null;
            // Prefer live detail snapshot (status may have changed while armed).
            if (detail && detail.id === detailId) {
                return { id: detail.id, name: detail.name, status: detail.status };
            }
            const fromList = (state.rows ?? []).find((r) => r && r.id === detailId);
            return fromList ?? { id: detailId, name: detailId, status: "completed" };
        }
        if (state.rows.length === 0) return null;
        return state.rows[state.selected] ?? null;
    }

    function handleCloseKey() {
        const row = currentTargetRow();
        if (!row || row.id == null) return;
        const now = nowFn();
        if (isCloseArmed(closeArm, row.id, now)) {
            // Second press within the window on the same run — act.
            const armedId = closeArm.id;
            clearCloseArm();
            let outcome = { action: "missing", id: armedId };
            if (typeof deps.closeRun === "function") {
                try {
                    outcome = deps.closeRun(armedId) ?? outcome;
                } catch {
                    outcome = { action: "missing", id: armedId };
                }
            }
            if (typeof deps.onClosed === "function") {
                try { deps.onClosed(outcome); } catch { /* ignore */ }
            }
            // Leave detail (if any) and refresh the visible list.
            if (mode === "detail") {
                stopDetailTimer();
                mode = "list";
                detail = null;
                detailId = null;
            }
            refreshRows();
            // Prefer keeping selection near the closed run's former neighbors.
            selectById(state, armedId);
            clampSelection(state);
            try { tui.requestRender(); } catch { /* ignore */ }
            return;
        }
        // First press (or expired / different selection): arm only — never mutate.
        armCloseFor(row);
    }

    function enterDetail() {
        if (state.rows.length === 0) return;
        const row = state.rows[state.selected];
        if (!row) return;
        clearCloseArm();
        detailId = row.id;
        detail = loadDetail(detailId) ?? {
            id: detailId,
            name: row.name,
            status: row.status,
            model: row.model,
            elapsed: row.elapsed,
            spend: row.spend,
            tools: "",
            output: "",
        };
        mode = "detail";
        stopDetailTimer();
        // Refresh once per second while the detail view is open.
        detailTimer = setIntervalFn(() => {
            if (mode !== "detail" || detailId == null) return;
            detail = loadDetail(detailId) ?? detail;
            try { tui.requestRender(); } catch { /* ignore */ }
        }, tickMs);
        try { tui.requestRender(); } catch { /* ignore */ }
    }

    function leaveDetail() {
        if (mode !== "detail") return;
        const viewedId = detailId;
        clearCloseArm();
        stopDetailTimer();
        mode = "list";
        detail = null;
        detailId = null;
        // Optional live list refresh so a disappeared run can clamp cleanly.
        refreshRows();
        selectById(state, viewedId);
        try { tui.requestRender(); } catch { /* ignore */ }
    }

    function close() {
        if (closed) return;
        closed = true;
        clearCloseArm();
        stopDetailTimer();
        mode = "list";
        detail = null;
        detailId = null;
        try { done(null); } catch { /* ignore */ }
    }

    function dispose() {
        // Session teardown / host overlay dismiss — always safe, idempotent.
        clearCloseArm();
        stopDetailTimer();
        mode = "list";
        detail = null;
        detailId = null;
    }

    /** True when input is the Close key (`x` / `X`). */
    function isCloseKey(data) {
        if (deps.matchKey(data, "x") || deps.matchKey(data, "X")) return true;
        // Literal fallback for tests / hosts that don't map a Key.x id.
        return data === "x" || data === "X";
    }

    if (deps.initialDetailId != null) {
        const idx = (state.rows ?? []).findIndex((r) => r && r.id === deps.initialDetailId);
        if (idx >= 0) {
            state.selected = idx;
            enterDetail();
        }
    }

    return {
        render(width) {
            // Colorize durable status inside the line (visible-width-aware),
            // then apply row-level accent/dim only to non-status chrome so the
            // semantic status color is not overwritten by whole-line theming.
            if (mode === "detail") {
                const lines = buildDetailLines(detail, {
                    width,
                    truncate: deps.truncate,
                    colorizeStatus: true,
                    fg,
                });
                return lines.map((line, i) => {
                    if (i === 0) return fg("accent", line);
                    if (i === 1) return fg("dim", line);
                    if (i === lines.length - 1) return fg("dim", line);
                    if (stripSectionRule(line)) return fg("dim", line);
                    if (line.trimStart().startsWith("← back")) return fg("dim", line);
                    return line;
                });
            }
            const lines = buildNavigatorLines(state, {
                width,
                truncate: deps.truncate,
                colorizeStatus: true,
                fg,
            });
            return lines.map((line, i) => {
                if (i === 0) return fg("accent", line);
                if (i === 1 || i === lines.length - 1) return fg("dim", line);
                // Selected row: keep the line readable without recoloring the
                // already-semantic status token (status is colored in-body).
                if (state.rows.length > 0 && i === LIST_ROW_START + state.selected) {
                    return line.startsWith("›  ")
                        ? fg("accent", "›  ") + line.slice(3)
                        : fg("accent", line);
                }
                return line;
            });
        },
        handleInput(data) {
            if (closed) return;
            if (mode === "detail") {
                if (isCloseKey(data)) {
                    handleCloseKey();
                } else if (deps.matchKey(data, "left")) {
                    leaveDetail();
                } else if (deps.matchKey(data, "escape")) {
                    close();
                }
                return;
            }
            if (isCloseKey(data)) {
                handleCloseKey();
            } else if (deps.matchKey(data, "up")) {
                if (moveSelection(state, -1)) {
                    clearCloseArm();
                    tui.requestRender();
                }
            } else if (deps.matchKey(data, "down")) {
                if (moveSelection(state, 1)) {
                    clearCloseArm();
                    tui.requestRender();
                }
            } else if (deps.matchKey(data, "enter")) {
                enterDetail();
            } else if (deps.matchKey(data, "escape")) {
                close();
            }
        },
        invalidate() {
            // Stateless render — nothing cached to clear on theme changes.
        },
        /** Clear detail + close-arm timers. Safe to call multiple times / after close. */
        dispose,
    };
}

/** Factory in the shape ctx.ui.custom expects: (tui, theme, keybindings, done). */
export function createNavigatorOverlayFactory(rows, deps) {
    return (tui, theme, _keybindings, done) =>
        createNavigatorOverlayComponent(rows, deps, tui, theme, done);
}

/**
 * Open the navigator as a focused overlay. `ui.custom(factory, { overlay: true })`
 * makes pi render it on top of existing content and focus it on show.
 *
 * Pi's `custom()` resolves with the value passed to `done()` (typically `null`),
 * NOT the component instance. Callers that need the component (e.g. to capture
 * `dispose` for session_shutdown) must use `deps.onComponent`, which is invoked
 * synchronously inside the factory when pi constructs the overlay.
 *
 * @param {object} ui
 * @param {Array<object>} rows
 * @param {object} [deps]
 * @param {(component: object) => void} [deps.onComponent] - sync capture seam
 */
export function showNavigator(ui, rows, deps = {}) {
    const baseFactory = createNavigatorOverlayFactory(rows, deps);
    return ui.custom((tui, theme, keybindings, done) => {
        const component = baseFactory(tui, theme, keybindings, done);
        if (typeof deps.onComponent === "function") {
            try { deps.onComponent(component); } catch { /* never break overlay open */ }
        }
        return component;
    }, { overlay: true });
}

/**
 * Open the navigator and track its dispose hook for session teardown.
 *
 * Pi's `ui.custom()` promise resolves to `done()`'s value (`null`), not the
 * component — so dispose MUST be captured synchronously via `onComponent`.
 * The active dispose reference is cleared when the overlay promise settles
 * (fulfill OR reject) and is safe to invoke from session_shutdown while open.
 *
 * Settlement cleanup uses `.then(clear, clear)` rather than `.finally(...)`:
 * `finally` rethrows into a second promise, and `void` does not consume that
 * rejection — Pi rejects `custom()` when overlay factory/show setup fails, which
 * would emit `unhandledRejection` (Node 22 exits 1). Both branches are handled
 * and `clear` never rethrows. Callers (index `openNavigator`) may discard the
 * returned promise; attach their own handler only if they need the settle value.
 *
 * @param {object} ui - pi UI with `custom()`
 * @param {Array<object>} rows
 * @param {object} deps - showNavigator deps (matchKey, truncate, getDetail, …)
 * @param {{ get: () => (undefined|(() => void)), set: (fn: undefined|(() => void)) => void }} disposeSlot
 * @returns {Promise<unknown>} pi custom() promise (done value on fulfill; rejects if custom() rejects).
 *   Safe to discard: internal handlers consume both settle paths (no unhandledRejection).
 */
export function openTrackedNavigator(ui, rows, deps, disposeSlot) {
    // Drop any prior overlay's timers before opening a new one (defensive;
    // pi normally only allows one focused custom overlay at a time).
    try { disposeSlot.get()?.(); } catch { /* ignore */ }
    disposeSlot.set(undefined);

    let disposeToken;
    const opened = showNavigator(ui, rows, {
        ...deps,
        onComponent: (component) => {
            if (typeof deps?.onComponent === "function") {
                try { deps.onComponent(component); } catch { /* ignore */ }
            }
            if (component && typeof component.dispose === "function") {
                disposeToken = () => {
                    try { component.dispose(); } catch { /* ignore */ }
                };
                disposeSlot.set(disposeToken);
            }
        },
    });
    // Token-guarded slot cleanup on BOTH settle paths. `.then(clear, clear)`
    // (not `.finally`) so a rejected custom() does not create a second promise
    // that rethrows into an unhandledRejection when callers discard the return.
    const clear = () => {
        if (disposeSlot.get() === disposeToken) {
            disposeSlot.set(undefined);
        }
    };
    void Promise.resolve(opened).then(clear, clear);
    return opened;
}

/** Invoke and clear a tracked navigator dispose slot (session_shutdown path). */
export function disposeTrackedNavigator(disposeSlot) {
    try { disposeSlot.get()?.(); } catch { /* ignore */ }
    disposeSlot.set(undefined);
}

// ---------------------------------------------------------------------------
// Editor wrapper (empty-editor ← interception by composition)
// ---------------------------------------------------------------------------

/**
 * Wrap any editor component so bare ← on an EMPTY editor (with visible runs)
 * enters subagent navigation, and everything else delegates unchanged.
 *
 * Composition, not replacement: a delegating Proxy forwards every property get
 * (methods bound to the inner editor) and every set to the wrapped component,
 * so the duck-typing pi applies to whatever `setEditorComponent` produces
 * (onSubmit/onChange assignment, setText, borderColor, setPaddingX,
 * setAutocompleteProvider, the `actionHandlers` app-keybinding wiring) keeps
 * working against the inner editor.
 *
 * @param {object} inner - the wrapped editor component
 * @param {object} deps
 * @param {(data: string) => boolean} deps.isOpenTrigger - bare ← match (pi-tui matchesKey(data, Key.left))
 * @param {() => boolean} deps.canOpen - visible current-parent runs exist
 * @param {() => boolean} [deps.isNavigating] - true while main-window navigation owns empty-editor keys
 * @param {(data: string) => boolean} [deps.isReturnTrigger] - Down returns to the input line while navigating
 * @param {(data: string) => boolean} [deps.isPreviousTrigger] - Up moves to the previous main-window row while navigating
 * @param {(data: string) => boolean} [deps.isViewTrigger] - Enter opens selected detail while navigating
 * @param {(data: string) => boolean} [deps.isStopTrigger] - x stops selected run while navigating
 * @param {() => void} [deps.onReturn]
 * @param {() => void} [deps.onPrevious]
 * @param {() => void} [deps.onView]
 * @param {() => void} [deps.onStop]
 * @param {() => void} [deps.onCancel]
 * @param {() => void} deps.onOpen - enter main-window navigation
 */
export function wrapEditor(inner, deps) {
    return new Proxy(inner, {
        get(target, prop) {
            if (prop === "handleInput") {
                return (data) => {
                    if (target.getText() === "") {
                        if (typeof deps.isNavigating === "function" && deps.isNavigating()) {
                            if (deps.isReturnTrigger?.(data)) { deps.onReturn?.(); return; }
                            if (deps.isPreviousTrigger?.(data)) { deps.onPrevious?.(); return; }
                            if (deps.isViewTrigger?.(data)) { deps.onView?.(); return; }
                            if (deps.isStopTrigger?.(data)) { deps.onStop?.(); return; }
                            deps.onCancel?.();
                            target.handleInput(data);
                            return;
                        }
                        if (deps.isOpenTrigger(data) && deps.canOpen()) {
                            deps.onOpen();
                            return;
                        }
                    }
                    target.handleInput(data);
                };
            }
            const v = Reflect.get(target, prop);
            return typeof v === "function" ? v.bind(target) : v;
        },
        set(target, prop, value) {
            return Reflect.set(target, prop, value);
        },
    });
}

/** String marks (not Symbols) so a RELOADED module instance recognizes a
 *  factory installed by its previous incarnation. */
export const NAVIGATOR_FACTORY_MARK = "__piBetterSubagentsNavigatorFactory";
const NAVIGATOR_FACTORY_REFRESH = "__piBetterSubagentsNavigatorRefresh";

/**
 * Install the navigator editor factory exactly once per UI.
 *
 * - No factory configured: wrap a default editor built by deps.createDefaultEditor.
 * - A factory from ANOTHER extension is configured: wrap its product (compose).
 * - Our own marked factory is already installed (repeat session_start, or a
 *   reloaded module seeing the previous incarnation's factory): refresh its
 *   deps and keep it — never stack a second wrapper.
 *
 * @param {object} ui - pi ctx.ui (getEditorComponent / setEditorComponent)
 * @param {object} deps - wrapEditor deps + createDefaultEditor(tui, theme, keybindings)
 * @returns the installed (or refreshed) factory
 */
export function installNavigatorEditor(ui, deps) {
    const prev = typeof ui.getEditorComponent === "function" ? ui.getEditorComponent() : undefined;
    if (prev && prev[NAVIGATOR_FACTORY_MARK] === true) {
        prev[NAVIGATOR_FACTORY_REFRESH](deps);
        return prev;
    }
    let currentDeps = deps;
    const base = prev;
    const factory = (tui, theme, keybindings) => {
        const inner = base
            ? base(tui, theme, keybindings)
            : currentDeps.createDefaultEditor(tui, theme, keybindings);
        return wrapEditor(inner, currentDeps);
    };
    factory[NAVIGATOR_FACTORY_MARK] = true;
    factory[NAVIGATOR_FACTORY_REFRESH] = (next) => {
        // Mutate in place: wrappers already built from this factory captured the
        // deps OBJECT, so refreshed callbacks must reach them too (a /reload
        // keeps the live editor instance alive).
        Object.assign(currentDeps, next);
    };
    ui.setEditorComponent(factory);
    return factory;
}
