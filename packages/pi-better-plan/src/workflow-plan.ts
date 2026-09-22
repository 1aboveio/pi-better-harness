import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

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

export function readRushPlan(path: string, cwd: string): RushPlan {
  if (!isAbsolute(path) || basename(path) !== "task-plan.json") throw new Error("Expected an absolute Rush task-plan.json path.");
  const root = realpathSync(resolve(cwd, ".resolve-issues", "rush"));
  const file = realpathSync(path);
  const dir = relative(root, dirname(file));
  if (!dir || dir.startsWith(".." + sep) || dir === ".." || dir.includes(sep)) {
    throw new Error("Rush plan must be inside this project's .resolve-issues/rush/<run-id> directory.");
  }
  const size = statSync(file).size;
  if (size > 2_000_000) throw new Error("Rush plan exceeds the 2 MB display limit.");
  const data: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(data) || data.runId !== dir || !Number.isSafeInteger(data.planRevision) ||
      (data.planRevision as number) < 0 || !Array.isArray(data.issues) || !isRecord(data.fleet)) {
    throw new Error("Invalid Rush plan identity or revision.");
  }
  const issues = data.issues.map((unit: unknown) => {
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
    if (!isRecord(value) || typeof value.status !== "string") throw new Error("Invalid Rush fleet stage.");
    fleet[stage] = { status: value.status };
  }
  return {
    runId: data.runId as string,
    planRevision: data.planRevision as number,
    issues,
    fleet,
    warehouseCanaryRequired: data.warehouseCanaryRequired === true,
    spec: isRecord(data.spec) && typeof data.spec.title === "string" ? { title: data.spec.title } : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
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

export function renderRushPlan(plan: RushPlan, width: number, full = false): string[] {
  const completed = plan.issues.filter((unit) => unit.status === "succeeded").length;
  const lines = [`rush-issues  rev ${plan.planRevision}  ${completed}/${plan.issues.length} units${plan.spec?.title ? `  ${plan.spec.title}` : ""}`];
  const fleet = ["explore", "combine", "canary", "review", "cicd"]
    .map((stage) => `${stage}: ${stage === "canary" && !plan.warehouseCanaryRequired ? "n/a" : plan.fleet[stage]?.status ?? "pending"}`);
  lines.push(`fleet  ${fleet.join("  ")}`);
  for (const unit of plan.issues) {
    const marker = unit.status === "succeeded" ? "✓" : unit.status === "blocked" ? "!" : unit.status === "pending" ? "○" : "●";
    lines.push(`${marker} #${unit.id} ${unit.title}  [${unit.stage} · ${unit.status}${unit.worker !== undefined ? ` · worker ${unit.worker}` : ""}]`);
    if (full) {
      if (unit.dependsOn.length) lines.push(`    after: ${unit.dependsOn.map((id) => `#${id}`).join(", ")}`);
      if (unit.note) lines.push(`    ${unit.note}`);
    }
  }
  return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
}

export function createRushPlanComponent(plan: RushPlan, onClose: () => void): Component {
  return {
    render: (width) => renderRushPlan(plan, width, true),
    handleInput(data) {
      if (matchesKey(data, "escape") || matchesKey(data, "left") || matchesKey(data, "ctrl+c")) onClose();
    },
    invalidate() {},
  };
}