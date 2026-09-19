import type { PlanDisplayMode, PlanEntry, PlanProgress, PlanSnapshot, PlanStep, PlanStepInput } from "./types.js";
import { EXTENSION_NAME } from "./types.js";

const MAX_STEPS = 50;
const MAX_STEP_CHARS = 500;
const MAX_EXPLANATION_CHARS = 2_000;
const STEP_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
export const COMPLETED_PLAN_RETENTION_MS = 30_000;

interface SessionEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}

export interface ReconstructedPlanState {
  plan: PlanSnapshot | null;
  displayMode: PlanDisplayMode;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

function nextPlanId(now: number): string {
  return `plan_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function validatePlanInput(steps: readonly PlanStepInput[], explanation?: string): string | null {
  if (steps.length === 0) return "A plan must contain at least one step.";
  if (steps.length > MAX_STEPS) return `A plan cannot contain more than ${MAX_STEPS} steps.`;
  if (explanation !== undefined && explanation.length > MAX_EXPLANATION_CHARS) {
    return `Plan explanation cannot exceed ${MAX_EXPLANATION_CHARS} characters.`;
  }

  const normalized = new Set<string>();
  const ids = new Map<string, number>();
  for (let index = 0; index < steps.length; index += 1) {
    const item = steps[index]!;
    const text = item.step.trim();
    if (!text) return `Plan step ${index + 1} cannot be empty.`;
    if (text.length > MAX_STEP_CHARS) {
      return `Plan step ${index + 1} cannot exceed ${MAX_STEP_CHARS} characters.`;
    }
    const key = text.toLocaleLowerCase();
    if (normalized.has(key)) return `Plan step ${index + 1} duplicates an earlier step.`;
    normalized.add(key);
    if (item.id !== undefined) {
      if (!STEP_ID.test(item.id)) return `Plan step ${index + 1} has an invalid id.`;
      if (ids.has(item.id)) return `Plan step ${index + 1} duplicates id ${item.id}.`;
      ids.set(item.id, index);
    }
  }

  for (let index = 0; index < steps.length; index += 1) {
    const item = steps[index]!;
    const seen = new Set<string>();
    for (const dependency of item.dependsOn ?? []) {
      if (seen.has(dependency)) return `Plan step ${index + 1} repeats dependency ${dependency}.`;
      seen.add(dependency);
      const prerequisite = ids.get(dependency);
      if (prerequisite === undefined) return `Plan step ${index + 1} references unknown dependency ${dependency}. Use explicit ids for dependencies.`;
      if ((item.status === "in_progress" || item.status === "completed") && steps[prerequisite]!.status !== "completed") {
        return `Plan step ${index + 1} cannot be ${item.status} until dependency ${dependency} is completed.`;
      }
    }
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const item = steps[ids.get(id)!]!;
    for (const dependency of item.dependsOn ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const id of ids.keys()) {
    if (visit(id)) return `Plan dependencies contain a cycle involving ${id}.`;
  }
  return null;
}

export function replacePlan(
  current: PlanSnapshot | null,
  steps: readonly PlanStepInput[],
  explanation?: string,
  now = nowSeconds(),
  completedAtMs = Date.now(),
): PlanSnapshot {
  const error = validatePlanInput(steps, explanation);
  if (error) throw new Error(error);

  const reusableIds = new Map(current?.steps.map((item) => [item.step.trim().toLocaleLowerCase(), item.id]) ?? []);
  const revision = (current?.revision ?? 0) + 1;
  const normalizedSteps: PlanStep[] = steps.map((item, index) => {
    const step = item.step.trim();
    return {
      id: item.id ?? reusableIds.get(step.toLocaleLowerCase()) ?? `step_${revision}_${index + 1}`,
      step,
      status: item.status,
      ...(item.dependsOn?.length ? { dependsOn: [...item.dependsOn] } : {}),
    };
  });
  if (new Set(normalizedSteps.map((item) => item.id)).size !== normalizedSteps.length) {
    throw new Error("Plan step ids must be unique, including generated ids.");
  }
  const isComplete = normalizedSteps.every((item) => item.status === "completed");
  const currentIsComplete = current?.steps.every((item) => item.status === "completed") === true;

  return {
    version: 1,
    planId: current?.planId ?? nextPlanId(now),
    revision,
    ...(explanation?.trim() ? { explanation: explanation.trim() } : {}),
    steps: normalizedSteps,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
    ...(isComplete
      ? { completedAtMs: currentIsComplete ? current.completedAtMs ?? current.updatedAt * 1_000 : completedAtMs }
      : {}),
  };
}

export function completedPlanClearDelay(plan: PlanSnapshot, now = Date.now()): number | null {
  if (planProgress(plan).state !== "complete") return null;
  const completedAtMs = plan.completedAtMs ?? plan.updatedAt * 1_000;
  return Math.max(0, completedAtMs + COMPLETED_PLAN_RETENTION_MS - now);
}

export function planProgress(plan: PlanSnapshot): PlanProgress {
  const completed = plan.steps.filter((item) => item.status === "completed").length;
  const pending = plan.steps.filter((item) => item.status === "pending").length;
  const blocked = plan.steps.filter((item) => item.status === "blocked").length;
  const inProgress = plan.steps.filter((item) => item.status === "in_progress").length;
  const activeIndex = plan.steps.findIndex((item) => item.status === "in_progress");
  const blockedIndex = plan.steps.findIndex((item) => item.status === "blocked");
  const completedIds = new Set(plan.steps.filter((item) => item.status === "completed").map((item) => item.id));
  const readyIndices = plan.steps.flatMap((item, index) =>
    item.status === "pending" && (item.dependsOn ?? []).every((id) => completedIds.has(id)) ? [index] : []);
  return {
    total: plan.steps.length,
    completed,
    pending,
    blocked,
    inProgress,
    activeIndex: activeIndex >= 0 ? activeIndex : blockedIndex >= 0 ? blockedIndex : null,
    readyIndices,
    state:
      completed === plan.steps.length
        ? "complete"
        : inProgress > 0
          ? "in_progress"
          : blocked > 0
            ? "blocked"
            : "draft",
  };
}

export function planSetEntry(plan: PlanSnapshot, at = nowSeconds()): PlanEntry {
  return { version: 1, kind: "set", plan, at };
}

export function planClearEntry(at = nowSeconds()): PlanEntry {
  return { version: 1, kind: "clear", at };
}

export function planDisplayEntry(mode: PlanDisplayMode, at = nowSeconds()): PlanEntry {
  return { version: 1, kind: "display", mode, at };
}

export function reconstructPlanState(entries: Iterable<SessionEntryLike>): ReconstructedPlanState {
  let plan: PlanSnapshot | null = null;
  let displayMode: PlanDisplayMode = "auto";
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== EXTENSION_NAME || !isPlanEntry(entry.data)) continue;
    if (entry.data.kind === "set") plan = entry.data.plan;
    else if (entry.data.kind === "clear") plan = null;
    else displayMode = entry.data.mode;
  }
  return { plan, displayMode };
}

function isPlanEntry(value: unknown): value is PlanEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PlanEntry>;
  if (candidate.version !== 1) return false;
  if (candidate.kind === "clear") return true;
  if (candidate.kind === "display") {
    return candidate.mode === "auto" || candidate.mode === "on" || candidate.mode === "off" || candidate.mode === "hidden";
  }
  if (candidate.kind !== "set") return false;
  return isPlanSnapshot(candidate.plan);
}

function isPlanSnapshot(value: unknown): value is PlanSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PlanSnapshot>;
  return (
    candidate.version === 1 &&
    typeof candidate.planId === "string" &&
    typeof candidate.revision === "number" &&
    Array.isArray(candidate.steps) &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.updatedAt === "number" &&
    (candidate.completedAtMs === undefined || typeof candidate.completedAtMs === "number")
  );
}