import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GoalSnapshot } from "./types.js";

/** Synchronous request bus shared with an installed `pi-better-harness` runtime. */
export const TASK_CONTEXT_EVENT = "pi-better-harness:task-context";

export type TaskContextAction = "inspect" | "start" | "pause" | "resume" | "complete";

/**
 * Mutable request. A present Harness runtime sets `enabled` to a boolean even
 * when Outcome & Todo is off. Without Harness the field stays undefined, which
 * lets Goal retain its standalone behavior.
 */
export interface TaskContextRequest {
  action: TaskContextAction;
  goalId?: string;
  /** The raw original goal trigger; only start requests carry it. */
  objective?: string;
  enabled?: boolean;
}

/**
 * Emit one task-context request and return it so the caller can inspect the
 * Harness-owned `enabled` field after synchronous listeners run.
 */
export function requestTaskContext(
  pi: Pick<ExtensionAPI, "events">,
  action: TaskContextAction,
  goal?: GoalSnapshot | null,
): TaskContextRequest {
  const request: TaskContextRequest = { action };
  if (goal) {
    request.goalId = goal.goalId;
    if (action === "start") request.objective = goal.objective;
  }
  pi.events.emit(TASK_CONTEXT_EVENT, request);
  return request;
}
