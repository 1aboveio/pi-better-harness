import type { DaemonClient } from "../client.ts";
import type { Subcommand } from "./context.ts";
import { cursorKey, readCursor, writeCursor } from "./cursors.ts";
import { resolveSession } from "./sessions.ts";

/**
 * How `tail` starts receiving a session's events. Today the daemon pushes live
 * events to the connection that opens the session, so there is nothing to catch
 * up on. The daemon's seq/subscribe protocol (#474) replaces this with a
 * `subscribe { sinceSeq }` that replays what was missed; only this function changes.
 */
export type TailSource = (client: DaemonClient, sessionId: string, sinceSeq: number | undefined) => Promise<void>;

export const liveAttach: TailSource = async (client, sessionId) => {
  await client.call({ type: "open_session", sessionId });
};

/**
 * Turns Pi session events into text for a reader. Stateful: an assistant message
 * prints as it streams, or in full at its end when the provider sent no deltas.
 */
export function createRenderer(): (event: any) => string {
  let streamed = false;
  return (event) => {
    switch (event?.type) {
      case "agent_start":
        return "-- turn started --\n";
      case "agent_end":
        return "\n-- turn ended --\n";
      case "message_start":
        streamed = false;
        return event.message?.role === "user" ? `\n> ${textOf(event.message)}\n` : "";
      case "message_update":
        if (event.assistantMessageEvent?.type !== "text_delta") return "";
        streamed = true;
        return String(event.assistantMessageEvent.delta ?? "");
      case "message_end":
        return event.message?.role === "assistant" && !streamed ? `${textOf(event.message)}\n` : "";
      case "tool_execution_start":
        return `\n[tool ${event.toolName}]\n`;
      default:
        return "";
    }
  };
}

function textOf(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: { type?: string; text?: string }) => (part.type === "text" ? part.text ?? "" : "")).join("");
}

export function createTailCommand(source: TailSource): Subcommand {
  return {
    usage: "tail [--host <ssh-alias>] [--since <seq>] [--json] <session>",
    options: { since: { type: "string" } },
    async run({ values, positionals }, context) {
      const ref = positionals[0];
      if (!ref) throw new Error("tail needs a session: pi-remote tail <session>");
      const client = await context.connect();
      const session = await resolveSession(client, ref);
      const key = cursorKey(context.host, session.sessionId);
      const since = typeof values.since === "string" ? Number(values.since) : readCursor(key);
      if (since !== undefined && !Number.isInteger(since)) throw new Error("--since must be an integer seq");

      const render = createRenderer();
      let lastSeq = since;
      const closed = new Promise<void>((resolve) => client.onClose(resolve));
      const aborted = new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      client.onEvent((message) => {
        if (message.sessionId !== session.sessionId) return;
        if (typeof message.seq === "number") lastSeq = message.seq;
        context.stdout(context.json ? `${JSON.stringify(message)}\n` : render(message.event));
      });
      try {
        await source(client, session.sessionId, since);
        await Promise.race([closed, aborted]);
      } finally {
        if (lastSeq !== undefined) writeCursor(key, lastSeq);
      }
      if (!context.signal.aborted) {
        context.stderr("connection closed by the daemon\n");
        return 1;
      }
      return 0;
    },
  };
}

export const command: Subcommand = createTailCommand(liveAttach);
