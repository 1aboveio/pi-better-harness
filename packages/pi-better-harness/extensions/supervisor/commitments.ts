import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { enabledScenarios } from "../settings/supervisor.ts";
import { OUTCOME_ENTRY } from "../task-context/outcome-state.ts";

const ENTRY = "pi-better-harness:supervisor-commitment";
type Status = "accepted" | "attempted" | "failed" | "verified";
type Commitment = { id: string; outcome: string; action: string; verification: string; status: Status;
  evidence?: string; observed?: string; reminder?: number };
type Branch = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;
function outcomeId(branch: Branch) {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i]!;
    if (e.type === "custom" && e.customType === OUTCOME_ENTRY)
      return (e.data as { outcome?: { status?: string } })?.outcome?.status === "active" ? e.id : undefined;
  }
}
function records(branch: Branch) {
  const outcome = outcomeId(branch);
  const items = new Map<string, Commitment>();
  if (!outcome) return items;
  for (const e of branch) {
    if (e.type !== "custom" || e.customType !== ENTRY) continue;
    const item = e.data as Commitment;
    if (item?.outcome === outcome && typeof item.id === "string") items.set(item.id, item);
  }
  return items;
}
function describe(c: Commitment) {
  return [`${c.id} · ${c.status}: ${c.action}`, `Verify: ${c.verification}`, c.observed, c.evidence && `Tool result: ${c.evidence}`,
    c.reminder && `Reminder: ${new Date(c.reminder).toISOString()}`].filter(Boolean).join("\n");
}
export function registerCommitments(pi: ExtensionAPI, onFailure: (ctx: ExtensionContext, evidence: string) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const enabled = () => enabledScenarios().includes("commitment-followup");
  function clear() { clearTimeout(timer); timer = undefined; }
  function schedule(ctx: ExtensionContext) {
    clear();
    if (!enabled()) return;
    const due = [...records(ctx.sessionManager.getBranch()).values()]
      .filter(c => c.status !== "verified" && c.reminder !== undefined).sort((a, b) => a.reminder! - b.reminder!)[0];
    if (!due) return;
    timer = setTimeout(() => {
      if (!enabled()) return;
      const current = records(ctx.sessionManager.getBranch()).get(due.id);
      if (current?.reminder === due.reminder && current?.status !== "verified") {
        pi.appendEntry(ENTRY, { ...current, reminder: undefined });
        pi.sendMessage({ customType: ENTRY, content: describe({ ...due, reminder: undefined }), display: true }, { triggerTurn: false });
      }
      schedule(ctx);
    }, Math.max(0, due.reminder! - Date.now()));
    timer.unref();
  }
  pi.on("session_shutdown", clear);
  pi.on("session_start", (_e, ctx) => schedule(ctx));
  pi.on("session_tree", (_e, ctx) => schedule(ctx));
  pi.on("agent_start", (_e, ctx) => schedule(ctx));
  pi.registerCommand("supervisor-followup", {
    description: "Show recovery commitments, or request one reminder with: remind <id> <minutes>",
    handler: async (args, ctx) => {
      if (!enabled()) return ctx.ui.notify("Commitment follow-up is disabled.", "info");
      const items = records(ctx.sessionManager.getBranch());
      if (!args.trim()) return ctx.ui.notify([...items.values()].map(describe).join("\n\n") || "No recorded recovery commitments.", "info");
      const match = /^remind\s+(\S+)\s+(\d+)$/.exec(args.trim());
      const c = match && items.get(match[1]!);
      const minutes = match && Number(match[2]);
      if (!c || c.status === "verified" || !minutes || minutes > 1440)
        return ctx.ui.notify("Use remind <open commitment id> <1–1440 minutes>.", "warning");
      pi.appendEntry(ENTRY, { ...c, reminder: Date.now() + minutes * 60_000 });
      schedule(ctx);
      ctx.ui.notify(`Reminder scheduled in ${minutes} minutes.`, "info");
    },
  });
  pi.registerTool({
    name: "supervisor_followup", label: "Recovery commitments",
    description: "Record an agreed recovery and its expected verification, or check progress without sending another reminder. Attach the tool call ID for attempts and a separate successful verification. Use status to answer follow-up questions.",
    parameters: Type.Object({
      action: StringEnum(["accept", "attempt", "verify", "status"] as const), id: Type.Optional(Type.String()),
      recovery: Type.Optional(Type.String({ maxLength: 500 })), verification: Type.Optional(Type.String({ maxLength: 500 })),
      toolCallId: Type.Optional(Type.String({ maxLength: 256 })), observation: Type.Optional(Type.String({ maxLength: 500 })),
    }),
    async execute(_id, p, _signal, _update, ctx) {
      const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
      if (!enabled()) return reply("Commitment follow-up is disabled.");
      const branch = ctx.sessionManager.getBranch();
      const outcome = outcomeId(branch);
      if (!outcome) return reply("No active Outcome.");
      const items = records(branch);
      if (p.action === "status" && !p.id) return reply([...items.values()].map(describe).join("\n\n") || "No recorded commitments.");
      if (p.action === "accept") {
        const action = p.recovery?.trim(), verification = p.verification?.trim();
        if (!action || !verification) throw new Error("Supply the recovery action and its verification condition.");
        const existing = [...items.values()].find(c => c.action === action && c.verification === verification && c.status !== "verified");
        if (existing) return reply(describe(existing));
        const c: Commitment = { id: randomUUID(), outcome, status: "accepted", action, verification };
        pi.appendEntry(ENTRY, c);
        return reply(describe(c));
      }
      const c = items.get(p.id ?? "");
      if (!c) throw new Error("Unknown commitment in this Outcome.");
      if (p.action === "status") return reply(describe(c));

      const latest = branch.map(e => e.type === "custom" && e.customType === ENTRY && (e.data as Commitment)?.id === c.id).lastIndexOf(true);
      const evidence = branch.slice(latest + 1).find(e => e.type === "message" && e.message.role === "toolResult" &&
        e.message.toolCallId === p.toolCallId && !e.message.toolName.startsWith("supervisor_"));
      if (c.evidence === p.toolCallId && c.evidence) {
        if (p.action === "verify" && c.status === "attempted") throw new Error("Verification requires a separate observed result.");
        return reply(describe(c));
      }
      if (!evidence || evidence.type !== "message" || evidence.message.role !== "toolResult") throw new Error("Provide a new tool result from this branch after the last commitment update.");
      if (c.status === "verified" || p.action === "verify" && c.status !== "attempted") throw new Error("Record a successful attempt before verification.");
      if (!p.observation?.trim()) throw new Error("Describe what the tool result establishes.");
      const next: Commitment = { ...c, status: evidence.message.isError ? "failed" : p.action === "verify" ? "verified" : "attempted",
        evidence: evidence.message.toolCallId, observed: p.observation.trim() };
      if (next.status === "verified") delete next.reminder;
      pi.appendEntry(ENTRY, next);
      schedule(ctx);
      if (next.status === "failed") onFailure(ctx, JSON.stringify({
        commitment: next.id, failedRecovery: next.action, expected: next.verification, observed: next.observed,
      }));
      return reply(describe(next));
    },
  });
}
