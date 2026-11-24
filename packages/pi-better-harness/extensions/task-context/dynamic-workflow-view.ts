import { visibleWidth } from "@earendil-works/pi-tui";
import { renderPlanPresentation, type PlanRenderTheme, type PlanRow } from "./plan-presentation.js";
import type { CompactTaskHeader } from "./compact-task-header.js";
import { phase, reviewState, type Step, type WorkflowRun } from "./dynamic-workflow.js";

const marker = { ready: "○", working: "●", waiting: "·", failed: "×", complete: "✓", standby: "–" } as const;
const status = { ready: "pending", working: "in_progress", waiting: "pending", failed: "failed", complete: "completed", standby: "skipped" } as const;

type Part = { text: string; color: string };
const wire = (text: string): Part => ({ text, color: "dim" });
type Node = { members: Step[]; label: Part; parents: string[]; revision?: string };

function diagramNodes(run: WorkflowRun): Node[] {
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
    const name = first.stage ?? first.title;
    const detail = members.length > 1 ? " [" + members.map((s, i) => s.id + " " + marker[states[i]!]).join(" ∥ ") + "]" : "";
    const text = name + detail + " " + (state === "complete" ? "✓" : state);
    const color = state === "complete" ? "success" : state === "failed" ? "error" : state === "ready" || state === "working" ? "accent" : "muted";
    return { members, label: { text, color }, parents: first.dependsOn ?? [], revision: first.review?.revision };
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

export function renderDynamic(run: WorkflowRun, width: number, theme: PlanRenderTheme, expanded: boolean, header: CompactTaskHeader) {
  const metadata = diagram(diagramNodes(run), Math.max(1, width - 2));
  const rows: PlanRow[] = run.steps.map(step => {
    const state = phase(run, step);
    return { label: step.id, title: step.title, status: status[state], statusLabel: state, cancelled: state === "standby" };
  });
  return renderPlanPresentation({ metadata, rows, foldAllRows: true }, width, theme, false, expanded,
    { ...header, subtitle: run.objective, runtime: header.runtime ?? { status: run.evidence ? "complete" : "active" } });
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
