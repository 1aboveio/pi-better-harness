import { DaemonClient } from "../client.ts";
import { isCodexHost } from "../codex/return.ts";
import { preflightCodexProvider } from "../codex/preflight.ts";
import { moveSession } from "../move/orchestrate.ts";
import type { Subcommand } from "./context.ts";
import { resolveSession } from "./sessions.ts";
import { resolveTarget, type Target } from "./target.ts";

export const command: Subcommand = {
  usage:
    "move [--host <source-ssh-alias>] <session> --to <ssh-alias> [--to-remote-dir <dir>] [--to-cwd <dir>] [--codex-provider <id>] [--wait <seconds>]\n  pi-remote move [--host <ssh-alias>] --abort <session>\n  pi-remote move [--host <ssh-alias>] --retire <session> --move-id <id> [--moved-to <daemon-id>]",
  options: {
    to: { type: "string" },
    "to-remote-dir": { type: "string" },
    "to-socket": { type: "string" },
    "to-cwd": { type: "string" },
    "codex-provider": { type: "string" },
    wait: { type: "string" },
    abort: { type: "boolean" },
    retire: { type: "boolean" },
    "move-id": { type: "string" },
    "moved-to": { type: "string" },
  },
  async run({ values, positionals }, context) {
    const ref = positionals[0];
    if (!ref) throw new Error("move needs a session: pi-remote move <session> --to <ssh-alias>");
    const source = await context.connect();
    const session = await resolveSession(source, ref);

    if (values.retire === true) {
      // Recovery once the target owns the session and the source is still fenced: finish the hand-over. Never reopens the source.
      if (values.abort === true) throw new Error("--retire and --abort cannot be combined");
      const moveId = values["move-id"];
      if (typeof moveId !== "string") throw new Error("--retire needs --move-id <id> (printed by the failed move)");
      const movedTo = typeof values["moved-to"] === "string" ? values["moved-to"] : "unknown";
      await source.call({ type: "move_retire", sessionId: session.sessionId, moveId, movedTo });
      context.stdout(context.json ? `${JSON.stringify({ sessionId: session.sessionId, retired: true })}\n` : `retired ${session.sessionId} on the source\n`);
      return 0;
    }

    if (values.abort === true) {
      // Operator recovery: give a fenced session back to this daemon. Only safe once the target does not hold it.
      await source.call({ type: "move_unfence", sessionId: session.sessionId });
      context.stdout(context.json ? `${JSON.stringify({ sessionId: session.sessionId, unfenced: true })}\n` : `unfenced ${session.sessionId}\n`);
      return 0;
    }

    const to = values.to;
    const toSocket = values["to-socket"];
    if (typeof to !== "string" && typeof toSocket !== "string") throw new Error("move needs a destination: --to <ssh-alias> (or --to-socket <path> for a daemon on this machine)");
    const waitSeconds = typeof values.wait === "string" ? Number(values.wait) : undefined;
    if (waitSeconds !== undefined && !(waitSeconds >= 0)) throw new Error("--wait must be a number of seconds");
    const toCwd = typeof values["to-cwd"] === "string" ? values["to-cwd"] : undefined;

    let destination: Target | undefined;
    let client: DaemonClient | undefined;
    try {
      if (typeof toSocket === "string") {
        client = await DaemonClient.connect(toSocket);
      } else {
        destination = await resolveTarget({ host: to as string, agent: isCodexHost(source) ? "codex" : "pi", signal: context.signal, ...(typeof values["to-remote-dir"] === "string" ? { remoteDir: values["to-remote-dir"] } : {}) });
        client = await DaemonClient.connect(destination.socketPath);
      }
      const rebindProvider = typeof values["codex-provider"] === "string" ? values["codex-provider"] : undefined;
      if (isCodexHost(source)) await preflightCodexProvider(source, client, session.sessionId, rebindProvider);
      else if (rebindProvider) throw new Error("--codex-provider only applies to Codex threads");
      const result = await moveSession(source, client, {
        sessionId: session.sessionId,
        ...(rebindProvider ? { rebindProvider } : {}),
        ...(toCwd ? { toCwd } : {}),
        ...(waitSeconds !== undefined ? { waitMs: waitSeconds * 1000 } : {}),
        onProgress: (message) => context.stderr(`${message}\n`),
      });
      context.stdout(
        context.json
          ? `${JSON.stringify(result)}\n`
          : `moved ${result.sessionId} to ${to ?? toSocket}:${result.cwd} (${result.worktreeFiles} files verified)\n`,
      );
      return 0;
    } finally {
      client?.close();
      await destination?.close();
    }
  },
};
