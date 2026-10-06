import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type AutocompleteItem } from "@earendil-works/pi-tui";
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
import { applyRushPlanUpdate, type RushPlanUpdate } from "./workflow-plan-update.js";
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

const WorkflowRowChangeSchema = Type.Object({
  id: Type.Optional(Type.String({ description: "Unit id, component id (e.g. C1), or fleet stage (explore, implement, review, ci, canary). Omit for run-level fields." })),
  target: Type.Optional(StringEnum(["unit", "component", "fleet", "run"] as const, { description: "Required with add. Otherwise only needed when the same id names two kinds of row." })),
  set: Type.Optional(Type.Object({}, {
    additionalProperties: true,
    description: "Fields to set on that row, e.g. status, stage, attempt, retries, diagnoses, worker, clock, note, headSha, pr. Each value replaces the old one; null clears it.",
  })),
  add: Type.Optional(Type.Object({}, {
    additionalProperties: true,
    description: "A new unit or component row for a scope change, with target unit or component. A unit needs id, title, stage, status; a component needs id and status. Send set or add, not both.",
  })),
});

const WorkflowUpdateSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "Absolute path to .resolve-issues/rush/<run-id>/task-plan.json. Send with revision to bind or reload a workflow plan; omit event for a read-only bind." })),
  event: Type.Optional(Type.String({ description: "Short name for a saved transition, e.g. unit-validated. Required when sending changes, decision, or profiling; omit for a read-only bind." })),
  revision: Type.Optional(Type.Integer({ minimum: 0, description: "The planRevision you last saw. Required with path. The update is refused if the saved plan has a different revision." })),
  changes: Type.Optional(Type.Array(WorkflowRowChangeSchema, { maxItems: 50, description: "Every row this transition changes. All of them are saved together as one revision." })),
  decision: Type.Optional(Type.Object({
    id: Type.String({ description: "New, unique decision id." }),
    humanWords: Type.String({ description: "The human's words, quoted or closely paraphrased." }),
    changes: Type.String({ description: "What the decision changes: units, validation, forbidden actions." }),
    supersedes: Type.Optional(Type.String({ description: "Id of the earlier decision this one replaces." })),
  }, { description: "A human decision to record with this transition." })),
  profiling: Type.Optional(Type.Object({}, {
    additionalProperties: true,
    description: "Extra fields for this transition's profiling event, e.g. outcome, wallMs, waitMs, headSha.",
  })),
}, { description: "Bind, reload, or update a workflow-owned task plan. Send this instead of plan while a workflow owns planning." });

const UpdatePlanSchema = Type.Object({
  explanation: Type.Optional(Type.String({ description: "Why the plan or its status changed." })),
  plan: Type.Optional(Type.Array(PlanStepSchema, { minItems: 1, maxItems: 50, description: "The full generic checklist. Required unless you send workflow." })),
  workflow: Type.Optional(WorkflowUpdateSchema),
});

type WorkflowPlanInput = Omit<RushPlanUpdate, "event"> & { path?: string; event?: string };

const LEGACY_PLAN_NAV_STATUS_KEY = "pi-better-plan-nav";
const DELEGATION_MODE_REQUEST = "pi-better-subagents:delegation-mode-request";
type DelegationMode = "manual" | "adaptive" | "coordinator";

const PLAN_ACTIONS: readonly AutocompleteItem[] = [
  { value: "clear", label: "clear", description: "Remove the current plan" },
  { value: "hide", label: "hide", description: "Hide the plan widget" },
  { value: "show", label: "show", description: "Restore automatic plan display" },
  { value: "pin auto", label: "pin auto", description: "Use automatic plan pinning" },
  { value: "pin on", label: "pin on", description: "Keep the plan pinned" },
  { value: "pin off", label: "pin off", description: "Keep the plan unpinned" },
];

export function planArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  const prefix = argumentPrefix.trimStart().toLowerCase();
  const matches = PLAN_ACTIONS.filter((action) => action.value.startsWith(prefix));
  return matches.length > 0 ? [...matches] : null;
}

function activeDelegationMode(pi: ExtensionAPI): DelegationMode {
  const request: { mode?: string } = {};
  pi.events.emit(DELEGATION_MODE_REQUEST, request);
  return request.mode === "manual" || request.mode === "coordinator" ? request.mode : "adaptive";
}

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
    if (!rushBinding || workflowPlanOwner(ctx) !== rushBinding.owner) return null;
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

  const displayWorkflowPlan = (plan: RushPlan, binding: WorkflowPlanBinding): void => {
    if (!rushBinding || rushBinding.owner !== binding.owner || rushBinding.path !== binding.path || rushBinding.runId !== binding.runId) {
      pi.appendEntry(WORKFLOW_PLAN_ENTRY, { version: 1, kind: "set", ...binding });
    }
    displayedWorkflowOwner = binding.owner;
    rushBinding = binding;
    rushPlan = plan;
    rushError = null;
    refresh(true);
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
    const binding = workflowBinding(ctx.sessionManager.getBranch());
    rushBinding = binding?.owner === displayedWorkflowOwner ? binding : null;
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
            if (displayMode === "hidden" || displayedWorkflowOwner !== workflowPlanOwner(ctx)) return [];
            if (displayedWorkflowOwner) {
              if (rushBinding?.owner !== displayedWorkflowOwner) return [];
              const fg = typeof theme?.fg === "function"
                ? (color: string, value: string) => theme.fg(color as never, value)
                : undefined;
              return rushPlan ? ["", ...renderRushPlan(rushPlan, width, false, fg, displayedWorkflowOwner)] : [];
            }
            if (!currentPlan) return [];
            return ["", ...renderCompactPlan(currentPlan, width, theme as never)];
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
      const plan = loadRushPlan(ctx);
      if (!plan) {
        ctx.ui.notify(`${owner} plan unavailable: ${rushError ?? "not bound"}`, "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify(renderRushPlan(plan, 160, true, undefined, owner).join("\n"), "info");
        return;
      }
      await ctx.ui.custom<void>((tui, theme, _keys, done) => {
        const fg = typeof theme?.fg === "function"
          ? (color: string, value: string) => theme.fg(color as never, value)
          : undefined;
        const component = createRushPlanComponent(plan, () => done(), fg, owner);
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
    name: "update_plan",
    label: "Update Plan",
    description: "Universal plan interface: create or replace a generic checklist, bind or reload a workflow plan with workflow.path and revision, or save a workflow transition with event and changes. Every successful call refreshes the displayed plan.",
    promptSnippet: "Create and update a persistent structured execution plan",
    promptGuidelines: [
      "Use update_plan for work with three or more meaningful steps unless a skill owns planning; update it immediately when a step completes, becomes blocked, or scope changes.",
      "For generic plans only, mark distinct milestones in_progress when work is actually underway. Do not mark a delegated step completed until its result or failure has been inspected and integrated.",
      "For generic plans with prerequisites, give steps stable ids and dependsOn edges. Start only ready steps whose prerequisites are completed; independent ready steps may run in parallel when the active delegation mode permits it.",
      "For generic plans, follow the active delegation mode. Manual forbids proactive delegation even in plan mode; adaptive favors substantial independent work; coordinator delegates nontrivial role-owned tasks after agents_catalog discovery.",
      "Use a generic plan as a milestone ledger only when no workflow owns planning. Otherwise follow the workflow's task plan and foreground role.",
      "For generic plans, use separate steps for distinct deliverables, not one step per worker process. Before completing verification or the plan, inspect and integrate every relevant delegated result or failure.",
      "While a workflow owns planning, bind its persisted task plan with update_plan({workflow:{path,revision}}). Then record every transition with update_plan's workflow event and changes instead of editing task-plan.json or its profiling log; it saves the rows, the next planRevision, and the matching profiling event together. Path and revision can accompany the first transition to bind and update in one call.",
    ],
    parameters: UpdatePlanSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const owner = workflowPlanOwner(ctx);
      const input = params as { explanation?: string; plan?: PlanStepInput[]; workflow?: WorkflowPlanInput };
      if (input.workflow !== undefined) {
        if (!owner) throw new Error("No workflow owns the task plan; send plan instead of workflow.");
        if (input.plan !== undefined) throw new Error("Send either plan or workflow, not both.");
        const { path, ...transition } = input.workflow;
        if (transition.event === undefined && (transition.changes !== undefined || transition.decision !== undefined || transition.profiling !== undefined)) {
          throw new Error("workflow.event is required when sending changes, decision, or profiling.");
        }
        let binding = rushBinding?.owner === owner ? rushBinding : null;
        if (path !== undefined) {
          if (transition.revision === undefined) throw new Error("workflow.revision is required with workflow.path.");
          const plan = readRushPlan(path, ctx.cwd);
          if (plan.planRevision !== transition.revision) {
            if (transition.event === undefined) {
              rushPlan = null;
              rushError = `revision mismatch: expected ${transition.revision}, found ${plan.planRevision}`;
              refresh(true);
            }
            throw new Error(`Rush plan revision mismatch: expected ${transition.revision}, found ${plan.planRevision}.`);
          }
          binding = { owner, path, runId: plan.runId };
          if (transition.event === undefined) {
            displayWorkflowPlan(plan, binding);
            return { content: [{ type: "text", text: `Showing ${owner} rev ${plan.planRevision}: ${plan.issues.length} units.` }], details: { ok: true, runId: plan.runId, revision: plan.planRevision } };
          }
        }
        if (!binding) throw new Error(`No ${owner} plan is bound; send workflow.path and workflow.revision to update_plan first.`);
        if (transition.event === undefined) throw new Error("workflow.path is required to bind or reload a plan; otherwise send workflow.event and changes.");
        const result = applyRushPlanUpdate(binding.path, ctx.cwd, binding.runId, { ...transition, event: transition.event });
        displayWorkflowPlan(result.plan, binding);
        const rows = result.changed.map(({ target, id, added }) =>
          `${added ? "+" : ""}${id === null ? "run" : target === "unit" ? `#${id}` : id}`);
        const logNote = result.logAheadRevision === undefined ? ""
          : ` The profiling log already held rev ${result.logAheadRevision} (an earlier write stopped after logging); this event supersedes it.`;
        return {
          content: [{ type: "text", text: `Saved ${owner} rev ${result.revision} (${transition.event.trim()})${rows.length ? `: ${rows.join(", ")}` : ""}${input.workflow.decision ? `${rows.length ? ";" : ":"} decision ${input.workflow.decision.id}` : ""}. Profiling: ${result.profilingPath}.${logNote}` }],
          details: {
            ok: true, runId: result.plan.runId, revision: result.revision, changed: result.changed, profilingPath: result.profilingPath,
            ...(result.logAheadRevision === undefined ? {} : { logAheadRevision: result.logAheadRevision }),
          },
        };
      }
      if (owner) {
        throw new Error(`${owner} owns the task plan. Send workflow instead of plan; include path and revision to bind its persisted task plan.`);
      }
      if (input.plan === undefined) throw new Error("plan is required: send the full list of steps.");
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
        theme.fg("toolTitle", theme.bold("update_plan ")) + theme.fg("muted", args.workflow
          ? `workflow ${args.workflow.event ?? "bind"}`
          : `${args.plan?.length ?? 0} steps`),
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
        const workflowPlan = loadRushPlan(ctx);
        return {
          content: [{ type: "text", text: workflowPlan
            ? renderRushPlan(workflowPlan, 160, true, undefined, owner).join("\n")
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
    getArgumentCompletions: planArgumentCompletions,
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
      systemPrompt: `${event.systemPrompt}\n\n${planPrompt(currentPlan, activeDelegationMode(pi))}`,
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

function planPrompt(plan: PlanSnapshot, mode: DelegationMode): string {
  const delegation = mode === "manual"
    ? "Manual delegation mode: a plan does not authorize proactive delegation. Work in the foreground unless the user explicitly asks or an active workflow explicitly requires delegation."
    : mode === "coordinator"
      ? "Coordinator delegation mode: consult agents_catalog and delegate nontrivial role-owned milestones according to current role descriptions. Keep orchestration, cross-role decisions, unowned or ambiguous work, integration, and final verification in the foreground."
      : "Adaptive delegation mode: identify substantial independent work before implementation. Delegate a bounded task when useful and available while continuing unblocked foreground work; keep tightly coupled work in the foreground.";
  return [
    "Current structured execution plan:",
    ...plan.steps.map(stepLine),
    ...(plan.steps.some((item) => item.dependsOn?.length)
      ? [`Ready pending steps: ${planProgress(plan).readyIndices.map((index) => plan.steps[index]!.step).join(", ") || "none"}. Start only steps whose prerequisites are complete.`]
      : []),
    "Use update_plan immediately when a step completes, becomes blocked, or the scope changes.",
    delegation,
    "Mark distinct foreground and delegated milestones in_progress concurrently only when both are actually underway. Do not complete verification or the plan until relevant delegated work is terminal, inspected, integrated, and the outcome is evidence-backed.",
  ].join("\n");
}
