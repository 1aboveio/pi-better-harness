import type { CustomEditor, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { commandAvailable, commandInvocation, resolveGoalCommand } from "./command-binding.js";
import { goalPreferencesPath, readGoalPreferences, writeGoalPreference, type GoalPreferences } from "./preferences.js";
import { createGoalSettingsPage } from "./settings-page.js";

import {
  collectActivitySnapshot,
  planBackgroundDrainWake,
  summarizeActiveBackground,
  terminalAttentionSignature,
  type BackgroundDrainTracker,
} from "./activity.js";
import {
  continuationStateEntry,
  createContinuationState,
  createGoalSnapshot,
  currentContinuationState,
  currentGoalSnapshot,
  goalClearEntry,
  goalSetEntry,
  goalWithStatus,
  validateObjective,
  validateTokenBudget,
  type GoalEntrySource,
} from "./goal-state.js";
import { continuationEvidence, type ContinuationEvidence } from "./continuation.js";
import { currentPermissionHold, logicalPermissionBlockerKey, MAX_PERMISSION_BLOCKERS, MAX_PERMISSION_RECORDS, permissionHoldRecord, permissionInstruction, permissionRecord, reportedPermissionBlockers, reportedPermissionGap, type PermissionHold } from "./permission-hold.js";
import { observeGoalStall } from "./stall.js";
import {
  flattenObjectiveForRail,
  goalClockRefreshDelayMs,
  goalTiming,
  isGoalClockVisible,
  renderGoalClockLine,
} from "./goal-clock.js";
import { createRenderScheduler } from "./shared-render-scheduler.js";
import { collectSubagentActivity } from "./subagents.js";
import { currentWorkflowOwner, skillCommandName, workflowEntry, workflowOwnerFromSkill, WORKFLOW_ENTRY_TYPE } from "./workflow.js";
import {
  EVENT_ACTIVITY,
  EVENT_READY,
  EVENT_REGISTER_PROVIDER,
  EVENT_TERMINAL_ATTENTION,
  EXTENSION_NAME,
  EXTENSION_VERSION,
  type ActivitySnapshot,
  type BackgroundActivityProvider,
  type BackgroundWorkItem,
  type GoalSnapshot,
} from "./types.js";

const POLL_INTERVAL_MS = 2_000;
const DEFAULT_IDLE_CONTINUATION_DELAY_MS = 60_000;
const DEFAULT_MAX_NO_PROGRESS_RETRIES = 10;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const WAKE_DISABLED =
  process.env.PI_BETTER_GOAL_DISABLE_WAKE === "1" ||
  process.env.PI_BETTER_EXTENSION_DISABLE_WAKE === "1";
const IDLE_CONTINUATION_DELAY_MS = parseDurationEnv(
  process.env.PI_BETTER_GOAL_IDLE_CONTINUATION_DELAY_MS,
  DEFAULT_IDLE_CONTINUATION_DELAY_MS,
);
const MAX_NO_PROGRESS_RETRIES = parseRetryLimit(
  process.env.PI_BETTER_GOAL_MAX_NO_PROGRESS_RETRIES,
  DEFAULT_MAX_NO_PROGRESS_RETRIES,
);

/**
 * Tools that block the foreground turn until the user answers. Background
 * completions that arrive meanwhile queue behind the answer (Pi only drains
 * steering after the whole tool batch, and callback batches are follow-ups
 * that wait for the entire run), so the goal harvests them explicitly.
 */
/** Model-callable resume, active only while an escape-paused goal waits. */
export const GOAL_RESUME_TOOL = "goal_resume";
/** Hotkey that resumes any paused goal, like `/goal resume`. */
export const GOAL_RESUME_SHORTCUT = "alt+g";

/** When the agent may call `goal_resume`; shared by the tool description and the paused prompt. */
const GOAL_RESUME_RULE =
  "Call goal_resume only when the user's latest message clearly says to proceed (for example \"go\", \"continue\", \"ok do it\", \"approved, proceed\"), " +
  "or answers a decision you explicitly asked for in your previous message with a choice that means proceed. Never call it for questions, \"why...\", \"what about...\", \"let me think\", or discussion.";

/** True when the agent may resume this goal with `goal_resume`. */
export function agentResumable(goal: GoalSnapshot | null, conversationalResume = true): boolean {
  return conversationalResume && goal?.status === "paused" &&
    (goal.pauseReason === "interrupt" || goal.pauseReason === "handback");
}

/** Footer status for a paused goal, telling the user how to resume it. */
export function pausedGoalStatus(goal: GoalSnapshot, conversationalResume = true): string {
  if (goal.pauseReason === "permission-blocker") return "goal held: permission blocker · /goal resume (one retry)";
  return agentResumable(goal, conversationalResume) ? 'goal paused · say "go" or /goal resume' : "goal paused · /goal resume";
}

function pausedGoalPrompt(goal: GoalSnapshot, conversationalResume: boolean): string {
  return [
    goal.pauseReason === "handback"
      ? `Pi Better Goal is paused because its workflow handed back unfinished work for the user's answer. Goal: ${goal.objective}`
      : `Pi Better Goal is paused because the user pressed escape. Goal: ${goal.objective}`,
    "Treat the user's messages as ordinary conversation: answer them, but do not continue the goal's work until it is resumed.",
    conversationalResume ? GOAL_RESUME_RULE : "Only the user can resume this goal, with /goal resume or alt+g. A conversational go-ahead does not resume it.",
  ].join("\n");
}

const BLOCKING_QUESTION_TOOLS: ReadonlySet<string> = new Set(["ask_user_question"]);

const GOAL_ACTIONS: readonly AutocompleteItem[] = [
  { value: "pause", label: "pause", description: "Pause the active goal" },
  { value: "resume", label: "resume", description: "Resume the paused goal" },
  { value: "clear", label: "clear", description: "Remove the current goal" },
  { value: "complete", label: "complete", description: "Mark the current goal complete" },
  { value: "settings", label: "settings", description: "Inspect or persist goal continuation, conversational resume, and Escape pause controls" },
];

const GOAL_SETTINGS = ["auto-continue", "conversational-resume", "pause-on-escape"] as const;

export function goalArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  const prefix = argumentPrefix.trimStart().toLowerCase();
  if (prefix.startsWith("settings ")) {
    const settingPrefix = prefix.slice("settings ".length);
    const choices = GOAL_SETTINGS.flatMap((setting) => settingPrefix.startsWith(`${setting} `)
      ? ["on", "off"].map((mode) => `settings ${setting} ${mode}`)
      : [`settings ${setting}`]);
    const matches = choices.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
    return matches.length > 0 ? matches : null;
  }
  const matches = GOAL_ACTIONS.filter((action) => action.value.startsWith(prefix));
  return matches.length > 0 ? [...matches] : null;
}

function parseDurationEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Linear backoff for no-progress retries: each identical outcome waits one more
 * grace period than the last (60s, 120s, 180s, ... by default).
 */
export function idleContinuationDelay(noProgressRetries: number, baseMs = IDLE_CONTINUATION_DELAY_MS): number {
  return Math.min(MAX_TIMER_DELAY_MS, baseMs * (1 + Math.max(0, noProgressRetries)));
}

function parseRetryLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * True when the agent loop ended because the running turn was interrupted
 * (escape / ctrl+c). An aborted run leaves a final assistant message whose
 * stopReason is "aborted".
 */
function wasTurnAborted(messages: readonly unknown[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    const candidate = message as { role?: unknown; stopReason?: unknown };
    if (candidate.role !== "assistant") {
      continue;
    }
    return candidate.stopReason === "aborted";
  }
  return false;
}

function activeItemsByKey(snapshot: ActivitySnapshot): Map<string, BackgroundWorkItem> {
  const items = new Map<string, BackgroundWorkItem>();
  for (const provider of snapshot.providers) {
    for (const item of provider.items) {
      if (item.active) items.set(`${provider.providerId}:${item.id}`, item);
    }
  }
  return items;
}

/** Items that were active when a question started and are no longer active now. */
export function finishedSinceQuestion(
  activeAtStart: ReadonlyMap<string, BackgroundWorkItem>,
  snapshot: ActivitySnapshot,
): BackgroundWorkItem[] {
  const stillActive = activeItemsByKey(snapshot);
  const current = new Map<string, BackgroundWorkItem>();
  for (const provider of snapshot.providers) {
    for (const item of provider.items) current.set(`${provider.providerId}:${item.id}`, item);
  }
  const finished: BackgroundWorkItem[] = [];
  for (const [key, started] of activeAtStart) {
    if (stillActive.has(key)) continue;
    finished.push(current.get(key) ?? { ...started, active: false, status: "unknown" });
  }
  return finished;
}

function questionHarvestPrompt(finished: readonly BackgroundWorkItem[]): string {
  const rows = finished.map((item) => {
    const label = item.label ? `${item.label} (${item.id})` : item.id;
    return `- ${label}: ${item.status}`;
  });
  return [
    `${finished.length} background item${finished.length === 1 ? "" : "s"} finished while you were waiting on the user's answer:`,
    ...rows,
    "Inspect and integrate these results now (for example with subagent_result or bg_task_status) before acting on the answer; their completion notices may still arrive later as a batch.",
  ].join("\n");
}

function continuationPrompt(goal: GoalSnapshot, owner: ReturnType<typeof currentWorkflowOwner> = null): string {
  return [
    "Continue working toward the active thread goal.",
    "",
    `Goal: ${goal.objective}`,
    "",
    owner
      ? `Continue the ${owner.name} workflow as its coordinator. Its own task plan is authoritative; do not implement product code in the parent. Mark the goal complete only after the workflow's completion audit.`
      : "Keep working through clear low-risk next steps. Do not stop at a plan. Mark the goal complete only after an evidence-backed completion audit proves no required work remains.",
  ].join("\n");
}

function formatGoal(
  goal: GoalSnapshot | null,
  continuation: ReturnType<typeof currentContinuationState> = null,
  stall = observeGoalStall(goal, continuation),
  preferences: GoalPreferences = { autoContinue: true, conversationalResume: true, pauseOnEscape: true },
  permissions?: PermissionHold | null,
): string {
  const settings = formatPreferences(preferences);
  if (!goal) {
    return `No goal is set.\n${settings}`;
  }
  const budget = goal.tokenBudget === null ? "none" : String(goal.tokenBudget);
  const timing = goalTiming(goal);
  const continuationStatus = continuation?.blocked
    ? `Automatic continuation: waiting after ${continuation.noProgressRetries} identical retries (${continuation.lastEvidenceSummary})`
    : `Automatic continuation: retry limit ${MAX_NO_PROGRESS_RETRIES}`;
  return [
    `Goal: ${goal.objective}`,
    `Status: ${goal.status}`,
    ...(goal.pauseReason ? [`Pause reason: ${goal.pauseReason}`] : []),
    ...(permissions?.blockers.length ? [
      `Permission hold: ${permissions.blockers.length} scope(s); ${permissions.recordCount} history records; retry ${permissions.retryPending ? "released once" : "held"}`,
      ...(permissions.saturated ? ["Permission observation incomplete: history/scope limit reached; release refused."] : []),
    ] : []),
    `Token budget: ${budget}`,
    `Tokens used: ${goal.usage.tokensUsed}`,
    `Active time: ${timing.activeSeconds}s`,
    `Elapsed time: ${timing.elapsedSeconds}s`,
    `Observable progress: ${stall?.state ?? "unknown"}`,
    continuationStatus,
    settings,
    ...(continuation?.blocked && goal.status === "active" ? ["Resume: /goal resume or alt+g"] : []),
    ...(goal.status === "paused"
      ? [agentResumable(goal, preferences.conversationalResume)
        ? 'Resume: say "go" (the agent calls goal_resume), /goal resume, or alt+g'
        : "Resume: /goal resume or alt+g"]
      : []),
  ].join("\n");
}

function formatPreferences(preferences: GoalPreferences): string {
  return [
    `Automatic continuation setting: ${preferences.autoContinue ? "on" : "off"}${WAKE_DISABLED ? " (disabled by environment)" : ""}`,
    `Conversational resume setting: ${preferences.conversationalResume ? "on" : "off"}`,
    `Pause on Esc setting: ${preferences.pauseOnEscape ? "on" : "off"}`,
  ].join("\n");
}

function formatSnapshot(snapshot: ActivitySnapshot): string {
  const providers = snapshot.providers.map((provider) => {
    const active = provider.items.filter((item) => item.active).length;
    const attention = provider.items.filter((item) => item.attention).length;
    return `${provider.label ?? provider.providerId}: ${active} active, ${attention} attention`;
  });
  return [
    `Activity: ${snapshot.category}`,
    `Foreground running: ${snapshot.foregroundRunning}`,
    `Background active: ${snapshot.activeBackgroundCount}`,
    `Background unhealthy: ${snapshot.unhealthyBackgroundCount}`,
    `Terminal attention: ${snapshot.terminalAttentionCount}`,
    ...providers,
  ].join("\n");
}

export default function (pi: ExtensionAPI): void {
  const providers = new Map<string, BackgroundActivityProvider>();
  const providerUnsubscribers = new Map<string, () => void>();
  providers.set("subagents", {
    id: "subagents",
    label: "Subagents",
    getActivity: () => collectSubagentActivity(),
  });

  let currentCtx: ExtensionContext | undefined;
  let executionGeneration = 0;
  let agentGeneration = -1;
  let turnGeneration = 0;
  let escapeAbortSuppression: { session: number; turn: number; execution: number } | undefined;
  let sessionGeneration = 0;
  let wakeGeneration = 0;
  let snapshotSequence = 0;
  let lastAppliedSnapshotSequence = 0;
  let foregroundRunning = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let collecting = false;
  let collectionPending = false;
  let latestSnapshot: ActivitySnapshot | null = null;
  let backgroundDrainTracker: BackgroundDrainTracker | null = null;
  let lastAttentionSignature = "";
  let continuationQueuedFor: string | null = null;
  let idleContinuationTimer: ReturnType<typeof setTimeout> | undefined;
  let idleContinuationSignature = "";
  let refreshGoalWidget: ((force?: boolean) => void) | undefined;
  let terminalInputUnsubscribe: (() => void) | undefined;
  let terminalInputIsEditor: (() => boolean) | undefined;
  let uiPromptDepth = 0;
  let lastAgentEvidence: ContinuationEvidence | null = null;
  let preferences: GoalPreferences = { autoContinue: true, conversationalResume: true, pauseOnEscape: true };
  /** Background items active when each pending blocking question started, keyed by tool call id. */
  const pendingQuestions = new Map<string, Map<string, BackgroundWorkItem>>();

  const getGoal = (ctx: ExtensionContext): GoalSnapshot | null => currentGoalSnapshot(ctx);
  const getWorkflow = (ctx: ExtensionContext) => currentWorkflowOwner(ctx.sessionManager.getBranch());
  const registeredSkillPath = (name: string): string | undefined =>
    pi.getCommands?.().find((item) => item.name === `skill:${name}` && item.source === "skill")?.sourceInfo.path;
  const workflowAvailable = (owner: NonNullable<ReturnType<typeof currentWorkflowOwner>>): boolean => {
    if (registeredSkillPath(owner.name) !== owner.path) return false;
    try {
      return workflowOwnerFromSkill(owner.name, owner.path)?.planOwner === owner.planOwner;
    } catch {
      return false;
    }
  };
  const recordWorkflow = (owner: ReturnType<typeof currentWorkflowOwner>): void => {
    pi.appendEntry(WORKFLOW_ENTRY_TYPE, workflowEntry(owner));
    pi.events.emit("pi-better-workflow:changed", owner);
  };

  /** Only active goals receive autonomous pokes; paused, complete, and budget-limited goals never do. */
  const isPokeable = (goal: GoalSnapshot | null): goal is GoalSnapshot => goal?.status === "active";

  const appendContinuationState = (state: ReturnType<typeof createContinuationState>): void => {
    pi.appendEntry(EXTENSION_NAME, continuationStateEntry(state));
  };

  const resetContinuationState = (goal: GoalSnapshot): void => {
    appendContinuationState(createContinuationState(goal.goalId));
  };

  const isForegroundBusy = (ctx: ExtensionContext): boolean =>
    foregroundRunning || !ctx.isIdle();

  /**
   * Chat `notify` appends lines above the Working/bash status region. While the
   * agent is streaming, that height change desyncs Pi main-screen differential
   * rendering and stacks "Working..." / "Elapsed Xs" into scrollback. Keep
   * mid-stream feedback out of the transcript; use the footer status instead.
   */
  const notifyGoal = (
    ctx: ExtensionContext,
    message: string,
    type: "info" | "warning" | "error" = "info",
  ): void => {
    if (!ctx.hasUI) {
      return;
    }
    if (isForegroundBusy(ctx) && type !== "error") {
      try {
        ctx.ui.setStatus(EXTENSION_NAME, message);
      } catch {
        // Footer status is best-effort only.
      }
      return;
    }
    ctx.ui.notify(message, type);
  };

  const setGoal = (goal: GoalSnapshot, ctx: ExtensionContext, source: GoalEntrySource): void => {
    const permissionHold = currentPermissionHold(ctx, goal.goalId);
    if (goal.status === "paused" && permissionHold.blockers.length > 0) {
      if (permissionHold.retryPending && permissionHold.recordCount < MAX_PERMISSION_RECORDS) {
        pi.appendEntry(EXTENSION_NAME, permissionRecord(goal.goalId, "permission-retry-finished"));
      }
      goal = { ...goal, pauseReason: "permission-blocker" };
    }
    executionGeneration += 1;
    lastAgentEvidence = null;
    const previous = getGoal(ctx);
    const wasVisible = previous !== null && isGoalClockVisible(previous);
    pi.appendEntry(EXTENSION_NAME, goalSetEntry(goal, source));
    continuationQueuedFor = null;
    backgroundDrainTracker = null;
    clearIdleContinuation();
    syncPollingState();
    syncResumeTool(goal);
    applyStatus(ctx);
    // Force a full redraw when the dock height changes (absent ↔ visible clock).
    refreshGoalWidget?.(!wasVisible || !isGoalClockVisible(goal));
  };

  const clearGoal = (ctx: ExtensionContext, source: GoalEntrySource): void => {
    executionGeneration += 1;
    lastAgentEvidence = null;
    const current = getGoal(ctx);
    const wasVisible = current !== null && isGoalClockVisible(current);
    pi.appendEntry(EXTENSION_NAME, goalClearEntry(current?.goalId ?? null, source));
    if (getWorkflow(ctx)) recordWorkflow(null);
    continuationQueuedFor = null;
    backgroundDrainTracker = null;
    clearIdleContinuation();
    syncPollingState();
    syncResumeTool(null);
    applyStatus(ctx);
    refreshGoalWidget?.(wasVisible);
  };

  /**
   * An interrupt (escape, or anything else that aborts the running turn) pauses
   * the goal. It stays paused while the user talks: messages are ordinary
   * conversation. It resumes through `/goal resume`, the hotkey, or the agent's
   * `goal_resume` once the user clearly says to proceed.
   */
  const pauseGoalOnInterrupt = (ctx: ExtensionContext): void => {
    const goal = getGoal(ctx);
    if (!isPokeable(goal)) {
      return;
    }
    const held = currentContinuationState(ctx, goal.goalId)?.blocked === true;
    setGoal(goalWithStatus(goal, "paused", undefined, held ? undefined : "interrupt"), ctx, "runtime");
    notifyGoal(ctx, currentPermissionHold(ctx, goal.goalId).blockers.length > 0
      ? "Goal remains permission-held. Use /goal resume or alt+g for one same-scope retry."
      : preferences.conversationalResume && !held
      ? 'Goal paused. Say "go" to resume it, or use /goal resume.'
      : "Goal paused. Use /goal resume or alt+g to resume it.");
  };

  const escapeAbortIsSuppressed = (): boolean =>
    escapeAbortSuppression?.session === sessionGeneration &&
    escapeAbortSuppression.turn === turnGeneration &&
    escapeAbortSuppression.execution === executionGeneration;

  /** Why a paused goal cannot become active again, or null when it can. */
  const resumeBlocker = (goal: GoalSnapshot, ctx: ExtensionContext): string | null => {
    if (!goal.command && skillCommandName(goal.objective)) {
      return "Invoke the skill directly; this legacy slash-command goal cannot resume as plain text.";
    }
    if (goal.command && !commandAvailable(pi, goal.command)) {
      return `Cannot resume: /${goal.command.name} is no longer registered at its original source.`;
    }
    if (goal.command?.source === "skill") {
      try {
        goalWorkflowOwner(goal);
      } catch (error) {
        return `Cannot resume: ${error instanceof Error ? error.message : String(error)} Reinvoke /${goal.command.name}.`;
      }
    }
    return null;
  };

  /** The workflow a skill-bound goal owns, re-resolved from its registered skill; null for other goals. */
  const goalWorkflowOwner = (goal: GoalSnapshot): ReturnType<typeof currentWorkflowOwner> =>
    goal.command?.source === "skill"
      ? workflowOwnerFromSkill(goal.command.name.slice("skill:".length), goal.command.path, registeredSkillPath)
      : null;

  /**
   * The one resume path shared by `/goal resume`, the hotkey, and `goal_resume`:
   * reactivate a paused goal or reopen an active no-progress hold.
   */
  const resumeGoal = (
    ctx: ExtensionContext,
    source: GoalEntrySource,
  ): { ok: true; goal: GoalSnapshot } | { ok: false; message: string } => {
    const current = getGoal(ctx);
    const held = current?.status === "active" && currentContinuationState(ctx, current.goalId)?.blocked === true;
    if (!current || (current.status !== "paused" && !held)) {
      return { ok: false, message: "Only paused or no-progress-held goals can be resumed." };
    }
    if (source === "tool" && currentContinuationState(ctx, current.goalId)?.blocked) {
      return { ok: false, message: "Only /goal resume or alt+g can reopen a no-progress hold." };
    }
    const blocker = resumeBlocker(current, ctx);
    if (blocker) {
      return { ok: false, message: blocker };
    }
    const goal = held ? current : goalWithStatus(current, "active");
    const permissions = currentPermissionHold(ctx, current.goalId);
    if (current.pauseReason === "permission-blocker" && permissions.blockers.length === 0) {
      return { ok: false, message: "Permission hold evidence is unavailable. The goal stays held; inspect the report before replacing this goal explicitly." };
    }
    if (permissions.blockers.length > 0) {
      if (source === "tool" || permissions.saturated) {
        return { ok: false, message: permissions.saturated
          ? "Permission hold history is full. The goal stays held; inspect it and create a new goal explicitly if needed."
          : "Only /goal resume or alt+g can release one permission retry." };
      }
      pi.appendEntry(EXTENSION_NAME, permissionRecord(current.goalId, "permission-release"));
    }
    // Resuming a skill-bound goal is explicit re-entry into its workflow: rebind the owner the
    // goal was created with (released by a handback) before the continuation runs.
    const owner = goalWorkflowOwner(current);
    const activeOwner = getWorkflow(ctx);
    if (owner && (activeOwner?.name !== owner.name || activeOwner.path !== owner.path)) recordWorkflow(owner);
    setGoal(goal, ctx, source);
    queueGoalContinuation(goal, ctx);
    return { ok: true, goal };
  };

  const boundCommandReady = (goal: GoalSnapshot, ctx: ExtensionContext): boolean => {
    if (!goal.command || commandAvailable(pi, goal.command)) return true;
    setGoal(goalWithStatus(goal, "paused"), ctx, "runtime");
    notifyGoal(ctx, `Goal paused: /${goal.command.name} is no longer registered at its original source.`, "error");
    return false;
  };

  const sendGoalContinuation = (goal: GoalSnapshot, content: string, kind: string, snapshot?: ActivitySnapshot): void => {
    if (goal.command?.source === "skill" || goal.command?.source === "prompt") {
      pi.sendUserMessage(`${commandInvocation(goal.command, true)}\n\n${content}`, {
        deliverAs: "followUp", expandPromptTemplates: true,
      });
    } else {
      pi.sendMessage({
        customType: EXTENSION_NAME, content, display: false,
        details: snapshot ? { kind, snapshot } : { kind, goalId: goal.goalId },
      }, { triggerTurn: true, deliverAs: "followUp" });
    }
  };

  const queueGoalContinuation = (goal: GoalSnapshot, ctx: ExtensionContext): void => {
    if (!isPokeable(goal) || continuationQueuedFor === goal.goalId) {
      return;
    }
    if (!boundCommandReady(goal, ctx)) return;
    clearIdleContinuation();
    continuationQueuedFor = goal.goalId;
    const permissions = currentPermissionHold(ctx, goal.goalId);
    if (permissions.blockers.length === 0) resetContinuationState(goal);
    sendGoalContinuation(goal, permissions.blockers.length > 0
      ? `${continuationPrompt(goal, getWorkflow(ctx))}\n\n${permissionInstruction(permissions)}`
      : continuationPrompt(goal, getWorkflow(ctx)), "continuation");
  };

  function clearIdleContinuation(): void {
    wakeGeneration += 1;
    if (idleContinuationTimer) {
      clearTimeout(idleContinuationTimer);
      idleContinuationTimer = undefined;
    }
    idleContinuationSignature = "";
  }

  const scheduleIdleContinuation = (
    goal: GoalSnapshot,
    ctx: ExtensionContext,
    kind: "continuation" | "background-drained",
    snapshot?: ActivitySnapshot,
  ): void => {
    if (WAKE_DISABLED || !preferences.autoContinue || !isPokeable(goal) || continuationQueuedFor === goal.goalId) {
      return;
    }
    if (currentPermissionHold(ctx, goal.goalId).blockers.length > 0) return;
    if (currentContinuationState(ctx, goal.goalId)?.blocked) {
      return;
    }
    const signature = `${goal.goalId}:${kind}`;
    if (idleContinuationTimer && (idleContinuationSignature === signature ||
        (kind === "continuation" && idleContinuationSignature === `${goal.goalId}:background-drained`))) {
      return;
    }
    clearIdleContinuation();
    idleContinuationSignature = signature;
    idleContinuationTimer = setTimeout(() => {
      idleContinuationTimer = undefined;
      idleContinuationSignature = "";
      void sendIdleContinuationAfterAudit(goal.goalId, ctx, kind, snapshot);
    }, idleContinuationDelay(kind === "continuation" ? currentContinuationState(ctx, goal.goalId)?.noProgressRetries ?? 0 : 0));
    idleContinuationTimer.unref?.();
  };

  const sendIdleContinuationAfterAudit = async (
    goalId: string,
    ctx: ExtensionContext,
    kind: "continuation" | "background-drained",
    priorSnapshot?: ActivitySnapshot,
  ): Promise<void> => {
    const execution = executionGeneration;
    const wake = wakeGeneration;
    const auditIsCurrent = (): boolean => {
      if (WAKE_DISABLED || !preferences.autoContinue || execution !== executionGeneration || wake !== wakeGeneration) return false;
      const current = currentGoalSnapshot(ctx);
      return isPokeable(current) && current.goalId === goalId &&
        currentPermissionHold(ctx, goalId).blockers.length === 0 &&
        !currentContinuationState(ctx, goalId)?.blocked &&
        continuationQueuedFor !== goalId && !isForegroundBusy(ctx);
    };
    const goal = currentGoalSnapshot(ctx);
    if (!auditIsCurrent() || !isPokeable(goal)) return;
    if (!boundCommandReady(goal, ctx)) return;
    const snapshot = await publishSnapshot(ctx);
    if (!snapshot || !auditIsCurrent() || snapshot.foregroundRunning || snapshot.backgroundRunning) return;

    continuationQueuedFor = goal.goalId;
    const content = kind === "background-drained"
      ? "Background activity for the active goal is no longer running. Inspect any subagent callbacks or final results, then continue the completion audit before marking the goal complete.\n\n" +
        continuationPrompt(goal, getWorkflow(ctx))
      : continuationPrompt(goal, getWorkflow(ctx));
    sendGoalContinuation(goal, content, kind, kind === "background-drained" ? priorSnapshot ?? snapshot : undefined);
  };

  const startOrReplaceGoal = (
    objective: string,
    tokenBudget: number | null,
    ctx: ExtensionContext,
    source: "command",
  ): GoalSnapshot => {
    const objectiveError = validateObjective(objective);
    if (objectiveError) {
      throw new Error(objectiveError);
    }
    const budgetError = validateTokenBudget(tokenBudget);
    if (budgetError) {
      throw new Error(budgetError);
    }
    const command = resolveGoalCommand(pi, objective);
    if (command && !commandAvailable(pi, command)) {
      throw new Error(`Command /${command.name} is unavailable at its registered source.`);
    }
    const goal = createGoalSnapshot(objective.trim(), tokenBudget, undefined, command ?? undefined);
    const owner = command?.source === "skill"
      ? workflowOwnerFromSkill(command.name.slice("skill:".length), command.path, registeredSkillPath)
      : null;
    if (getWorkflow(ctx)) recordWorkflow(null);
    setGoal(goal, ctx, source);
    if (command) {
      if (owner) recordWorkflow(owner);
      pi.sendUserMessage(commandInvocation(command), { deliverAs: "followUp", expandPromptTemplates: true });
      if (command.source === "extension") scheduleIdleContinuation(goal, ctx, "continuation");
    } else {
      queueGoalContinuation(goal, ctx);
    }
    return goal;
  };

  const publishSnapshot = async (ctx: ExtensionContext): Promise<ActivitySnapshot | null> => {
    const execution = executionGeneration;
    const sequence = ++snapshotSequence;
    const snapshot = await collectActivitySnapshot(ctx, providers.values(), foregroundRunning);
    if (execution !== executionGeneration) return null;
    if (sequence < lastAppliedSnapshotSequence) return latestSnapshot;
    lastAppliedSnapshotSequence = sequence;
    latestSnapshot = snapshot;

    const goal = currentGoalSnapshot(ctx);
    const wakePlan = planBackgroundDrainWake(backgroundDrainTracker, goal, snapshot);
    backgroundDrainTracker = wakePlan.nextTracker;
    if (isPokeable(goal) && wakePlan.wakeSignature && currentPermissionHold(ctx, goal.goalId).blockers.length === 0 &&
        !currentContinuationState(ctx, goal.goalId)?.blocked) {
      // Persist external progress now: a foreground/callback turn may cancel its delayed wake.
      clearIdleContinuation();
      resetContinuationState(goal);
      lastAgentEvidence = null;
      scheduleIdleContinuation(goal, ctx, "background-drained", snapshot);
    }

    if (snapshot.foregroundRunning || snapshot.backgroundRunning) {
      clearIdleContinuation();
    }

    pi.events.emit(EVENT_ACTIVITY, snapshot);
    if (execution !== executionGeneration) return null;
    const attention = terminalAttentionSignature(snapshot);
    if (attention && attention !== lastAttentionSignature) {
      lastAttentionSignature = attention;
      pi.events.emit(EVENT_TERMINAL_ATTENTION, snapshot);
      if (execution !== executionGeneration) return null;
    }
    applyStatus(ctx);

    return snapshot;
  };

  /** Footer status from the goal state and the latest activity snapshot. */
  const statusText = (ctx: ExtensionContext, snapshot: ActivitySnapshot | null): string | undefined => {
    const goal = getGoal(ctx);
    let waitingOnAnswer = 0;
    if (snapshot) {
      for (const activeAtStart of pendingQuestions.values()) {
        waitingOnAnswer += finishedSinceQuestion(activeAtStart, snapshot).length;
      }
    }
    if (waitingOnAnswer > 0) return `${waitingOnAnswer} background done; waiting on your answer`;
    const background = snapshot?.backgroundRunning
      ? `bg ${snapshot.activeBackgroundCount}${snapshot.unhealthyBackgroundCount ? `, ${snapshot.unhealthyBackgroundCount} unhealthy` : ""}`
      : undefined;
    if (goal?.status === "paused") return background ? `${pausedGoalStatus(goal, preferences.conversationalResume)} · ${background}` : pausedGoalStatus(goal, preferences.conversationalResume);
    if (background) return background;
    const continuation = goal ? currentContinuationState(ctx, goal.goalId) : null;
    if (continuation?.blocked) return "waiting: no progress";
    const goalStall = observeGoalStall(goal, continuation, {
      foregroundRunning,
      backgroundRunning: snapshot?.backgroundRunning ?? false,
    });
    return goalStall?.state === "stalled" ? "goal stalled" : undefined;
  };

  function applyStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.setStatus(EXTENSION_NAME, statusText(ctx, latestSnapshot));
    } catch {
      // UI status is best-effort only.
    }
  }

  /**
   * `goal_resume` is in the model's tool list only while an escape-paused goal
   * waits. Pi activates newly registered tools by default, so this also removes
   * it at session start. Only this one tool is toggled; other extensions' tool
   * choices are left as they are.
   */
  function syncResumeTool(goal: GoalSnapshot | null): void {
    if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
    try {
      const active = pi.getActiveTools();
      const wanted = agentResumable(goal, preferences.conversationalResume);
      if (active.includes(GOAL_RESUME_TOOL) === wanted) return;
      pi.setActiveTools(wanted ? [...active, GOAL_RESUME_TOOL] : active.filter((name) => name !== GOAL_RESUME_TOOL));
    } catch {
      // Tool activation is unavailable before Pi binds the session; the tool also refuses on its own.
    }
  }

  const collectIfPossible = (): void => {
    const ctx = currentCtx;
    if (!ctx) {
      return;
    }
    if (collecting) {
      collectionPending = true;
      return;
    }
    collecting = true;
    const session = sessionGeneration;
    void publishSnapshot(ctx).finally(() => {
      if (session !== sessionGeneration) return;
      collecting = false;
      if (collectionPending) {
        collectionPending = false;
        collectIfPossible();
      } else {
        syncPollingState();
      }
    });
  };

  const startPolling = (): void => {
    if (pollTimer) {
      return;
    }
    pollTimer = setInterval(collectIfPossible, POLL_INTERVAL_MS);
    pollTimer.unref?.();
  };

  const stopPolling = (): void => {
    if (!pollTimer) {
      return;
    }
    clearInterval(pollTimer);
    pollTimer = undefined;
  };

  const syncPollingState = (): void => {
    const ctx = currentCtx;
    const goal = ctx ? currentGoalSnapshot(ctx) : null;
    if (ctx && (isPokeable(goal) || latestSnapshot?.backgroundRunning === true)) {
      startPolling();
    } else {
      stopPolling();
    }
  };

  const installGoalWidget = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) {
      return;
    }
    ctx.ui.setWidget(
      EXTENSION_NAME,
      (tui, theme) => {
        const inputIsEditor = (): boolean => {
          const focus = tui as typeof tui & { getFocusedComponent?(): Partial<CustomEditor> | null };
          if (typeof focus.getFocusedComponent !== "function" || tui.hasOverlay()) return false;
          // Duck typing survives Pi's bundled/jiti module boundaries. Unknown
          // custom editors and dialog components keep ownership of Escape.
          const editor = focus.getFocusedComponent();
          return typeof editor?.onEscape === "function" &&
            typeof editor.isShowingAutocomplete === "function" && !editor.isShowingAutocomplete();
        };
        terminalInputIsEditor = inputIsEditor;
        const requestRender = (force = false): void => {
          try {
            tui.requestRender(force);
          } catch {
            // UI paint is best-effort only.
          }
        };
        const scheduler = createRenderScheduler(() => requestRender(false));
        const refresh = (force = false): void => {
          if (force) {
            scheduler.cancel();
            // Height transitions must reset main-screen differential state so
            // Working/Elapsed lines keep rewriting in place instead of stacking.
            requestRender(true);
            return;
          }
          scheduler.request();
        };
        refreshGoalWidget = refresh;

        return {
          dispose() {
            scheduler.dispose();
            if (terminalInputIsEditor === inputIsEditor) terminalInputIsEditor = undefined;
            if (refreshGoalWidget === refresh) {
              refreshGoalWidget = undefined;
            }
          },
          invalidate() {},
          render(width: number): string[] {
            const goal = getGoal(ctx);
            scheduler.cancel();
            if (!goal || !isGoalClockVisible(goal)) {
              return [];
            }
            const nextRenderDelay = goalClockRefreshDelayMs(goal);
            if (nextRenderDelay !== null) scheduler.schedule(nextRenderDelay);
            const fg = typeof theme?.fg === "function"
              ? (color: string, value: string) => theme.fg(color as never, value)
              : undefined;
            return [renderGoalClockLine(goal, width, undefined, fg), ""];
          },
        };
      },
      { placement: "aboveEditor" },
    );
  };

  pi.events.on(EVENT_REGISTER_PROVIDER, (provider) => {
    const candidate = provider as Partial<BackgroundActivityProvider> | undefined;
    if (!candidate || typeof candidate.id !== "string" || typeof candidate.getActivity !== "function") {
      return;
    }
    const accepted = candidate as BackgroundActivityProvider;
    providerUnsubscribers.get(accepted.id)?.();
    providerUnsubscribers.delete(accepted.id);
    providers.set(accepted.id, accepted);
    if (typeof accepted.onActivityChanged === "function") {
      providerUnsubscribers.set(accepted.id, accepted.onActivityChanged(collectIfPossible));
    }
    if (latestSnapshot) collectIfPossible();
  });

  const changePreference = async (ctx: ExtensionCommandContext, key: keyof GoalPreferences, enabled: boolean): Promise<void> => {
    const previous = preferences;
    preferences = writeGoalPreference(key, enabled);
    if (previous.autoContinue !== preferences.autoContinue) clearIdleContinuation();
    syncResumeTool(getGoal(ctx));
    applyStatus(ctx);
    if (!previous.autoContinue && preferences.autoContinue) {
      const snapshot = await publishSnapshot(ctx);
      const goal = getGoal(ctx);
      if (snapshot && isPokeable(goal) && !isForegroundBusy(ctx) && !snapshot.backgroundRunning) {
        scheduleIdleContinuation(goal, ctx, "continuation", snapshot);
      }
    }
  };
  const openSettings = async (ctx: ExtensionCommandContext): Promise<void> => {
    currentCtx = ctx;
    if (ctx.hasUI && ctx.mode !== "rpc" && typeof ctx.ui.custom === "function") {
      await ctx.ui.custom<void>((tui, theme, _kb, done) => createGoalSettingsPage(theme, {
        get: () => ({ ...preferences }),
        change: (key, enabled) => changePreference(ctx, key, enabled),
      }, () => tui.requestRender(), () => done()));
    } else {
      ctx.ui.notify(`${formatPreferences(preferences)}\nPreferences: ${goalPreferencesPath()}`, "info");
    }
  };
  const contribution = { id: "goal", label: "Goal", command: "/goal settings", open: openSettings };
  const registerSettings = () => pi.events.emit("harness-settings:register", contribution);
  const unsubscribeSettingsRequest = pi.events.on("harness-settings:request", registerSettings);
  registerSettings();

  pi.registerCommand("goal", {
    description: "Create, inspect, pause, resume, clear, or complete the active goal; configure persistent goal settings",
    getArgumentCompletions: goalArgumentCompletions,
    handler: async (args, ctx) => {
      currentCtx = ctx;
      const trimmed = args.trim();
      const current = getGoal(ctx);

      if (trimmed === "settings" || trimmed.startsWith("settings ")) {
        if (trimmed === "settings") {
          await openSettings(ctx);
          return;
        }
        const [, setting, mode, ...extra] = trimmed.split(/\s+/);
        if (setting !== undefined && (!GOAL_SETTINGS.includes(setting as typeof GOAL_SETTINGS[number]) ||
            (mode !== "on" && mode !== "off") || extra.length > 0)) {
          notifyGoal(ctx, "Usage: /goal settings [auto-continue|conversational-resume|pause-on-escape on|off]", "warning");
          return;
        }
        if (setting !== undefined) {
          try {
            const key = setting === "auto-continue" ? "autoContinue"
              : setting === "conversational-resume" ? "conversationalResume" : "pauseOnEscape";
            await changePreference(ctx, key, mode === "on");
          } catch (error) {
            notifyGoal(ctx, error instanceof Error ? error.message : String(error), "error");
            return;
          }
        }
        ctx.ui.notify(`${formatPreferences(preferences)}\nPreferences: ${goalPreferencesPath()}`, "info");
        return;
      }

      if (!trimmed) {
        const continuation = current ? currentContinuationState(ctx, current.goalId) : null;
        // Inspection is always explicit user intent; show the full summary even while busy.
        ctx.ui.notify(formatGoal(current, continuation, observeGoalStall(current, continuation, { foregroundRunning }), preferences,
          current ? currentPermissionHold(ctx, current.goalId) : null), "info");
        return;
      }

      if (trimmed === "pause") {
        if (!current || current.status !== "active") {
          notifyGoal(ctx, "Only active goals can be paused.", "warning");
          return;
        }
        setGoal(goalWithStatus(current, "paused"), ctx, "command");
        notifyGoal(ctx, "Goal paused.");
        return;
      }

      if (trimmed === "resume") {
        const result = resumeGoal(ctx, "command");
        if (!result.ok) {
          notifyGoal(ctx, result.message, current?.status === "paused" ? "error" : "warning");
          return;
        }
        notifyGoal(ctx, "Goal resumed.");
        return;
      }

      if (trimmed === "clear") {
        clearGoal(ctx, "command");
        notifyGoal(ctx, "Goal cleared.");
        return;
      }

      if (trimmed === "complete") {
        if (!current) {
          notifyGoal(ctx, "No goal is set.", "warning");
          return;
        }
        setGoal(goalWithStatus(current, "complete"), ctx, "command");
        if (getWorkflow(ctx)) recordWorkflow(null);
        notifyGoal(ctx, "Goal marked complete.");
        return;
      }

      // Confirm dialogs swap the editor and reflow the dock. While the agent is
      // streaming that desyncs main-screen differential paints, so replace
      // silently mid-turn and only confirm when idle.
      if (current && current.status !== "complete" && ctx.hasUI && !isForegroundBusy(ctx)) {
        const replace = await ctx.ui.confirm(
          "Replace active goal?",
          `Current goal: ${flattenObjectiveForRail(current.objective)}`,
        );
        if (!replace) {
          return;
        }
      }

      try {
        const goal = startOrReplaceGoal(trimmed, null, ctx, "command");
        notifyGoal(ctx, `Goal set: ${flattenObjectiveForRail(goal.objective)}`);
      } catch (error) {
        notifyGoal(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Inspect the current pi-better-goal objective, status, and timing.",
    promptSnippet: "Inspect the current goal, status, token budget, tokens used, active time, and total elapsed time.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const goal = getGoal(ctx);
      const continuation = goal ? currentContinuationState(ctx, goal.goalId) : null;
      const stall = observeGoalStall(goal, continuation, {
        foregroundRunning,
        backgroundRunning: latestSnapshot?.backgroundRunning ?? false,
      });
      return {
        content: [{ type: "text", text: formatGoal(goal, continuation, stall, preferences, goal ? currentPermissionHold(ctx, goal.goalId) : null) }],
        details: { goal, continuation, permissionHold: goal ? currentPermissionHold(ctx, goal.goalId) : null, stall, preferences: { ...preferences }, timing: goal ? goalTiming(goal) : null, hasGoal: goal !== null },
      };
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description: "Mark the current pi-better-goal objective complete after a completion audit.",
    promptSnippet: "Mark the current Codex-style goal complete after verification.",
    parameters: Type.Object({
      status: Type.String({ description: "Only 'complete' is accepted." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = params as { status: string };
      if (input.status !== "complete") {
        return {
          content: [{ type: "text", text: "Only status:'complete' is accepted." }],
          details: { ok: false, goal: getGoal(ctx) },
        };
      }
      const current = getGoal(ctx);
      if (!current) {
        return {
          content: [{ type: "text", text: "No goal is set." }],
          details: { ok: false, goal: null },
        };
      }
      if (current.status === "complete") {
        return {
          content: [{ type: "text", text: "Goal already complete." }],
          details: { ok: true, goal: current },
        };
      }
      const goal = goalWithStatus(current, "complete");
      setGoal(goal, ctx, "tool");
      if (getWorkflow(ctx)) recordWorkflow(null);
      return {
        content: [{ type: "text", text: "Goal marked complete." }],
        details: { ok: true, goal },
      };
    },
  });

  pi.registerTool({
    name: GOAL_RESUME_TOOL,
    label: "Resume Goal",
    description:
      "Resume the goal the user paused with escape, or one its workflow handed back, exactly like /goal resume. " + GOAL_RESUME_RULE,
    promptSnippet: "Resume the escape-paused or handed-back goal, only on the user's clear go-ahead.",
    parameters: Type.Object({
      reason: Type.Optional(Type.String({ description: "Short quote or summary of the user's go-ahead." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const reason = (params as { reason?: string }).reason;
      const current = getGoal(ctx);
      if (!preferences.conversationalResume) {
        return {
          content: [{ type: "text", text: "Conversational goal resume is disabled. Only the user can resume with /goal resume or alt+g." }],
          details: { ok: false, goal: current },
        };
      }
      if (!agentResumable(current, preferences.conversationalResume)) {
        const text = current?.status === "paused"
          ? "This goal was paused with /goal pause or by the runtime. Only the user can resume it, with /goal resume."
          : "No goal is paused, so there is nothing to resume.";
        return { content: [{ type: "text", text }], details: { ok: false, goal: current } };
      }
      const result = resumeGoal(ctx, "tool");
      if (!result.ok) {
        return { content: [{ type: "text", text: `Goal stays paused. ${result.message}` }], details: { ok: false, goal: getGoal(ctx) } };
      }
      return {
        content: [{ type: "text", text: "Goal resumed. Its continuation runs after this turn." }],
        details: { ok: true, goal: result.goal, ...(reason ? { reason } : {}) },
      };
    },
  });

  pi.registerShortcut?.(GOAL_RESUME_SHORTCUT, {
    description: "Resume the paused goal",
    handler: (ctx) => {
      currentCtx = ctx;
      const result = resumeGoal(ctx, "command");
      notifyGoal(ctx, result.ok ? "Goal resumed." : result.message, result.ok ? "info" : "warning");
    },
  });

  pi.registerCommand("better-activity", {
    description: "Show foreground/background activity known to pi-better-goal",
    handler: async (_args, ctx) => {
      currentCtx = ctx;
      const snapshot = await publishSnapshot(ctx);
      if (!snapshot) return;
      ctx.ui.notify(formatSnapshot(snapshot), "info");
    },
  });

  pi.registerCommand("workflow", {
    description: "Inspect or clear the active skill-owned workflow",
    handler: async (args, ctx) => {
      if (args.trim() === "clear") {
        recordWorkflow(null);
        notifyGoal(ctx, "Workflow ownership cleared.");
        return;
      }
      const owner = getWorkflow(ctx);
      notifyGoal(ctx, owner ? `Workflow: ${owner.name} (${owner.path}); plan owned by workflow.` : "No workflow owns this session.");
    },
  });

  pi.registerTool({
    name: "release_workflow",
    label: "Release Workflow",
    description: "Release the active skill-owned workflow when it hands back unfinished work (a blocked unit awaiting the human). Its bound active Goal pauses; /goal resume rebinds the workflow. When the workflow is done, call update_goal complete instead, which also releases it.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const owner = getWorkflow(ctx);
      if (!owner) return { content: [{ type: "text", text: "No workflow owns this session." }], details: { released: false } };
      const goal = getGoal(ctx);
      let resumeCommand: string | undefined;
      if (goal?.status === "active" && goal.command?.source === "skill") {
        const boundOwner = workflowOwnerFromSkill(goal.command.name.slice("skill:".length), goal.command.path, registeredSkillPath);
        if (boundOwner?.name === owner.name && boundOwner.path === owner.path) {
          setGoal(goalWithStatus(goal, "paused", undefined, "handback"), ctx, "tool");
          resumeCommand = goal.command.name;
        }
      }
      recordWorkflow(null);
      return {
        content: [{ type: "text", text: `Released ${owner.name} workflow ownership.${resumeCommand ? ` Its Goal is paused, not complete; the user's go-ahead or /goal resume rebinds /${resumeCommand}.` : ""}` }],
        details: { released: true, owner: owner.name, goalPaused: resumeCommand !== undefined },
      };
    },
  });

  pi.registerTool({
    name: "get_background_activity",
    label: "Get Background Activity",
    description: "Inspect foreground/background activity known to pi-better-goal.",
    promptSnippet: "Inspect active background work such as async subagents",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      currentCtx = ctx;
      const snapshot = await publishSnapshot(ctx);
      if (!snapshot) {
        return { content: [{ type: "text", text: "Activity changed during collection; inspect again." }], details: { stale: true } };
      }
      return {
        content: [{ type: "text", text: formatSnapshot(snapshot) }],
        details: snapshot,
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    terminalInputUnsubscribe?.();
    terminalInputUnsubscribe = undefined;
    terminalInputIsEditor = undefined;
    uiPromptDepth = 0;
    executionGeneration += 1;
    sessionGeneration += 1;
    escapeAbortSuppression = undefined;
    clearIdleContinuation();
    continuationQueuedFor = null;
    backgroundDrainTracker = null;
    lastAgentEvidence = null;
    collecting = false;
    collectionPending = false;
    currentCtx = ctx;
    foregroundRunning = !ctx.isIdle();
    try {
      preferences = readGoalPreferences();
    } catch (error) {
      notifyGoal(ctx, error instanceof Error ? error.message : String(error), "error");
    }
    const restoredGoal = getGoal(ctx);
    if (restoredGoal?.status === "active" && currentPermissionHold(ctx, restoredGoal.goalId).blockers.length > 0) {
      // A persisted release is not a replayable dispatch ticket after reload.
      setGoal(goalWithStatus(restoredGoal, "paused", undefined, "permission-blocker"), ctx, "runtime");
    }
    if (restoredGoal?.status === "active" && !restoredGoal.command && skillCommandName(restoredGoal.objective)) {
      setGoal(goalWithStatus(restoredGoal, "paused"), ctx, "runtime");
      notifyGoal(ctx, "Goal paused: invoke its skill directly before resuming.", "error");
    }
    pi.events.emit(EVENT_READY, { version: EXTENSION_VERSION });
    syncResumeTool(getGoal(ctx));
    installGoalWidget(ctx);
    if (ctx.mode === "tui" && ctx.hasUI && typeof ctx.ui.onTerminalInput === "function") {
      const session = sessionGeneration;
      terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
        if (session === sessionGeneration && uiPromptDepth === 0 &&
            !isKeyRelease(data) && matchesKey(data, "escape") && terminalInputIsEditor?.()) {
          if (preferences.pauseOnEscape) {
            pauseGoalOnInterrupt(ctx);
          } else if (foregroundRunning) {
            // The original key reaches Pi next and may abort this run. Preserve
            // this keypress's choice through both abort notifications only.
            escapeAbortSuppression = { session, turn: turnGeneration, execution: executionGeneration };
          }
        }
        // Observe only: Pi must still interrupt streams or handle editor Escape.
        return undefined;
      });
    }
    const snapshot = await publishSnapshot(ctx);
    if (!snapshot) return;
    syncPollingState();
    if (restoredGoal?.status === "active" && restoredGoal.command && boundCommandReady(restoredGoal, ctx) && !foregroundRunning && !snapshot.backgroundRunning) {
      scheduleIdleContinuation(restoredGoal, ctx, "continuation");
    }
  });

  pi.on("ui_prompt_start", () => { uiPromptDepth += 1; });
  pi.on("ui_prompt_end", () => { uiPromptDepth = Math.max(0, uiPromptDepth - 1); });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") {
      return;
    }
    const skillName = skillCommandName(event.text ?? "");
    if (skillName) {
      const command = pi.getCommands?.().find((item) => item.name === `skill:${skillName}` && item.source === "skill");
      if (command) {
        try {
          const owner = workflowOwnerFromSkill(skillName, command.sourceInfo.path, registeredSkillPath);
          if (owner) recordWorkflow(owner);
        } catch (error) {
          notifyGoal(ctx, error instanceof Error ? error.message : String(error), "error");
          return { action: "handled" as const };
        }
      }
    }
    // A paused goal stays paused while the user talks: the message is ordinary
    // conversation. Only /goal resume, the hotkey, or goal_resume resume it.
    const goal = getGoal(ctx);
    if (goal?.status === "active" && currentPermissionHold(ctx, goal.goalId).blockers.length === 0 &&
        !currentContinuationState(ctx, goal.goalId)?.blocked) {
      executionGeneration += 1;
      clearIdleContinuation();
      lastAgentEvidence = null;
      resetContinuationState(goal);
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    currentCtx = ctx;
    const goal = currentGoalSnapshot(ctx);
    const owner = getWorkflow(ctx);
    const snapshot = await publishSnapshot(ctx);
    if (!snapshot) return;
    const permissions = goal ? currentPermissionHold(ctx, goal.goalId) : null;
    const permissionPrompt = permissions && goal?.status !== "complete" &&
      (permissions.blockers.length > 0 || goal?.pauseReason === "permission-blocker")
      ? permissionInstruction({ ...permissions, retryPending: permissions.retryPending && goal?.status === "active" }) +
        (permissions.blockers.length === 0 ? "\nBlocker evidence is unavailable. Stay held; do not invent a retry scope." : "") : "";
    // A held goal overrides workflow ownership without invoking or invalidating that workflow.
    if (permissionPrompt && goal?.status === "paused") {
      return { systemPrompt: `${event.systemPrompt}\n\n${permissionPrompt}` };
    }
    const pausedInstruction = permissionPrompt || (goal?.status === "paused" && (goal.pauseReason === "interrupt" || goal.pauseReason === "handback")
      ? pausedGoalPrompt(goal, preferences.conversationalResume) : "");
    if (!isPokeable(goal) && !owner) {
      return pausedInstruction ? { systemPrompt: `${event.systemPrompt}\n\n${pausedInstruction}` } : undefined;
    }

    const questionInstruction = snapshot.backgroundRunning
      ? " A blocking user question (ask_user_question) holds this whole turn until the user answers, and background completions wait behind it. Harvest finished background results before asking, and ask only when the answer is needed to proceed."
      : "";
    const heldInstruction = goal?.status === "active" && currentContinuationState(ctx, goal.goalId)?.blocked
      ? "Automatic Goal continuation is held for no progress. Answer the current user message or inspect delivered background results without restarting autonomous Goal work. Only /goal resume or alt+g reopens this hold."
      : "";

    if (owner) {
      if (!workflowAvailable(owner)) {
        if (isPokeable(goal)) setGoal(goalWithStatus(goal, "paused"), ctx, "runtime");
        recordWorkflow(null);
        return { systemPrompt: `${event.systemPrompt}\n\nWorkflow ${owner.name} is no longer a registered, valid skill. Stop work and ask the user to reinvoke the skill.` };
      }
      let instructions: string;
      try {
        instructions = readFileSync(owner.path, "utf8");
      } catch {
        if (isPokeable(goal)) setGoal(goalWithStatus(goal, "paused"), ctx, "runtime");
        return { systemPrompt: `${event.systemPrompt}\n\nWorkflow ${owner.name} is unavailable. Stop work and ask the user to restore or reinvoke the skill.` };
      }
      return {
        systemPrompt: `${event.systemPrompt}\n\n` +
          (pausedInstruction
            ? `${pausedInstruction}\n` + (permissionPrompt
              ? "These permission constraints override the workflow instructions below.\n\n"
              : "While the goal is paused, this overrides the workflow instructions below: do not advance the workflow until the goal is resumed.\n\n")
            : "") +
          `Active workflow: ${owner.name} (${owner.path}). Its task plan owns planning and the parent is a coordinator, not a product-code implementer. Follow the workflow instructions below, including on resumed turns:\n\n${instructions}` +
          (isPokeable(goal) ? `\n\nActive objective: ${goal.objective}. Complete it only after the workflow completion audit.` : "") +
          (questionInstruction ? `\n\n${questionInstruction.trim()}` : "") +
          (heldInstruction ? `\n\n${heldInstruction}` : ""),
      };
    }

    if (!isPokeable(goal)) return;
    const backgroundInstruction = snapshot.backgroundRunning
      ? ` The goal still has delegated background work running (${summarizeActiveBackground(snapshot)}). Foreground idleness alone is not goal completion; keep any structured plan current and do not mark verification, the plan, or the goal complete until every relevant delegated task reaches a terminal state and its result or failure has been inspected and integrated.`
      : "";
    return {
      systemPrompt:
        `${event.systemPrompt}\n\n` +
        `Pi Better Goal active objective: ${goal.objective}. ${heldInstruction || "Keep working through clear low-risk next steps, and mark complete only after an evidence-backed completion audit."}${backgroundInstruction}${questionInstruction}` +
        (permissionPrompt ? `\n\n${permissionPrompt}` : ""),
    };
  });

  pi.on("agent_start", async (_event, ctx) => {
    executionGeneration += 1;
    turnGeneration += 1;
    escapeAbortSuppression = undefined;
    agentGeneration = executionGeneration;
    currentCtx = ctx;
    foregroundRunning = true;
    clearIdleContinuation();
    continuationQueuedFor = null;
    lastAgentEvidence = null;
    const turnSignal = ctx.signal;
    if (turnSignal) {
      const session = sessionGeneration;
      const turn = turnGeneration;
      const onAbort = (): void => {
        if (session !== sessionGeneration || turn !== turnGeneration) return;
        if (!escapeAbortIsSuppressed()) pauseGoalOnInterrupt(ctx);
      };
      if (turnSignal.aborted) {
        onAbort();
      } else {
        turnSignal.addEventListener("abort", onAbort, { once: true });
      }
    }
    await publishSnapshot(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    lastAgentEvidence = agentGeneration === executionGeneration ? continuationEvidence(event.messages) : null;
    // Only an observed editor Escape with pause disabled exempts this abort.
    // Unknown interrupt sources retain the safety fallback on every host.
    if (wasTurnAborted(event.messages) && !escapeAbortIsSuppressed()) {
      pauseGoalOnInterrupt(ctx);
    }
    escapeAbortSuppression = undefined;
  });

  pi.on("tool_result", (event, ctx) => {
    const goal = getGoal(ctx);
    if (!goal || (goal.status !== "active" && goal.status !== "paused")) return;
    const reports = reportedPermissionBlockers(pi, event.toolName, event.details);
    const incomplete = reportedPermissionGap(pi, event.toolName, event.details);
    if (reports.length === 0 && !incomplete) return;
    let hold = currentPermissionHold(ctx, goal.goalId);
    let changed = false;
    for (const blocker of reports) {
      const previous = hold.blockers.find((item) => logicalPermissionBlockerKey(item) === logicalPermissionBlockerKey(blocker));
      if (!hold.retryPending && previous && JSON.stringify(previous) === JSON.stringify(blocker)) continue;
      if (hold.saturated || (!previous && hold.blockers.length >= MAX_PERMISSION_BLOCKERS)) {
        if (!hold.saturated && hold.recordCount < MAX_PERMISSION_RECORDS) {
          pi.appendEntry(EXTENSION_NAME, permissionRecord(goal.goalId, "permission-gap"));
        }
        break;
      }
      pi.appendEntry(EXTENSION_NAME, permissionHoldRecord(goal.goalId, blocker));
      changed = true;
      hold = currentPermissionHold(ctx, goal.goalId);
    }
    if (incomplete && !hold.saturated && hold.recordCount < MAX_PERMISSION_RECORDS) {
      pi.appendEntry(EXTENSION_NAME, permissionRecord(goal.goalId, "permission-gap"));
      changed = true;
      hold = currentPermissionHold(ctx, goal.goalId);
    }
    if (hold.retryPending && hold.recordCount < MAX_PERMISSION_RECORDS) {
      pi.appendEntry(EXTENSION_NAME, permissionRecord(goal.goalId, "permission-retry-finished"));
    }
    if (!changed && goal.status === "paused" && goal.pauseReason === "permission-blocker") return;
    setGoal(goalWithStatus(goal, "paused", undefined, "permission-blocker"), ctx, "runtime");
    notifyGoal(ctx, "Goal held for a permission blocker. /goal resume or alt+g releases one same-scope retry.", "warning");
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    if (!BLOCKING_QUESTION_TOOLS.has(event.toolName)) return;
    currentCtx = ctx;
    const snapshot = await publishSnapshot(ctx);
    if (!snapshot) return;
    const active = activeItemsByKey(snapshot);
    if (active.size > 0) pendingQuestions.set(event.toolCallId, active);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    const activeAtStart = pendingQuestions.get(event.toolCallId);
    if (!activeAtStart) return;
    pendingQuestions.delete(event.toolCallId);
    currentCtx = ctx;
    const snapshot = await publishSnapshot(ctx);
    if (!snapshot) return;
    const finished = finishedSinceQuestion(activeAtStart, snapshot);
    if (finished.length === 0) return;
    // Steering is drained right after this tool batch, so the model sees the
    // finished work together with the user's answer instead of after the run.
    pi.sendMessage({
      customType: EXTENSION_NAME,
      content: questionHarvestPrompt(finished),
      display: false,
      details: { kind: "question-harvest", toolCallId: event.toolCallId, finished: finished.map((item) => ({ id: item.id, status: item.status })) },
    }, { deliverAs: "steer", triggerTurn: true });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    executionGeneration += 1;
    escapeAbortSuppression = undefined;
    currentCtx = ctx;
    foregroundRunning = false;
    const snapshot = await publishSnapshot(ctx);
    if (!snapshot) return;
    const goal = getGoal(ctx);
    if (isPokeable(goal)) {
      const permissions = currentPermissionHold(ctx, goal.goalId);
      if (permissions.blockers.length > 0) {
        if (permissions.retryPending && permissions.recordCount < MAX_PERMISSION_RECORDS) {
          pi.appendEntry(EXTENSION_NAME, permissionRecord(goal.goalId, "permission-retry-finished"));
        }
        setGoal(goalWithStatus(goal, "paused", undefined, "permission-blocker"), ctx, "runtime");
        return;
      }
    }
    if (!isPokeable(goal) || snapshot.backgroundRunning) {
      return;
    }
    const evidence = lastAgentEvidence;
    if (!evidence) {
      scheduleIdleContinuation(goal, ctx, "continuation", snapshot);
      return;
    }
    const previous = currentContinuationState(ctx, goal.goalId) ?? createContinuationState(goal.goalId);
    if (previous.blocked) return;
    const repeated = previous.lastEvidenceSignature === evidence.signature;
    const noProgressRetries = repeated ? previous.noProgressRetries + 1 : 0;
    const blocked = repeated && noProgressRetries >= MAX_NO_PROGRESS_RETRIES;
    const now = Date.now();
    appendContinuationState({
      goalId: goal.goalId,
      lastEvidenceSignature: evidence.signature,
      lastEvidenceSummary: evidence.summary,
      ...(repeated
        ? (previous.lastProgressAt !== undefined ? { lastProgressAt: previous.lastProgressAt } : {})
        : { lastProgressAt: now }),
      noProgressRetries,
      blocked,
      updatedAt: Math.floor(now / 1000),
    });
    if (blocked) {
      refreshGoalWidget?.();
      if (ctx.hasUI) {
        ctx.ui.setStatus(EXTENSION_NAME, "waiting: no progress");
        ctx.ui.notify(
          `Goal automatic continuation is waiting after ${noProgressRetries} identical retries (${evidence.summary}). Use /goal resume or alt+g to resume it.`,
          "warning",
        );
      }
      return;
    }
    scheduleIdleContinuation(goal, ctx, "continuation", snapshot);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (typeof unsubscribeSettingsRequest === "function") unsubscribeSettingsRequest();

    executionGeneration += 1;
    sessionGeneration += 1;
    escapeAbortSuppression = undefined;
    terminalInputUnsubscribe?.();
    terminalInputUnsubscribe = undefined;
    terminalInputIsEditor = undefined;
    uiPromptDepth = 0;
    stopPolling();
    foregroundRunning = false;
    pendingQuestions.clear();
    clearIdleContinuation();
    currentCtx = undefined;
    latestSnapshot = null;
    collectionPending = false;
    try {
      ctx.ui.setStatus(EXTENSION_NAME, undefined);
      ctx.ui.setWidget(EXTENSION_NAME, undefined);
    } catch {
      // Best-effort cleanup.
    }
  });
}