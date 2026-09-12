export const EXTENSION_NAME = "pi-better-plan";

export type PlanStepStatus = "pending" | "in_progress" | "completed" | "blocked";
export type PlanDisplayMode = "auto" | "on" | "off" | "hidden";

export interface PlanStepInput {
  step: string;
  status: PlanStepStatus;
}

export interface PlanStep extends PlanStepInput {
  id: string;
}

export interface PlanSnapshot {
  version: 1;
  planId: string;
  revision: number;
  explanation?: string;
  steps: PlanStep[];
  createdAt: number;
  updatedAt: number;
  completedAtMs?: number;
}

export interface PlanProgress {
  total: number;
  completed: number;
  pending: number;
  blocked: number;
  inProgress: number;
  activeIndex: number | null;
  state: "draft" | "in_progress" | "blocked" | "complete";
}

export type PlanEntry =
  | { version: 1; kind: "set"; plan: PlanSnapshot; at: number }
  | { version: 1; kind: "clear"; at: number }
  | { version: 1; kind: "display"; mode: PlanDisplayMode; at: number };