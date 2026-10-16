import type { DaemonClient } from "../client.ts";
import type { Subcommand } from "./context.ts";
import { resolveSession } from "./sessions.ts";

/**
 * Deliver text to a session the way a person typing would: queued as steering
 * mid-turn, otherwise as the prompt that starts a turn. Returns which one it was.
 */
export async function deliverMessage(client: DaemonClient, sessionId: string, message: string): Promise<"steer" | "prompt"> {
  const state = await client.call({ type: "get_state", sessionId });
  const running = (state.data as { isStreaming: boolean }).isStreaming;
  // Mid-turn the message is queued for the next model call; an idle session starts a new turn with it.
  // `streamingBehavior` covers a turn that starts between the state check and the prompt.
  const reply = await client.call(running ? { type: "steer", sessionId, message } : { type: "prompt", sessionId, message, streamingBehavior: "steer" });
  // A Codex host says how it delivered (a turn can start or end between the check and the call).
  const said = (reply.data as { delivered?: string } | undefined)?.delivered;
  return said === "steer" || said === "prompt" ? said : running ? "steer" : "prompt";
}

export const command: Subcommand = {
  usage: 'steer [--host <ssh-alias>] <session> "<message>"',
  options: {},
  async run({ positionals }, context) {
    const [ref, ...rest] = positionals;
    const message = rest.join(" ").trim();
    if (!ref || !message) throw new Error('steer needs a session and a message: pi-remote steer <session> "<message>"');
    const client = await context.connect();
    const session = await resolveSession(client, ref);
    const delivered = await deliverMessage(client, session.sessionId, message);
    context.stdout(context.json ? `${JSON.stringify({ sessionId: session.sessionId, delivered })}\n` : `${delivered === "steer" ? "steered" : "started turn on"} ${session.sessionId.slice(0, 8)}\n`);
    return 0;
  },
};
