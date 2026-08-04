import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { EXTENSION_NAME, type GoalSnapshot, type GoalStatus } from "./types.js";

const LEGACY_GOAL_ENTRY_TYPE = "pi-codex-goal";
const MAX_OBJECTIVE_CHARS = 8000;

interface SessionEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}

interface GoalLike {
  goalId: string;
  objective: string;
  status: GoalStatus;
  tokenBudget?: number | null;
  usage?: { tokensUsed?: number; activeSeconds?: number };
  createdAt?: number;
  updatedAt?: number;
  activeStartedAt?: number | null;
  completedAt?: number | null;
}

export type GoalEntrySource = "command" | "tool" | "runtime";

export interface ContinuationState {
  goalId: string;
  lastEvidenceSignature: string | null;
  lastEvidenceSummary: string;
  /** Millisecond timestamp of the last changed foreground or external evidence. */
  lastProgressAt?: number;
  noProgressRetries: number;
  blocked: boolean;
  updatedAt: number;
}

export type GoalCustomEntry =
  | {
      version: 1;
      kind: "set";
      source: GoalEntrySource;
      goal: GoalSnapshot;
      at: number;
    }
  | {
      version: 1;
      kind: "clear";
      source: GoalEntrySource;
      clearedGoalId: string | null;
      at: number;
    }
  | {
      version: 1;
      kind: "continuation-state";
      state: ContinuationState;
      at: number;
    };

function isGoalStatus(value: unknown): value is GoalStatus {
  return value === "active" || value === "paused" || value === "budgetLimited" || value === "complete";
}

function isGoalLike(value: unknown): value is GoalLike {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<GoalLike>;
  return (
    typeof candidate.goalId === "string" &&
    typeof candidate.objective === "string" &&
    isGoalStatus(candidate.status)
  );
}

function isContinuationState(value: unknown): value is ContinuationState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ContinuationState>;
  return (
    typeof candidate.goalId === "string" &&
    (candidate.lastEvidenceSignature === null || typeof candidate.lastEvidenceSignature === "string") &&
    typeof candidate.lastEvidenceSummary === "string" &&
    (candidate.lastProgressAt === undefined || (typeof candidate.lastProgressAt === "number" && Number.isFinite(candidate.lastProgressAt))) &&
    typeof candidate.noProgressRetries === "number" &&
    Number.isInteger(candidate.noProgressRetries) &&
    candidate.noProgressRetries >= 0 &&
    typeof candidate.blocked === "boolean" &&
    typeof candidate.updatedAt === "number"
  );
}

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function nextGoalId(): string {
  return `goal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeGoal(goal: GoalLike): GoalSnapshot {
  const now = unixSeconds();
  const createdAt = typeof goal.createdAt === "number" ? goal.createdAt : now;
  const updatedAt = typeof goal.updatedAt === "number" ? goal.updatedAt : createdAt;
  return {
    goalId: goal.goalId,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: typeof goal.tokenBudget === "number" ? goal.tokenBudget : null,
    usage: {
      tokensUsed: typeof goal.usage?.tokensUsed === "number" ? goal.usage.tokensUsed : 0,
      activeSeconds: typeof goal.usage?.activeSeconds === "number" ? goal.usage.activeSeconds : 0,
    },
    createdAt,
    updatedAt,
    activeStartedAt:
      typeof goal.activeStartedAt === "number"
        ? goal.activeStartedAt
        : goal.status === "active"
          ? updatedAt
          : null,
    completedAt:
      typeof goal.completedAt === "number"
        ? goal.completedAt
        : goal.status === "complete"
          ? updatedAt
          : null,
  };
}

export function createGoalSnapshot(
  objective: string,
  tokenBudget: number | null = null,
  now = unixSeconds(),
): GoalSnapshot {
  return {
    goalId: nextGoalId(),
    objective,
    status: "active",
    tokenBudget,
    usage: { tokensUsed: 0, activeSeconds: 0 },
    createdAt: now,
    updatedAt: now,
    activeStartedAt: now,
    completedAt: null,
  };
}

export function validateObjective(objective: string): string | null {
  if (objective.trim().length === 0) {
    return "Goal objective cannot be empty.";
  }
  if (objective.length > MAX_OBJECTIVE_CHARS) {
    return `Goal objective is too long; limit is ${MAX_OBJECTIVE_CHARS} characters.`;
  }
  return null;
}

export function validateTokenBudget(tokenBudget: number | null | undefined): string | null {
  if (tokenBudget === null || tokenBudget === undefined) {
    return null;
  }
  if (!Number.isInteger(tokenBudget) || tokenBudget <= 0) {
    return "Token budget must be a positive integer when provided.";
  }
  return null;
}

export function goalSetEntry(goal: GoalSnapshot, source: GoalEntrySource): GoalCustomEntry {
  return { version: 1, kind: "set", source, goal, at: unixSeconds() };
}

export function goalClearEntry(clearedGoalId: string | null, source: GoalEntrySource): GoalCustomEntry {
  return { version: 1, kind: "clear", source, clearedGoalId, at: unixSeconds() };
}

export function createContinuationState(goalId: string, now = unixSeconds()): ContinuationState {
  return {
    goalId,
    lastEvidenceSignature: null,
    lastEvidenceSummary: "",
    lastProgressAt: now * 1000,
    noProgressRetries: 0,
    blocked: false,
    updatedAt: now,
  };
}

export function continuationStateEntry(state: ContinuationState): GoalCustomEntry {
  return { version: 1, kind: "continuation-state", state, at: unixSeconds() };
}

export function goalWithStatus(
  goal: GoalSnapshot,
  status: GoalStatus,
  now = unixSeconds(),
): GoalSnapshot {
  const accruedActiveSeconds =
    goal.status === "active" && goal.activeStartedAt !== null
      ? Math.max(0, now - goal.activeStartedAt)
      : 0;
  const usage = {
    ...goal.usage,
    activeSeconds: goal.usage.activeSeconds + accruedActiveSeconds,
  };

  if (status === "active") {
    return {
      ...goal,
      status,
      usage,
      updatedAt: now,
      activeStartedAt: goal.status === "active" ? goal.activeStartedAt : now,
      completedAt: null,
    };
  }

  return {
    ...goal,
    status,
    usage,
    updatedAt: now,
    activeStartedAt: null,
    completedAt: status === "complete" ? now : null,
  };
}

export function reconstructGoalSnapshot(entries: Iterable<SessionEntryLike>): GoalSnapshot | null {
  let goal: GoalSnapshot | null = null;

  for (const entry of entries) {
    if (
      entry.type !== "custom" ||
      (entry.customType !== EXTENSION_NAME && entry.customType !== LEGACY_GOAL_ENTRY_TYPE)
    ) {
      continue;
    }
    if (!entry.data || typeof entry.data !== "object") {
      continue;
    }
    const data = entry.data as { kind?: unknown; goal?: unknown; status?: unknown };
    if (data.kind === "clear") {
      goal = null;
      continue;
    }
    if (data.kind === "set" && isGoalLike(data.goal)) {
      goal = normalizeGoal(data.goal);
      continue;
    }
    if (data.kind === "usage" && goal && isGoalStatus(data.status)) {
      goal = {
        ...goal,
        status: data.status,
        activeStartedAt:
          data.status === "active" ? (goal.activeStartedAt ?? goal.updatedAt) : null,
        completedAt: data.status === "complete" ? goal.updatedAt : null,
      };
    }
  }

  return goal;
}

export function currentGoalSnapshot(ctx: ExtensionContext): GoalSnapshot | null {
  return reconstructGoalSnapshot(ctx.sessionManager.getBranch() as Iterable<SessionEntryLike>);
}

export function currentContinuationState(ctx: ExtensionContext, goalId: string): ContinuationState | null {
  let state: ContinuationState | null = null;
  for (const entry of ctx.sessionManager.getBranch() as Iterable<SessionEntryLike>) {
    if (entry.type !== "custom" || entry.customType !== EXTENSION_NAME || !entry.data || typeof entry.data !== "object") {
      continue;
    }
    const data = entry.data as { kind?: unknown; state?: unknown };
    if (data.kind === "continuation-state" && isContinuationState(data.state) && data.state.goalId === goalId) {
      state = data.state;
    }
  }
  return state;
}