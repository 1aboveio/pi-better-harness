import type { DaemonClient } from "../client.ts";
import type { SessionSummary } from "../protocol.ts";

export type DisplayStatus = "running" | "idle" | "needs-input" | "closed";

/**
 * `needsInput` is the field the daemon's needs-input tracking (#474) will set on
 * the summary; until then it is absent and sessions read as running or idle.
 */
export function displayStatus(summary: SessionSummary & { needsInput?: boolean }): DisplayStatus {
  if (summary.status === "closed") return "closed";
  if (summary.needsInput) return "needs-input";
  return summary.isStreaming ? "running" : "idle";
}

export async function listSessions(client: DaemonClient): Promise<SessionSummary[]> {
  const response = await client.call({ type: "list_sessions" });
  return (response.data as { sessions: SessionSummary[] }).sessions;
}

/** Find a session by full id, unique id prefix, or exact name. */
export async function resolveSession(client: DaemonClient, ref: string): Promise<SessionSummary> {
  const sessions = await listSessions(client);
  const exact = sessions.find((s) => s.sessionId === ref);
  if (exact) return exact;
  const matches = sessions.filter((s) => s.sessionId.startsWith(ref) || s.name === ref);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`No session matches "${ref}". Run \`pi-remote ls\` to see sessions.`);
  throw new Error(`"${ref}" is ambiguous; it matches ${matches.map((s) => s.sessionId.slice(0, 8)).join(", ")}. Use more of the id.`);
}
