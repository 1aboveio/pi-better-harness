/**
 * The move protocol, driven from the CLI against two daemons:
 *
 *   source: fence -> export        (source stops accepting commands; nothing else changes)
 *   transfer: read chunk -> write chunk, repeated, over the daemons' own sockets
 *   target: commit                 (verify archive + manifest, rebuild workspace, open session) = acknowledgement
 *   source: retire                 (source records the hand-over and closes the session)
 *
 * Any failure before the target acknowledges unfences the source and aborts the
 * target. If the outcome on the target cannot be learned, the source stays fenced:
 * a stuck fence is recoverable (`pi-remote move --abort`), two live writers are not.
 */
import { randomUUID } from "node:crypto";
import { DEFAULT_CHUNK_BYTES } from "../core/transfer.ts";
import type { CommitAck } from "./service.ts";

/** What the orchestration needs from either end: a daemon connection, or a local stand-in that speaks the same move commands. */
export interface MoveEndpoint {
  call(command: Record<string, unknown>): Promise<{ data?: unknown }>;
  /** The commands that unstick this end when it is left fenced. A daemon uses the `pi-remote move` forms; a local session names its own. */
  recovery?: MoveRecovery;
}

export interface MoveRecovery {
  abort(sessionId: string): string;
  retire(sessionId: string, moveId: string, movedTo?: string): string;
}

const DAEMON_RECOVERY: MoveRecovery = {
  abort: (sessionId) => `pi-remote move --abort ${sessionId}`,
  retire: (sessionId, moveId, movedTo) => `pi-remote move [--host <source>] --retire ${sessionId} --move-id ${moveId}${movedTo ? ` --moved-to ${movedTo}` : ""}`,
};

export interface MoveFaults {
  /** Throw while transferring chunk n (0-based). */
  failAtChunk?: number;
  /** Flip one bit of chunk n on its way to the target. */
  corruptChunk?: number;
}

export interface MoveOptions {
  sessionId: string;
  moveId?: string;
  /** Absolute directory on the target for the workspace. Default: under the target daemon's server dir. */
  toCwd?: string;
  /** Agent-specific: have the target bind the session to this model provider (Codex `--codex-provider`). */
  rebindProvider?: string;
  /** How long to wait for the session to reach a safe boundary (idle). */
  waitMs?: number;
  chunkBytes?: number;
  /** Test hooks; the CLI never sets these. */
  faults?: MoveFaults;
  onProgress?: (message: string) => void;
}

export interface MoveResult extends CommitAck {
  moveId: string;
  from: string;
  archiveBytes: number;
  chunks: number;
  excluded: number;
}

export class MoveError extends Error {
  /** True when the source session is back in service on its original daemon. */
  readonly sourceUnfenced: boolean;
  constructor(message: string, sourceUnfenced: boolean) {
    super(message);
    this.name = "MoveError";
    this.sourceUnfenced = sourceUnfenced;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function moveSession(source: MoveEndpoint, target: MoveEndpoint, options: MoveOptions): Promise<MoveResult> {
  const { sessionId } = options;
  const moveId = options.moveId ?? randomUUID();
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const progress = options.onProgress ?? (() => undefined);
  const recovery = source.recovery ?? DAEMON_RECOVERY;

  const fenced = await source.call({ type: "move_fence", sessionId, moveId, ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}) });
  const from = (fenced.data as { daemonId: string }).daemonId;
  progress(`fenced ${sessionId} on source`);

  let ack: CommitAck | undefined;
  let chunks = 0;
  let archiveBytes = 0;
  let excluded = 0;
  try {
    const exported = (await source.call({ type: "move_export", sessionId, moveId })).data as { size: number; sha256: string; excluded: number };
    archiveBytes = exported.size;
    excluded = exported.excluded;
    progress(`bundled ${exported.size} bytes`);
    await target.call({ type: "move_begin", moveId, sessionId, size: exported.size, sha256: exported.sha256, ...(options.toCwd ? { cwd: options.toCwd } : {}), ...(options.rebindProvider ? { rebindProvider: options.rebindProvider } : {}) });

    for (let offset = 0; offset < exported.size; chunks++) {
      if (options.faults?.failAtChunk === chunks) throw new Error(`injected transfer failure at chunk ${chunks}`);
      const read = (await source.call({ type: "move_read", moveId, offset, length: chunkBytes })).data as { data: string; eof: boolean };
      let data = Buffer.from(read.data, "base64");
      if (data.length === 0) throw new Error("source returned an empty chunk before the end of the archive");
      if (options.faults?.corruptChunk === chunks) data = Buffer.concat([Buffer.from([data[0]! ^ 1]), data.subarray(1)]);
      await target.call({ type: "move_write", moveId, offset, data: data.toString("base64") });
      offset += data.length;
    }
    progress(`transferred ${chunks} chunk(s)`);

    ack = (await target.call({ type: "move_commit", moveId })).data as CommitAck;
  } catch (error) {
    const reason = describe(error);
    // A reply may have been lost after the target committed; its abort answer says which it is.
    let committed: boolean | undefined;
    try {
      committed = ((await target.call({ type: "move_abort", moveId, sessionId })).data as { committed: boolean }).committed;
    } catch {
      committed = undefined;
    }
    if (committed === true) {
      ack = (await target.call({ type: "move_commit", moveId }).catch(() => undefined))?.data as CommitAck | undefined;
      if (!ack) throw new MoveError(`${reason}. The target holds the session but its reply was lost; the source stays fenced. Check the target with \`pi-remote ls\`; once it lists the session, run \`${recovery.retire(sessionId, moveId)}\` to retire the source (do not use --abort: the target owns the session).`, false);
    } else if (committed === false) {
      try {
        await source.call({ type: "move_unfence", sessionId, moveId });
      } catch (unfenceError) {
        throw new MoveError(`${reason}. The source could not be unfenced (${describe(unfenceError)}); run \`${recovery.abort(sessionId)}\`.`, false);
      }
      throw new MoveError(`move failed, source session is unchanged and running: ${reason}`, true);
    } else {
      throw new MoveError(`${reason}. The target could not be reached to learn whether it took the session, so the source stays fenced (no second writer). Once the target is reachable, run \`${recovery.abort(sessionId)}\` on the source if it does not hold the session.`, false);
    }
  }

  progress(`target acknowledged ${ack.sessionId} at ${ack.cwd}`);
  try {
    await source.call({ type: "move_retire", sessionId, moveId, movedTo: ack.daemonId });
  } catch (error) {
    throw new MoveError(`target now owns the session, but retiring the source failed: ${describe(error)}. The source stays fenced. Once it is reachable, run \`${recovery.retire(sessionId, moveId, ack.daemonId)}\` (do not use --abort: the target owns the session).`, false);
  }
  return { ...ack, moveId, from, archiveBytes, chunks, excluded };
}
