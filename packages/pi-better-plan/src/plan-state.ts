import type { PlanDisplayMode, PlanEntry, PlanProgress, PlanSnapshot, PlanStep, PlanStepInput } from "./types.js";
import { EXTENSION_NAME } from "./types.js";

const MAX_STEPS = 50;
const MAX_STEP_CHARS = 500;
const MAX_EXPLANATION_CHARS = 2_000;
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

  let inProgress = 0;
  const normalized = new Set<string>();
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
    if (item.status === "in_progress") inProgress += 1;
  }
  if (inProgress > 1) return "A plan can have at most one step in progress.";
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
      id: reusableIds.get(step.toLocaleLowerCase()) ?? `step_${revision}_${index + 1}`,
      step,
      status: item.status,
    };
  });
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
  const activeIndex = plan.steps.findIndex((item) => item.status === "in_progress" || item.status === "blocked");
  return {
    total: plan.steps.length,
    completed,
    pending,
    blocked,
    inProgress,
    activeIndex: activeIndex >= 0 ? activeIndex : null,
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