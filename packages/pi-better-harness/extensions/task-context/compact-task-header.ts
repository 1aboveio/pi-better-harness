import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { PlanRenderTheme } from "./plan-presentation.js";

export interface CompactTaskHeader {
  subtitle?: string;
  disclosure?: string;
  runtime?: { status: string; clock?: string };
}

export function canRenderTaskRuntime(width: number, runtime: CompactTaskHeader["runtime"]): boolean {
  if (!runtime || !Number.isFinite(width)) return false;
  return visibleWidth(runtime.status + (runtime.clock ? `  ${runtime.clock}` : "")) + 6 <= Math.floor(width);
}

export function renderCompactTaskHeader(summary: string | undefined, width: number, theme: PlanRenderTheme, header: CompactTaskHeader): string[] {
  const size = Math.max(1, Math.floor(width));
  const left = theme.fg("warning", "todo") + (header.disclosure ? theme.fg("accent", ` ${header.disclosure}`) : "") +
    (summary ? theme.fg("dim", `  ${summary}`) : "");
  const runtime = header.runtime;
  const tone = runtime?.status === "complete" ? "success" : runtime?.status === "active" ? "accent" : "warning";
  const right = runtime ? theme.fg(tone, runtime.status) + (runtime.clock ? theme.fg("dim", `  ${runtime.clock}`) : "") : "";
  const rightWidth = visibleWidth(right);
  const leftWidth = Math.max(4, size - rightWidth - 2);
  const title = truncateToWidth(left, leftWidth);
  const heading = right && canRenderTaskRuntime(size, runtime)
    ? title + " ".repeat(Math.max(2, size - visibleWidth(title) - rightWidth)) + right
    : truncateToWidth(left, size);
  const lines = [truncateToWidth(heading, size)];
  if (header.subtitle) {
    const indent = Math.min(2, size - 1);
    const text = header.subtitle.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
    lines.push(" ".repeat(indent) + theme.fg("muted", truncateToWidth(text, size - indent)), "");
  }
  return lines;
}