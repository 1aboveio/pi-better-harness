import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { commandAvailable, commandInvocation, resolveGoalCommand } from "./command-binding.js";

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
export function agentResumable(goal: GoalSnapshot | null): boolean {
  return goal?.status === "paused" && goal.pauseReason === "interrupt";
}

/** Footer status for a paused goal, telling the user how to resume it. */
export function pausedGoalStatus(goal: GoalSnapshot): string {
  return agentResumable(goal) ? 'goal paused · say "go" or /goal resume' : "goal paused · /goal resume";
}

function pausedGoalPrompt(goal: GoalSnapshot): string {
  return [
    `Pi Better Goal is paused because the user pressed escape. Goal: ${goal.objective}`,
    "Treat the user's messages as ordinary conversation: answer them, but do not continue the goal's work until it is resumed.",
    GOAL_RESUME_RULE,
  ].join("\n");
}

const BLOCKING_QUESTION_TOOLS: ReadonlySet<string> = new Set(["ask_user_question"]);

const GOAL_ACTIONS: readonly AutocompleteItem[] = [
  { value: "pause", label: "pause", description: "Pause the active goal" },
  { value: "resume", label: "resume", description: "Resume the paused goal" },
  { value: "clear", label: "clear", description: "Remove the current goal" },
  { value: "complete", label: "complete", description: "Mark the current goal complete" },
];

export function goalArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  const prefix = argumentPrefix.trimStart().toLowerCase();
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
): string {
  if (!goal) {
    return "No goal is set.";
  }
  const budget = goal.tokenBudget === null ? "none" : String(goal.tokenBudget);
  const timing = goalTiming(goal);
  const continuationStatus = continuation?.blocked
    ? `Automatic continuation: waiting after ${continuation.noProgressRetries} identical retries (${continuation.lastEvidenceSummary})`
    : `Automatic continuation: retry limit ${MAX_NO_PROGRESS_RETRIES}`;
  return [
    `Goal: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Token budget: ${budget}`,
    `Tokens used: ${goal.usage.tokensUsed}`,
    `Active time: ${timing.activeSeconds}s`,
    `Elapsed time: ${timing.elapsedSeconds}s`,
    `Observable progress: ${stall?.state ?? "unknown"}`,
    continuationStatus,
    ...(goal.status === "paused"
      ? [agentResumable(goal)
        ? 'Resume: say "go" (the agent calls goal_resume), /goal resume, or alt+g'
        : "Resume: /goal resume or alt+g"]
      : []),
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
  let lastAgentEvidence: ContinuationEvidence | null = null;
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
    setGoal(goalWithStatus(goal, "paused", undefined, "interrupt"), ctx, "runtime");
    notifyGoal(ctx, 'Goal paused. Say "go" to resume it, or use /goal resume.');
  };

  /** Why a paused goal cannot become active again, or null when it can. */
  const resumeBlocker = (goal: GoalSnapshot): string | null => {
    if (!goal.command && skillCommandName(goal.objective)) {
      return "Invoke the skill directly; this legacy slash-command goal cannot resume as plain text.";
    }
    if (goal.command && !commandAvailable(pi, goal.command)) {
      return `Cannot resume: /${goal.command.name} is no longer registered at its original source.`;
    }
    return null;
  };

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
    const blocker = resumeBlocker(current);
    if (blocker) {
      return { ok: false, message: blocker };
    }
    const goal = held ? current : goalWithStatus(current, "active");
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
    resetContinuationState(goal);
    sendGoalContinuation(goal, continuationPrompt(goal, getWorkflow(ctx)), "continuation");
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
    if (WAKE_DISABLED || !isPokeable(goal) || continuationQueuedFor === goal.goalId) {
      return;
    }
    if (kind === "continuation" && currentContinuationState(ctx, goal.goalId)?.blocked) {
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
      if (execution !== executionGeneration || wake !== wakeGeneration) return false;
      const current = currentGoalSnapshot(ctx);
      return isPokeable(current) && current.goalId === goalId &&
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
    if (isPokeable(goal) && wakePlan.wakeSignature) {
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
    if (goal?.status === "paused") return background ? `${pausedGoalStatus(goal)} · ${background}` : pausedGoalStatus(goal);
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
      const wanted = agentResumable(goal);
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

  pi.registerCommand("goal", {
    description: "Create, inspect, pause, resume, clear, or complete the active goal",
    getArgumentCompletions: goalArgumentCompletions,
    handler: async (args, ctx) => {
      currentCtx = ctx;
      const trimmed = args.trim();
      const current = getGoal(ctx);

      if (!trimmed) {
        const continuation = current ? currentContinuationState(ctx, current.goalId) : null;
        // Inspection is always explicit user intent; show the full summary even while busy.
        ctx.ui.notify(formatGoal(current, continuation, observeGoalStall(current, continuation, { foregroundRunning })), "info");
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
        content: [{ type: "text", text: formatGoal(goal, continuation, stall) }],
        details: { goal, continuation, stall, timing: goal ? goalTiming(goal) : null, hasGoal: goal !== null },
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
      "Resume the goal the user paused with escape, exactly like /goal resume. " + GOAL_RESUME_RULE,
    promptSnippet: "Resume the escape-paused goal, only on the user's clear go-ahead.",
    parameters: Type.Object({
      reason: Type.Optional(Type.String({ description: "Short quote or summary of the user's go-ahead." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const reason = (params as { reason?: string }).reason;
      const current = getGoal(ctx);
      if (!agentResumable(current)) {
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
    description: "Release the active skill-owned workflow after its final handoff and completion audit.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const owner = getWorkflow(ctx);
      if (!owner) return { content: [{ type: "text", text: "No workflow owns this session." }], details: { released: false } };
      recordWorkflow(null);
      return { content: [{ type: "text", text: `Released ${owner.name} workflow ownership.` }], details: { released: true, owner: owner.name } };
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
    executionGeneration += 1;
    sessionGeneration += 1;
    clearIdleContinuation();
    continuationQueuedFor = null;
    backgroundDrainTracker = null;
    lastAgentEvidence = null;
    collecting = false;
    collectionPending = false;
    currentCtx = ctx;
    foregroundRunning = !ctx.isIdle();
    const restoredGoal = getGoal(ctx);
    if (restoredGoal?.status === "active" && !restoredGoal.command && skillCommandName(restoredGoal.objective)) {
      setGoal(goalWithStatus(restoredGoal, "paused"), ctx, "runtime");
      notifyGoal(ctx, "Goal paused: invoke its skill directly before resuming.", "error");
    }
    pi.events.emit(EVENT_READY, { version: EXTENSION_VERSION });
    syncResumeTool(getGoal(ctx));
    installGoalWidget(ctx);
    const snapshot = await publishSnapshot(ctx);
    if (!snapshot) return;
    syncPollingState();
    if (restoredGoal?.status === "active" && restoredGoal.command && boundCommandReady(restoredGoal, ctx) && !foregroundRunning && !snapshot.backgroundRunning) {
      scheduleIdleContinuation(restoredGoal, ctx, "continuation");
    }
  });

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
    if (goal?.status === "active") {
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
    const pausedInstruction = agentResumable(goal) ? pausedGoalPrompt(goal!) : "";
    if (!isPokeable(goal) && !owner) {
      return pausedInstruction ? { systemPrompt: `${event.systemPrompt}\n\n${pausedInstruction}` } : undefined;
    }

    const questionInstruction = snapshot.backgroundRunning
      ? " A blocking user question (ask_user_question) holds this whole turn until the user answers, and background completions wait behind it. Harvest finished background results before asking, and ask only when the answer is needed to proceed."
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
            ? `${pausedInstruction}\nWhile the goal is paused, this overrides the workflow instructions below: do not advance the workflow until the goal is resumed.\n\n`
            : "") +
          `Active workflow: ${owner.name} (${owner.path}). Its task plan owns planning and the parent is a coordinator, not a product-code implementer. Follow the workflow instructions below, including on resumed turns:\n\n${instructions}` +
          (isPokeable(goal) ? `\n\nActive objective: ${goal.objective}. Complete it only after the workflow completion audit.` : "") +
          (questionInstruction ? `\n\n${questionInstruction.trim()}` : ""),
      };
    }

    if (!isPokeable(goal)) return;
    const backgroundInstruction = snapshot.backgroundRunning
      ? ` The goal still has delegated background work running (${summarizeActiveBackground(snapshot)}). Foreground idleness alone is not goal completion; keep any structured plan current and do not mark verification, the plan, or the goal complete until every relevant delegated task reaches a terminal state and its result or failure has been inspected and integrated.`
      : "";
    return {
      systemPrompt:
        `${event.systemPrompt}\n\n` +
        `Pi Better Goal active objective: ${goal.objective}. Keep working through clear low-risk next steps, and mark complete only after an evidence-backed completion audit.${backgroundInstruction}${questionInstruction}`,
    };
  });

  pi.on("agent_start", async (_event, ctx) => {
    executionGeneration += 1;
    agentGeneration = executionGeneration;
    currentCtx = ctx;
    foregroundRunning = true;
    clearIdleContinuation();
    continuationQueuedFor = null;
    lastAgentEvidence = null;
    const turnSignal = ctx.signal;
    if (turnSignal) {
      if (turnSignal.aborted) {
        pauseGoalOnInterrupt(ctx);
      } else {
        turnSignal.addEventListener("abort", () => pauseGoalOnInterrupt(ctx), { once: true });
      }
    }
    await publishSnapshot(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    lastAgentEvidence = agentGeneration === executionGeneration ? continuationEvidence(event.messages) : null;
    // `escape` is a pi-reserved built-in shortcut (`app.interrupt`), so extensions
    // cannot register it. Observe the interrupt instead: when a running turn is
    // aborted (escape / ctrl+c while streaming), pause the active goal so it does
    // not auto-continue after the user stopped the agent.
    if (wasTurnAborted(event.messages)) {
      pauseGoalOnInterrupt(ctx);
    }
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
    currentCtx = ctx;
    foregroundRunning = false;
    const snapshot = await publishSnapshot(ctx);
    if (!snapshot) return;
    const goal = getGoal(ctx);
    if (!isPokeable(goal) || snapshot.backgroundRunning) {
      return;
    }
    const evidence = lastAgentEvidence;
    if (!evidence) {
      scheduleIdleContinuation(goal, ctx, "continuation", snapshot);
      return;
    }
    const previous = currentContinuationState(ctx, goal.goalId) ?? createContinuationState(goal.goalId);
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
          `Goal automatic continuation is waiting after ${noProgressRetries} identical retries (${evidence.summary}). New input or background activity will resume it.`,
          "warning",
        );
      }
      return;
    }
    scheduleIdleContinuation(goal, ctx, "continuation", snapshot);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    executionGeneration += 1;
    sessionGeneration += 1;
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