import type { Component } from "@earendil-works/pi-tui";
import {
  createPlanPresentationComponent, renderPlanPresentation,
  type PlanPresentation, type PlanRenderTheme,
} from "./plan-presentation.js";
import type { PlanSnapshot } from "./types.js";

export type { PlanRenderTheme } from "./plan-presentation.js";

// The compact widget keeps stable ordinals; the full view names each step by its id
// so a prerequisite edge (`after: <id>`) can be traced back to the row it names.
function presentPlan(plan: PlanSnapshot, showIds = false): PlanPresentation {
  return {
    rows: plan.steps.map((item, index) => ({
      label: showIds && item.id ? item.id : String(index + 1),
      title: item.step,
      status: item.status,
      ...(item.dependsOn?.length ? { details: [`after: ${item.dependsOn.join(", ")}`] } : {}),
    })),
  };
}

export function renderCompactPlan(plan: PlanSnapshot, width: number, theme: PlanRenderTheme, expanded = false): string[] {
  return renderPlanPresentation(presentPlan(plan), width, theme, false, -1, expanded);
}

export function renderFullPlan(plan: PlanSnapshot, width: number, theme: PlanRenderTheme, selectedIndex = -1): string[] {
  return renderPlanPresentation(presentPlan(plan, true), width, theme, true, selectedIndex);
}

export function createFullPlanComponent(plan: PlanSnapshot, theme: PlanRenderTheme, onClose: () => void): Component {
  return createPlanPresentationComponent(presentPlan(plan, true), theme, onClose);
}
