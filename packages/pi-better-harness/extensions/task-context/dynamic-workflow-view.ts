import { truncateToWidth } from "@earendil-works/pi-tui";
import { planText, type PlanRenderTheme } from "./plan-presentation.js";
import { renderCompactTaskHeader, type CompactTaskHeader } from "./compact-task-header.js";
import { phase, reviewState, type Step, type WorkflowRun } from "./dynamic-workflow.js";
import { diagramCounts, type WorkflowNode } from "./workflow-diagram.js";
import { renderWorkflowFrame, type WorkflowFrame, type WorkflowTheme } from "./workflow-view.js";

const marker = { ready: "○", working: "●", waiting: "·", failed: "×", complete: "✓", standby: "–" } as const;
const status = { ready: "pending", working: "in_progress", waiting: "pending", failed: "failed", complete: "completed", standby: "skipped" } as const;
const colors = { ready: "accent", working: "accent", waiting: "muted", failed: "error", complete: "success", standby: "dim" } as const;

function diagramNodes(run: WorkflowRun, selected?: string): WorkflowNode[] {
  const sequential = run.steps.every((step, index) => {
    if (step.review) return false;
    const parents = step.dependsOn ?? [];
    if (index === 0) return parents.length === 0;
    return parents.length === 1 && parents[0] === run.steps[index - 1]!.id;
  });
  if (sequential) return [];

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
    const order = ["failed", "working", "ready", "waiting", "complete", "standby"] as const;
    const title = planText(first.title);
    const fallback = title.trim().split(/\s+/u).length <= 2 ? title : first.id;
    const name = planText(members.length > 1 ? first.stage! : first.diagramLabel ?? first.stage ?? fallback);
    const selectedGroup = members.some(s => s.id === selected);
    const state = states[0]!;
    const label = members.length === 1
      ? [{ text: marker[state] + " " + name, color: colors[state], selected: selectedGroup }]
      : [{ text: name, color: "text", selected: selectedGroup }, ...diagramCounts(order.map(key => ({
          glyph: marker[key], color: colors[key], count: states.filter(value => value === key).length,
        })))];
    return { ids: members.map(s => s.id), name, label, parents: first.dependsOn ?? [], revision: first.review?.revision };

  });
}

export function renderDynamicFrame(run: WorkflowRun, width: number, theme: WorkflowTheme, expanded: boolean, header: CompactTaskHeader, selected?: string, leftShare = 0.5): WorkflowFrame {
  const size = Math.max(1, Math.floor(width));
  const rows = run.steps.map(step => {
    const state = phase(run, step);
    return {
      id: step.id, state, status: status[state],
      label: [
        { color: colors[state], text: marker[state] + " " },
        { color: "text", text: planText(step.title), selected: step.id === selected },
      ],
    };
  });
  const completed = rows.filter(row => row.state === "complete").length;
  const total = rows.filter(row => row.state !== "standby").length;
  const heading = renderCompactTaskHeader(completed + "/" + total, size, theme, {
    ...header, subtitle: run.objective, runtime: header.runtime ?? { subject: "workflow", status: run.evidence ? "complete" : "active" },
  });

  const frame = renderWorkflowFrame(rows, diagramNodes(run, selected), heading, size, theme, expanded, leftShare);
  const step = run.steps.find(s => s.id === selected);
  if (step) {
    const entry = run.history.filter(h => h.step === step.id).at(-1);
    const result = entry?.result ?? "Required: " + step.output;
    const caption = [step.id, step.catalog, result].filter(Boolean).join(" · ");
    frame.lines.push(truncateToWidth(theme.fg("muted", planText(caption)), size));
  }
  return frame;
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
