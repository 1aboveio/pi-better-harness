/**
 * pi-better-subagents — Claude Code-style async subagents for pi.
 *
 * Core semantic: launching a subagent IS the deliverable. `subagent_spawn`
 * starts a detached `pi -p` child and returns immediately with a run id; the
 * foreground session stays free for the human while it runs. When the child
 * finishes, its RESULT is posted back into the session (delivered as a followUp
 * so it never cuts into work in progress). The foreground is never BLOCKED on a
 * wait/poll loop — it's only nudged once, at completion, with the answer.
 *
 *   launch is the result · completion posts back · the foreground never blocks
 */

import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, statSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "@earendil-works/pi-ai";
import {
    CLOSE_CONFIRM_STATUS_KEY,
    NAVIGATOR_STATUS_KEY,
    disposeBackgroundWorkNavigator,
    ensureBackgroundWorkNavigator,
    isNavigatorUiAvailable,
    refreshBackgroundWorkNavigator,
    registerBackgroundWorkProvider,
    type BackgroundWorkDetail,
    type BackgroundWorkProvider,
    type BackgroundWorkRow,
} from "./shared-navigator.ts";
import { spawnDetached, type SpawnResult } from "./spawn.ts";
import { parseRun, type Usage } from "./parse.ts";
import { finalizeRun as finalizeRunCore } from "./finalization.ts";
import { loadConfig, normalizeTools, resolveExtensionPath, SAFE_DEFAULT_TOOLS, SAFE_CLEAN_TOOLS, DEFAULT_MAX_CONCURRENT } from "./config.ts";
import { resolveExtensions, extensionArgs } from "./extensions.ts";
import { maybeBuildSandboxCommand } from "./sandbox.ts";
import { resolveSubagentWorkspace } from "./git-workspace.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import {
    sessionsDir,
    runDir,
    logPathFor,
    promptPathFor,
    nextRunId,
    writeMeta,
    readMeta,
    listMetas,
    effectiveStatus,
    ownedByThisParent,
    navigatorVisibleRuns,
    isDismissed,
    dismissRun,
    type RunMeta,
    type RunCallbackOrigin,
} from "./registry.ts";
import {
    captureProcessIdentity,
    extractChildEventFactsFromLog,
    loadHealthThresholdsFromConfig,
    needsMonitoring,
    observeRunHealth,
    realProcessProbe,
    reconcileRun,
    type ChildEventFacts,
    type HealthObservation,
    type ProcessProbe,
    type RawLogDiagnostic,
} from "./health.ts";
import {
    assignBatchJobNames,
    formatBatchLaunchResponse,
    mergeJobOptions,
    nextBatchId,
    planBatchLaunches,
    validateBatchPlan,
} from "./batch.mjs";
import {
    formatCapacityRejectMessage,
    getSharedCapacityGate,
} from "./capacity.mjs";
import { buildHealthCallbackDelivery } from "./completion.ts";
import {
    text,
    subagentListTool,
    subagentOutputTool,
    subagentResultTool,
    subagentStopTool,
} from "./tools.ts";
import { stopRun } from "./stop.ts";
import {
    WIDGET_CLEAR,
    fmtElapsed,
    fmtSpend,
    shortModel,
    isSpendCacheFresh,
    resolveHealthLogExtraction,
} from "./widget.ts";
import {
    executeNavigatorClose,
    buildNavigatorRows,
    buildNavigatorDetail,
} from "./navigator.ts";

/** The tools this extension registers — excluded from children by default so a
 *  subagent cannot recursively spawn more subagents unless explicitly allowed. */
const SUBAGENT_TOOLS = [
    "subagent_spawn",
    "subagent_spawn_batch",
    "subagent_list",
    "subagent_output",
    "subagent_stop",
    "subagent_result",
];

// ---- retired live status widget ------------------------------------------
//
// The shared background-work navigator owns the active subagent list. This
// legacy `subagents` widget key is now clear-only so users do not see the same
// run twice (`background work · N` plus `Subagents · N running`). Pure widget
// helpers remain for compatibility tests and older render contracts.

/** Freshest UI-bearing context, captured from session_start / tool calls. */
let uiCtx: ExtensionContext | undefined;
let activeCallbackOrigin: RunCallbackOrigin | undefined;
let ticker: ReturnType<typeof setInterval> | undefined;
let widgetNavActive = false;
let widgetNavSelectedId: string | undefined;

type SpendSnap = {
    usage: Usage;
    tool: string | null;
    refreshedAt: number;
    logSize: number;
};
/** Per-run spend/tool cache for the UI hot path. */
const spendCache = new Map<string, SpendSnap>();

type HealthLogSnap = {
    facts: ChildEventFacts;
    rawLog: RawLogDiagnostic;
    logSize: number;
    mtimeMs?: number;
};
/** Per-run health-log parse cache — size/mtime gated (no full reparse every tick). */
const healthLogCache = new Map<string, HealthLogSnap>();

function logStatOf(id: string): { size: number; mtimeMs?: number } {
    try {
        const st = statSync(logPathFor(id));
        return { size: st.size, mtimeMs: Math.trunc(st.mtimeMs) };
    } catch {
        return { size: 0 };
    }
}

function logSizeOf(id: string): number {
    return logStatOf(id).size;
}

function callbackOriginFromContext(ctx: ExtensionContext): RunCallbackOrigin {
    let sessionId: string | undefined;
    try {
        sessionId = ctx.sessionManager?.getSessionId();
    } catch {
        sessionId = undefined;
    }
    return { cwd: ctx.cwd, sessionId };
}

function callbackSuppressionReason(meta: RunMeta, active: RunCallbackOrigin | undefined = activeCallbackOrigin): string | undefined {
    const origin = meta.callbackOrigin;
    if (origin) {
        if (!active) return "active session identity is unavailable";
        if (origin.cwd !== active.cwd) return `origin cwd ${origin.cwd} does not match active cwd ${active.cwd}`;
        if (origin.sessionId && origin.sessionId !== active.sessionId) {
            return `origin session ${origin.sessionId} does not match active session ${active.sessionId ?? "unknown"}`;
        }
        return undefined;
    }

    if (active && meta.cwd !== active.cwd) {
        return `legacy run cwd ${meta.cwd} does not match active cwd ${active.cwd}`;
    }
    return undefined;
}

function belongsToActiveNavigatorSession(meta: RunMeta): boolean {
    const active = activeCallbackOrigin;
    if (!active) return false;
    const origin = meta.callbackOrigin;
    if (origin) {
        if (origin.cwd !== active.cwd) return false;
        if (origin.sessionId || active.sessionId) return origin.sessionId === active.sessionId;
        return true;
    }
    if (active.sessionId) return false;
    return meta.cwd === active.cwd;
}

function markCompletionCallbackSuppressed(id: string, reason: string, now: number = Date.now()): void {
    const meta = readMeta(id);
    if (!meta || meta.completionCallbackSuppressedAt !== undefined) return;
    meta.completionCallbackSuppressedAt = now;
    meta.completionCallbackSuppressedReason = reason;
    writeMeta(meta);
}

function markHealthCallbackSuppressed(meta: RunMeta, status: "orphaned" | "lost", reason: string, now: number): void {
    if (status === "orphaned") {
        if (meta.orphanedCallbackSuppressedAt !== undefined) return;
        meta.orphanedCallbackSuppressedAt = now;
        meta.orphanedCallbackSuppressedReason = reason;
    } else {
        if (meta.lostCallbackSuppressedAt !== undefined) return;
        meta.lostCallbackSuppressedAt = now;
        meta.lostCallbackSuppressedReason = reason;
    }
    writeMeta(meta);
}

function isHealthCallbackHandled(meta: RunMeta, status: "orphaned" | "lost"): boolean {
    return status === "orphaned"
        ? meta.orphanedCallbackSentAt !== undefined || meta.orphanedCallbackSuppressedAt !== undefined
        : meta.lostCallbackSentAt !== undefined || meta.lostCallbackSuppressedAt !== undefined;
}

/** Refresh spend/tool for a run only when the cache is stale or the log grew. */
function spendFor(id: string, now: number): { usage: Usage; tool: string | null } {
    const logSize = logSizeOf(id);
    const cached = spendCache.get(id);
    if (isSpendCacheFresh(cached, now, logSize)) {
        return { usage: cached!.usage, tool: cached!.tool };
    }
    const r = parseRun(id);
    const snap: SpendSnap = {
        usage: r.usage,
        tool: r.toolCalls.length ? r.toolCalls[r.toolCalls.length - 1]! : null,
        refreshedAt: now,
        logSize,
    };
    spendCache.set(id, snap);
    return { usage: snap.usage, tool: snap.tool };
}

/**
 * Observe health for a widget/navigator row. Best-effort; never throws into the tick.
 * Full log parse is gated by size/mtime so the 1 Hz frame does not re-read and
 * reparse every complete log when nothing changed (#67).
 *
 * When `displayStatus` is omitted, uses durable `meta.status`.
 * Navigator detail/list pass `effectiveStatus(meta)` so process liveness cannot
 * say "supervised" while the UI shows transient "exited" (#69).
 */
function observeWidgetHealth(
    meta: RunMeta,
    now: number,
    displayStatus?: RunMeta["status"] | "exited",
): HealthObservation | undefined {
    try {
        const { size: logSize, mtimeMs } = logStatOf(meta.id);
        const cached = healthLogCache.get(meta.id);
        const resolved = resolveHealthLogExtraction(
            cached,
            { logSize, mtimeMs },
            () => extractChildEventFactsFromLog(meta.id, { now }),
        );
        if (!resolved.hit) {
            healthLogCache.set(meta.id, {
                facts: resolved.facts as ChildEventFacts,
                rawLog: resolved.rawLog as RawLogDiagnostic,
                logSize,
                mtimeMs,
            });
        }
        const status = displayStatus ?? meta.status;
        return observeRunHealth({
            // Prefer caller-supplied effective/display status (navigator detail)
            // so liveness cannot say "supervised" while the UI shows "exited".
            status,
            now,
            facts: resolved.facts as ChildEventFacts,
            rawLog: resolved.rawLog as RawLogDiagnostic,
            thresholds: loadHealthThresholdsFromConfig(),
            startedAt: meta.startedAt,
        });
    } catch {
        return undefined;
    }
}

function syncWidgetNavSelection(running: RunMeta[]): void {
    if (!widgetNavActive) return;
    if (running.length === 0) {
        widgetNavActive = false;
        widgetNavSelectedId = undefined;
        return;
    }
    if (!widgetNavSelectedId || !running.some((m) => m.id === widgetNavSelectedId)) {
        // Start on the row nearest the input line; Down returns to input.
        widgetNavSelectedId = running[running.length - 1]?.id;
    }
}

/**
 * Clear the retired legacy subagent widget and refresh the shared navigator.
 * The shared background-work navigator is now the only list surface; keeping
 * this path as clear-only prevents the old `Subagents · N running` widget from
 * duplicating the same run below `background work · N`.
 */
function renderWidget(): void {
    const ctx = uiCtx;
    if (!ctx || !ctx.hasUI) return;
    updateNavigatorFooter(ctx);
    try { ctx.ui.setWidget("subagents", WIDGET_CLEAR); } catch { /* ignore */ }
    spendCache.clear();
    healthLogCache.clear();
    stopTicker();
}

/** Clear the retired widget if a UI is present. */
function ensureTicker(): void {
    if (!uiCtx?.hasUI) return;
    renderWidget();
}

function stopTicker(): void {
    if (ticker) { clearInterval(ticker); ticker = undefined; }
}

// ---- periodic health reconciliation (#63) --------------------------------
//
// Reconciles durable supervision status for current-parent running/orphaned
// runs (process-group-only, ADR 0002): a run whose child is gone but whose
// captured process group still has live members becomes durable non-terminal
// `orphaned`; a run with no credible process-group evidence becomes durable
// terminal `lost`. Escaped/reparented descendants are out of contract.
// Reconciliation never kills anything; it only writes truth. The ticker
// exists only while current-parent running/orphaned work needs monitoring.

/** How often supervision is reconciled. Independent of the 1 Hz widget tick. */
const HEALTH_TICK_MS = 15_000;
let healthTicker: ReturnType<typeof setInterval> | undefined;
/** ExtensionAPI retained so health transitions can deliver coordinator follow-ups (#65). */
let healthPi: ExtensionAPI | undefined;

/**
 * Deliver a durable, deduped coordinator follow-up for orphaned/lost (#65).
 *
 * Markers live on RunMeta so reloads and repeated health ticks never re-fire.
 * A marker means successful handoff only: written after sendMessage returns, or
 * after intentionally suppressing the model path under callback:false. A failed
 * or crashed delivery leaves the marker unset so reload/recovery can retry.
 * `callback:false` suppresses the model message only — human ui.notify is
 * handled by the caller. Uses the same non-interrupting followUp mechanics as
 * completion, with distinct ATTENTION wording from buildHealthCallbackDelivery.
 */
function deliverHealthCallback(pi: ExtensionAPI | undefined, meta: RunMeta, status: "orphaned" | "lost", now: number): void {
    if (!pi) return;
    if (isHealthCallbackHandled(meta, status)) return;

    const suppressionReason = callbackSuppressionReason(meta);
    if (suppressionReason) {
        markHealthCallbackSuppressed(meta, status, suppressionReason, now);
        return;
    }

    const callback = meta.callback !== false;
    const label = meta.name ? `${meta.name} (${meta.id})` : meta.id;
    const delivery = buildHealthCallbackDelivery({ id: meta.id, label, status, callback });
    if (!delivery) {
        // callback:false — model follow-up suppressed; mark handled so recovery
        // does not spin forever. Human notify remains the caller's job.
        if (status === "orphaned") meta.orphanedCallbackSentAt = now;
        else meta.lostCallbackSentAt = now;
        writeMeta(meta);
        return;
    }
    try {
        pi.sendMessage(
            { customType: "subagent-health", content: delivery.content, display: true },
            delivery.options,
        );
    } catch {
        // Handoff failed — leave marker unset so a later tick/reload can retry.
        // Never let a delivery failure break the health ticker.
        return;
    }
    // Marker = successful handoff (sendMessage returned), not mere attempt.
    if (status === "orphaned") meta.orphanedCallbackSentAt = now;
    else meta.lostCallbackSentAt = now;
    writeMeta(meta);
}

/** One reconciliation + durable health-callback recovery pass. */
function reconcileHealth(): void {
    const ctx = uiCtx;
    const pi = healthPi;
    for (const summary of listMetas()) {
        if (!ownedByThisParent(summary)) continue;
        // running/orphaned: process reconcile. lost: durable callback recovery only.
        if (summary.status !== "running" && summary.status !== "orphaned" && summary.status !== "lost") continue;
        // Re-read under the id: finalizeRun / subagent_stop may have written a
        // terminal status since listMetas() snapshotted.
        const meta = readMeta(summary.id);
        if (!meta) continue;
        if (meta.status !== "running" && meta.status !== "orphaned" && meta.status !== "lost") continue;
        const now = Date.now();

        if (meta.status === "running" || meta.status === "orphaned") {
            const result = reconcileRun(meta, realProcessProbe, now);
            if (result.changed) {
                Object.assign(meta, result.patch, { status: result.status });
                writeMeta(meta);
                if (result.transition) {
                    // Human-visible health (always) on fresh transitions.
                    if (!callbackSuppressionReason(meta)) {
                        const label = meta.name ? `${meta.name} (${meta.id})` : meta.id;
                        const note = result.status === "orphaned"
                            ? `Subagent ${label} lost supervision — related processes may still be alive (orphaned).`
                            : `Subagent ${label} is lost — no related process remains and no terminal result was observed.`;
                        try { ctx?.ui.notify(note, "warning"); } catch { /* ignore */ }
                    }
                }
            }
        }

        // Durable recovery independent of a fresh transition: any current
        // orphaned/lost without a successful handoff marker must eventually
        // deliver exactly one coordinator follow-up (or mark callback:false).
        if (meta.status === "orphaned" || meta.status === "lost") {
            deliverHealthCallback(pi, meta, meta.status, now);
        }
    }
    // Stop existing the moment nothing current-parent needs monitoring/recovery.
    if (!needsMonitoring(listMetas())) stopHealthTicker();
}

/** Start the reconciliation loop if it isn't already running. */
function ensureHealthTicker(): void {
    if (healthTicker) return;
    healthTicker = setInterval(reconcileHealth, HEALTH_TICK_MS);
    healthTicker.unref?.(); // never keep the process alive on our account
}

function stopHealthTicker(): void {
    if (healthTicker) { clearInterval(healthTicker); healthTicker = undefined; }
}

/** Test/diagnostic seam: whether the periodic reconciliation loop is active. */
export function isHealthTickerActive(): boolean {
    return healthTicker !== undefined;
}

/**
 * Spawn-time identity probe. Production uses the OS-backed probe; extension-
 * level tests substitute a deterministic fake at this kernel boundary (never a
 * mock of a first-party module) via setIdentityProbeForTests.
 */
let spawnIdentityProbe: ProcessProbe = realProcessProbe;
export function setIdentityProbeForTests(probe: ProcessProbe | undefined): void {
    spawnIdentityProbe = probe ?? realProcessProbe;
}

// ---- minimal subagent navigator (empty-editor ←, #45) --------------------
// ---- subagent navigator (empty-editor ← list #45, live detail #46) --------
// ---- subagent navigator (list #45, detail #46, two-press close #47) -------
//
// Human-facing TUI surface. Glue points, all gated on isNavigatorUiAvailable so
// print/RPC sessions never see any of it:
//   1. footer hint `← subagents · N` via the DEFAULT footer status mechanism
//      (setStatus — the full footer is never replaced);
//   2. an editor wrapper that intercepts bare ← only when the editor is empty
//      and at least one non-dismissed current-parent run is running,
//      delegating everything else to the wrapped
//      editor (composition via navigator.mjs, tested with fakes);
//   3. a focused overlay (ctx.ui.custom(..., { overlay: true })) listing the
//      #44 navigatorVisibleRuns newest first, with Enter → live detail view
//      that refreshes once per second (#46) and two-press `x` Close (#47).
//      Detail + close-arm timers dispose on back, Escape, overlay close,
//      selection change, list↔detail return, and session_shutdown.

let unregisterSubagentProvider: (() => void) | undefined;
const TERMINAL_NAVIGATOR_RETENTION_MS = 30_000;

/**
 * Observe health for a navigator row/detail (#69). Reuses the size/mtime-gated
 * log cache so the overlay refresh does not reparse every complete log on each
 * paint. Passes effective/display status so detail
 * liveness matches the status line for legacy dead-running metadata.
 * Best-effort; never throws into the TUI.
 */
function observeNavigatorHealth(meta: RunMeta, now: number = Date.now()): HealthObservation | undefined {
    return observeWidgetHealth(meta, now, effectiveStatus(meta));
}

/** Rows for the overlay: visible current-parent runs, newest first (#44 seam). */
function navigatorRows() {
    const now = Date.now();
    return buildNavigatorRows(sessionVisibleNavigatorRuns(), {
        effectiveStatus,
        shortModel,
        fmtElapsed,
        now,
        spendFor: (m: RunMeta) => {
            const snap = spendFor(m.id, now);
            return fmtSpend(snap.usage);
        },
        toolFor: (m: RunMeta) => {
            const snap = spendFor(m.id, now);
            return snap.tool ?? "";
        },
        // Effort is shown when available on metadata; Pi does not always expose it.
        effortFor: (m: RunMeta) => {
            const any = m as RunMeta & { effort?: string; modelEffort?: string };
            return any.effort ?? any.modelEffort;
        },
        healthFor: (m: RunMeta) => observeNavigatorHealth(m, now),
    });
}

/** Runs that should advertise/open the left-arrow navigator affordance. */
function navigatorRunningRuns(): RunMeta[] {
    return sessionVisibleNavigatorRuns().filter((m) => effectiveStatus(m) === "running");
}

function navigatorRunningCount(): number {
    return navigatorRunningRuns().length;
}

function sessionVisibleNavigatorRuns(): RunMeta[] {
    const now = Date.now();
    return navigatorVisibleRuns(listMetas())
        .filter(belongsToActiveNavigatorSession)
        .filter((m) => !isExpiredTerminalNavigatorRun(m, now));
}

function isExpiredTerminalNavigatorRun(meta: RunMeta, now: number): boolean {
    const status = effectiveStatus(meta);
    if (!isTerminalNavigatorStatus(status)) return false;
    const endedAt = meta.endedAt ?? meta.lostAt;
    return typeof endedAt === "number" && now - endedAt >= TERMINAL_NAVIGATOR_RETENTION_MS;
}

function isTerminalNavigatorStatus(status: string): boolean {
    return status !== "running" && status !== "orphaned";
}

/** Live detail snapshot for one run (registry + log parse + health). */
function navigatorDetail(id: string) {
    const now = Date.now();
    return buildNavigatorDetail(id, {
        readMeta,
        effectiveStatus,
        parseRun,
        shortModel,
        fmtElapsed,
        fmtSpend,
        now,
        effortFor: (m: RunMeta) => {
            const any = m as RunMeta & { effort?: string; modelEffort?: string };
            return any.effort ?? any.modelEffort;
        },
        healthFor: (m: RunMeta) => observeNavigatorHealth(m, now),
    });
}

/** Shared #44 stop+dismiss path used by navigator Close (#47). */
function navigatorCloseRun(id: string) {
    return executeNavigatorClose(id, {
        readMeta,
        effectiveStatus,
        stopRun,
        dismissRun,
    });
}

/** Publish/clear the Close confirmation footer hint (TUI only). */
function publishCloseConfirmHint(ctx: ExtensionContext, hint: string | null): void {
    if (!isNavigatorUiAvailable(ctx)) return;
    try {
        ctx.ui.setStatus(CLOSE_CONFIRM_STATUS_KEY, hint ?? undefined);
    } catch { /* ignore */ }
}

function statusTone(status: string): BackgroundWorkRow["statusTone"] {
    switch (status) {
        case "running": return "running";
        case "completed": return "success";
        case "failed":
        case "lost": return "failed";
        case "killed":
        case "orphaned": return "warning";
        default: return "muted";
    }
}

function subagentWorkRows(now: number): BackgroundWorkRow[] {
    const startedById = new Map(sessionVisibleNavigatorRuns().map((m) => [m.id, m.startedAt]));
    return navigatorRows().map((row) => {
        const bits = [];
        if (row.model) bits.push(row.effort ? `${row.model} ${row.effort}` : row.model);
        if (row.tool) bits.push(row.tool);
        if (row.spend) bits.push(row.spend);
        return {
            providerId: "subagents",
            id: row.id,
            name: row.name,
            model: row.model,
            effort: row.effort,
            tool: row.tool,
            tokens: row.spend,
            status: row.status,
            statusTone: statusTone(row.status),
            kind: "subagent",
            elapsed: row.elapsed,
            primary: bits.join(" · ") || "subagent run",
            facts: row.healthFacts,
            sortStartedAt: startedById.get(row.id) ?? now,
        };
    });
}

function subagentWorkDetail(id: string, now: number): BackgroundWorkDetail | null {
    const detail = navigatorDetail(id);
    if (!detail) return null;
    const metadata = [
        { label: "provider", value: "Subagents" },
        { label: "model", value: detail.effort ? `${detail.model} · effort ${detail.effort}` : detail.model },
        { label: "elapsed", value: detail.elapsed },
        { label: "tools", value: detail.currentTool ? `current ${detail.currentTool}` : (detail.tools || "(none)") },
        { label: "spend", value: detail.spend || "(none)" },
        { label: "pid", value: detail.pid != null ? String(detail.pid) : "-" },
        { label: "pgid", value: detail.pgid != null ? String(detail.pgid) : "-" },
    ];
    return {
        providerId: "subagents",
        id: detail.id,
        title: detail.name || detail.id,
        status: detail.status,
        statusTone: statusTone(detail.status),
        subtitle: detail.currentTool ? `current tool ${detail.currentTool}` : undefined,
        metadata,
        evidence: { label: "output", text: detail.output || "(no output yet)" },
        footerActions: [detail.status === "running" || detail.status === "orphaned" ? "x stop" : "x dismiss"],
    };
}

function ensureSubagentProvider(): void {
    if (unregisterSubagentProvider) return;
    const provider: BackgroundWorkProvider = {
        id: "subagents",
        label: "Subagents",
        priority: 10,
        visibleCount: () => navigatorRunningCount(),
        listRows: (now) => subagentWorkRows(now),
        detail: (id, now) => subagentWorkDetail(id, now),
        armCloseLabel: (row) => row.status === "running" || row.status === "orphaned" ? "x again to stop" : "x again to dismiss",
        close: (id) => {
            const outcome = navigatorCloseRun(id) as { action: string; id: string; status?: string };
            return { ...outcome, providerId: "subagents" };
        },
    };
    unregisterSubagentProvider = registerBackgroundWorkProvider(provider);
}

function selectedWidgetNavRun(): RunMeta | undefined {
    const running = navigatorRunningRuns();
    syncWidgetNavSelection(running);
    return running.find((m) => m.id === widgetNavSelectedId);
}

function enterWidgetNav(ctx: ExtensionContext): void {
    if (!isNavigatorUiAvailable(ctx)) return;
    const running = navigatorRunningRuns();
    if (running.length === 0) return;
    widgetNavActive = true;
    widgetNavSelectedId = running[running.length - 1]?.id;
    try { renderWidget(); } catch { /* ignore */ }
}

function exitWidgetNav(): void {
    if (!widgetNavActive) return;
    widgetNavActive = false;
    widgetNavSelectedId = undefined;
    try { renderWidget(); } catch { /* ignore */ }
}

function moveWidgetNavPrevious(): void {
    const running = navigatorRunningRuns();
    syncWidgetNavSelection(running);
    const idx = running.findIndex((m) => m.id === widgetNavSelectedId);
    if (idx > 0) widgetNavSelectedId = running[idx - 1]?.id;
    try { renderWidget(); } catch { /* ignore */ }
}

function returnWidgetNavToInput(): void {
    const running = navigatorRunningRuns();
    syncWidgetNavSelection(running);
    const idx = running.findIndex((m) => m.id === widgetNavSelectedId);
    if (idx >= 0 && idx < running.length - 1) {
        widgetNavSelectedId = running[idx + 1]?.id;
        try { renderWidget(); } catch { /* ignore */ }
        return;
    }
    exitWidgetNav();
}

function viewWidgetNavSelection(ctx: ExtensionContext): void {
    const selected = selectedWidgetNavRun();
    if (!selected) return;
    openNavigator(ctx, selected.id);
}

function stopWidgetNavSelection(ctx: ExtensionContext): void {
    const selected = selectedWidgetNavRun();
    if (!selected) return;
    try { navigatorCloseRun(selected.id); } catch { /* ignore */ }
    updateNavigatorFooter(ctx);
    try { renderWidget(); } catch { /* ignore */ }
}

/** Open the focused navigator overlay. No-op without a UI or visible runs. */
function openNavigator(ctx: ExtensionContext, initialDetailId?: string): void {
    void initialDetailId;
    ensureNavigator(ctx);
}

/** Publish/clear the running-only `← subagents · N` footer hint (dirty-checked). */
function updateNavigatorFooter(ctx: ExtensionContext | undefined): void {
    refreshBackgroundWorkNavigator(ctx);
}

/** Install the empty-editor ← wrapper once per UI (reload-safe, composable). */
function ensureNavigator(ctx: ExtensionContext): void {
    if (!isNavigatorUiAvailable(ctx)) return;
    try {
        ensureSubagentProvider();
        ensureBackgroundWorkNavigator(ctx, {
            createDefaultEditor: (tui: any, theme: any, keybindings: any) =>
                new CustomEditor(tui, theme, keybindings),
            isOpenTrigger: (data: string) => matchesKey(data, Key.left),
            matchKey: (data: string, keyId: string) => matchesKey(data, keyId),
            truncate: truncateToWidth,
        });
    } catch { /* ignore */ }
}

/** Resolve the pi binary once per session. */
let cachedPi: string | undefined;
function resolvePiBinary(): string {
    if (cachedPi !== undefined) return cachedPi;
    try {
        cachedPi = execSync("which pi", { encoding: "utf-8", timeout: 3000 }).trim();
    } catch {
        cachedPi = "pi";
    }
    return cachedPi;
}

/**
 * Finalize a run once its child exits. Host-facing wrapper around the
 * first-party finalizer (finalization.ts) so tests can exercise the durable
 * path without importing the pi package.
 */
function finalizeRun(pi: ExtensionAPI, ctx: ExtensionContext, id: string, code: number | null): void {
    // Host-facing wrapper around first-party finalizer (finalization.ts).
    // Coherent child-exit evidence may supersede provisional orphaned/lost
    // reconciliation; finalization.ts enforces canExitFinalize + lifecycle authority.
    finalizeRunCore(id, code, {
        renderWidget,
        notify: (message, level) => {
            try { ctx.ui.notify(message, level); } catch { /* ignore */ }
        },
        sendMessage: (message, options) => {
            const meta = readMeta(id);
            if (!meta) return;
            const suppressionReason = callbackSuppressionReason(meta);
            if (suppressionReason) {
                markCompletionCallbackSuppressed(id, suppressionReason);
                return;
            }
            pi.sendMessage(message, options);
        },
    });
}

export default function (pi: ExtensionAPI) {
    // Capture for the health ticker (module-level); needed for orphaned/lost
    // coordinator follow-ups that fire outside a tool-call stack (#65).
    healthPi = pi;
    ensureSubagentProvider();

    type SpawnParams = {
        prompt: string; name?: string; model?: string; tools?: string;
        exclude_tools?: string; clean?: boolean; sandbox?: boolean;
        sandbox_dir?: string; callback?: boolean; cwd?: string;
        git_clone_workspace?: boolean; approve?: boolean; allow_nested?: boolean;
    };

    /**
     * Shared internal spawn path used by both subagent_spawn and
     * subagent_spawn_batch. Every launched job becomes a normal subagent run
     * with its own run ID, process, log, metadata, callback, result/output/stop
     * behavior, and sandboxing.
     */
    async function spawnSubagentRun(
        ctx: ExtensionContext,
        p: SpawnParams,
        batchInfo?: { batchId: string; batchName?: string },
    ): Promise<{
        id: string;
        meta: RunMeta;
        spawned: SpawnResult;
        runtime: string;
        warn: string;
        sandboxDir?: string;
    }> {
        const cfg = loadConfig();
        const callbackOrigin = callbackOriginFromContext(ctx);
        activeCallbackOrigin = callbackOrigin;

        // Sandbox is ON by default. sandbox_dir moves the confinement + working
        // dir elsewhere. git_clone_workspace prepares a disposable clone with
        // .git/ inside the writable root for Git-mutating sandboxed subagents.
        const explicitSandbox = p.sandbox === true || typeof p.sandbox_dir === "string" || p.git_clone_workspace === true;
        const sandboxEnabled = p.sandbox !== false; // default on

        mkdirSync(sessionsDir(), { recursive: true });
        const id = nextRunId();
        mkdirSync(runDir(id), { recursive: true });

        const workspace = resolveSubagentWorkspace({
            ctxCwd: ctx.cwd,
            cwd: p.cwd,
            sandboxDir: p.sandbox_dir,
            gitCloneWorkspace: p.git_clone_workspace,
            runId: id,
            runDirPath: runDir(id),
            sandboxEnabled,
        });
        const cwd = workspace.cwd;
        const requestedSandboxDir = workspace.requestedSandboxDir;
        const model = p.model ?? cfg.defaultModel ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);

        if (requestedSandboxDir) mkdirSync(requestedSandboxDir, { recursive: true });
        writeFileSync(promptPathFor(id), p.prompt);

        const clean = p.clean === true;

        let allow = normalizeTools(
            p.tools ?? cfg.defaultTools ?? (clean ? SAFE_CLEAN_TOOLS : SAFE_DEFAULT_TOOLS),
        );
        if (p.allow_nested) {
            const have = new Set(allow.split(","));
            allow = [...allow.split(","), ...SUBAGENT_TOOLS.filter((t) => !have.has(t))]
                .filter(Boolean).join(",");
        }

        const resolution = resolveExtensions({
            tools: allow, model, clean, allowNested: p.allow_nested, config: cfg,
        });
        const { args: extArgs, missing } = extensionArgs(resolution, resolveExtensionPath);
        if (missing.length) {
            throw new Error(
                `Subagent needs extension(s) that are not installed: ${missing.join(", ")}. ` +
                `Install them, drop the tools that require them, or remove the mapping from config.json.`,
            );
        }

        const excludes = new Set<string>();
        if (p.exclude_tools) for (const t of p.exclude_tools.split(",")) if (t.trim()) excludes.add(t.trim());
        if (!p.allow_nested && resolution.mode === "inherit") {
            for (const t of SUBAGENT_TOOLS) excludes.add(t);
        }

        const args = [
            "-p", "--mode", "json",
            "--session-dir", sessionsDir(),
            "--session-id", id,
            ...extArgs,
            ...(model ? ["--model", model] : []),
            ...(allow ? ["--tools", allow] : []),
            ...(excludes.size ? ["--exclude-tools", [...excludes].join(",")] : []),
            ...(p.approve ? ["--approve"] : []),
            p.prompt,
        ];

        const piBin = resolvePiBinary();
        const sandboxCommand = requestedSandboxDir
            ? maybeBuildSandboxCommand({
                profilePath: join(runDir(id), "sandbox.sb"),
                writableDir: requestedSandboxDir, home: homedir(), piBin, piArgs: args,
            }, { sandboxEnabled, explicitSandbox })
            : undefined;
        const cmd = sandboxCommand ?? { file: piBin, fileArgs: args };
        const sandboxDir = sandboxCommand ? requestedSandboxDir : undefined;

        const spawned = spawnDetached({ file: cmd.file, fileArgs: cmd.fileArgs, cwd, logPath: logPathFor(id) });
        // Record process identity (pgid, start-time token) so health
        // reconciliation can tell a supervised child from a recycled pid
        // or an orphaned process group (#63). Best-effort: when the OS
        // probes are unavailable the fields stay absent and the run is
        // reconciled via the conservative old-metadata path.
        const identity = captureProcessIdentity(spawned.pid, spawnIdentityProbe);

        const meta: RunMeta = {
            id, name: p.name, status: "running",
            pid: spawned.pid, spawnPid: process.pid, model, cwd,
            ...identity,
            promptPreview: p.prompt.slice(0, 200),
            startedAt: Date.now(), logPath: logPathFor(id), sessionId: id,
            callbackOrigin,
            sandbox: sandboxDir, callback: p.callback !== false,
            ...batchInfo,
        };
        writeMeta(meta);

        void spawned.exit.then((code) => finalizeRun(pi, ctx, id, code));

        uiCtx = ctx;
        ensureTicker();
        // Start periodic supervision reconciliation (self-stops when idle).
        ensureHealthTicker();
        // Footer hint: a visible run now exists, so `← background work · N` shows.
        updateNavigatorFooter(ctx);

        const runtime = resolution.mode === "inherit"
            ? `Runtime: ALL installed extensions (inheritExtensions) — mid-turn drain risk\n`
            : resolution.specs.length
                ? `Runtime: isolated · extensions ${resolution.specs.join(", ")}\n`
                : `Runtime: isolated · built-in tools only\n`;
        const warn = resolution.unmapped.length
            ? `NOTE: no extension mapped for ${resolution.unmapped.join(", ")} — ` +
              `${resolution.unmapped.length > 1 ? "these tools" : "this tool"} will NOT exist in the child. ` +
              `Add a toolExtensions entry in config.json.\n`
            : "";
        return { id, meta, spawned, runtime, warn, sandboxDir };
    }

    // ---- subagent_spawn -------------------------------------------------
    pi.registerTool({
        name: "subagent_spawn",
        label: "Spawn Subagent",
        description:
            "Launch a task in a background pi subagent (a detached `pi -p` process) and return " +
            "IMMEDIATELY with a run id. The foreground session stays free. Completion is reported " +
            "later on the user's next turn — never wait or poll for it.",
        promptSnippet: "Delegate a task to a background subagent that runs without blocking you",
        promptGuidelines: [
            "Use subagent_spawn for independent work the user should not have to wait on. It returns at once with a run id; that return IS the deliverable — report the id to the user and continue.",
            "After subagent_spawn, do NOT call subagent_output or subagent_result in a loop to wait for the result, and do NOT sleep. The run completes on its own and reports back on the next turn.",
            "Only call subagent_result / subagent_output when the user explicitly asks how a run is going or for its result.",
            "The tools param is both the tool allowlist AND what determines which extensions load in the child (e.g. tools='read,bash,web_fetch' loads only the web-tools package). Ask for the tools the task needs and nothing more; clean:true gives a built-ins-only child. Pick a model with the model param (e.g. 'xai/grok-4.5').",
            "By default the subagent is sandboxed (writes confined to its working dir, reads and network open) and triggers completion here on finish. Set callback:false to finish quietly — then read the result on demand via subagent_result.",
            "Use git_clone_workspace:true when the subagent will mutate Git in a sandbox. The parent prepares a disposable, self-contained clone with a real .git/ directory inside the sandbox root, so linked-worktree metadata outside the sandbox cannot stall the child.",
        ],
        parameters: Type.Object({
            prompt: Type.String({ description: "The task for the subagent. This is the only context it gets — be self-contained." }),
            name: Type.Optional(Type.String({ description: "Short label for the run (e.g. 'reviewer')." })),
            model: Type.Optional(Type.String({ description: "Model as provider/id (default: inherit foreground model)." })),
            tools: Type.Optional(Type.String({ description: "Tool allowlist: comma-separated names the child may use (e.g. 'read,bash,web_fetch'). This ALSO selects which extensions load — only packages backing a requested tool are loaded. Defaults to the configured safe set." })),
            exclude_tools: Type.Optional(Type.String({ description: "Comma-separated tool denylist, applied on top of the allowlist." })),
            clean: Type.Optional(Type.Boolean({ description: "Run a hermetic child with NO extensions at all (only built-ins: read, bash, edit, write). Default false — the extensions backing the requested tools load, so web_fetch and model auth (e.g. xai) work." })),
            sandbox: Type.Optional(Type.Boolean({ description: "Default TRUE (macOS): kernel-confine the child's file WRITES to its working dir — reads and network stay open, but it cannot write outside, whatever it runs. Set false to allow writes anywhere." })),
            sandbox_dir: Type.Optional(Type.String({ description: "Confine writes to (and run the child in) this directory instead of the working dir. Created if missing." })),
            callback: Type.Optional(Type.Boolean({ description: "Default TRUE: on completion, trigger a turn that calls subagent_result and presents the result. Set false to finish quietly — the result is then read on demand via subagent_result." })),
            cwd: Type.Optional(Type.String({ description: "Working directory (default: current)." })),
            git_clone_workspace: Type.Optional(Type.Boolean({ description: "Prepare a disposable Git clone workspace for sandboxed Git-mutating subagents. The clone has a real .git/ directory inside the sandbox writable root and is self-contained after setup." })),
            approve: Type.Optional(Type.Boolean({ description: "Trust project-local files in the child (default: false; headless runs cannot prompt for trust)." })),
            allow_nested: Type.Optional(Type.Boolean({ description: "Allow the child to spawn its own subagents (default: false). Loads this extension in the child and allowlists its tools." })),
        }),

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const p = params as SpawnParams;
            if (p.prompt.trim() === "") throw new Error("prompt is empty.");

            const cfg = loadConfig();
            const maxConcurrent = cfg.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
            const countRunning = () =>
                listMetas().filter((m) => ownedByThisParent(m) && effectiveStatus(m) === "running").length;
            // Shared with batch-spawn: reserve before any async work so an interleaved
            // batch cannot oversubscribe after this check and before writeMeta.
            const gate = getSharedCapacityGate(countRunning);
            if (!gate.tryReserve(1, maxConcurrent)) {
                throw new Error(`Max concurrent subagents (${maxConcurrent}) reached. Stop or let some finish first.`);
            }

            try {
                const { id, spawned, runtime, warn, sandboxDir } = await spawnSubagentRun(ctx, p);
                gate.commit(1);
                return text(
                    `Subagent launched: ${p.name ? `${p.name} ` : ""}id=${id} (pid ${spawned.pid}).\n` +
                    (p.callback === false
                        ? `Running in the background; the foreground is free. It will finish quietly — read the result with subagent_result id=${id}.\n`
                        : `Running in the background; the foreground is free. Its result will be posted back here when it finishes.\n`) +
                    (sandboxDir ? `Sandboxed: writes confined to ${sandboxDir}\n` : "") +
                    runtime + warn +
                    `Log: ${logPathFor(id)}`,
                );
            } catch (err) {
                gate.release(1);
                throw err;
            }
        },
    });

    // ---- subagent_spawn_batch -------------------------------------------
    pi.registerTool({
        name: "subagent_spawn_batch",
        label: "Spawn Subagent Batch",
        description:
            "Launch several independent background pi subagents at once. Each job becomes a " +
            "normal subagent run with its own run id, process, log, and metadata. " +
            "'shared' options are applied to every job; per-job options override them.",
        promptSnippet: "Launch a batch of background subagents at once",
        promptGuidelines: [
            "Use subagent_spawn_batch when you have several independent tasks to delegate. It returns immediately with a batch id and one run id per launched job.",
            "Each job is a normal subagent run; use subagent_result / subagent_output / subagent_stop with the individual run ids just like subagent_spawn.",
            "Do NOT poll for results. Each job reports back on its own when it finishes.",
            "By default the whole batch is rejected if there is not enough capacity. Set onCapacity to 'launch-available' to launch as many as fit and report the rest as skipped.",
        ],
        parameters: Type.Object({
            batchName: Type.Optional(Type.String({ description: "Optional display label for the batch." })),
            shared: Type.Optional(Type.Object({
                model: Type.Optional(Type.String({ description: "Model as provider/id (default: inherit foreground model)." })),
                tools: Type.Optional(Type.String({ description: "Tool allowlist applied to every job." })),
                exclude_tools: Type.Optional(Type.String({ description: "Comma-separated tool denylist applied to every job." })),
                sandbox: Type.Optional(Type.Boolean({ description: "Default TRUE: kernel-confine writes to the working dir." })),
                sandbox_dir: Type.Optional(Type.String({ description: "Writable root for every job." })),
                callback: Type.Optional(Type.Boolean({ description: "Default TRUE: post result back on completion." })),
                clean: Type.Optional(Type.Boolean({ description: "Hermetic builtins-only child; no extensions load." })),
                cwd: Type.Optional(Type.String({ description: "Working directory (default: current)." })),
                git_clone_workspace: Type.Optional(Type.Boolean({ description: "Prepare a disposable Git clone workspace for each job (same semantics as subagent_spawn)." })),
                approve: Type.Optional(Type.Boolean({ description: "Trust project-local files in children." })),
                allow_nested: Type.Optional(Type.Boolean({ description: "Allow children to spawn their own subagents." })),
            }, { description: "Options applied to every job; per-job values override these." })),
            jobs: Type.Array(Type.Object({
                prompt: Type.String({ description: "The task for this job." }),
                name: Type.Optional(Type.String({ description: "Short label for this job." })),
                model: Type.Optional(Type.String()),
                tools: Type.Optional(Type.String()),
                exclude_tools: Type.Optional(Type.String()),
                sandbox: Type.Optional(Type.Boolean()),
                sandbox_dir: Type.Optional(Type.String()),
                callback: Type.Optional(Type.Boolean()),
                clean: Type.Optional(Type.Boolean()),
                cwd: Type.Optional(Type.String()),
                git_clone_workspace: Type.Optional(Type.Boolean()),
                approve: Type.Optional(Type.Boolean()),
                allow_nested: Type.Optional(Type.Boolean()),
            }, { description: "A single batch job." }), {
                minItems: 1,
                description: "One or more jobs to launch. Each must have a prompt.",
            }),
            onCapacity: Type.Optional(Type.String({ description: 'Capacity behavior: "reject" (default) or "launch-available".' })),
        }),

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const p = params as {
                batchName?: string;
                shared?: Partial<SpawnParams>;
                jobs: Array<Partial<SpawnParams> & { prompt: string }>;
                onCapacity?: "reject" | "launch-available";
            };

            const cfg = loadConfig();
            const maxConcurrent = cfg.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
            const countRunning = () =>
                listMetas().filter((m) => ownedByThisParent(m) && effectiveStatus(m) === "running").length;
            const launchAvailable = p.onCapacity === "launch-available";
            // Shared with single-spawn. Reservations count against maxConcurrent so a
            // concurrent single spawn cannot take a slot the batch already admitted.
            const gate = getSharedCapacityGate(countRunning);

            validateBatchPlan({ shared: p.shared, jobs: p.jobs, onCapacity: p.onCapacity, config: cfg });

            // reject mode: whole-batch reservation is all-or-nothing. Holding the slots
            // until each job commits (or the unused remainder is released) closes the
            // interleaving oversubscribe class — a stale plan alone is not enough.
            if (!launchAvailable) {
                // planBatchLaunches still produces the public error text (incl. pending).
                planBatchLaunches({
                    jobs: p.jobs,
                    runningCount: countRunning(),
                    pendingCount: gate.pending,
                    maxConcurrent,
                    onCapacity: p.onCapacity,
                });
                if (!gate.tryReserve(p.jobs.length, maxConcurrent)) {
                    // Race: capacity changed between plan and reserve.
                    throw new Error(formatCapacityRejectMessage({
                        jobCount: p.jobs.length,
                        runningCount: countRunning(),
                        pendingCount: gate.pending,
                        maxConcurrent,
                    }));
                }
            }

            const names = assignBatchJobNames(p.jobs);
            const batchId = nextBatchId();
            const launched: { name: string; id: string }[] = [];
            const failed: { name: string; reason: string }[] = [];
            const skipped: { name: string }[] = [];
            // How many reject-mode reserved slots are still held (not yet committed/released).
            let reservedRemaining = launchAvailable ? 0 : p.jobs.length;

            // Walk every job in order. launch-available reserves one slot at a time and
            // backfills when a job fails before a normal run is launched (slot released).
            for (let i = 0; i < p.jobs.length; i++) {
                const job = p.jobs[i];
                const name = names[i];
                const merged = mergeJobOptions(p.shared, job);

                if (launchAvailable) {
                    if (!gate.tryReserve(1, maxConcurrent)) {
                        for (let j = i; j < p.jobs.length; j++) {
                            skipped.push({ name: names[j] });
                        }
                        break;
                    }
                }

                try {
                    const { id } = await spawnSubagentRun(ctx, { ...merged, name }, { batchId, batchName: p.batchName });
                    gate.commit(1);
                    if (!launchAvailable) reservedRemaining -= 1;
                    launched.push({ name, id });
                } catch (err) {
                    gate.release(1);
                    if (!launchAvailable) reservedRemaining -= 1;
                    const reason = err instanceof Error ? err.message : String(err);
                    failed.push({ name, reason });
                    if (!launchAvailable) {
                        // reject mode: leave already-launched runs running, release any
                        // still-held later reservations, and report every later job as failed.
                        if (reservedRemaining > 0) {
                            gate.release(reservedRemaining);
                            reservedRemaining = 0;
                        }
                        for (let j = i + 1; j < p.jobs.length; j++) {
                            failed.push({
                                name: names[j],
                                reason: "not launched due to earlier job failure in reject mode",
                            });
                        }
                        return text(formatBatchLaunchResponse({
                            batchId, batchName: p.batchName, launched, skipped, failed,
                        }));
                    }
                    // launch-available: failure did not consume a slot — continue so
                    // later jobs can use remaining capacity (backfill).
                }
            }

            // Safety: any unused reject-mode reservation must not leak.
            if (reservedRemaining > 0) {
                gate.release(reservedRemaining);
                reservedRemaining = 0;
            }

            return text(formatBatchLaunchResponse({ batchId, batchName: p.batchName, launched, skipped, failed }));
        },
    });

    // ---- model-facing read/stop tools -----------------------------------
    // The definitions live in tools.ts; registration uses the exact objects
    // the factories return, so tests invoke the same execute handlers the
    // model reaches (no drift-prone second copy). Stop's only UI side effect
    // (widget redraw after a kill) is injected as onStopped.
    pi.registerTool(subagentListTool(Type));
    pi.registerTool(subagentOutputTool(Type));
    pi.registerTool(subagentResultTool(Type));
    pi.registerTool(subagentStopTool(Type, { onStopped: renderWidget }));

    // ---- live-status lifecycle -----------------------------------------
    // Capture a UI-bearing context and, if runs from a prior session are still
    // alive, resume the ticking widget. Deferred out of the factory per pi's
    // "no background resources at load" rule.
    pi.on("session_start", async (_event, ctx) => {
        uiCtx = ctx;
        activeCallbackOrigin = callbackOriginFromContext(ctx);
        // Reload / session switch hardening (#48):
        // - Drop any leftover overlay timers/confirm state from a prior session
        //   (defensive if the host skipped session_shutdown before re-start).
        // - Reinstall the editor wrapper without stacking (marked factory).
        // - Clear + republish footer statuses (pi clears extension statuses on
        //   session switch/reload; dirty-check only dedupes within a session).
        // - Repaint the widget even if its last in-memory lines match; the host
        //   may have dropped extension UI during reload/session replacement.
        ensureSubagentProvider();
        disposeBackgroundWorkNavigator(ctx);
        widgetNavActive = false;
        widgetNavSelectedId = undefined;
        if (isNavigatorUiAvailable(ctx)) {
            try { ctx.ui.setStatus(CLOSE_CONFIRM_STATUS_KEY, undefined); } catch { /* ignore */ }
        }
        ensureNavigator(ctx);
        updateNavigatorFooter(ctx);
        // Clear the retired legacy widget so the shared navigator is the only
        // list surface for running/orphaned subagents.
        renderWidget();
        // Resume supervision reconciliation + durable health-callback recovery
        // across /reload while current-parent work still needs the ticker
        // (running/orphaned, or unmarked lost); it stops itself when idle.
        if (needsMonitoring(listMetas())) ensureHealthTicker();
    });

    pi.on("session_before_switch", () => {
        activeCallbackOrigin = undefined;
        disposeBackgroundWorkNavigator();
    });

    // Tear down the timer and clear the widget when the session ends.
    pi.on("session_shutdown", async (_event, ctx) => {
        activeCallbackOrigin = undefined;
        stopTicker();
        stopHealthTicker();
        spendCache.clear();
        // Always dispose navigator detail timers (no UI call — just clearInterval).
        // Safe in every mode; the dispose hook is only set when a TUI overlay opened.
        disposeBackgroundWorkNavigator(ctx);
        // Widget clear is intentional in every mode that exposes ui (incl. RPC
        // — pi docs: setWidget works in both TUI and RPC). Navigator cleanup
        // is TUI-only: the footer hint is never published outside TUI, so
        // clearing it in RPC would be a pure UI leak (setStatus subagents-nav).
        try { ctx.ui.setWidget("subagents", WIDGET_CLEAR); } catch { /* ignore */ }
        if (isNavigatorUiAvailable(ctx)) {
            try { ctx.ui.setStatus(NAVIGATOR_STATUS_KEY, undefined); } catch { /* ignore */ }
            try { ctx.ui.setStatus(CLOSE_CONFIRM_STATUS_KEY, undefined); } catch { /* ignore */ }
        }
    });
}
