import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { setTimeout as delay } from "node:timers/promises";
import type { openSupervisorClient } from "pi-better-subagents/supervisor-client.mjs";
import { scenarioRevision } from "../settings/supervisor.ts";
import { digest, scopeEvidence } from "./evidence.ts";

const ENTRY = "pi-better-harness:supervisor-decision";
type DecisionRecord = { owner: string; proposal: string; outcome: string; status: string; expires?: number; result?: string; successful?: boolean };

export function registerDecisionTool(pi: ExtensionAPI, connect: typeof openSupervisorClient) {
  const field = (description: string) => Type.String({ minLength: 1, maxLength: 200, description });
  pi.registerTool({
    name: "supervisor_request_decision",
    label: "Supervisor decision",
    description: "Ask the user once about a proposed action shared by owners in this trusted workspace. Reuse the same exact proposal when checking back. Apply the normal tool permission checks when acting. Once the covered effect has been checked, record its observed tool result using verifyToolCallId.",
    parameters: Type.Object({
      reference: field("Stable identifier for this proposed change, shared by the affected owners."),
      operation: field("Exact action requiring a decision."), host: field("Exact host or service."),
      verifyToolCallId: Type.Optional(field("Original tool result that verified the authorized effect in this session.")),
      resource: field("Concrete resource affected."), effect: field("Exact side effect to authorize."),
    }),
    async execute(_id, { verifyToolCallId, ...proposal }, abort, _update, ctx) {
      const reply = (status: string) => ({ content: [{ type: "text" as const, text: `Supervisor decision: ${status}` }], details: { status } });
      const setting = scenarioRevision("shared-decisions");
      if (!setting) return reply("disabled");
      const session = ctx.sessionManager.getSessionId();
      const branch = ctx.sessionManager.getBranch();
      const scope = scopeEvidence(branch);
      const revision = scope?.revision;
      if (!scope || !revision || !ctx.isProjectTrusted()) return reply("requires an active Goal in a trusted workspace");
      const current = () => ctx.sessionManager.getSessionId() === session &&
        scopeEvidence(ctx.sessionManager.getBranch())?.revision === revision && scenarioRevision("shared-decisions") === setting;
      const key = digest(JSON.stringify([proposal.reference, proposal.operation, proposal.host, proposal.resource, proposal.effect]));
      const index = branch.map(e => {
        if (e.type !== "custom" || e.customType !== ENTRY) return false;
        const r = e.data as DecisionRecord;
        return r.proposal === key && r.outcome === scope.outcomeId && r.owner === session;
      }).lastIndexOf(true);
      const entry = branch[index];
      const last = entry?.type === "custom" ? entry.data as DecisionRecord : undefined;
      if (verifyToolCallId) {
        if (last?.status !== "approved") return reply("no approved decision in this Goal");
        if (last.result === verifyToolCallId) return reply(last.successful ? "verified" : "verification failed");
        const proof = branch.slice(index + 1).find(e => e.type === "message" && e.message.role === "toolResult" &&
          e.message.toolCallId === verifyToolCallId && !e.message.toolName.startsWith("supervisor_"));
        if (proof?.type !== "message" || proof.message.role !== "toolResult") return reply("missing observed result after approval");
        pi.appendEntry(ENTRY, { ...last, result: verifyToolCallId, successful: !proof.message.isError } satisfies DecisionRecord);
        return reply(proof.message.isError ? "verification failed" : "verified");
      }
      const deadline = AbortSignal.timeout(125_000);
      const signal = abort ? AbortSignal.any([deadline, abort]) : deadline;
      const client = await connect(pi, ctx, signal);
      try {
        let result = await client.decision(ctx.hasUI ? "decision-request" : "decision-query", proposal);
        if (result.status === "ask") {
          const token = result.token;
          const lines = Object.entries(proposal).map(([k, v]) => `${k}: ${v}`);
          const scope = `${lines.join("\n")}\n\nApplies for ${result.durationMinutes} minutes to owners requesting this exact action in ${result.workspace}.`;
          const choice = current() && !signal.aborted ? await ctx.ui.select(scope, ["Approve", "Deny"], { signal, timeout: result.timeoutMs }) : undefined;
          const answer = !current() || signal.aborted || !choice ? "cancelled" : choice === "Approve" ? "approved" : "denied";
          result = await client.decision("decision-answer", proposal, token, answer);
        } else {
          // Other owners wait for this question's answer without opening another dialog.
          while (result.status === "pending" && current() && !signal.aborted) {
            await delay(1500, undefined, { signal });
            result = await client.decision("decision-query", proposal);
          }
        }
        if (!current()) return reply("stale");
        if (result.status === "approved" || result.status === "denied") {
          if (last?.status !== result.status || last.expires !== result.expires)
            pi.appendEntry(ENTRY, { owner: session, proposal: key, outcome: scope.outcomeId, status: result.status, expires: result.expires } satisfies DecisionRecord);
          else if (last.result) return reply(`${result.status} · ${last.successful ? "verified" : "verification failed"}`);
        }
        return reply(result.status);
      } finally { client.close(); }
    },
  });
}
