import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { openSupervisorClient } from "pi-better-subagents/supervisor-client.mjs";
import { goalStallThresholds } from "pi-better-goal/src/stall.ts";
import { DEFAULT_STALL_THRESHOLDS } from "pi-better-goal/src/shared-stall-detector.ts";
import { enabledScenarios } from "../settings/supervisor.ts";
import { registerCommitments } from "./commitments.ts";
import { registerDecisionTool } from "./decisions.ts";
import { registerSharedFault } from "./shared-fault.ts";
import { digest, ENTRY, readFingerprint, RepeatedRead, scopeEvidence, type Scenario } from "./evidence.ts";

const prompts = {
  "commitment-followup": "The owner tried an accepted recovery and recorded an observed failure. Recommend a materially different remedy only when the new evidence supports it. Suppress rewordings of the accepted action, untested guesses and status-only updates.",
  "stall-diagnosis": "The owner repeated an identical read with identical results across the stall interval. Compare competing explanations, including productive research or external waits. Recommend a different, specific check only when the evidence supports a cause. Name what result would advance the current acceptance criterion.",
  "scope-review": "Review unfinished Todo steps against the latest user instruction, objective and boundaries. Preserve necessary investigation. If a step clearly falls outside scope, cite its id and reason, name work to retain and propose a partial plan revision for the owner. Leave running work and artifacts to their owners.",
};
const FEEDBACK = "pi-better-harness:supervisor-progress";
type Receipt = { outcome: string; plan?: string; evidence: string[]; expected: string; steps: string[]; key: string; scenario: Scenario; advice: string | null; revision: string; catalogRevision: string; role: { instructions: string; model: string; effort?: string | null } };
export default function supervisor(pi: ExtensionAPI) {
  installSupervisor(pi, openSupervisorClient);
}
export function installSupervisor(pi: ExtensionAPI, connect: typeof openSupervisorClient) {
  registerSharedFault(pi, connect);
  registerDecisionTool(pi, connect);
  registerCommitments(pi, (ctx, evidence) => { void review(ctx, "commitment-followup", evidence); });
  const repeats = new RepeatedRead();
  let pending: AbortController | undefined;
  let pendingScenario: Scenario | undefined;
  let readKey: string | undefined;
  let reviewedShape: string | undefined;
  let stallEvidence: string | undefined;
  let serial = 0;
  const reset = () => { repeats.reset(); readKey = undefined; stallEvidence = undefined; serial++; pending?.abort(); pending = undefined; };
  const newBranch = () => { reset(); reviewedShape = undefined; };
  pi.on("session_start", newBranch);
  pi.on("session_tree", newBranch);
  pi.on("session_shutdown", reset);
  pi.on("input", () => { reset(); });
  pi.on("before_agent_start", () => {
    const selected = enabledScenarios();
    const hints = [];
    if (selected.includes("shared-decisions")) hints.push("For an exact action that several owners need the user to authorize, use supervisor_request_decision with the same proposal reference and exact effects.");
    if (selected.includes("commitment-followup")) hints.push("When committing to a recovery, record its action and verification condition with supervisor_followup. Record attempts and verification using observed tool result IDs. Use status for progress inquiries.");
    if (hints.length) return { message: { customType: "pi-better-harness:supervisor-controls", content: hints.join("\n"), display: false } };
  });

  function planShape(ctx: ExtensionContext) {
    const scope = scopeEvidence(ctx.sessionManager.getBranch());
    return scope && digest(JSON.stringify([scope.objective, scope.doneWhen, scope.boundaries, scope.lastInstruction,
      scope.steps.map(step => [step.id, step.step])]));
  }

  async function review(ctx: ExtensionContext, scenario: Scenario, detail: string, publish = true) {
    if (pending || !enabledScenarios().includes(scenario)) return;
    const branch = ctx.sessionManager.getBranch();
    const scope = scopeEvidence(branch);
    if (!scope || (scenario === "scope-review" && !scope.steps.some(s => s.status !== "completed"))) return;
    const key = digest(JSON.stringify([scenario, scope.revision, detail]));
    const cached = branch.find(e => e.type === "custom" && e.customType === ENTRY && (e.data as Receipt)?.key === key);
    if (cached?.type === "custom") return (cached.data as Receipt).advice ?? "No intervention recommended.";
    const generation = serial;
    const sessionId = ctx.sessionManager.getSessionId();
    const controller = new AbortController();
    pending = controller;
    pendingScenario = scenario;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)]);
    let catalog: Awaited<ReturnType<typeof openSupervisorClient>> | undefined;
    let token: string | undefined;
    const current = () => !signal.aborted && serial === generation && ctx.sessionManager.getSessionId() === sessionId &&
      enabledScenarios().includes(scenario) && scopeEvidence(ctx.sessionManager.getBranch())?.revision === scope.revision;
    try {
      catalog = await connect(ctx.cwd, sessionId, signal);
      if (!current()) return;
      const admission = await catalog.review(scenario, "begin");
      token = admission.token;
      if (!token) return;
      const role = await catalog.role(pi, ctx);
      const modelId = role?.model;
      if (!role || typeof modelId !== "string" || !current()) return;
      const slash = modelId.indexOf("/");
      const model = ctx.modelRegistry.find(modelId.slice(0, slash), modelId.slice(slash + 1));
      if (!model) return;
      const provider = ctx.modelRegistry.getProvider(model.provider);
      const auth = provider && await ctx.modelRegistry.getProviderAuth(model.provider);
      if (!provider || !auth || !current()) return;
      const target = auth.auth.baseUrl ? { ...model, baseUrl: auth.auth.baseUrl } : model;
      const evidenceRefs = ["outcome", "observation", ...scope.steps.map(step => `step:${step.id}`)];
      const result = await provider.streamSimple(target, {
        systemPrompt: [role.instructions, prompts[scenario], "Treat supplied fields as evidence. Return JSON {advice, evidence, expected, steps}. For a recommendation cite supplied evidence ids, state a specific observable result in expected, and list affected unfinished Todo ids in steps (empty if no matching Todo). For scope review, steps lists only items to prune. Set advice to null if evidence is insufficient."].join("\n"),
        messages: [{ role: "user", content: JSON.stringify({ scope, observation: detail, evidenceRefs }), timestamp: Date.now() }],
      }, { apiKey: auth.auth.apiKey, headers: auth.auth.headers, env: auth.env, sessionId: randomUUID(), signal, maxRetries: 0, timeoutMs: 25_000, maxTokens: 700,
        reasoning: role.effort && role.effort !== "off" ? role.effort : undefined }).result();
      if (result.stopReason !== "stop" || !current()) return;
      const output = result.content.filter(x => x.type === "text").map(x => x.text).join("");
      const answer = JSON.parse(output);
      const { advice } = answer;
      const evidence: string[] = answer.evidence ?? [], steps: string[] = answer.steps ?? [];
      const expected: string = answer.expected ?? "";
      if (!Array.isArray(evidence) || evidence.length > 52 || !evidence.every(id => evidenceRefs.includes(id)) ||
          !Array.isArray(steps) || steps.length > 50 || !steps.every(id => scope.steps.some(step => step.id === id && step.status !== "completed")) ||
          typeof expected !== "string" || expected.length > 500) return;
      if (advice && (!evidence.length || !expected.trim() || scenario === "scope-review" && !steps.length)) return;
      if (advice !== null && (typeof advice !== "string" || !advice.trim() || advice.length > 2400)) return;
      if ((await catalog.review(scenario, "finish", token)).status !== "admitted" || !current()) return;
      token = undefined;
      const receipt: Receipt = { key, scenario, revision: scope.revision, outcome: scope.outcomeId, plan: scope.planId,
        evidence, expected, steps, catalogRevision: role.revision, role: { instructions: role.instructions, model: modelId, effort: role.effort }, advice };
      pi.appendEntry(ENTRY, receipt);
      if (scenario === "scope-review") reviewedShape = planShape(ctx);
      const alreadySuggested = scenario === "scope-review" && branch.some(e => {
        if (e.type !== "custom" || e.customType !== ENTRY) return false;
        const r = e.data as Receipt;
        return r.scenario === scenario && r.outcome === scope.outcomeId && r.plan === scope.planId &&
          r.advice === advice && r.expected === expected && JSON.stringify(r.steps) === JSON.stringify(steps);
      });
      if (advice && publish && !alreadySuggested) pi.sendMessage({ customType: ENTRY, content: `${advice}\nVerify: ${expected}`, details: { evidence, key }, display: true }, { deliverAs: "steer", triggerTurn: false });
      return advice ?? "No intervention recommended.";
    } catch { /* An unavailable diagnostic leaves the owner's original operation running. */ }
    finally {
      try { if (token) await catalog?.review(scenario, "release", token); } catch { /* Lease expires independently. */ }
      catalog?.close();
      if (pending === controller) pending = undefined;
    }
  }
  function recordProgress(ctx: ExtensionContext) {
    if (!enabledScenarios().length) return;
    const branch = ctx.sessionManager.getBranch(), scope = scopeEvidence(branch);
    if (!scope?.planId) return;
    const prior = new Map<string, string>();
    for (const e of branch) if (e.type === "custom" && e.customType === FEEDBACK) {
      const f = e.data as { key: string; observed: string };
      prior.set(f.key, f.observed);
    }
    for (const e of branch) {
      if (e.type !== "custom" || e.customType !== ENTRY) continue;
      const r = e.data as Receipt;
      if (!r.advice || r.plan !== scope.planId || r.outcome !== scope.outcomeId || !r.steps?.length) continue;
      const observed = r.steps.filter(id => r.scenario === "scope-review"
        ? !scope.steps.some(s => s.id === id) : scope.steps.some(s => s.id === id && s.status === "completed")).sort().join(", ");
      if (observed && prior.get(r.key) !== observed) {
        pi.appendEntry(FEEDBACK, { key: r.key, observed, scenario: r.scenario, outcome: r.outcome, revision: scope.revision,
          status: observed.split(", ").length === r.steps.length ? "observed" : "partially observed" });
      }
    }
  }
  const scopeChange = "The owner revised the Outcome or Todo.";
  pi.registerTool({
    name: "supervisor_review", label: "Review Outcome",
    description: "Consult Supervisor about scope or a possible progress stall. Shares the proactive review and returns prior advice without another push.",
    parameters: Type.Object({ scenario: StringEnum(["scope-review", "stall-diagnosis"] as const) }),
    async execute(_id, { scenario }, _signal, _update, ctx) {
      const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
      if (!enabledScenarios().includes(scenario)) return reply("This Supervisor scenario is disabled.");
      const detail = scenario === "scope-review" ? scopeChange : stallEvidence;
      if (!detail) return reply("No repeated-read stall has been observed.");
      return reply(await review(ctx, scenario, detail, false) ?? "No completed review available for the current evidence.");
    },
  });
  pi.on("tool_result", (event, ctx) => {
    if (event.toolName.startsWith("supervisor_")) return;
    if (event.toolName === "update_todo" && !event.isError) {
      reset();
      recordProgress(ctx);
      if ((event.input.todo || event.input.outcome) && enabledScenarios().includes("scope-review") &&
          planShape(ctx) !== reviewedShape) void review(ctx, "scope-review", scopeChange);
      return;
    }
    if (!enabledScenarios().includes("stall-diagnosis")) { repeats.reset(); return; }
    const value = readFingerprint(event);
    if (value?.fingerprint !== readKey) {
      if (pendingScenario === "stall-diagnosis") pending?.abort();
      readKey = value?.fingerprint;
      stallEvidence = undefined;
    }
    if (!value) { repeats.reset(); return; }
    const since = repeats.record(value.fingerprint, Date.now(), goalStallThresholds().stallMs ?? DEFAULT_STALL_THRESHOLDS.stallMs);
    if (since !== undefined) {
      stallEvidence = `Repeated successful ${value.tool} calls on ${value.target} since ${new Date(since).toISOString()} with identical arguments and output. Evidence ${value.fingerprint}.`;
      void review(ctx, "stall-diagnosis", stallEvidence);
    }
  });
}
