import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reconstructGoalSnapshot } from "pi-better-goal/src/goal-state.ts";
import { readHarnessSetting, updateHarnessSetting } from "../shared-harness-settings.js";
import { advanceWorkflow, defineWorkflow, DYNAMIC_ENTRY, dynamicParameters, phase, readDynamic,
  type Attempt, type CatalogChoice, type DynamicState, type WorkflowRun } from "./dynamic-workflow.js";
import { WORKFLOW_ASSIGNMENT, type WorkflowAssignmentRequest } from "pi-better-subagents/workflow-assignment.ts";
import { DELEGATION_MODE_REQUEST } from "pi-better-subagents/delegation.ts";
import { isRecord } from "./workflow-plan.js";
import { describeRun } from "./dynamic-workflow-view.js";

const modes = ["off", "on", "adaptive"] as const;
type Mode = typeof modes[number];
const planning = "Analyze the user's current intent. Use dynamic_workflow action define with the actual objective, observable criteria and task-specific steps. Express real dependencies and parallel branches. Where delegation is permitted, inspect suitable entries with agents_catalog before selecting their canonical ids. Use stages and review/revision only where the task needs them. Bind goalId only for the Goal this work delivers.";
const execution = "Read get_todo to resume the accepted workflow. Work each ready step, then submit its required output using the current runId and revision. For a catalog item, call subagent_spawn with workflow:{runId,step}, its selected role or agent, inheriting catalog settings. Inspect subagent_result after its callback. For review or revision, submit the current artifactVersion and findings or output. Finish with evidence for each objective criterion.";

function catalogChoice(ctx: ExtensionContext, id: string): CatalogChoice {
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "agents_catalog") continue;
    const details: unknown = entry.message.details;
    const view = isRecord(details) ? details.view : undefined;
    if (!isRecord(view) || view.id !== id) continue;
    const exposure = isRecord(view.skills) && isRecord(view.skills.effective) ? view.skills.effective : undefined;
    if (!view.found || !view.definitionValid || !view.catalogLaunchable || view.launchable === false || exposure?.mode === "error") {
      const reason = exposure?.error ?? view.launchabilityReason;
      return { id, skills: null, error: typeof reason === "string" ? reason : "Catalog entry unavailable." };
    }
    if (!exposure || exposure.mode === "discovery") return { id, skills: null };
    if (!Array.isArray(exposure.paths) || !exposure.paths.every(path => typeof path === "string")) {
      return { id, skills: null, error: "Catalog entry has invalid skill paths." };
    }
    return { id, skills: exposure.paths };
  }
  return { id, skills: null, error: "Inspect " + id + " with agents_catalog, then retry the step." };
}

export function registerDynamicWorkflow(pi: ExtensionAPI, owner: (ctx: ExtensionContext) => string | null, changed: () => void) {
  let mode: Mode = "off";
  let state: DynamicState | undefined;
  let activeContext: ExtensionContext | undefined;
  const run = () => state && "run" in state ? state.run : undefined;
  const pending = () => !!state && "pending" in state;
  const restore = (ctx: ExtensionContext) => {
    activeContext = ctx;
    state = readDynamic(ctx.sessionManager.getBranch());
  };
  const save = (next: DynamicState) => {
    pi.appendEntry(DYNAMIC_ENTRY, next);
    state = next;
    changed();
  };
  const persist = (next: WorkflowRun) => save({ version: 1, run: next });
  const clear = () => save({ version: 1, clear: true });
  const setting = {
    id: "dynamic-workflow", label: "Automatic dynamic workflows", values: [...modes], get: () => mode,
    change(value: string) {
      if (!modes.includes(value as Mode)) throw new Error("Unknown dynamic workflow mode.");
      mode = updateHarnessSetting("dynamicWorkflow", () => value as Mode);
      changed();
    },
  };
  const loadMode = () => {
    const saved = readHarnessSetting<Mode>("dynamicWorkflow");
    mode = saved && modes.includes(saved) ? saved : "off";
  };
  const active = () => { const current = run(); return !!current && !current.evidence; };
  const available = () => mode !== "off" || pending() || active();
  const guidance = () => {
    if (active()) return execution;
    if (pending() || mode === "on") return planning;
    if (mode === "adaptive") return "Handle simple single-action requests directly. For tasks with dependencies, role handoffs, parallel work or repeated review, consider a dynamic workflow. " + planning;
    return undefined;
  };
  pi.registerCommand("dynamic-workflow", {
    description: "Plan one workflow for the current task, or continue its active run",
    handler: async (args, ctx) => {
      restore(ctx);
      const existingOwner = owner(ctx);
      if (existingOwner) { ctx.ui.notify(existingOwner + " owns this Todo.", "warning"); return; }
      const resume = active();
      if (!resume && !pending()) save({ version: 1, pending: true });
      pi.sendMessage({ customType: DYNAMIC_ENTRY + ":requested", display: true,
        content: [resume ? "Continue the current dynamic workflow." : "Plan a dynamic workflow for the current task.", args.trim()].filter(Boolean).join("\n") },
        { triggerTurn: true, deliverAs: "followUp" });
    },
  });
  pi.registerTool({
    name: "dynamic_workflow", label: "Dynamic workflow", description: "Define the task workflow once, record step results and versioned review verdicts, retry a failed assignment, or finish with objective evidence.",
    parameters: dynamicParameters,
    async execute(_key, input, _signal, _update, ctx) {
      restore(ctx);
      if (owner(ctx)) throw new Error(owner(ctx) + " owns the Todo.");
      const current = run();
      let next: WorkflowRun;
      if (input.action === "define") {
        if (current && !current.evidence) throw new Error("A workflow is already active.");
        if (mode === "off" && !pending()) throw new Error("Automatic workflows are off. Use /dynamic-workflow for this task.");
        if (!input.definition) throw new Error("Supply a workflow definition.");
        const goal = reconstructGoalSnapshot(ctx.sessionManager.getBranch());
        const goalId = input.definition.goalId ?? (goal?.status === "active" && goal.objective === input.definition.objective ? goal.goalId : undefined);
        if (goalId && (goal?.goalId !== goalId || goal.status !== "active")) throw new Error("Bind only to the active Goal.");
        const ids = [...new Set(input.definition.steps.flatMap(s => s.catalog ? [s.catalog] : []))];
        next = defineWorkflow({ ...input.definition, goalId }, ids.map(id => catalogChoice(ctx, id)));
      } else {
        if (!current) throw new Error("No accepted workflow.");
        next = advanceWorkflow(current, input);
        if (input.action === "retry") {
          const id = next.steps.find(s => s.id === input.step)?.catalog;
          if (id) next.catalogChoices = next.catalogChoices.map(c => c.id === id ? catalogChoice(ctx, id) : c);
        }
      }
      persist(next);
      return { content: [{ type: "text", text: describeRun(next) }], details: { run: next } };
    },
  });

  function recordWorker(current: WorkflowRun, stepId: string, worker: Attempt) {
    persist({ ...current, revision: current.revision + 1, workers: { ...current.workers, [stepId]: worker } });
  }
  const unsubscribe = pi.events.on(WORKFLOW_ASSIGNMENT, (event: unknown) => {
    const request = event as WorkflowAssignmentRequest;
    const { input, ref } = request;
    const ctx = activeContext;
    const origin = request.ctx.sessionManager;
    const originLeaf = origin.getLeafId?.();
    if (!ctx || ctx.sessionManager.getSessionId() !== origin.getSessionId() ||
        (originLeaf && !ctx.sessionManager.getBranch().some(entry => entry.id === originLeaf))) {
      request.error = "The workflow assignment belongs to another session branch.";
      return;
    }
    restore(ctx);
    const current = run();
    const s = current?.steps.find(step => step.id === ref.step);
    if (!current || ref.runId !== current.id || !s?.catalog || owner(ctx)) {
      request.error = "No matching active workflow assignment.";
      return;
    }
    const state = phase(current, s);
    if (state !== "ready") { request.error = s.title + " is " + state; return; }
    const modeRequest: { mode?: string } = {};
    pi.events.emit(DELEGATION_MODE_REQUEST, modeRequest);
    const selected = s.catalog.startsWith("role.") ? "role" : "agent";
    const value = selected === "role" ? s.catalog.slice(5) : s.catalog;
    let error: string | undefined;
    if (modeRequest.mode === "manual") error = "Automatic workflow delegation is disabled in manual mode.";
    else if ((input[selected] !== value && input[selected] !== s.catalog) || input[selected === "role" ? "agent" : "role"] !== undefined
      || input.session_id !== undefined || input.session_name !== undefined || input.skills !== undefined || input.clean === true) error = "Use the selected catalog entry and inherit its skills.";
    recordWorker(current, s.id, { callId: request.callId, error });
    if (error) { request.error = error; return; }
    const needs = new Set(s.dependsOn);
    const reviewer = s.review ? s : current.steps.find(item => item.review?.revision === s.id);
    if (reviewer?.review) {
      needs.add(reviewer.id);
      needs.add(reviewer.review.artifact);
      needs.add(reviewer.review.revision);
    }
    const prior = current.history.filter(h => needs.has(h.step)).map(h => h.step + ": " + h.result);
    const prompt = [input.prompt, "Objective: " + current.objective, "Assignment: " + s.title,
      "Required output: " + s.output, ...prior].join("\n");
    request.admission = { prompt, settled(receipt) {
      // Re-read the selected branch after asynchronous admission. A fork or a
      // simultaneous independent launch may have changed the latest snapshot.
      if (!activeContext || activeContext.sessionManager.getSessionId() !== origin.getSessionId()) return;
      restore(activeContext);
      const latest = run();
      if (latest?.id === current.id && latest.workers[s.id]?.callId === request.callId) {
        recordWorker(latest, s.id, { callId: request.callId, ...receipt });
      }
    } };
  });
  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "subagent_result") return;
    restore(ctx);
    const current = run();
    if (!current || current.evidence) return;
    const claim = Object.entries(current.workers).find(([, w]) => w.runId && w.runId === event.input.id);
    if (!claim) return;
    const [stepId, worker] = claim;
    const details = event.details as { hasFinalAnswer?: boolean; outcome?: { outcome?: { outcome?: string; reason?: string } }; assignment?: { attemptId?: string; state?: string; reason?: string; verified?: boolean } } | undefined;
    const a = details?.assignment;
    if (event.isError || !a?.verified || a.attemptId !== worker.runId) return;
    if (a.state === "completed" && !worker.result) {
      const body = event.content.flatMap(b => b.type === "text" ? [b.text] : []).join("\n");
      const durable = details?.outcome?.outcome;
      const result = durable?.outcome === "succeeded" ? durable.reason : details?.hasFinalAnswer ? body : undefined;
      if (result?.trim()) recordWorker(current, stepId, { ...worker, result });
      else if (details?.hasFinalAnswer === false && !worker.error) recordWorker(current, stepId, { ...worker, error: "The worker finished without returning the required output." });
    }
    if ((a.state === "failed" || a.state === "cancelled") && !worker.error) {
      recordWorker(current, stepId, { ...worker, error: a.reason || a.state });
    }
  });
  return { run, pending, available, restore, setting, loadMode, guidance, clear, dispose: () => { activeContext = undefined; if (typeof unsubscribe === "function") unsubscribe(); } };
}
