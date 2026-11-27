import { renderPlanPresentation, type PlanPresentation, type PlanRenderTheme } from "./plan-presentation.js";
import type { PlanSnapshot } from "./types.js";
import type { CompactTaskHeader } from "./compact-task-header.js";

export type { PlanRenderTheme } from "./plan-presentation.js";

// The compact widget keeps stable ordinals so folded rows stay easy to scan.
function presentPlan(plan: PlanSnapshot): PlanPresentation {
  return {
    rows: plan.steps.map((item, index) => ({
      label: String(index + 1),
      title: item.step,
      status: item.status,
      ...(item.dependsOn?.length ? { details: [`after: ${item.dependsOn.join(", ")}`] } : {}),
    })),
  };
}

export function renderCompactPlan(plan: PlanSnapshot, width: number, theme: PlanRenderTheme, expanded = false, header?: CompactTaskHeader): string[] {
  return renderPlanPresentation(presentPlan(plan), width, theme, false, expanded, header);
}
