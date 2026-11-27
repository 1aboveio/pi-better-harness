import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GoalSnapshot } from "./types.js";

/** Synchronous request bus shared with an installed `pi-better-harness` runtime. */
export const TASK_CONTEXT_EVENT = "pi-better-harness:task-context";

export type TaskContextAction = "saved" | "adopt" | "inspect" | "audit" | "start" | "bind" | "pause" | "resume" | "complete";

export const OUTCOME_ACCEPTED_EVENT = "pi-better-harness:outcome-accepted";

/** The Todo panel probes once on installation and requests a start only on a user click. */
export const GOAL_PANEL_START_EVENT = "pi-better-goal:panel-start";
export type GoalPanelStartRequest =
  | { action: "probe"; available?: boolean }
  | { action: "start"; sessionId: string; objective: string };

export interface OutcomeAcceptedEvent {
  sessionId: string;
  reopenedGoalId?: string;
  outcome: {
    objective: string;
    doneWhen?: readonly string[];
    status: string;
    goalId?: string;
  };
}

/** Only explicit, actionable outcomes qualify; prose and restored state do not. */
export function canStartGoalFromOutcome(value: unknown, reopenedGoal?: Pick<GoalSnapshot, "objective" | "command">): value is OutcomeAcceptedEvent["outcome"] {
  if (!value || typeof value !== "object") return false;
  const outcome = value as Partial<OutcomeAcceptedEvent["outcome"]>;
  const objective = typeof outcome.objective === "string" ? outcome.objective.trim() : "";
  const retainsCommand = reopenedGoal?.command && reopenedGoal.objective.trim() === objective;
  return outcome.status === "active" && outcome.goalId === undefined &&
    !!objective && (!objective.startsWith("/") || !!retainsCommand) &&
    (reopenedGoal !== undefined || (Array.isArray(outcome.doneWhen) && outcome.doneWhen.length > 0 &&
      outcome.doneWhen.every(item => typeof item === "string" && !!item.trim())));
}

/**
 * Mutable request. A present Harness runtime sets `enabled` to a boolean even
 * when Outcome & Todo is off. Without Harness the field stays undefined, which
 * lets Goal retain its standalone behavior.
 */
export interface TaskContextRequest {
  action: TaskContextAction;
  auditHandled?: boolean;
  savedGoal?: { objective: string; status: string; goalId?: string; reopenedGoalId?: string };
  handoffOwner?: string;
  manual?: boolean;
  status?: GoalSnapshot["status"];
  doneWhen?: readonly string[];
  openSteps?: readonly string[];
  /** The Goal delegated its checklist to the workflow checked by the completion gate. */
  workflowOwnsPlan?: boolean;
  /** Evidence retained by a finished workflow bound to this Goal. */
  evidence?: readonly { criterion: string; result: string }[];
  ledgerBlocker?: string;
  goalId?: string;
  /** Current widget width on a visual ownership inspection. */
  width?: number;
  /** The raw original goal trigger; returned as the refined objective on audit. */
  objective?: string;
  /** Hooks authority: a present Harness runtime sets this even when Outcome & Todo is off. */
  enabled?: boolean;
  /**
   * Visual ownership. A Harness runtime sets this on `inspect` responses when
   * its combined Todo header is rendering the requested `goalId`. It is
   * independent of `enabled` and stays undefined without Harness, so Goal keeps
   * its standalone clock widget whenever that header does not own the goal.
   */
  display?: boolean;
}

/**
 * Emit one task-context request and return it so the caller can inspect the
 * Harness-owned `enabled` field after synchronous listeners run.
 */
export function requestTaskContext(
  pi: Pick<ExtensionAPI, "events">,
  action: TaskContextAction | { action: "audit"; workflowOwnsPlan: boolean },
  goal?: GoalSnapshot | null,
  width?: number,
  manual = false,
): TaskContextRequest {
  const request: TaskContextRequest = typeof action === "string" ? { action } : { ...action };
  if (manual) request.manual = true;
  if (width !== undefined) request.width = width;
  if (goal) {
    request.goalId = goal.goalId;
    if (action === "adopt") request.status = goal.status;
    if (action === "start" || action === "bind" || action === "adopt") request.objective = goal.objective;
  }
  pi.events.emit(TASK_CONTEXT_EVENT, request);
  return request;
}
