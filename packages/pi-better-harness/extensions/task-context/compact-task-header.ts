import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { PlanRenderTheme } from "./plan-presentation.js";

export interface CompactTaskHeader {
  subtitle?: string;
  disclosure?: string;
  onStartButton?: (row: number, left: number, right: number) => void;
  runtime?: { status: string; clock?: string; subject?: "workflow" };
  /** Preformatted high-level ledger counts shown in the existing Todo surface. */
  ledger?: string;
}

function runtimeLabel(runtime: NonNullable<CompactTaskHeader["runtime"]>): string {
  return `${runtime.subject ?? "goal"} ${runtime.status}`;
}

export function canRenderTaskRuntime(width: number, runtime: CompactTaskHeader["runtime"]): boolean {
  if (!runtime || !Number.isFinite(width)) return false;
  return visibleWidth(runtimeLabel(runtime) + (runtime.clock ? `  ${runtime.clock}` : "")) + 6 <= Math.floor(width);
}

export function renderCompactTaskHeader(summary: string | undefined, width: number, theme: PlanRenderTheme, header: CompactTaskHeader, inProgress = false): string[] {
  const size = Math.max(1, Math.floor(width));
  let left = theme.fg("warning", "todo") + (header.disclosure ? theme.fg("accent", ` ${header.disclosure}`) : "") +
    (summary ? theme.fg("dim", `  ${summary}`) : "");
  const runtime = header.runtime;
  const tone = runtime?.status === "complete" ? "success" : runtime?.status === "active" ? "accent" : "warning";
  const right = runtime ? theme.fg(tone, runtimeLabel(runtime)) + (runtime.clock ? theme.fg("dim", `  ${runtime.clock}`) : "") : "";
  const rightWidth = visibleWidth(right);
  const showRuntime = right && canRenderTaskRuntime(size, runtime);
  const leftWidth = showRuntime ? Math.max(4, size - rightWidth - 2) : size;
  const progressMark = " · ●";
  if (inProgress && visibleWidth(left) + visibleWidth(progressMark) <= leftWidth) {
    left += theme.fg("accent", progressMark);
  }
  const title = truncateToWidth(left, leftWidth);
  const heading = showRuntime
    ? title + " ".repeat(Math.max(2, size - visibleWidth(title) - rightWidth)) + right
    : title;
  const lines = [truncateToWidth(heading, size)];
  const indent = Math.min(2, size - 1);
  const details: string[] = [];
  if (header.subtitle) {
    const text = header.subtitle.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
    details.push(" ".repeat(indent) + theme.fg("muted", truncateToWidth(text, size - indent)));
  }
  if (header.ledger) {
    const text = header.ledger.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
    details.push(" ".repeat(indent) + theme.fg("dim", truncateToWidth(text, size - indent)));
  }
  if (details.length > 0) {
    lines.push(...details);
    const fullLabel = "[Start Goal · Alt+G]";
    const label = indent + fullLabel.length <= size ? fullLabel : "[Start]";
    if (header.onStartButton && size >= indent + label.length) {
      header.onStartButton(lines.length, indent, indent + label.length);
      lines.push(" ".repeat(indent) + theme.fg("accent", label));
    } else {
      lines.push("");
    }
  }
  return lines;
}
