import type { DaemonClient } from "../client.ts";
import type { SessionSummary } from "../protocol.ts";

export type DisplayStatus = "running" | "idle" | "needs-input" | "closed" | "moved" | "error";

/** A session with an unanswered extension dialog reads as needs-input, even while its turn is paused mid-stream. */
export function displayStatus(summary: SessionSummary): DisplayStatus {
  if (summary.ownership === "moved") return "moved";
  if (summary.status === "closed") return "closed";
  if (summary.needsInput.length > 0) return "needs-input";
  if (summary.isStreaming) return "running";
  return summary.lastError ? "error" : "idle";
}

export async function listSessions(client: DaemonClient): Promise<SessionSummary[]> {
  const response = await client.call({ type: "list_sessions" });
  return (response.data as { sessions: SessionSummary[] }).sessions;
}

/** The one session-naming rule for every pi-remote subcommand: full id, unique id prefix, or exact name. */
export function matchSession(sessions: SessionSummary[], ref: string): SessionSummary {
  const exact = sessions.find((s) => s.sessionId === ref);
  if (exact) return exact;
  const matches = sessions.filter((s) => s.sessionId.startsWith(ref) || s.name === ref);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`No session matches "${ref}". Run \`pi-remote ls\` to see sessions.`);
  throw new Error(`"${ref}" is ambiguous; it matches ${matches.map((s) => s.sessionId.slice(0, 8)).join(", ")}. Use more of the id.`);
}

/** Find a session by full id, unique id prefix, or exact name. */
export async function resolveSession(client: DaemonClient, ref: string): Promise<SessionSummary> {
  return matchSession(await listSessions(client), ref);
}
