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
  createRushPlanComponent, readRushPlan, renderRushPlan, workflowBinding,
  WORKFLOW_PLAN_ENTRY, type RushPlan, type WorkflowPlanBinding,
} from "./workflow-plan.js";
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
  id: Type.Optional(Type.String({ description: "Stable step id used by dependsOn (letters, digits, underscore, hyphen; max 64 characters)." })),
  step: Type.String({ description: "A concise, verifiable execution step." }),
  status: StringEnum(["pending", "in_progress", "completed", "blocked"] as const),
  dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Ids of prerequisite steps in this plan. All must be completed before this step starts." })),
});

const UpdatePlanSchema = Type.Object({
  explanation: Type.Optional(Type.String({ description: "Why the plan or its status changed." })),
  plan: Type.Array(PlanStepSchema, { minItems: 1, maxItems: 50 }),
});

const LEGACY_PLAN_NAV_STATUS_KEY = "pi-better-plan-nav";

function workflowPlanOwner(ctx: ExtensionContext): string | null {
  let owner: string | null = null;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== "pi-better-workflow") continue;
    const data = entry.data as { version?: unknown; kind?: unknown; owner?: { name?: unknown; planOwner?: unknown } } | null;
    if (data?.version !== 1) continue;
    if (data.kind === "clear") owner = null;
    else if (data.kind === "set" && data.owner?.planOwner === "workflow" && typeof data.owner.name === "string") {
      owner = data.owner.name;
    }
  }
  return owner;
}

export default function planExtension(pi: ExtensionAPI): void {
  let currentPlan: PlanSnapshot | null = null;
  let displayMode: PlanDisplayMode = "auto";
  let displayedWorkflowOwner: string | null = null;
  let rushBinding: WorkflowPlanBinding | null = null;
  let rushPlan: RushPlan | null = null;
  let rushError: string | null = null;
  let refreshWidget: ((force?: boolean) => void) | undefined;
  let completedPlanClearTimer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribeWorkflow = pi.events.on("pi-better-workflow:changed", (owner) => {
    displayedWorkflowOwner = owner && typeof owner === "object" && "name" in owner && typeof owner.name === "string"
      ? owner.name : null;
    rushBinding = null;
    rushPlan = null;
    rushError = null;
    refreshWidget?.(true);
  });

  const refresh = (force = false): void => refreshWidget?.(force);

  const loadRushPlan = (ctx: ExtensionContext): RushPlan | null => {
    if (!rushBinding || workflowPlanOwner(ctx) !== "rush-issues") return null;
    try {
      const plan = readRushPlan(rushBinding.path, ctx.cwd);
      if (plan.runId !== rushBinding.runId) throw new Error("Rush run identity changed.");
      rushPlan = plan;
      rushError = null;
    } catch (error) {
      rushPlan = null;
      rushError = error instanceof Error ? error.message : String(error);
    }
    refresh(true);
    return rushPlan;
  };

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
    displayedWorkflowOwner = workflowPlanOwner(ctx);
    rushBinding = displayedWorkflowOwner === "rush-issues" ? workflowBinding(ctx.sessionManager.getBranch()) : null;
    rushPlan = null;
    rushError = null;
    if (rushBinding) loadRushPlan(ctx);
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
            if (displayMode === "hidden") return [];
            if (displayedWorkflowOwner) {
              if (displayedWorkflowOwner !== "rush-issues") return [];
              return rushPlan ? renderRushPlan(rushPlan, width) : [];
            }
            if (!currentPlan) return [];
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
    const owner = workflowPlanOwner(ctx);
    if (owner) {
      const plan = owner === "rush-issues" ? loadRushPlan(ctx) : null;
      if (!plan) {
        ctx.ui.notify(owner === "rush-issues" ? `Rush plan unavailable: ${rushError ?? "not bound"}` : `${owner} owns the task plan.`, "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify(renderRushPlan(plan, 160, true).join("\n"), "info");
        return;
      }
      await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
        const component = createRushPlanComponent(plan, () => done());
        return { render: (width) => component.render(width), handleInput(data) {
          component.handleInput?.(data);
          tui.requestRender();
        }, invalidate: () => component.invalidate() };
      });
      return;
    }
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
    name: "sync_workflow_plan",
    label: "Sync Workflow Plan",
    description: "Display the persisted rush-issues task plan at its exact checkpoint revision. Read-only; Rush retains plan ownership.",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path to .resolve-issues/rush/<run-id>/task-plan.json" }),
      revision: Type.Integer({ minimum: 0, description: "Persisted planRevision to display" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (workflowPlanOwner(ctx) !== "rush-issues") throw new Error("Only an active rush-issues workflow can sync its plan.");
      const plan = readRushPlan(params.path, ctx.cwd);
      if (plan.planRevision !== params.revision) {
        rushPlan = null;
        rushError = `revision mismatch: expected ${params.revision}, found ${plan.planRevision}`;
        refresh(true);
        throw new Error(`Rush plan ${rushError}.`);
      }
      const binding: WorkflowPlanBinding = { owner: "rush-issues", path: params.path, runId: plan.runId };
      if (!rushBinding || rushBinding.path !== binding.path || rushBinding.runId !== binding.runId) {
        pi.appendEntry(WORKFLOW_PLAN_ENTRY, { version: 1, kind: "set", ...binding });
      }
      rushBinding = binding;
      rushPlan = plan;
      rushError = null;
      refresh(true);
      return { content: [{ type: "text", text: `Showing rush-issues rev ${plan.planRevision}: ${plan.issues.length} units.` }], details: { runId: plan.runId, revision: plan.planRevision } };
    },
  });

  pi.registerTool({
    name: "update_plan",
    label: "Update Plan",
    description: "Create or atomically replace the current structured execution plan and its step statuses.",
    promptSnippet: "Create and update a persistent structured execution plan",
    promptGuidelines: [
      "Use update_plan for work with three or more meaningful steps unless a skill owns planning; update it immediately when a step completes, becomes blocked, or scope changes.",
      "For generic plans only, mark independent foreground and delegated milestones in_progress concurrently when work is actually underway. Do not mark a delegated step completed until its result or failure has been inspected and integrated.",
      "For generic plans with prerequisites, give steps stable ids and dependsOn edges. Start only ready steps whose prerequisites are completed; independent ready steps may run in parallel, including in subagents.",
      "For generic plans only, before the first implementation milestone identify independent substantial work. Launch a bounded subagent task while you continue another, or state the concrete reason delegation is unsuitable.",
      "Use a generic plan as the foreground coordinator's milestone ledger only when no workflow owns planning. Otherwise follow the workflow's task plan and foreground role.",
      "For generic plans, use separate steps for distinct deliverables, not one step per worker process. Before completing verification or the plan, inspect and integrate every relevant delegated result or failure.",
    ],
    parameters: UpdatePlanSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const owner = workflowPlanOwner(ctx);
      if (owner) throw new Error(`${owner} owns the task plan. Update its workflow plan instead of update_plan.`);
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
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const owner = workflowPlanOwner(ctx);
      if (owner) {
        const workflowPlan = owner === "rush-issues" ? loadRushPlan(ctx) : null;
        return {
          content: [{ type: "text", text: workflowPlan
            ? renderRushPlan(workflowPlan, 160, true).join("\n")
            : `${owner} owns the task plan; ${rushError ?? "consult its persisted workflow state"}.` }],
          details: { hasPlan: !!workflowPlan, plan: workflowPlan, progress: null, workflowOwner: owner },
        };
      }
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
        if (workflowPlanOwner(ctx)) {
          ctx.ui.notify("The workflow owns its plan; /plan clear cannot change it.", "warning");
          return;
        }
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
  pi.on("before_agent_start", async (event, ctx) => {
    if (workflowPlanOwner(ctx)) return;
    if (!currentPlan) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${planPrompt(currentPlan)}`,
    };
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    cancelCompletedPlanClear();
    if (typeof unsubscribeWorkflow === "function") unsubscribeWorkflow();
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
  if (progress.inProgress > 1) status.push(`${progress.inProgress} steps in progress`);
  else if (current) status.push(`Current step: ${current.step}`);
  if (plan.steps.some((item) => item.dependsOn?.length)) status.push(`${progress.readyIndices.length} ready`);
  return status.join(". ") + ".";
}

function stepLine(item: PlanSnapshot["steps"][number], index: number): string {
  return `${index + 1}. [${item.status}] ${item.step}${item.dependsOn?.length ? ` (after: ${item.dependsOn.join(", ")})` : ""}`;
}

function formatPlan(plan: PlanSnapshot): string {
  const progress = planProgress(plan);
  return [
    `Plan: ${progress.completed}/${progress.total} steps completed${progress.blocked ? `, ${progress.blocked} blocked` : ""}`,
    ...plan.steps.map(stepLine),
    ...(plan.steps.some((item) => item.dependsOn?.length)
      ? [`Ready: ${progress.readyIndices.map((index) => plan.steps[index]!.step).join(", ") || "none"}`]
      : []),
  ].join("\n");
}

function planPrompt(plan: PlanSnapshot): string {
  return [
    "Current structured execution plan:",
    ...plan.steps.map(stepLine),
    ...(plan.steps.some((item) => item.dependsOn?.length)
      ? [`Ready pending steps: ${planProgress(plan).readyIndices.map((index) => plan.steps[index]!.step).join(", ") || "none"}. Start only steps whose prerequisites are complete.`]
      : []),
    "Use update_plan immediately when a step completes, becomes blocked, or the scope changes.",
    "Before starting the first implementation milestone, identify independent substantial work. If a subagent is available, launch one bounded task early while you continue another; otherwise briefly state the concrete dependency or shared-worktree constraint that makes delegation unsuitable.",
    "Treat the plan as the foreground coordinator's milestone ledger: delegate independent, sufficiently substantial work early, mark distinct foreground and delegated milestones in_progress concurrently, and continue unblocked foreground work instead of waiting or polling.",
    "Do not complete verification or the plan until relevant delegated work is terminal, its results or failures have been inspected and integrated, and the outcome is evidence-backed.",
  ].join("\n");
}