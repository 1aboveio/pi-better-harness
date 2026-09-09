import type { Component } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import { planProgress } from "./plan-state.js";
import type { PlanSnapshot, PlanStep } from "./types.js";

export interface PlanRenderTheme {
  fg(color: string, value: string): string;
}

export function renderCompactPlan(
  plan: PlanSnapshot,
  width: number,
  theme: PlanRenderTheme,
  options: { focused?: boolean; selectedIndex?: number } = {},
): string[] {
  const progress = planProgress(plan);
  const selected = clampIndex(options.selectedIndex ?? progress.activeIndex ?? firstIncompleteIndex(plan), plan.steps.length);
  const indices = contextIndices(plan.steps.length, selected);
  const stateLabel = progress.blocked > 0
    ? `${progress.blocked} blocked`
    : progress.state === "complete"
      ? "complete"
      : progress.state.replace("_", " ");
  const lines = [
    theme.fg(progress.blocked > 0 ? "warning" : "accent", `plan ${progress.completed}/${progress.total} steps`) +
      theme.fg("dim", ` · ${stateLabel}`),
  ];

  for (const index of indices) {
    const item = plan.steps[index]!;
    const selectedPrefix = options.focused && index === selected ? theme.fg("accent", "› ") : "  ";
    lines.push(`${selectedPrefix}${stepGlyph(item, theme)} ${index + 1}  ${stepText(item, theme)}`);
  }
  lines.push("");
  return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
}

export function renderFullPlan(plan: PlanSnapshot, width: number, theme: PlanRenderTheme, selectedIndex = -1): string[] {
  const progress = planProgress(plan);
  const heading = `Practical Plan · ${progress.completed}/${progress.total} completed`;
  const lines = [theme.fg("accent", rule(heading, width)), ""];
  for (let index = 0; index < plan.steps.length; index += 1) {
    const item = plan.steps[index]!;
    const prefix = index === selectedIndex ? theme.fg("accent", "› ") : "  ";
    lines.push(`${prefix}${stepGlyph(item, theme)}  ${String(index + 1).padStart(2, " ")}  ${stepText(item, theme)}`);
  }
  lines.push("", theme.fg("dim", rule("", width)));
  return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
}

export function createFullPlanComponent(
  plan: PlanSnapshot,
  theme: PlanRenderTheme,
  onClose: () => void,
): Component {
  let selected = planProgress(plan).activeIndex ?? firstIncompleteIndex(plan);
  return {
    render: (width) => renderFullPlan(plan, width, theme, selected),
    handleInput(data) {
      if (matchesKey(data, "up")) selected = clampIndex(selected - 1, plan.steps.length);
      else if (matchesKey(data, "down")) selected = clampIndex(selected + 1, plan.steps.length);
      else if (matchesKey(data, "escape") || matchesKey(data, "left") || matchesKey(data, "ctrl+c")) onClose();
    },
    invalidate() {},
  };
}

function contextIndices(total: number, selected: number): number[] {
  if (total <= 3) return Array.from({ length: total }, (_, index) => index);
  const start = Math.min(Math.max(0, selected - 1), total - 3);
  return [start, start + 1, start + 2];
}

function firstIncompleteIndex(plan: PlanSnapshot): number {
  const index = plan.steps.findIndex((item) => item.status !== "completed");
  return index >= 0 ? index : Math.max(0, plan.steps.length - 1);
}

function clampIndex(index: number, total: number): number {
  return Math.min(Math.max(0, index), Math.max(0, total - 1));
}

function stepGlyph(item: PlanStep, theme: PlanRenderTheme): string {
  switch (item.status) {
    case "completed": return theme.fg("success", "✓");
    case "in_progress": return theme.fg("accent", "●");
    case "blocked": return theme.fg("warning", "!");
    case "pending": return theme.fg("dim", "○");
  }
}

function stepText(item: PlanStep, theme: PlanRenderTheme): string {
  if (item.status === "completed" || item.status === "pending") return theme.fg("muted", item.step);
  if (item.status === "blocked") return theme.fg("warning", `BLOCKED · ${item.step}`);
  return item.step;
}

function rule(label: string, width: number): string {
  const size = Math.max(1, Math.floor(width));
  if (!label) return "━".repeat(size);
  const prefix = `━━ ${label} `;
  return prefix + "━".repeat(Math.max(0, size - prefix.length));
}