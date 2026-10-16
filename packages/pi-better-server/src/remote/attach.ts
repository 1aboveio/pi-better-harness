import { spawn } from "node:child_process";
import type { CompanionInfo } from "../companion.ts";
import type { Subcommand } from "./context.ts";
import { resolveSession } from "./sessions.ts";

/** The local command that shows the companion's terminal: tmux itself, or ssh -t into the host's tmux. */
export function attachCommand(host: string | undefined, attach: string[]): string[] {
  return host ? ["ssh", "-t", "--", host, ...attach.map(shellWord)] : attach;
}

function shellWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./=-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

export const command: Subcommand = {
  usage: "attach [--host <ssh-alias>] [--no-attach] <session>",
  options: { "no-attach": { type: "boolean" } },
  async run({ values, positionals }, context) {
    const ref = positionals[0];
    if (!ref) throw new Error("attach needs a session: pi-remote attach <session>");
    const client = await context.connect();
    const session = await resolveSession(client, ref);
    const started = await client.call({ type: "start_companion", sessionId: session.sessionId });
    const info = started.data as CompanionInfo;
    const argv = attachCommand(context.host, info.attach);
    if (values["no-attach"]) {
      context.stdout(context.json ? `${JSON.stringify({ sessionId: session.sessionId, ...info, command: argv })}\n` : `${argv.join(" ")}\n`);
      return 0;
    }
    // The daemon connection is not needed any more; the terminal talks to the daemon from the host itself.
    await context.close();
    const child = spawn(argv[0]!, argv.slice(1), { stdio: "inherit" });
    return await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
  },
};
