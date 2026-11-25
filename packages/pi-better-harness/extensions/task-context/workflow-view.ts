import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { compactRowIndices, planText, type DisplayStatus, type PlanRenderTheme } from "./plan-presentation.js";
import { workflowDiagram, type DiagramPart, type WorkflowNode } from "./workflow-diagram.js";

export type WorkflowTheme = PlanRenderTheme & { underline?(text: string): string };

interface WorkflowTask {
  id?: string;
  status: DisplayStatus;
  label: DiagramPart[];
  badge?: DiagramPart;
}

export interface WorkflowFrame {
  lines: string[];
  stepAt(x: number, y: number): string | undefined;
}

export function renderWorkflowFrame(
  tasks: WorkflowTask[], nodes: WorkflowNode[], heading: string[],
  width: number, theme: WorkflowTheme, expanded: boolean,
): WorkflowFrame {
  const size = Math.max(1, Math.floor(width));
  const split = size >= 36 && nodes.length > 0;
  const listWidth = split ? Math.min(38, Math.floor(size / 3)) : size;
  const graphWidth = split ? size - listWidth - 3 : size;
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
    const badge = task.badge?.text ? styled(task.badge) : "";
    if (badge && visibleWidth(label) + 2 + visibleWidth(badge) <= listWidth) {
      list.push({ line: label + "  " + badge, id: task.id });
    } else {
      list.push({ line: truncateToWidth(label, listWidth), id: task.id });
      if (badge) {
        const indent = " ".repeat(Math.min(2, listWidth - 1));
        const available = listWidth - indent.length;
        // Keep short statuses readable at the split threshold. External status text can be arbitrarily long.
        const wrapped = visibleWidth(badge) <= available * 2 ? wrapTextWithAnsi(badge, available) : [];
        const badgeLines = wrapped.length > 0 && wrapped.length <= 2 ? wrapped : [truncateToWidth(badge, available)];
        for (const line of badgeLines) list.push({ line: indent + line, id: task.id });
      }
    }
    previous = index;
  }
  if (previous < tasks.length - 1) omitted(tasks.length - previous - 1);

  const lines = [...heading];
  if (split) {
    const gutter = theme.fg("dim", " │ ");
    for (let i = 0; i < Math.max(list.length, graph.length); i++) {
      const left = truncateToWidth(list[i]?.line ?? "", listWidth);
      lines.push(left + " ".repeat(listWidth - visibleWidth(left)) + gutter + (graph[i] ?? ""));
    }
  } else {
    lines.push(...list.map(row => row.line), ...graph);
  }
  return {
    lines: lines.map(line => truncateToWidth(line, size)),
    stepAt: (x, y) => x >= 0 && x < listWidth ? list[y - heading.length]?.id : undefined,
  };
}
