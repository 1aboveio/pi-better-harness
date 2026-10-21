/**
 * /detach and `pi-remote return`: the two directions of moving a plain local Pi
 * session. Both are the shared `moveSession` with one end replaced by this machine
 * (LocalSource / LocalSink), preceded by a preflight that runs before anything is fenced.
 */
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { DaemonClient } from "../client.ts";
import { assertExistingDirectory } from "../core/adapter.ts";
import { assertTransferCapabilities, moveSession, type MoveResult } from "../move/orchestrate.ts";
import { checkProviderAuth } from "../move/auth.ts";
import { assertChecks, connectChecked, estimateBundleBytes, isGithubRemote, repoRemoteOf, runChecks, type CheckResult } from "../move/preflight.ts";
import { resolveSession } from "../remote/sessions.ts";
import { LocalSink, type LocalCommitAck } from "./local-sink.ts";
import { LocalSource, type LocalSessionInfo } from "./local-source.ts";
import { localStateDir, readLocalRecord } from "./local-state.ts";

export interface DetachOptions {
  session: LocalSessionInfo;
  /** Name the user gave for the destination (ssh alias); recorded for `return` and notices. */
  host: string;
  connect: () => Promise<DaemonClient>;
  /** Include prompt preflight, bash, background work and pending input/dialogs, not just model streaming. */
  isBusy: () => boolean;
  stateDir?: string;
  toCwd?: string;
  copy?: boolean;
  includeWorkspace?: boolean;
  compression?: "gzip" | "none";
  waitMs?: number;
  onProgress?: (message: string) => void;
}

export async function detachSession(options: DetachOptions): Promise<MoveResult> {
  const { session, host } = options;
  const stateDir = options.stateDir ?? localStateDir();
  const client = await connectChecked(options.connect, host);
  try {
    assertTransferCapabilities(client.server, options);
    if (options.includeWorkspace === false && (!options.toCwd || !options.toCwd.startsWith("/"))) throw new Error("Session-only transfer requires an existing absolute destination directory (toCwd)");
    const repoRemote = options.includeWorkspace === false ? undefined : repoRemoteOf(session.cwd);
    const preflight = await client.call({
      type: "move_preflight",
      ...(session.model ? { model: session.model } : {}),
      ...(repoRemote ? { repoRemote, requireGh: isGithubRemote(repoRemote) } : {}),
      ...(options.includeWorkspace !== undefined ? { includeWorkspace: options.includeWorkspace } : {}),
      ...(options.includeWorkspace === false ? {} : { bytes: estimateBundleBytes(session.cwd) }),
      ...(options.toCwd ? { dir: options.toCwd } : {}),
    });
    assertChecks((preflight.data as { checks: CheckResult[] }).checks);
    options.onProgress?.("preflight passed");
    const source = new LocalSource({ session, stateDir, isBusy: options.isBusy, host });
    return await moveSession(source, client, {
      sessionId: session.sessionId,
      ...(options.copy !== undefined ? { copy: options.copy } : {}),
      ...(options.includeWorkspace !== undefined ? { includeWorkspace: options.includeWorkspace } : {}),
      ...(options.compression !== undefined ? { compression: options.compression } : {}),
      ...(options.toCwd ? { toCwd: options.toCwd } : {}),
      ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
  } finally {
    client.close();
  }
}

export interface ReturnOptions {
  /** Session id, unique id prefix or name on the daemon. */
  ref: string;
  host?: string;
  connect: () => Promise<DaemonClient>;
  stateDir?: string;
  /** Known custom local transcript storage, outside normal SDK discovery. */
  sessionDirs?: readonly string[];
  sessionFiles?: readonly string[];
  /** Existing absolute directory for session-only; new/empty workspace directory otherwise. */
  toCwd?: string;
  copy?: boolean;
  includeWorkspace?: boolean;
  compression?: "gzip" | "none";
  waitMs?: number;
  onProgress?: (message: string) => void;
}

export interface ReturnResult extends MoveResult {
  sessionFile: string;
}

/**
 * The workspace is rebuilt from the bundle and needs an empty directory. /detach leaves the original
 * workspace in place, so when it is still there the session comes back beside it instead of over it:
 * nothing in the original is touched or guessed about.
 */
function defaultReturnDir(original: string | undefined, fallback: string, onProgress?: (message: string) => void): string {
  if (!original) return fallback;
  if (!existsSync(original) || readdirSync(original).length === 0) return original;
  for (let n = 1; ; n++) {
    const candidate = join(dirname(original), `${basename(original)}-returned${n === 1 ? "" : `-${n}`}`);
    if (!existsSync(candidate)) {
      onProgress?.(`the original workspace ${original} still exists and is left untouched; returning into ${candidate}`);
      return candidate;
    }
  }
}

export async function returnSession(options: ReturnOptions): Promise<ReturnResult> {
  const stateDir = options.stateDir ?? localStateDir();
  const client = await connectChecked(options.connect, options.host);
  try {
    assertTransferCapabilities(client.server, options);
    if (options.includeWorkspace === false) assertExistingDirectory(options.toCwd);
    const summary = await resolveSession(client, options.ref);
    const described = await client.call({ type: "move_preflight", sessionId: summary.sessionId, ...(options.includeWorkspace !== undefined ? { includeWorkspace: options.includeWorkspace } : {}) });
    const info = (described.data as { session: { cwdName: string; model?: string; repoRemote?: string; bytes?: number } }).session;
    const dest = resolve(options.toCwd ?? defaultReturnDir(readLocalRecord(stateDir, summary.sessionId)?.cwd, join(process.cwd(), info.cwdName), options.onProgress));

    const checks: CheckResult[] = [];
    if (options.includeWorkspace !== false && existsSync(dest) && readdirSync(dest).length > 0) {
      checks.push({ name: "workspace", ok: false, detail: `${dest} already exists and is not empty; pass --to-cwd <empty dir>` });
    }
    checks.push(
      ...(await runChecks(
        {
          ...(info.model ? { model: info.model } : {}),
          ...(options.includeWorkspace !== false && info.repoRemote ? { repoRemote: info.repoRemote, requireGh: isGithubRemote(info.repoRemote) } : {}),
          ...(options.includeWorkspace === false || info.bytes === undefined ? {} : { bytes: info.bytes }),
          dir: dest,
        },
        { serverDir: stateDir, providerAuth: (provider) => checkProviderAuth(provider, process.cwd()) },
      )),
    );
    assertChecks(checks);
    options.onProgress?.("preflight passed");

    const result = await moveSession(client, new LocalSink({ stateDir, cwd: dest, sessionDirs: options.sessionDirs, sessionFiles: options.sessionFiles }), {
      sessionId: summary.sessionId,
      toCwd: dest,
      ...(options.copy !== undefined ? { copy: options.copy } : {}),
      ...(options.includeWorkspace !== undefined ? { includeWorkspace: options.includeWorkspace } : {}),
      ...(options.compression !== undefined ? { compression: options.compression } : {}),
      ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    return result as ReturnResult;
  } finally {
    client.close();
  }
}

export type { LocalCommitAck };
