import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { setTimeout as delay } from "node:timers/promises";
import { openSupervisorClient } from "pi-better-subagents/supervisor-client.mjs";
import { enabledScenarios } from "../settings/supervisor.ts";
import { scopeEvidence } from "./evidence.ts";

export function registerDecisionTool(pi: ExtensionAPI) {
  const field = (description: string) => Type.String({ minLength: 1, maxLength: 200, description });
  pi.registerTool({
    name: "supervisor_request_decision",
    label: "Supervisor decision",
    description: "Ask the user once about a proposed action shared by owners in this trusted workspace. Reuse the same exact proposal when checking back. Apply the normal tool permission checks when acting.",
    parameters: Type.Object({
      reference: field("Stable identifier for this proposed change, shared by the affected owners."),
      operation: field("Exact action requiring a decision."), host: field("Exact host or service."),
      resource: field("Concrete resource affected."), effect: field("Exact side effect to authorize."),
    }),
    async execute(_id, proposal, abort, _update, ctx) {
      const reply = (status: string) => ({ content: [{ type: "text" as const, text: `Supervisor decision: ${status}` }], details: { status } });
      if (!enabledScenarios().includes("shared-decisions")) return reply("disabled");
      const session = ctx.sessionManager.getSessionId();
      const revision = scopeEvidence(ctx.sessionManager.getBranch())?.revision;
      if (!revision || !ctx.isProjectTrusted()) return reply("requires an active Outcome in a trusted workspace");
      const current = () => ctx.sessionManager.getSessionId() === session &&
        scopeEvidence(ctx.sessionManager.getBranch())?.revision === revision && enabledScenarios().includes("shared-decisions");
      const deadline = AbortSignal.timeout(125_000);
      const signal = abort ? AbortSignal.any([deadline, abort]) : deadline;
      const client = await openSupervisorClient(ctx.cwd, session, signal);
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
        return reply(current() ? result.status : "stale");
      } finally { client.close(); }
    },
  });
}
