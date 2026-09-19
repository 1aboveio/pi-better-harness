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
  type GoalSnapshot,
} from "./types.js";

const POLL_INTERVAL_MS = 2_000;
const DEFAULT_IDLE_CONTINUATION_DELAY_MS = 30_000;
const DEFAULT_MAX_NO_PROGRESS_RETRIES = 3;
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
  let foregroundRunning = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let collecting = false;
  let collectionPending = false;
  let latestSnapshot: ActivitySnapshot | null = null;
  let backgroundDrainTracker: BackgroundDrainTracker | null = null;
  let lastWakeSignature = "";
  let lastAttentionSignature = "";
  let continuationQueuedFor: string | null = null;
  let idleContinuationTimer: ReturnType<typeof setTimeout> | undefined;
  let idleContinuationSignature = "";
  let refreshGoalWidget: ((force?: boolean) => void) | undefined;
  let lastAgentEvidence: ContinuationEvidence | null = null;

  const getGoal = (ctx: ExtensionContext): GoalSnapshot | null => currentGoalSnapshot(ctx);
  const getWorkflow = (ctx: ExtensionContext) => currentWorkflowOwner(ctx.sessionManager.getBranch());
  const workflowAvailable = (owner: NonNullable<ReturnType<typeof currentWorkflowOwner>>): boolean => {
    const command = pi.getCommands?.().find((item) => item.name === `skill:${owner.name}` && item.source === "skill");
    if (command?.sourceInfo.path !== owner.path) return false;
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
    const previous = getGoal(ctx);
    const wasVisible = previous !== null && isGoalClockVisible(previous);
    pi.appendEntry(EXTENSION_NAME, goalSetEntry(goal, source));
    continuationQueuedFor = null;
    backgroundDrainTracker = null;
    clearIdleContinuation();
    syncPollingState();
    // Force a full redraw when the dock height changes (absent ↔ visible clock).
    refreshGoalWidget?.(!wasVisible || !isGoalClockVisible(goal));
  };

  const clearGoal = (ctx: ExtensionContext, source: GoalEntrySource): void => {
    const current = getGoal(ctx);
    const wasVisible = current !== null && isGoalClockVisible(current);
    pi.appendEntry(EXTENSION_NAME, goalClearEntry(current?.goalId ?? null, source));
    if (getWorkflow(ctx)) recordWorkflow(null);
    continuationQueuedFor = null;
    backgroundDrainTracker = null;
    clearIdleContinuation();
    syncPollingState();
    refreshGoalWidget?.(wasVisible);
  };

  const pauseGoalOnInterrupt = (ctx: ExtensionContext): void => {
    const goal = getGoal(ctx);
    if (!isPokeable(goal)) {
      return;
    }
    setGoal(goalWithStatus(goal, "paused"), ctx, "runtime");
    notifyGoal(ctx, "Goal paused (interrupted).");
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
    if (idleContinuationTimer && idleContinuationSignature === signature) {
      return;
    }
    clearIdleContinuation();
    idleContinuationSignature = signature;
    idleContinuationTimer = setTimeout(() => {
      idleContinuationTimer = undefined;
      idleContinuationSignature = "";
      void sendIdleContinuationAfterAudit(goal.goalId, ctx, kind, snapshot);
    }, IDLE_CONTINUATION_DELAY_MS);
    idleContinuationTimer.unref?.();
  };

  const sendIdleContinuationAfterAudit = async (
    goalId: string,
    ctx: ExtensionContext,
    kind: "continuation" | "background-drained",
    priorSnapshot?: ActivitySnapshot,
  ): Promise<void> => {
    const goal = currentGoalSnapshot(ctx);
    if (!isPokeable(goal) || goal.goalId !== goalId || continuationQueuedFor === goal.goalId || foregroundRunning) {
      return;
    }
    if (!boundCommandReady(goal, ctx)) return;
    const snapshot = await collectActivitySnapshot(ctx, providers.values(), foregroundRunning);
    latestSnapshot = snapshot;
    pi.events.emit(EVENT_ACTIVITY, snapshot);
    if (snapshot.foregroundRunning || snapshot.backgroundRunning) {
      return;
    }

    // A background drain is a meaningful external state transition and reopens a held goal.
    if (kind === "background-drained") {
      resetContinuationState(goal);
    }
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
      ? workflowOwnerFromSkill(command.name.slice("skill:".length), command.path)
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

  const publishSnapshot = async (ctx: ExtensionContext): Promise<ActivitySnapshot> => {
    const snapshot = await collectActivitySnapshot(ctx, providers.values(), foregroundRunning);
    latestSnapshot = snapshot;
    pi.events.emit(EVENT_ACTIVITY, snapshot);

    const attention = terminalAttentionSignature(snapshot);
    if (attention && attention !== lastAttentionSignature) {
      lastAttentionSignature = attention;
      pi.events.emit(EVENT_TERMINAL_ATTENTION, snapshot);
    }

    if (!WAKE_DISABLED) {
      const goal = currentGoalSnapshot(ctx);
      const wakePlan = planBackgroundDrainWake(backgroundDrainTracker, goal, snapshot);
      backgroundDrainTracker = wakePlan.nextTracker;
      if (isPokeable(goal) && wakePlan.wakeSignature) {
        const wakeSignature = wakePlan.wakeSignature;
        if (wakeSignature !== lastWakeSignature) {
          lastWakeSignature = wakeSignature;
          scheduleIdleContinuation(goal, ctx, "background-drained", snapshot);
        }
      }
    }

    if (snapshot.foregroundRunning || snapshot.backgroundRunning) {
      clearIdleContinuation();
    }

    if (ctx.hasUI) {
      const goal = getGoal(ctx);
      const continuation = goal ? currentContinuationState(ctx, goal.goalId) : null;
      const goalStall = observeGoalStall(goal, continuation, {
        foregroundRunning,
        backgroundRunning: latestSnapshot?.backgroundRunning ?? false,
      });
      const status = snapshot.backgroundRunning
        ? `bg ${snapshot.activeBackgroundCount}${snapshot.unhealthyBackgroundCount ? `, ${snapshot.unhealthyBackgroundCount} unhealthy` : ""}`
        : continuation?.blocked
          ? "waiting: no progress"
          : goalStall?.state === "stalled"
            ? "goal stalled"
          : undefined;
      try {
        ctx.ui.setStatus(EXTENSION_NAME, status);
      } catch {
        // UI status is best-effort only.
      }
    }

    return snapshot;
  };

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
    void publishSnapshot(ctx).finally(() => {
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
        if (!current || current.status !== "paused") {
          notifyGoal(ctx, "Only paused goals can be resumed.", "warning");
          return;
        }
        if (!current.command && skillCommandName(current.objective)) {
          notifyGoal(ctx, "Invoke the skill directly; this legacy slash-command goal cannot resume as plain text.", "error");
          return;
        }
        if (current.command && !commandAvailable(pi, current.command)) {
          notifyGoal(ctx, `Cannot resume: /${current.command.name} is no longer registered at its original source.`, "error");
          return;
        }
        const goal = goalWithStatus(current, "active");
        setGoal(goal, ctx, "command");
        queueGoalContinuation(goal, ctx);
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

  pi.registerCommand("better-activity", {
    description: "Show foreground/background activity known to pi-better-goal",
    handler: async (_args, ctx) => {
      currentCtx = ctx;
      const snapshot = await publishSnapshot(ctx);
      ctx.ui.notify(formatSnapshot(snapshot), snapshot.backgroundRunning ? "info" : "info");
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
      return {
        content: [{ type: "text", text: formatSnapshot(snapshot) }],
        details: snapshot,
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    foregroundRunning = !ctx.isIdle();
    const restoredGoal = getGoal(ctx);
    if (restoredGoal?.status === "active" && !restoredGoal.command && skillCommandName(restoredGoal.objective)) {
      setGoal(goalWithStatus(restoredGoal, "paused"), ctx, "runtime");
      notifyGoal(ctx, "Goal paused: invoke its skill directly before resuming.", "error");
    }
    pi.events.emit(EVENT_READY, { version: EXTENSION_VERSION });
    installGoalWidget(ctx);
    latestSnapshot = await publishSnapshot(ctx);
    syncPollingState();
    if (restoredGoal?.status === "active" && restoredGoal.command && boundCommandReady(restoredGoal, ctx) && !foregroundRunning && !latestSnapshot.backgroundRunning) {
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
          const owner = workflowOwnerFromSkill(skillName, command.sourceInfo.path);
          if (owner) recordWorkflow(owner);
        } catch (error) {
          notifyGoal(ctx, error instanceof Error ? error.message : String(error), "error");
          return { action: "handled" as const };
        }
      }
    }
    const goal = getGoal(ctx);
    if (goal?.status === "active") {
      resetContinuationState(goal);
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    currentCtx = ctx;
    const goal = currentGoalSnapshot(ctx);
    const owner = getWorkflow(ctx);
    const snapshot = await publishSnapshot(ctx);
    if (!isPokeable(goal) && !owner) {
      return;
    }

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
        systemPrompt: `${event.systemPrompt}\n\nActive workflow: ${owner.name} (${owner.path}). Its task plan owns planning and the parent is a coordinator, not a product-code implementer. Follow the workflow instructions below, including on resumed turns:\n\n${instructions}` +
          (isPokeable(goal) ? `\n\nActive objective: ${goal.objective}. Complete it only after the workflow completion audit.` : ""),
      };
    }

    if (!isPokeable(goal)) return;
    const backgroundInstruction = snapshot.backgroundRunning
      ? ` The goal still has delegated background work running (${summarizeActiveBackground(snapshot)}). Foreground idleness alone is not goal completion; keep any structured plan current and do not mark verification, the plan, or the goal complete until every relevant delegated task reaches a terminal state and its result or failure has been inspected and integrated.`
      : "";
    return {
      systemPrompt:
        `${event.systemPrompt}\n\n` +
        `Pi Better Goal active objective: ${goal.objective}. Keep working through clear low-risk next steps, and mark complete only after an evidence-backed completion audit.${backgroundInstruction}`,
    };
  });

  pi.on("agent_start", async (_event, ctx) => {
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
    lastAgentEvidence = continuationEvidence(event.messages);
    // `escape` is a pi-reserved built-in shortcut (`app.interrupt`), so extensions
    // cannot register it. Observe the interrupt instead: when a running turn is
    // aborted (escape / ctrl+c while streaming), pause the active goal so it does
    // not auto-continue after the user stopped the agent.
    if (wasTurnAborted(event.messages)) {
      pauseGoalOnInterrupt(ctx);
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    currentCtx = ctx;
    foregroundRunning = false;
    const snapshot = await publishSnapshot(ctx);
    const goal = getGoal(ctx);
    if (!isPokeable(goal) || snapshot.backgroundRunning) {
      return;
    }
    const previous = currentContinuationState(ctx, goal.goalId) ?? createContinuationState(goal.goalId);
    const evidence = lastAgentEvidence ?? continuationEvidence([]);
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
    stopPolling();
    foregroundRunning = false;
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