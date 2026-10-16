/**
 * Pi extension: `/detach <host>` moves the current local session, with its workspace,
 * into the pi-better-server daemon on <host> and leaves it running there.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DaemonClient } from "../client.ts";
import { PreflightError } from "../move/preflight.ts";
import { MoveError } from "../move/orchestrate.ts";
import { resolveTarget, type Target } from "../remote/target.ts";
import { detachSession } from "./detach.ts";
import { localBlockedReason, localStateDir, readLocalRecord } from "./local-state.ts";

const USAGE = "Usage: /detach <ssh-alias> [--remote-dir <dir>] [--to-cwd <dir>]";

export function parseDetachArgs(args: string): { host: string; remoteDir?: string; toCwd?: string } {
  const words = args.trim().split(/\s+/).filter(Boolean);
  let host: string | undefined;
  let remoteDir: string | undefined;
  let toCwd: string | undefined;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === "--remote-dir") remoteDir = words[++i];
    else if (word === "--to-cwd") toCwd = words[++i];
    else if (word.startsWith("-") || host) throw new Error(USAGE);
    else host = word;
  }
  if (!host) throw new Error(USAGE);
  return { host, ...(remoteDir ? { remoteDir } : {}), ...(toCwd ? { toCwd } : {}) };
}

export default function (pi: ExtensionAPI): void {
  /** Sessions this process has seen leave. A later `return` rewrites the record to "owned", but this process must never write them again. */
  const departed = new Set<string>();
  pi.registerCommand("detach", {
    description: "Move this session and its workspace to a pi-better-server daemon on <ssh-alias>",
    handler: async (args, ctx) => {
      guard(ctx);
      let parsed;
      try {
        parsed = parseDetachArgs(args);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }
      const sessionId = ctx.sessionManager.getSessionId();
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const header = ctx.sessionManager.getHeader();
      const name = ctx.sessionManager.getSessionName();
      let target: Target | undefined;
      try {
        const result = await detachSession({
          session: {
            sessionId,
            cwd: ctx.cwd,
            sessionFile: ctx.sessionManager.getSessionFile(),
            ...(name ? { name } : {}),
            ...(model ? { model } : {}),
            ...(header?.timestamp ? { createdAt: header.timestamp } : {}),
          },
          host: parsed.host,
          connect: async () => {
            target = await resolveTarget({ host: parsed.host, ...(parsed.remoteDir ? { remoteDir: parsed.remoteDir } : {}) });
            return DaemonClient.connect(target.socketPath);
          },
          isBusy: () => !ctx.isIdle(),
          ...(parsed.toCwd ? { toCwd: parsed.toCwd } : {}),
          onProgress: (message) => ctx.ui.notify(message, "info"),
        });
        departed.add(sessionId);
        ctx.ui.notify(
          `Moved to ${parsed.host}: ${result.cwd} (${result.worktreeFiles} files verified). The agent keeps running there.\n` +
            `Follow it:  pi-remote tail ${sessionId} --host ${parsed.host}\n` +
            `Steer it:   pi-remote steer ${sessionId} "<message>" --host ${parsed.host}\n` +
            `Bring it back:  pi-remote return ${sessionId} --host ${parsed.host}  (rebuilds beside the original workspace, which stays as it is)\n` +
            "This Pi process will not run the session again; exit with /quit.",
          "info",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const untouched = error instanceof PreflightError || (error instanceof MoveError && error.sourceUnfenced);
        ctx.ui.notify(untouched ? `${message}\nThis session is unchanged.` : message, "error");
      } finally {
        await target?.close();
      }
    },
  });

  // Once the session is fenced or has left, a second writer here would fork its history. Every turn
  // ends in the session file and the workspace, so the gate sits on those two, not on each caller:
  // extension-triggered turns (sendCustomMessage triggerTurn from background tasks or goals) never
  // emit `input`, and `moved` is latched in memory so a later `return` does not reopen this process.
  const guarded = new WeakSet<object>();
  const blockedFor = (ctx: { sessionManager: { getSessionId(): string } }): string | undefined => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (readLocalRecord(localStateDir(), sessionId)?.state === "moved") departed.add(sessionId);
    const reason = localBlockedReason(localStateDir(), sessionId);
    if (reason) return reason;
    return departed.has(sessionId) ? `This session moved away from this Pi process; resume it in a new process with \`pi --session\` after \`pi-remote return ${sessionId}\`.` : undefined;
  };
  const guard = (ctx: { sessionManager: { getSessionId(): string } }): void => {
    const manager = ctx.sessionManager as unknown as { _persist?: (entry: unknown) => void; _rewriteFile?: () => void };
    if (guarded.has(manager)) return;
    guarded.add(manager);
    for (const method of ["_persist", "_rewriteFile"] as const) {
      const original = manager[method];
      if (typeof original !== "function") continue;
      (manager as Record<string, unknown>)[method] = function (this: unknown, ...args: unknown[]) {
        if (blockedFor(ctx)) return undefined;
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      };
    }
  };

  pi.on("session_start", (_event, ctx) => {
    guard(ctx);
  });

  pi.on("input", (_event, ctx) => {
    guard(ctx);
    const reason = blockedFor(ctx);
    if (!reason) return { action: "continue" };
    ctx.ui.notify(reason, "warning");
    return { action: "handled" };
  });

  pi.on("agent_start", (_event, ctx) => {
    guard(ctx);
    if (blockedFor(ctx)) ctx.abort();
  });

  pi.on("tool_call", (_event, ctx) => {
    guard(ctx);
    const reason = blockedFor(ctx);
    return reason ? { block: true, reason } : undefined;
  });
}
