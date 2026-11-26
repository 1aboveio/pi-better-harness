import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { renderWorkflowFrame } from "./workflow-view.js";
import type { CompactTaskHeader } from "./compact-task-header.js";
import { diagramCounts, workflowDiagram, type DiagramPart, type WorkflowNode } from "./workflow-diagram.js";
import {
  alignedPlanLabels, plainPlanTheme, planRowTitleColor, planText, renderPlanHeading, renderPlanPresentation, statusStyle,
  type DisplayStatus, type PlanRenderTheme, type PlanPresentation,
} from "./plan-presentation.js";

export const WORKFLOW_PLAN_ENTRY = "pi-better-workflow-plan";
export const CANCELLED_ROW_RETENTION_MS = 30_000;

interface RushUnit {
  id: string;
  title: string;
  stage: string;
  status: string;
  cancelledAt?: number;
  dependsOn: string[];
  worker?: string | number | undefined;
  workerKind?: string | undefined;
  note?: string | undefined;
  headSha?: string | undefined;
  reviewedHead?: string | undefined;
  recordedFixStatus?: "pending" | "completed" | undefined;
  openFindings?: number;
  delivery?: string | undefined;
  canaryStatus?: DisplayStatus | null | undefined;
}

export interface RushPlan {
  runId: string;
  planRevision: number;
  issues: RushUnit[];
  fleet: Record<string, { status: string }>;
  warehouseCanaryRequired: boolean;
  spec?: { title?: string } | undefined;
}

export interface WorkflowPlanBinding {
  owner: string;
  path: string;
  runId: string;
}

export interface RushPlanFile {
  /** Real path of task-plan.json. */
  file: string;
  /** Run directory name, which is also the run id. */
  runId: string;
}

/** Resolve a Rush task-plan.json path, refusing anything outside `<cwd>/.resolve-issues/rush/<run-id>/`. */
export function resolveRushPlanFile(path: string, cwd: string): RushPlanFile {
  if (!isAbsolute(path) || basename(path) !== "task-plan.json") throw new Error("Expected an absolute Rush task-plan.json path.");
  const root = realpathSync(resolve(cwd, ".resolve-issues", "rush"));
  const file = realpathSync(path);
  const dir = relative(root, dirname(file));
  if (!dir || dir.startsWith(".." + sep) || dir === ".." || dir.includes(sep)) {
    throw new Error("Rush plan must be inside this project's .resolve-issues/rush/<run-id> directory.");
  }
  if (statSync(file).size > MAX_RUSH_PLAN_BYTES) throw new Error("Rush plan exceeds the 2 MB display limit.");
  return { file, runId: dir };
}

export const MAX_RUSH_PLAN_BYTES = 2_000_000;

export function readRushPlan(path: string, cwd: string): RushPlan {
  const { file, runId } = resolveRushPlanFile(path, cwd);
  return projectRushPlan(JSON.parse(readFileSync(file, "utf8")), runId, dirname(file));
}

/** Validate a parsed task-plan.json document and project the fields the plan view shows. */
export function projectRushPlan(data: unknown, runId: string, expectedRunDir?: string): RushPlan {
  if (!isRecord(data) || !Number.isSafeInteger(data.planRevision) ||
      (data.planRevision as number) < 0) {
    throw new Error("Invalid Rush plan identity or revision.");
  }
  // Current preflight plans carry runDir instead of duplicating its basename
  // in runId. The caller has already confined the file to the run directory.
  const validIdentity = data.runId === undefined
    ? typeof data.runDir === "string" && isAbsolute(data.runDir) && basename(data.runDir) === runId
    : data.runId === runId;
  if (!validIdentity) throw new Error("Invalid Rush plan identity or revision.");
  if (expectedRunDir !== undefined && data.runDir !== undefined) {
    let matches = false;
    try {
      matches = typeof data.runDir === "string" && isAbsolute(data.runDir)
        && realpathSync(data.runDir) === realpathSync(expectedRunDir);
    } catch { /* An unavailable run directory cannot establish identity. */ }
    if (!matches) throw new Error("Invalid Rush plan identity or revision: runDir does not match the plan directory.");
  }
  const persistedFleet = data.fleet === undefined ? {} : data.fleet;
  if (!isRecord(persistedFleet)) throw new Error("Invalid Rush fleet stages.");
  const persistedUnits = Array.isArray(data.issues) ? data.issues : data.units;
  if (!Array.isArray(persistedUnits)) throw new Error("Invalid Rush plan units.");
  const issues = persistedUnits.map((unit: unknown) => {
    if (!isRecord(unit) || typeof unit.id !== "string" || typeof unit.title !== "string" ||
        typeof unit.stage !== "string" || typeof unit.status !== "string") {
      throw new Error("Invalid Rush plan unit.");
    }
    return {
      id: unit.id, title: unit.title, stage: unit.stage, status: unit.status,
      dependsOn: Array.isArray(unit.dependsOn) ? unit.dependsOn.filter((id): id is string => typeof id === "string") : [],
      worker: (typeof unit.worker === "string" && unit.worker !== "") || typeof unit.worker === "number" ? unit.worker : undefined,
      workerKind: typeof unit.workerKind === "string" ? unit.workerKind : undefined,
      note: typeof unit.note === "string" ? unit.note : undefined,
      headSha: typeof unit.headSha === "string" && unit.headSha ? unit.headSha : undefined,
      reviewedHead: typeof unit.reviewedHead === "string" && unit.reviewedHead ? unit.reviewedHead : undefined,
      ...reviewFixEvidence(unit),
      delivery: typeof unit.delivery === "string" && unit.delivery ? unit.delivery : undefined,
      canaryStatus: readCanaryStatus(unit.warehouseCanary),
    };
  });
  const fleet: RushPlan["fleet"] = {};
  for (const [stage, value] of Object.entries(persistedFleet)) {
    const status = typeof value === "string" ? value : isRecord(value) ? value.status : undefined;
    if (typeof status !== "string") throw new Error("Invalid Rush fleet stage.");
    fleet[stage] = { status };
  }
  return {
    runId,
    planRevision: data.planRevision as number,
    issues,
    fleet,
    // The skill marks canary work per unit (`warehouseCanary`); older plans set a run-level flag.
    warehouseCanaryRequired: data.warehouseCanaryRequired === true ||
      issues.some((unit) => unit.canaryStatus !== undefined),
    spec: isRecord(data.spec) && typeof data.spec.title === "string" ? { title: data.spec.title } : undefined,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function workflowBinding(entries: Iterable<{ type: string; customType?: string; data?: unknown }>): WorkflowPlanBinding | null {
  let binding: WorkflowPlanBinding | null = null;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === "pi-better-workflow") {
      const data = entry.data;
      if (isRecord(data) && data.version === 1 && data.kind === "set") {
        if (data.resumePlan !== true || !isRecord(data.owner) || binding?.owner !== data.owner.name) binding = null;
      }
    }
    if (entry.type !== "custom" || entry.customType !== WORKFLOW_PLAN_ENTRY) continue;
    const data = entry.data;
    if (!isRecord(data) || data.version !== 1) continue;
    if (data.kind === "clear") binding = null;
    else if (data.kind === "set" && typeof data.owner === "string" && data.owner.length > 0 &&
             typeof data.path === "string" && typeof data.runId === "string") {
      binding = { owner: data.owner, path: data.path, runId: data.runId };
    }
  }
  return binding;
}

function workflowStatus(status: string): DisplayStatus {
  switch (status) {
    case "succeeded": case "completed": return "completed";
    case "in-flight": case "in_progress": case "running": case "diagnosing": return "in_progress";
    case "pending": return "pending";
    case "blocked": return "blocked";
    case "failed": return "failed";
    case "skipped": case "not-applicable": case "cancelled": case "canceled": return "skipped";
    default: return "unknown";
  }
}

// null marks applicable work with no unit-level execution result.
function readCanaryStatus(value: unknown): DisplayStatus | null | undefined {
  if (value == null || value === false) return undefined;
  if (!isRecord(value)) return null;
  if (value.required === false || value.applicable === false || value.status === "not-applicable") return undefined;

  const resultStatus = isRecord(value.result) ? value.result.status : value.result;
  const status = value.status ?? resultStatus;
  if (status === "pass" || status === "passed") return "completed";
  if (status === "fail") return "failed";
  return typeof status === "string" ? workflowStatus(status) : null;
}

// A unit is delivered (completed) only at `status: succeeded`, whether its change landed by a
// merged PR or a direct push. Between code done and delivery, a unit with a HEAD shows
// whether that HEAD passed review; without one it shows plain in-progress, as before.
function unitStatus(unit: RushUnit): DisplayStatus {
  const status = workflowStatus(unit.status);
  if (unit.worker !== undefined && (unit.workerKind === "fix" || unit.workerKind === "review")) return status;
  if (status !== "in_progress" || unit.stage !== "done" || !unit.headSha) return status;
  return unit.reviewedHead === unit.headSha ? "reviewed" : "implemented";
}

function reviewFixEvidence(unit: Record<string, unknown>): Pick<RushUnit, "recordedFixStatus" | "openFindings"> {
  const findings = Array.isArray(unit.reviewFindings) ? unit.reviewFindings.filter(isRecord) : [];
  const openFindings = findings.filter(finding => finding.status === "open").length;
  if (openFindings) return { recordedFixStatus: "pending", openFindings };
  if (findings.some(finding => finding.status === "resolved")) return { recordedFixStatus: "completed" };
  // The first review starts at fixRound 1, even when it passes without a fix.
  const passed = typeof unit.headSha === "string" && !!unit.headSha && unit.headSha === unit.reviewedHead;
  if (typeof unit.fixRound === "number" && unit.fixRound > 1 && (passed || unit.status === "succeeded" || unit.status === "completed")) {
    return { recordedFixStatus: "completed" };
  }
  return {};
}

type IssueStages = Record<"implement" | "review" | "fix" | "ship", DisplayStatus>;

function unitStages(unit: RushUnit, fleet: RushPlan["fleet"]): IssueStages {
  const status = workflowStatus(unit.status);
  const recordedFix = unit.recordedFixStatus ?? "skipped";
  const reviewed = !!unit.headSha && unit.headSha === unit.reviewedHead;
  if (status === "completed") {
    return { implement: status, review: reviewed ? "completed" : "unknown", fix: recordedFix === "completed" ? "completed" : "skipped", ship: status };
  }

  const worker = unit.worker !== undefined ? unit.workerKind : undefined;
  const stages: IssueStages = { implement: "completed", review: "pending", fix: recordedFix, ship: "pending" };
  if (worker === "fix") {
    stages.fix = status;
    return stages;
  }
  if (worker === "review") {
    stages.review = status;
    return stages;
  }

  const stopped = status === "blocked" || status === "failed";
  if (recordedFix === "pending") {
    if (stopped) stages.fix = status;
    return stages;
  }
  const implemented = unit.stage === "done" || unit.stage === "review" || unit.delivery === "review";
  // Older blocked units record the delivery phase only in the fleet summary.
  const legacyBlock = stopped && !unit.delivery && (unit.stage === "validate" || unit.stage === "done");
  if (stopped && (unit.delivery === "ci" || (legacyBlock && fleet.ci?.status === status))) {
    if (reviewed || (legacyBlock && workflowStatus(fleet.review?.status ?? "") === "completed")) stages.review = "completed";
    stages.ship = status;
  } else if (legacyBlock && fleet.review?.status === status) {
    stages.review = status;
  } else if (reviewed) {
    stages.review = "completed";
    stages.ship = status;
  } else if (!implemented) {
    stages.implement = status;
  } else if (stopped || unit.stage === "review" || unit.delivery === "review" ||
    unit.delivery === "ci" || (!unit.delivery && unit.headSha)) {
    // Draft CI can start before review. Only a pass on the current HEAD starts shipping.
    stages.review = status;
  }
  return stages;
}

function summarizeStage(statuses: DisplayStatus[]): DisplayStatus | "partial" {
  const applicable = statuses.filter((status) => status !== "skipped");
  if (applicable.length === 0) return statuses.length ? "skipped" : "pending";
  if (applicable.every((status) => status === "completed")) return "completed";
  for (const status of ["failed", "blocked", "unknown"] as const) {
    if (applicable.includes(status)) return status;
  }
  if (applicable.includes("in_progress")) return "in_progress";
  return applicable.includes("completed") ? "partial" : "pending";
}

function issueStageLabel(name: keyof IssueStages, units: IssueStages[], openFindings = 0): DiagramPart[] {
  const counts = new Map<DisplayStatus, number>();
  for (const unit of units) counts.set(unit[name], (counts.get(unit[name]) ?? 0) + 1);
  const eligible = units.length - (counts.get("skipped") ?? 0);
  const done = counts.get("completed") ?? 0;
  const node: DiagramPart[] = [{ text: name[0]!.toUpperCase() + name.slice(1), color: "text" }];
  const detail = (text: string, color: string) => {
    node.push({ color: "dim", text: node.length === 1 ? " " : " · " }, { text, color });
  };
  if (done > 0 && (name === "implement" || name === "ship")) {
    detail(`${done}/${eligible}`, done === eligible ? "success" : "muted");
  }
  const states: DisplayStatus[] = ["failed", "blocked", "unknown", "in_progress"];
  if (name === "fix") states.push("pending", "completed");
  node.push(...diagramCounts(states.map(state => ({ ...statusStyle(state), count: counts.get(state) ?? 0 }))));

  if (name === "review") {
    if (openFindings) detail(`${openFindings} open finding${openFindings === 1 ? "" : "s"}`, "muted");
    if (done && node.length === 1) detail(`✓${done}/${eligible}`, done === eligible ? "success" : "muted");
  }
  if (node.length === 1) {
    const style = statusStyle(name === "fix" ? "skipped" : "pending");
    detail(style.glyph, style.color);
  }
  return node;
}

function issueWorkflowNodes(plan: RushPlan): WorkflowNode[] {
  const units = plan.issues.filter(unit => workflowStatus(unit.status) !== "skipped");
  if (!units.length) return [];
  const stages = units.map(unit => unitStages(unit, plan.fleet));
  const openFindings = units.reduce((count, unit) =>
    workflowStatus(unit.status) === "completed" ? count : count + (unit.openFindings ?? 0), 0);
  const node = (id: keyof IssueStages, parents: string[], revision?: string): WorkflowNode => {
    const label = issueStageLabel(id, stages, openFindings);
    return { ids: [id], name: label[0]!.text, label, parents, revision };
  };
  return [node("implement", []), node("review", ["implement"], "fix"), node("fix", []), node("ship", ["review"])];
}

function presentRushPlan(plan: RushPlan, owner: string, readOnly: boolean): PlanPresentation {
  const stageLabel = (name: string, status: DisplayStatus | "partial", suffix = "") => {
    const style = statusStyle(status === "partial" ? "implemented" : status);
    return { color: style.color, text: `${name} ${style.glyph}${suffix}` };
  };
  const fleetLabel = (name: string) => {
    const raw = plan.fleet[name]?.status ?? "pending";
    const status = workflowStatus(raw);
    return stageLabel(name, status, status === "unknown" ? ` ${planText(raw)}` : "");
  };
  const context = [{ color: "dim", text: `${planText(owner)} · rev ${plan.planRevision}` }];
  // The warehouse canary only applies to data work; hide it otherwise.
  if (plan.warehouseCanaryRequired) {
    context.push({ color: "dim", text: "  ·  " });
    const applicable = plan.issues.filter(unit => unit.canaryStatus !== undefined);
    const remaining = applicable.filter(unit => workflowStatus(unit.status) !== "skipped");
    if (remaining.some(unit => unit.canaryStatus != null)) {
      const statuses = remaining.map(unit => unit.canaryStatus ?? "pending");
      const status = summarizeStage(statuses);
      context.push(stageLabel("canary", status));
      if (status !== "in_progress" && statuses.includes("in_progress")) {
        const style = statusStyle("in_progress");
        context.push({ color: style.color, text: ` ${style.glyph}` });
      }
    } else if (applicable.length && !remaining.length) {
      context.push(stageLabel("canary", "skipped"));
    } else {
      context.push(fleetLabel("canary"));
    }
  }
  const metadata = [context];
  if (readOnly) metadata.push([{ color: "warning", text: "read-only handoff" }]);
  if (plan.spec?.title) metadata.push([{ color: "dim", text: plan.spec.title }]);
  return {
    metadata,
    rows: visibleRushUnits(plan).map((unit) => {
      const status = unitStatus(unit);
      const cancelled = unit.status === "cancelled" || unit.status === "canceled";
      const details = [`${unit.stage} · ${unit.status}${unit.delivery ? ` · ${unit.delivery}` : ""}${unit.worker !== undefined ? ` · worker ${unit.worker}` : ""}`];
      if (unit.dependsOn.length) details.push(`after: ${unit.dependsOn.map((id) => `#${id}`).join(", ")}`);
      if (unit.note) details.push(unit.note);
      const worker = unit.worker !== undefined && workflowStatus(unit.status) === "in_progress" ? unit.workerKind : undefined;
      let statusLabel: string | undefined;
      if (status === "unknown" || cancelled) statusLabel = unit.status;
      else if (worker === "fix") statusLabel = "fixing";
      else if (worker === "review") statusLabel = "in review";
      return {
        label: `#${unit.id}`, title: unit.title, status, cancelled, details,
        ...(statusLabel ? { statusLabel } : {}),
      };
    }),
  };
}

export function visibleRushUnits(plan: RushPlan, now = Date.now()): RushPlan["issues"] {
  return plan.issues.filter(unit => (unit.status !== "cancelled" && unit.status !== "canceled") ||
    unit.cancelledAt === undefined || now < unit.cancelledAt + CANCELLED_ROW_RETENTION_MS);
}

export function renderRushPlan(
  plan: RushPlan,
  width: number,
  full = false,
  fg?: (color: string, value: string) => string,
  owner = "rush-issues",
  readOnly = false,
  expanded = false,
  header?: CompactTaskHeader,
): string[] {
  const theme = fg ? { fg } : plainPlanTheme;
  if (full) {
    const presentation = presentRushPlan(plan, owner, readOnly);
    const graph = workflowDiagram(issueWorkflowNodes(plan), Math.max(1, width - 2));
    return renderPlanPresentation({ ...presentation, metadata: [...(presentation.metadata ?? []), ...graph] }, width, theme, true);
  }
  return renderRushFrame(plan, width, theme, owner, readOnly, expanded, header).lines;
}

export function renderRushFrame(
  plan: RushPlan, width: number, theme: PlanRenderTheme, owner: string, readOnly: boolean,
  expanded: boolean, header?: CompactTaskHeader, leftShare = 0.5,
) {
  const presentation = presentRushPlan(plan, owner, readOnly);
  const heading = renderPlanHeading(presentation, width, theme, header);
  const labels = alignedPlanLabels(presentation.rows);
  const rows = presentation.rows.map((row, index) => {
    const style = statusStyle(row.status);
    return {
      status: row.status,
      label: [
        { color: style.color, text: style.glyph + " " },
        { color: "dim", text: labels[index]! + " " },
        { color: planRowTitleColor(row.status), text: row.title },
      ],
    };
  });
  return renderWorkflowFrame(rows, issueWorkflowNodes(plan), heading, width, theme, expanded, leftShare);
}
