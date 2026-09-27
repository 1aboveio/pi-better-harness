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
import { writeFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import * as PiTui from "@earendil-works/pi-tui";
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
    renderRegisteredWorkDetail,
    type BackgroundWorkDetail,
    type BackgroundWorkProvider,
    type BackgroundWorkRow,
} from "./shared-navigator.ts";
import { spawnDetached, type SpawnResult } from "./spawn.ts";
import { parseRun, readRunTranscript, resetParseRunCursor, type Usage } from "./parse.ts";
import { finalizeRun as finalizeRunCore } from "./finalization.ts";
import { loadConfig, normalizeTools, resolveExtensionPath, selfDir, SAFE_DEFAULT_TOOLS, SAFE_CLEAN_TOOLS, DEFAULT_MAX_CONCURRENT } from "./config.ts";
import { STEER_FILE_ENV, readSteerReceipt } from "./child-steer.ts";
import {
    decideTiming,
    describeTiming,
    emptyProgress,
    foldProgress,
    formatTimingLimits,
    isProgressRelevantLine,
    resolveRunTiming,
    steerText,
    timingParameterSchemas,
    type ProgressState,
    type TimingParams,
    type TimingStopReason,
} from "./timing.ts";
import { readAppendedLines, type LogCursor } from "./log-cursor.ts";
import { DELEGATION_MODE_REQUEST, delegationPrompt, isDelegationMode, normalizeDelegationMode, type DelegationMode } from "./delegation.ts";
import { resolveExtensions, extensionArgs } from "./extensions.ts";
import { prepareTaskRuntime } from "./task-policy.ts";
import { canonicalizePath, takeRecoverySnapshot } from "./shared-sandbox-core.ts";
import { TASK_BUILTINS } from "./shared-task-sandbox.ts";
import { observeSandboxPermissions, resolveSubagentPermissions } from "./permission-policy.ts";
import { resolveSubagentWorkspace } from "./git-workspace.ts";
import { join } from "node:path";
import {
    baseDir,
    taskWorkspaceDir,
    sessionsDir,
    runDir,
    recordTaskRuntimeProvenance,
    discardFailedLaunch,
    logPathFor,
    promptPathFor,
    nextRunId,
    writeMeta,
    readMeta,
    listMetas,
    listActiveMetasForParent,
    listMetasForOrigin,
    listMetasForParent,
    onMetaChanged,
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
    isAbandonedByParent,
    needsMonitoring,
    observeRunHealth,
    realProcessProbe,
    reconcileRun,
    resetChildEventLogCursor,
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
import { cancelCallbackBatch, getCallbackBatcher } from "./shared-callback-batcher.ts";
import { completionCallbackFields, failureAttentionFields, healthCallbackFields } from "./callback-fields.ts";
import { collectRunFailures, failurePath, failureView, markFailureAttentionDelivered, pendingFailureAttention, prependFailureSummary } from "./failures.ts";
import { failureAttentionHandled, observeFailures } from "./shared-failure-observations.ts";
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
    fmtTokens,
    shortModel,
    isSpendCacheFresh,
    resolveHealthLogExtraction,
    withinRefreshFloor,
} from "./widget.ts";
import {
    executeNavigatorClose,
    buildNavigatorRows,
    buildNavigatorDetail,
} from "./navigator.ts";
import { enforceRegistrySizeCapOnce, runDailyCleanupOnce } from "./cleanup.ts";
import { assertThinkingLevel, parseModelThinking, type ThinkingLevel } from "./thinking.ts";
import { createAgentOperations } from "./agent-operations.ts";
import {
    clarifyCatalogRequest,
    createLaunchEnricher,
    hasCatalogSelector,
    loadLaunchSnapshot,
    noteCatalogHost,
    prepareCatalogJob,
    tiersForLaunch,
    type CatalogHost,
    type CatalogJobFields,
    type CatalogRunRecord,
} from "./catalog-runtime.ts";
import { defaultUserRoot, type CatalogSnapshot } from "./catalog-store.ts";

/** The tools this extension registers — excluded from children by default so a
 *  subagent cannot recursively spawn more subagents unless explicitly allowed. */
const SUBAGENT_TOOLS = [
    "subagent_spawn",
    "subagent_spawn_batch",
    "subagent_list",
    "subagent_output",
    "subagent_stop",
    "subagent_result",
    "agents_catalog",
];

const projectConfigDirName = typeof (PiCodingAgent as { CONFIG_DIR_NAME?: unknown }).CONFIG_DIR_NAME === "string"
    ? (PiCodingAgent as { CONFIG_DIR_NAME: string }).CONFIG_DIR_NAME
    : ".pi";

const CATALOG_GUIDELINES = [
    "When a task, workflow, or skill instruction names a model or effort, translate that authoritative choice into the structured model and thinking arguments before spawning. The runtime does not parse prose, quoted model names, or comparisons, and copying a model into the child prompt does not change the launch.",
    "Optional agent, role, and alias select a catalog definition. Pass one agent id or one role id. Pass an array of role ids when one run was given more than one role: that call asks to choose one or split, and without a UI choice it returns clarification-needed and starts no child. Naming both an agent and a role does the same. One job's choice does not change another job. A named agent displays its defined name. A direct role displays the label allocated from the local run registry. Calls without agent or role keep the existing name and model chain.",
    "Catalog model and effort are resolved before the child starts. An unavailable explicit model or unsupported explicit effort does not launch and does not fall back. The catalog grants no tools, sandbox modes, extensions, or permissions.",
];

const SUBAGENT_ORCHESTRATION_GUIDELINES = [
    "When a structured plan is active, follow the current delegation mode. Track delegated and foreground deliverables only when delegation is permitted and actually underway; continue unblocked foreground work and integrate results before marking work complete.",
    "Do not treat launching a subagent as completion of the parent milestone; relevant terminal results must be inspected and integrated before verification or completion.",
];

const GOAL_READY_EVENT = "pi-better-goal:ready";
const GOAL_REGISTER_PROVIDER_EVENT = "pi-better-goal:register-provider";
const goalReadySubscriptions = new WeakSet<ExtensionAPI>();

function registerSubagentsGoalProvider(pi: ExtensionAPI): void {
    const emitProvider = (): void => {
        pi.events?.emit(GOAL_REGISTER_PROVIDER_EVENT, {
            id: "subagents",
            label: "Subagents",
            getActivity: () => ({
                providerId: "subagents",
                label: "Subagents",
                items: listMetasForParent(process.pid).map((meta) => {
                    const status = effectiveStatus(meta);
                    const active = status === "running" || status === "orphaned";
                    return {
                        id: meta.id,
                        ...(meta.name ? { label: meta.name } : {}),
                        status,
                        active,
                        unhealthy: status === "orphaned",
                        terminal: !active,
                        attention: status === "orphaned" || status === "failed" || status === "killed" || status === "lost" || status === "exited",
                        startedAt: meta.startedAt,
                        ...(meta.endedAt !== undefined ? { endedAt: meta.endedAt } : {}),
                    };
                }),
            }),
            onActivityChanged: onMetaChanged,
        });
    };
    if (!goalReadySubscriptions.has(pi)) {
        pi.events?.on?.(GOAL_READY_EVENT, emitProvider);
        goalReadySubscriptions.add(pi);
    }
    emitProvider();
}

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
    refreshedAt: number;
};
/**
 * Per-run health-log parse cache — size/mtime gated and floored by
 * HOT_PATH_REFRESH_FLOOR_MS, so a child writing continuously cannot make every
 * frame re-read its log.
 */
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

/** Origin with a readable session id, or undefined when identity is unavailable. */
function verifiedOriginFromContext(ctx: ExtensionContext | undefined): RunCallbackOrigin | undefined {
    if (!ctx?.sessionManager || typeof ctx.cwd !== "string") return undefined;
    try {
        const sessionId = ctx.sessionManager.getSessionId();
        return sessionId ? { cwd: ctx.cwd, sessionId } : undefined;
    } catch {
        return undefined;
    }
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
    return belongsToOrigin(meta, active);
}

function belongsToOrigin(meta: RunMeta, active: RunCallbackOrigin): boolean {
    const origin = meta.callbackOrigin;
    if (origin) {
        if (origin.cwd !== active.cwd) return false;
        if (origin.sessionId || active.sessionId) return origin.sessionId === active.sessionId;
        return true;
    }
    if (active.sessionId) return false;
    return meta.cwd === active.cwd;
}

function hasSelfProcessIdentity(meta: RunMeta): boolean {
    return meta.pid === process.pid || meta.pgid === process.pid;
}

function stopCurrentSessionSubagents(ctx: ExtensionContext): void {
    const origin = callbackOriginFromContext(ctx);
    for (const summary of listMetasForParent(process.pid)) {
        if (!ownedByThisParent(summary)) continue;
        if (summary.status !== "running" && summary.status !== "orphaned") continue;
        if (!belongsToOrigin(summary, origin)) continue;
        // Automatic shutdown cleanup must not let corrupt or synthetic metadata
        // signal the foreground Pi process itself.
        if (hasSelfProcessIdentity(summary)) continue;
        try { stopRun(summary.id); } catch { /* best-effort shutdown cleanup */ }
        spendCache.delete(summary.id);
        healthLogCache.delete(summary.id);
        resetChildEventLogCursor(summary.id);
    }
}

function markCompletionCallbackSuppressed(id: string, reason: string, now: number = Date.now()): void {
    const meta = readMeta(id);
    if (!meta || meta.completionCallbackSentAt !== undefined || meta.completionCallbackSuppressedAt !== undefined) return;
    meta.completionCallbackSuppressedAt = now;
    meta.completionCallbackSuppressedReason = reason;
    writeMeta(meta);
}

function markCompletionCallbackSent(id: string, now: number): void {
    const meta = readMeta(id);
    if (!meta || meta.completionCallbackSentAt !== undefined || meta.completionCallbackSuppressedAt !== undefined) return;
    meta.completionCallbackSentAt = now;
    writeMeta(meta);
}

/** Queue one durable ordinary terminal event on the host-shared batch. */
function enqueueCompletionCallback(pi: ExtensionAPI, id: string): void {
    const meta = readMeta(id);
    if (!meta
        || meta.callback === false
        || meta.completionCallbackPendingAt === undefined
        || meta.completionCallbackSentAt !== undefined
        || meta.completionCallbackSuppressedAt !== undefined) return;
    const state = collectRunFailures(id, meta.cwd, true);
    // Lifecycle, current actionability, and retained history are separate facts (#315).
    const due = pendingFailureAttention(state, Date.now(), { terminal: true });
    getCallbackBatcher(pi).enqueue({
        ...completionCallbackFields(meta, state, due?.incidents ?? []),
        callback: true,
        isDelivered: () => {
            const current = readMeta(id);
            return current?.completionCallbackSentAt !== undefined
                || current?.completionCallbackSuppressedAt !== undefined;
        },
        getSuppressionReason: () => {
            const current = readMeta(id);
            if (!current) throw new Error("Subagent metadata is unavailable; defer completion");
            return callbackSuppressionReason(current);
        },
        onDelivered: (at) => {
            const state = collectRunFailures(id, meta.cwd, true);
            const due = pendingFailureAttention(state, at, { terminal: true });
            if (due) {
                markFailureAttentionDelivered(failurePath(id), due, at);
                if (due.incidents.some((incident) => pendingFailureAttention(collectRunFailures(id, meta.cwd, true), at, { terminal: true })?.incidents.includes(incident))) return;
            }
            markCompletionCallbackSent(id, at);
        },
        onSuppressed: (reason, at) => markCompletionCallbackSuppressed(id, reason, at),
    });
}

/** Recover only records explicitly marked pending; legacy terminal runs never replay. */
function recoverCompletionCallbacks(pi: ExtensionAPI): void {
    for (const meta of listMetasForParent(process.pid)) {
        if (!ownedByThisParent(meta)) continue;
        enqueueCompletionCallback(pi, meta.id);
    }
}

function deliverFailureAttention(pi: ExtensionAPI | undefined, meta: RunMeta, now: number): void {
    if (!pi || meta.callback === false || callbackSuppressionReason(meta)) return;
    if ((meta.status === "orphaned" || meta.status === "lost") && !isHealthCallbackHandled(meta, meta.status)) return;
    const state = collectRunFailures(meta.id, meta.cwd, meta.status !== "running" && meta.status !== "orphaned");
    // Evidence gaps (oversized or malformed log records) are not something the parent can act on
    // while the child runs; they ride the completion or health callback instead (#315). Once an
    // orphaned run's health callback is handled there is no later callback that is sure to come
    // (the run may stay orphaned), so gaps found after it are delivered now (#325).
    const pending = pendingFailureAttention(state, now, { deferObservationGaps: meta.status === "running" });
    if (!pending || (meta.status !== "running" && meta.status !== "orphaned" && meta.completionCallbackPendingAt !== undefined)) return;
    // Only the pending incidents are rendered; earlier deliveries are counted, not repeated (#315).
    void getCallbackBatcher(pi).deliverUrgent({
        ...failureAttentionFields(meta, state, pending),
        isDelivered: () => failureAttentionHandled(collectRunFailures(meta.id, meta.cwd), pending.incidents),
        getSuppressionReason: () => {
            const current = readMeta(meta.id);
            if (!current) throw new Error("Subagent metadata is unavailable; defer failure notification");
            return callbackSuppressionReason(current);
        },
        onDelivered: (at) => { markFailureAttentionDelivered(failurePath(meta.id), pending, at); },
    });
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

/**
 * Refresh spend/tool for a run only when the cache is stale or the log grew —
 * and never more often than the hot-path refresh floor, since a live child grows
 * its log on every frame and each refresh re-parses a bounded log tail.
 */
function spendFor(id: string, now: number): { usage: Usage; tool: string | null } {
    const cached = spendCache.get(id);
    if (withinRefreshFloor(cached, now)) {
        return { usage: cached!.usage, tool: cached!.tool };
    }
    const logSize = logSizeOf(id);
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
 * Full log parse is gated by size/mtime so event/detail refresh does not re-read and
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
        const cached = healthLogCache.get(meta.id);
        // Inside the floor nothing is read at all — not even the log's stat.
        const { size: logSize, mtimeMs } = withinRefreshFloor(cached, now)
            ? { size: cached!.logSize, mtimeMs: cached!.mtimeMs }
            : logStatOf(meta.id);
        const resolved = resolveHealthLogExtraction(
            cached,
            { logSize, mtimeMs, now },
            () => extractChildEventFactsFromLog(meta.id, { now }),
        );
        if (!resolved.hit) {
            healthLogCache.set(meta.id, {
                facts: resolved.facts as ChildEventFacts,
                rawLog: resolved.rawLog as RawLogDiagnostic,
                logSize,
                mtimeMs,
                refreshedAt: now,
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
    resetChildEventLogCursor();
    resetParseRunCursor();
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

/** How often supervision is reconciled. Independent of TUI render scheduling. */
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

    const callback = meta.callback !== false;
    const label = meta.name ? `${meta.name} (${meta.id})` : meta.id;
    const failureState = collectRunFailures(meta.id, meta.cwd, status === "lost");
    const attention = pendingFailureAttention(failureState, now, { terminal: status === "lost" });
    const delivery = buildHealthCallbackDelivery({ id: meta.id, label, status, callback });
    if (!delivery) {
        // callback:false — model follow-up suppressed; mark handled so recovery
        // does not spin forever. Human notify remains the caller's job.
        if (status === "orphaned") meta.orphanedCallbackSentAt = now;
        else meta.lostCallbackSentAt = now;
        writeMeta(meta);
        return;
    }
    void getCallbackBatcher(pi).deliverUrgent({
        ...healthCallbackFields(meta, status, failureState, delivery.content, attention?.incidents ?? []),
        isDelivered: () => {
            const current = readMeta(meta.id);
            if (!current) throw new Error("Subagent metadata is unavailable; defer health notification");
            return isHealthCallbackHandled(current, status);
        },
        getSuppressionReason: () => {
            const current = readMeta(meta.id);
            if (!current) throw new Error("Subagent metadata is unavailable; defer health notification");
            return callbackSuppressionReason(current);
        },
        onDelivered: (at) => {
            const current = readMeta(meta.id);
            if (!current || isHealthCallbackHandled(current, status)) return;
            if (attention) {
                markFailureAttentionDelivered(failurePath(meta.id), attention, at);
                if (attention.incidents.some((incident) => pendingFailureAttention(collectRunFailures(meta.id, meta.cwd), at, { terminal: true })?.incidents.includes(incident))) return;
            }
            if (status === "orphaned") current.orphanedCallbackSentAt = at;
            else current.lostCallbackSentAt = at;
            writeMeta(current);
        },
        onSuppressed: (reason, at) => {
            const current = readMeta(meta.id);
            if (!current || isHealthCallbackHandled(current, status)) return;
            markHealthCallbackSuppressed(current, status, reason, at);
        },
    });
}

// ---- harness timing: soft deadline, hard ceiling, stuck wake ----------------
//
// Timeout control is the harness's job, not the launching prompt's: nothing
// else enforces an orchestrator's "30-minute attempt", and a parent that only
// notices late kills a child that was still making progress. Policy lives in
// timing.ts; this host part reads progress from the child's own event log,
// writes the steer request the child's control extension (child-steer.ts)
// delivers, wakes the parent once per event, and stops the run when due.

/** Incremental progress read per run (rebuilt from the log after /reload). */
const progressCache = new Map<string, { cursor?: LogCursor; state: ProgressState }>();

function steerPathFor(id: string): string {
    return join(runDir(id), "steer.json");
}

function childSteerExtensionPath(): string {
    return join(selfDir(), "child-steer.ts");
}

function readProgress(meta: RunMeta): ProgressState {
    let entry = progressCache.get(meta.id);
    const read = readAppendedLines(logPathFor(meta.id), entry?.cursor);
    if (!entry || read.restarted) entry = { state: emptyProgress(meta.startedAt) };
    if (read.error === undefined) entry.cursor = read.cursor;
    for (const line of read.lines) {
        if (!isProgressRelevantLine(line)) continue;
        let event: unknown;
        try { event = JSON.parse(line); } catch { continue; }
        if (event && typeof event === "object") foldProgress(entry.state, event as Record<string, unknown>);
    }
    progressCache.set(meta.id, entry);
    return entry.state;
}

/** Merge into the durable timing record under a fresh read. */
function patchTiming(id: string, patch: Partial<NonNullable<RunMeta["timing"]>>): RunMeta | undefined {
    const current = readMeta(id);
    if (!current?.timing) return undefined;
    current.timing = { ...current.timing, ...patch };
    for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
        if (patch[key] === undefined) delete current.timing[key];
    }
    writeMeta(current);
    return current;
}

function requestSteer(meta: RunMeta, now: number): void {
    const path = steerPathFor(meta.id);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ id: `deadline:${meta.id}`, text: steerText(meta.timing!, meta.startedAt), at: now }));
    renameSync(tmp, path);
}

function timingLabel(meta: RunMeta): string {
    return meta.name ? `${meta.name} (${meta.id})` : meta.id;
}

function fmtWindow(ms: number): string {
    const minutes = Math.round(ms / 60_000);
    return minutes >= 1 ? `${minutes}m` : `${Math.max(1, Math.round(ms / 1000))}s`;
}

/**
 * One parent wake for a timing event. The marker records a handoff (or an
 * intentional suppression), so reloads and later ticks never repeat it.
 */
function deliverTimingWake(pi: ExtensionAPI | undefined, meta: RunMeta, kind: "deadline" | "stuck", key: string,
    content: string, isHandled: (current: RunMeta) => boolean, markHandled: (at: number) => void): void {
    if (!callbackSuppressionReason(meta)) {
        try { uiCtx?.ui.notify(content, "warning"); } catch { /* ignore */ }
    }
    if (!pi || meta.callback === false) { markHandled(Date.now()); return; }
    void getCallbackBatcher(pi).deliverUrgent({
        source: "subagent",
        id: meta.id,
        label: timingLabel(meta),
        status: key,
        customType: `subagent-${kind}`,
        content,
        detailTool: "subagent_result",
        isDelivered: () => {
            const current = readMeta(meta.id);
            if (!current) throw new Error("Subagent metadata is unavailable; defer timing notification");
            return isHandled(current);
        },
        getSuppressionReason: () => {
            const current = readMeta(meta.id);
            if (!current) throw new Error("Subagent metadata is unavailable; defer timing notification");
            return callbackSuppressionReason(current);
        },
        onDelivered: (at) => markHandled(at),
        onSuppressed: (_reason, at) => markHandled(at),
    });
}

/** Stop a run for a timing reason and report it through the ordinary completion callback. */
function stopForTiming(pi: ExtensionAPI | undefined, id: string, reason: TimingStopReason, now: number): boolean {
    if (!patchTiming(id, { stopReason: reason, stoppedAt: now })) return false;
    const outcome = stopRun(id, { now: () => now });
    if (outcome.action !== "stopped") {
        // The child finished on its own first (or an orphaned run's group was already gone and
        // it was finalized from its log): its own exit is the outcome, not a harness stop.
        patchTiming(id, { stopReason: undefined, stoppedAt: undefined });
        progressCache.delete(id);
        return outcome.action === "finalized";
    }
    const current = readMeta(id);
    if (current && current.callback !== false && current.completionCallbackPendingAt === undefined
        && current.completionCallbackSentAt === undefined && current.completionCallbackSuppressedAt === undefined) {
        current.completionCallbackPendingAt = now;
        writeMeta(current);
    }
    progressCache.delete(id);
    if (current && !callbackSuppressionReason(current)) {
        const note = describeTiming({ ...current, status: current.status });
        try { uiCtx?.ui.notify(`Subagent ${timingLabel(current)} ${note?.short ?? `stopped: ${reason}`}.`, "warning"); } catch { /* ignore */ }
    }
    if (pi) enqueueCompletionCallback(pi, id);
    renderWidget();
    return true;
}

/**
 * Apply the run's timing policy at `now`. Returns true when the run was stopped.
 * Only supervised `running` runs owned by this parent are timed.
 */
function enforceTiming(pi: ExtensionAPI | undefined, meta: RunMeta, now: number): boolean {
    const timing = meta.timing;
    if (!timing || timing.stopReason) return false;
    // The ceiling also bounds an orphaned run (child gone, its process group still alive).
    if (meta.status === "orphaned") {
        return timing.ceilingAt !== undefined && now >= timing.ceilingAt ? stopForTiming(pi, meta.id, "ceiling", now) : false;
    }
    if (meta.status !== "running") return false;
    const needsProgress = timing.stuckMs !== undefined || (timing.deadlineAt !== undefined && now >= timing.deadlineAt);
    const progress = needsProgress ? readProgress(meta) : undefined;
    const patch: Partial<NonNullable<RunMeta["timing"]>> = {};
    if (progress?.lastProgressAt !== undefined && progress.lastProgressAt > (timing.lastProgressAt ?? 0)) patch.lastProgressAt = progress.lastProgressAt;
    if (timing.steerRequestedAt !== undefined && timing.steerDeliveredAt === undefined) {
        // The child's receipt for this run's steer; clamped so a skewed clock cannot move grace earlier than the request.
        const receipt = readSteerReceipt(steerPathFor(meta.id));
        if (receipt?.id === `deadline:${meta.id}`) patch.steerDeliveredAt = Math.min(now, Math.max(receipt.at, timing.steerRequestedAt));
    }
    if (Object.keys(patch).length) meta = patchTiming(meta.id, patch) ?? meta;
    const actions = decideTiming(meta.timing, progress, now);
    if (actions.stop) return stopForTiming(pi, meta.id, actions.stop, now);
    if (actions.steer) {
        try {
            requestSteer(meta, now);
            meta = patchTiming(meta.id, { steerRequestedAt: now }) ?? meta;
        } catch { /* retried on the next tick */ }
    }
    if (actions.deadlineWake && meta.timing?.steerRequestedAt !== undefined) {
        const t = meta.timing;
        const limit = t.deadlineAt !== undefined ? fmtWindow(t.deadlineAt - meta.startedAt) : "soft";
        deliverTimingWake(pi, meta, "deadline", "deadline",
            `Subagent ${timingLabel(meta)} reached its ${limit} soft deadline. The harness told it to stop starting new work, ` +
            `commit what is done, and report. The message reaches it after its current tool call; if it has not finished ${fmtWindow(t.graceMs)} after that, ` +
            `the harness stops it (reason: deadline). ` +
            `Its completion or stop is reported here; no action is needed now.`,
            (current) => current.timing?.deadlineWakeSentAt !== undefined,
            (at) => { patchTiming(meta.id, { deadlineWakeSentAt: at }); });
    }
    if (actions.stuckWake) {
        const { anchorAt, ageMs } = actions.stuckWake;
        deliverTimingWake(pi, meta, "stuck", `stuck:${anchorAt}`,
            `Subagent ${timingLabel(meta)} looks stuck: no progress for ${fmtWindow(ageMs)}. Its successful tool calls, if any, only repeated earlier calls ` +
            `(same tool, same arguments), for example re-reading the same file or re-running the same command; time inside running tool calls is not counted. ` +
            `It is still running and will not be stopped for this; this is reported once. Inspect it with subagent_output before deciding to stop it.`,
            (current) => current.timing?.stuckWakeSentAt !== undefined && (current.timing.stuckAnchorAt ?? 0) >= anchorAt,
            (at) => { patchTiming(meta.id, { stuckWakeSentAt: at, stuckAnchorAt: anchorAt }); });
    }
    return false;
}

/** One reconciliation + durable health-callback recovery pass. */
function reconcileHealth(): void {
    const ctx = uiCtx;
    const pi = healthPi;
    for (const summary of listMetasForParent(process.pid)) {
        if (!ownedByThisParent(summary)) continue;
        // running/orphaned: process reconcile. lost: durable callback recovery only.
        if (summary.status !== "running" && summary.status !== "orphaned" && summary.status !== "lost") continue;
        // Re-read under the id: finalizeRun / subagent_stop may have written a
        // terminal status since the owned index was read.
        const meta = readMeta(summary.id);
        if (!meta) continue;
        if (meta.status !== "running" && meta.status !== "orphaned" && meta.status !== "lost") continue;
        const now = Date.now();
        if (meta.status === "orphaned" || meta.status === "lost") {
            observeFailures(failurePath(meta.id), [{ id: `supervision:${meta.status}`, operation: `supervision:${meta.status}`, kind: "incomplete",
                summary: meta.status === "lost" ? "Child supervision was lost; outcome is unknown" : "Child supervision interrupted; related work may still be alive" }], now);
        }
        deliverFailureAttention(pi, meta, now);
        try {
            if (enforceTiming(pi, meta, now)) continue;
        } catch { /* timing is best-effort per tick; supervision below still runs */ }

        if (meta.status === "running" || meta.status === "orphaned") {
            const result = reconcileRun(meta, realProcessProbe, now);
            if (result.changed) {
                Object.assign(meta, result.patch, { status: result.status });
                writeMeta(meta);
                if (result.status === "lost") {
                    observeFailures(failurePath(meta.id), [
                        { id: "supervision:orphaned-resolved", operation: "supervision:orphaned", kind: "recovered", incidents: ["supervision:orphaned"] },
                        { id: "supervision:lost", operation: "supervision:lost", kind: "incomplete", summary: "Child supervision was lost; outcome is unknown" },
                    ], now);
                } else if (result.status === "orphaned") {
                    observeFailures(failurePath(meta.id), [{ id: "supervision:orphaned", operation: "supervision:orphaned", kind: "incomplete", summary: "Child supervision interrupted; related work may still be alive" }], now);
                }
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
    // Completed runs can still have failed completion handoffs to retry.
    for (const summary of listMetasForParent(process.pid)) {
        if (!pi || !ownedByThisParent(summary) || summary.status === "running" || summary.status === "orphaned" || summary.status === "lost") continue;
        const meta = readMeta(summary.id);
        if (meta && meta.completionCallbackPendingAt !== undefined && meta.completionCallbackSentAt === undefined && meta.completionCallbackSuppressedAt === undefined) enqueueCompletionCallback(pi!, meta.id);
    }
    pruneProgressCache();
    if (!needsMonitoring(listMetasForParent(process.pid)) && !hasPendingFailureCallbacks()) stopHealthTicker();
}

/** Release progress state for runs that are no longer live (lost, stopped, or finished by any path). */
function pruneProgressCache(): void {
    for (const id of [...progressCache.keys()]) {
        const meta = readMeta(id);
        if (!meta || (meta.status !== "running" && meta.status !== "orphaned")) progressCache.delete(id);
    }
}

/** Test seam: run ids whose progress state is held in memory. */
export function progressCacheIdsForTests(): string[] {
    return [...progressCache.keys()];
}

/**
 * This pi's own start-identity token, recorded on every run it spawns so a later
 * process can tell "my parent is gone" from "my parent's pid was recycled".
 */
function parentStartToken(): string | undefined {
    try {
        return realProcessProbe.startToken(process.pid);
    } catch {
        return undefined;
    }
}

/**
 * Reconcile records whose spawning pi is provably gone.
 *
 * Reconciliation above is owner-gated — a pi must not adjudicate another pi's
 * children — and retention only ever retires TERMINAL records. Those two correct
 * rules trap a `running`/`orphaned` record whose parent died without a clean
 * shutdown: no live process is its owner, so nothing moves it to `lost`, so it
 * never becomes eligible for retention and lives forever. One such record was
 * observed pinning 1.1 GB indefinitely.
 *
 * Adoption is status-only and uses exactly the same evidence rules: reconcileRun
 * owns the verdict. Deliberately NOT done: no notify (this session did not launch
 * the run, so reporting it would be noise about someone else's work), no callback
 * delivery (the coordinator it was meant for no longer exists), and no effect on
 * ticker lifetime — an adopted record never keeps this session's loop alive. It is
 * swept when the loop happens to run, and once at session start.
 *
 * Best-effort; never throws into a caller.
 */
function reconcileAbandonedRuns(now: number = Date.now()): number {
    let adopted = 0;
    try {
        for (const summary of listMetas()) {
            if (ownedByThisParent(summary)) continue;
            if (summary.status !== "running" && summary.status !== "orphaned") continue;
            if (!isAbandonedByParent(summary, realProcessProbe)) continue;
            // Re-read under the id: another pi may have adopted it since the snapshot.
            const meta = readMeta(summary.id);
            if (!meta) continue;
            if (meta.status !== "running" && meta.status !== "orphaned") continue;
            const result = reconcileRun(meta, realProcessProbe, now);
            if (!result.changed) continue;
            Object.assign(meta, result.patch, { status: result.status });
            meta.adoptedFromLostParentAt = meta.adoptedFromLostParentAt ?? now;
            writeMeta(meta);
            adopted += 1;
        }
    } catch { /* best-effort */ }
    return adopted;
}

function hasPendingFailureCallbacks(): boolean {
    return listMetasForParent(process.pid).some((m) => ownedByThisParent(m) && m.callback !== false &&
        m.completionCallbackPendingAt !== undefined && m.completionCallbackSentAt === undefined && m.completionCallbackSuppressedAt === undefined &&
        !callbackSuppressionReason(m));
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
let acceptanceProviderRef: BackgroundWorkProvider | undefined;
let acceptanceSpawnToolRef: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
let acceptanceStopToolRef: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
const TERMINAL_NAVIGATOR_RETENTION_MS = 30_000;
let mainAgentStartedAt: number | undefined;
const mainAgentTools = new Map<string, string>();

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
function navigatorRows(visible?: RunMeta[], at?: number) {
    const now = at ?? Date.now();
    return buildNavigatorRows(visible ?? sessionVisibleNavigatorRuns(now), {
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
        effortFor: (m: RunMeta) => m.effort,
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

/**
 * The visible run set. The durable origin index limits reads to this session;
 * each rebuild still reads owned non-terminal metadata so external status
 * changes are visible immediately without a time-based memo.
 */
function sessionVisibleNavigatorRuns(now: number = Date.now()): RunMeta[] {
    const origin = activeCallbackOrigin;
    if (!origin) return [];
    return navigatorVisibleRuns(listMetasForOrigin(origin))
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
function navigatorDetail(id: string, now: number = Date.now()) {
    return buildNavigatorDetail(id, {
        readMeta,
        effectiveStatus,
        parseRun,
        shortModel,
        fmtElapsed,
        fmtSpend,
        now,
        effortFor: (m: RunMeta) => m.effort,
        healthFor: (m: RunMeta) => observeNavigatorHealth(m, now),
    });
}

/** Shared #44 stop+dismiss path used by navigator Close (#47). */
function navigatorCloseRun(id: string) {
    const outcome = executeNavigatorClose(id, {
        readMeta,
        effectiveStatus,
        stopRun,
        dismissRun,
    });
    // A closed row is off the hot path: release its caches and retained events.
    spendCache.delete(id);
    healthLogCache.delete(id);
    resetChildEventLogCursor(id);
    resetParseRunCursor(id);
    return outcome;
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
    // One registry scan per rebuild: both the start times and the rows below are
    // built from this snapshot.
    const visible = sessionVisibleNavigatorRuns(now);
    const metaById = new Map(visible.map((m) => [m.id, m]));
    return navigatorRows(visible, now).map((row) => {
        const bits = [];
        if (row.model) bits.push(row.effort ? `${row.model} ${row.effort}` : row.model);
        if (row.tool) bits.push(row.tool);
        if (row.spend) bits.push(row.spend);
        const failure = failureView(row.id, metaById.get(row.id)?.cwd ?? "", row.status !== "running" && row.status !== "orphaned");
        // Only a failure that needs action replaces the row's columns; history stays in the detail view.
        const firstFailure = failure.actionable ? failure.text.split("\n")[0] || "" : "";
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
            primary: firstFailure || bits.join(" · ") || "subagent run",
            secondary: firstFailure ? bits.join(" · ") : undefined,
            facts: [firstFailure, ...row.healthFacts].filter(Boolean).slice(0, 2),
            sortStartedAt: metaById.get(row.id)?.startedAt ?? now,
            expiresAt: (() => {
                const meta = metaById.get(row.id);
                const endedAt = meta?.endedAt ?? meta?.lostAt;
                return meta && isTerminalNavigatorStatus(effectiveStatus(meta)) && typeof endedAt === "number"
                    ? endedAt + TERMINAL_NAVIGATOR_RETENTION_MS
                    : undefined;
            })(),
        };
    });
}

function mainAgentWorkRow(now: number): BackgroundWorkRow {
    let running = mainAgentStartedAt !== undefined;
    try { running ||= uiCtx?.isIdle() === false; } catch { /* use event state */ }
    const model = shortModel(uiCtx?.model?.id);
    const effort = uiCtx?.thinkingLevel;
    const tool = [...mainAgentTools.values()].at(-1);
    let contextTokens: number | null | undefined;
    try { contextTokens = uiCtx?.getContextUsage()?.tokens; } catch { contextTokens = undefined; }
    const tokens = typeof contextTokens === "number" ? `${fmtTokens(contextTokens)} tok` : undefined;
    const bits = [
        effort ? `${model} ${effort}` : model,
        tool ? `tool ${tool}` : undefined,
        tokens,
    ].filter((bit): bit is string => Boolean(bit));
    return {
        providerId: "subagents",
        id: "main",
        name: "main",
        model,
        effort,
        tool,
        tokens,
        status: running ? "running" : "idle",
        statusTone: running ? "running" : "muted",
        kind: "main agent",
        elapsed: running && mainAgentStartedAt !== undefined ? fmtElapsed(now - mainAgentStartedAt) : "idle",
        primary: bits.join(" · "),
        sortStartedAt: mainAgentStartedAt ?? now,
    };
}

function subagentWorkDetail(id: string, now: number, options?: { logTailLines?: number }): BackgroundWorkDetail | null {
    const detail = navigatorDetail(id, now);
    if (!detail) return null;
    void options;
    const transcript = readRunTranscript(id);
    const view = failureView(id, readMeta(id)?.cwd ?? "", detail.status !== "running" && detail.status !== "orphaned");
    const failure = view.text;
    const metadata = [
        ...(failure ? [{ label: "failure", value: failure.split("\n")[0]! }] : []),
        { label: "provider", value: "Subagents" },
        { label: "id", value: detail.id },
        ...(detail.role ? [{ label: "role", value: String(detail.role) }] : []),
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
        subtitle: (view.actionable && failure.split("\n")[0]) || (detail.currentTool ? `current tool ${detail.currentTool}` : undefined),
        metadata,
        evidence: { label: "transcript", text: prependFailureSummary(detail.output || "(no transcript yet)", failure) },
        transcript: transcript.entries,
        transcriptDiagnostic: failure ? prependFailureSummary(transcript.diagnostic ?? "", failure) : transcript.diagnostic,
        footerActions: [detail.status === "running" || detail.status === "orphaned" ? "x stop" : "x dismiss"],
    };
}

function createSubagentTranscriptComponent(detail: BackgroundWorkDetail, theme: unknown) {
    const ContainerComponent = (PiTui as any).Container;
    const AssistantComponent = (PiCodingAgent as any).AssistantMessageComponent;
    const ToolComponent = (PiCodingAgent as any).ToolExecutionComponent;
    const markdownTheme = typeof (PiCodingAgent as any).getMarkdownTheme === "function"
        ? (PiCodingAgent as any).getMarkdownTheme()
        : {};
    if (!ContainerComponent || !AssistantComponent || !ToolComponent) {
        return {
            render: () => (detail.transcript ?? []).flatMap((entry) => entry.type === "assistant"
                ? entry.content.filter((block) => block.type === "text").flatMap((block) => String(block.text ?? "").split("\n"))
                : [`[${entry.state}] ${entry.name}`]),
            invalidate() {},
        };
    }
    const container = new ContainerComponent();
    const ui = { requestRender: () => { try { (uiCtx?.ui as any)?.requestRender?.(); } catch { /* ignore */ } } };
    for (const entry of detail.transcript ?? []) {
        if (entry.type === "assistant") {
            const message = {
                role: "assistant" as const,
                content: entry.content,
                stopReason: entry.streaming ? undefined : "stop",
                timestamp: Date.now(),
            };
            const component = new AssistantComponent(message as any, true, markdownTheme, "Thinking...", 1);
            component.updateContent(message as any, entry.streaming);
            container.addChild(component);
            continue;
        }
        const component = new ToolComponent(
            entry.name,
            entry.id ?? `transcript-${entry.name}`,
            entry.args ?? {},
            { showImages: false },
            undefined,
            ui as any,
            uiCtx?.cwd ?? process.cwd(),
        );
        component.markExecutionStarted();
        component.setArgsComplete();
        if (entry.state === "completed") {
            const result = entry.result && typeof entry.result === "object"
                ? entry.result as any
                : { content: entry.result == null ? [] : [{ type: "text", text: String(entry.result) }] };
            component.updateResult({ ...result, isError: entry.isError });
        }
        container.addChild(component);
    }
    return container;
}

function ensureSubagentProvider(): void {
    if (unregisterSubagentProvider) return;
    const provider: BackgroundWorkProvider = {
        id: "subagents",
        label: "Subagents",
        priority: 10,
        visibleCount: () => navigatorRunningCount(),
        showSection: (rows) => rows.some((row) => row.status === "running"),
        parentRow: (now) => mainAgentWorkRow(now),
        listRows: (now) => subagentWorkRows(now),
        detail: (id, now, options) => subagentWorkDetail(id, now, options),
        armCloseLabel: (row) => row.status === "running" || row.status === "orphaned" ? "x again to stop" : "x again to dismiss",
        close: (id) => {
            const outcome = navigatorCloseRun(id) as { action: string; id: string; status?: string };
            return { ...outcome, providerId: "subagents" };
        },
        onVisibleChanged: onMetaChanged,
    };
    acceptanceProviderRef = provider;
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
            createTranscriptComponent: createSubagentTranscriptComponent,
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
    progressCache.delete(id);
    // Host-facing wrapper around first-party finalizer (finalization.ts).
    // Coherent child-exit evidence may supersede provisional orphaned/lost
    // reconciliation; finalization.ts enforces canExitFinalize + lifecycle authority.
    const result = finalizeRunCore(id, code, {
        renderWidget,
        notify: (message, level) => {
            try { ctx.ui.notify(message, level); } catch { /* ignore */ }
        },
        sendMessage: () => enqueueCompletionCallback(pi, id),
    });
    if (result.applied && hasPendingFailureCallbacks()) ensureHealthTicker();
}

function timingSchemaFields() {
    return timingParameterSchemas(Type);
}

/** String for one role, or an array when the caller assigns more than one. Arrays reach clarification instead of being rejected. */
function catalogRoleSchema(purpose: string) {
    const one = `One role id (role.<slug>) for this ${purpose}. Mutually exclusive with agent.`;
    const many = `Two or more role ids for this ${purpose}. An array is ambiguous and asks to choose one role or split into separate runs. No child launches until that choice is made.`;
    return Type.Optional(Type.Union([
        Type.String({ description: one }),
        Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: many }),
    ], { description: `${one} ${many}` }));
}

export default function (pi: ExtensionAPI) {
    let delegationOverride: DelegationMode | undefined;
    const activeDelegationMode = (): DelegationMode => delegationOverride ?? normalizeDelegationMode(loadConfig().delegationMode);
    const restoreDelegationMode = (ctx: ExtensionContext): void => {
        delegationOverride = undefined;
        const branch = ctx.sessionManager?.getBranch?.();
        if (!Array.isArray(branch)) return;
        for (const entry of branch) {
            if (entry.type !== "custom" || entry.customType !== "pi-better-subagents-delegation") continue;
            const data = entry.data as { version?: unknown; mode?: unknown } | null;
            if (data?.version === 1 && isDelegationMode(data.mode)) delegationOverride = data.mode;
        }
    };
    const unsubscribeDelegationRequest = pi.events?.on?.(DELEGATION_MODE_REQUEST, (data: unknown) => {
        if (data && typeof data === "object") (data as { mode?: DelegationMode }).mode = activeDelegationMode();
    });
    // Capture for the health ticker (module-level); needed for orphaned/lost
    // coordinator follow-ups that fire outside a tool-call stack (#65).
    healthPi = pi;
    ensureSubagentProvider();
    registerSubagentsGoalProvider(pi);
    observeSandboxPermissions(pi);
    let acceptanceResultToolRef: { execute: (toolCallId: string, params: { id: string }) => Promise<unknown> } | undefined;
    function publishAcceptanceHooks(tool?: NonNullable<typeof acceptanceResultToolRef>): void {
        if (process.env.PI_CATALOG_ACCEPTANCE_PROBE !== "1") return;
        if (tool) acceptanceResultToolRef = tool;
        (globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("pi-better-subagents.acceptance-hooks")] = {
            subagentResult: acceptanceResultToolRef,
            subagentSpawn: acceptanceSpawnToolRef,
            subagentStop: acceptanceStopToolRef,
            listRows: () => acceptanceProviderRef?.listRows(Date.now()) ?? [],
            renderDetail: (id: string, width = 100) => renderRegisteredWorkDetail("subagents", id, width),
        };
    }

    function catalogHostFrom(ctx: ExtensionContext): CatalogHost {
        const cfg = loadConfig();
        return {
            cwd: ctx.cwd,
            projectTrusted: typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false,
            userRoot: defaultUserRoot(),
            projectConfigDirName,
            registry: ctx.modelRegistry,
            foregroundModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
            configuredDefaultModel: cfg.defaultModel,
            tiers: tiersForLaunch(cfg),
            hasUI: ctx.hasUI === true,
            select: typeof ctx.ui?.select === "function"
                ? (title, options) => ctx.ui.select(title, options)
                : undefined,
        };
    }

    function catalogResult(clarification: { message: string; choices: readonly string[] }) {
        return {
            content: [{ type: "text" as const, text: clarification.message }],
            details: {
                status: "clarification-needed" as const,
                launched: false,
                wrote: false,
                choices: [...clarification.choices],
            },
        };
    }

    async function admitCatalog(ctx: ExtensionContext, jobs: CatalogJobFields[]): Promise<
        | { status: "clarification-needed"; message: string; choices: readonly string[] }
        | { status: "ready"; jobs: SpawnParams[]; snapshot?: CatalogSnapshot }
    > {
        const host = catalogHostFrom(ctx);
        noteCatalogHost(host);
        if (!jobs.some((job) => hasCatalogSelector(job))) {
            return { status: "ready", jobs: jobs as SpawnParams[] };
        }
        const snapshot = loadLaunchSnapshot(host);
        const clarified = await clarifyCatalogRequest(jobs, { hasUI: host.hasUI === true, select: host.select });
        if (clarified.status === "clarification-needed") return clarified;
        const prepared: SpawnParams[] = [];
        for (const job of clarified.jobs) {
            if (!hasCatalogSelector(job)) {
                prepared.push(job as SpawnParams);
                continue;
            }
            const result = await prepareCatalogJob(snapshot, job, host);
            if (result.status === "blocked") throw new Error(result.message);
            if (result.status !== "ready") {
                prepared.push(job as SpawnParams);
                continue;
            }
            prepared.push({ ...(job as SpawnParams), ...result.assign });
        }
        return { status: "ready", jobs: prepared, snapshot };
    }

    type SpawnParams = {
        prompt: string; name?: string; model?: string; thinking?: ThinkingLevel; tools?: string;
        exclude_tools?: string; clean?: boolean; sandbox?: boolean;
        sandbox_dir?: string; callback?: boolean; cwd?: string;
        git_clone_workspace?: boolean; approve?: boolean; allow_nested?: boolean;
        agent?: string; role?: string | readonly string[]; alias?: string;
        catalog?: CatalogRunRecord; catalogResolved?: boolean;
    } & TimingParams;

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
        assertThinkingLevel(p.thinking);
        const permissionPlan = resolveSubagentPermissions(pi, p.sandbox);
        const cfg = loadConfig();
        // Harness-owned timing (soft deadline, ceiling, stuck window); validated before any side effect.
        resolveRunTiming({ params: p, settings: cfg, env: process.env, startedAt: 0 });
        let model: string | undefined;
        let thinking: ThinkingLevel | undefined;
        if (p.catalogResolved === true) {
            model = p.model;
            thinking = p.thinking;
        } else {
            const requestedModel = p.model ?? cfg.defaultModel ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
            const parsed = parseModelThinking(requestedModel, p.thinking);
            model = parsed.model;
            thinking = parsed.thinking;
        }
        // Best-effort daily hygiene for durable tmp state. The marker makes
        // this effectively free after the first subagent launch each day.
        runDailyCleanupOnce({ config: cfg });
        // Age retires history; this bounds the peak one busy day can reach.
        // Rate-limited inside cleanup.ts, and never on the UI hot path.
        const capped = enforceRegistrySizeCapOnce({ config: cfg });
        for (const id of capped.removed) {
            spendCache.delete(id);
            healthLogCache.delete(id);
            resetChildEventLogCursor(id);
            resetParseRunCursor(id);
        }
        const callbackOrigin = callbackOriginFromContext(ctx);
        activeCallbackOrigin = callbackOrigin;

        // Sandbox is ON by default. sandbox_dir moves the confinement + working
        // dir elsewhere. git_clone_workspace prepares a disposable clone with
        // .git/ inside the writable root for Git-mutating sandboxed subagents.
        const sandboxEnabled = permissionPlan.sandboxEnabled;

        const id = nextRunId();
        const childSessionDir = sandboxEnabled ? join(sessionsDir(), id) : sessionsDir();
        // The disposable clone this launch owns (removed if the spawn fails); a caller's sandbox_dir is not ours.
        const ownedCloneWorkspace = !p.sandbox_dir && sandboxEnabled && p.git_clone_workspace ? taskWorkspaceDir(id) : undefined;
        mkdirSync(childSessionDir, { recursive: true });
        mkdirSync(runDir(id), { recursive: true });

        const workspace = resolveSubagentWorkspace({
            ctxCwd: ctx.cwd,
            cwd: p.cwd,
            sandboxDir: p.sandbox_dir ?? ownedCloneWorkspace,
            gitCloneWorkspace: p.git_clone_workspace,
            runId: id,
            runDirPath: runDir(id),
            sandboxEnabled,
        });
        const cwd = workspace.cwd;
        const requestedSandboxDir = workspace.requestedSandboxDir;

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
            tools: sandboxEnabled ? allow.split(",").filter((name) => (TASK_BUILTINS as readonly string[]).includes(name)).join(",") : allow,
            model, clean, allowNested: sandboxEnabled ? false : p.allow_nested, config: cfg,
        });
        const { args: resolvedExtArgs, missing } = extensionArgs(resolution, resolveExtensionPath);
        // The harness's own child control extension (no tools, no command I/O) rides along in every
        // mode, including clean: it is how a soft-deadline steer reaches the child session.
        const extArgs = [...resolvedExtArgs, "--extension", childSteerExtensionPath()]
            .map((value, index, all) => sandboxEnabled && all[index - 1] === "--extension" ? canonicalizePath(value) : value);
        if (sandboxEnabled && resolution.mode === "inherit") {
            throw new Error("Task confinement requires explicit extensions; inheritExtensions is unsupported while sandboxing is enabled.");
        }
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
            "--session-dir", childSessionDir,
            "--session-id", id,
            ...extArgs,
            ...(model ? ["--model", model] : []),
            ...(thinking ? ["--thinking", thinking] : []),
            ...(allow && !sandboxEnabled ? ["--tools", allow] : []),
            ...(excludes.size ? ["--exclude-tools", [...excludes].join(",")] : []),
            ...(sandboxEnabled ? ["--no-builtin-tools", "--no-approve"] : p.approve ? ["--approve"] : []),
            p.prompt,
        ];

        const piBin = resolvePiBinary();
        const selectedTools = allow.split(",").filter((name) => name && !excludes.has(name));
        const unavailableTools = sandboxEnabled ? selectedTools.filter((name) => !(TASK_BUILTINS as readonly string[]).includes(name)) : [];
        if (sandboxEnabled && selectedTools.length && unavailableTools.length === selectedTools.length) {
            throw new Error(`No requested tool has a verified task sandbox adapter: ${unavailableTools.join(", ")}.`);
        }
        const taskRuntime = sandboxEnabled && requestedSandboxDir ? prepareTaskRuntime({
            root: requestedSandboxDir, controlDir: join(runDir(id), "control"), piBin,
            tools: selectedTools, permissions: permissionPlan.permissions,
            extensionPaths: extArgs.flatMap((arg, index) => arg === "--extension" && extArgs[index + 1] ? [extArgs[index + 1]!] : []),
            runtimeRoots: [baseDir()],
        }) : undefined;
        if (sandboxEnabled && !taskRuntime) throw new Error("Task sandbox has no workspace; refusing an unconfined child.");
        // Parent-authored trust record, written before the child can run (#325).
        if (taskRuntime) recordTaskRuntimeProvenance(id);
        // Outside project = Write or Write & delete lets the run change files
        // outside its workspace: start an APFS local snapshot (macOS, in the
        // background; a failure is reported, never blocks the run).
        const snapshot = taskRuntime ? takeRecoverySnapshot(taskRuntime.policy.permissions) : undefined;
        if (snapshot?.started) {
            void snapshot.done.then((outcome) => {
                if (!outcome.ok) ctx.ui?.notify?.(`Subagent ${id}: recovery snapshot failed (run continues): ${outcome.detail}`, "warning");
            });
        }
        const cmd = taskRuntime ? { file: taskRuntime.file, fileArgs: [...taskRuntime.fileArgs, ...args] } : { file: piBin, fileArgs: args };
        const sandboxDir = taskRuntime ? requestedSandboxDir : undefined;

        let spawned: ReturnType<typeof spawnDetached>;
        try {
            spawned = spawnDetached({ file: cmd.file, fileArgs: cmd.fileArgs, cwd, logPath: logPathFor(id),
                env: { [STEER_FILE_ENV]: steerPathFor(id) } });
        } catch (error) {
            // Nothing references the run yet (no metadata): drop its directory (prompt, control/), its
            // provenance record, its session directory, its clone workspace, and the task scratch, so a
            // failed launch leaves nothing behind (#325, #332).
            discardFailedLaunch(id, { sessionDir: childSessionDir, workspaceDir: ownedCloneWorkspace, scratch: taskRuntime?.policy.scratch });
            throw error;
        }
        // Record process identity (pgid, start-time token) so health
        // reconciliation can tell a supervised child from a recycled pid
        // or an orphaned process group (#63). Best-effort: when the OS
        // probes are unavailable the fields stay absent and the run is
        // reconciled via the conservative old-metadata path.
        const identity = captureProcessIdentity(spawned.pid, spawnIdentityProbe);
        const startedAt = Date.now();

        const meta: RunMeta = {
            id, name: p.name, status: "running",
            pid: spawned.pid, spawnPid: process.pid, spawnPidStartTime: parentStartToken(), model,
            effort: thinking, cwd,
            ...identity,
            promptPreview: p.prompt.slice(0, 200),
            startedAt, logPath: logPathFor(id), sessionId: id,
            callbackOrigin,
            sandbox: sandboxDir, taskRuntime: Boolean(taskRuntime), taskScratch: taskRuntime?.policy.scratch, callback: p.callback !== false,
            ...batchInfo,
            // The launch record is JSON. Registry freezes that value; it does not
            // require the resolver's nominal type to carry an index signature.
            ...(p.catalog ? { catalog: p.catalog as unknown as RunMeta["catalog"] } : {}),
            timing: resolveRunTiming({ params: p, settings: cfg, env: process.env, startedAt }),
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
        const warn = (unavailableTools.length ? `Task sandbox: unavailable adapters for ${unavailableTools.join(", ")}; these tools are disabled.\n` : "") +
            (resolution.unmapped.length
            ? `NOTE: no extension mapped for ${resolution.unmapped.join(", ")} — ` +
              `${resolution.unmapped.length > 1 ? "these tools" : "this tool"} will NOT exist in the child. ` +
              `Add a toolExtensions entry in config.json.\n`
            : "");
        return { id, meta, spawned, runtime: runtime + (meta.timing ? `${formatTimingLimits(meta.timing, startedAt)}\n` : ""), warn, sandboxDir };
    }

    // ---- subagent_spawn -------------------------------------------------
    const acceptanceSpawnTool = {
        name: "subagent_spawn",
        label: "Spawn Subagent",
        description:
            "Launch a task in a background pi subagent (a detached `pi -p` process) and return " +
            "IMMEDIATELY with a run id. The foreground session stays free. Completion is reported " +
            "later on the user's next turn — never wait or poll for it.",
        promptSnippet: "Delegate a task to a background subagent that runs without blocking you",
        promptGuidelines: [
            "When delegation is permitted by the active mode, use subagent_spawn for assigned work that can run independently. It returns at once with a run id; report the id and continue.",
            "After subagent_spawn, do NOT call subagent_output or subagent_result in a loop to wait for the result, and do NOT sleep. The run completes on its own and reports back on the next turn.",
            "Call subagent_result after a completion or attention callback, or when the user explicitly asks for the result. Use subagent_output only when the user explicitly asks how a run is progressing; never use either tool to poll.",
            ...SUBAGENT_ORCHESTRATION_GUIDELINES,
            "The tools param is both the tool allowlist AND what determines which extensions load in the child (e.g. tools='read,bash,web_fetch' loads only the web-tools package). Ask for the tools the task needs and nothing more; clean:true gives a built-ins-only child. Pick a model with the model param (e.g. 'xai/grok-4.5@high'); providerless model patterns are resolved by Pi, while provider/model is deterministic and loads mapped provider extensions.",
            ...CATALOG_GUIDELINES,
            "By default the subagent is sandboxed. Human settings in /sandbox control file, credential-file, command, and network permissions; sandbox:false cannot override an enabled human profile. Without published settings, legacy write confinement applies. Set callback:false to finish quietly — then read the result on demand via subagent_result.",
            "Every run is timed by the harness: a soft deadline (default 30 min) steers the child to wrap up and wakes you once, the run is stopped after grace_minutes (reason deadline), a hard ceiling (default 90 min) stops it without grace (reason ceiling), and no progress for stuck_minutes (default 10) wakes you once (reason stuck). Set deadline_minutes/max_minutes/stuck_minutes to fit the task instead of writing a time limit into the prompt; do not stop a slow child that is still making progress.",
            "Use git_clone_workspace:true when the subagent will mutate Git in a sandbox. The parent prepares a disposable, self-contained clone with a real .git/ directory inside the sandbox root, so linked-worktree metadata outside the sandbox cannot stall the child.",
        ],
        parameters: Type.Object({
            prompt: Type.String({ description: "The task for the subagent. This is the only context it gets — be self-contained." }),
            name: Type.Optional(Type.String({ description: "Short label for the run (e.g. 'reviewer'). Ignored when agent or role is set, except as the direct-role alias when alias is omitted." })),
            agent: Type.Optional(Type.String({ description: "Named agent id (agent.<slug>). Mutually exclusive with role. The navigator shows the defined agent name." })),
            role: catalogRoleSchema("direct role launch"),
            alias: Type.Optional(Type.String({ description: "Per-run display alias for a direct role launch, such as checkout. Not a reusable agent. Colliding aliases gain a numeric suffix." })),
            model: Type.Optional(Type.String({ description: "Pi model pattern, preferably provider/id, optionally suffixed with @effort (for example openai/gpt-5.5@high). Providerless patterns are resolved by Pi. Default: inherit foreground model. Put authoritative model choices here; do not rely on prompt text." })),
            thinking: Type.Optional(Type.String({ description: "Reasoning effort for the child: off, minimal, low, medium, high, xhigh, or max (default: Pi/model default)." })),
            tools: Type.Optional(Type.String({ description: "Tool allowlist: comma-separated names the child may use (e.g. 'read,bash,web_fetch'). This ALSO selects which extensions load — only packages backing a requested tool are loaded. Defaults to the configured safe set." })),
            exclude_tools: Type.Optional(Type.String({ description: "Comma-separated tool denylist, applied on top of the allowlist." })),
            clean: Type.Optional(Type.Boolean({ description: "Run a hermetic child with NO extensions at all (only built-ins: read, bash, edit, write). Default false — the extensions backing the requested tools load, so web_fetch and model auth (e.g. xai) work." })),
            sandbox: Type.Optional(Type.Boolean({ description: "Use the human Subagents profile from /sandbox. An enabled human profile cannot be bypassed with false. Without published settings, defaults to kernel write confinement; false opts out of that legacy default." })),
            sandbox_dir: Type.Optional(Type.String({ description: "Confine writes to (and run the child in) this directory instead of the working dir. Created if missing." })),
            callback: Type.Optional(Type.Boolean({ description: "Default TRUE: on completion, trigger a turn that calls subagent_result and presents the result. Set false to finish quietly — the result is then read on demand via subagent_result." })),
            cwd: Type.Optional(Type.String({ description: "Working directory (default: current)." })),
            git_clone_workspace: Type.Optional(Type.Boolean({ description: "Prepare a disposable Git clone workspace for sandboxed Git-mutating subagents. The clone has a real .git/ directory inside the sandbox writable root and is self-contained after setup." })),
            approve: Type.Optional(Type.Boolean({ description: "Trust project-local files in the child (default: false; headless runs cannot prompt for trust)." })),
            allow_nested: Type.Optional(Type.Boolean({ description: "Allow the child to spawn its own subagents (default: false). Loads this extension in the child and allowlists its tools." })),
            ...timingSchemaFields(),
        }),

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const p = params as SpawnParams;
            if (p.prompt.trim() === "") throw new Error("prompt is empty.");

            const cfg = loadConfig();
            const maxConcurrent = cfg.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
            const countRunning = () =>
                listActiveMetasForParent(process.pid).filter((m) => effectiveStatus(m) === "running").length;
            // Shared with batch-spawn: reserve before any async work so an interleaved
            // batch cannot oversubscribe after this check and before writeMeta.
            const gate = getSharedCapacityGate(countRunning);
            if (!gate.tryReserve(1, maxConcurrent)) {
                throw new Error(`Max concurrent subagents (${maxConcurrent}) reached. Stop or let some finish first.`);
            }

            let reserved = 1;
            try {
                const catalog = await admitCatalog(ctx, [p]);
                if (catalog.status === "clarification-needed") {
                    gate.release(1);
                    reserved = 0;
                    return catalogResult(catalog) as ReturnType<typeof text>;
                }
                if (catalog.jobs.length > 1) {
                    const extra = catalog.jobs.length - 1;
                    if (extra > 0 && !gate.tryReserve(extra, maxConcurrent)) {
                        gate.release(1);
                        reserved = 0;
                        throw new Error(`Choosing split needs ${catalog.jobs.length} subagent slots, but only one was free. Nothing was launched.`);
                    }
                    reserved += extra;
                    const launched: { name?: string; id: string }[] = [];
                    for (const job of catalog.jobs) {
                        const { id } = await spawnSubagentRun(ctx, job);
                        gate.commit(1);
                        reserved -= 1;
                        launched.push({ name: job.name, id });
                    }
                    return text(launched.map((item) => `Subagent launched: ${item.name ? `${item.name} ` : ""}id=${item.id}.`).join("\n"));
                }
                Object.assign(p, catalog.jobs[0]);
                const { id, spawned, runtime, warn, sandboxDir } = await spawnSubagentRun(ctx, p);
                gate.commit(1);
                reserved = 0;
                return text(
                    `Subagent launched: ${p.name ? `${p.name} ` : ""}id=${id} (pid ${spawned.pid}).\n` +
                    (p.callback === false
                        ? `Running in the background; the foreground is free. It will finish quietly — read the result with subagent_result id=${id}.\n`
                        : `Running in the background; the foreground is free. Its result will be posted back here when it finishes.\n`) +
                    (sandboxDir ? `Sandboxed: project root ${sandboxDir}; launch permissions apply.\n` : "") +
                    runtime + warn +
                    `Log: ${logPathFor(id)}`,
                );
            } catch (err) {
                if (reserved === 1) gate.release(1);
                else if (reserved > 0) gate.release(reserved);
                throw err;
            }
        },
    };
    acceptanceSpawnToolRef = acceptanceSpawnTool;
    pi.registerTool(acceptanceSpawnTool);

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
            "When delegation is permitted by the active mode, use subagent_spawn_batch for several independent assigned tasks. It returns immediately with a batch id and one run id per launched job.",
            "Each job is a normal subagent run; use subagent_result / subagent_output / subagent_stop with the individual run ids just like subagent_spawn.",
            "Do NOT poll for results. Each job reports back on its own when it finishes.",
            ...SUBAGENT_ORCHESTRATION_GUIDELINES,
            "By default the whole batch is rejected if there is not enough capacity. Set onCapacity to 'launch-available' to launch as many as fit and report the rest as skipped.",
            ...CATALOG_GUIDELINES,
            "Per-job agent, role, alias, model, and thinking override shared. One batch refreshes the catalog once and every job uses that snapshot. Jobs are resolved independently.",
        ],
        parameters: Type.Object({
            batchName: Type.Optional(Type.String({ description: "Optional display label for the batch." })),
            shared: Type.Optional(Type.Object({
                name: Type.Optional(Type.String({ description: "Label applied to jobs that do not set their own. Direct-role alias when alias is omitted." })),
                agent: Type.Optional(Type.String({ description: "Named agent id applied to jobs that do not select their own agent or role." })),
                role: catalogRoleSchema("shared role selector"),
                alias: Type.Optional(Type.String({ description: "Direct-role alias applied when a job does not set alias." })),
                model: Type.Optional(Type.String({ description: "Pi model pattern, preferably provider/id, optionally suffixed with @effort (default: inherit foreground model). Put authoritative model choices here; prompt text is not parsed." })),
                thinking: Type.Optional(Type.String({ description: "Reasoning effort applied to every job: off, minimal, low, medium, high, xhigh, or max." })),
                tools: Type.Optional(Type.String({ description: "Tool allowlist applied to every job." })),
                exclude_tools: Type.Optional(Type.String({ description: "Comma-separated tool denylist applied to every job." })),
                sandbox: Type.Optional(Type.Boolean({ description: "Use the human Subagents profile; false cannot override an enabled profile. Legacy default is write confinement." })),
                sandbox_dir: Type.Optional(Type.String({ description: "Writable root for every job." })),
                callback: Type.Optional(Type.Boolean({ description: "Default TRUE: post result back on completion." })),
                clean: Type.Optional(Type.Boolean({ description: "Hermetic builtins-only child; no extensions load." })),
                cwd: Type.Optional(Type.String({ description: "Working directory (default: current)." })),
                git_clone_workspace: Type.Optional(Type.Boolean({ description: "Prepare a disposable Git clone workspace for each job (same semantics as subagent_spawn)." })),
                approve: Type.Optional(Type.Boolean({ description: "Trust project-local files in children." })),
                allow_nested: Type.Optional(Type.Boolean({ description: "Allow children to spawn their own subagents." })),
                ...timingSchemaFields(),
            }, { description: "Options applied to every job; per-job values override these." })),
            jobs: Type.Array(Type.Object({
                prompt: Type.String({ description: "The task for this job." }),
                name: Type.Optional(Type.String({ description: "Short label for this job. Direct-role alias when alias is omitted." })),
                agent: Type.Optional(Type.String({ description: "Named agent id for this job. Overrides shared agent and role." })),
                role: catalogRoleSchema("batch job"),
                alias: Type.Optional(Type.String({ description: "Direct-role alias for this job." })),
                model: Type.Optional(Type.String()),
                thinking: Type.Optional(Type.String()),
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
                ...timingSchemaFields(),
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
                listActiveMetasForParent(process.pid).filter((m) => effectiveStatus(m) === "running").length;
            const launchAvailable = p.onCapacity === "launch-available";
            // Shared with single-spawn. Reservations count against maxConcurrent so a
            // concurrent single spawn cannot take a slot the batch already admitted.
            const gate = getSharedCapacityGate(countRunning);

            validateBatchPlan({ shared: p.shared, jobs: p.jobs, onCapacity: p.onCapacity, config: cfg });

            let catalogSnapshot: CatalogSnapshot | undefined;
            let catalogHost: CatalogHost | undefined;
            if (hasCatalogSelector(p.shared) || p.jobs.some((job) => hasCatalogSelector(job))) {
                catalogHost = catalogHostFrom(ctx);
                noteCatalogHost(catalogHost);
                catalogSnapshot = loadLaunchSnapshot(catalogHost);
                const clarified = await clarifyCatalogRequest(
                    p.jobs.map((job) => mergeJobOptions(p.shared, job) as CatalogJobFields),
                    { hasUI: catalogHost.hasUI === true, select: catalogHost.select },
                );
                if (clarified.status === "clarification-needed") return catalogResult(clarified) as ReturnType<typeof text>;
                p.jobs = clarified.jobs as typeof p.jobs;
                validateBatchPlan({ shared: undefined, jobs: p.jobs, onCapacity: p.onCapacity, config: cfg });
            }

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
                let name = names[i];
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
                    if (catalogSnapshot && catalogHost && hasCatalogSelector(merged)) {
                        const explicitName = typeof job.name === "string" && job.name.trim() !== "" ? job.name : undefined;
                        const prepared = await prepareCatalogJob(catalogSnapshot, {
                            ...merged,
                            name: explicitName,
                            alias: typeof merged.alias === "string" && merged.alias.trim() !== "" ? merged.alias : explicitName,
                        }, catalogHost);
                        if (prepared.status === "blocked") throw new Error(prepared.message);
                        if (prepared.status === "ready") {
                            Object.assign(merged, prepared.assign);
                            if (prepared.assign.model === undefined) delete merged.model;
                            if (prepared.assign.thinking === undefined) delete merged.thinking;
                            name = prepared.assign.name;
                        }
                    }
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
    // The foreground origin from session_start; otherwise the calling context's
    // own session. An unreadable session id stays unavailable (never cwd-wide).
    const toolSession = {
        getActiveOrigin: (ctx?: unknown) => activeCallbackOrigin ?? verifiedOriginFromContext(ctx as ExtensionContext | undefined),
    };
    pi.registerTool(subagentListTool(Type, toolSession));
    pi.registerTool(subagentOutputTool(Type, toolSession));
    const acceptanceResultTool = subagentResultTool(Type, toolSession);
    pi.registerTool(acceptanceResultTool);
    publishAcceptanceHooks(acceptanceResultTool);
    const acceptanceStopTool = subagentStopTool(Type, { onStopped: renderWidget });
    acceptanceStopToolRef = acceptanceStopTool;
    pi.registerTool(acceptanceStopTool);
    publishAcceptanceHooks();

    const agentOperations = createAgentOperations({
        projectConfigDirName,
        propagateCommandContext(commandCtx) {
            noteCatalogHost(catalogHostFrom(commandCtx));
        },
        resolveHost(toolCtx) {
            const full = toolCtx as Partial<ExtensionContext> & { cwd: string; isProjectTrusted(): boolean };
            noteCatalogHost(catalogHostFrom({
                cwd: full.cwd,
                hasUI: full.hasUI === true,
                model: full.model,
                modelRegistry: full.modelRegistry,
                ui: full.ui ?? { select: async () => undefined },
                isProjectTrusted: () => full.isProjectTrusted(),
            } as ExtensionContext));
            return {
                cwd: full.cwd,
                projectTrusted: full.isProjectTrusted(),
                userRoot: defaultUserRoot(),
                projectConfigDirName,
            };
        },
        enrich: createLaunchEnricher(),
    });
    if (typeof pi.registerCommand === "function") {
        agentOperations.registerCommands(pi);
        pi.registerCommand("subagents", {
            description: "Show or change the current-session delegation mode",
            async handler(args, ctx) {
                const tokens = args.trim().split(/\s+/).filter(Boolean);
                if (tokens.length === 0) {
                    ctx.ui.notify(`Delegation mode: ${activeDelegationMode()}.`, "info");
                    return;
                }
                const requested = tokens[1];
                if (tokens.length === 2 && tokens[0] === "mode" && isDelegationMode(requested)) {
                    delegationOverride = requested;
                    pi.appendEntry("pi-better-subagents-delegation", { version: 1, mode: delegationOverride });
                    ctx.ui.notify(`Delegation mode: ${delegationOverride} (current session).`, "info");
                } else {
                    ctx.ui.notify("Usage: /subagents [mode manual|adaptive|coordinator]", "warning");
                }
            },
        });
    }
    const discoveryTool = agentOperations.createDiscoveryTool(Type as never);
    pi.registerTool(discoveryTool as Parameters<ExtensionAPI["registerTool"]>[0]);

    pi.on("before_agent_start", (event) => ({
        systemPrompt: `${event.systemPrompt}\n\n${delegationPrompt(activeDelegationMode())}`,
    }));

    // ---- live-status lifecycle -----------------------------------------
    pi.on("agent_start", async (_event, ctx) => {
        uiCtx = ctx;
        mainAgentStartedAt = Date.now();
        mainAgentTools.clear();
        refreshBackgroundWorkNavigator(ctx);
    });

    pi.on("tool_execution_start", async (event, ctx) => {
        mainAgentTools.set(event.toolCallId, event.toolName);
        refreshBackgroundWorkNavigator(ctx);
    });

    pi.on("tool_execution_end", async (event, ctx) => {
        mainAgentTools.delete(event.toolCallId);
        refreshBackgroundWorkNavigator(ctx);
    });

    pi.on("message_end", async (event, ctx) => {
        if (event.message.role === "assistant") refreshBackgroundWorkNavigator(ctx);
    });

    pi.on("model_select", async (_event, ctx) => {
        // The selected model is already on ctx. Inspection between this event
        // and the next /agents call must not keep the previous foreground.
        try { noteCatalogHost(catalogHostFrom(ctx)); } catch { /* navigator still redraws */ }
        refreshBackgroundWorkNavigator(ctx);
    });

    pi.on("thinking_level_select", async (_event, ctx) => {
        refreshBackgroundWorkNavigator(ctx);
    });

    pi.on("agent_settled", async (_event, ctx) => {
        mainAgentStartedAt = undefined;
        mainAgentTools.clear();
        refreshBackgroundWorkNavigator(ctx);
    });

    pi.on("session_tree", async (_event, ctx) => {
        restoreDelegationMode(ctx);
    });

    // Capture a UI-bearing context and, if runs from a prior session are still
    // alive, resume the ticking widget. Deferred out of the factory per pi's
    // "no background resources at load" rule.
    pi.on("session_start", async (_event, ctx) => {
        restoreDelegationMode(ctx);
        uiCtx = ctx;
        try { noteCatalogHost(catalogHostFrom(ctx)); } catch { /* catalog inspection stays undecided */ }
        try { mainAgentStartedAt = ctx.isIdle() ? undefined : Date.now(); }
        catch { mainAgentStartedAt = undefined; }
        mainAgentTools.clear();
        activeCallbackOrigin = callbackOriginFromContext(ctx);
        recoverCompletionCallbacks(pi);
        // Reload / session switch hardening (#48):
        // - Drop any leftover overlay timers/confirm state from a prior session
        //   (defensive if the host skipped session_shutdown before re-start).
        // - Reinstall the editor wrapper without stacking (marked factory).
        // - Clear + republish footer statuses (pi clears extension statuses on
        //   session switch/reload; dirty-check only dedupes within a session).
        // - Repaint the widget even if its last in-memory lines match; the host
        //   may have dropped extension UI during reload/session replacement.
        ensureSubagentProvider();
        // Adopt records left non-terminal by a pi that died without a clean
        // shutdown, so the age sweep can eventually retire them.
        reconcileAbandonedRuns();
        disposeBackgroundWorkNavigator(ctx);
        widgetNavActive = false;
        widgetNavSelectedId = undefined;
        if (isNavigatorUiAvailable(ctx)) {
            try { ctx.ui.setStatus(CLOSE_CONFIRM_STATUS_KEY, undefined); } catch { /* ignore */ }
        }
        ensureNavigator(ctx);
        publishAcceptanceHooks();
        updateNavigatorFooter(ctx);
        // Clear the retired legacy widget so the shared navigator is the only
        // list surface for running/orphaned subagents.
        renderWidget();
        // Resume supervision reconciliation + durable health-callback recovery
        // across /reload while current-parent work still needs the ticker
        // (running/orphaned, or unmarked lost); it stops itself when idle.
        if (needsMonitoring(listMetasForParent(process.pid)) || hasPendingFailureCallbacks()) ensureHealthTicker();
    });

    pi.on("session_before_switch", () => {
        activeCallbackOrigin = undefined;
        cancelCallbackBatch(pi);
        mainAgentStartedAt = undefined;
        mainAgentTools.clear();
        disposeBackgroundWorkNavigator();
    });

    // Tear down the timer and clear the widget when the session ends.
    pi.on("session_shutdown", async (_event, ctx) => {
        // The foreground Pi session owns this work. Stop current-session
        // running/orphaned children before dropping the session origin, so they
        // cannot become live process groups with no coordinator.
        stopCurrentSessionSubagents(ctx);
        activeCallbackOrigin = undefined;
        if (typeof unsubscribeDelegationRequest === "function") unsubscribeDelegationRequest();
        cancelCallbackBatch(pi);
        mainAgentStartedAt = undefined;
        mainAgentTools.clear();
        stopTicker();
        stopHealthTicker();
        spendCache.clear();
        healthLogCache.clear();
        progressCache.clear();
        // Release the incremental log cursors' retained state with the session.
        resetChildEventLogCursor();
        resetParseRunCursor();
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
