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

const shellWord = (word: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

/** The follow-up commands carry `--remote-dir` when the daemon is not in its default dir, so they work as printed. */
export function detachedMessage(sessionId: string, host: string, result: { cwd: string; worktreeFiles: number }, remoteDir?: string): string {
  const where = `--host ${shellWord(host)}${remoteDir ? ` --remote-dir ${shellWord(remoteDir)}` : ""}`;
  return (
    `Moved to ${host}: ${result.cwd} (${result.worktreeFiles} files verified). The agent keeps running there.\n` +
    `Follow it:  pi-remote tail ${sessionId} ${where}\n` +
    `Steer it:   pi-remote steer ${sessionId} "<message>" ${where}\n` +
    `Bring it back:  pi-remote return ${sessionId} ${where}  (rebuilds beside the original workspace, which stays as it is)\n` +
    "This Pi process will not run the session again; exit with /quit."
  );
}

/** The Pi session methods the transcript gate wraps. The gate cannot work without them, so /detach refuses when Pi no longer has them. */
const GATED_METHODS = ["_persist", "_rewriteFile"] as const;

export interface DetachDeps {
  resolveTarget: typeof resolveTarget;
}

export function registerDetach(pi: ExtensionAPI, deps: DetachDeps = { resolveTarget }): void {
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
      const missing = GATED_METHODS.filter((method) => typeof (ctx.sessionManager as unknown as Record<string, unknown>)[method] !== "function");
      if (missing.length > 0) {
        ctx.ui.notify(
          `Refusing to detach: this Pi no longer has the session methods (${missing.join(", ")}) that keep a moved session from being written here, so the move could not be made safe. This session is unchanged.`,
          "error",
        );
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
            target = await deps.resolveTarget({ host: parsed.host, ...(parsed.remoteDir ? { remoteDir: parsed.remoteDir } : {}) });
            return DaemonClient.connect(target.socketPath);
          },
          isBusy: () => !ctx.isIdle(),
          ...(parsed.toCwd ? { toCwd: parsed.toCwd } : {}),
          onProgress: (message) => ctx.ui.notify(message, "info"),
        });
        departed.add(sessionId);
        ctx.ui.notify(detachedMessage(sessionId, parsed.host, result, parsed.remoteDir), "info");
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
    // The manager survives runtime replacement; extension contexts do not.
    const stable = { sessionManager: ctx.sessionManager };
    const manager = stable.sessionManager as unknown as { flushed?: boolean; _persist?: (entry: unknown) => void; _rewriteFile?: () => void };
    if (guarded.has(manager)) return;
    guarded.add(manager);
    const rewrite = typeof manager._rewriteFile === "function" ? manager._rewriteFile : undefined;
    // Writes dropped while blocked leave entries only in memory. If the session is unblocked again (a failed
    // move unfences it), the next append would name those entries as parentId, so the file is rewritten whole first.
    let dropped = false;
    for (const method of GATED_METHODS) {
      const original = manager[method];
      if (typeof original !== "function") continue;
      (manager as Record<string, unknown>)[method] = function (this: unknown, ...args: unknown[]) {
        if (blockedFor(stable)) {
          dropped = true;
          return undefined;
        }
        if (dropped) {
          dropped = false;
          if (rewrite && manager.flushed !== false) return rewrite.call(this);
        }
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

export default function (pi: ExtensionAPI): void {
  registerDetach(pi);
}
