import type { SessionSummary } from "../protocol.ts";
import type { Subcommand } from "./context.ts";
import { displayStatus, listSessions } from "./sessions.ts";

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/** A failed turn shows its error where the status is, so a thread that cannot run is not mistaken for an idle one. */
function statusCell(session: SessionSummary): string {
  const status = displayStatus(session);
  if (status !== "error" || !session.lastError) return status;
  const oneLine = session.lastError.replace(/\s+/g, " ").trim();
  return `error: ${oneLine.length > 90 ? `${oneLine.slice(0, 89)}…` : oneLine}`;
}

export function formatTable(sessions: SessionSummary[], now = Date.now()): string {
  const rows = [
    ["ID", "STATUS", "LAST ACTIVITY", "BRANCH", "CWD", "NAME"],
    ...sessions.map((s) => [s.sessionId.slice(0, 8), statusCell(s), relativeTime(s.updatedAt, now), s.branch ?? "-", s.cwd, s.name ?? ""]),
  ];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()).join("\n") + "\n";
}

export const command: Subcommand = {
  usage: "ls [--host <ssh-alias>] [--json]",
  options: {},
  async run(_args, context) {
    const sessions = await listSessions(await context.connect());
    if (context.json) {
      context.stdout(`${JSON.stringify(sessions.map((s) => ({ ...s, displayStatus: displayStatus(s) })), null, 2)}\n`);
    } else if (sessions.length === 0) {
      context.stdout("No sessions.\n");
    } else {
      context.stdout(formatTable(sessions));
    }
    return 0;
  },
};
