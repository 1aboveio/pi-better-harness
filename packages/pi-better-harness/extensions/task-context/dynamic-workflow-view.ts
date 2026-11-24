import { renderPlanPresentation, type PlanRenderTheme, type PlanRow } from "./plan-presentation.js";
import type { CompactTaskHeader } from "./compact-task-header.js";
import { phase, reviewState, type Step, type WorkflowRun } from "./dynamic-workflow.js";

const marker = { ready: "○", working: "●", waiting: "·", failed: "×", complete: "✓", standby: "–" } as const;
const status = { ready: "pending", working: "in_progress", waiting: "pending", failed: "failed", complete: "completed", standby: "skipped" } as const;

export function renderDynamic(run: WorkflowRun, width: number, theme: PlanRenderTheme, expanded: boolean, header: CompactTaskHeader) {
  const groups = new Map<string, Step[]>();
  const group = (s: Step) => s.stage ? "stage:" + s.stage : "step:" + s.id;
  const label = (s: Step) => s.stage ?? s.title;
  for (const s of run.steps) {
    const members = groups.get(group(s)) ?? [];
    members.push(s);
    groups.set(group(s), members);
  }
  const byId = new Map(run.steps.map(s => [s.id, s]));
  const metadata = [...groups.values()].map(members => {
    const incoming = new Set<string>();
    const conditional = new Set<string>();
    const current = members.map(s => phase(run, s));
    for (const s of members) {
      for (const id of s.dependsOn ?? []) {
        const dep = byId.get(id)!;
        const siblings = groups.get(group(dep))!;
        if (group(dep) !== group(s)) incoming.add(siblings.length === 1 ? label(dep) : `${dep.id} ${marker[phase(run, dep)]}`);
        else incoming.add(dep.id + " → " + s.id);
      }
      if (s.review) conditional.add("↔ " + label(byId.get(s.review.revision)!));
    }
    const active = current.includes("failed") ? "failed" : current.includes("working") ? "working" : current.includes("ready") ? "ready"
      : current.every(p => p === "complete") ? "complete" : current.every(p => p === "standby") ? "standby" : "waiting";
    return [
      { text: incoming.size ? [...incoming].join(" + ") + " → " : "", color: "dim" },
      { text: label(members[0]!) + (members.length > 1 ? " [" + members.map(s => s.id + " " + marker[phase(run, s)]).join(", ") + "]" : ""), color: active === "complete" ? "success" : active === "failed" ? "error" : active === "ready" || active === "working" ? "accent" : "muted" },
      { text: (conditional.size ? " " + [...conditional].join(" ") : "") + " · " + active +
        (members.length > 1 ? ` (${current.filter(p => p === "complete").length}/${members.length})` : ""), color: "dim" },
    ];
  });
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
