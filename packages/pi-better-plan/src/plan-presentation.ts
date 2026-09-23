import type { Component } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface PlanRenderTheme {
  fg(color: string, value: string): string;
}

export type DisplayStatus = "completed" | "in_progress" | "pending" | "blocked" | "failed" | "skipped" | "unknown";
export interface PlanRow {
  label: string;
  title: string;
  status: DisplayStatus;
  statusLabel?: string;
  details?: string[];
}
export interface PlanPresentation {
  rows: PlanRow[];
  metadata?: { text: string; color: string }[][];
}

export const plainPlanTheme: PlanRenderTheme = { fg: (_color, value) => value };

export function statusStyle(status: DisplayStatus): { glyph: string; color: string; label: string } {
  switch (status) {
    case "completed": return { glyph: "✓", color: "success", label: "" };
    case "in_progress": return { glyph: "●", color: "accent", label: "active" };
    case "blocked": return { glyph: "!", color: "warning", label: "blocked" };
    case "failed": return { glyph: "×", color: "error", label: "failed" };
    case "skipped": return { glyph: "—", color: "dim", label: "skipped" };
    case "unknown": return { glyph: "?", color: "warning", label: "unknown" };
    case "pending": return { glyph: "○", color: "dim", label: "" };
  }
}

// Keep each piece of external text on one terminal row before measuring it.
export function planText(value: string): string {
  return value.replace(/[\r\n\t]/g, " ");
}

export function renderPlanPresentation(
  plan: PlanPresentation, width: number, theme: PlanRenderTheme,
  full = false, selectedIndex = -1,
): string[] {
  const size = Math.max(1, Math.floor(width));
  const count = (status: DisplayStatus) => plan.rows.filter((row) => row.status === status).length;
  const summary = [`${count("completed")}/${plan.rows.length} complete`];
  for (const [status, label] of [
    ["in_progress", "in progress"], ["blocked", "blocked"], ["failed", "failed"],
    ["skipped", "skipped"], ["unknown", "unknown"],
  ] as const) {
    if (count(status)) summary.push(`${count(status)} ${label}`);
  }
  if (count("pending") && summary.length === 1) summary.push(`${count("pending")} pending`);
  const lines = [theme.fg("warning", "plan") + theme.fg("dim", `  ${summary.join(" · ")}`)];
  for (const metadata of plan.metadata ?? []) {
    const content = metadata.map((part) => theme.fg(part.color, planText(part.text))).join("");
    for (const line of wrapTextWithAnsi(content, Math.max(1, size - 2))) lines.push(`  ${line}`);
  }
  lines.push("");

  const labelWidth = Math.min(12, Math.max(4, ...plan.rows.map((row) => visibleWidth(planText(row.label)))));
  const statusWidth = Math.min(24, Math.max(0, ...plan.rows.map((row) =>
    visibleWidth(planText(row.statusLabel ?? statusStyle(row.status).label)))));
  for (const [index, row] of plan.rows.entries()) {
    const style = statusStyle(row.status);
    const label = truncateToWidth(planText(row.label), labelWidth);
    const prefix = (index === selectedIndex ? theme.fg("accent", "› ") : "  ") +
      theme.fg(style.color, style.glyph) + " " + theme.fg("dim", label) +
      " ".repeat(Math.max(0, labelWidth - visibleWidth(label)) + 2);
    const titleColor = row.status === "blocked" ? "warning" : row.status === "failed" ? "error" :
      row.status === "in_progress" ? "text" : "muted";
    const badge = planText(row.statusLabel ?? style.label);
    const available = size - visibleWidth(prefix);
    // At narrow widths use an inline status so it survives title truncation.
    if (badge && available < statusWidth + 14) {
      lines.push(prefix + theme.fg(style.color, `${badge} · `) + theme.fg(titleColor, planText(row.title)));
    } else {
      const titleWidth = Math.max(0, available - (statusWidth ? statusWidth + 2 : 0));
      const title = truncateToWidth(planText(row.title), titleWidth);
      lines.push(prefix + theme.fg(titleColor, title) + (badge
        ? " ".repeat(Math.max(0, titleWidth - visibleWidth(title)) + 2) + theme.fg(style.color, badge)
        : ""));
    }
    if (full) {
      for (const detail of row.details ?? []) {
        const indent = Math.min(visibleWidth(prefix), Math.max(0, size - 4));
        for (const line of wrapTextWithAnsi(planText(detail), Math.max(1, size - indent))) {
          lines.push(" ".repeat(indent) + theme.fg("dim", line));
        }
      }
    }
  }
  if (full) lines.push("", theme.fg("dim", "↑↓ navigate · esc / ← back"));
  return lines.map((line) => truncateToWidth(line, size));
}

export function createPlanPresentationComponent(
  plan: PlanPresentation, theme: PlanRenderTheme, onClose: () => void,
): Component {
  let selected = plan.rows.findIndex((row) => row.status === "in_progress");
  if (selected < 0) selected = plan.rows.findIndex((row) => row.status !== "completed");
  if (selected < 0) selected = Math.max(0, plan.rows.length - 1);
  return {
    render: (width) => renderPlanPresentation(plan, width, theme, true, selected),
    handleInput(data) {
      if (matchesKey(data, "up")) selected = Math.max(0, selected - 1);
      else if (matchesKey(data, "down")) selected = Math.min(Math.max(0, plan.rows.length - 1), selected + 1);
      else if (matchesKey(data, "escape") || matchesKey(data, "left") || matchesKey(data, "ctrl+c")) onClose();
    },
    invalidate() {},
  };
}
