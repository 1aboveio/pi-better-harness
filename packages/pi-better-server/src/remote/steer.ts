import type { Subcommand } from "./context.ts";
import { resolveSession } from "./sessions.ts";

export const command: Subcommand = {
  usage: 'steer [--host <ssh-alias>] <session> "<message>"',
  options: {},
  async run({ positionals }, context) {
    const [ref, ...rest] = positionals;
    const message = rest.join(" ").trim();
    if (!ref || !message) throw new Error('steer needs a session and a message: pi-remote steer <session> "<message>"');
    const client = await context.connect();
    const session = await resolveSession(client, ref);
    const state = await client.call({ type: "get_state", sessionId: session.sessionId });
    const running = (state.data as { isStreaming: boolean }).isStreaming;
    // Mid-turn the message is queued for the next model call; an idle session starts a new turn with it.
    // `streamingBehavior` covers a turn that starts between the state check and the prompt.
    await client.call(
      running
        ? { type: "steer", sessionId: session.sessionId, message }
        : { type: "prompt", sessionId: session.sessionId, message, streamingBehavior: "steer" },
    );
    context.stdout(context.json ? `${JSON.stringify({ sessionId: session.sessionId, delivered: running ? "steer" : "prompt" })}\n` : `${running ? "steered" : "started turn on"} ${session.sessionId.slice(0, 8)}\n`);
    return 0;
  },
};
