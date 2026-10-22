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

/** The Pi session methods the transcript gate wraps. A transfer cannot be safe without both. */
const GATED_METHODS = ["_persist", "_rewriteFile"] as const;
type LocalSessionManager = { getSessionId(): string; getSessionFile?(): string | undefined };

/** Call before starting a transfer, while the source is still unfenced. */
export function assertLocalSessionTransferSafe(sessionManager: unknown): void {
  const manager = sessionManager as Record<string, unknown> | null | undefined;
  const missing = GATED_METHODS.filter((method) => typeof manager?.[method] !== "function");
  if (missing.length > 0) {
    throw new Error(
      `Refusing to detach: this Pi no longer has the session methods (${missing.join(", ")}) that keep a moved session from being written here, so the move could not be made safe. This session is unchanged.`,
    );
  }
}

interface ManagerOwnershipGuard {
  departed: Set<string>;
  wrapped: boolean;
}

// Native replacement and separately loaded extension modules must share both gates and latches.
const OWNERSHIP_GUARDS = Symbol.for("pi-better-server.local-ownership-guards.v1");
const shared = globalThis as typeof globalThis & {
  [OWNERSHIP_GUARDS]?: {
    registered: WeakSet<ExtensionAPI>;
    apis: WeakMap<ExtensionAPI, ReturnType<typeof createLocalOwnershipGuard>>;
    managers: WeakMap<LocalSessionManager, ManagerOwnershipGuard>;
  };
};
const ownership = shared[OWNERSHIP_GUARDS] ??= {
  registered: new WeakSet<ExtensionAPI>(),
  apis: new WeakMap<ExtensionAPI, ReturnType<typeof createLocalOwnershipGuard>>(),
  managers: new WeakMap<LocalSessionManager, ManagerOwnershipGuard>(),
};

function managerOwnershipGuard(manager: LocalSessionManager): ManagerOwnershipGuard {
  let state = ownership.managers.get(manager);
  if (!state) {
    state = { departed: new Set<string>(), wrapped: false };
    ownership.managers.set(manager, state);
  }
  return state;
}

function createLocalOwnershipGuard() {
  const markDeparted = (manager: LocalSessionManager, sessionId: string): void => {
    managerOwnershipGuard(manager).departed.add(sessionId);
  };
  const blockedFor = (manager: LocalSessionManager): string | undefined => {
    const sessionId = manager.getSessionId();
    const state = managerOwnershipGuard(manager);
    // A return replaces the record with "owned", but cannot refresh this manager's stale history.
    if (readLocalRecord(localStateDir(), sessionId)?.state === "moved") markDeparted(manager, sessionId);
    const reason = localBlockedReason(localStateDir(), sessionId, manager.getSessionFile?.());
    if (reason) return reason;
    return state.departed.has(sessionId) ? `This session moved away from this Pi process; resume it in a new process with \`pi --session\` after \`pi-remote return ${sessionId}\`.` : undefined;
  };
  const guard = (sessionManager: LocalSessionManager): void => {
    // Capture the manager, never the context: native runtime replacement invalidates contexts.
    const manager = sessionManager as LocalSessionManager & { flushed?: boolean; _persist?: (entry: unknown) => void; _rewriteFile?: () => void };
    blockedFor(manager);
    const state = managerOwnershipGuard(manager);
    if (state.wrapped) return;
    state.wrapped = true;
    const rewrite = typeof manager._rewriteFile === "function" ? manager._rewriteFile : undefined;
    // Dropped entries remain in memory. After a failed move unfences the source, rewrite them
    // before appending again so every on-disk parentId still points to an on-disk entry.
    let dropped = false;
    for (const method of GATED_METHODS) {
      const original = manager[method];
      if (typeof original !== "function") continue;
      (manager as unknown as Record<string, unknown>)[method] = function (this: unknown, ...args: unknown[]) {
        if (blockedFor(manager)) {
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
  return { markDeparted, blockedFor, guard };
}

function localOwnershipGuard(pi: ExtensionAPI) {
  let guard = ownership.apis.get(pi);
  if (!guard) {
    guard = createLocalOwnershipGuard();
    ownership.apis.set(pi, guard);
  }
  return guard;
}

/** Install ownership gates once per API, without registering any commands. */
export function registerLocalOwnershipGuard(pi: ExtensionAPI): void {
  if (ownership.registered.has(pi)) return;
  ownership.registered.add(pi);
  const { guard, blockedFor } = localOwnershipGuard(pi);

  // Extension-triggered turns skip input, so gate agent/tool execution and transcript writes too.
  pi.on("session_start", (_event, ctx) => {
    guard(ctx.sessionManager);
  });

  pi.on("input", (_event, ctx) => {
    const manager = ctx.sessionManager;
    guard(manager);
    const reason = blockedFor(manager);
    if (!reason) return { action: "continue" };
    ctx.ui.notify(reason, "warning");
    return { action: "handled" };
  });

  pi.on("agent_start", (_event, ctx) => {
    const manager = ctx.sessionManager;
    guard(manager);
    if (blockedFor(manager)) ctx.abort();
  });

  pi.on("tool_call", (_event, ctx) => {
    const manager = ctx.sessionManager;
    guard(manager);
    const reason = blockedFor(manager);
    return reason ? { block: true, reason } : undefined;
  });
}

/** Latch acknowledgement on the captured source manager, not a runtime's current manager. Never call for a copy. */
export function markLocalSessionDeparted(pi: ExtensionAPI, sessionId: string, manager: object): void {
  registerLocalOwnershipGuard(pi);
  localOwnershipGuard(pi).markDeparted(manager as LocalSessionManager, sessionId);
}

export interface DetachDeps {
  resolveTarget: typeof resolveTarget;
}

export function registerDetach(pi: ExtensionAPI, deps: DetachDeps = { resolveTarget }): void {
  registerLocalOwnershipGuard(pi);
  pi.registerCommand("detach", {
    description: "Move this session and its workspace to a pi-better-server daemon on <ssh-alias>",
    handler: async (args, ctx) => {
      const manager = ctx.sessionManager;
      localOwnershipGuard(pi).guard(manager);
      let parsed;
      try {
        parsed = parseDetachArgs(args);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }
      try {
        assertLocalSessionTransferSafe(ctx.sessionManager);
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
            target = await deps.resolveTarget({ host: parsed.host, ...(parsed.remoteDir ? { remoteDir: parsed.remoteDir } : {}) });
            return DaemonClient.connect(target.socketPath);
          },
          isBusy: () => !ctx.isIdle(),
          ...(parsed.toCwd ? { toCwd: parsed.toCwd } : {}),
          onProgress: (message) => ctx.ui.notify(message, "info"),
        });
        markLocalSessionDeparted(pi, sessionId, manager);
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
}

export default function (pi: ExtensionAPI): void {
  registerDetach(pi);
}
