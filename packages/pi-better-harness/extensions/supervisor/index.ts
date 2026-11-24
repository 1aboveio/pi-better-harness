import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model, Context, SimpleStreamOptions, AssistantMessage } from "@earendil-works/pi-ai";
import { openSupervisorClient } from "pi-better-subagents/supervisor-client.mjs";
import { goalStallThresholds } from "pi-better-goal/src/stall.ts";
import { DEFAULT_STALL_THRESHOLDS } from "pi-better-goal/src/shared-stall-detector.ts";
import { enabledScenarios } from "../settings/supervisor.ts";
import { registerCommitments } from "./commitments.ts";
import { registerDecisionTool } from "./decisions.ts";
import { registerSharedFault } from "./shared-fault.ts";
import { digest, ENTRY, readFingerprint, RepeatedRead, scopeEvidence, type Scenario } from "./evidence.ts";

const prompts = {
  "stall-diagnosis": "The owner repeated an identical read with identical results across the stall interval. Compare competing explanations, including productive research or external waits. Recommend a different, specific check only when the evidence supports a cause. Name what result would advance the current acceptance criterion.",
  "scope-review": "Review unfinished Todo steps against the latest user instruction, objective and boundaries. Preserve necessary investigation. If a step clearly falls outside scope, cite its id and reason, name work to retain and propose a partial plan revision for the owner. Leave running work and artifacts to their owners.",
};
type Transport = { streamSimple(model: Model<Api>, context: Context, options: SimpleStreamOptions): { result(): Promise<AssistantMessage> } };
type Receipt = { key: string; scenario: Scenario; advice: string | null; revision: string; catalogRevision: string };
export default function supervisor(pi: ExtensionAPI) {
  installSupervisor(pi, openSupervisorClient);
}
export function installSupervisor(pi: ExtensionAPI, connect: typeof openSupervisorClient) {
  registerSharedFault(pi);
  registerDecisionTool(pi);
  registerCommitments(pi);
  const repeats = new RepeatedRead();
  let pending: AbortController | undefined;
  let pendingScenario: Scenario | undefined;
  let readKey: string | undefined;
  let stallEvidence: string | undefined;
  let serial = 0;
  const reset = () => { repeats.reset(); readKey = undefined; stallEvidence = undefined; serial++; pending?.abort(); pending = undefined; };
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", reset);
  pi.on("input", () => { reset(); });

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
      const role = await catalog.role();
      const modelId = role?.model;
      if (!role || typeof modelId !== "string" || !current()) return;
      const slash = modelId.indexOf("/");
      const model = ctx.modelRegistry.find(modelId.slice(0, slash), modelId.slice(slash + 1));
      const transport = ctx.modelRegistry as typeof ctx.modelRegistry & Partial<Transport>;
      if (!model || !transport.streamSimple) return;
      const result = await transport.streamSimple(model, {
        systemPrompt: [role.instructions, prompts[scenario], "Treat supplied fields as evidence. Return JSON with advice as a concise recommendation in the owner's language, or null for insufficient evidence."].join("\n"),
        messages: [{ role: "user", content: JSON.stringify({ scope, observation: detail }), timestamp: Date.now() }],
      }, { sessionId: randomUUID(), signal, maxRetries: 0, timeoutMs: 25_000, maxTokens: 700,
        reasoning: role.effort && role.effort !== "off" ? role.effort : undefined }).result();
      if (result.stopReason !== "stop" || !current()) return;
      const output = result.content.filter(x => x.type === "text").map(x => x.text).join("");
      const { advice } = JSON.parse(output);
      if (advice !== null && (typeof advice !== "string" || !advice.trim() || advice.length > 2400)) return;
      if ((await catalog.review(scenario, "finish", token)).status !== "admitted" || !current()) return;
      token = undefined;
      pi.appendEntry(ENTRY, { key, scenario, revision: scope.revision, catalogRevision: role.revision, advice } satisfies Receipt);
      if (advice && publish) pi.sendMessage({ customType: ENTRY, content: advice, display: true }, { deliverAs: "steer", triggerTurn: false });
      return advice ?? "No intervention recommended.";
    } catch { /* An unavailable diagnostic leaves the owner's original operation running. */ }
    finally {
      try { if (token) await catalog?.review(scenario, "release", token); } catch { /* Lease expires independently. */ }
      catalog?.close();
      if (pending === controller) pending = undefined;
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
      if (event.input.todo || event.input.outcome) void review(ctx, "scope-review", scopeChange);
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
      stallEvidence = `Repeated successful ${value.tool} calls since ${new Date(since).toISOString()} with identical arguments and output. Evidence ${value.fingerprint}.`;
      void review(ctx, "stall-diagnosis", stallEvidence);
    }
  });
}
