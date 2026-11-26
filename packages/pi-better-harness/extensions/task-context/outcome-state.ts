import { reconstructGoalSnapshot } from "pi-better-goal/src/goal-state.ts";
import type { GoalSnapshot } from "pi-better-goal/src/types.ts";

export const OUTCOME_ENTRY = "pi-better-harness:outcome";

export interface OutcomeInput {
  objective: string;
  doneWhen?: string[];
  boundaries?: string[];
  source?: string;
  status?: "active" | "paused" | "complete" | "cancelled";
}

export interface Outcome extends OutcomeInput {
  status: "active" | "paused" | "complete" | "cancelled";
  goalId?: string;
}

export function prepareOutcome(current: Outcome | null, input: OutcomeInput, newTask = false): Outcome {
  if (typeof input.objective !== "string" || !input.objective.trim()) throw new Error("Outcome objective must not be empty.");
  for (const key of ["doneWhen", "boundaries"] as const) {
    if (input[key] !== undefined && (!Array.isArray(input[key]) || !input[key]!.every(value => typeof value === "string"))) {
      throw new Error(`Goal ${key} must be a list of strings.`);
    }
  }
  if (input.source !== undefined && typeof input.source !== "string") throw new Error("Goal source must be a string.");
  if (input.status !== undefined && !["active", "paused", "complete", "cancelled"].includes(input.status)) throw new Error("Invalid Goal status.");
  const previous = newTask ? null : current;
  return {
    ...previous,
    objective: input.objective.trim(),
    status: input.status ?? previous?.status ?? "active",
    ...(input.doneWhen !== undefined ? { doneWhen: [...input.doneWhen] } : {}),
    ...(input.boundaries !== undefined ? { boundaries: [...input.boundaries] } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
  };
}

export function restoreOutcome(
  entries: readonly { type: string; customType?: string; data?: unknown }[],
  goal?: GoalSnapshot | null,
): Outcome | null {
  let lastOutcomeIndex = -1;
  let outcome: Outcome | null = null;
  for (const [index, entry] of entries.entries()) {
    if (entry.type !== "custom" || entry.customType !== OUTCOME_ENTRY) continue;
    const data = entry.data as { version?: number; outcome?: Outcome } | null;
    if (data?.version !== 1 || !data.outcome) continue;
    try {
      const parsed = prepareOutcome(null, data.outcome);
      if (typeof data.outcome.goalId === "string") parsed.goalId = data.outcome.goalId;
      outcome = parsed;
      lastOutcomeIndex = index;
    } catch {
      // A malformed entry is not permission to replace previously valid task state.
    }
  }
  // Older sessions could save new active work against a Goal that was already complete.
  if (outcome?.status === "active" && goal?.status === "complete" && outcome.goalId === goal.goalId) {
    const previous = reconstructGoalSnapshot(entries.slice(0, lastOutcomeIndex));
    if (previous?.goalId === goal.goalId && previous.status === "complete") {
      delete outcome.goalId;
      if (outcome.source === "goal") delete outcome.source;
    }
  }
  return outcome;
}

export function formatOutcome(outcome: Outcome | null, compact = false): string {
  if (!outcome) return "No Goal is set.";
  const text = (value: string) => compact && value.length > 600 ? `${value.slice(0, 600)}...` : value;
  const items = (values: string[]) => (compact ? values.slice(0, 3) : values).map(value => compact && value.length > 150 ? `${value.slice(0, 150)}...` : value).join("; ");
  return [
    `Goal (${outcome.status === "active" && !outcome.goalId ? "saved" : outcome.status}): ${text(outcome.objective)}`,
    ...(outcome.doneWhen?.length ? [`Done when: ${items(outcome.doneWhen)}`] : []),
    ...(outcome.boundaries?.length ? [`Boundaries: ${items(outcome.boundaries)}`] : []),
  ].join("\n");
}
