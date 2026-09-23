import type { Component } from "@earendil-works/pi-tui";
import {
  createPlanPresentationComponent, renderPlanPresentation,
  type PlanPresentation, type PlanRenderTheme,
} from "./plan-presentation.js";
import type { PlanSnapshot } from "./types.js";

export type { PlanRenderTheme } from "./plan-presentation.js";

function presentPlan(plan: PlanSnapshot): PlanPresentation {
  return {
    rows: plan.steps.map((item, index) => ({
      label: String(index + 1), title: item.step, status: item.status,
    })),
  };
}

export function renderCompactPlan(plan: PlanSnapshot, width: number, theme: PlanRenderTheme): string[] {
  return renderPlanPresentation(presentPlan(plan), width, theme);
}

export function renderFullPlan(plan: PlanSnapshot, width: number, theme: PlanRenderTheme, selectedIndex = -1): string[] {
  return renderPlanPresentation(presentPlan(plan), width, theme, true, selectedIndex);
}

export function createFullPlanComponent(plan: PlanSnapshot, theme: PlanRenderTheme, onClose: () => void): Component {
  return createPlanPresentationComponent(presentPlan(plan), theme, onClose);
}
