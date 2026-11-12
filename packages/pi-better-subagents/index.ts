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

import { assignmentFor } from "./assignment-projection.mjs";
import { historicalWaits, attentionRevision, attentionDismissed, dismissAttention } from "./historical-attention.ts";
import { registerAssignmentAttempt, commitAssignmentTerminal, readOutcome, receiptOutcome, outcomeTranscriptReceipt, inspectOutcome, createOutcomeHost, closeOutcomeHost, claimOutcome, type AssignmentBinding } from "./assignment-outcomes.ts";
import { currentSandboxPermissions } from "./permission-policy.ts";
import { requestResumeAdmission } from "./worker-waits.ts";
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import * as PiTui from "@earendil-works/pi-tui";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { initializeNavigatorPanels } from "./shared-navigator-panels.ts";
import { matchesKey, Key, truncateToWidth, type AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "@earendil-works/pi-ai";
import {
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
import { spawnDetached, killProcessTree, type SpawnResult } from "./spawn.ts";
import { parseRun, parseRunForLifecycle, readRunTranscript, resetParseRunCursor, type Usage } from "./parse.ts";
import { finalizeRun as finalizeRunCore } from "./finalization.ts";
import { selectSessionByName } from "./session-selection.ts";
import { isWithinWorkspace } from "./workspace-scope.ts";
import { loadConfig, writeDelegationMode, writeSubagentSettings, isConcurrencyCap, normalizeConcurrencyCap, normalizeTools, resolveExtensionPath, configPath, selfDir, SAFE_DEFAULT_TOOLS, SAFE_CLEAN_TOOLS } from "./config.ts";
import { createSubagentSettingsPage } from "./settings-page.ts";
import { deliverSubagentPrompt, effectiveSubagentSettings, formatSubagentSettings, subagentSettingsTool, SUBAGENT_SETTINGS_CONTEXT } from "./effective-settings.ts";
import { STEER_FILE_ENV, readSteerReceipt } from "./child-steer.ts";
import {
    continuationTimingParams,
    decideTiming,
    describeTiming,
    DEFAULT_TIMING_MINUTES,
    emptyProgress,
    foldProgress,
    formatTimingLimits,
    isTimingMinutes,
    isProgressRelevantLine,
    resolveRunTiming,
    steerText,
    stuckAlertText,
    TIMING_ENV,
    timingParameterSchemas,
    toolWaitAlertText,
    validatedTimingMinutes,
    type OpenCallRecord,
    type ProgressState,
    type TimingSettings,
    type TimingParams,
    type TimingStopReason,
} from "./timing.ts";
import { readAppendedLines, type LogCursor } from "./log-cursor.ts";
import { DELEGATION_MODES, DELEGATION_MODE_REQUEST, isDelegationMode, normalizeDelegationMode, type DelegationMode } from "./delegation.ts";
import { resolveChildClosure, resolveChildLaunch, configSnapshot } from "./child-dependencies.mjs";
import { PREFLIGHT_ENV } from "./child-preflight.mjs";
import { resolveExtensions, extensionArgs } from "./extensions.ts";
import { prepareTaskRuntime, applyDirectApplicationLoadout, RUN_APPLICATION, SDK_BUILTIN_TOOLS } from "./task-policy.ts";
import { canonicalizePath, takeRecoverySnapshot } from "./shared-sandbox-core.ts";
import { TASK_BUILTINS } from "./shared-task-sandbox.ts";
import { APPLY_PATCH, describeTaskTools, planTaskTools, selectEffectiveTaskTools } from "./subagent-tools.ts";
import {
    announceExecutionAdapter, observeSandboxPermissions, resolveCommandSettings, resolveSubagentPermissions,
} from "./permission-policy.ts";
import { resolveSubagentWorkspace } from "./git-workspace.ts";
import { dirname, isAbsolute, join } from "node:path";
import {
    baseDir,
    taskWorkspaceDir,
    sessionsDir,
    runDir,
    recordTaskRuntimeProvenance,
    discardFailedLaunch,
    recordLaunchAttempt,
    clearLaunchAttempt,
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
    batchLaunchOutputSchema,
    batchLaunchResult,
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
import { cancelCallbackBatch, getCallbackBatcher, setCallbackBatchContext } from "./shared-callback-batcher.ts";
import { completionCallbackFields, failureAttentionFields, healthCallbackFields } from "./callback-fields.ts";
import { collectRunFailures, failurePath, markFailureAttentionDelivered, pendingFailureAttention } from "./failures.ts";
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
    pendingNavigatorPark,
    buildNavigatorDetail,
} from "./navigator.ts";
import { enforceRegistrySizeCapOnce, runDailyCleanupOnce } from "./cleanup.ts";
import {
    ContinuationError,
    acquireConversationLease,
    assertContinuationExtensions,
    buildLaunchRecipe,
    planContinuation,
    type ContinuationPlan,
    type ConversationLease,
} from "./continuation.ts";
import { createHash } from "node:crypto";
import { assertThinkingLevel, parseModelThinking, type ThinkingLevel } from "./thinking.ts";
import {
    absolutizeSkillPaths,
    configuredSkillExposure,
    describeSkillExposure,
    normalizeSkillExposure,
    resolveSkillExposure,
    skillLaunchArgs,
    type SkillExposureMode,
} from "./skills.ts";
import type { DiscoveredSkill } from "./skill-picker.ts";
import { createAgentOperations } from "./agent-operations.ts";
import { createAgentSessionSettings } from "./agent-session-settings.ts";
import {
    clarifyCatalogRequest,
    createLaunchEnricher,
    blankCatalogSelector,
    hasCatalogSelector,
    loadLaunchSnapshot,
    noteCatalogHost,
    prepareCatalogJob,
    catalogDefaultNote,
    tiersForLaunch,
    type CatalogHost,
    type CatalogJobFields,
    type CatalogRunRecord,
} from "./catalog-runtime.ts";
import { registerSubagentsGoalProvider } from "./goal-provider.ts";
import {
    DEFAULT_WORKER_BRIDGE_TOOLS,
    PreSpawnResumeError,
    type WorkerSandboxAuthority,
    assertAssignmentPermissionScope,
    assertFinalResumeDispatch,
    releaseChild,
    cancelParkedWait,
    branchContains,
    captureWorkerPolicy,
    createOwnedAttemptStopper,
    childBridgeExtensionPath,
    childWriterLeaseEnv,
    createResumeOrchestration,
    createWorkerOperationsHost,
    finalizeWorkerParkAfterExit,
    manualResumeRefusal,
    ownerBindingFromContext,
    parkedWaitForRun,
    planWorkerBridgeTools,
    reconcileParkedWaits,
    resolveProductionSchemas,
    resumePrompt,
    settleResumedAttemptExit,
    type ResumeCapacity,
    type ResumeLaunchInput,
    type WaitOwnerBinding,
    type ResumeOrchestration,
    type WorkerOperationsHost,
} from "./worker-waits.ts";
import { defaultUserRoot, type CatalogSnapshot } from "./catalog-store.ts";
import { restrictContextFilesToWorktree } from "./shared-worktree-context.ts";

const SUBAGENT_MODE_ACTIONS: readonly AutocompleteItem[] = [
    { value: "settings", label: "settings", description: "Open delegation, concurrency, and timing settings" },
    { value: "cap", label: "cap <number>", description: "Set a positive concurrent subagent limit for this session" },
    { value: "tool-wait", label: "tool-wait <minutes>", description: "Set the session tool-wait alert time; 0 turns it off" },
    { value: "stuck", label: "stuck <minutes>", description: "Set the session no-progress alert time; 0 turns it off" },
    { value: "reset", label: "reset", description: "Reset session mode, cap, and timing alerts to saved defaults" },
    { value: "mode manual", label: "mode manual", description: "Delegate only when explicitly requested" },
    { value: "mode adaptive", label: "mode adaptive", description: "Delegate substantial independent work" },
    { value: "mode coordinator", label: "mode coordinator", description: "Delegate role-owned work by default" },
    { value: "save", label: "save", description: "Save the current mode, cap, and timing alerts as defaults" },
];

export function subagentsArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
    const prefix = argumentPrefix.trimStart().toLowerCase();
    const matches = SUBAGENT_MODE_ACTIONS.filter((action) => action.value.startsWith(prefix));
    return matches.length > 0 ? [...matches] : null;
}

/** The tools this extension registers — excluded from children by default so a
 *  subagent cannot recursively spawn more subagents unless explicitly allowed. */
const SUBAGENT_TOOLS = [
    "subagent_spawn",
    "subagent_spawn_batch",
    "subagent_list",
    "subagent_settings",
    "subagent_output",
    "subagent_stop",
    "subagent_result",
    "agents_catalog",
];

const projectConfigDirName = typeof (PiCodingAgent as { CONFIG_DIR_NAME?: unknown }).CONFIG_DIR_NAME === "string"
    ? (PiCodingAgent as { CONFIG_DIR_NAME: string }).CONFIG_DIR_NAME
    : ".pi";

const CATALOG_GUIDELINES = [
    "With an agent or role, omit model and thinking to launch on its default model and effort, which agents_catalog shows. Name a model or effort only for a stated reason, such as a task or workflow instruction, and never copy one from another role's runs.",
    "When a task, workflow, or skill instruction names a model or effort, translate that authoritative choice into the structured model and thinking arguments before spawning. The runtime does not parse prose, quoted model names, or comparisons, and copying a model into the child prompt does not change the launch.",
    "Optional agent, role, and alias select a catalog definition. Pass one named agent id (agent: \"agent.payments\") or one role by its short name (role: \"developer\"); the role.developer form also works. Pass an array of role names when one run was given more than one role: that call asks to choose one or split, and without a UI choice it returns clarification-needed and starts no child. Naming both an agent and a role does the same. One job's choice does not change another job. A named agent displays its defined name. A direct role displays the label allocated from the local run registry. Calls without agent or role keep the existing name and model chain.",
    "Catalog model and effort are resolved before the child starts. An unavailable explicit model or unsupported explicit effort does not launch and does not fall back. The catalog grants no tools, sandbox modes, extensions, or permissions.",
];

const SUBAGENT_ORCHESTRATION_GUIDELINES = [
    "Follow the Harness execution policy for concurrency; the active delegation mode determines whether to use subagents, not whether independent background commands can overlap.",
    "When a structured plan is active, follow the current delegation mode. Track delegated and foreground deliverables only when delegation is permitted and actually underway; continue unblocked foreground work and integrate results before marking work complete.",
    "Do not treat launching a subagent as completion of the parent milestone; relevant terminal results must be inspected and integrated before verification or completion.",
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

/**
 * Instance-local suppression: this module has no active session, not the run.
 * A finalizer that runs after `/reload` (the process and its exit observer
 * survive the session) can report this even though the replacing session owns
 * the run, so it must never be written as a durable suppression (#625).
 */
const NO_ACTIVE_SESSION_REASON = "active session identity is unavailable";

function callbackSuppressionReason(meta: RunMeta, active: RunCallbackOrigin | undefined = activeCallbackOrigin): string | undefined {
    const origin = meta.callbackOrigin;
    if (origin) {
        if (!active) return NO_ACTIVE_SESSION_REASON;
        if (origin.cwd !== active.cwd) return `origin cwd ${origin.cwd} does not match active cwd ${active.cwd}`;
        if (origin.sessionId && origin.sessionId !== active.sessionId) {
            return `origin session ${origin.sessionId} does not match active session ${active.sessionId ?? "unknown"}`;
        }
        if (meta.operations?.resumeLaunchToken && meta.operations.branchId
            && (!uiCtx || !branchContains(uiCtx, meta.operations.branchId))) {
            return `origin branch ${meta.operations.branchId} is not active`;
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

/**
 * Runs this extension instance launched, so its in-memory exit observer is the
 * authority that finalizes them. A run adopted after `/reload` is absent here:
 * the instance that held the observer is gone, so supervision falls back to the
 * child's own log (see `finalizeInterruptedRunFromLog`).
 */
const directlySupervisedRunIds = new Set<string>();

/**
 * Detach current-session live work instead of killing it (#625).
 *
 * Subagent children are detached process groups: they survive the foreground
 * process dying. The previous shutdown loop therefore made every controlled
 * `/reload` (and every clean quit) a silent, destructive end to in-flight work —
 * no drain, no warning, and the run recorded `killed`. Shutdown now only records
 * that this session's direct supervision ended; the child and all of its saved
 * state stay untouched, and the next session of the same pi process resumes
 * supervision and finalizes it from the child's own log.
 *
 * Returns the interrupted runs so the caller can warn the human.
 */
function interruptCurrentSessionSubagents(reason: string, ctx: ExtensionContext): RunMeta[] {
    const origin = callbackOriginFromContext(ctx);
    const now = Date.now();
    const interrupted: RunMeta[] = [];
    for (const summary of listMetasForParent(process.pid)) {
        if (!ownedByThisParent(summary)) continue;
        if (summary.status !== "running" && summary.status !== "orphaned") continue;
        if (!belongsToOrigin(summary, origin)) continue;
        // Corrupt or synthetic metadata must never point the interruption record
        // (or any later signal) at the foreground Pi process itself.
        if (hasSelfProcessIdentity(summary)) continue;
        try {
            // Re-read under the id: a run may have finished while shutdown ran.
            const meta = readMeta(summary.id);
            if (!meta || (meta.status !== "running" && meta.status !== "orphaned")) continue;
            meta.supervisionInterruptedAt = now;
            meta.supervisionInterruptedReason = reason;
            writeMeta(meta);
            interrupted.push(meta);
        } catch { /* a failed marker must never kill or block the child */ }
        spendCache.delete(summary.id);
        healthLogCache.delete(summary.id);
        resetChildEventLogCursor(summary.id);
    }
    return interrupted;
}

/** Warn the human that a shutdown/reload left delegated work running (#625). */
function warnInterruptedSubagents(ctx: ExtensionContext, interrupted: RunMeta[], reason: string): void {
    if (interrupted.length === 0) return;
    const count = interrupted.length;
    const label = count === 1 ? "1 subagent run is" : `${count} subagent runs are`;
    const ids = interrupted.slice(0, 3).map((meta) => meta.id).join(", ") + (count > 3 ? ", …" : "");
    const verb = reason === "reload" ? "reload" : "session shutdown";
    const guidance = reason === "reload"
        ? "The reloaded session resumes supervision and reports the result; use subagent_stop to end it instead."
        : "They keep running detached and stay readable with subagent_result/subagent_output; use subagent_stop to end one.";
    try {
        ctx.ui.notify(`Subagent ${label} still running (${ids}) — ${verb} no longer kills delegated work. ${guidance}`, "warning");
    } catch { /* no UI available (print/RPC/quit) */ }
}

/**
 * True once this extension instance's `session_shutdown` has run. A late child
 * finalizer can still execute after `/reload` (the process and its exit
 * observer survive the session), and such a finalizer must not restart
 * supervision loops or durably suppress a callback just because THIS instance
 * no longer has a session.
 */
let sessionTornDown = false;
let outcomeHost = createOutcomeHost();
const outcomeAdmission = new Map<string, () => boolean>();

/**
 * "The rightful conversation is not the active one", not "this notification is
 * dead" (#625). These reasons only defer delivery to whoever owns the run, so
 * they must never consume an interrupted run's owed completion.
 */
function isConversationIdentityReason(reason: string): boolean {
    return reason === NO_ACTIVE_SESSION_REASON
        || reason.startsWith("origin session ")
        || reason.startsWith("origin branch ")
        || reason.startsWith("origin cwd ")
        || reason.startsWith("legacy run cwd ");
}

function markCompletionCallbackSuppressed(id: string, reason: string, now: number = Date.now()): void {
    // A finalizer that runs after this instance was torn down cannot name the
    // session that owns the run now. Suppressing durably would erase the
    // pending marker the replacing session recovers (#625), so leave it.
    if (sessionTornDown && reason === NO_ACTIVE_SESSION_REASON) return;
    const meta = readMeta(id);
    if (!meta || meta.completionCallbackSentAt !== undefined || meta.completionCallbackSuppressedAt !== undefined) return;
    // An explicitly interrupted run owes its completion to the conversation that
    // launched it (#625, DEV-226 criterion 5). An unrelated session merely being
    // active — B opening before the original A returns — drops this delivery
    // attempt but must keep the obligation: the pending marker stays, and A
    // recovers it when it comes back. Records that never lost supervision keep
    // today's durable suppression, so legacy/foreign notifications stay dead.
    if ((meta.supervisionInterruptedAt !== undefined || meta.operations?.resumeLaunchToken)
        && isConversationIdentityReason(reason)) return;
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
    if (meta?.assignment) {
        try {
            const outcome = commitAssignmentTerminal(meta);
            if (outcome) { void enqueueAssignmentOutcome(pi, meta); return; }
            // An unresolved assignment exit belongs to repair, not legacy delivery.
            return;
        } catch (error) {
            try { uiCtx?.ui?.notify(`Assignment outcome could not commit: ${String(error)}`, "warning"); } catch { /* no UI */ }
            return;
        }
    }
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

async function enqueueAssignmentOutcome(pi: ExtensionAPI, meta: RunMeta): Promise<void> {
    const outcome = readOutcome(meta);
    const ctx = uiCtx;
    if (!outcome || outcome.deliveryReceipt || outcome.disposition || !ctx || meta.callback === false
        || typeof ctx.sessionManager?.getBranch !== "function") return;
    const active = ownerBindingFromContext(ctx);
    if (active.sessionId !== outcome.recipient.sessionId || active.workspace !== outcome.recipient.workspace
        || (outcome.recipient.branchId && !ctx.sessionManager.getBranch().some((entry) => entry.id === outcome.recipient.branchId))) return;
    const prior = outcomeTranscriptReceipt(ctx.sessionManager.getBranch(), outcome.eventId);
    if (prior) { receiptOutcome(meta, prior); return; }
    const gate = await requestResumeAdmission(pi, active, { timeoutMs: 50 });
    outcomeAdmission.set(outcome.eventId, () => gate.allowed ? gate.isCurrent?.() !== false : !active.goalId && !outcome.recipient.goalId && gate.revision === -1);
    if (!gate.allowed && (active.goalId || outcome.recipient.goalId || gate.revision !== -1)) return;
    if (!claimOutcome(meta, outcomeHost)) return;
    getCallbackBatcher(pi).enqueue({
        source: "subagent", id: outcome.eventId, inspectId: meta.id, receiptId: outcome.eventId,
        label: meta.name ?? meta.id,
        status: outcome.outcome, outcome: outcome.reason, detailTool: "subagent_result", callback: true,
        isDelivered: () => Boolean(readOutcome(meta)?.deliveryReceipt),
        getSuppressionReason: () => {
            if (!uiCtx || callbackSuppressionReason(meta)) throw new Error("Recorded parent is inactive; retain outcome.");
            if ((outcome.recipient.branchId && !uiCtx.sessionManager.getBranch().some((entry) => entry.id === outcome.recipient.branchId)) || !outcomeAdmission.get(outcome.eventId)?.()) throw new Error("Parent delivery authority changed; retain outcome.");
            return undefined;
        },
        onDelivered: (at) => {
            const entry = outcomeTranscriptReceipt(ctx.sessionManager.getBranch(), outcome.eventId);
            if (!entry) throw new Error("Awaiting durable recipient transcript receipt.");
            receiptOutcome(meta, entry);
            markCompletionCallbackSent(meta.id, at);
        },
    });
}

/**
 * Recover only records explicitly marked pending; legacy terminal runs never replay.
 *
 * Current-parent records are recovered unconditionally (the owner decides, and the
 * session gate still suppresses a different foreground session). A run an
 * interrupted DEAD parent left behind is recovered only by the conversation that
 * launched it: that session id is the ownership proof, so an unrelated session
 * never adopts it. A foreign parent that is still alive keeps ownership — the
 * same `isAbandonedByParent` proof the running-record supervision uses — so this
 * path never takes a live pi's terminal callback (#625, DEV-226 criterion 5).
 */
function recoverAssignmentOutcomes(pi: ExtensionAPI): void {
    for (const meta of activeCallbackOrigin ? listMetasForOrigin(activeCallbackOrigin) : []) if (meta.assignment) {
        try { if (commitAssignmentTerminal(meta)) void enqueueAssignmentOutcome(pi, meta); } catch { /* keep unverified; no legacy handoff */ }
    }
}

function recoverCompletionCallbacks(pi: ExtensionAPI): void {
    recoverAssignmentOutcomes(pi);
    for (const meta of listMetasForParent(process.pid)) {
        if (!ownedByThisParent(meta)) continue;
        enqueueCompletionCallback(pi, meta.id);
    }
    const activeSessionId = activeCallbackOrigin?.sessionId;
    if (!activeSessionId) return;
    for (const summary of listMetas()) {
        if (ownedByThisParent(summary) || summary.supervisionInterruptedAt === undefined) continue;
        if (summary.status === "running" || summary.status === "orphaned") continue;
        // A live foreign parent still owns its run's callback: never deliver for it.
        if (!isAbandonedByParent(summary, realProcessProbe)) continue;
        const meta = readMeta(summary.id);
        if (!meta || meta.status === "running" || meta.status === "orphaned") continue;
        if (meta.callbackOrigin?.sessionId !== activeSessionId) continue;
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
    if (!ctx) return;
    // A run can exit after Pi replaced the session that captured this ctx; Pi then throws on any
    // property read. That session's UI is gone, so drop the ctx instead of failing the finalizer.
    try {
        if (!ctx.hasUI) return;
    } catch {
        if (uiCtx === ctx) uiCtx = undefined;
        return;
    }
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
    // A fresh (or restarted) fold may have lost the start of a call that is still
    // running: seed it from the durable record rather than reporting silence.
    if (!entry || read.restarted) {
        entry = { state: emptyProgress(meta.startedAt, meta.timing?.openCalls ?? meta.timing?.inFlight) };
    }
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

function sameOpenCalls(a: readonly OpenCallRecord[] | undefined, b: readonly OpenCallRecord[]): boolean {
    return a !== undefined && a.length === b.length && a.every((call, index) => {
        const next = b[index];
        return next !== undefined && call.id === next.id && call.since === next.since
            && call.name === next.name && call.command === next.command;
    });
}

/**
 * One parent wake for a timing event. The marker records a handoff (or an
 * intentional suppression), so reloads and later ticks never repeat it.
 */
function deliverTimingWake(pi: ExtensionAPI | undefined, meta: RunMeta, kind: "deadline" | "stuck" | "tool-wait", key: string,
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
        // A log finalization is terminal evidence discovered here, not by the child
        // exit handler, so this path still owes the one completion callback (#624).
        if (pi && outcome.action === "finalized") enqueueCompletionCallback(pi, id);
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
    // Progress is folded whenever a control can use it: the stuck or tool-wait
    // window, or a deadline whose steer must be held behind a running call (the
    // record of that call must exist before the deadline, not only after it).
    const needsProgress = timing.stuckMs !== undefined || timing.toolWaitMs !== undefined || timing.deadlineAt !== undefined;
    const progress = needsProgress ? readProgress(meta) : undefined;
    const patch: Partial<NonNullable<RunMeta["timing"]>> = {};
    if (progress?.lastProgressAt !== undefined && progress.lastProgressAt > (timing.lastProgressAt ?? 0)) patch.lastProgressAt = progress.lastProgressAt;
    if (progress) {
        const openCalls: OpenCallRecord[] = [...progress.open.entries()].map(([id, call]) => ({
            id, since: call.startedAt,
            ...(call.name ? { name: call.name } : {}),
            ...(call.command !== undefined ? { command: call.command.slice(0, 200) } : {}),
        }));
        const first = openCalls[0];
        const openId = first?.id;
        const since = progress.inFlightSince ?? first?.since ?? progress.lastEventAt ?? meta.startedAt;
        // Durable still-alive evidence: every call the child is waiting on. Survives a
        // reload whose bounded log read no longer contains a call's start (#620).
        if (openCalls.length > 0) {
            if (!sameOpenCalls(timing.openCalls, openCalls)) patch.openCalls = openCalls;
        } else if (timing.openCalls !== undefined) {
            patch.openCalls = undefined;
        }
        if (openId === undefined) {
            if (timing.inFlight !== undefined) patch.inFlight = undefined;
        } else if (timing.inFlight?.id !== openId || timing.inFlight.since !== since) {
            patch.inFlight = { id: openId, since };
        }
        // A finished call needs no marker. Keeping only live call ids bounds the record.
        const openIds = new Set(openCalls.map((call) => call.id));
        const alerted = (timing.toolWaitAlerted ?? []).filter((id) => openIds.has(id));
        if (alerted.length !== (timing.toolWaitAlerted ?? []).length) {
            patch.toolWaitAlerted = alerted.length > 0 ? alerted : undefined;
        }
    }
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
            `the harness stops it (reason: deadline).`,
            (current) => current.timing?.deadlineWakeSentAt !== undefined,
            (at) => { patchTiming(meta.id, { deadlineWakeSentAt: at }); });
    }
    for (const wake of actions.toolWaitWakes ?? []) {
        const lastProgressAt = Math.max(progress?.lastProgressAt ?? 0, meta.timing?.lastProgressAt ?? 0) || undefined;
        const content = toolWaitAlertText({
            id: meta.id,
            label: timingLabel(meta),
            callId: wake.callId,
            toolName: wake.name ?? "",
            ...(wake.command !== undefined ? { command: wake.command } : {}),
            openMs: wake.ageMs,
            thresholdMs: meta.timing?.toolWaitMs ?? wake.ageMs,
            now,
            ...(lastProgressAt !== undefined ? { lastProgressAt } : {}),
            logPath: meta.logPath,
        });
        deliverTimingWake(pi, meta, "tool-wait", `tool-wait:${wake.callId}`, content,
            (current) => (current.timing?.toolWaitAlerted ?? []).includes(wake.callId),
            () => {
                const current = readMeta(meta.id);
                const alerted = current?.timing?.toolWaitAlerted ?? [];
                if (!alerted.includes(wake.callId)) {
                    patchTiming(meta.id, { toolWaitAlerted: [...alerted, wake.callId] });
                }
            });
    }
    if (actions.stuckWake) {
        const { anchorAt, ageMs } = actions.stuckWake;
        const lastProgressAt = Math.max(progress?.lastProgressAt ?? 0, meta.timing?.lastProgressAt ?? 0) || undefined;
        deliverTimingWake(pi, meta, "stuck", `stuck:${anchorAt}`,
            stuckAlertText({
                id: meta.id, label: timingLabel(meta), ageMs,
                windowMs: meta.timing?.stuckMs ?? ageMs, now,
                ...(lastProgressAt !== undefined ? { lastProgressAt } : {}),
                logPath: meta.logPath,
            }),
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
        // Interrupted work whose child already exited is finalized from its own
        // coherent log before any other verdict (and before timing can mislabel
        // an already-finished run as stopped) (#625).
        if (meta.status === "running" || meta.status === "orphaned") {
            try {
                if (finalizeInterruptedRunFromLog(pi, meta, now)) continue;
            } catch { /* best-effort; the ordinary reconciliation below still runs */ }
        }
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
    // A restart leaves an explicitly interrupted child whose owning pi is gone
    // (#625). Its record is foreign, so the owner-gated loops above never see it:
    // finalize it from its own coherent log once the child itself is gone. This
    // is the human's own interrupted work, not another session's live run, and
    // `finalizeInterruptedRunFromLog` still requires all process evidence to be
    // absent, so a live writer is never touched.
    for (const summary of listMetas()) {
        if (summary.status !== "running" && summary.status !== "orphaned") continue;
        if (ownedByThisParent(summary) || !ownsInterruptedSupervision(summary)) continue;
        const meta = readMeta(summary.id);
        if (!meta || (meta.status !== "running" && meta.status !== "orphaned")) continue;
        try { finalizeInterruptedRunFromLog(pi, meta, Date.now()); } catch { /* the next tick retries */ }
    }
    // Completed runs can still have failed completion handoffs to retry.
    for (const summary of listMetasForParent(process.pid)) {
        if (!pi || !ownedByThisParent(summary) || summary.status === "running" || summary.status === "orphaned" || summary.status === "lost") continue;
        const meta = readMeta(summary.id);
        if (meta && meta.completionCallbackPendingAt !== undefined && meta.completionCallbackSentAt === undefined && meta.completionCallbackSuppressedAt === undefined) enqueueCompletionCallback(pi!, meta.id);
    }
    pruneProgressCache();
    syncHealthTicker();
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

/** Test seam: drop the in-memory progress fold, as a reloaded extension instance does. */
export function forgetProgressCacheForTests(): void {
    progressCache.clear();
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

/** Completion batches own their retry timer; only supervision keeps this one alive. */
function syncHealthTicker(): void {
    // A replaced instance never restarts supervision loops for a session it no
    // longer owns; the live instance runs its own. It must still STOP one that is
    // already armed: a run this instance launched before teardown can finish
    // afterwards, and returning early here left the interval supervising a
    // session that no longer exists (#625).
    if (sessionTornDown) {
        stopHealthTicker();
        return;
    }
    if (needsMonitoring(listMetasForParent(process.pid)) || needsInterruptedSupervision()) ensureHealthTicker();
    else stopHealthTicker();
}

/** Start the reconciliation loop if it isn't already running. */
function ensureHealthTicker(): void {
    // Not gated on `sessionTornDown`: a spawn always means the current session is
    // doing new work. Only `syncHealthTicker` — the path a late child finalizer
    // takes — stays closed in a replaced instance.
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
//   1. an editor wrapper that intercepts bare ← only when the editor is empty
//      and at least one non-dismissed current-parent run is running,
//      delegating everything else to the wrapped
//      editor (composition via navigator.mjs, tested with fakes);
//   2. a focused overlay (ctx.ui.custom(..., { overlay: true })) listing the
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
    return sessionVisibleNavigatorRuns().filter((m) => ["running", "waiting"].includes(assignmentFor(m, effectiveStatus(m)).state));
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
    const status = assignmentFor(meta, effectiveStatus(meta)).state;
    if (!isTerminalNavigatorStatus(status)) return false;
    const endedAt = meta.endedAt ?? meta.lostAt;
    return typeof endedAt === "number" && now - endedAt >= TERMINAL_NAVIGATOR_RETENTION_MS;
}

function isTerminalNavigatorStatus(status: string): boolean {
    return status !== "running" && status !== "waiting" && status !== "orphaned";
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

/**
 * Set by the active extension instance: cancel a parked assignment's pending
 * wait. Returns false when the run is not parked, so the ordinary stop path runs.
 */
let cancelParkedForUi: ((id: string, reason: string) => Promise<boolean>) | undefined;

/** Shared #44 stop+dismiss path used by navigator Close (#47). */
function navigatorCloseRun(id: string) {
    // A parked attempt's child already exited cleanly, so "close" must cancel the
    // pending automatic resume instead of pretending to stop a live process.
    if (parkedWaitForRun(id) && cancelParkedForUi) {
        void cancelParkedForUi(id, "closed from the navigator; the automatic resume is cancelled")
            .then(() => { dismissRun(id); uiCtx?.ui.notify(`Cancelled the pending wait of ${id}. Writer termination may remain unproven.`, "info"); })
            .catch((error) => uiCtx?.ui.notify(`Cancellation failed for ${id}: ${String(error)}. The wait remains available for inspection and retry.`, "warning"));
        // The synchronous navigator must retain the row until the durable operation settles.
        return { action: "missing", id };
    }
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
    syncHealthTicker();
    // Close stops (or log-finalizes) the run, which is a terminal transition:
    // queue its one completion callback so no terminal state is silent (#624).
    // enqueueCompletionCallback is a no-op for runs that owe no callback.
    if (healthPi) enqueueCompletionCallback(healthPi, id);
    return outcome;
}

function statusTone(status: string): BackgroundWorkRow["statusTone"] {
    switch (status) {
        case "running": return "running";
        case "completed": return "success";
        case "failed":
        case "lost": return "failed";
        case "held":
        case "waiting":
        case "cancelled":
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
            sortStartedAt: metaById.get(row.id)?.startedAt ?? now,
            expiresAt: (() => {
                const meta = metaById.get(row.id);
                const endedAt = meta?.endedAt ?? meta?.lostAt;
                return meta && isTerminalNavigatorStatus(row.status) && typeof endedAt === "number"
                    ? endedAt + TERMINAL_NAVIGATOR_RETENTION_MS
                    : undefined;
            })(),
        };
    });
}

const DELEGATION_BLURB: Record<DelegationMode, string> = {
    manual: "only when you or a workflow asks",
    adaptive: "substantial independent work",
    coordinator: "every role-owned task",
};
let readDelegation = (): { mode: DelegationMode; source: "session" | "config" } => ({ mode: "adaptive", source: "config" });
let cycleDelegation = (): void => {};
let saveDelegationDefault: (mode: DelegationMode) => { ok: boolean; message: string } = () => ({ ok: false, message: "Saving the delegation default is unavailable." });

function mainAgentWorkRow(now: number): BackgroundWorkRow {
    let running = mainAgentStartedAt !== undefined;
    try { running ||= uiCtx?.isIdle() === false; } catch { /* use event state */ }
    const model = shortModel(uiCtx?.model?.id);
    const effort = uiCtx?.thinkingLevel;
    const tool = [...mainAgentTools.values()].at(-1);
    let contextTokens: number | null | undefined;
    try { contextTokens = uiCtx?.getContextUsage()?.tokens; } catch { contextTokens = undefined; }
    const tokens = typeof contextTokens === "number" ? `${fmtTokens(contextTokens)} tok` : undefined;
    const delegation = readDelegation();
    const bits = [
        effort ? `${model} ${effort}` : model,
        tool,
        tokens,
        delegation.source === "session" ? `${delegation.mode} · session` : delegation.mode,
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

function mainAgentWorkDetail(now: number): BackgroundWorkDetail {
    const row = mainAgentWorkRow(now);
    const delegation = readDelegation();
    return {
        providerId: "subagents",
        id: "main",
        title: "main",
        status: row.status,
        statusTone: row.statusTone,
        subtitle: row.primary,
        metadata: [
            { label: "kind", value: "main agent" },
            { label: "model", value: row.effort ? `${row.model} · effort ${row.effort}` : (row.model || "-") },
            { label: "tool", value: row.tool || "-" },
            { label: "context", value: row.tokens || "-" },
            { label: "elapsed", value: row.elapsed },
            { label: "mode", value: `${delegation.mode} · ${delegation.source}` },
        ],
        evidence: {
            label: "delegation",
            text: [
                `${delegation.mode}: ${DELEGATION_BLURB[delegation.mode]}.`,
                "m cycles this session. ctrl+s saves that mode as the next session's default.",
                "x does not stop the main agent.",
            ].filter(Boolean).join(" "),
        },
        footerActions: ["m mode", "ctrl+s save"],
    };
}

function subagentWorkDetail(id: string, now: number, options?: { logTailLines?: number }): BackgroundWorkDetail | null {
    if (id === "main") return mainAgentWorkDetail(now);
    const detail = navigatorDetail(id, now);
    if (!detail) return null;
    void options;
    const transcript = readRunTranscript(id);
    const metadata = [
        { label: "provider", value: "Subagents" },
        { label: "id", value: detail.id },
        ...(detail.role ? [{ label: "role", value: String(detail.role) }] : []),
        { label: "model", value: detail.effort ? `${detail.model} · effort ${detail.effort}` : detail.model },
        ...(detail.assignment ? [
            { label: "revision", value: detail.assignment.revision },
            { label: "reason", value: detail.assignment.reason },
            { label: "process", value: `${detail.assignment.processStatus}; termination ${detail.assignment.termination}` },
            { label: "evidence", value: detail.assignment.evidence.join(", ") },
        ] : []),
        { label: "elapsed", value: detail.elapsed },
        { label: "tools", value: detail.currentTool ? `current ${detail.currentTool}` : (detail.tools || "(none)") },
        { label: "spend", value: detail.spend || "(none)" },
        ...(detail.park ? [
            { label: "wait", value: `${detail.park.waitId} generation ${detail.park.generation}` },
        ] : []),
        { label: "pid", value: detail.pid != null ? String(detail.pid) : "-" },
        { label: "pgid", value: detail.pgid != null ? String(detail.pgid) : "-" },
    ];
    return {
        providerId: "subagents",
        id: detail.id,
        title: detail.name || detail.id,
        status: detail.status,
        statusTone: statusTone(detail.status),
        subtitle: detail.currentTool || undefined,
        metadata,
        evidence: { label: "transcript", text: detail.output || "(no transcript yet)" },
        transcript: transcript.entries,
        transcriptDiagnostic: transcript.diagnostic,
        footerActions: [detail.park ? "x cancel resume" : detail.attemptStatus === "running" || detail.attemptStatus === "orphaned" ? "x stop" : "x dismiss"],
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
        showSection: (rows) => rows.some((row) => row.status === "running" || ["parking", "waiting", "ready", "resuming", "held"].includes(row.status)),
        parentRow: (now) => mainAgentWorkRow(now),
        listRows: (now) => subagentWorkRows(now),
        detail: (id, now, options) => subagentWorkDetail(id, now, options),
        handleDetailInput: (id, data) => {
            if (id !== "main") return false;
            if (data === "m") {
                cycleDelegation();
                return true;
            }
            if (data !== "ctrl+s") return false;
            saveDelegationDefault(readDelegation().mode);
            return true;
        },
        armCloseLabel: (row) => pendingNavigatorPark(readMeta(row.id)) ? "x again to cancel resume" : row.status === "running" || row.status === "orphaned" ? "x again to stop" : "x again to dismiss",
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

function viewWidgetNavSelection(ctx: ExtensionContext, owner?: symbol): void {
    const selected = selectedWidgetNavRun();
    if (!selected) return;
    openNavigator(ctx, selected.id, owner);
}

function stopWidgetNavSelection(ctx: ExtensionContext): void {
    const selected = selectedWidgetNavRun();
    if (!selected) return;
    try { navigatorCloseRun(selected.id); } catch { /* ignore */ }
    updateNavigatorFooter(ctx);
    try { renderWidget(); } catch { /* ignore */ }
}

/** Open the focused navigator overlay. No-op without a UI or visible runs. */
function openNavigator(ctx: ExtensionContext, initialDetailId?: string, owner?: symbol): void {
    void initialDetailId;
    ensureNavigator(ctx, owner);
}

/** Refresh the shared navigator after run changes. */
function updateNavigatorFooter(ctx: ExtensionContext | undefined): void {
    refreshBackgroundWorkNavigator(ctx);
}

/** Install the empty-editor ← wrapper once per UI (reload-safe, composable). */
function ensureNavigator(ctx: ExtensionContext, owner?: symbol): void {
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
        }, owner);
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
function finalizeRun(pi: ExtensionAPI, ctx: ExtensionContext | undefined, id: string, code: number | null): void {
    progressCache.delete(id);
    directlySupervisedRunIds.delete(id);
    // Host-facing wrapper around first-party finalizer (finalization.ts).
    // Coherent child-exit evidence may supersede provisional orphaned/lost
    // reconciliation; finalization.ts enforces canExitFinalize + lifecycle authority.
    finalizeRunCore(id, code, {
        renderWidget,
        notify: (message, level) => {
            try { ctx?.ui.notify(message, level); } catch { /* ignore */ }
        },
        sendMessage: () => enqueueCompletionCallback(pi, id),
    });
    syncHealthTicker();
}

/**
 * Finalize a run whose supervision a previous session interrupted (`/reload`,
 * a session switch, or a quit) once its process evidence is gone (#625).
 *
 * The instance that held the in-memory exit observer is gone, so nothing else
 * reads the child's own log when the process disappears: health reconciliation
 * alone would record an interrupted-but-finished run `lost`, hiding a result
 * that is fully on disk. Only coherent terminal stream evidence is accepted
 * (`agent_end` with every tool call closed); anything else keeps the existing
 * reconciliation verdict, so no failure or completion is manufactured.
 *
 * Runs this instance launched are skipped: their exit observer finalizes them.
 */
function finalizeInterruptedRunFromLog(
    pi: ExtensionAPI | undefined,
    meta: RunMeta,
    now: number,
): boolean {
    if (!pi) return false;
    if (directlySupervisedRunIds.has(meta.id)) return false;
    if (meta.supervisionInterruptedAt === undefined) return false;
    // Process evidence still exists: the child keeps running, nothing to finalize.
    if (reconcileRun(meta, realProcessProbe, now).status !== "lost") return false;
    let run;
    try { run = parseRunForLifecycle(meta.id); } catch { return false; }
    if (!run.sawEnd || run.unmatchedToolCalls.length > 0) return false;
    // Exit code is unknown after the observer is gone; the lifecycle authority
    // classifies from the coherent stream instead of inventing one.
    finalizeRun(pi, uiCtx, meta.id, null);
    return true;
}

/**
 * Does this process have to supervise this explicit interruption record (#625)?
 *
 * A run this parent launched is this session's own (#625 reload). A run left by
 * a parent that is provably gone has no live owner at all — the restart case —
 * so its recorded interruption is the only thing that can recover it. Anything
 * else belongs to a live pi and is never adjudicated here.
 */
function ownsInterruptedSupervision(summary: Pick<RunMeta, "spawnPid" | "spawnPidStartTime" | "supervisionInterruptedAt">): boolean {
    if (summary.supervisionInterruptedAt === undefined) return false;
    return ownedByThisParent(summary) || isAbandonedByParent(summary, realProcessProbe);
}

/** True while an interrupted record still needs this process's supervision loop. */
function needsInterruptedSupervision(): boolean {
    try {
        for (const summary of listMetas()) {
            if (summary.status !== "running" && summary.status !== "orphaned") continue;
            if (ownsInterruptedSupervision(summary)) return true;
        }
    } catch { /* best-effort scheduler gate */ }
    return false;
}

/**
 * Attempt log-evidence finalization for every interrupted run this process has
 * to supervise: its own current-parent ones and the ones a dead parent left
 * behind. Live children are never finalized (`finalizeInterruptedRunFromLog`
 * requires the process evidence to be gone), so this only recovers a child that
 * already finished on its own.
 */
function recoverInterruptedSubagents(pi: ExtensionAPI | undefined): number {
    let recovered = 0;
    const now = Date.now();
    for (const summary of listMetas()) {
        if (summary.status !== "running" && summary.status !== "orphaned") continue;
        if (!ownsInterruptedSupervision(summary)) continue;
        const meta = readMeta(summary.id);
        if (!meta || (meta.status !== "running" && meta.status !== "orphaned")) continue;
        try {
            if (finalizeInterruptedRunFromLog(pi, meta, now)) recovered += 1;
        } catch { /* best-effort at session start; the health ticker retries */ }
    }
    return recovered;
}

/**
 * Re-prove a continuation's native history identity after its writer lease is held.
 *
 * `planContinuation` validated the saved conversation, but it validated a plan:
 * between that read and admission another process's sweep can retire the shared
 * workspace, the saved history, or the prior run record, and Pi's `--session`
 * opens a missing path by creating a fresh conversation — a silent replacement
 * instead of a refusal. Cleanup now takes the same per-conversation lock this
 * admission takes, so re-reading here is reading a conversation nothing else can
 * retire concurrently. Any change since validation refuses; the cached path is
 * never reopened on the strength of the earlier check.
 */
function revalidateContinuationUnderLease(
    plan: ContinuationPlan,
    origin: RunCallbackOrigin | undefined,
): void {
    const current = readMeta(plan.prior.id);
    if (!current) {
        throw new ContinuationError(
            `Cannot continue ${plan.prior.id}: its run record was removed while this launch was being prepared. ` +
            `Its saved history is missing; restore the original history or launch a new run instead.`,
        );
    }
    const fresh = planContinuation({
        id: plan.prior.id,
        prior: current,
        origin,
        others: listMetas(),
    });
    if (fresh.conversation.sessionId !== plan.conversation.sessionId || fresh.conversation.path !== plan.conversation.path) {
        throw new ContinuationError(
            `Cannot continue ${plan.prior.id}: the saved conversation it would reopen changed while this launch was being prepared ` +
            `(${plan.conversation.path} -> ${fresh.conversation.path}). Launch a new run instead.`,
        );
    }
}

/**
 * The removed launch flag, reported by name so an older caller is told what to
 * do instead of having its request silently dropped.
 */
const RETAIN_SESSION_REMOVED =
    "retain_session was removed: every saved conversation persists automatically. " +
    "Omit it, and pass session_id to continue a saved conversation.";

function assertNoRetiredLaunchOptions(value: object | undefined, label = ""): void {
    if (value && (value as { retain_session?: unknown }).retain_session !== undefined) {
        throw new Error(`${label}${RETAIN_SESSION_REMOVED}`);
    }
}

function sameLaunchPath(left: unknown, right: string | undefined): boolean {
    if (typeof left !== "string" || right === undefined) return false;
    if (left === right) return true;
    try { return canonicalizePath(left) === canonicalizePath(right); } catch { return false; }
}

function sameLaunchTools(left: unknown, right: string): boolean {
    return typeof left === "string" && normalizeTools(left) === normalizeTools(right);
}

/**
 * A continuation may repeat its launch's skill exposure, and only that. The
 * saved paths are absolute (frozen at launch), so a caller repeating relative
 * paths is compared against the recipe's own workspace.
 *
 * Discovery and `[]` are different choices and must never compare equal: a
 * recipe with no `skills` key means "the child discovers the user catalog", and
 * an explicit `[]` means "load no skills at all". Treating an absent key as an
 * empty list would accept a continuation that silently disables discovery for a
 * conversation that was launched with it.
 */
function sameLaunchSkills(value: unknown, recipe: ContinuationPlan["recipe"]): boolean {
    let requested: string[] | undefined;
    try {
        requested = normalizeSkillExposure(value, "skills");
    } catch {
        return false;
    }
    if (requested === undefined) return false;
    const saved = recipe.skills;
    if (saved === undefined) return false;
    const resolved = requested.length === 0 ? [] : absolutizeSkillPaths(requested, recipe.cwd);
    return resolved.length === saved.length && resolved.every((path, index) => path === saved[index]);
}

function sameLaunchRoles(left: unknown, right: string | readonly string[] | undefined): boolean {
    if (typeof left === "string") return left === right;
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((value, index) => value === right[index]);
    }
    return false;
}

function continuationLaunchConflicts(
    job: Record<string, unknown>,
    recipe: ContinuationPlan["recipe"],
    options: { includeName: boolean },
): string[] {
    const conflicts: string[] = [];
    const check = (key: string, same: (value: unknown) => boolean) => {
        const value = job[key];
        if (value !== undefined && !same(value)) conflicts.push(key);
    };
    if (options.includeName) check("name", (value) => value === recipe.name);
    check("agent", (value) => value === recipe.agent);
    check("role", (value) => sameLaunchRoles(value, recipe.role));
    check("alias", (value) => value === recipe.alias);
    check("tools", (value) => sameLaunchTools(value, recipe.tools));
    check("exclude_tools", (value) => typeof value === "string" && normalizeTools(value) === normalizeTools(recipe.excludeTools ?? ""));
    check("skills", (value) => sameLaunchSkills(value, recipe));
    check("clean", (value) => value === recipe.clean);
    check("sandbox", (value) => value === recipe.sandbox);
    check("sandbox_dir", (value) => sameLaunchPath(value, recipe.sandboxDir));
    check("cwd", (value) => sameLaunchPath(value, recipe.cwd));
    check("git_clone_workspace", (value) => value === recipe.gitCloneWorkspace);
    check("approve", (value) => value === recipe.approve);
    check("allow_nested", (value) => value === recipe.allowNested);
    return conflicts;
}

/**
 * Refuse any launch-only option that does not reproduce the saved recipe.
 * Matching values are allowed (a caller that repeats its original launch call is
 * provably asking for the same thing); a missing option just keeps the recipe.
 */
function assertContinuationLaunchOptions(
    job: Record<string, unknown>,
    recipe: ContinuationPlan["recipe"],
    label: string,
    options: { includeName: boolean } = { includeName: true },
): void {
    if (job.retain_session !== undefined) throw new ContinuationError(`${label}${RETAIN_SESSION_REMOVED}`);
    const conflicts = continuationLaunchConflicts(job, recipe, options);
    if (conflicts.length === 0) return;
    const named = conflicts.map((key) => `\`${key}\``).join(", ");
    const prefix = label || "Cannot continue this saved conversation: ";
    throw new ContinuationError(
        `${prefix}${named} ${conflicts.length === 1 ? "conflicts" : "conflict"} with the saved launch recipe. ` +
        `A continued conversation keeps the recipe it was launched with; omit ${conflicts.length === 1 ? "it" : "them"}. ` +
        `A continuation accepts prompt, session_id, and optional model, thinking, callback, and timing overrides.`,
    );
}

/**
 * The attempt that currently owns a saved conversation: the LATEST attempt by
 * `startedAt` (then id, so ties stay deterministic). Never pick an older
 * completed sibling: that would branch history from a superseded attempt.
 */
function latestConversationAttempt(sessionId: string, metas: readonly RunMeta[]): RunMeta | undefined {
    let latest: RunMeta | undefined;
    for (const meta of metas) {
        if (meta.sessionId !== sessionId) continue;
        if (!latest || meta.startedAt > latest.startedAt
            || (meta.startedAt === latest.startedAt && meta.id > latest.id)) latest = meta;
    }
    return latest;
}

/**
 * Select a saved conversation by its exact native session id and validate it for
 * one more attempt. `planContinuation` owns the refusals (a running/orphaned
 * latest attempt, missing history or workspace, unsupported recipe), so a
 * missing session is the only error added here. Nothing is ever recreated.
 */
function requestedSessionId(job: { session_id?: string; session_name?: string }, cwd: string): string | undefined {
    if (job.session_id !== undefined && job.session_name !== undefined) {
        throw new Error("Pass either session_id or session_name, not both.");
    }
    if (job.session_name !== undefined) {
        if (typeof job.session_name !== "string") throw new Error("session_name must be a non-empty name.");
        return selectSessionByName(listMetas(), job.session_name, (workspace) => isWithinWorkspace(workspace, cwd));
    }
    return job.session_id;
}

function continuationPlanFor(sessionId: string, origin: RunCallbackOrigin | undefined): ContinuationPlan {
    const others = listMetas();
    const latest = latestConversationAttempt(sessionId, others);
    if (!latest) {
        throw new ContinuationError(
            `Cannot continue session ${sessionId}: no saved subagent conversation has that native session id. ` +
            `Check the session id reported by the launching attempt, or omit session_id to start a new conversation.`,
        );
    }
    return planContinuation({ id: latest.id, prior: latest, origin, others });
}

function timingSchemaFields() {
    return timingParameterSchemas(Type);
}

/** String for one role, or an array when the caller assigns more than one. Arrays reach clarification instead of being rejected. */
function catalogRoleSchema(purpose: string) {
    const one = `One role by short name (developer) for this ${purpose}; role.developer also works, case-insensitive. Mutually exclusive with agent.`;
    const many = `Two or more role names for this ${purpose}. An array is ambiguous and asks to choose one role or split into separate runs. No child launches until that choice is made.`;
    return Type.Optional(Type.Union([
        Type.String({ description: one }),
        Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: many }),
    ], { description: `${one} ${many}` }));
}

/** Loaded Pi skill metadata from the current prompt resources. No model call, no directory scan. */
function discoveredSkillsFromContext(ctx: { getSystemPromptOptions?: () => { skills?: readonly unknown[] } }): DiscoveredSkill[] {
    try {
        const loaded = ctx.getSystemPromptOptions?.().skills ?? [];
        const skills: DiscoveredSkill[] = [];
        for (const raw of loaded) {
            if (!raw || typeof raw !== "object") continue;
            const skill = raw as {
                name?: unknown; description?: unknown; filePath?: unknown; baseDir?: unknown;
                sourceInfo?: { source?: unknown };
            };
            if (typeof skill.name !== "string" || !skill.name || typeof skill.filePath !== "string" || !skill.filePath) continue;
            skills.push({
                name: skill.name,
                description: typeof skill.description === "string" ? skill.description : "",
                path: skill.filePath,
                ...(typeof skill.baseDir === "string" ? { baseDir: skill.baseDir } : {}),
                ...(typeof skill.sourceInfo?.source === "string" ? { source: skill.sourceInfo.source } : {}),
            });
        }
        return skills;
    } catch {
        return [];
    }
}

export default function (pi: ExtensionAPI) {
    // A standalone Subagents install has no Harness extension, so the parent
    // session applies the same linked-worktree project boundary as its children.
    pi.on("before_agent_start", (event) => {
        restrictContextFilesToWorktree(event.systemPromptOptions, PiCodingAgent.getAgentDir());
    });
    initializeNavigatorPanels(pi);
    // Each cached factory instance owns the navigator it installs (#460).
    const navigatorOwner = Symbol("subagents navigator factory");
    const agentSessionSettings = createAgentSessionSettings(pi);
    let catalogModelRegistry: ExtensionContext["modelRegistry"] | undefined;
    let delegationOverride: DelegationMode | undefined;
    let capOverride: number | undefined;
    let timingOverride: { maxMinutes?: number; toolWaitMinutes?: number; stuckMinutes?: number } = {};
    interface SkillSelection { mode: SkillExposureMode; paths: string[] }
    let skillsOverride: SkillSelection | undefined;
    const savedSkills = (): SkillSelection & { source: "config" | "default"; error?: string } => {
        try {
            return configuredSkillExposure(loadConfig().defaultSkills);
        } catch (error) {
            return {
                mode: "inherit", paths: [], source: "config",
                error: error instanceof Error ? error.message : String(error),
            };
        }
    };
    const activeSkills = (): SkillSelection & { source: "session" | "config" | "default"; error?: string } => {
        if (skillsOverride) return { ...skillsOverride, source: "session" };
        return savedSkills();
    };
    /** The same active default a launch sees, shaped for catalog inspection. */
    const readSkillDefaults = () => {
        const skills = activeSkills();
        const value = skills.mode === "inherit" ? undefined : [...skills.paths];
        const error = skills.error ?? (skills.mode === "explicit" && skills.paths.length === 0
            ? "Selected skills has no paths. Add at least one skill path or choose No skill catalog."
            : undefined);
        return { value, source: skills.source, ...(error ? { error } : {}) };
    };
    const changeSkills = (mode: SkillExposureMode, paths: readonly string[]): void => {
        if (mode !== "explicit" && paths.length > 0) throw new Error("Only Selected skills carries a path list.");
        if (mode === "explicit" && paths.some((path) => !isAbsolute(path))) {
            throw new Error("Enter absolute skill paths so every child resolves the same files.");
        }
        const next = { mode, paths: [...paths] };
        skillsOverride = next;
        pi.appendEntry("pi-better-subagents-skills", { version: 1, ...next });
    };
    /** The current-session choice, with `{}` preserving explicit discovery. */
    const sessionSkillChoice = (): { value?: unknown } | undefined => {
        if (!skillsOverride) return undefined;
        if (skillsOverride.mode === "explicit" && skillsOverride.paths.length === 0) {
            throw new Error("Selected skills has no paths. Add at least one skill path or choose No skill catalog before launching.");
        }
        if (skillsOverride.mode === "inherit") return {};
        return { value: skillsOverride.mode === "none" ? [] : [...skillsOverride.paths] };
    };
    const activeConcurrencyCap = (): number => capOverride ?? normalizeConcurrencyCap(loadConfig().maxConcurrent);
    const timingSettingsFor = (cfg = loadConfig()): TimingSettings => ({ ...cfg, ...timingOverride });
    /** A per-run max_minutes wins; otherwise a session timeout choice beats the environment. */
    const launchTimingParams = (params: TimingParams = {}): TimingParams => ({
        ...params,
        max_minutes: params.max_minutes ?? timingOverride.maxMinutes,
    });
    interface TimingMinutesState {
        maxMinutes: number;
        toolWaitMinutes: number;
        stuckMinutes: number;
        timeoutSource: "environment" | "session" | "config" | "default";
        toolWaitSource: "environment" | "session" | "config" | "default";
        stuckSource: "environment" | "session" | "config" | "default";
        defaultMaxMinutes: number;
        defaultToolWaitMinutes: number;
        defaultStuckMinutes: number;
        timingError?: string;
    }
    const timingState = (): TimingMinutesState => {
        const cfg = loadConfig();
        const envFor = (key: "toolWaitMinutes" | "stuckMinutes"): string | undefined => {
            const raw = key === "toolWaitMinutes" ? process.env[TIMING_ENV.toolWait] : process.env[TIMING_ENV.stuck];
            return raw !== undefined && raw.trim() !== "" ? raw : undefined;
        };
        const sourceFor = (key: "toolWaitMinutes" | "stuckMinutes"): "environment" | "session" | "config" | "default" =>
            envFor(key) !== undefined ? "environment"
                : timingOverride[key] !== undefined ? "session"
                    : cfg[key] !== undefined && cfg[key] !== null ? "config" : "default";
        const timeoutEnv = process.env[TIMING_ENV.max];
        const timeoutSource = (): "environment" | "session" | "config" | "default" =>
            timingOverride.maxMinutes !== undefined ? "session"
                : timeoutEnv !== undefined && timeoutEnv.trim() !== "" ? "environment"
                    : cfg.maxMinutes !== undefined && cfg.maxMinutes !== null ? "config" : "default";
        try {
            const sessionTimeout = timingOverride.maxMinutes !== undefined ? { max_minutes: timingOverride.maxMinutes } : {};
            const effective = resolveRunTiming({ params: sessionTimeout, settings: timingSettingsFor(cfg), env: process.env, startedAt: 0 });
            const defaults = resolveRunTiming({ settings: cfg, env: process.env, startedAt: 0 });
            const minutes = (ms: number | undefined): number => ms === undefined ? 0 : ms / 60_000;
            return {
                maxMinutes: minutes(effective.ceilingAt),
                toolWaitMinutes: minutes(effective.toolWaitMs),
                stuckMinutes: minutes(effective.stuckMs),
                timeoutSource: timeoutSource(),
                toolWaitSource: sourceFor("toolWaitMinutes"),
                stuckSource: sourceFor("stuckMinutes"),
                defaultMaxMinutes: minutes(defaults.ceilingAt),
                defaultToolWaitMinutes: minutes(defaults.toolWaitMs),
                defaultStuckMinutes: minutes(defaults.stuckMs),
            };
        } catch (error) {
            return {
                maxMinutes: DEFAULT_TIMING_MINUTES.max,
                toolWaitMinutes: DEFAULT_TIMING_MINUTES.toolWait,
                stuckMinutes: DEFAULT_TIMING_MINUTES.stuck,
                timeoutSource: timeoutSource(),
                toolWaitSource: sourceFor("toolWaitMinutes"),
                stuckSource: sourceFor("stuckMinutes"),
                defaultMaxMinutes: DEFAULT_TIMING_MINUTES.max,
                defaultToolWaitMinutes: DEFAULT_TIMING_MINUTES.toolWait,
                defaultStuckMinutes: DEFAULT_TIMING_MINUTES.stuck,
                timingError: error instanceof Error ? error.message : String(error),
            };
        }
    };
    const changeCap = (cap: number): void => {
        if (!isConcurrencyCap(cap)) throw new Error("Concurrent subagents must be a positive whole number.");
        capOverride = cap;
        pi.appendEntry("pi-better-subagents-cap", { version: 1, maxConcurrent: cap });
    };
    const changeTiming = (key: "maxMinutes" | "toolWaitMinutes" | "stuckMinutes", minutes: number): void => {
        const value = validatedTimingMinutes(minutes, key);
        timingOverride = { ...timingOverride, [key]: value };
        pi.appendEntry("pi-better-subagents-timing", { version: 1, ...timingOverride });
    };
    const changeMode = (mode: DelegationMode): void => {
        delegationOverride = mode;
        pi.appendEntry("pi-better-subagents-delegation", { version: 1, mode });
    };
    const resetSettings = (): void => {
        capOverride = undefined;
        delegationOverride = undefined;
        timingOverride = {};
        skillsOverride = undefined;
        pi.appendEntry("pi-better-subagents-cap", { version: 1, maxConcurrent: null });
        pi.appendEntry("pi-better-subagents-delegation", { version: 1, mode: null });
        pi.appendEntry("pi-better-subagents-timing", { version: 1, maxMinutes: null, toolWaitMinutes: null, stuckMinutes: null });
        pi.appendEntry("pi-better-subagents-skills", { version: 1, mode: null });
    };
    const activeDelegationMode = (): DelegationMode => delegationOverride ?? normalizeDelegationMode(loadConfig().delegationMode);
    const countRunning = () =>
        listActiveMetasForParent(process.pid).filter((meta) => effectiveStatus(meta) === "running").length;
    // Supervised worker operations: the Background observed-waits service owns
    // durable records, this extension owns the trusted transport its children
    // talk to. Both are absent in a standalone Subagents install, which is why
    // the bridge is optional and parking refuses instead of pretending.
    const workerOperations: WorkerOperationsHost = createWorkerOperationsHost({
        pi,
        childExtensionPath: childBridgeExtensionPath(selfDir()),
    });
    let resumeOrchestration: ResumeOrchestration | undefined;
    const notifyOwnedWait = (message: string, level: "warning" | "info" = "warning") => {
        try { uiCtx?.ui?.notify?.(message, level); } catch { /* no UI */ }
    };
    /**
     * Stop a continuation attempt only when this parent owns it and the token
     * published with it matches. A pid is never signalled on a guess.
     */
    const stopPublishedAttempt = createOwnedAttemptStopper();
    cancelParkedForUi = async (id, reason) => {
        const parked = parkedWaitForRun(id);
        if (!parked) return false;
        try {
            await cancelParkedWait(workerOperations.service, parked, reason, { stopAttempt: stopPublishedAttempt });
            if (parked.meta.assignment) enqueueCompletionCallback(pi, id);
        } finally { syncHealthTicker(); }
        return true;
    };
    const effectiveSettings = () => {
        const timing = timingState();
        return effectiveSubagentSettings({
            delegationMode: activeDelegationMode(), maxConcurrent: activeConcurrencyCap(),
            sources: { delegationMode: delegationOverride ? "session" : "config",
                maxConcurrent: capOverride !== undefined ? "session" : "config" },
            timing: {
                toolWaitMinutes: timing.toolWaitMinutes, stuckMinutes: timing.stuckMinutes,
                sources: { toolWaitMinutes: timing.toolWaitSource, stuckMinutes: timing.stuckSource },
                ...(timing.timingError ? { error: timing.timingError } : {}),
            },
        }, countRunning(), getSharedCapacityGate(countRunning).pending);
    };
    const saveSettings = (): { ok: boolean; message: string } => {
        try {
            const skills = activeSkills();
            if (!skillsOverride && skills.error) {
                return {
                    ok: false,
                    message: `Cannot save subagent defaults: the saved defaultSkills value is invalid (${skills.error}). ` +
                        `Choose a skill mode in this session to replace it, or fix the saved config first.`,
                };
            }
            if (skills.mode === "explicit" && skills.paths.length === 0) {
                return { ok: false, message: "Add at least one skill path, or choose No skill catalog to load none." };
            }
            // Saving mode and cap must not write a skill key into a config that
            // never had one. Discovery only replaces a saved choice when a saved
            // skill value already exists.
            const cfg = loadConfig();
            const savedSkillValue = cfg.defaultSkills;
            const hasSavedSkillChoice = savedSkillValue !== undefined && savedSkillValue !== null;
            // Like skills, only save a timing key this session overrides or the
            // config already carries; built-in defaults need no stored copy.
            const savedTiming: { maxMinutes?: number; toolWaitMinutes?: number; stuckMinutes?: number } = {};
            if (timingOverride.maxMinutes !== undefined) {
                savedTiming.maxMinutes = timingOverride.maxMinutes;
            } else if (isTimingMinutes(cfg.maxMinutes)) {
                savedTiming.maxMinutes = cfg.maxMinutes;
            }
            if (timingOverride.toolWaitMinutes !== undefined) {
                savedTiming.toolWaitMinutes = timingOverride.toolWaitMinutes;
            } else if (isTimingMinutes(cfg.toolWaitMinutes)) {
                savedTiming.toolWaitMinutes = cfg.toolWaitMinutes;
            }
            if (timingOverride.stuckMinutes !== undefined) {
                savedTiming.stuckMinutes = timingOverride.stuckMinutes;
            } else if (isTimingMinutes(cfg.stuckMinutes)) {
                savedTiming.stuckMinutes = cfg.stuckMinutes;
            }
            writeSubagentSettings({
                delegationMode: activeDelegationMode(),
                maxConcurrent: activeConcurrencyCap(),
                ...savedTiming,
                ...(skills.mode === "inherit" && !hasSavedSkillChoice ? {} : {
                    // null is an explicit discovery choice; it must override a saved path list.
                    defaultSkills: skills.mode === "inherit" ? null : [...skills.paths],
                }),
            });
            resetSettings();
            return { ok: true, message: "Subagent defaults saved." };
        } catch (error) {
            return { ok: false, message: `Could not save subagent defaults: ${error instanceof Error ? error.message : String(error)}` };
        }
    };
    readDelegation = () => ({
        mode: activeDelegationMode(),
        source: delegationOverride ? "session" : "config",
    });
    cycleDelegation = () => {
        const current = activeDelegationMode();
        const next = DELEGATION_MODES[(DELEGATION_MODES.indexOf(current) + 1) % DELEGATION_MODES.length]!;
        changeMode(next);
    };
    saveDelegationDefault = (mode) => {
        try {
            writeDelegationMode(mode);
        } catch (error) {
            return { ok: false, message: `Could not save the delegation default: ${error instanceof Error ? error.message : String(error)}` };
        }
        delegationOverride = undefined;
        pi.appendEntry("pi-better-subagents-delegation", { version: 1, mode: null });
        return { ok: true, message: `Delegation default saved: ${mode}.` };
    };
    const restoreDelegationMode = (ctx: ExtensionContext): void => {
        delegationOverride = undefined;
        capOverride = undefined;
        timingOverride = {};
        skillsOverride = undefined;
        const branch = ctx.sessionManager?.getBranch?.();
        if (!Array.isArray(branch)) return;
        for (const entry of branch) {
            if (entry.type === "custom" && entry.customType === "pi-better-subagents-timeout") {
                const data = entry.data as { version?: unknown; maxMinutes?: unknown } | null;
                if (data?.version === 1) {
                    const next = { ...timingOverride };
                    if (data.maxMinutes === null) delete next.maxMinutes;
                    else if (isTimingMinutes(data.maxMinutes)) next.maxMinutes = data.maxMinutes;
                    timingOverride = next;
                }
                continue;
            }
            if (entry.type === "custom" && entry.customType === "pi-better-subagents-cap") {
                const data = entry.data as { version?: unknown; maxConcurrent?: unknown } | null;
                if (data?.version === 1) {
                    if (data.maxConcurrent === null) capOverride = undefined;
                    else if (isConcurrencyCap(data.maxConcurrent)) capOverride = data.maxConcurrent;
                }
            }
            if (entry.type === "custom" && entry.customType === "pi-better-subagents-skills") {
                const data = entry.data as { version?: unknown; mode?: unknown; paths?: unknown } | null;
                if (data?.version !== 1) continue;
                if (data.mode === null) {
                    skillsOverride = undefined;
                } else if ((data.mode === "inherit" || data.mode === "none") && Array.isArray(data.paths) && data.paths.length === 0) {
                    skillsOverride = { mode: data.mode, paths: [] };
                } else if (data.mode === "explicit" && Array.isArray(data.paths)
                    && data.paths.every((path): path is string => typeof path === "string" && isAbsolute(path))) {
                    skillsOverride = { mode: "explicit", paths: [...data.paths] };
                }
                continue;
            }
            if (entry.type === "custom" && entry.customType === "pi-better-subagents-timing") {
                const data = entry.data as {
                    version?: unknown; maxMinutes?: unknown; toolWaitMinutes?: unknown; stuckMinutes?: unknown;
                } | null;
                if (data?.version !== 1) continue;
                const next: { maxMinutes?: number; toolWaitMinutes?: number; stuckMinutes?: number } = {};
                if (isTimingMinutes(data.maxMinutes)) next.maxMinutes = data.maxMinutes;
                if (isTimingMinutes(data.toolWaitMinutes)) next.toolWaitMinutes = data.toolWaitMinutes;
                if (isTimingMinutes(data.stuckMinutes)) next.stuckMinutes = data.stuckMinutes;
                timingOverride = next;
                continue;
            }
            if (entry.type !== "custom" || entry.customType !== "pi-better-subagents-delegation") continue;
            const data = entry.data as { version?: unknown; mode?: unknown } | null;
            if (data?.version !== 1) continue;
            if (data.mode === null) delegationOverride = undefined;
            else if (isDelegationMode(data.mode)) delegationOverride = data.mode;
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
    // Record admission identities during registration: inventory actions are not
    // available while extensions load. A later replacement must fail the identity check.
    const registeredSpawnSchemas = new Map<string, object>();
    const registerSpawnTool: ExtensionAPI["registerTool"] = (definition) => {
        registeredSpawnSchemas.set(definition.name, definition.parameters);
        pi.registerTool(definition);
    };
    announceExecutionAdapter(pi, {
        parametersFor: (name) => registeredSpawnSchemas.get(name),
        runApplication: (TASK_BUILTINS as readonly string[]).includes(RUN_APPLICATION),
    });
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
        if (typeof ctx.sessionManager?.getBranch === "function") agentSessionSettings.restore(ctx);
        catalogModelRegistry = ctx.modelRegistry;
        const cfg = loadConfig();
        return {
            sessionSettings: agentSessionSettings.snapshot(),
            getSessionSettings: () => agentSessionSettings.snapshot(),
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
        /** Skill exposure for this launch; omit to inherit catalog/config/discovery. */
        skills?: readonly string[];
        sandbox_dir?: string; callback?: boolean; cwd?: string;
        git_clone_workspace?: boolean; approve?: boolean; allow_nested?: boolean;
        agent?: string; role?: string | readonly string[]; alias?: string;
        catalog?: CatalogRunRecord; catalogResolved?: boolean;
        /**
         * Native session id of a saved conversation to continue. Omit for a
         * brand-new conversation; an attempt's own id is its session id only on
         * a fresh launch, so follow-ups use the session id the launch reported.
         */
        session_id?: string;
        session_name?: string;
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
        resume?: ContinuationPlan,
        /**
         * Internal resume identity. Never a tool parameter: an auto-resume
         * publishes its attempt id and launch token in the coordinator before
         * this call, and a manual continuation passes neither.
         */
        internal?: {
            assignedRunId?: string;
            launchToken?: string;
            /** Present for an automatic resume: it may continue a conversation whose wait is still pending. */
            resumeWait?: { waitId: string; generation: number };
            /**
             * The owner binding captured when the worker parked. A resumed attempt
             * must register its operation bridge and record meta.operations under
             * THIS parent workspace/session/branch/Goal: a parent model turn appends
             * branch entries while the continuation is being admitted, and the wait's
             * exact-revision reads and acknowledgement are checked against the
             * captured owner, not the current one.
             */
            parkOwner?: WaitOwnerBinding;
            /**
             * Final dispatch fence: runs after every async preparation and
             * immediately before the child is released. Throwing proves no child
             * was started.
             */
            beforeSpawn?: (context: {
                runId: string;
                permissionPlan: ReturnType<typeof resolveSubagentPermissions>;
            }) => Promise<void | (() => void)> | void | (() => void);
            /** Called once a child process exists, so an ambiguous failure is never retried. */
            onSpawned?: () => void;
        },
    ): Promise<{
        id: string;
        meta: RunMeta;
        spawned: SpawnResult;
        runtime: string;
        warn: string;
        sandboxDir?: string;
        /** Set only when a catalog run's model or effort differs from its role or agent default. */
        modelNote?: string;
    }> {
        assertThinkingLevel(p.thinking);
        // Skill exposure is a caller choice, not a launch: validate its shape
        // before any attempt directory or capacity effect exists. A continuation
        // validates too, so a malformed repeat is a shape error rather than being
        // reported as a recipe conflict.
        normalizeSkillExposure(p.skills, "skills");
        // A conversation parked on an observed wait resumes through the
        // coordinator's claim. An ordinary manual continuation would leave that
        // automatic resume armed for the same assignment, so it is refused until
        // the human takes the parked attempt over (subagent_stop cancels the wait).
        if (resume && !internal?.resumeWait) {
            const parked = parkedWaitForRun(resume.prior.id);
            if (parked) throw new ContinuationError(manualResumeRefusal(parked));
        }
        // A continuation re-applies the CURRENT mandatory human permissions to its
        // frozen confinement intent. Historical metadata can never widen authority,
        // and a profile that would change confinement refuses instead of silently
        // moving a live conversation into a different sandbox.
        const permissionPlan = resolveSubagentPermissions(pi, resume ? resume.recipe.sandbox : p.sandbox);
        if (resume && permissionPlan.sandboxEnabled !== resume.recipe.sandbox) {
            throw new ContinuationError(
                `Cannot continue ${resume.prior.id}: current sandbox permissions would change its confinement. ` +
                `Launch a new run instead of continuing this conversation.`,
            );
        }
        const cfg = loadConfig();
        // Harness-owned timing (soft deadline, ceiling, tool-wait and stuck windows); validated before any side effect.
        resolveRunTiming({ params: launchTimingParams(p), settings: timingSettingsFor(cfg), env: process.env, startedAt: 0 });
        let model: string | undefined;
        let thinking: ThinkingLevel | undefined;
        if (resume) {
            // Preserve the recipe's effective model and effort. Only an explicit
            // per-attempt model/effort acts as an escalation; a bare foreground or
            // configured default must not silently replace the owner's choice.
            assertThinkingLevel(resume.recipe.effort, "saved effort");
            const baseModel = parseModelThinking(resume.recipe.model, resume.recipe.effort);
            if (p.model !== undefined) {
                const explicit = parseModelThinking(p.model, p.thinking ?? baseModel.thinking);
                model = explicit.model;
                thinking = explicit.thinking;
            } else {
                model = baseModel.model;
                thinking = p.thinking ?? baseModel.thinking;
            }
        } else if (p.catalogResolved === true) {
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
        // Resume has already validated this history. Retiring it here would let
        // native --session create an empty replacement before the child runs.
        if (!resume) runDailyCleanupOnce({ config: cfg });
        // Age retires history; this bounds the peak one busy day can reach.
        // Rate-limited inside cleanup.ts, and never on the UI hot path.
        const capped = resume ? { removed: [] } : enforceRegistrySizeCapOnce({ config: cfg });
        for (const id of capped.removed) {
            spendCache.delete(id);
            healthLogCache.delete(id);
            resetChildEventLogCursor(id);
            resetParseRunCursor(id);
        }
        const callbackOrigin = internal?.parkOwner
            ? { cwd: internal.parkOwner.workspace, sessionId: internal.parkOwner.sessionId }
            : callbackOriginFromContext(ctx);
        activeCallbackOrigin = callbackOriginFromContext(ctx);

        // Sandbox is opt-in. sandbox_dir moves the confinement + working
        // dir elsewhere. git_clone_workspace prepares a disposable clone with
        // .git/ inside the writable root for Git-mutating sandboxed subagents.
        const sandboxEnabled = permissionPlan.sandboxEnabled;

        // An auto-resume carries the attempt id the coordinator already published;
        // a fresh or manual launch allocates a new one.
        const id = internal?.assignedRunId ?? nextRunId();
        // Attempt identity (`id`) and conversation identity (`sessionId`) are
        // separate. A continuation keeps the native session; only the attempt is new.
        const sessionId = resume ? resume.conversation.sessionId : id;
        const rootRunId = resume ? resume.rootRunId : id;
        const childSessionDir = resume
            ? resume.recipe.sessionDir
            : sandboxEnabled ? join(sessionsDir(), id) : sessionsDir();
        // The disposable clone this launch owns (removed if the spawn fails); a caller's sandbox_dir is not ours.
        // A continuation never prepares another clone: the recipe's workspace already
        // holds the prior attempt's uncommitted work.
        const ownedCloneWorkspace = !resume && !p.sandbox_dir && sandboxEnabled && p.git_clone_workspace ? taskWorkspaceDir(id) : undefined;
        // A launch attempt only becomes a run when `writeMeta` commits. Until
        // then everything it creates (prompt, control/, provenance, its own
        // session dir, clone workspace, task scratch) belongs to the attempt and
        // must go if it fails, so no unreadable record is left in the registry
        // (#325, #332, #623).
        let lease: ConversationLease | undefined;
        let spawned: ReturnType<typeof spawnDetached> | undefined;
        let launchScratch: string | undefined;
        let committed = false;
        try {
            if (!resume) mkdirSync(childSessionDir, { recursive: true });
            mkdirSync(runDir(id), { recursive: true });
            // Claim the directory before anything else is prepared. Until
            // `meta.json` exists this claim is the only ownership evidence, so a
            // concurrent purge can tell this live attempt from dead launch debris
            // (#623 R1). The outer catch drops the whole directory on failure.
            recordLaunchAttempt(id);

            const workspace = resume
                ? { cwd: resume.recipe.cwd, requestedSandboxDir: resume.recipe.sandboxDir }
                : resolveSubagentWorkspace({
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

            // Skill exposure is decided once per attempt. A continuation replays the
            // frozen recipe (including its absence, which keeps discovery); a fresh
            // launch resolves launch option → catalog role/agent → this session's
            // default → saved config default → discovery. Relative paths belong to
            // the workspace the child runs in.
            const sessionSkills = resume ? undefined : sessionSkillChoice();
            if (!resume && !sessionSkills) {
                const saved = savedSkills();
                if (saved.error) {
                    throw new Error(`Cannot read config defaultSkills: ${saved.error}`);
                }
            }
            const skills = resolveSkillExposure(resume
                ? { saved: { paths: resume.recipe.skills }, cwd }
                : {
                    requested: p.skills,
                    catalog: p.catalog?.effective?.skills?.value,
                    session: sessionSkills,
                    configured: cfg.defaultSkills,
                    cwd,
                });

            if (requestedSandboxDir) mkdirSync(requestedSandboxDir, { recursive: true });
            writeFileSync(promptPathFor(id), p.prompt);

            // A continuation keeps the recipe's launch intent; only current
            // permission-driven adjustments are re-derived from it.
            const requestedTools = resume ? resume.recipe.tools : p.tools;
            const requestedExcludeTools = resume ? resume.recipe.excludeTools ?? "" : p.exclude_tools ?? "";
            const clean = resume ? resume.recipe.clean : p.clean === true;
            const allowNested = resume ? resume.recipe.allowNested : p.allow_nested === true;
            const approve = resume ? resume.recipe.approve : p.approve === true;
            const gitCloneWorkspace = resume ? resume.recipe.gitCloneWorkspace : p.git_clone_workspace === true;
            const callbackEnabled = resume ? p.callback ?? resume.recipe.callback : p.callback !== false;
            const launchName = resume ? resume.recipe.name : p.name;
            // The frozen launch snapshot is the same shape a fresh spawn freezes.
            const launchCatalog: RunMeta["catalog"] = resume
                ? resume.recipe.catalog
                : p.catalog as unknown as RunMeta["catalog"] | undefined;

            let allow = normalizeTools(
                requestedTools ?? cfg.defaultTools ?? (clean ? SAFE_CLEAN_TOOLS : SAFE_DEFAULT_TOOLS),
            );
            if (allowNested) {
                const have = new Set(allow.split(","));
                allow = [...allow.split(","), ...SUBAGENT_TOOLS.filter((t) => !have.has(t))]
                    .filter(Boolean).join(",");
            }

            // A confined child gets extension tools only through /sandbox Subagents · Tools (ADR 0009):
            // the guarded apply_patch adapter, and trusted tools admitted by name and package.
            const requestedExcludes = new Set(requestedExcludeTools.split(",").map((t) => t.trim()).filter(Boolean));

            // Supervised worker operations. This only decides which names the
            // child's loadout carries: clean children, explicit tool lists,
            // exclusions and task-sandboxed children keep their restrictions, and
            // the Background host still intersects the captured task authority
            // with the current profile before any task launches.
            // Production schemas come from the parent Background extension's own
            // tool registrations; a bridge tool without one is withheld instead of
            // being advertised with a permissive fallback schema.
            const productionBridgeSchemas = resolveProductionSchemas(pi, DEFAULT_WORKER_BRIDGE_TOOLS);
            const bridgePlan = planWorkerBridgeTools({
                allow: allow.split(",").filter(Boolean),
                excluded: [...requestedExcludes],
                clean,
                explicitTools: requestedTools !== undefined,
                productionSchemas: new Set(productionBridgeSchemas.schemas.keys()),
            });
            const bridgeEnabled = workerOperations.available && bridgePlan.tools.length > 0;
            if (bridgeEnabled) {
                allow = [...new Set([...allow.split(",").filter(Boolean), ...bridgePlan.tools])].join(",");
            }

            if (sandboxEnabled && !clean) {
                const names = allow.split(",").filter(Boolean);
                // Models reach for apply_patch whenever they may edit; ticked trusted tools join the default set.
                if (permissionPlan.tools.applyPatch && names.some((name) => name === "edit" || name === "write")) names.push(APPLY_PATCH);
                if (requestedTools === undefined) names.push(...permissionPlan.tools.trusted.map((entry) => entry.name));
                allow = [...new Set(names)].join(",");
            }
            if (sandboxEnabled && requestedTools === undefined && permissionPlan.permissions?.processAccess === "read") {
                allow = [...new Set([...allow.split(","), "process_list"])].join(",");
            }
            // Shell Off confines the child to directly launched applications: a requested bash
            // becomes the guarded run_application builtin. Exclusions stay exclusions (an excluded
            // run_application leaves bash out rather than restoring it), and a read-only loadout
            // keeps no command capability at all.
            const commandSettings = resolveCommandSettings(permissionPlan.permissions);
            if (sandboxEnabled && !commandSettings.shell) {
                allow = applyDirectApplicationLoadout(allow.split(",").filter(Boolean), {
                    shell: false, excluded: requestedExcludes,
                }).tools.join(",");
            }
            const bridgeToolNames = new Set<string>(bridgeEnabled ? bridgePlan.tools : []);
            // A bridge tool the supervisor withholds (no production schema, clean,
            // excluded) explains itself better than extension admission would.
            const withheldBridgeReasons = new Map<string, string>(bridgePlan.withheld.map((tool) => [tool.name, tool.reason]));
            // Candidates for the task-tool plan: exclusions and bridge-supplied
            // names never reach extension admission.
            const plannedTools = allow.split(",").filter((name) => name && !requestedExcludes.has(name) && !bridgeToolNames.has(name));
            const taskTools = sandboxEnabled ? planTaskTools({
                requested: plannedTools,
                settings: permissionPlan.tools, network: permissionPlan.permissions?.network ?? true,
                processAccess: permissionPlan.permissions?.processAccess ?? "off",
                builtins: [...TASK_BUILTINS, "codemode"], registered: pi.getAllTools?.() ?? [],
                toolExtensions: cfg.toolExtensions, resolvePath: resolveExtensionPath,
            }) : undefined;
            // One effective selection feeds the task policy, child preflight, worker
            // bridge and frozen recipe, so a refused tool cannot leak into any of them
            // (#669). A name this attempt requires - the caller's explicit `tools`, or a
            // continuation's frozen loadout - refuses the launch instead of narrowing it;
            // an inherited default is dropped from the child with the reason.
            const requiredToolNames = new Set(requestedTools === undefined
                ? []
                : requestedTools.split(",").map((name) => name.trim()).filter(Boolean));
            const toolSelection = taskTools
                ? selectEffectiveTaskTools({
                    tools: allow.split(",").filter(Boolean), plan: taskTools, required: requiredToolNames,
                })
                : undefined;
            if (toolSelection?.required.length) {
                const detail = toolSelection.required
                    .map((tool) => `${tool.name} (${withheldBridgeReasons.get(tool.name) ?? tool.reason})`).join(", ");
                throw resume
                    ? new ContinuationError(
                        `Cannot continue ${resume.prior.id}: its frozen launch requires tool(s) this parent can no longer provide: ${detail}. ` +
                        `Launch a new run instead of continuing this conversation.`,
                    )
                    : new Error(
                        `Requested tool(s) are not available in the task sandbox: ${detail}. ` +
                        `Remove them from the tools list, or make them available in /sandbox (Subagents · Tools); nothing was launched.`,
                    );
            }
            if (toolSelection) {
                if (plannedTools.length > 0 && toolSelection.tools.length === 0) {
                    throw new Error(`No requested tool has a verified task sandbox adapter: ${toolSelection.refused.map((tool) => `${tool.name} (${withheldBridgeReasons.get(tool.name) ?? tool.reason})`).join(", ")}.`);
                }
                allow = toolSelection.tools.join(",");
            }
            const dependencyOptions = {
                model, virtual: (() => {
                    const slash = model?.indexOf("/") ?? -1;
                    return slash > 0 && ctx.modelRegistry?.find?.(model!.slice(0, slash), model!.slice(slash + 1))?.api === "pi-virtual";
                })(), config: cfg, resolvePath: resolveExtensionPath,
                configPaths: [configPath(), join(selfDir(), "config.json")],
            };
            // Bridge tools are supplied by the worker bridge extension, not by a
            // configured toolExtensions mapping: keep them out of extension
            // resolution so `unmapped` stays an accurate operator warning and the
            // frozen launch recipe never depends on bridge availability.
            const extensionAllowlist = () => (bridgeEnabled
                ? allow.split(",").filter((name) => !(bridgePlan.tools as readonly string[]).includes(name)).join(",")
                : allow);
            const { resolution, fullResolution } = await resolveChildLaunch({ ...dependencyOptions, resolution: resolveExtensions({
                // Only SDK builtins reach `--tools` and extension resolution: process_list and run_application
                // are task builtins that the mandatory guard installs and activates itself.
                tools: sandboxEnabled ? allow.split(",").filter((name) => (SDK_BUILTIN_TOOLS as readonly string[]).includes(name)).join(",") : extensionAllowlist(),
                model, clean, allowNested: sandboxEnabled ? false : allowNested, config: cfg,
            }) }, taskTools?.trusted.map(tool => tool.loadPath) ?? []);
            const { args: resolvedExtArgs, missing } = extensionArgs(resolution, (spec) => resolution.paths[spec] ?? resolveExtensionPath(spec));
            const trustedExtArgs = fullResolution.specs.map(spec => fullResolution.paths[spec])
                .filter(path => !resolvedExtArgs.includes(path)).flatMap(path => ["--extension", path]);
            // Harness child controls ride along in every mode, including clean and unsandboxed runs.
            // They deliver deadline steers and keep external monitoring with the coordinator.
            const codemodeArgs = !sandboxEnabled && allow.split(",").includes("codemode") && !requestedExcludes.has("codemode")
                ? ["--extension", join(selfDir(), "child-codemode.ts")] : [];
            const extArgs = [...resolvedExtArgs, ...trustedExtArgs, ...codemodeArgs,
                "--extension", childSteerExtensionPath(), "--extension", join(selfDir(), "child-ownership.ts")]
                .map((value, index, all) => sandboxEnabled && all[index - 1] === "--extension" ? canonicalizePath(value) : value);
            const baseExtensionArgs = [...resolvedExtArgs, ...codemodeArgs,
                "--extension", childSteerExtensionPath(), "--extension", join(selfDir(), "child-ownership.ts")]
                .map((value, index, all) => sandboxEnabled && all[index - 1] === "--extension" ? canonicalizePath(value) : value);
            if (resume?.recipe.extensionArgs) {
                // A model escalation may change provider auth, but an unchanged tool
                // must not silently switch implementations with current configuration.
                const reference = model === resume.recipe.model ? resolution : await resolveChildClosure({
                    ...dependencyOptions, model: resume.recipe.model, virtual: false, resolution: resolveExtensions({
                    tools: sandboxEnabled ? allow.split(",").filter((name) => (SDK_BUILTIN_TOOLS as readonly string[]).includes(name)).join(",") : extensionAllowlist(),
                    model: resume.recipe.model, clean, allowNested: sandboxEnabled ? false : allowNested, config: cfg,
                }) });
                const referenceArgs = [...extensionArgs(reference, (spec) => reference.paths[spec] ?? resolveExtensionPath(spec)).args, ...codemodeArgs,
                    ...(!resume.recipe.baseExtensionArgs ? trustedExtArgs : []),
                    "--extension", childSteerExtensionPath(), "--extension", join(selfDir(), "child-ownership.ts")]
                    .map((value, index, all) => sandboxEnabled && all[index - 1] === "--extension" ? canonicalizePath(value) : value);
                assertContinuationExtensions(resume.prior.id, resume.recipe,
                    referenceArgs, taskTools?.trusted ?? []);
            }
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
            if (requestedExcludeTools) for (const t of requestedExcludeTools.split(",")) if (t.trim()) excludes.add(t.trim());
            if (!allowNested && resolution.mode === "inherit") {
                for (const t of SUBAGENT_TOOLS) excludes.add(t);
            }

            // A continuation reopens the exact saved conversation with `--session`;
            // never `--session-id`, which would create a replacement session when the
            // history is missing, and never both (Pi rejects the combination).
            const sessionArgs = resume
                ? ["--session", resume.conversation.path, "--session-dir", childSessionDir]
                : ["--session-dir", childSessionDir, "--session-id", id];
            // The bridge extension is added to the command, not to the frozen
            // recipe: whether a supervising Background host is installed is a
            // supervision capability, not a tool implementation, so it must not
            // invalidate a conversation's saved recipe when it appears later.
            const commandExtArgs = bridgeEnabled
                ? [...extArgs, "--extension", childBridgeExtensionPath(selfDir())]
                : extArgs;
            const args = [
                "-p", "--mode", "json",
                ...sessionArgs,
                ...commandExtArgs,
                ...(model ? ["--model", model] : []),
                ...(thinking ? ["--thinking", thinking] : []),
                ...skillLaunchArgs(skills),
                ...(allow && !sandboxEnabled ? ["--tools", allow] : []),
                ...(excludes.size ? ["--exclude-tools", [...excludes].join(",")] : []),
                ...(sandboxEnabled ? ["--no-builtin-tools", "--no-approve"] : approve ? ["--approve"] : []),
                p.prompt,
            ];

            const selectedTools = allow.split(",").filter((name) => name && !excludes.has(name));
            const dropped = toolSelection?.dropped ?? [];
            const taskRuntime = sandboxEnabled && requestedSandboxDir ? prepareTaskRuntime({
                root: requestedSandboxDir, controlDir: join(runDir(id), "control"),
                tools: selectedTools,
                permissions: permissionPlan.permissions && { ...permissionPlan.permissions, ...commandSettings },
                applyPatch: taskTools?.applyPatch === true,
                extensionTools: taskTools?.trusted.map(({ loadPath: _loadPath, ...tool }) => tool) ?? [],
                // The sandboxed child's policy enables the guarded operation bridge
                // only when the fixed bridge adapter path is among its extension
                // paths; the task guard then admits those tools by exact source.
                extensionPaths: [
                    ...extArgs.flatMap((arg, index) => arg === "--extension" && extArgs[index + 1] ? [extArgs[index + 1]!] : []),
                    ...(bridgeEnabled ? [childBridgeExtensionPath(selfDir())] : []),
                ],
                runtimeRoots: [baseDir()],
                capturedDenyWrite: internal?.resumeWait
                    ? (resume?.prior.operations?.policy.sandbox as WorkerSandboxAuthority | null)?.denyWrite
                    : undefined,
            }) : undefined;
            launchScratch = taskRuntime?.policy.scratch;
            if (sandboxEnabled && !taskRuntime) throw new Error("Task sandbox has no workspace; refusing an unconfined child.");
            // Parent-authored trust record, written before the child can run (#325).
            if (taskRuntime) recordTaskRuntimeProvenance(id);
            // Outside project = Write or Write & delete lets the run change files
            // outside its workspace: start an APFS local snapshot (macOS, in the
            // background; a failure is reported, never blocks the run).
            const snapshot = taskRuntime ? takeRecoverySnapshot(taskRuntime.policy.permissions) : undefined;
            if (snapshot?.started) {
                void snapshot.done.then((outcome) => {
                    if (outcome.ok) return;
                    // The snapshot can finish after the session was replaced and ctx went stale.
                    try { ctx.ui?.notify?.(`Subagent ${id}: recovery snapshot failed (run continues): ${outcome.detail}`, "warning"); } catch { /* ignore */ }
                });
            }
            const cmd = taskRuntime ? { file: taskRuntime.file, fileArgs: [...taskRuntime.fileArgs, ...args] } : { file: process.execPath, fileArgs: [join(selfDir(), "child-runtime.mjs"), resolvePiBinary(), ...args] };
            const sandboxDir = taskRuntime ? requestedSandboxDir : undefined;

            // Reservations prevent competing admissions, but do not grandfather
            // unstarted work after a cap reduction. No await separates this live
            // occupancy check, child creation, and the running metadata below.
            const maxConcurrent = activeConcurrencyCap();
            if (countRunning() >= maxConcurrent) {
                throw new Error(`Max concurrent subagents (${maxConcurrent}) reached. Stop or let some finish first.`);
            }
            // One writer per conversation, held across admission, child lifetime,
            // and finalization. A live duplicate continuation is refused instead of
            // letting two processes rewrite one session file. A fresh launch has a
            // brand-new native session id, so it cannot contend with anyone and
            // needs no lease; every continuation does.
            if (resume) {
                lease = acquireConversationLease({ sessionId, attemptId: id });
            }
            // The lease is the first moment no other process can retire this
            // conversation: re-prove the history identity the cached plan was
            // built from, so `--session` can never reopen a file another sweep
            // removed as an empty replacement.
            if (resume) revalidateContinuationUnderLease(resume, callbackOrigin);
            const preflightPath = join(runDir(id), "child-preflight.json");
            writeFileSync(preflightPath, JSON.stringify({ ...fullResolution, model, tools: selectedTools,
                configSnapshot: configSnapshot([dirname(configPath()), join(cwd, ".pi")]),
            }));
            // Register the worker's bridge run before the child can start, so the
            // child's first handshake finds a bound run and its task authority is
            // already captured. A resume requires the bridge: without it the
            // attempt could not read evidence or acknowledge its wait.
            let workerBridge: { env: Record<string, string>; policy: ReturnType<typeof captureWorkerPolicy>; authorityReference: string } | undefined;
            if (bridgeEnabled) {
                const workerPolicy = captureWorkerPolicy({
                    sandbox: sandboxEnabled,
                    mandatoryPermissions: permissionPlan.enforced,
                    tools: selectedTools,
                    clean,
                    workspace: cwd,
                    authorityReference: "",
                    // The assignment deadline the attempt was admitted with; a
                    // continuation must not silently extend it.
                    deadlineAt: resolveRunTiming({ params: launchTimingParams(p), settings: timingSettingsFor(cfg), env: process.env, startedAt: Date.now() }).deadlineAt ?? null,
                    taskPolicy: taskRuntime?.policy ?? null,
                });
                const authorityReference = `worker-policy:${createHash("sha256")
                    .update(JSON.stringify(workerPolicy))
                    .digest("hex")
                    .slice(0, 16)}`;
                // A resumed attempt keeps the owner captured at park time; a fresh
                // launch uses the active foreground binding.
                const owner = internal?.parkOwner ?? ownerBindingFromContext(ctx);
                try {
                    const handle = await workerOperations.register({
                        runId: id,
                        conversationId: sessionId,
                        workspace: cwd,
                        authorityReference,
                        branchId: owner.branchId,
                        goalId: owner.goalId,
                        policy: { ...workerPolicy, authorityReference },
                        capabilities: bridgePlan.capabilities,
                        tools: bridgePlan.tools,
                        schemas: bridgePlan.tools.map((name) => productionBridgeSchemas.schemas.get(name)!).filter(Boolean),
                        attemptId: id,
                        ...(lease?.token ? { writerLeaseId: lease.token } : {}),
                        owner,
                    });
                    workerBridge = {
                        env: { ...handle.env, ...childWriterLeaseEnv(lease?.token) },
                        policy: workerPolicy,
                        authorityReference,
                    };
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    // The child's loadout already promises the bridge (and a
                    // sandboxed task policy would refuse to start without it), so a
                    // registration failure refuses this launch instead of letting the
                    // child run with tools that cannot work.
                    if (internal?.resumeWait) {
                        throw new PreSpawnResumeError(`Cannot resume this conversation without its operation bridge: ${reason}`);
                    }
                    throw new Error(`Cannot supervise this worker's background operations: ${reason}`);
                }
            }
            // Last gate before execution: the parent identity, Goal admission
            // revision, durable claim/token and current policy must all still hold.
            // The fence returns a synchronous release guard that is invoked with no
            // await between it and the spawn, so a cancellation or parent change
            // cannot hide inside a final asynchronous window.
            if (internal?.resumeWait && !resume?.prior.assignment) throw new PreSpawnResumeError("This legacy park has no verified assignment outcome recipient; refusing continuation on an unsupported binding.");
            const parent = ownerBindingFromContext(ctx);
            const assignment: AssignmentBinding | undefined = internal?.resumeWait && resume?.prior.assignment
                ? resume.prior.assignment
                : parent.sessionId && typeof ctx.sessionManager?.getBranch === "function" ? { version: 1, assignmentId: id,
                    owner: { kind: "worker-conversation", sessionId, workspace: cwd, branchId: parent.branchId, goalId: parent.goalId },
                    recipient: { kind: "parent-session", ...parent } } : undefined;
            if (!assignment && bridgeEnabled) throw new Error("Durable assignment outcomes require a recorded parent session and transcript capability.");
            if (assignment) registerAssignmentAttempt(assignment, id);
            if (internal?.resumeWait) {
                const captured = resume?.prior.operations?.policy;
                const currentSandbox = taskRuntime ? {
                    root: taskRuntime.policy.root,
                    ...(taskRuntime.policy.permissions ? { permissions: taskRuntime.policy.permissions } : {}),
                    ...(taskRuntime.policy.denyWrite ? { denyWrite: [...taskRuntime.policy.denyWrite] } : {}),
                } : null;
                assertAssignmentPermissionScope(captured, { sandbox: currentSandbox, mandatoryPermissions: permissionPlan.enforced });
            }
            const dispatchGuard = await internal?.beforeSpawn?.({ runId: id, permissionPlan });
            spawned = releaseChild(dispatchGuard, () => spawnDetached({ file: cmd.file, fileArgs: cmd.fileArgs, cwd, logPath: logPathFor(id),
                env: {
                    [STEER_FILE_ENV]: steerPathFor(id),
                    [PREFLIGHT_ENV]: preflightPath,
                    ...(workerBridge?.env ?? {}),
                } }));
            internal?.onSpawned?.();
            // Record process identity (pgid, start-time token) so health
            // reconciliation can tell a supervised child from a recycled pid
            // or an orphaned process group (#63). Best-effort: when the OS
            // probes are unavailable the fields stay absent and the run is
            // reconciled via the conservative old-metadata path.
            const identity = captureProcessIdentity(spawned.pid, spawnIdentityProbe);
            const startedAt = Date.now();
            // The effective launch recipe is frozen on the attempt so a later
            // continuation can reproduce its runtime intent without re-resolving the
            // catalog or guessing from current configuration.
            const recipe = buildLaunchRecipe({
                attemptId: id,
                sessionId,
                sessionDir: childSessionDir,
                cwd,
                model,
                effort: thinking,
                tools: allow,
                excludeTools: requestedExcludes.size ? [...requestedExcludes].join(",") : undefined,
                skills: skills.mode === "inherit" ? undefined : [...skills.paths],
                clean,
                allowNested,
                approve,
                sandbox: sandboxEnabled,
                sandboxDir: requestedSandboxDir,
                gitCloneWorkspace,
                callback: callbackEnabled,
                name: launchName,
                agent: resume ? resume.recipe.agent : p.agent,
                role: resume ? resume.recipe.role : p.role,
                alias: resume ? resume.recipe.alias : p.alias,
                catalog: launchCatalog,
                extensionArgs: extArgs,
                baseExtensionArgs,
                trustedExtensions: resume?.recipe.trustedExtensions ?? taskTools?.trusted.map(({ name, package: owner, loadPath }) => ({ name, package: owner, loadPath })),
            });

            const meta: RunMeta = {
                assignment,
                outcomeSupport: { version: 1, available: Boolean(assignment), ...(!assignment ? { reason: "Legacy host has no verified parent session/transcript; durable assignment delivery is unavailable." } : {}) },
                id, name: launchName, status: "running",
                pid: spawned.pid, spawnPid: process.pid, spawnPidStartTime: parentStartToken(), model,
                effort: thinking, cwd,
                ...(skills.mode === "inherit" ? {} : { skills: [...skills.paths] }),
                skillsSource: skills.source,
                ...identity,
                promptPreview: p.prompt.slice(0, 200),
                startedAt, logPath: logPathFor(id), sessionId,
                rootRunId,
                ...(resume ? { resumedFrom: resume.prior.id } : {}),
                recipe,
                callbackOrigin,
                sandbox: sandboxDir, taskRuntime: Boolean(taskRuntime), taskScratch: taskRuntime?.policy.scratch, callback: callbackEnabled,
                ...batchInfo,
                // The launch record is JSON. Registry freezes that value; it does not
                // require the resolver's nominal type to carry an index signature.
                ...(launchCatalog ? { catalog: launchCatalog as unknown as RunMeta["catalog"] } : {}),
                // Supervised-operation binding (references only; the per-run bridge
                // token stays in the child environment and is never persisted).
                ...(workerBridge ? {
                    operations: {
                        version: 1 as const,
                        bridgeRunId: id,
                        conversationId: sessionId,
                        workspace: cwd,
                        authorityReference: workerBridge.authorityReference,
                        // Captured at park time for a resumed attempt; the worker
                        // workspace above stays the actual task/sandbox root.
                        ...(internal?.parkOwner
                            ? { branchId: internal.parkOwner.branchId, goalId: internal.parkOwner.goalId }
                            : {
                                branchId: ownerBindingFromContext(ctx).branchId,
                                goalId: ownerBindingFromContext(ctx).goalId,
                            }),
                        ...(internal?.launchToken ? { resumeLaunchToken: internal.launchToken } : {}),
                        policy: {
                            version: 1 as const,
                            mandatoryPermissions: workerBridge.policy.mandatoryPermissions,
                            sandbox: workerBridge.policy.sandbox,
                            tools: workerBridge.policy.tools,
                            clean: workerBridge.policy.clean,
                            deadlineAt: workerBridge.policy.deadlineAt,
                        },
                        tools: bridgePlan.tools,
                    },
                } : {}),
                timing: resolveRunTiming({ params: launchTimingParams(p), settings: timingSettingsFor(cfg), env: process.env, startedAt }),
            };
            // This instance holds the exit observer for a run it actually
            // started; only it can finalize on the exit event (#625).
            directlySupervisedRunIds.add(id);
            // A launch is live work of the current session, so an earlier
            // teardown of this instance no longer applies. Without this the
            // teardown latch would keep supervision from ever settling again
            // for a run started after it (#625).
            sessionTornDown = false;
            // Register exit supervision before any fallible post-spawn publication.
            // A failed metadata write must not strand a running child without a close
            // handler; the lease stays held until that child has actually exited.
            void spawned.exit.then((code) => {
                try { finalizeRun(pi, ctx, id, code); }
                finally { lease?.release(); }
                if (workerBridge) workerOperations.release(id, "attempt-exited");
                // After the writer lease is free: a clean park may already have a
                // ready dependency, and a failed park must hold its wait rather
                // than leave an automatic resume armed.
                void settleParkedExit(id);
                // If this attempt was a published resume of an earlier parked
                // assignment, an exit before acknowledgement must settle that
                // unconsumed generation explicitly instead of leaving it resuming.
                void settleResumedAttemptExit({
                    attemptId: id,
                    service: workerOperations.service,
                    status: readMeta(id)?.status ?? "exited",
                    // The exit handler releases the conversation writer lease just
                    // above, before this call.
                    writerLeaseReleased: true,
                    notify: (message) => {
                        try { uiCtx?.ui?.notify?.(message, "warning"); } catch { /* ignore UI failures */ }
                    },
                });
            });
            writeMeta(meta);
            committed = true;
            // `meta.json` is now the record of this run; the claim has served its
            // purpose. Best effort: a leftover claim is inert while metadata exists.
            clearLaunchAttempt(id);

            uiCtx = ctx;
            ensureTicker();
            // Start periodic supervision reconciliation (self-stops when idle).
            ensureHealthTicker();
            // Footer hint: a visible run now exists, so `← background work · N` shows.
            updateNavigatorFooter(ctx);

            const toolSummary = taskTools ? describeTaskTools(taskTools) : undefined;
            const runtime = resolution.mode === "inherit"
                ? `Runtime: ALL installed extensions (inheritExtensions) — mid-turn drain risk\n`
                : toolSummary
                    ? `Runtime: isolated · ${toolSummary}${resolution.specs.length ? ` · extensions ${resolution.specs.join(", ")}` : ""}\n`
                    : resolution.specs.length
                    ? `Runtime: isolated · extensions ${resolution.specs.join(", ")}\n`
                    : `Runtime: isolated · built-in tools only\n`;
            const warn = (dropped.length ? `Task sandbox: ${dropped.map((tool) => `${tool.name} disabled (${withheldBridgeReasons.get(tool.name) ?? tool.reason})`).join("; ")}.\n` : "") +
                (!sandboxEnabled && resolution.unmapped.length
                ? `NOTE: no extension mapped for ${resolution.unmapped.join(", ")} — ` +
                  `${resolution.unmapped.length > 1 ? "these tools" : "this tool"} will NOT exist in the child. ` +
                  `Add a toolExtensions entry in config.json.\n`
                : "");
            const modelNote = catalogDefaultNote(resume ? undefined : p.catalog, model, thinking);
            // The resolved skill exposure rides with the runtime summary, which every
            // launch and continuation message already prints.
            return { id, meta, spawned, runtime: `${runtime}${describeSkillExposure(skills)}\n${meta.timing ? `${formatTimingLimits(meta.timing, startedAt)}\n` : ""}`, warn, sandboxDir, modelNote };
        } catch (error) {
            // A launch that never committed metadata is not a run: drop
            // everything the attempt created so the registry keeps no
            // unreadable record (#325, #332, #623). A continuation's session
            // directory belongs to the retained owner and a caller-chosen
            // `sandbox_dir` is never ours, so `discardFailedLaunch` only
            // removes this attempt's own paths. A child that already started
            // must not keep running unsupervised; its log goes with the
            // attempt, because a record without metadata can never be read.
            if (!committed) {
                lease?.release();
                if (spawned) killProcessTree(spawned.pid, "SIGKILL");
                discardFailedLaunch(id, { sessionDir: childSessionDir, workspaceDir: ownedCloneWorkspace, scratch: launchScratch });
            }
            throw error;
        }
    }

    /**
     * Finalize a parked attempt after its child exited.
     *
     * The bridge staged the verified checkpoint while the child was still alive;
     * this is where Background receives the three-fact exit proof
     * (checkpoint recorded, writer lease released, original writer gone) and the
     * durable wait leaves `parking`. A park that cannot be proven holds the
     * generation instead of leaving a resume armed for supervision that stopped.
     */
    async function settleParkedExit(id: string): Promise<void> {
        try {
            const result = await finalizeWorkerParkAfterExit({
                runId: id,
                service: workerOperations.service,
                // The exit handler calls this after `lease?.release()`.
                writerLeaseReleased: true,
            });
            if (result.outcome === "held" && result.reason) {
                try { uiCtx?.ui?.notify?.(`Subagent ${id} park held: ${result.reason}`, "warning"); } catch { /* ignore UI failures */ }
            } else if (result.outcome === "parked" && result.wait?.phase === "ready" && resumeOrchestration) {
                // The dependency settled while this attempt was exiting: the ready
                // delivery may already have been dispatched, but reconcile it here.
                const park = parkedWaitForRun(id);
                if (park) void resumeOrchestration.resume(park);
            }
        } catch {
            // The durable park record still shows the staged state; reconciliation
            // at the next session start retries the proof.
        } finally {
            syncHealthTicker();
        }
    }

    /**
     * Launch one automatic continuation of a parked conversation.
     *
     * Everything below is the ordinary continuation admission path
     * (`planContinuation` → `spawnSubagentRun`), reused unchanged: native session,
     * frozen recipe, current mandatory permissions, capacity, writer lease. Only
     * the attempt id/token come from the durable park record written before this
     * call; every failure is classified as pre-spawn (releasable) or ambiguous
     * (must be held).
     */
    async function launchParkedResume(input: ResumeLaunchInput): Promise<void> {
        const ctx = uiCtx;
        if (!ctx || sessionTornDown) {
            throw new PreSpawnResumeError("No active foreground session can resume the parked assignment.");
        }
        const prior = readMeta(input.park.runId);
        if (!prior) throw new PreSpawnResumeError(`Cannot resume ${input.park.runId}: its run record is gone.`);
        const now = Date.now();
        if (prior.timing?.deadlineAt !== undefined && now >= prior.timing.deadlineAt) {
            throw new PreSpawnResumeError(
                `Cannot resume ${input.park.runId}: its assignment deadline passed while it was parked. The wait is held for the owner.`,
            );
        }
        let plan: ContinuationPlan;
        try {
            plan = planContinuation({
                id: prior.id,
                prior,
                origin: { cwd: input.park.record.ownerWorkspace ?? prior.callbackOrigin?.cwd ?? prior.cwd, sessionId: input.park.record.ownerSessionId ?? prior.callbackOrigin?.sessionId },
                others: listMetas(),
            });
        } catch (error) {
            throw new PreSpawnResumeError(error instanceof Error ? error.message : String(error));
        }
        const owner: WaitOwnerBinding = {
            sessionId: input.park.record.ownerSessionId ?? prior.callbackOrigin?.sessionId ?? "",
            workspace: input.park.record.ownerWorkspace ?? prior.callbackOrigin?.cwd ?? prior.cwd,
            branchId: input.park.record.ownerBranchId ?? null,
            goalId: input.park.record.ownerGoalId ?? null,
        };
        const target = plan;
        let spawned = false;
        try {
            await spawnSubagentRun(
                ctx,
                {
                    prompt: resumePrompt(input.park),
                    session_id: plan.conversation.sessionId,
                    callback: prior.callback ?? true,
                    ...continuationTiming(prior),
                },
                undefined,
                plan,
                {
                    assignedRunId: input.assignedRunId,
                    launchToken: input.launchToken,
                    // Marks this launch as an automatic resume: it may continue a
                    // conversation whose wait is still pending, which a manual
                    // continuation is refused until it takes over.
                    resumeWait: { waitId: input.park.waitId, generation: input.park.generation },
                    // The bridge registration and meta.operations must describe the
                    // owner captured when the worker parked, not the foreground
                    // branch as it stands after the parent's later model turn.
                    parkOwner: owner,
                    // Final dispatch fence: extension resolution, permission
                    // re-resolution, the bridge registration and the writer lease
                    // all happened above. Nothing may have changed since admission.
                    beforeSpawn: ({ permissionPlan }) => assertFinalResumeDispatch({
                        pi,
                        rpc: workerOperations.rpc,
                        // Getter, not a captured value: the foreground context can be
                        // replaced during the asynchronous preparation.
                        service: () => workerOperations.service,
                        context: () => uiCtx,
                        park: input.park,
                        claim: input.claim,
                        owner,
                        admissionRevision: input.admissionRevision,
                        permissionsUnchanged: () => samePermissionPlan(
                            permissionPlan,
                            resolveSubagentPermissions(pi, target.recipe.sandbox),
                        ),
                        capacityAvailable: () => resumeCapacity().recheck(),
                    }),
                    onSpawned: () => { spawned = true; },
                },
            );
        } catch (error) {
            // A child that exists is ambiguous: the coordinator holds the claim
            // and the next reconciliation must not launch a second execution.
            if (spawned) throw error;
            throw error instanceof PreSpawnResumeError
                ? error
                : new PreSpawnResumeError(error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * Compare two permission resolutions by value. A changed worker authority
     * during preparation (tightened or relaxed) invalidates the admission and
     * requires a fresh launch decision.
     */
    function samePermissionPlan(
        left: ReturnType<typeof resolveSubagentPermissions>,
        right: ReturnType<typeof resolveSubagentPermissions>,
    ): boolean {
        const canonical = (value: unknown): string => {
            const sort = (input: unknown): unknown => {
                if (Array.isArray(input)) return input.map(sort);
                if (input && typeof input === "object") {
                    return Object.fromEntries(Object.keys(input as Record<string, unknown>).sort()
                        .map((key) => [key, sort((input as Record<string, unknown>)[key])]));
                }
                return input;
            };
            return JSON.stringify(sort(value));
        };
        return canonical(left) === canonical(right);
    }

    /** Preserve the original assignment deadline across parking; never extend it. */
    function continuationTiming(prior: RunMeta): TimingParams {
        const timing = prior.timing;
        if (!timing) return {};
        return continuationTimingParams(timing, Date.now());
    }

    /**
     * Capacity admission for an automatic resume. The ordinary shared gate is
     * reserved before any durable pre-spawn record, so a saturated pool leaves the
     * generation ready (delivery is retried) instead of publishing an
     * unresumable claim; the recheck covers a cap reduced in the meantime.
     */
    function resumeCapacity(): ResumeCapacity {
        const gate = () => getSharedCapacityGate(countRunning);
        return {
            tryReserve: () => gate().tryReserve(1, activeConcurrencyCap()),
            recheck: () => countRunning() + gate().pending <= activeConcurrencyCap(),
            commit: () => gate().commit(1),
            release: () => gate().release(1),
        };
    }

    /** Create the resume orchestration lazily (needs an active foreground context). */
    function ensureResumeOrchestration(): ResumeOrchestration {
        resumeOrchestration ??= createResumeOrchestration({
            pi,
            service: () => workerOperations.service,
            rpc: workerOperations.rpc,
            context: () => uiCtx,
            capacity: resumeCapacity(),
            launch: launchParkedResume,
            stopAttempt: stopPublishedAttempt,
            notifyWhen: (meta) => Boolean(activeCallbackOrigin && belongsToOrigin(meta, activeCallbackOrigin)),
            notify: notifyOwnedWait,
        });
        return resumeOrchestration;
    }

    /**
     * Start the supervised-worker path: the local bridge host plus reconciliation
     * of parked generations left by a previous session. Nothing here runs when the
     * Background service is absent.
     */
    async function startWorkerOperations(): Promise<void> {
        const ready = await workerOperations.start();
        if (!ready) return;
        const service = workerOperations.service;
        if (!service) return;
        const orchestration = ensureResumeOrchestration();
        try {
            // Register the continuation adapter first: Background refuses to
            // register a park wait without one, and ready deliveries are dispatched
            // to exactly this adapter.
            service.registerContinuationAdapter(orchestration.adapter);
        } catch { /* a host that refuses the adapter leaves parking unavailable */ }
        try {
            await reconcileParkedWaits(service, {
                resume: (park) => orchestration.resume(park),
                notifyWhen: (meta) => Boolean(activeCallbackOrigin && belongsToOrigin(meta, activeCallbackOrigin)),
                notify: notifyOwnedWait,
            });
            const historical = historicalWaits(activeCallbackOrigin);
            if (historical.length && activeCallbackOrigin && !attentionDismissed(activeCallbackOrigin.cwd, attentionRevision(historical))) {
                uiCtx?.ui?.notify?.(`${historical.length} historical subagent waits remain. Inspect or cancel with /subagents history; dismiss this notice with /subagents history dismiss.`, "warning");
            }
        } catch { /* reconciliation retries on the next session start */ }
    }

    // ---- subagent_spawn -------------------------------------------------
    //
    // One tool launches both fresh work and a continuation of saved work. A
    // continuation is an ORDINARY attempt of the SAME saved conversation: a new
    // run id, the prior native session id, the exact saved session file, and the
    // frozen launch recipe. Old logs/results/callbacks/timing stay under their
    // own attempt id. Nothing stays alive between attempts, so a parked
    // conversation occupies zero capacity slots. `session_id` (not the run id)
    // selects the conversation, and the latest attempt is always the one that
    // owns it.
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
            "The tools param is both the tool allowlist AND what determines which extensions load in the child (e.g. tools='read,bash,web_fetch' loads only the web-tools package). Ask for the tools the task needs and nothing more; clean:true gives a built-ins-only child. When the task already names its SKILL.md by path, pass skills with those absolute paths (or [] for none) so the child does not advertise the whole skills catalog. Without an agent or role, pick a model with the model param (e.g. 'xai/grok-4.5@high'); providerless model patterns are resolved by Pi, while provider/model is deterministic and loads mapped provider extensions.",
            ...CATALOG_GUIDELINES,
            "Subagent sandboxing defaults to off. Human settings in /sandbox control file, credential-file, command, and network permissions; sandbox:false cannot override an enabled human profile. Set sandbox:true to request kernel confinement, including without published settings. Set callback:false to finish quietly — then read the result on demand via subagent_result.",
            "Every launch automatically joins one shared harness-owned watcher, including batch launches; it stops when the last active run ends. Do not start a separate heartbeat or background watcher for subagents. A tool call still open for tool_wait_minutes (default 5) or no progress for stuck_minutes (default 10) sends one factual alert; these alerts never stop, cancel, or restart the run. Hard timeouts default to 60 minutes; max_minutes overrides that default (0 disables). Soft deadlines remain opt-in for work with a real wall-clock bound: deadline_minutes steers the child to wrap up and later stops it after grace_minutes, while max_minutes stops it without grace. Do not set elapsed-time limits merely because a task may take a while; use them only when the work needs a real wall-clock bound.",
            "Use git_clone_workspace:true when the subagent will mutate Git in a sandbox. The parent prepares a disposable, self-contained clone with a real .git/ directory inside the sandbox root, so linked-worktree metadata outside the sandbox cannot stall the child.",
            "Saved conversations persist automatically. To continue a completed or stopped worker in its own history, call subagent_spawn with session_id (the native session id reported for the saved conversation) and the new feedback as prompt. Omit session_id for a brand-new conversation.",
            "On a continuation, pass prompt, session_id, and only optional model, thinking, callback, or timing overrides. Launch-only options (name, agent, role, alias, tools, exclude_tools, skills, clean, sandbox, sandbox_dir, cwd, git_clone_workspace, approve, allow_nested) keep the saved recipe; repeat them only with the same value, otherwise the launch is refused.",
            "Do not restate the original task or role when continuing: they already live in the saved conversation. A running or orphaned latest attempt blocks continuation until it stops, and missing saved history is refused rather than recreated.",
        ],
        parameters: Type.Object({
            prompt: Type.String({ description: "The task for the subagent. This is the only context it gets — be self-contained. On a continuation this is the next user turn; the original task and role stay in saved history." }),
            session_name: Type.Optional(Type.String({ description: "Exact name of one saved conversation in the current folder and descendants. Alternative to session_id. Duplicate names report matching session ids instead of choosing a conversation." })),
            session_id: Type.Optional(Type.String({ description: "Native session id of a saved conversation to continue (reported for every launch and attempt). Omit to start a new conversation. A continuation gets a new run id but keeps this session id, history, workspace, and frozen launch recipe." })),
            name: Type.Optional(Type.String({ description: "Short label for the run (e.g. 'reviewer'). Ignored when agent or role is set, except as the direct-role alias when alias is omitted." })),
            agent: Type.Optional(Type.String({ description: "Named agent id (agent.<slug>). Mutually exclusive with role. The navigator shows the defined agent name." })),
            role: catalogRoleSchema("direct role launch"),
            alias: Type.Optional(Type.String({ description: "Per-run display alias for a direct role launch, such as checkout. Not a reusable agent. Colliding aliases gain a numeric suffix." })),
            model: Type.Optional(Type.String({ description: "Pi model pattern, preferably provider/id, optionally suffixed with @effort (for example openai/gpt-5.5@high). Providerless patterns are resolved by Pi. Omit to use the agent or role default; without one, inherit the foreground model. Put authoritative model choices here; do not rely on prompt text." })),
            thinking: Type.Optional(Type.String({ description: "Reasoning effort for the child: off, minimal, low, medium, high, xhigh, or max. Omit to use the agent or role default; without one, the Pi/model default." })),
            tools: Type.Optional(Type.String({ description: "Tool allowlist: comma-separated names the child may use (e.g. 'read,bash,web_fetch'). This ALSO selects which extensions load — only packages backing a requested tool are loaded. Defaults to the configured safe set." })),
            exclude_tools: Type.Optional(Type.String({ description: "Comma-separated tool denylist, applied on top of the allowlist." })),
            skills: Type.Optional(Type.Array(Type.String(), { description: "Skill exposure for the child. Omit to inherit the catalog role/agent choice, then config defaultSkills, then user-catalog discovery. [] loads no skills (--no-skills). Absolute paths load exactly those skills (--no-skills --skill <path>), which is how a task that names one SKILL.md by path avoids advertising the whole catalog. Relative paths resolve against the child workspace." })),
            clean: Type.Optional(Type.Boolean({ description: "Run a hermetic child with NO extensions at all (only built-ins: read, bash, edit, write). Default false — the extensions backing the requested tools load, so web_fetch and model auth (e.g. xai) work." })),
            sandbox: Type.Optional(Type.Boolean({ description: "Use the human Subagents profile from /sandbox. Defaults to off without published settings. True requests kernel confinement; false cannot bypass an enabled human profile." })),
            sandbox_dir: Type.Optional(Type.String({ description: "Confine writes to (and run the child in) this directory instead of the working dir. Created if missing." })),
            callback: Type.Optional(Type.Boolean({ description: "Default TRUE: on completion, trigger a turn that calls subagent_result and presents the result. Set false to finish quietly — the result is then read on demand via subagent_result." })),
            cwd: Type.Optional(Type.String({ description: "Working directory (default: current)." })),
            git_clone_workspace: Type.Optional(Type.Boolean({ description: "Prepare a disposable Git clone workspace for sandboxed Git-mutating subagents. The clone has a real .git/ directory inside the sandbox writable root and is self-contained after setup." })),
            approve: Type.Optional(Type.Boolean({ description: "Trust project-local files in the child (default: false; headless runs cannot prompt for trust)." })),
            allow_nested: Type.Optional(Type.Boolean({ description: "Allow the child to spawn its own subagents (default: false). Loads this extension in the child and allowlists its tools." })),
            ...timingSchemaFields(),
        }),

        async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<{
            content: { type: "text"; text: string }[];
            details: Record<string, unknown>;
        }> {
            const p = { ...params } as SpawnParams;
            p.session_id = requestedSessionId(p, ctx.cwd);
            if (p.prompt.trim() === "") throw new Error("prompt is empty.");
            if (p.session_id !== undefined && (typeof p.session_id !== "string" || p.session_id.trim() === "")) {
                throw new Error("session_id must be a non-empty native session id.");
            }
            assertNoRetiredLaunchOptions(p as { retain_session?: unknown });
            // A present-but-blank role or agent is a mistake, not a request for a catalog-free child.
            const blankSelector = blankCatalogSelector(p);
            if (blankSelector) throw new Error(blankSelector);

            const maxConcurrent = activeConcurrencyCap();
            // Shared with batch-spawn: reserve before any async work so an interleaved
            // batch cannot oversubscribe after this check and before writeMeta.
            const gate = getSharedCapacityGate(countRunning);
            if (!gate.tryReserve(1, maxConcurrent)) {
                throw new Error(`Max concurrent subagents (${maxConcurrent}) reached. Stop or let some finish first.`);
            }

            let reserved = 1;
            try {
                if (p.session_id !== undefined) {
                    // Continue a saved conversation. The same capacity, permission,
                    // lease, callback, and finalization path runs as for a fresh
                    // launch; only the conversation and recipe are inherited. The
                    // catalog is never re-resolved for a saved conversation.
                    const plan = continuationPlanFor(p.session_id, verifiedOriginFromContext(ctx) ?? activeCallbackOrigin);
                    assertContinuationLaunchOptions(p as unknown as Record<string, unknown>, plan.recipe, "");
                    const continuation: SpawnParams = {
                        prompt: p.prompt,
                        model: p.model,
                        thinking: p.thinking,
                        callback: p.callback,
                        deadline_minutes: p.deadline_minutes,
                        grace_minutes: p.grace_minutes,
                        max_minutes: p.max_minutes,
                        tool_wait_minutes: p.tool_wait_minutes,
                        stuck_minutes: p.stuck_minutes,
                    };
                    const { id, spawned, runtime, warn, sandboxDir, modelNote } = await spawnSubagentRun(
                        ctx, continuation, undefined, plan,
                    );
                    gate.commit(1);
                    reserved = 0;
                    return {
                        content: [{ type: "text" as const, text:
                            `Subagent continued: ${plan.recipe.name ? `${plan.recipe.name} ` : ""}id=${id} (pid ${spawned.pid}) from ${plan.prior.id}${plan.prior.status === "killed" ? " (interrupted attempt)" : ""}.\n` +
                            `Conversation: session ${plan.conversation.sessionId} — pass session_id=${plan.conversation.sessionId} for the next follow-up.\n` +
                            (modelNote ? `${modelNote[0]!.toUpperCase()}${modelNote.slice(1)}.\n` : "") +
                            (continuation.callback === false
                                ? `Running in the background; the foreground is free. It will finish quietly — read the result with subagent_result id=${id}.\n`
                                : `Running in the background; the foreground is free. Its result will be posted back here when it finishes.\n`) +
                            (sandboxDir ? `Sandboxed: project root ${sandboxDir}; current launch permissions apply.\n` : "") +
                            runtime + warn +
                            `Log: ${logPathFor(id)}`,
                        }],
                        details: {
                            status: "continued" as const,
                            launched: true,
                            priorId: plan.prior.id,
                            runId: id,
                            sessionId: plan.conversation.sessionId,
                            rootRunId: plan.rootRunId,
                        },
                    };
                }
                const catalog = await admitCatalog(ctx, [p]);
                if (catalog.status === "clarification-needed") {
                    gate.release(1);
                    reserved = 0;
                    return catalogResult(catalog);
                }
                if (catalog.jobs.length > 1) {
                    const extra = catalog.jobs.length - 1;
                    if (extra > 0 && !gate.tryReserve(extra, activeConcurrencyCap())) {
                        gate.release(1);
                        reserved = 0;
                        throw new Error(`Choosing split needs ${catalog.jobs.length} subagent slots, but only one was free. Nothing was launched.`);
                    }
                    reserved += extra;
                    const launched: { name?: string; id: string; modelNote?: string }[] = [];
                    for (const job of catalog.jobs) {
                        const { id, modelNote } = await spawnSubagentRun(ctx, job);
                        gate.commit(1);
                        reserved -= 1;
                        launched.push({ name: job.name, id, modelNote });
                    }
                    return {
                        content: [{ type: "text" as const, text: launched.map((item) => `Subagent launched: ${item.name ? `${item.name} ` : ""}id=${item.id} (session ${item.id}).${item.modelNote ? ` ${item.modelNote}.` : ""}`).join("\n") }],
                        details: { status: "launched" as const, launched: true, runIds: launched.map((item) => item.id) },
                    };
                }
                Object.assign(p, catalog.jobs[0]);
                const { id, meta, spawned, runtime, warn, sandboxDir, modelNote } = await spawnSubagentRun(ctx, p);
                gate.commit(1);
                reserved = 0;
                return {
                    content: [{ type: "text" as const, text:
                        `Subagent launched: ${p.name ? `${p.name} ` : ""}id=${id} (pid ${spawned.pid}).\n` +
                        `Session: ${meta.sessionId} — pass it as session_id to continue this conversation.\n` +
                        (modelNote ? `${modelNote[0]!.toUpperCase()}${modelNote.slice(1)}.\n` : "") +
                        (p.callback === false
                            ? `Running in the background; the foreground is free. It will finish quietly — read the result with subagent_result id=${id}.\n`
                            : `Running in the background; the foreground is free. Its result will be posted back here when it finishes.\n`) +
                        (sandboxDir ? `Sandboxed: project root ${sandboxDir}; launch permissions apply.\n` : "") +
                        runtime + warn +
                        `Log: ${logPathFor(id)}`,
                    }],
                    details: { status: "launched" as const, launched: true, runId: id, sessionId: meta.sessionId },
                };
            } catch (err) {
                if (reserved === 1) gate.release(1);
                else if (reserved > 0) gate.release(reserved);
                throw err;
            }
        },
    };
    acceptanceSpawnToolRef = acceptanceSpawnTool;
    registerSpawnTool(acceptanceSpawnTool);

    // ---- subagent_spawn_batch -------------------------------------------
    registerSpawnTool({
        name: "subagent_spawn_batch",
        label: "Spawn Subagent Batch",
        description:
            "Launch several independent background pi subagents at once. Each job becomes a " +
            "normal subagent run with its own run id, process, log, and metadata. " +
            "'shared' options are applied to every job; per-job options override them. " +
            "Codemode callers receive a structured launch receipt: status, batchId when assigned, " +
            "and launched, failed, skipped arrays with 1-based effective job positions (after any confirmed role split). Inspect all arrays; " +
            "a returned receipt is not proof that every job launched or completed. " +
            "Await the launch call and preserve its receipt. Script cancellation does not stop launched runs; use subagent_stop.",
        outputSchema: batchLaunchOutputSchema,
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
                model: Type.Optional(Type.String({ description: "Pi model pattern, preferably provider/id, optionally suffixed with @effort. Omit to use the agent or role default; without one, inherit the foreground model. Put authoritative model choices here; prompt text is not parsed." })),
                thinking: Type.Optional(Type.String({ description: "Reasoning effort applied to every job: off, minimal, low, medium, high, xhigh, or max." })),
                tools: Type.Optional(Type.String({ description: "Tool allowlist applied to every job." })),
                exclude_tools: Type.Optional(Type.String({ description: "Comma-separated tool denylist applied to every job." })),
                skills: Type.Optional(Type.Array(Type.String(), { description: "Skill exposure applied to every job. Per-job skills override this. [] loads no skills; absolute paths load exactly those skills; omit to inherit discovery." })),
                sandbox: Type.Optional(Type.Boolean({ description: "Use the human Subagents profile; false cannot override an enabled profile. Defaults to off without published settings; true requests kernel confinement." })),
                sandbox_dir: Type.Optional(Type.String({ description: "Writable root for every job." })),
                callback: Type.Optional(Type.Boolean({ description: "Default TRUE: post result back on completion." })),
                clean: Type.Optional(Type.Boolean({ description: "Hermetic builtins-only child; no extensions load." })),
                cwd: Type.Optional(Type.String({ description: "Working directory (default: current)." })),
                git_clone_workspace: Type.Optional(Type.Boolean({ description: "Prepare a disposable Git clone workspace for each job (same semantics as subagent_spawn)." })),
                approve: Type.Optional(Type.Boolean({ description: "Trust project-local files in children." })),
                allow_nested: Type.Optional(Type.Boolean({ description: "Allow children to spawn their own subagents." })),
                ...timingSchemaFields(),
            }, { description: "Options applied to every job; per-job values override these. session_id is per job and is never inherited from shared, because one shared conversation would make every job compete for the same writer." })),
            jobs: Type.Array(Type.Object({
                prompt: Type.String({ description: "The task for this job. On a continuation this is the next user turn." }),
                session_name: Type.Optional(Type.String({ description: "Exact saved conversation name in the current folder and descendants. Per job only; alternative to session_id. Ambiguous names refuse with matching session ids." })),
                session_id: Type.Optional(Type.String({ description: "Native session id of a saved conversation this JOB continues. Per job only, never shared. Omit for a new conversation. A continuation keeps its saved history, workspace, and frozen recipe, and accepts only model/thinking/callback/timing overrides." })),
                name: Type.Optional(Type.String({ description: "Short label for this job. Direct-role alias when alias is omitted." })),
                agent: Type.Optional(Type.String({ description: "Named agent id for this job. Overrides shared agent and role." })),
                role: catalogRoleSchema("batch job"),
                alias: Type.Optional(Type.String({ description: "Direct-role alias for this job." })),
                model: Type.Optional(Type.String()),
                thinking: Type.Optional(Type.String()),
                tools: Type.Optional(Type.String()),
                exclude_tools: Type.Optional(Type.String()),
                skills: Type.Optional(Type.Array(Type.String())),
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
            const launchAvailable = p.onCapacity === "launch-available";
            // Shared with single-spawn. Reservations count against maxConcurrent so a
            // concurrent single spawn cannot take a slot the batch already admitted.
            const gate = getSharedCapacityGate(countRunning);

            // session_id selects one saved conversation, so it is per job: a shared
            // value would point every job at the same conversation writer.
            if (p.shared?.session_name !== undefined) throw new Error("session_name is per job, never shared.");
            if (p.shared?.session_id !== undefined) {
                throw new Error("session_id is per job: set jobs[i].session_id for the jobs that continue a saved conversation; shared has no session_id.");
            }
            assertNoRetiredLaunchOptions(p.shared, "shared: ");
            p.jobs.forEach((job, index) => assertNoRetiredLaunchOptions(job, `jobs[${index}]: `));

            validateBatchPlan({ shared: p.shared, jobs: p.jobs, onCapacity: p.onCapacity, config: cfg });
            // A present-but-blank role or agent rejects the whole batch before any launch.
            const blankSelector = blankCatalogSelector(p.shared, "shared")
                ?? p.jobs.map((job, index) => blankCatalogSelector(job, `jobs[${index}]`)).find(Boolean);
            if (blankSelector) throw new Error(blankSelector);

            let catalogSnapshot: CatalogSnapshot | undefined;
            let catalogHost: CatalogHost | undefined;
            const needsCatalog = p.jobs.some((job) => job.session_id === undefined && job.session_name === undefined
                && hasCatalogSelector(mergeJobOptions(p.shared, job)));
            if (needsCatalog) {
                catalogHost = catalogHostFrom(ctx);
                noteCatalogHost(catalogHost);
                catalogSnapshot = loadLaunchSnapshot(catalogHost);
                const clarified = await clarifyCatalogRequest(
                    p.jobs.map((job) => mergeJobOptions(p.shared, job) as CatalogJobFields),
                    { hasUI: catalogHost.hasUI === true, select: catalogHost.select },
                );
                if (clarified.status === "clarification-needed") return {
                    ...catalogResult(clarified),
                    structuredContent: {
                        status: "clarification-needed",
                        message: clarified.message,
                        choices: [...clarified.choices],
                        launched: [],
                        failed: [],
                        skipped: [],
                    },
                };
                p.jobs = clarified.jobs as typeof p.jobs;
                validateBatchPlan({ shared: undefined, jobs: p.jobs, onCapacity: p.onCapacity, config: cfg });
            }

            // reject mode: whole-batch reservation is all-or-nothing. Holding the slots
            // until each job commits (or the unused remainder is released) closes the
            // interleaving oversubscribe class — a stale plan alone is not enough.
            if (!launchAvailable) {
                const maxConcurrent = activeConcurrencyCap();
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
            const launched: { job: number; name: string; id: string; sessionId: string; continuedFrom?: string; modelNote?: string }[] = [];
            const failed: { job: number; name: string; reason: string }[] = [];
            const skipped: { job: number; name: string }[] = [];
            // How many reject-mode reserved slots are still held (not yet committed/released).
            let reservedRemaining = launchAvailable ? 0 : p.jobs.length;

            // Walk every job in order. launch-available reserves one slot at a time and
            // backfills when a job fails before a normal run is launched (slot released).
            for (let i = 0; i < p.jobs.length; i++) {
                const job = p.jobs[i];
                let name = names[i];
                const merged = mergeJobOptions(p.shared, job);
                const isContinuation = job.session_id !== undefined || job.session_name !== undefined;
                // A continuation keeps its own frozen model and effort. shared.model
                // is a default for NEW conversations, so only a per-job value is an
                // explicit escalation of the saved recipe.
                const launch: Partial<SpawnParams> & { prompt: string; name: string } = !isContinuation
                    ? { ...merged, name }
                    : { ...merged, name, model: job.model, thinking: job.thinking };

                if (launchAvailable) {
                    if (!gate.tryReserve(1, activeConcurrencyCap())) {
                        for (let j = i; j < p.jobs.length; j++) {
                            skipped.push({ job: j + 1, name: names[j] });
                        }
                        break;
                    }
                }

                try {
                    const sessionId = requestedSessionId(job, ctx.cwd);
                    // A saved conversation is never re-resolved against the catalog.
                    if (sessionId === undefined && catalogSnapshot && catalogHost && hasCatalogSelector(merged)) {
                        const explicitName = typeof job.name === "string" && job.name.trim() !== "" ? job.name : undefined;
                        const prepared = await prepareCatalogJob(catalogSnapshot, {
                            ...merged,
                            name: explicitName,
                            alias: typeof merged.alias === "string" && merged.alias.trim() !== "" ? merged.alias : explicitName,
                        }, catalogHost);
                        if (prepared.status === "blocked") throw new Error(prepared.message);
                        if (prepared.status === "ready") {
                            Object.assign(launch, prepared.assign);
                            if (prepared.assign.model === undefined) delete launch.model;
                            if (prepared.assign.thinking === undefined) delete launch.thinking;
                            name = prepared.assign.name;
                        }
                    }
                    let plan: ContinuationPlan | undefined;
                    if (sessionId !== undefined) {
                        plan = continuationPlanFor(sessionId, verifiedOriginFromContext(ctx) ?? activeCallbackOrigin);
                        assertContinuationLaunchOptions(
                            launch as unknown as Record<string, unknown>, plan.recipe, `Job ${i + 1}: `, { includeName: false },
                        );
                    }
                    const { id, meta, modelNote } = await spawnSubagentRun(ctx, { ...launch, name }, { batchId, batchName: p.batchName }, plan);
                    gate.commit(1);
                    if (!launchAvailable) reservedRemaining -= 1;
                    launched.push({
                        job: i + 1, name, id, sessionId: meta.sessionId,
                        ...(plan ? { continuedFrom: plan.prior.id } : {}),
                        ...(modelNote ? { modelNote } : {}),
                    });
                } catch (err) {
                    gate.release(1);
                    if (!launchAvailable) reservedRemaining -= 1;
                    const reason = err instanceof Error ? err.message : String(err);
                    failed.push({ job: i + 1, name, reason });
                    if (!launchAvailable) {
                        // reject mode: leave already-launched runs running, release any
                        // still-held later reservations, and report every later job as failed.
                        if (reservedRemaining > 0) {
                            gate.release(reservedRemaining);
                            reservedRemaining = 0;
                        }
                        for (let j = i + 1; j < p.jobs.length; j++) {
                            failed.push({
                                job: j + 1,
                                name: names[j],
                                reason: "not launched due to earlier job failure in reject mode",
                            });
                        }
                        return batchLaunchResult({
                            batchId, batchName: p.batchName, launched, skipped, failed,
                        });
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

            return batchLaunchResult({ batchId, batchName: p.batchName, launched, skipped, failed });
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
        inspectOutcome: (meta: RunMeta, params: Record<string, unknown>, callCtx?: unknown) => {
            if (params.disposition !== undefined && params.disposition !== "consumed" && params.disposition !== "dismissed") throw new Error("Outcome disposition must be consumed or dismissed.");
            if (!readOutcome(meta)) {
                if (params.disposition !== undefined || params.operation_id !== undefined) throw new Error("No committed terminal outcome is available for this assignment.");
                return null;
            }
            const context = (callCtx ?? uiCtx) as ExtensionContext;
            if (!context) throw new Error("Parent identity is unavailable.");
            return inspectOutcome(meta, { recipient: { kind: "parent-session", ...ownerBindingFromContext(context) }, permissions: currentSandboxPermissions(pi),
                branchIds: context.sessionManager.getBranch().map((entry) => entry.id),
                ...(typeof params.operation_id === "string" ? { operationId: params.operation_id } : {}),
                ...(typeof params.outcome_revision === "number" ? { revision: params.outcome_revision } : {}),
                ...(params.disposition === "consumed" || params.disposition === "dismissed" ? { disposition: params.disposition, note: String(params.note ?? "") } : {}) });
        },
        getActiveOrigin: (ctx?: unknown) => activeCallbackOrigin ?? verifiedOriginFromContext(ctx as ExtensionContext | undefined),
    };
    pi.registerTool(subagentListTool(Type, toolSession));
    pi.registerTool(subagentSettingsTool(Type, effectiveSettings));
    pi.registerTool(subagentOutputTool(Type, toolSession));
    const acceptanceResultTool = subagentResultTool(Type, toolSession);
    pi.registerTool(acceptanceResultTool);
    publishAcceptanceHooks(acceptanceResultTool);
    const acceptanceStopTool = subagentStopTool(Type, { onStopped: (id) => {
        renderWidget();
        syncHealthTicker();
        // Stopping a run is a terminal transition, so it owes the caller its one
        // completion callback even when the caller is the one who asked (#624).
        enqueueCompletionCallback(pi, id);
    } });
    acceptanceStopToolRef = acceptanceStopTool;
    // A parked assignment has no live child: `subagent_stop` is the explicit
    // takeover that cancels its pending automatic resume, so the conversation can
    // be continued manually. Without this, stop would report "not running" and
    // leave the automatic resume armed for the same assignment.
    const acceptanceStopToolWithParked = {
        ...acceptanceStopTool,
        async execute(toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) {
            const target = (params as { id?: unknown } | undefined)?.id;
            try {
            if (typeof target === "string" && await cancelParkedForUi?.(target, "cancelled by subagent_stop; the automatic resume is cancelled")) {
                renderWidget();
                syncHealthTicker();
                return {
                    content: [{
                        type: "text",
                        text: `Durably cancelled the pending wait of parked subagent ${target}. Writer termination may remain unproven; ordinary continuation admission still applies.`,
                    }],
                };
            }
            } catch (error) {
                return { isError: true, content: [{ type: "text", text: `Cancellation failed for ${target}: ${String(error)}. The retained wait remains available for inspection and retry.` }] };
            }
            return (acceptanceStopTool.execute as (
                id: string, p: unknown, s?: AbortSignal, u?: unknown, c?: unknown,
            ) => Promise<unknown>)(toolCallId, params, signal, onUpdate, ctx) as Promise<never>;
        },
    };
    pi.registerTool(acceptanceStopToolWithParked as typeof acceptanceStopTool);
    publishAcceptanceHooks();

    const agentOperations = createAgentOperations({
        projectConfigDirName,
        sessionSettings: agentSessionSettings,
        readSkillDefaults,
        discoverSkills: (commandCtx) => discoveredSkillsFromContext(commandCtx),
        editableModels: () => catalogModelRegistry?.getAvailable().map((model) => `${model.provider}/${model.id}`) ?? [],
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
                sessionManager: full.sessionManager,
                ui: full.ui ?? { select: async () => undefined },
                isProjectTrusted: () => full.isProjectTrusted(),
            } as ExtensionContext));
            return {
                cwd: full.cwd,
                projectTrusted: full.isProjectTrusted(),
                userRoot: defaultUserRoot(),
                projectConfigDirName,
                sessionSettings: agentSessionSettings.snapshot(),
            };
        },
        enrich: createLaunchEnricher(pi),
    });
    const openSettings = async (ctx: ExtensionCommandContext): Promise<void> => {
        if (ctx.mode === "tui" && ctx.hasUI && typeof ctx.ui.custom === "function") {
            const next = await ctx.ui.custom<"agents" | undefined>((tui, theme, _kb, done) => createSubagentSettingsPage(theme, {
                get: () => {
                    const settings = effectiveSettings();
                    const skills = activeSkills();
                    const timing = timingState();
                    return {
                        mode: settings.delegationMode, maxConcurrent: settings.maxConcurrent,
                        maxMinutes: timing.maxMinutes,
                        modeSource: settings.sources.delegationMode,
                        capSource: settings.sources.maxConcurrent,
                        defaultMode: normalizeDelegationMode(loadConfig().delegationMode),
                        defaultCap: normalizeConcurrencyCap(loadConfig().maxConcurrent),
                        toolWaitMinutes: settings.toolWaitMinutes, stuckMinutes: settings.stuckMinutes,
                        toolWaitSource: settings.timingSources.toolWaitMinutes,
                        stuckSource: settings.timingSources.stuckMinutes,
                        defaultToolWaitMinutes: timing.defaultToolWaitMinutes,
                        defaultStuckMinutes: timing.defaultStuckMinutes,
                        ...(settings.timingError ? { timingError: settings.timingError } : {}),
                        skillsMode: skills.mode, skillsPaths: skills.paths, skillsSource: skills.source,
                        skillsError: skills.error,
                    };
                },
                changeMode, changeCap, changeTiming, changeSkills, save: saveSettings, reset: resetSettings,
                discoverSkills: () => discoveredSkillsFromContext(ctx),
                // Close this page first; the catalog opens after ui.custom resolves.
                openAgents: () => done("agents"),
            }, () => { refreshBackgroundWorkNavigator(ctx); tui.requestRender(); }, () => done(undefined)));
            if (next === "agents") await agentOperations.openCatalog(ctx);
        } else {
            const skills = activeSkills();
            const skillChoice = skills.mode === "inherit" ? "discovery"
                : skills.mode === "none" ? "no skills" : `${skills.paths.length} selected skills`;
            const timing = timingState();
            ctx.ui.notify(`Delegation mode: ${activeDelegationMode()}. Concurrent subagents: ${activeConcurrencyCap()}. ` +
                `Timeout: ${timing.maxMinutes} minutes (0 disables). Tool-wait alert: ${timing.toolWaitMinutes} min. ` +
                `No-progress alert: ${timing.stuckMinutes} min. Skills: ${skillChoice}. ` +
                `Use /subagents mode <mode>, cap <number>, tool-wait <minutes>, stuck <minutes>, or settings; /subagents save persists them.`, "info");
        }
    };
    const contribution = { id: "subagents", label: "Subagents", command: "/subagents settings", open: openSettings };
    const agentsContribution = { id: "agents", label: "Agents", command: "/agents", open: agentOperations.openCatalog };
    const registerSettings = () => {
        pi.events?.emit("harness-settings:register", contribution);
        pi.events?.emit("harness-settings:register", agentsContribution);
    };
    const unsubscribeSettingsRequest = pi.events?.on?.("harness-settings:request", registerSettings);
    const unsubscribeOutcomeWorkflow = pi.events?.on?.("pi-better-workflow:changed", () => recoverAssignmentOutcomes(pi));
    registerSettings();

    if (typeof pi.registerCommand === "function") {
        agentOperations.registerCommands(pi);
        pi.registerCommand("subagents", {
            description: "[history [dismiss]|settings|mode manual|adaptive|coordinator|cap <number>|tool-wait <minutes>|stuck <minutes>|save|reset] — Subagent management",
            getArgumentCompletions: subagentsArgumentCompletions,
            async handler(args, ctx) {
                const tokens = args.trim().split(/\s+/).filter(Boolean);
                if (tokens[0] === "history") {
                    try {
                        const origin = { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() };
                        const waits = historicalWaits(origin);
                        if (tokens[1] === "dismiss") {
                            dismissAttention(ctx.cwd, attentionRevision(waits));
                            ctx.ui.notify("Historical attention notice dismissed. Waits and evidence are unchanged.", "info");
                            return;
                        }
                        const labels = waits.map((p) => `${p.runId} · session ${p.record.ownerSessionId ?? "unknown"} · ${p.phase}`);
                        const selected = await ctx.ui.select("Historical subagent waits", labels);
                        const park = waits[labels.indexOf(selected ?? "")];
                        if (!park) return;
                        const action = await ctx.ui.select(`${park.runId} · session ${park.record.ownerSessionId ?? "unknown"}`, ["Inspect", "Cancel pending wait"]);
                        if (action === "Inspect") {
                            ctx.ui.notify(JSON.stringify({ runId: park.runId, originatingSession: park.record.ownerSessionId,
                                workspace: park.record.ownerWorkspace, waitId: park.waitId, generation: park.generation,
                                phase: park.phase, reason: park.record.heldReason, cancellation: park.record.cancelReason,
                                resumedBy: park.record.resumedBy, log: park.meta.logPath }), "info");
                        } else if (action === "Cancel pending wait" && await ctx.ui.confirm("Cancel pending wait?", `${park.runId} belongs to session ${park.record.ownerSessionId ?? "unknown"}. This does not prove its writer has stopped.`)) {
                            if (!await cancelParkedForUi?.(park.runId, "explicit cancellation from historical management")) throw new Error("The pending wait changed; inspect it again.");
                            ctx.ui.notify(`Durably cancelled the pending wait of ${park.runId}. Writer termination may remain unproven.`, "info");
                        }
                    } catch (error) { ctx.ui.notify(`Historical wait management failed: ${String(error)}. Inspect or retry with /subagents history.`, "warning"); }
                    return;
                }
                if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === "settings")) {
                    await openSettings(ctx);
                    return;
                }
                const requested = tokens[1];
                if (tokens.length === 1 && tokens[0] === "save") {
                    const skills = activeSkills();
                    if (skills.mode === "explicit" && skills.paths.length === 0) {
                        ctx.ui.notify("Add at least one skill path, or choose No skill catalog to load none.", "warning");
                        return;
                    }
                    const skillChoice = skills.mode === "inherit" ? "skill discovery"
                        : skills.mode === "none" ? "no skills" : `${skills.paths.length} selected skills`;
                    const timing = timingState();
                    if (ctx.hasUI && !(await ctx.ui.confirm("Save subagent defaults?",
                        `Future sessions will start in ${activeDelegationMode()} with a cap of ${activeConcurrencyCap()}, ` +
                        `timeout ${timing.maxMinutes} minutes (0 disables), tool-wait alert ${timing.toolWaitMinutes} min, ` +
                        `no-progress alert ${timing.stuckMinutes} min, and ${skillChoice}.`))) {
                        ctx.ui.notify("Subagent defaults unchanged.", "info");
                        return;
                    }
                    const saved = saveSettings();
                    ctx.ui.notify(saved.message, saved.ok ? "info" : "warning");
                } else if (tokens.length === 1 && tokens[0] === "reset") {
                    resetSettings();
                    ctx.ui.notify("Session subagent settings reset to saved defaults.", "info");
                } else if (tokens.length === 2 && tokens[0] === "mode" && isDelegationMode(requested)) {
                    changeMode(requested);
                    ctx.ui.notify(`Delegation mode: ${activeDelegationMode()} (current session).`, "info");
                } else if (tokens.length === 2 && tokens[0] === "cap") {
                    const cap = /^\d+$/.test(requested!) ? Number(requested) : NaN;
                    if (!isConcurrencyCap(cap)) {
                        ctx.ui.notify("Concurrent subagents must be a positive whole number. Nothing changed.", "warning");
                        return;
                    }
                    changeCap(cap);
                    ctx.ui.notify(`Concurrent subagents: ${cap} (current session). Running subagents are unchanged.`, "info");
                } else if (tokens.length === 2 && (tokens[0] === "tool-wait" || tokens[0] === "stuck")) {
                    const key = tokens[0] === "tool-wait" ? "toolWaitMinutes" : "stuckMinutes";
                    let minutes: number;
                    try {
                        minutes = validatedTimingMinutes(requested, key);
                    } catch (error) {
                        ctx.ui.notify(`${error instanceof Error ? error.message : String(error)} Nothing changed.`, "warning");
                        return;
                    }
                    changeTiming(key, minutes);
                    ctx.ui.notify(`${tokens[0] === "tool-wait" ? "Tool-wait" : "No-progress"} alert: ${minutes} min (current session). Running subagents are unchanged.`, "info");
                } else {
                    ctx.ui.notify("Usage: /subagents [history [dismiss]|settings|mode manual|adaptive|coordinator|cap <number>|tool-wait <minutes>|stuck <minutes>|save|reset]", "warning");
                }
                refreshBackgroundWorkNavigator(ctx);
            },
        });
    }
    const discoveryTool = agentOperations.createDiscoveryTool(Type as never);
    pi.registerTool(discoveryTool as Parameters<ExtensionAPI["registerTool"]>[0]);

    // Sections on a host that renders them; text only where it renders none.
    // Returning a prompt on modern pi would set forceSystemPrompt, and the request
    // would then carry a snapshot, so sections published after it never arrive.
    pi.on("before_agent_start", (event) => deliverSubagentPrompt(event, effectiveSettings()));

    // ---- live-status lifecycle -----------------------------------------
    pi.on("agent_start", async (_event, ctx) => {
        setCallbackBatchContext(pi, ctx);
        getCallbackBatcher(pi).setForegroundRunning(true);
        uiCtx = ctx;
        mainAgentStartedAt = Date.now();
        mainAgentTools.clear();
        refreshBackgroundWorkNavigator(ctx);
    });

    pi.on("agent_end", () => { getCallbackBatcher(pi).setForegroundRunning(false); });

    pi.on("tool_execution_start", async (event, ctx) => {
        getCallbackBatcher(pi).toolStarted(event.toolCallId);
        mainAgentTools.set(event.toolCallId, event.toolName);
        refreshBackgroundWorkNavigator(ctx);
    });

    pi.on("tool_execution_end", async (event, ctx) => {
        await getCallbackBatcher(pi).toolEnded(event.toolCallId);
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
        getCallbackBatcher(pi).setForegroundRunning(false);
        setCallbackBatchContext(pi, ctx);
        mainAgentStartedAt = undefined;
        mainAgentTools.clear();
        refreshBackgroundWorkNavigator(ctx);
        recoverAssignmentOutcomes(pi);
    });

    pi.on("session_tree", async (_event, ctx) => {
        setCallbackBatchContext(pi, ctx);
        agentSessionSettings.restore(ctx);
        try { noteCatalogHost(catalogHostFrom(ctx)); } catch { /* catalog inspection stays undecided */ }
        restoreDelegationMode(ctx);
        recoverAssignmentOutcomes(pi);
    });

    // Capture a UI-bearing context and, if runs from a prior session are still
    // alive, resume the ticking widget. Deferred out of the factory per pi's
    // "no background resources at load" rule.
    pi.on("session_start", async (_event, ctx) => {
        // A session begins in this process again (reload, restart, or a session
        // switch), so the previous session's teardown no longer applies: the
        // replacing session owns this instance's supervision loops (#625).
        sessionTornDown = false;
        outcomeHost = createOutcomeHost();
        setCallbackBatchContext(pi, ctx);
        agentSessionSettings.restore(ctx);
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
        // - Repaint the widget even if its last in-memory lines match; the host
        //   may have dropped extension UI during reload/session replacement.
        ensureSubagentProvider();
        // A reload/restart leaves detached children alive without an in-memory
        // exit observer (#625). Finalize any that finished while the foreground
        // session was gone; live ones stay `running` and the ticker below
        // supervises them until they exit. This runs BEFORE abandonment
        // adoption: a finished child's coherent log is terminal evidence, and
        // `lost` would otherwise win the race and hide the result.
        recoverInterruptedSubagents(pi);
        // Adopt records left non-terminal by a pi that died without a clean
        // shutdown, so the age sweep can eventually retire them.
        reconcileAbandonedRuns();
        disposeBackgroundWorkNavigator(ctx, navigatorOwner);
        widgetNavActive = false;
        widgetNavSelectedId = undefined;
        ensureNavigator(ctx, navigatorOwner);
        publishAcceptanceHooks();
        updateNavigatorFooter(ctx);
        // Clear the retired legacy widget so the shared navigator is the only
        // list surface for running/orphaned subagents.
        renderWidget();
        // Reattach one watcher after reload; ordinary completion retries belong to the batcher.
        syncHealthTicker();
        // Supervised worker operations (ADR 0020): the bridge host is bound to this
        // process, and parked generations from a previous session are reconciled
        // against the durable coordinator before anything resumes.
        void startWorkerOperations();
    });

    pi.on("session_before_switch", () => {
        agentSessionSettings.clear();
        catalogModelRegistry = undefined;
        activeCallbackOrigin = undefined;
        cancelCallbackBatch(pi);
        mainAgentStartedAt = undefined;
        mainAgentTools.clear();
        // Owned disposal only: a headless child or a stale factory must not clear
        // the parent's navigator by omitting the context and owner.
        disposeBackgroundWorkNavigator(undefined, navigatorOwner);
    });

    // Tear down the timer and clear the widget when the session ends.
    pi.on("session_shutdown", async (event, ctx) => {
        closeOutcomeHost(outcomeHost);
        if (typeof unsubscribeOutcomeWorkflow === "function") unsubscribeOutcomeWorkflow();
        if (typeof unsubscribeSettingsRequest === "function") unsubscribeSettingsRequest();
        // #625: subagent children are detached process groups that outlive this
        // foreground session. A controlled reload or quit must not destroy
        // delegated work: record the interruption durably, warn the human, and
        // leave the child, its log, and its saved state untouched. The next
        // session of this pi process resumes supervision and finalizes the run
        // from the child's own log.
        const reason = typeof event?.reason === "string" ? event.reason : "shutdown";
        try {
            const interrupted = interruptCurrentSessionSubagents(reason, ctx);
            warnInterruptedSubagents(ctx, interrupted, reason);
        } catch { /* shutdown cleanup must never block the session teardown */ }
        // Late finalizers of surviving children must not restart supervision
        // loops in this replaced instance.
        sessionTornDown = true;
        // This instance's bridge host dies with the session: a surviving child
        // loses its transport (and therefore refuses to park) instead of talking
        // to a replaced session's handlers. Durable wait records are untouched.
        try { resumeOrchestration?.stop(); } catch { /* best effort */ }
        resumeOrchestration = undefined;
        void workerOperations.close().catch(() => {});
        // Children keep running; their finalizers (if this instance still holds
        // one) must not reach for a ctx that Pi invalidates once the session is
        // replaced.
        uiCtx = undefined;
        agentSessionSettings.clear();
        catalogModelRegistry = undefined;
        // `/reload` keeps the same session identity, so a finalizer that lands
        // after the replacement still targets the live session and may deliver
        // its completion. Every other reason replaces or ends that identity, so
        // the origin is dropped and the pending marker is left for whichever
        // session owns the run next.
        if (reason !== "reload") activeCallbackOrigin = undefined;
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
        disposeBackgroundWorkNavigator(ctx, navigatorOwner);
        // Widget clear is intentional in every mode that exposes ui, including RPC.
        try { ctx.ui.setWidget("subagents", WIDGET_CLEAR); } catch { /* ignore */ }
    });
}
