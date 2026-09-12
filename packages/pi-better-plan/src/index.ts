import { StringEnum } from "@earendil-works/pi-ai";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
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

const PLAN_NAV_STATUS_KEY = "pi-better-plan-nav";
const PLAN_EDITOR_FACTORY_MARK = "__piBetterPlanFactory";
const PLAN_EDITOR_FACTORY_REFRESH = "__piBetterPlanRefresh";
const PLAN_NAVIGATION_KEY = Symbol.for("pi-better-harness.plan-navigation.state");

interface SharedPlanNavigationState {
  visible: boolean;
  progressLabel?: string;
  releaseWorkFocus?: () => void;
  refreshNavigationHint?: () => void;
}

function sharedPlanNavigationState(): SharedPlanNavigationState {
  const global = globalThis as typeof globalThis & { [PLAN_NAVIGATION_KEY]?: SharedPlanNavigationState };
  if (!global[PLAN_NAVIGATION_KEY]) global[PLAN_NAVIGATION_KEY] = { visible: false };
  return global[PLAN_NAVIGATION_KEY]!;
}

export default function planExtension(pi: ExtensionAPI): void {
  let currentPlan: PlanSnapshot | null = null;
  let displayMode: PlanDisplayMode = "auto";
  let selectedIndex = 0;
  let focused = false;
  let refreshWidget: ((force?: boolean) => void) | undefined;
  let currentCtx: ExtensionContext | undefined;

  const refresh = (force = false): void => refreshWidget?.(force);

  const updateNavigationHint = (ctx = currentCtx): void => {
    if (!ctx?.hasUI) return;
    const progress = currentPlan ? planProgress(currentPlan) : null;
    const visible = currentPlan !== null && displayMode !== "hidden";
    const navigation = sharedPlanNavigationState();
    navigation.visible = visible;
    const suffix = progress?.blocked ? "blocked" : progress ? `${progress.completed}/${progress.total}` : "";
    if (suffix) navigation.progressLabel = suffix;
    else delete navigation.progressLabel;
    if (navigation.refreshNavigationHint) {
      ctx.ui.setStatus(PLAN_NAV_STATUS_KEY, undefined);
      navigation.refreshNavigationHint();
    } else {
      ctx.ui.setStatus(PLAN_NAV_STATUS_KEY, visible ? `→ plan · ${suffix}` : undefined);
    }
  };

  const restore = (ctx: ExtensionContext): void => {
    const state = reconstructPlanState(ctx.sessionManager.getBranch());
    currentPlan = state.plan;
    displayMode = state.displayMode;
    selectedIndex = preferredIndex(currentPlan);
    focused = false;
    updateNavigationHint(ctx);
    refresh(true);
  };

  const persistPlan = (plan: PlanSnapshot): void => {
    currentPlan = plan;
    selectedIndex = preferredIndex(plan);
    focused = false;
    pi.appendEntry(EXTENSION_NAME, planSetEntry(plan));
    updateNavigationHint();
    refresh(true);
  };

  const setDisplayMode = (mode: PlanDisplayMode): void => {
    displayMode = mode;
    pi.appendEntry(EXTENSION_NAME, planDisplayEntry(mode));
    updateNavigationHint();
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
            return renderCompactPlan(currentPlan, width, theme as never, { focused, selectedIndex });
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
    focused = false;
    refresh();
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

  const handlePlanNavigation = (data: string, ctx: ExtensionContext): boolean => {
    if (!currentPlan || displayMode === "hidden") return false;
    if (!focused) {
      if (!matchesKey(data, Key.right)) return false;
      sharedPlanNavigationState().releaseWorkFocus?.();
      focused = true;
      selectedIndex = preferredIndex(currentPlan);
      refresh();
      return true;
    }
    if (matchesKey(data, Key.up)) {
      selectedIndex = Math.max(0, selectedIndex - 1);
      refresh();
      return true;
    }
    if (matchesKey(data, Key.down)) {
      selectedIndex = Math.min(currentPlan.steps.length - 1, selectedIndex + 1);
      refresh();
      return true;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
      void showFullPlan(ctx);
      return true;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.escape)) {
      focused = false;
      refresh();
      return true;
    }
    focused = false;
    refresh();
    return false;
  };

  const installEditorNavigation = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;
    const ui = ctx.ui as typeof ctx.ui & {
      getEditorComponent?(): ((tui: unknown, theme: unknown, keybindings: unknown) => unknown) | undefined;
      setEditorComponent(factory: (tui: unknown, theme: unknown, keybindings: unknown) => unknown): void;
    };
    const previous = ui.getEditorComponent?.() as
      | (((tui: unknown, theme: unknown, keybindings: unknown) => unknown) & Record<string, unknown>)
      | undefined;
    const handlers = { handle: (data: string) => handlePlanNavigation(data, ctx) };
    if (previous?.[PLAN_EDITOR_FACTORY_MARK] === true) {
      const replaceHandlers = previous[PLAN_EDITOR_FACTORY_REFRESH];
      if (typeof replaceHandlers === "function") replaceHandlers(handlers);
      return;
    }
    let currentHandlers = handlers;
    const factory = ((tui: unknown, theme: unknown, keybindings: unknown) => {
      const inner = (previous
        ? previous(tui, theme, keybindings)
        : new CustomEditor(tui as never, theme as never, keybindings as never)) as {
        getText?(): string;
        handleInput(data: string): void;
      };
      return new Proxy(inner, {
        get(target, property) {
          if (property === "handleInput") {
            return (data: string) => {
              if (target.getText?.() === "" && currentHandlers.handle(data)) return;
              target.handleInput(data);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as ((tui: unknown, theme: unknown, keybindings: unknown) => unknown) & Record<string, unknown>;
    factory[PLAN_EDITOR_FACTORY_MARK] = true;
    factory[PLAN_EDITOR_FACTORY_REFRESH] = (next: typeof handlers) => { currentHandlers = next; };
    ui.setEditorComponent(factory);
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
        currentPlan = null;
        focused = false;
        pi.appendEntry(EXTENSION_NAME, planClearEntry());
        updateNavigationHint(ctx);
        refresh(true);
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
    currentCtx = ctx;
    installWidget(ctx);
    installEditorNavigation(ctx);
    restore(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    currentCtx = ctx;
    restore(ctx);
  });
  pi.on("before_agent_start", async (event) => {
    if (!currentPlan) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${planPrompt(currentPlan)}`,
    };
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    refreshWidget = undefined;
    currentCtx = undefined;
    const navigation = sharedPlanNavigationState();
    navigation.visible = false;
    delete navigation.progressLabel;
    navigation.refreshNavigationHint?.();
    try {
      ctx.ui.setStatus(PLAN_NAV_STATUS_KEY, undefined);
      ctx.ui.setWidget(EXTENSION_NAME, undefined);
    } catch { /* best-effort cleanup */ }
  });
}

function preferredIndex(plan: PlanSnapshot | null): number {
  if (!plan) return 0;
  const progress = planProgress(plan);
  if (progress.activeIndex !== null) return progress.activeIndex;
  const next = plan.steps.findIndex((item) => item.status !== "completed");
  return next >= 0 ? next : Math.max(0, plan.steps.length - 1);
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