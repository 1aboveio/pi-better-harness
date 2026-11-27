/** Shared handoff/copy orchestration over the existing move commands. */
import { randomUUID } from "node:crypto";
import { DEFAULT_CHUNK_BYTES } from "../core/transfer.ts";
import type { CommitAck } from "./service.ts";
import type { HelloData } from "../protocol.ts";

export interface MoveEndpoint {
  call(command: Record<string, unknown>): Promise<{ data?: unknown }>;
  server?: HelloData | undefined;
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
  failAtChunk?: number;
  corruptChunk?: number;
}

export interface MoveOptions {
  sessionId: string;
  moveId?: string;
  toCwd?: string;
  rebindProvider?: string;
  copy?: boolean;
  /** Defaults to true for existing move/detach/return callers. */
  includeWorkspace?: boolean;
  compression?: "gzip" | "none";
  waitMs?: number;
  chunkBytes?: number;
  faults?: MoveFaults;
  onProgress?: (message: string) => void;
}

export interface MoveResult extends CommitAck {
  moveId: string;
  sourceId: string;
  destinationId: string;
  sourceUnfenced: boolean;
  from: string;
  archiveBytes: number;
  chunks: number;
  excluded: number;
}

export class MoveError extends Error {
  readonly sourceUnfenced: boolean;
  readonly sourceId?: string;
  readonly destinationId?: string;
  readonly moveId?: string;
  readonly targetOutcome?: "committed" | "not-committed" | "unknown";
  constructor(message: string, sourceUnfenced: boolean, transfer?: { sourceId: string; destinationId: string; moveId: string; targetOutcome: "committed" | "not-committed" | "unknown" }) {
    super(message);
    this.name = "MoveError";
    this.sourceUnfenced = sourceUnfenced;
    if (transfer) Object.assign(this, transfer);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** New transfer choices must never silently become an old daemon's full-workspace move. */
export function assertTransferCapabilities(server: HelloData | undefined, options: Pick<MoveOptions, "copy" | "includeWorkspace" | "compression">): void {
  if (options.copy === undefined && options.includeWorkspace === undefined && options.compression === undefined) return;
  const required = ["session-transfer-v1", ...(options.compression === "gzip" ? ["compressed-bundle-v1"] : [])];
  const missing = required.filter((capability) => !server?.capabilities?.includes(capability));
  if (missing.length) throw new Error(`Daemon lacks ${missing.join(", ")}; update it before transferring. Nothing was fenced.`);
}

export async function moveSession(source: MoveEndpoint, target: MoveEndpoint, options: MoveOptions): Promise<MoveResult> {
  const { sessionId } = options;
  const copy = options.copy ?? false;
  const destinationId = copy ? randomUUID() : sessionId;
  const moveId = options.moveId ?? randomUUID();
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) throw new Error("chunkBytes must be a positive integer");
  if (options.includeWorkspace === false && (!options.toCwd || !options.toCwd.startsWith("/"))) {
    throw new Error("Session-only transfer requires an existing absolute destination directory (toCwd)");
  }
  if (source.server) assertTransferCapabilities(source.server, options);
  if (target.server) assertTransferCapabilities(target.server, options);
  const progress = options.onProgress ?? (() => undefined);
  const recovery = source.recovery ?? DAEMON_RECOVERY;
  const errorInfo = (targetOutcome: "committed" | "not-committed" | "unknown") => ({ sourceId: sessionId, destinationId, moveId, targetOutcome });

  const fenced = await source.call({ type: "move_fence", sessionId, moveId, ...(options.waitMs !== undefined || copy ? { waitMs: options.waitMs ?? 0 } : {}) });
  const from = (fenced.data as { daemonId: string }).daemonId;
  let ack: CommitAck | undefined;
  let chunks = 0;
  let archiveBytes = 0;
  let excluded = 0;
  try {
    progress(`fenced ${sessionId} on source`);
    const exported = (await source.call({ type: "move_export", sessionId, moveId,
      ...(options.includeWorkspace !== undefined ? { includeWorkspace: options.includeWorkspace } : {}),
      ...(options.compression !== undefined ? { compression: options.compression } : {}),
    })).data as { size: number; sha256: string; excluded: number };
    archiveBytes = exported.size;
    excluded = exported.excluded;
    progress(`bundled ${exported.size} bytes`);
    await target.call({ type: "move_begin", moveId, sessionId: destinationId, ...(copy ? { copy: true, sourceSessionId: sessionId } : {}),
      ...(options.includeWorkspace !== undefined ? { includeWorkspace: options.includeWorkspace } : {}),
      size: exported.size, sha256: exported.sha256, ...(options.toCwd ? { cwd: options.toCwd } : {}), ...(options.rebindProvider ? { rebindProvider: options.rebindProvider } : {}) });

    for (let offset = 0; offset < exported.size; chunks++) {
      if (options.faults?.failAtChunk === chunks) throw new Error(`injected transfer failure at chunk ${chunks}`);
      const read = (await source.call({ type: "move_read", moveId, offset, length: chunkBytes })).data as { data: string; eof: boolean };
      let data = Buffer.from(read.data, "base64");
      if (data.length === 0 || data.length > exported.size - offset) throw new Error("source returned an invalid chunk length");
      if (options.faults?.corruptChunk === chunks) data = Buffer.concat([Buffer.from([data[0]! ^ 1]), data.subarray(1)]);
      await target.call({ type: "move_write", moveId, offset, data: data.toString("base64") });
      offset += data.length;
    }
    progress(`transferred ${chunks} chunk(s)`);
    ack = (await target.call({ type: "move_commit", moveId })).data as CommitAck;
    if (!ack || ack.sessionId !== destinationId || ack.verified !== true) throw new Error("Invalid target acknowledgement");
  } catch (error) {
    const reason = describe(error);
    let committed: boolean | undefined;
    try {
      committed = ((await target.call({ type: "move_abort", moveId, sessionId: destinationId })).data as { committed: boolean }).committed;
    } catch {
      committed = undefined;
    }
    if (committed === true) {
      const retry = (await target.call({ type: "move_commit", moveId }).catch(() => undefined))?.data as CommitAck | undefined;
      ack = retry?.sessionId === destinationId && retry.verified === true ? retry : undefined;
    }
    if (!ack || committed !== true) {
      const outcome = committed === true ? "committed" : committed === false ? "not-committed" : "unknown";
      if (copy || committed === false) {
        try {
          await source.call({ type: "move_unfence", sessionId, moveId });
        } catch (unfenceError) {
          throw new MoveError(`${reason}. The source could not be unfenced (${describe(unfenceError)}); run \`${recovery.abort(sessionId)}\`. Destination ${destinationId}, move ${moveId}: ${outcome}.`, false, errorInfo(outcome));
        }
        if (committed === false) throw new MoveError(`move failed, source session is unchanged and running: ${reason}`, true, errorInfo(outcome));
        throw new MoveError(`Partial copy: ${reason}. Source ${sessionId} is running. Destination ${destinationId} ${committed === true ? "holds" : "may hold"} the independent copy (move ${moveId}); check the target before retrying.`, true, errorInfo(outcome));
      }
      if (committed === true) throw new MoveError(`${reason}. The target holds the session but its reply was lost; the source stays fenced. Check the target with \`pi-remote ls\`; once it lists the session, run \`${recovery.retire(sessionId, moveId)}\` to retire the source (do not use --abort: the target owns the session).`, false, errorInfo(outcome));
      throw new MoveError(`${reason}. The target could not be reached to learn whether it took the session, so the source stays fenced (no second writer). Once the target is reachable, run \`${recovery.abort(sessionId)}\` on the source if it does not hold the session.`, false, errorInfo(outcome));
    }
  }

  try {
    await source.call(copy ? { type: "move_unfence", sessionId, moveId } : { type: "move_retire", sessionId, moveId, movedTo: ack.daemonId });
  } catch (error) {
    const instruction = copy ? recovery.abort(sessionId) : recovery.retire(sessionId, moveId, ack.daemonId);
    throw new MoveError(`target now owns the session, but ${copy ? "unfencing" : "retiring"} the source failed: ${describe(error)}. The source stays fenced. Once it is reachable, run \`${instruction}\`${copy ? "." : " (do not use --abort: the target owns the session)."}`, false, errorInfo("committed"));
  }
  progress(`target acknowledged ${ack.sessionId} at ${ack.cwd}`);
  return { ...ack, moveId, sourceId: sessionId, destinationId, sourceUnfenced: copy, from, archiveBytes, chunks, excluded };
}
