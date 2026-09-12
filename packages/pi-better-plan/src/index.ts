import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  completedPlanClearDelay,
  planClearEntry,
  planDisplayEntry,
  planProgress,
  planSetEntry,
  reconstructPlanState,
  replacePlan,
} from "./plan-state.js";
import { createFullPlanComponent, renderCompactPlan } from "./plan-render.js";
import {
  EXTENSION_NAME,
  type PlanDisplayMode,
  type PlanProgress,
  type PlanSnapshot,
  type PlanStepInput,
} from "./types.js";

interface GetPlanDetails {
  hasPlan: boolean;
  plan: PlanSnapshot | null;
  progress: PlanProgress | null;
}

const PlanStepSchema = Type.Object({
  step: Type.String({ description: "A concise, verifiable execution step." }),
  status: StringEnum(["pending", "in_progress", "completed", "blocked"] as const),
});

const UpdatePlanSchema = Type.Object({
  explanation: Type.Optional(Type.String({ description: "Why the plan or its status changed." })),
  plan: Type.Array(PlanStepSchema, { minItems: 1, maxItems: 50 }),
});

const LEGACY_PLAN_NAV_STATUS_KEY = "pi-better-plan-nav";

export default function planExtension(pi: ExtensionAPI): void {
  let currentPlan: PlanSnapshot | null = null;
  let displayMode: PlanDisplayMode = "auto";
  let refreshWidget: ((force?: boolean) => void) | undefined;
  let completedPlanClearTimer: ReturnType<typeof setTimeout> | undefined;

  const refresh = (force = false): void => refreshWidget?.(force);

  const cancelCompletedPlanClear = (): void => {
    if (completedPlanClearTimer) clearTimeout(completedPlanClearTimer);
    completedPlanClearTimer = undefined;
  };

  const clearPlan = (): void => {
    cancelCompletedPlanClear();
    currentPlan = null;
    pi.appendEntry(EXTENSION_NAME, planClearEntry());
    refresh(true);
  };

  const scheduleCompletedPlanClear = (): void => {
    cancelCompletedPlanClear();
    if (!currentPlan) return;
    const delay = completedPlanClearDelay(currentPlan);
    if (delay === null) return;
    const completedPlan = currentPlan;
    const timer = setTimeout(() => {
      if (completedPlanClearTimer !== timer) return;
      completedPlanClearTimer = undefined;
      if (currentPlan?.planId !== completedPlan.planId || currentPlan.revision !== completedPlan.revision) return;
      clearPlan();
    }, delay);
    completedPlanClearTimer = timer;
    timer.unref?.();
  };

  const restore = (ctx: ExtensionContext): void => {
    cancelCompletedPlanClear();
    const state = reconstructPlanState(ctx.sessionManager.getBranch());
    currentPlan = state.plan;
    displayMode = state.displayMode;
    if (ctx.hasUI) ctx.ui.setStatus(LEGACY_PLAN_NAV_STATUS_KEY, undefined);
    refresh(true);
    scheduleCompletedPlanClear();
  };

  const persistPlan = (plan: PlanSnapshot): void => {
    currentPlan = plan;
    pi.appendEntry(EXTENSION_NAME, planSetEntry(plan));
    refresh(true);
    scheduleCompletedPlanClear();
  };

  const setDisplayMode = (mode: PlanDisplayMode): void => {
    displayMode = mode;
    pi.appendEntry(EXTENSION_NAME, planDisplayEntry(mode));
    refresh(true);
  };

  const installWidget = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(
      EXTENSION_NAME,
      (tui, theme) => {
        const localRefresh = (force = false): void => tui.requestRender(force);
        refreshWidget = localRefresh;
        return {
          render(width: number): string[] {
            if (!currentPlan || displayMode === "hidden") return [];
            return renderCompactPlan(currentPlan, width, theme as never);
          },
          invalidate() {},
          dispose() {
            if (refreshWidget === localRefresh) refreshWidget = undefined;
          },
        };
      },
      { placement: "aboveEditor" },
    );
  };

  const showFullPlan = async (ctx: ExtensionContext): Promise<void> => {
    if (!currentPlan) {
      if (ctx.hasUI) ctx.ui.notify("No plan is set.", "warning");
      return;
    }
    if (ctx.mode !== "tui") {
      ctx.ui.notify(formatPlan(currentPlan), "info");
      return;
    }
    const snapshot = currentPlan;
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      const component = createFullPlanComponent(snapshot, theme as never, () => done());
      return {
        render: (width) => component.render(width),
        handleInput(data) {
          component.handleInput?.(data);
          tui.requestRender();
        },
        invalidate: () => component.invalidate(),
      };
    });
  };


  pi.registerTool({
    name: "update_plan",
    label: "Update Plan",
    description: "Create or atomically replace the current structured execution plan and its step statuses.",
    promptSnippet: "Create and update a persistent structured execution plan",
    promptGuidelines: [
      "Use update_plan for work with three or more meaningful steps, and update it immediately when a step completes, becomes blocked, or scope changes.",
      "Keep at most one update_plan step in_progress and do not mark a step completed until its required verification succeeds.",
    ],
    parameters: UpdatePlanSchema,
    async execute(_toolCallId, params) {
      const input = params as { explanation?: string; plan: PlanStepInput[] };
      const plan = replacePlan(currentPlan, input.plan, input.explanation);
      persistPlan(plan);
      const progress = planProgress(plan);
      return {
        content: [{ type: "text", text: formatProgress(plan) }],
        details: { ok: true, plan, progress },
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("update_plan ")) + theme.fg("muted", `${args.plan.length} steps`),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const text = result.content[0];
      return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text?.type === "text" ? text.text : "Plan updated"), 0, 0);
    },
  });

  pi.registerTool({
    name: "get_plan",
    label: "Get Plan",
    description: "Inspect the current structured execution plan and derived checklist progress.",
    promptSnippet: "Inspect the current structured execution plan and progress",
    parameters: Type.Object({}),
    async execute() {
      if (!currentPlan) {
        return {
          content: [{ type: "text", text: "No plan is set." }],
          details: { hasPlan: false, plan: null, progress: null } as GetPlanDetails,
        };
      }
      const progress = planProgress(currentPlan);
      return {
        content: [{ type: "text", text: formatPlan(currentPlan) }],
        details: { hasPlan: true, plan: currentPlan, progress } as GetPlanDetails,
      };
    },
  });

  pi.registerCommand("plan", {
    description: "Inspect, show, hide, clear, or configure the current plan",
    handler: async (args, ctx) => {
      const input = args.trim().toLowerCase();
      if (!input) return showFullPlan(ctx);
      if (input === "clear") {
        clearPlan();
        ctx.ui.notify("Plan cleared.", "info");
        return;
      }
      if (input === "hide") {
        setDisplayMode("hidden");
        return;
      }
      if (input === "show") {
        setDisplayMode("auto");
        return;
      }
      const pinMode = input.match(/^pin\s+(auto|on|off)$/)?.[1] as PlanDisplayMode | undefined;
      if (pinMode) {
        setDisplayMode(pinMode);
        ctx.ui.notify(`Plan pin mode: ${pinMode}.`, "info");
        return;
      }
      ctx.ui.notify("Usage: /plan [clear|hide|show|pin auto|pin on|pin off]", "warning");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    installWidget(ctx);
    restore(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    restore(ctx);
  });
  pi.on("before_agent_start", async (event) => {
    if (!currentPlan) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${planPrompt(currentPlan)}`,
    };
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    cancelCompletedPlanClear();
    refreshWidget = undefined;
    try {
      ctx.ui.setStatus(LEGACY_PLAN_NAV_STATUS_KEY, undefined);
      ctx.ui.setWidget(EXTENSION_NAME, undefined);
    } catch { /* best-effort cleanup */ }
  });
}

function formatProgress(plan: PlanSnapshot): string {
  const progress = planProgress(plan);
  const current = progress.activeIndex === null ? null : plan.steps[progress.activeIndex];
  const status = [`Plan updated: ${progress.completed}/${progress.total} steps completed`];
  if (progress.blocked > 0) status.push(`${progress.blocked} blocked`);
  if (current) status.push(`Current step: ${current.step}`);
  return status.join(". ") + ".";
}

function formatPlan(plan: PlanSnapshot): string {
  const progress = planProgress(plan);
  return [
    `Plan: ${progress.completed}/${progress.total} steps completed${progress.blocked ? `, ${progress.blocked} blocked` : ""}`,
    ...plan.steps.map((item, index) => `${index + 1}. [${item.status}] ${item.step}`),
  ].join("\n");
}

function planPrompt(plan: PlanSnapshot): string {
  return [
    "Current structured execution plan:",
    ...plan.steps.map((item, index) => `${index + 1}. [${item.status}] ${item.step}`),
    "Use update_plan immediately when a step completes, becomes blocked, or the scope changes. Completion must be explicit and evidence-backed.",
  ].join("\n");
}