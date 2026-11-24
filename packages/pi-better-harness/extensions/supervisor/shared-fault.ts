import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { openSupervisorClient } from "pi-better-subagents/supervisor-client.mjs";
import { scenarioRevision } from "../settings/supervisor.ts";
import { digest, scopeEvidence } from "./evidence.ts";

const ENTRY = "pi-better-harness:shared-read-fault";
const readers = new Set(["bg_task_status", "bg_task_log", "bg_task_list", "bg_task_wait_list", "subagent_status", "subagent_list", "subagent_result"]);
type Row = { operation: string; revision: string; incident: string; state: "open" | "verified"; text: string };
export function matchReadFailure(event: ToolResultEvent) {
  return event.isError && event.content.some(b => b.type === "text" && /^(?:Error: )?(?:runtime-unhealthy: runtime_get_snapshot timed out|Runtime scope is still rebuilding; retry the observation\.|runtime-unhealthy: read worker (?:exited|failed|unresponsive)[^\n]*)$/.test(b.text.trim()));
}
export function registerSharedFault(pi: ExtensionAPI, connect: typeof openSupervisorClient) {
  const inFlight = new Map<string, AbortController>();
  const cancel = () => { for (const c of inFlight.values()) c.abort(); inFlight.clear(); };
  pi.on("session_tree", cancel);
  pi.on("session_shutdown", cancel);
  pi.on("input", () => { cancel(); });
  async function observe(ctx: ExtensionContext, event: ToolResultEvent) {
    if (!readers.has(event.toolName)) return;
    const setting = scenarioRevision("shared-fault");
    if (!setting) return;
    const branch = ctx.sessionManager.getBranch();
    const scope = scopeEvidence(branch);
    if (!scope) return;
    const operation = digest(JSON.stringify([event.toolName, event.input]));
    const last = [...branch].reverse().find(e => e.type === "custom" && e.customType === ENTRY &&
      (e.data as Row)?.operation === operation && (e.data as Row)?.revision === scope.revision);
    const row = last?.type === "custom" ? last.data as Row : undefined;
    const session = ctx.sessionManager.getSessionId();
    const flight = [session, scope.revision, operation].join("/");
    if (!matchReadFailure(event)) {
      if (!event.isError) {
        inFlight.get(flight)?.abort();
        if (row?.state === "open") {
          pi.appendEntry(ENTRY, { ...row, state: "verified", text: `Verified by successful ${event.toolName} for the original input.` } satisfies Row);
          const reporter = await connect(pi, ctx, AbortSignal.timeout(5000));
          try { await reporter.sharedReadDiagnosis(row.incident); } finally { reporter.close(); }
        }
      }
      return;
    }
    if (inFlight.has(flight) || inFlight.size >= 2) return;
    const controller = new AbortController();
    inFlight.set(flight, controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(7000)]);
    let client: Awaited<ReturnType<typeof openSupervisorClient>> | undefined;
    try {
      client = await connect(pi, ctx, signal);
      const { incident } = await client.sharedReadDiagnosis();
      if (!incident || signal.aborted || scenarioRevision("shared-fault") !== setting ||
          ctx.sessionManager.getSessionId() !== session || scopeEvidence(ctx.sessionManager.getBranch())?.revision !== scope.revision ||
          row?.state === "open" && row.incident === incident.id) return;
      const text = `${event.toolName}: ${incident.recommendation}`;
      pi.appendEntry(ENTRY, { operation, revision: scope.revision, incident: incident.id, state: "open", text } satisfies Row);
      pi.sendMessage({ customType: ENTRY, content: text, display: true }, { deliverAs: "steer", triggerTurn: false });
    } finally {
      client?.close();
      if (inFlight.get(flight) === controller) inFlight.delete(flight);
    }
  }
  pi.on("tool_result", (event, ctx) => { void observe(ctx, event).catch(() => {}); });
}
