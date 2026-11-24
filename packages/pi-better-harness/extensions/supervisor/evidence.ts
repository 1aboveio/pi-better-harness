import { createHash } from "node:crypto";
import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { OUTCOME_ENTRY, type Outcome } from "../task-context/outcome-state.ts";
import { EXTENSION_NAME, type PlanEntry } from "../task-context/types.ts";

export type Scenario = "stall-diagnosis" | "scope-review" | "commitment-followup";
type Branch = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;
export const ENTRY = "pi-better-harness:supervisor-review";
export const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Keep the fingerprint local. File contents and raw tool output never enter a model prompt here. */
export function readFingerprint(event: ToolResultEvent) {
  if (event.isError || !["read", "grep", "find", "ls"].includes(event.toolName)) return;
  const hash = createHash("sha256");
  hash.update(JSON.stringify(event.input));
  for (const block of event.content) {
    if (block.type !== "text" || block.text.length > 64_000) return;
    hash.update(JSON.stringify(block.text));
  }
  return { tool: event.toolName, target: typeof event.input.path === "string" ? event.input.path.slice(-250) : "current workspace", fingerprint: hash.digest("hex") };
}
export class RepeatedRead {
  private last?: { fingerprint: string; since: number; count: number };
  reset() { this.last = undefined; }
  record(value: string, now: number, minimumAge: number) {
    if (this.last?.fingerprint !== value) this.last = { fingerprint: value, since: now, count: 0 };
    this.last.count++;
    if (this.last.count >= 3 && now - this.last.since >= minimumAge) return this.last.since;
  }
}

export function scopeEvidence(branch: Branch) {
  const newest = [...branch].reverse();
  const outcomeEntry = newest.find(entry => entry.type === "custom" && entry.customType === OUTCOME_ENTRY);
  const outcome = outcomeEntry?.type === "custom" && (outcomeEntry.data as { outcome?: Outcome })?.outcome;
  if (!outcome || outcome.status !== "active" || typeof outcome.objective !== "string") return;
  const user = newest.find(entry => entry.type === "message" && entry.message.role === "user");
  const content = user?.type === "message" && user.message.role === "user" ? user.message.content : "";
  const lastInstruction = typeof content === "string" ? content : content.filter(x => x.type === "text").map(x => x.text).join("\n");
  const plan = newest.find(entry => entry.type === "custom" && entry.customType === EXTENSION_NAME &&
    ["set", "clear"].includes((entry.data as PlanEntry | undefined)?.kind ?? ""));
  const data = plan?.type === "custom" ? plan.data as PlanEntry : undefined;
  const steps = data?.kind === "set" && Array.isArray(data.plan?.steps) ? data.plan.steps.slice(0, 50).map(s => ({ id: s.id, step: s.step, status: s.status })) : [];
  return {
    outcomeId: outcomeEntry!.id,
    planId: data?.kind === "set" ? data.plan.planId : undefined,
    revision: [outcomeEntry!.id, user?.id, plan?.id].join("/"),
    objective: outcome.objective.slice(0, 2000),
    doneWhen: outcome.doneWhen?.slice(0, 8).map(s => s.slice(0, 400)),
    boundaries: outcome.boundaries?.slice(0, 8).map(s => s.slice(0, 400)),
    lastInstruction: lastInstruction.slice(-2000), steps,
  };
}
