/**
 * `pi-remote return` for a Codex thread: the move in the other direction. The host that
 * has the thread is the source, this machine's Codex daemon is the target, and the same
 * `moveSession` runs it, so the guarantees are the same ones a move away has: the host
 * keeps the thread fenced until this machine acknowledges it (no half-moved state), and
 * once it has, the host's copy is archived (one live writer).
 */
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DaemonClient } from "../client.ts";
import { moveSession, type MoveResult } from "../move/orchestrate.ts";
import { defaultServerDir, socketPathFor } from "../paths.ts";
import { resolveSession } from "../remote/sessions.ts";
import { readRolloutMeta } from "./rollout.ts";
import { startCodexDaemon, type CodexDaemon } from "./daemon.ts";
import { CodexRuntime, type CodexRuntimeOptions } from "./runtime.ts";

export interface ReturnCodexOptions {
  /** Thread id, unique id prefix or name on the host. */
  ref: string;
  /** Connected client for the host's Codex daemon. */
  host: DaemonClient;
  /** This machine's daemon dir (default: the usual one). */
  serverDir?: string;
  codex?: CodexRuntimeOptions;
  /** Where to rebuild the workspace. Default: where the thread lived before it moved away. */
  toCwd?: string;
  waitMs?: number;
  onProgress?: (message: string) => void;
}

export interface ReturnCodexResult extends MoveResult {
  resumeCommand: string;
}

export function isCodexHost(client: DaemonClient): boolean {
  return client.server?.extensionVersions?.["codex-cli"] !== undefined;
}

/** The local Codex daemon: the one already running in `serverDir`, else one that lives for this command. */
async function localDaemon(serverDir: string, codex: CodexRuntimeOptions | undefined): Promise<{ client: DaemonClient; runtime: CodexRuntime; stop(): Promise<void> }> {
  let started: CodexDaemon | undefined;
  let client: DaemonClient;
  try {
    client = await DaemonClient.connect(socketPathFor(serverDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code && !["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code!)) throw error;
    started = await startCodexDaemon({ serverDir, ...(codex ? { codex } : {}) });
    client = await DaemonClient.connect(started.socketPath);
  }
  if (client.server?.extensionVersions?.["codex-cli"] === undefined) {
    client.close();
    await started?.stop();
    throw new Error(`The daemon in ${serverDir} hosts Pi sessions, not Codex threads. Stop it, or point PI_SERVER_DIR at a Codex daemon dir.`);
  }
  return {
    client,
    runtime: started?.runtime ?? new CodexRuntime(codex),
    async stop() {
      client.close();
      await started?.stop();
    },
  };
}

export async function returnCodexThread(options: ReturnCodexOptions): Promise<ReturnCodexResult> {
  const summary = await resolveSession(options.host, options.ref);
  const serverDir = options.serverDir ?? defaultServerDir();
  const local = await localDaemon(serverDir, options.codex);
  try {
    // Default destination: the original workspace path, read from the tombstone left when the thread moved away.
    let dest = options.toCwd ? resolve(options.toCwd) : undefined;
    if (!dest) {
      const tombstone = local.runtime.archivedRolloutPath(summary.sessionId) ?? local.runtime.rolloutPath(summary.sessionId);
      if (tombstone) dest = readRolloutMeta(tombstone).cwd;
    }
    // Checked before anything is fenced: a busy destination must not cost the host its session.
    if (dest && existsSync(dest) && readdirSync(dest).length > 0) {
      throw new Error(`${dest} already exists and is not empty; pass --to-cwd <empty dir>`);
    }
    options.onProgress?.("preflight passed");
    const result = await moveSession(options.host, local.client, {
      sessionId: summary.sessionId,
      ...(dest ? { toCwd: dest } : {}),
      ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    return { ...result, resumeCommand: `cd ${result.cwd} && codex resume ${result.sessionId}` };
  } finally {
    await local.stop();
  }
}
