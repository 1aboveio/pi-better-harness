import { returnSession } from "../detach/detach.ts";
import type { Subcommand } from "./context.ts";

export const command: Subcommand = {
  usage: "return --host <ssh-alias> <session> [--to-cwd <empty dir>] [--wait <seconds>]",
  options: {
    "to-cwd": { type: "string" },
    wait: { type: "string" },
  },
  async run({ values, positionals }, context) {
    const ref = positionals[0];
    if (!ref) throw new Error("return needs a session: pi-remote return <session> --host <ssh-alias>");
    const waitSeconds = typeof values.wait === "string" ? Number(values.wait) : undefined;
    if (waitSeconds !== undefined && !(waitSeconds >= 0)) throw new Error("--wait must be a number of seconds");
    const result = await returnSession({
      ref,
      ...(context.host ? { host: context.host } : {}),
      connect: () => context.connect(),
      ...(typeof values["to-cwd"] === "string" ? { toCwd: values["to-cwd"] } : {}),
      ...(waitSeconds !== undefined ? { waitMs: waitSeconds * 1000 } : {}),
      onProgress: (message) => context.stderr(`${message}\n`),
    });
    context.stdout(
      context.json
        ? `${JSON.stringify(result)}\n`
        : `returned ${result.sessionId} to ${result.cwd} (${result.worktreeFiles} files verified); resume with: cd ${result.cwd} && pi --session ${result.sessionFile ?? result.sessionId}\n`,
    );
    return 0;
  },
};
