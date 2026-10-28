import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, matchesKey, type AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readHarnessSetting, updateHarnessSetting } from "../shared-harness-settings.js";
import { reconstructGoalSnapshot } from "pi-better-goal/src/goal-state.ts";
import { OUTCOME_ENTRY, prepareOutcome, restoreOutcome, formatOutcome, type Outcome, type OutcomeInput } from "./outcome-state.js";

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
import { createPlanWidget } from "./plan-widget.js";
import { installLegacyPlanMask, type LegacyPlanMask } from "./legacy-plan-mask.js";
import { COMPACT_PLAN_ROWS } from "./plan-presentation.js";
import {
  createRushPlanComponent, readRushPlan, renderRushPlan, workflowBinding,
  WORKFLOW_PLAN_ENTRY, visibleRushUnits, type RushPlan, type WorkflowPlanBinding,
} from "./workflow-plan.js";
import { cancelledRowsClearDelay, observeCancelledRows } from "./cancelled-rows.js";
import { applyRushPlanUpdate, type RushPlanUpdate } from "./workflow-plan-update.js";
import {
  EXTENSION_NAME,
  type PlanDisplayMode,
  type PlanSnapshot,
  type PlanStepInput,
} from "./types.js";

const PlanStepSchema = Type.Object({
  id: Type.Optional(Type.String({ description: "Stable step id used by dependsOn (letters, digits, underscore, hyphen; max 64 characters)." })),
  step: Type.String({ description: "Short, plain-language action label, usually 3-7 words, such as 'Add Todo toggle'. Keep methods and acceptance criteria outside the label." }),
  status: StringEnum(["pending", "in_progress", "completed", "blocked"] as const),
  dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Ids of prerequisite steps in this plan. All must be completed before this step starts." })),
});

const WorkflowRowChangeSchema = Type.Object({
  id: Type.Optional(Type.String({ description: "Unit id, component id (e.g. C1), or fleet stage (explore, implement, review, ci, canary). Omit for run-level fields." })),
  target: Type.Optional(StringEnum(["unit", "component", "fleet", "run"] as const, { description: "Required with add. Otherwise only needed when the same id names two kinds of row." })),
  set: Type.Optional(Type.Object({}, {
    additionalProperties: true,
    description: "Fields to set on that row, e.g. status, stage, attempt, retries, diagnoses, worker, clock, note, headSha, pr. Each value replaces the old one; null clears it. Keep title a short, plain-language action label, usually 3-7 words.",
  })),
  add: Type.Optional(Type.Object({}, {
    additionalProperties: true,
    description: "A new unit or component row for a scope change, with target unit or component. A unit needs id, title, stage, status; a component needs id and status. Use a short, plain-language action for title, usually 3-7 words. Send set or add, not both.",
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

const OutcomeSchema = Type.Object({
  objective: Type.String({ minLength: 1 }),
  doneWhen: Type.Optional(Type.Array(Type.String())),
  boundaries: Type.Optional(Type.Array(Type.String())),
  source: Type.Optional(Type.String()),
  status: Type.Optional(StringEnum(["active", "paused", "complete", "cancelled"] as const)),
});
const UpdatePlanSchema = Type.Object({
  explanation: Type.Optional(Type.String()),
  newTask: Type.Optional(Type.Boolean({ description: "Start an unrelated task: replace the previous outcome and detach its Todo and Goal binding. Omit for a correction or refinement of the current task." })),
  todo: Type.Optional(Type.Array(PlanStepSchema, { maxItems: 50 })),
  outcome: Type.Optional(OutcomeSchema),
  workflow: Type.Optional(WorkflowUpdateSchema),
});

type WorkflowPlanInput = Omit<RushPlanUpdate, "event"> & { path?: string; event?: string };

const LEGACY_PLAN_NAV_STATUS_KEY = "pi-better-plan-nav";
const PLAN_ACTIONS: readonly AutocompleteItem[] = [
  { value: "clear", label: "clear", description: "Remove the current Todo without changing its outcome" },
  { value: "hide", label: "hide", description: "Hide the Todo widget" },
  { value: "show", label: "show", description: "Restore automatic Todo display" },
  { value: "expand", label: "expand", description: "Show all steps in the Todo widget" },
  { value: "collapse", label: "collapse", description: "Show up to five relevant steps" },
  { value: "pin auto", label: "pin auto", description: "Use automatic Todo pinning" },
  { value: "pin on", label: "pin on", description: "Keep Todo pinned" },
  { value: "pin off", label: "pin off", description: "Keep Todo unpinned" },
];

export function planArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  const prefix = argumentPrefix.trimStart().toLowerCase();
  const matches = PLAN_ACTIONS.filter((action) => action.value.startsWith(prefix));
  return matches.length > 0 ? [...matches] : null;
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

export default function taskContextExtension(pi: ExtensionAPI): void {
  let enabled = false;
  let outcome: Outcome | null = null;
  const readEnabled = (value: unknown): boolean => {
    if (value === undefined) return false;
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as any).version !== 1 || typeof (value as any).enabled !== "boolean") throw new Error("Invalid outcomeTodo setting.");
    return (value as { enabled: boolean }).enabled;
  };
  const syncTools = (): void => {
    if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
    const active = pi.getActiveTools().filter(name => name !== "update_todo" && name !== "get_todo");
    pi.setActiveTools(enabled ? [...active, "update_todo", "get_todo"] : active);
  };
  const saveOutcome = (next: Outcome): void => {
    outcome = next;
    pi.appendEntry(OUTCOME_ENTRY, { version: 1, outcome: next });
    refresh(true);
  };
  let currentPlan: PlanSnapshot | null = null;
  let displayMode: PlanDisplayMode = "auto";
  let expanded = false;
  let displayedWorkflowOwner: string | null = null;
  let rushBinding: WorkflowPlanBinding | null = null;
  let rushPlan: RushPlan | null = null;
  let rushError: string | null = null;
  let refreshWidget: ((force?: boolean) => void) | undefined;
  let completedPlanClearTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelledRowsTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshFullPlan: (() => void) | undefined;
  const cancelCancelledRowsTimer = (): void => {
    if (cancelledRowsTimer !== undefined) clearTimeout(cancelledRowsTimer);
    cancelledRowsTimer = undefined;
  };
  const scheduleCancelledRowsClear = (): void => {
    cancelCancelledRowsTimer();
    if (!rushPlan) return;
    const delay = cancelledRowsClearDelay(rushPlan);
    if (delay === null) return;
    const timer = setTimeout(() => {
      if (cancelledRowsTimer !== timer) return;
      cancelledRowsTimer = undefined;
      refresh(true);
      scheduleCancelledRowsClear();
    }, delay);
    cancelledRowsTimer = timer;
    timer.unref?.();
  };
  const observeCancellations = (plan: RushPlan, binding: WorkflowPlanBinding, ctx: ExtensionContext): void => {
    observeCancelledRows(plan, binding, ctx.sessionManager.getBranch(), (type, data) => pi.appendEntry(type, data));
  };
  const unsubscribeWorkflow = pi.events.on("pi-better-workflow:changed", (owner) => {
    displayedWorkflowOwner = owner && typeof owner === "object" && "name" in owner && typeof owner.name === "string"
      ? owner.name : null;
    if (!enabled) return;
    if (displayedWorkflowOwner) {
      cancelCancelledRowsTimer();
      rushBinding = null;
      rushPlan = null;
      rushError = null;
    }
    refresh(true);
  });

  const refresh = (force = false): void => {
    refreshWidget?.(force);
    refreshFullPlan?.();
  };

  const loadRushPlan = (ctx: ExtensionContext): RushPlan | null => {
    const owner = workflowPlanOwner(ctx);
    const binding = workflowBinding(ctx.sessionManager.getBranch());
    displayedWorkflowOwner = owner;
    rushBinding = binding && (!owner || binding.owner === owner) ? binding : null;
    if (!rushBinding) {
      rushPlan = null;
      rushError = null;
      cancelCancelledRowsTimer();
      return null;
    }
    try {
      const plan = readRushPlan(rushBinding.path, ctx.cwd);
      if (plan.runId !== rushBinding.runId) throw new Error("Rush run identity changed.");
      observeCancellations(plan, rushBinding, ctx);
      rushPlan = plan;
      rushError = null;
    } catch (error) {
      rushPlan = null;
      rushError = error instanceof Error ? error.message : String(error);
    }
    scheduleCancelledRowsClear();
    refresh(true);
    return rushPlan;
  };

  const displayWorkflowPlan = (plan: RushPlan, binding: WorkflowPlanBinding, ctx: ExtensionContext, readOnly = false): void => {
    if (!rushBinding || rushBinding.owner !== binding.owner || rushBinding.path !== binding.path || rushBinding.runId !== binding.runId) {
      pi.appendEntry(WORKFLOW_PLAN_ENTRY, { version: 1, kind: "set", ...binding });
    }
    displayedWorkflowOwner = readOnly ? null : binding.owner;
    rushBinding = binding;
    observeCancellations(plan, binding, ctx);
    rushPlan = plan;
    rushError = null;
    scheduleCancelledRowsClear();
    refresh(true);
  };

  const clearWorkflowPlan = (): void => {
    cancelCancelledRowsTimer();
    if (rushBinding) pi.appendEntry(WORKFLOW_PLAN_ENTRY, { version: 1, kind: "clear" });
    rushBinding = null;
    rushPlan = null;
    rushError = null;
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
    const entries = ctx.sessionManager.getBranch();
    outcome = restoreOutcome(entries);
    if (enabled) {
      const trigger = reconstructGoalSnapshot(entries);
      if (!outcome && trigger && trigger.status !== "complete") {
        outcome = { objective: trigger.objective, source: "goal", goalId: trigger.goalId, status: trigger.status === "active" ? "active" : "paused" };
      } else if (outcome?.goalId && outcome.status !== "complete" && outcome.status !== "cancelled") {
        const status = trigger?.goalId !== outcome.goalId ? "paused"
          : trigger.status === "complete" ? "complete" : trigger.status === "active" ? "active" : "paused";
        outcome = { ...outcome, status };
      }
    }
    cancelCompletedPlanClear();
    cancelCancelledRowsTimer();
    const state = reconstructPlanState(ctx.sessionManager.getBranch());
    currentPlan = state.plan;
    displayedWorkflowOwner = workflowPlanOwner(ctx);
    const binding = workflowBinding(ctx.sessionManager.getBranch());
    rushBinding = binding && (!displayedWorkflowOwner || binding.owner === displayedWorkflowOwner) ? binding : null;
    rushPlan = null;
    rushError = null;
    if (enabled && rushBinding) loadRushPlan(ctx);
    displayMode = state.displayMode;
    expanded = state.expanded;
    if (ctx.hasUI) ctx.ui.setStatus(LEGACY_PLAN_NAV_STATUS_KEY, undefined);
    refresh(true);
    if (enabled) scheduleCompletedPlanClear();
  };

  const persistPlan = (plan: PlanSnapshot): void => {
    clearWorkflowPlan();
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

  const setExpanded = (value: boolean): void => {
    expanded = value;
    pi.appendEntry(EXTENSION_NAME, { version: 1, kind: "expansion", expanded, at: Math.floor(Date.now() / 1_000) });
    refresh(true);
  };

  const installWidget = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(
      EXTENSION_NAME,
      (tui, theme) => {
        const localRefresh = (force = false): void => tui.requestRender(force);
        refreshWidget = localRefresh;
        const widget = createPlanWidget(
          (width: number): string[] => {
            if (!enabled || displayMode === "hidden" || displayedWorkflowOwner !== workflowPlanOwner(ctx)) return [];
            const heading = outcome ? new Text(`Outcome (${outcome.status}): ${outcome.objective}`, 0, 0).render(width).slice(0, 2) : [];
            if (displayedWorkflowOwner || rushBinding) {
              if (!rushBinding || (displayedWorkflowOwner && rushBinding.owner !== displayedWorkflowOwner) ||
                  !workflowBinding(ctx.sessionManager.getBranch())) return heading;
              const fg = typeof theme?.fg === "function"
                ? (color: string, value: string) => theme.fg(color as never, value)
                : undefined;
              return [...heading, ...(rushPlan ? renderRushPlan(rushPlan, width, false, fg, rushBinding.owner, !displayedWorkflowOwner, expanded) : [])];
            }
            return [...heading, ...(currentPlan ? renderCompactPlan(currentPlan, width, theme as never, expanded) : [])];
          },
          () => (rushBinding && rushPlan ? visibleRushUnits(rushPlan).length : currentPlan?.steps.length ?? 0) > COMPACT_PLAN_ROWS,
          () => expanded,
          () => setExpanded(!expanded),
        );
        return {
          ...widget,
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
    const binding = workflowBinding(ctx.sessionManager.getBranch());
    if (owner || binding) {
      const plan = loadRushPlan(ctx);
      const planOwner = owner ?? binding!.owner;
      if (!plan) {
        ctx.ui.notify(`${planOwner}${owner ? " plan" : " read-only handoff"} unavailable: ${rushError ?? "not bound"}`, "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify(renderRushPlan(plan, 160, true, undefined, planOwner, !owner).join("\n"), "info");
        return;
      }
      try {
        await ctx.ui.custom<void>((tui, theme, _keys, done) => {
          refreshFullPlan = () => tui.requestRender();
          const fg = typeof theme?.fg === "function"
            ? (color: string, value: string) => theme.fg(color as never, value)
            : undefined;
          const component = createRushPlanComponent(() => rushPlan ?? { ...plan, issues: [] }, () => done(), fg, planOwner, !owner);
          return { render: (width) => [...(outcome ? new Text(formatOutcome(outcome, true), 0, 0).render(width).slice(0, 6) : []), ...component.render(width)], handleInput(data) {
            component.handleInput?.(data);
            tui.requestRender();
          }, invalidate: () => component.invalidate() };
        });
      } finally {
        refreshFullPlan = undefined;
      }
      return;
    }
    if (!currentPlan) {
      if (!outcome) { ctx.ui.notify("No outcome or Todo is set.", "info"); return; }
      if (ctx.mode !== "tui") { ctx.ui.notify(formatOutcome(outcome), "info"); return; }
      await ctx.ui.custom<void>((_tui, _theme, _keys, done) => ({
        render: width => new Text(formatOutcome(outcome), 0, 0).render(width),
        handleInput: data => { if (matchesKey(data, "escape") || matchesKey(data, "left")) done(); },
        invalidate() {},
      }));
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
        render: (width) => [...(outcome ? new Text(formatOutcome(outcome, true), 0, 0).render(width).slice(0, 6) : []), ...component.render(width)],
        handleInput(data) {
          component.handleInput?.(data);
          tui.requestRender();
        },
        invalidate: () => component.invalidate(),
      };
    });
  };


  pi.registerTool({
    name: "update_todo",
    label: "Update Todo",
    description: "Manage the accepted outcome and Todo: save an outcome alone, update a generic checklist, or bind and update the workflow's canonical task plan. Existing workflow revision checks apply.",
    promptSnippet: "Remember the accepted outcome and update optional Todo progress",
    promptGuidelines: [
      "Capture the accepted outcome before substantive implementation, delegation, or investigation. An outcome-only update is valid; do not invent a checklist or acceptance criteria.",
      "Use newTask:true with its outcome when the user switches to unrelated work. Omit newTask for a correction or refinement of the same task. Mark the outcome complete explicitly; checklist completion alone is not delivery.",
      "Use a Todo checklist when several meaningful milestones help track delivery; update it when work completes, is blocked, or changes scope.",
      "Write each Todo label as a short action in plain language, usually 3-7 English words or a similarly short phrase in the task's language. For example: 'Add Todo toggle' or 'Test keyboard controls'. Put methods, file paths, rationale, and acceptance criteria in the outcome, explanation, or workflow records, not the label. Apply this to workflow titles too; do not copy long issue headings.",
      "For generic plans only, mark distinct milestones in_progress when work is actually underway. Do not mark a delegated step completed until its result or failure has been inspected and integrated.",
      "For generic plans with prerequisites, give steps stable ids and dependsOn edges for actual dependencies, not list order. Start ready independent steps concurrently under the Harness execution policy; subagent delegation mode controls subagents, not background-command concurrency.",
      "For generic plans, follow the active delegation mode for subagents. Manual forbids proactive subagent delegation even in plan mode; adaptive favors substantial independent work; coordinator delegates nontrivial role-owned tasks after agents_catalog discovery.",
      "Use a generic plan as a milestone ledger only when no workflow owns planning. Otherwise follow the workflow's task plan and foreground role.",
      "For generic plans, use separate steps for distinct deliverables, not one step per worker process. Before completing verification or the plan, inspect and integrate every relevant delegated result or failure.",
      "While a workflow owns planning, bind its persisted task plan with update_todo({workflow:{path,revision}}). Record transitions with workflow event and changes rather than editing task-plan.json or its profiling log.",
    ],
    parameters: UpdatePlanSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!enabled) throw new Error("Outcome & Todo is off. Enable it in /harness-settings.");
      const owner = workflowPlanOwner(ctx);
      const input = params as { explanation?: string; newTask?: boolean; todo?: PlanStepInput[]; outcome?: OutcomeInput; workflow?: WorkflowPlanInput };
      if (!input.outcome && input.todo === undefined && !input.workflow) throw new Error("Send outcome, todo, or workflow.");
      if (input.newTask && !input.outcome) throw new Error("A new task requires its outcome.");
      if (input.todo !== undefined && input.workflow !== undefined) throw new Error("Send either todo or workflow, not both.");
      if (input.todo !== undefined && owner) throw new Error(`${owner} owns the task plan. Send workflow instead of todo.`);
      const nextOutcome = input.outcome ? prepareOutcome(outcome, input.outcome, input.newTask) : null;
      const replacement = input.todo?.length ? replacePlan(input.newTask ? null : currentPlan, input.todo, input.explanation) : null;
      // Commit task memory only after the requested checklist or workflow operation succeeds.
      const commitOutcome = (): void => {
        if (!nextOutcome) return;
        if (input.newTask && input.todo === undefined) {
          if (!input.workflow) clearWorkflowPlan();
          if (currentPlan) clearPlan();
        }
        saveOutcome(nextOutcome);
      };
      if (!input.workflow && input.todo === undefined) {
        commitOutcome();
        return { content: [{ type: "text", text: "Outcome updated." }], details: { ok: true, outcome } };
      }
      if (input.workflow !== undefined) {
        const savedBinding = workflowBinding(ctx.sessionManager.getBranch());
        if (!owner && (input.workflow.event !== undefined || input.workflow.changes !== undefined ||
            input.workflow.decision !== undefined || input.workflow.profiling !== undefined || !savedBinding)) {
          throw new Error(savedBinding
            ? `${savedBinding.owner} plan is a read-only handoff. Reinvoke /skill:${savedBinding.owner} before updating its workflow plan.`
            : "No workflow owns the task plan; send plan instead of workflow.");
        }
        if (input.todo !== undefined) throw new Error("Send either todo or workflow, not both.");
        const { path, ...transition } = input.workflow;
        if (transition.event === undefined && (transition.changes !== undefined || transition.decision !== undefined || transition.profiling !== undefined)) {
          throw new Error("workflow.event is required when sending changes, decision, or profiling.");
        }
        let binding = savedBinding && (!owner || savedBinding.owner === owner) ? savedBinding : null;
        if (path !== undefined) {
          if (!owner && path !== binding?.path) {
            throw new Error(`${binding!.owner} plan is a read-only handoff; only its bound path can be reloaded. Reinvoke /skill:${binding!.owner} to bind a workflow plan.`);
          }
          if (transition.revision === undefined) throw new Error("workflow.revision is required with workflow.path.");
          const plan = readRushPlan(path, ctx.cwd);
          if (!owner && plan.runId !== binding!.runId) throw new Error("Rush run identity changed.");
          if (plan.planRevision !== transition.revision) {
            if (transition.event === undefined) {
              rushPlan = null;
              rushError = `revision mismatch: expected ${transition.revision}, found ${plan.planRevision}`;
              refresh(true);
            }
            throw new Error(`Rush plan revision mismatch: expected ${transition.revision}, found ${plan.planRevision}.`);
          }
          binding = { owner: owner ?? binding!.owner, path, runId: plan.runId };
          if (transition.event === undefined) {
            displayWorkflowPlan(plan, binding, ctx, !owner);
            commitOutcome();
            return { content: [{ type: "text", text: `Showing ${binding.owner} rev ${plan.planRevision}: ${plan.issues.length} units.${owner ? "" : " Read-only handoff."}` }], details: { ok: true, runId: plan.runId, revision: plan.planRevision, ...(!owner ? { readOnly: true } : {}) } };
          }
        }
        if (!binding) throw new Error(`No ${owner} plan is bound; send workflow.path and workflow.revision to update_todo first.`);
        if (transition.event === undefined) throw new Error("workflow.path is required to bind or reload a plan; otherwise send workflow.event and changes.");
        const result = applyRushPlanUpdate(binding.path, ctx.cwd, binding.runId, { ...transition, event: transition.event });
        displayWorkflowPlan(result.plan, binding, ctx);
        commitOutcome();
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
      if (input.todo === undefined) throw new Error("todo is required: send the full list of steps.");
      if (!replacement) {
        clearWorkflowPlan(); clearPlan(); commitOutcome();
        return { content: [{ type: "text", text: "Todo cleared." }], details: { ok: true, outcome } };
      }
      const plan = replacement;
      persistPlan(plan);
      commitOutcome();
      const progress = planProgress(plan);
      return {
        content: [{ type: "text", text: formatProgress(plan) }],
        details: { ok: true, plan, progress },
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("update_todo ")) + theme.fg("muted", args.workflow
          ? `workflow ${args.workflow.event ?? "bind"}`
          : `${args.todo?.length ?? 0} steps`),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const text = result.content[0];
      return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text?.type === "text" ? text.text : "Todo updated"), 0, 0);
    },
  });

  const getTodoParameters = Type.Object({});
  pi.registerTool({
    name: "get_todo",
    label: "Get Todo",
    description: "Inspect the accepted outcome, Todo progress, and any bound workflow task plan.",
    promptSnippet: "Inspect the current outcome and Todo",
    parameters: getTodoParameters,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (!enabled) throw new Error("Outcome & Todo is off. Enable it in /harness-settings.");
      const owner = workflowPlanOwner(ctx);
      const binding = workflowBinding(ctx.sessionManager.getBranch());
      if (owner || binding) {
        const workflowPlan = loadRushPlan(ctx);
        const planOwner = owner ?? binding!.owner;
        return {
          content: [{ type: "text", text: `${formatOutcome(outcome)}\n${workflowPlan
            ? renderRushPlan(workflowPlan, 160, true, undefined, planOwner, !owner).join("\n")
            : owner ? `${owner} owns the task plan; ${rushError ?? "consult its persisted workflow state"}.`
              : `${planOwner} read-only handoff unavailable: ${rushError ?? "not bound"}.`}` }],
          details: { outcome, hasPlan: !!workflowPlan, plan: workflowPlan, progress: null, workflowOwner: planOwner, ...(!owner ? { readOnly: true } : {}) },
        };
      }
      if (!currentPlan) {
        return {
          content: [{ type: "text", text: `${formatOutcome(outcome)}\nNo todo is set.` }],
          details: { outcome, hasPlan: false, plan: null, progress: null },
        };
      }
      const progress = planProgress(currentPlan);
      return {
        content: [{ type: "text", text: `${formatOutcome(outcome)}\n${formatPlan(currentPlan)}` }],
        details: { outcome, hasPlan: true, plan: currentPlan, progress },
      };
    },
  });

  pi.registerCommand("todo", {
    description: "Inspect, show, hide, or clear the current Todo and inspect its outcome",
    getArgumentCompletions: planArgumentCompletions,
    handler: async (args, ctx) => {
      if (!enabled) { ctx.ui.notify("Enable Outcome & Todo in /harness-settings.", "info"); return; }
      const input = args.trim().toLowerCase();
      if (!input) return showFullPlan(ctx);
      if (input === "clear") {
        if (workflowPlanOwner(ctx)) {
          ctx.ui.notify("The workflow owns its plan; /todo clear cannot change it.", "warning");
          return;
        }
        clearWorkflowPlan();
        clearPlan();
        ctx.ui.notify("Todo cleared; the outcome is unchanged.", "info");
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
      if (input === "expand" || input === "collapse") {
        setExpanded(input === "expand");
        return;
      }
      const pinMode = input.match(/^pin\s+(auto|on|off)$/)?.[1] as PlanDisplayMode | undefined;
      if (pinMode) {
        setDisplayMode(pinMode);
        ctx.ui.notify(`Todo display: ${pinMode}.`, "info");
        return;
      }
      ctx.ui.notify("Usage: /todo [clear|hide|show|expand|collapse|pin auto|pin on|pin off]", "warning");
    },
  });

  const setting = {
    id: "outcome-todo", label: "Outcome & Todo", values: ["Off", "On"],
    get: () => enabled ? "On" : "Off",
    async change(value: string, ctx: ExtensionContext) {
      if (value !== "On" && value !== "Off") throw new Error("Invalid Outcome & Todo mode.");
      updateHarnessSetting("outcomeTodo", current => { readEnabled(current); return { version: 1, enabled: value === "On" }; });
      enabled = value === "On";
      syncTools();
      if (enabled) { installWidget(ctx); restore(ctx); }
      else { cancelCompletedPlanClear(); cancelCancelledRowsTimer(); if (ctx.hasUI) ctx.ui.setWidget(EXTENSION_NAME, undefined); refreshWidget = undefined; }
    },
  };
  const registerSettings = () => pi.events.emit("harness-settings:register", setting);
  const unsubscribeSettings = pi.events.on("harness-settings:request", registerSettings);
  registerSettings();
  const unsubscribeTask = pi.events.on("pi-better-harness:task-context", (event: unknown) => {
    if (!event || typeof event !== "object") return;
    const request = event as { action: string; goalId?: string; objective?: string; enabled?: boolean };
    request.enabled = enabled;
    if (!enabled || request.action === "inspect") return;
    if (request.action === "start" && request.goalId && request.objective?.trim()) {
      if (outcome?.goalId === request.goalId) return;
      clearWorkflowPlan();
      if (currentPlan) clearPlan();
      saveOutcome({ objective: request.objective.trim(), status: "active", goalId: request.goalId, source: "goal" });
    } else if (outcome && request.goalId && outcome.goalId === request.goalId) {
      const status = request.action === "pause" ? "paused" : request.action === "resume" ? "active" : request.action === "complete" ? "complete" : null;
      if (status) saveOutcome({ ...outcome, status });
    }
  });
  let legacyPlanMask: LegacyPlanMask | undefined;
  const onSessionStart = async (_event: unknown, ctx: ExtensionContext): Promise<void> => {
    // Retire a separately installed pi-better-plan before installing our Todo widget.
    await legacyPlanMask?.cleanup(ctx);
    try { enabled = readEnabled(readHarnessSetting("outcomeTodo")); } catch (error) { enabled = false; if (ctx.hasUI) ctx.ui.notify(String(error), "warning"); }
    syncTools();
    if (enabled) installWidget(ctx);
    restore(ctx);
    registerSettings();
  };
  legacyPlanMask = installLegacyPlanMask(getTodoParameters);
  pi.on("session_start", onSessionStart);
  pi.on("session_tree", async (_event, ctx) => {
    restore(ctx);
  });
  pi.on("context", (event) => {
    const messages = event.messages.filter(message => message.role !== "custom" || message.customType !== "pi-better-harness:outcome-reminder");
    if (!enabled || outcome?.status !== "active") return messages.length === event.messages.length ? undefined : { messages };
    const unit = rushPlan?.issues.find(item => item.status === "in-flight") ?? rushPlan?.issues.find(item => item.status === "pending");
    const step = currentPlan?.steps.find(item => item.status === "in_progress") ?? currentPlan?.steps.find(item => item.status === "pending");
    const focus = rushBinding ? (unit ? `${unit.id}: ${unit.title}` : undefined) : step?.step;
    return { messages: [...messages, { role: "custom" as const, customType: "pi-better-harness:outcome-reminder", content: `${formatOutcome(outcome, true)}${focus ? `\nTodo focus: ${focus.slice(0, 300)}` : ""}\nChoose work that advances this outcome or meets a binding requirement. Report unrelated debt without fixing it. Latest user instructions win; questions are not permission to execute. Stop when the agreed outcome and required checks are done.`, display: false, timestamp: Date.now() }] };
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    cancelCompletedPlanClear();
    cancelCancelledRowsTimer();
    refreshFullPlan = undefined;
    if (typeof unsubscribeWorkflow === "function") unsubscribeWorkflow();
    if (typeof unsubscribeSettings === "function") unsubscribeSettings();
    if (typeof unsubscribeTask === "function") unsubscribeTask();
    refreshWidget = undefined;
    try {
      ctx.ui.setStatus(LEGACY_PLAN_NAV_STATUS_KEY, undefined);
      ctx.ui.setWidget(EXTENSION_NAME, undefined);
    } catch { /* best-effort cleanup */ }
    legacyPlanMask?.dispose();
    legacyPlanMask = undefined;
  });
}


function formatProgress(plan: PlanSnapshot): string {
  const progress = planProgress(plan);
  const current = progress.activeIndex === null ? null : plan.steps[progress.activeIndex];
  const status = [`Todo updated: ${progress.completed}/${progress.total} steps completed`];
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
    `Todo: ${progress.completed}/${progress.total} steps completed${progress.blocked ? `, ${progress.blocked} blocked` : ""}`,
    ...plan.steps.map(stepLine),
    ...(plan.steps.some((item) => item.dependsOn?.length)
      ? [`Ready: ${progress.readyIndices.map((index) => plan.steps[index]!.step).join(", ") || "none"}`]
      : []),
  ].join("\n");
}
