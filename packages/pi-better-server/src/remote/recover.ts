import { recoverLocal } from "../detach/recover.ts";
import { localStateDir } from "../detach/local-state.ts";
import type { Subcommand } from "./context.ts";

export const command: Subcommand = {
  usage: "recover --host <ssh-alias> <session> (--abort | --retire --move-id <id> [--moved-to <daemon-id>])",
  options: {
    abort: { type: "boolean" },
    retire: { type: "boolean" },
    "move-id": { type: "string" },
    "moved-to": { type: "string" },
  },
  async run({ values, positionals }, context) {
    const ref = positionals[0];
    if (!ref) throw new Error("recover needs a session: pi-remote recover <session> --abort|--retire --host <ssh-alias>");
    if ((values.abort === true) === (values.retire === true)) throw new Error("recover needs exactly one of --abort or --retire");
    if (!context.host && typeof values.socket !== "string") throw new Error("recover needs --host <ssh-alias>: the daemon the detach targeted, to check it before changing this machine's record");
    const result = await recoverLocal({
      stateDir: localStateDir(),
      ref,
      action: values.abort === true ? "abort" : "retire",
      ...(typeof values["move-id"] === "string" ? { moveId: values["move-id"] } : {}),
      ...(typeof values["moved-to"] === "string" ? { movedTo: values["moved-to"] } : {}),
      connect: () => context.connect(),
    });
    context.stdout(
      context.json
        ? `${JSON.stringify(result)}\n`
        : result.state === "owned"
          ? `${result.sessionId} is usable on this machine again\n`
          : `${result.sessionId} is recorded as moved; bring it back with: pi-remote return ${result.sessionId} --host ${context.host ?? "<ssh-alias>"}\n`,
    );
    return 0;
  },
};
