import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  collectActivitySnapshot,
  planBackgroundDrainWake,
  summarizeActiveBackground,
  terminalAttentionSignature,
  type BackgroundDrainTracker,
} from "./activity.js";
import {
  createGoalSnapshot,
  currentGoalSnapshot,
  goalClearEntry,
  goalSetEntry,
  goalWithStatus,
  validateObjective,
  validateTokenBudget,
} from "./goal-state.js";
import { goalTiming, renderGoalClockLine } from "./goal-clock.js";
import { collectSubagentActivity } from "./subagents.js";
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
const WAKE_DISABLED =
  process.env.PI_BETTER_GOAL_DISABLE_WAKE === "1" ||
  process.env.PI_BETTER_EXTENSION_DISABLE_WAKE === "1";

function continuationPrompt(goal: GoalSnapshot): string {
  return [
    "Continue working toward the active thread goal.",
    "",
    `Goal: ${goal.objective}`,
    "",
    "Keep working through clear low-risk next steps. Do not stop at a plan. Mark the goal complete only after an evidence-backed completion audit proves no required work remains.",
  ].join("\n");
}

function formatGoal(goal: GoalSnapshot | null): string {
  if (!goal) {
    return "No goal is set.";
  }
  const budget = goal.tokenBudget === null ? "none" : String(goal.tokenBudget);
  const timing = goalTiming(goal);
  return [
    `Goal: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Token budget: ${budget}`,
    `Tokens used: ${goal.usage.tokensUsed}`,
    `Active time: ${timing.activeSeconds}s`,
    `Elapsed time: ${timing.elapsedSeconds}s`,
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
  providers.set("subagents", {
    id: "subagents",
    label: "Subagents",
    getActivity: () => collectSubagentActivity(),
  });

  let currentCtx: ExtensionContext | undefined;
  let foregroundRunning = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let collecting = false;
  let latestSnapshot: ActivitySnapshot | null = null;
  let backgroundDrainTracker: BackgroundDrainTracker | null = null;
  let lastWakeSignature = "";
  let lastAttentionSignature = "";
  let continuationQueuedFor: string | null = null;

  const getGoal = (ctx: ExtensionContext): GoalSnapshot | null => currentGoalSnapshot(ctx);

  const setGoal = (goal: GoalSnapshot, ctx: ExtensionContext, source: "command" | "tool" | "runtime"): void => {
    pi.appendEntry(EXTENSION_NAME, goalSetEntry(goal, source));
    continuationQueuedFor = null;
    backgroundDrainTracker = null;
  };

  const clearGoal = (ctx: ExtensionContext, source: "command" | "tool" | "runtime"): void => {
    const current = getGoal(ctx);
    pi.appendEntry(EXTENSION_NAME, goalClearEntry(current?.goalId ?? null, source));
    continuationQueuedFor = null;
    backgroundDrainTracker = null;
  };

  const queueGoalContinuation = (goal: GoalSnapshot): void => {
    if (goal.status !== "active" || continuationQueuedFor === goal.goalId) {
      return;
    }
    continuationQueuedFor = goal.goalId;
    pi.sendMessage(
      {
        customType: EXTENSION_NAME,
        content: continuationPrompt(goal),
        display: false,
        details: { kind: "continuation", goalId: goal.goalId },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
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
    const goal = createGoalSnapshot(objective.trim(), tokenBudget);
    setGoal(goal, ctx, source);
    queueGoalContinuation(goal);
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
      if (goal?.status === "active" && wakePlan.wakeSignature) {
        const wakeSignature = wakePlan.wakeSignature;
        if (wakeSignature !== lastWakeSignature) {
          lastWakeSignature = wakeSignature;
          continuationQueuedFor = goal.goalId;
          pi.sendMessage(
            {
              customType: EXTENSION_NAME,
              content:
                "Background activity for the active goal is no longer running. Inspect any subagent callbacks or final results, then continue the completion audit before marking the goal complete.\n\n" +
                continuationPrompt(goal),
              display: false,
              details: { kind: "background-drained", snapshot },
            },
            { triggerTurn: true, deliverAs: "followUp" },
          );
        }
      }
    }

    if (ctx.hasUI) {
      const status = snapshot.backgroundRunning
        ? `bg ${snapshot.activeBackgroundCount}${snapshot.unhealthyBackgroundCount ? `, ${snapshot.unhealthyBackgroundCount} unhealthy` : ""}`
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
    if (!ctx || collecting) {
      return;
    }
    collecting = true;
    void publishSnapshot(ctx).finally(() => {
      collecting = false;
    });
  };

  const startPolling = (): void => {
    if (pollTimer) {
      return;
    }
    pollTimer = setInterval(collectIfPossible, POLL_INTERVAL_MS);
    pollTimer.unref?.();
    collectIfPossible();
  };

  const stopPolling = (): void => {
    if (!pollTimer) {
      return;
    }
    clearInterval(pollTimer);
    pollTimer = undefined;
  };

  const installGoalWidget = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) {
      return;
    }
    ctx.ui.setWidget(
      EXTENSION_NAME,
      (tui, _theme) => {
        const timer = setInterval(() => tui.requestRender(), 1_000);
        timer.unref?.();
        return {
          dispose() {
            clearInterval(timer);
          },
          invalidate() {},
          render(width: number): string[] {
            const goal = getGoal(ctx);
            if (!goal) {
              return [];
            }
            return [renderGoalClockLine(goal, width)];
          },
        };
      },
      { placement: "belowEditor" },
    );
  };

  pi.events.on(EVENT_REGISTER_PROVIDER, (provider) => {
    const candidate = provider as Partial<BackgroundActivityProvider> | undefined;
    if (!candidate || typeof candidate.id !== "string" || typeof candidate.getActivity !== "function") {
      return;
    }
    providers.set(candidate.id, candidate as BackgroundActivityProvider);
    collectIfPossible();
  });

  pi.registerCommand("goal", {
    description: "Create, inspect, pause, resume, clear, or complete the active goal",
    handler: async (args, ctx) => {
      currentCtx = ctx;
      const trimmed = args.trim();
      const current = getGoal(ctx);

      if (!trimmed) {
        ctx.ui.notify(formatGoal(current), "info");
        return;
      }

      if (trimmed === "pause") {
        if (!current || current.status !== "active") {
          ctx.ui.notify("Only active goals can be paused.", "warning");
          return;
        }
        setGoal(goalWithStatus(current, "paused"), ctx, "command");
        ctx.ui.notify("Goal paused.", "info");
        return;
      }

      if (trimmed === "resume") {
        if (!current || current.status !== "paused") {
          ctx.ui.notify("Only paused goals can be resumed.", "warning");
          return;
        }
        const goal = goalWithStatus(current, "active");
        setGoal(goal, ctx, "command");
        queueGoalContinuation(goal);
        ctx.ui.notify("Goal resumed.", "info");
        return;
      }

      if (trimmed === "clear") {
        clearGoal(ctx, "command");
        ctx.ui.notify("Goal cleared.", "info");
        return;
      }

      if (trimmed === "complete") {
        if (!current) {
          ctx.ui.notify("No goal is set.", "warning");
          return;
        }
        setGoal(goalWithStatus(current, "complete"), ctx, "command");
        ctx.ui.notify("Goal marked complete.", "info");
        return;
      }

      if (current && current.status !== "complete" && ctx.hasUI) {
        const replace = await ctx.ui.confirm(
          "Replace active goal?",
          `Current goal: ${current.objective}`,
        );
        if (!replace) {
          return;
        }
      }

      try {
        const goal = startOrReplaceGoal(trimmed, null, ctx, "command");
        ctx.ui.notify(`Goal set: ${goal.objective}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
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
      return {
        content: [{ type: "text", text: formatGoal(goal) }],
        details: { goal, timing: goal ? goalTiming(goal) : null, hasGoal: goal !== null },
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
    pi.events.emit(EVENT_READY, { version: EXTENSION_VERSION });
    installGoalWidget(ctx);
    startPolling();
  });

  pi.on("before_agent_start", async (event, ctx) => {
    currentCtx = ctx;
    const goal = currentGoalSnapshot(ctx);
    const snapshot = await publishSnapshot(ctx);
    if (goal?.status !== "active") {
      return;
    }

    const backgroundInstruction = snapshot.backgroundRunning
      ? ` The goal still has delegated background work running (${summarizeActiveBackground(snapshot)}). Foreground idleness alone is not goal completion; do not mark the goal complete until delegated background work reaches a terminal state and its result or failure has been inspected.`
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
    continuationQueuedFor = null;
    await publishSnapshot(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    currentCtx = ctx;
    foregroundRunning = false;
    const snapshot = await publishSnapshot(ctx);
    const goal = getGoal(ctx);
    if (goal?.status === "active" && !snapshot.backgroundRunning) {
      queueGoalContinuation(goal);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopPolling();
    foregroundRunning = false;
    currentCtx = undefined;
    try {
      ctx.ui.setStatus(EXTENSION_NAME, undefined);
      ctx.ui.setWidget(EXTENSION_NAME, undefined);
    } catch {
      // Best-effort cleanup.
    }
  });
}