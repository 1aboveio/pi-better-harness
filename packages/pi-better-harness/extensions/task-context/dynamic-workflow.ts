import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { validatePlanInput } from "./plan-state.js";

const text = Type.String({ minLength: 1, pattern: "\\S" });
const id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" });
const definitionSchema = Type.Object({
  objective: text,
  criteria: Type.Array(text, { minItems: 1, uniqueItems: true, description: "Observable acceptance criteria for the user's objective." }),
  goalId: Type.Optional(text),
  steps: Type.Array(Type.Object({
    id, title: text, output: text,
    dependsOn: Type.Optional(Type.Array(id, { uniqueItems: true })),
    stage: Type.Optional(text),
    catalog: Type.Optional(Type.String({ description: "Canonical inspected role.* or agent.* id. Omit for foreground work." })),
    review: Type.Optional(Type.Object({ artifact: id, revision: id }, { description: "Review the artifact step's output. On findings, open the revision step, then review the new version. Delivery depends on this review." })),
  }), { minItems: 1, maxItems: 50 }),
});
const evidenceSchema = Type.Array(Type.Object({ criterion: text, result: text }));
export const dynamicParameters = Type.Object({
  action: StringEnum(["define", "submit", "retry", "finish"] as const),
  definition: Type.Optional(definitionSchema),
  runId: Type.Optional(text), revision: Type.Optional(Type.Integer({ minimum: 1 })),
  step: Type.Optional(id), result: Type.Optional(text),
  verdict: Type.Optional(StringEnum(["passed", "changes_requested"] as const)),
  artifactVersion: Type.Optional(Type.Integer({ minimum: 1 })),
  evidence: Type.Optional(evidenceSchema),
});
export type Definition = Static<typeof definitionSchema>;
export type DynamicInput = Static<typeof dynamicParameters>;
export type Step = Definition["steps"][number];
export type CatalogChoice = { id: string; skills: string[] | null; error?: string };
export type Attempt = { callId: string; runId?: string; result?: string; error?: string };
type History = { step: string; result: string; version?: number; verdict?: DynamicInput["verdict"]; worker?: Attempt };
export interface WorkflowRun extends Definition {
  id: string; revision: number;
  history: History[];
  workers: Record<string, Attempt>;
  catalogChoices: CatalogChoice[];
  evidence?: Static<typeof evidenceSchema>;
}
export type BranchEntry = { type: string; customType?: string; data?: unknown };
export const DYNAMIC_ENTRY = "pi-better-harness:dynamic-workflow";
export type DynamicState = { version: 1; pending: true } | { version: 1; run: WorkflowRun } | { version: 1; clear: true };
export function readDynamic(entries: readonly BranchEntry[], goalId?: string): DynamicState | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type !== "custom" || e.customType !== DYNAMIC_ENTRY) continue;
    const state = e.data as DynamicState | undefined;
    if (state?.version === 1 && (!goalId || ("run" in state && state.run.goalId === goalId))) return state;
  }
  return undefined;
}

export function defineWorkflow(input: Definition, choices: CatalogChoice[]): WorkflowRun {
  const error = validatePlanInput(input.steps.map(s => ({ id: s.id, step: s.title, dependsOn: s.dependsOn, status: "pending" })));
  if (error) throw new Error(error);
  const fixes = new Set<string>();
  const byId = new Map(input.steps.map(step => [step.id, step]));
  for (const step of input.steps) {
    if (!step.review) continue;
    const { artifact, revision } = step.review;
    const fix = byId.get(revision);
    if (!step.dependsOn?.includes(artifact) || !fix || fix.review || fix.dependsOn?.length || fixes.has(revision)
      || byId.get(artifact)?.review || input.steps.some(s => s.dependsOn?.includes(revision))) {
      throw new Error("A review must depend on its artifact and own a separate revision step with no ordinary dependencies or dependents.");
    }
    fixes.add(revision);
  }
  return { ...input, id: randomUUID(), revision: 1, history: [], workers: {}, catalogChoices: choices };
}

export function reviewState(run: WorkflowRun, reviewer: Step) {
  const review = reviewer.review!;
  const changes = run.history.filter(h => h.step === review.revision);
  const version = changes.length + 1;
  const verdict = run.history.find(h => h.step === reviewer.id && h.version === version);
  const artifact = changes.at(-1) ?? run.history.find(h => h.step === review.artifact);
  return { version, verdict, artifact };
}

export function phase(run: WorkflowRun, step: Step): "ready" | "waiting" | "complete" | "standby" | "working" | "failed" {
  const reviewer = run.steps.find(s => s.review?.revision === step.id);
  if (reviewer) {
    const { verdict } = reviewState(run, reviewer);
    if (verdict?.verdict !== "changes_requested") return run.history.some(h => h.step === step.id) ? "complete" : "standby";
  } else if (step.review) {
    const { verdict } = reviewState(run, step);
    if (verdict?.verdict === "passed") return "complete";
    if (verdict?.verdict === "changes_requested") return "waiting";
  } else if (run.history.some(h => h.step === step.id)) return "complete";

  // A completed prerequisite has a recorded output, or a passing current review.
  if (step.dependsOn?.some(dep => {
    const parent = run.steps.find(s => s.id === dep)!;
    return parent.review ? reviewState(run, parent).verdict?.verdict !== "passed" : !run.history.some(h => h.step === dep);
  })) return "waiting";
  const choice = run.catalogChoices.find(c => c.id === step.catalog);
  const worker = Object.hasOwn(run.workers, step.id) ? run.workers[step.id] : undefined;
  if (choice?.error || worker?.error) return "failed";
  if (worker) return "working";
  return "ready";
}

export function openWork(run: WorkflowRun): string[] {
  return run.steps.filter(step => !["complete", "standby"].includes(phase(run, step))).map(s => s.title);
}

export function advanceWorkflow(current: WorkflowRun, input: DynamicInput): WorkflowRun {
  if (input.runId !== current.id || input.revision !== current.revision) throw new Error("Workflow changed. Read get_todo for its current runId and revision.");
  if (current.evidence) throw new Error("Workflow already finished.");
  const run = structuredClone(current);
  if (input.action === "finish") {
    const open = openWork(run);
    if (open.length) throw new Error("Outstanding steps: " + open.join(", "));
    const missing = run.criteria.filter(c => !input.evidence?.some(e => e.criterion === c && e.result.trim()));
    if (missing.length) throw new Error("Missing objective evidence: " + missing.join(", "));
    run.evidence = input.evidence;
  } else {
    const step = run.steps.find(s => s.id === input.step);
    if (!step) throw new Error("Unknown workflow step.");
    const state = phase(run, step);
    if (input.action === "retry") {
      if (state !== "failed") throw new Error("Only a failed assignment can be retried.");
      delete run.workers[step.id];
    } else {
      if (input.action !== "submit" || !["ready", "working"].includes(state)) throw new Error(step.title + " is " + state + ".");
      const worker = Object.hasOwn(run.workers, step.id) ? run.workers[step.id] : undefined;
      if (step.catalog && !worker?.result) throw new Error("Inspect this step's successful subagent_result before submitting its output.");
      if (!input.result?.trim()) throw new Error("Supply the required output: " + step.output);
      const reviewer = step.review ? step : run.steps.find(s => s.review?.revision === step.id);
      if (reviewer && input.artifactVersion !== reviewState(run, reviewer).version) throw new Error("Review or revise the current artifact version.");
      if (step.review ? !input.verdict : input.verdict !== undefined) throw new Error("Only a review step takes a required verdict.");
      run.history.push({ step: step.id, result: input.result, version: input.artifactVersion, verdict: input.verdict, worker });
      delete run.workers[step.id];
    }
  }
  run.revision++;
  return run;
}
