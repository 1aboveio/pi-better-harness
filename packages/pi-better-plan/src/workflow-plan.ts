import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import {
  createPlanPresentationComponent, plainPlanTheme, planText, renderPlanPresentation, statusStyle,
  type DisplayStatus, type PlanPresentation,
} from "./plan-presentation.js";

export const WORKFLOW_PLAN_ENTRY = "pi-better-workflow-plan";

interface RushUnit {
  id: string;
  title: string;
  stage: string;
  status: string;
  dependsOn: string[];
  worker?: string | number | undefined;
  note?: string | undefined;
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
  owner: "rush-issues";
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
  return projectRushPlan(JSON.parse(readFileSync(file, "utf8")), runId);
}

/** Validate a parsed task-plan.json document and project the fields the plan view shows. */
export function projectRushPlan(data: unknown, runId: string): RushPlan {
  if (!isRecord(data) || data.runId !== runId || !Number.isSafeInteger(data.planRevision) ||
      (data.planRevision as number) < 0 || !isRecord(data.fleet)) {
    throw new Error("Invalid Rush plan identity or revision.");
  }
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
      worker: typeof unit.worker === "string" || typeof unit.worker === "number" ? unit.worker : undefined,
      note: typeof unit.note === "string" ? unit.note : undefined,
    };
  });
  const fleet: RushPlan["fleet"] = {};
  for (const [stage, value] of Object.entries(data.fleet)) {
    const status = typeof value === "string" ? value : isRecord(value) ? value.status : undefined;
    if (typeof status !== "string") throw new Error("Invalid Rush fleet stage.");
    fleet[stage] = { status };
  }
  return {
    runId: data.runId as string,
    planRevision: data.planRevision as number,
    issues,
    fleet,
    // The skill marks canary work per unit (`warehouseCanary`); older plans set a run-level flag.
    warehouseCanaryRequired: data.warehouseCanaryRequired === true ||
      persistedUnits.some((unit: unknown) => isRecord(unit) && unit.warehouseCanary != null && unit.warehouseCanary !== false),
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
      if (isRecord(data) && data.version === 1 && (data.kind === "set" || data.kind === "clear")) binding = null;
    }
    if (entry.type !== "custom" || entry.customType !== WORKFLOW_PLAN_ENTRY) continue;
    const data = entry.data;
    if (!isRecord(data) || data.version !== 1) continue;
    if (data.kind === "clear") binding = null;
    else if (data.kind === "set" && data.owner === "rush-issues" &&
             typeof data.path === "string" && typeof data.runId === "string") {
      binding = { owner: "rush-issues", path: data.path, runId: data.runId };
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
    case "skipped": case "not-applicable": case "cancelled": return "skipped";
    default: return "unknown";
  }
}

function presentRushPlan(plan: RushPlan): PlanPresentation {
  // The warehouse canary only applies to data work; hide it otherwise.
  const stages = ["explore", "implement", "review", "ci", ...(plan.warehouseCanaryRequired ? ["canary"] : [])];
  const fleet = stages.map((stage) => {
    const status = plan.fleet[stage]?.status ?? "pending";
    const display = workflowStatus(status);
    const style = statusStyle(display);
    return { color: style.color, text: `  ${stage} ${style.glyph}${display === "unknown" ? ` ${planText(status)}` : ""}` };
  });
  const metadata = [[{ color: "dim", text: `rush-issues · rev ${plan.planRevision}  ·` }, ...fleet]];
  if (plan.spec?.title) metadata.push([{ color: "dim", text: plan.spec.title }]);
  return {
    metadata,
    rows: plan.issues.map((unit) => {
      const status = workflowStatus(unit.status);
      const details = [`${unit.stage} · ${unit.status}${unit.worker !== undefined ? ` · worker ${unit.worker}` : ""}`];
      if (unit.dependsOn.length) details.push(`after: ${unit.dependsOn.map((id) => `#${id}`).join(", ")}`);
      if (unit.note) details.push(unit.note);
      return {
        label: `#${unit.id}`, title: unit.title, status, details,
        ...(status === "unknown" || unit.status === "cancelled" ? { statusLabel: unit.status } : {}),
      };
    }),
  };
}

export function renderRushPlan(
  plan: RushPlan,
  width: number,
  full = false,
  fg?: (color: string, value: string) => string,
): string[] {
  const theme = fg ? { fg } : plainPlanTheme;
  return renderPlanPresentation(presentRushPlan(plan), width, theme, full);
}

export function createRushPlanComponent(
  plan: RushPlan,
  onClose: () => void,
  fg?: (color: string, value: string) => string,
): Component {
  const theme = fg ? { fg } : plainPlanTheme;
  return createPlanPresentationComponent(presentRushPlan(plan), theme, onClose);
}