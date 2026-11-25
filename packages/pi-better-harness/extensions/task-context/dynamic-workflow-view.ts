import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { compactRowIndices, planText, type PlanRenderTheme } from "./plan-presentation.js";
import { renderCompactTaskHeader, type CompactTaskHeader } from "./compact-task-header.js";
import { phase, reviewState, type Step, type WorkflowRun } from "./dynamic-workflow.js";

const marker = { ready: "○", working: "●", waiting: "·", failed: "×", complete: "✓", standby: "–" } as const;
const status = { ready: "pending", working: "in_progress", waiting: "pending", failed: "failed", complete: "completed", standby: "skipped" } as const;

type Part = { text: string; color: string; selected?: boolean };
const colors = { ready: "accent", working: "accent", waiting: "muted", failed: "error", complete: "success", standby: "dim" } as const;
const wire = (text: string): Part => ({ text, color: "dim" });
type Node = { members: Step[]; label: Part; parents: string[]; revision?: string };

function diagramNodes(run: WorkflowRun, selected?: string): Node[] {
  const groups = new Map<string, Step[]>();
  const fixes = new Set(run.steps.map(s => s.review?.revision));
  for (const s of run.steps) {
    // Only coalesce parallel siblings. Different prerequisites within one
    // named stage must stay visible as distinct edges.
    const key = s.stage && !s.review && !fixes.has(s.id)
      ? JSON.stringify([s.stage, [...s.dependsOn ?? []].sort()]) : s.id;
    const members = groups.get(key) ?? [];
    members.push(s);
    groups.set(key, members);
  }
  return [...groups.values()].map(members => {
    const first = members[0]!;
    const states = members.map(s => phase(run, s));
    const state = (["failed", "working", "ready", "waiting", "complete", "standby"] as const)
      .find(candidate => states.includes(candidate))!;
    const name = planText(first.stage ?? first.title);
    const detail = members.length > 1 ? " [" + members.map((s, i) => s.id + " " + marker[states[i]!]).join(" ∥ ") + "]" : "";
    const label = { text: marker[state] + " " + name + detail, color: colors[state], selected: members.some(s => s.id === selected) };
    return { members, label, parents: first.dependsOn ?? [], revision: first.review?.revision };
  });
}

function diagram(nodes: Node[], width: number): Part[][] {
  const byId = new Map(nodes.flatMap(node => node.members.map(step => [step.id, node] as const)));
  const fixes = new Set(nodes.map(node => node.revision));
  const main = nodes.filter(node => !fixes.has(node.members[0]!.id));
  const path: Node[] = [];
  let next = main.filter(node => !node.parents.length);
  while (next.length === 1) {
    const current = next[0]!;
    path.push(current);
    next = main.filter(node => node.parents.length === current.members.length && node.parents.every(id => byId.get(id) === current));
  }
  if (path.length === main.length) {
    const top: Part[] = [];
    const loops: Part[][] = [];
    let x = 0;
    for (const [i, node] of path.entries()) {
      top.push(node.label);
      const size = visibleWidth(node.label.text);
      if (node.revision) {
        const fix = byId.get(node.revision)!.label;
        const fixSize = visibleWidth(fix.text);
        const span = Math.max(size + 2, fixSize + 6);
        const indent = " ".repeat(x);
        top.push(wire(" " + "─".repeat(span - size - 1) + "┬"));
        loops.push([wire(indent + "↑" + " ".repeat(span - 1) + "│")],
          [wire(indent + "└─ "), fix, wire(" ←" + "─".repeat(span - fixSize - 5) + "┘")]);
        x += span + 1;
      } else x += size;
      if (i < path.length - 1) { top.push(wire(" ─→ ")); x += 4; }
    }
    if (x <= width) return [top, ...loops];
    // Preserve edge direction without wrapping connectors away from their nodes.
    return path.flatMap((node, i) => {
      const lines = [[wire(i ? "↓ " : ""), node.label]];
      if (node.revision) lines.push([wire("  ↳ "), byId.get(node.revision)!.label], [wire("  ↺ " + (node.members[0]!.stage ?? node.members[0]!.title))]);
      return lines;
    });
  }
  return nodes.map(node => {
    const parents = node.parents.map(id => {
      const parent = byId.get(id)!;
      return parent.members.length > 1 ? id : parent.members[0]!.stage ?? parent.members[0]!.title;
    });
    return [wire(parents.length ? parents.join(" + ") + " → " : ""), node.label,
      ...(node.revision ? [wire(" ↔ "), byId.get(node.revision)!.label] : [])];
  });
}

type WorkflowTheme = PlanRenderTheme & { underline?(text: string): string };

export interface DynamicFrame {
  lines: string[];
  stepAt(x: number, y: number): string | undefined;
}

export function renderDynamicFrame(run: WorkflowRun, width: number, theme: WorkflowTheme, expanded: boolean, header: CompactTaskHeader, selected?: string): DynamicFrame {
  const size = Math.max(1, Math.floor(width));
  const rows = run.steps.map(step => {
    const state = phase(run, step);
    return { step, state, status: status[state] };
  });
  const completed = rows.filter(row => row.state === "complete").length;
  const total = rows.filter(row => row.state !== "standby").length;
  const lines = renderCompactTaskHeader(completed + "/" + total, size, theme, {
    ...header, subtitle: run.objective, runtime: header.runtime ?? { status: run.evidence ? "complete" : "active" },
  });

  // Leave room for both a task title and a dependency edge. Tiny terminals use the full line for each.
  const split = size >= 36;
  const listWidth = split ? Math.min(38, Math.floor(size / 3)) : size;
  const gutter = theme.fg("dim", " │ ");
  const graphWidth = split ? size - listWidth - 3 : size;
  const highlight = (text: string) => theme.underline?.(text) ?? theme.fg("accent", text);
  const graph = diagram(diagramNodes(run, selected), graphWidth).flatMap(parts => {
    const text = parts.map(p => {
      const styled = theme.fg(p.color, planText(p.text));
      return p.selected ? highlight(styled) : styled;
    }).join("");
    return wrapTextWithAnsi(text, graphWidth);
  });

  const visible = expanded ? rows.map((_, i) => i) : compactRowIndices(rows);
  const tasks: { line: string; id?: string }[] = [];
  let previous = -1;
  const omitted = (count: number) => tasks.push({ line: theme.fg("dim", "  … " + count + " more") });
  for (const i of visible) {
    if (i > previous + 1) omitted(i - previous - 1);
    const { step, state } = rows[i]!;
    const title = theme.fg("text", planText(step.title));
    const line = theme.fg(colors[state], marker[state]) + " " + (step.id === selected ? highlight(title) : title);
    tasks.push({ id: step.id, line: truncateToWidth(line, listWidth) });
    previous = i;
  }
  if (previous < rows.length - 1) omitted(rows.length - previous - 1);

  const firstRow = lines.length;
  if (split) {
    for (let i = 0; i < Math.max(tasks.length, graph.length); i++) {
      const left = tasks[i]?.line ?? "";
      lines.push(left + " ".repeat(Math.max(0, listWidth - visibleWidth(left))) + gutter + (graph[i] ?? ""));
    }
  } else {
    lines.push(...tasks.map(t => t.line), ...graph);
  }
  const step = run.steps.find(s => s.id === selected);
  if (step) {
    const entry = run.history.filter(h => h.step === step.id).at(-1);
    const result = entry?.result ?? "Required: " + step.output;
    const caption = [step.id, step.catalog, result].filter(Boolean).join(" · ");
    lines.push(theme.fg("muted", planText(caption)));
  }
  return {
    lines: lines.map(line => truncateToWidth(line, size)),
    stepAt: (x, y) => x >= 0 && x < listWidth ? tasks[y - firstRow]?.id : undefined,
  };
}

export function renderDynamic(run: WorkflowRun, width: number, theme: WorkflowTheme, expanded: boolean, header: CompactTaskHeader) {
  return renderDynamicFrame(run, width, theme, expanded, header).lines;
}

export function describeRun(run: WorkflowRun): string {
  const lines = [run.objective, `runId ${run.id} · revision ${run.revision} · ${run.evidence ? "finished" : "active"}`,
    ...run.criteria.map(c => "Acceptance: " + c)];
  for (const s of run.steps) {
    lines.push(`${s.id} [${phase(run, s)}] ${s.title}${s.stage ? " · " + s.stage : ""}${s.dependsOn?.length ? " ← " + s.dependsOn.join(" + ") : ""}. Required output: ${s.output}`);
    if (s.review) lines.push(`  Review ${s.review.artifact} v${reviewState(run, s).version}; changes_requested → ${s.review.revision} → ${s.id}.`);
    const choice = run.catalogChoices.find(c => c.id === s.catalog);
    const worker = Object.hasOwn(run.workers, s.id) ? run.workers[s.id] : undefined;
    if (choice) {
      lines.push(`  ${choice.id} · skills: ${choice.skills?.join(", ") || (choice.skills ? "none" : "discovery")}. subagent_spawn workflow: ${JSON.stringify({ runId: run.id, step: s.id })}`);
      if (choice.error) lines.push("  " + choice.error);
      if (worker) lines.push("  Assignment: " + (worker.error ?? worker.result ?? worker.runId ?? worker.callId));
    }
  }
  for (const h of run.history) lines.push(`Recorded ${h.step}${h.version ? " v" + h.version : ""}${h.verdict ? " " + h.verdict : ""}${h.worker?.runId ? " (" + h.worker.runId + ")" : ""}: ${h.result}`);
  for (const item of run.evidence ?? []) lines.push(item.criterion + ": " + item.result);
  return lines.join("\n");
}
