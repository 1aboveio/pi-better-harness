import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { compactRowIndices, planText, type DisplayStatus, type PlanRenderTheme } from "./plan-presentation.js";
import { workflowDiagram, type DiagramPart, type WorkflowNode } from "./workflow-diagram.js";

export type WorkflowTheme = PlanRenderTheme & { underline?(text: string): string };

interface WorkflowTask {
  id?: string;
  status: DisplayStatus;
  label: DiagramPart[];
}

export interface WorkflowFrame {
  lines: string[];
  stepAt(x: number, y: number): string | undefined;
  resizeAt(x: number, y: number): ((nextX: number) => number) | undefined;
}

export function renderWorkflowFrame(
  tasks: WorkflowTask[], nodes: WorkflowNode[], heading: string[],
  width: number, theme: WorkflowTheme, expanded: boolean, leftShare = 0.5,
): WorkflowFrame {
  const size = Math.max(1, Math.floor(width));
  const split = size >= 36 && nodes.length > 0;
  const gutter = " │ ";
  const available = size - visibleWidth(gutter);
  const fitColumn = (cells: number) => Math.max(12, Math.min(available - 12, cells));
  // Round to the nearest terminal cell, giving a tied cell to the diagram.
  const listWidth = split ? fitColumn(Math.ceil(available * leftShare - 0.5)) : size;
  const graphWidth = split ? available - listWidth : size;
  const styled = (part: DiagramPart) => {
    const value = theme.fg(part.color, planText(part.text));
    return part.selected ? theme.underline?.(value) ?? theme.fg("accent", value) : value;
  };
  const graph = workflowDiagram(nodes, graphWidth).flatMap(line =>
    wrapTextWithAnsi(line.map(styled).join(""), graphWidth));

  const list: { line: string; id?: string }[] = [];
  const visible = expanded ? tasks.map((_, index) => index) : compactRowIndices(tasks);
  const omitted = (count: number) => list.push({ line: theme.fg("dim", "  … " + count + " more") });
  let previous = -1;
  for (const index of visible) {
    if (index > previous + 1) omitted(index - previous - 1);
    const task = tasks[index]!;
    const label = task.label.map(styled).join("");
    list.push({ line: label, id: task.id });
    previous = index;
  }
  if (previous < tasks.length - 1) omitted(tasks.length - previous - 1);

  const lines = [...heading];
  if (split) {
    const divider = theme.fg("dim", gutter);
    for (let i = 0; i < Math.max(list.length, graph.length); i++) {
      const left = truncateToWidth(list[i]?.line ?? "", listWidth);
      lines.push(left + " ".repeat(listWidth - visibleWidth(left)) + divider + (graph[i] ?? ""));
    }
  } else {
    lines.push(...list.map(row => row.line), ...graph);
  }
  const bodyEnd = lines.length;
  return {
    lines: lines.map(line => truncateToWidth(line, size)),
    resizeAt(x, y) {
      if (!split || y < heading.length || y >= bodyEnd || Math.abs(x - (listWidth + 1)) > 1) return;
      return nextX => fitColumn(listWidth + nextX - x) / available;
    },
    stepAt: (x, y) => x >= 0 && x < listWidth ? list[y - heading.length]?.id : undefined,
  };
}
