/**
 * A live local Pi session as the source end of a move: it answers the same
 * move_fence / export / read / retire / unfence commands a daemon does, so the
 * shared `moveSession` orchestration (and its failure handling) drives /detach
 * unchanged. Ownership lives in a small record next to Pi's own state instead of
 * a daemon's ownership.json.
 */
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { createBundle, sha256File } from "../core/bundle.ts";
import { readChunk } from "../core/transfer.ts";
import { SERVER_EXTENSION_VERSIONS } from "../handshake.ts";
import type { MoveEndpoint, MoveRecovery } from "../move/orchestrate.ts";
import { localBlockedReason, localDaemonId, localRecovery, movesDir, readLocalRecord, removeMoveDir, writeLocalRecord } from "./local-state.ts";

export interface LocalSessionInfo {
  sessionId: string;
  cwd: string;
  sessionFile: string | undefined;
  name?: string;
  /** `provider/modelId` */
  model?: string;
  createdAt?: string;
}

export interface LocalSourceOptions {
  session: LocalSessionInfo;
  stateDir: string;
  /** True while a turn is running or starting. */
  isBusy(): boolean;
  /** The user-facing name of the destination, recorded so `return` and the notice can name it. */
  host?: string;
}

const MAX_READ_BYTES = 4 * 1024 * 1024;

export class LocalSource implements MoveEndpoint {
  private readonly options: LocalSourceOptions;

  readonly recovery: MoveRecovery;

  constructor(options: LocalSourceOptions) {
    this.options = options;
    this.recovery = localRecovery(options.host);
  }

  async call(command: Record<string, unknown>): Promise<{ data?: unknown }> {
    const moveId = command.moveId as string | undefined;
    if (moveId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/.test(moveId)) throw new Error("Invalid moveId");
    if (command.sessionId !== undefined && command.sessionId !== this.options.session.sessionId) throw new Error("Source sessionId does not match the local session");
    switch (command.type) {
      case "move_fence":
        return { data: await this.fence(moveId!, typeof command.waitMs === "number" ? command.waitMs : 30_000) };
      case "move_export":
        return { data: this.export(moveId!, command.includeWorkspace as boolean | undefined, command.compression as "gzip" | "none" | undefined) };
      case "move_read": {
        const file = join(movesDir(this.options.stateDir), moveId!, "bundle.tar");
        if (!existsSync(file)) throw new Error(`No exported bundle for move ${moveId}`);
        const { data, eof } = readChunk(file, command.offset as number, Math.min(command.length as number, MAX_READ_BYTES));
        return { data: { data: data.toString("base64"), eof } };
      }
      case "move_retire": {
        const { session, stateDir } = this.options;
        const record = readLocalRecord(stateDir, session.sessionId);
        if (record?.state === "moved" && record.moveId === moveId) return { data: {} };
        if (record?.state !== "fenced" || record.moveId !== moveId) throw new Error(`Session ${session.sessionId} is not fenced by move ${moveId}`);
        writeLocalRecord(stateDir, { ...record, state: "moved", movedTo: command.movedTo as string });
        removeMoveDir(stateDir, moveId!);
        return { data: {} };
      }
      case "move_unfence": {
        const { session, stateDir } = this.options;
        const record = readLocalRecord(stateDir, session.sessionId);
        if (record?.state !== "fenced") throw new Error(`Session ${session.sessionId} is not fenced`);
        if (moveId && record.moveId !== moveId) throw new Error(`Session ${session.sessionId} is fenced by another move`);
        const { moveId: fencedBy, ...rest } = record;
        writeLocalRecord(stateDir, { ...rest, state: "owned" });
        if (fencedBy) removeMoveDir(stateDir, fencedBy);
        return { data: {} };
      }
      default:
        throw new Error(`A local session cannot handle ${String(command.type)}`);
    }
  }

  private async fence(moveId: string, waitMs: number): Promise<{ daemonId: string; epoch: number }> {
    const { session, stateDir, isBusy } = this.options;
    const previous = readLocalRecord(stateDir, session.sessionId);
    if (previous && previous.state !== "owned") throw new Error(`Session ${session.sessionId} is ${previous.state === "moved" ? `already on ${previous.host ?? previous.movedTo ?? "a daemon"}` : "already being detached"}`);
    const deadline = Date.now() + waitMs;
    while (isBusy()) {
      if (Date.now() >= deadline) throw new Error("The session is mid-turn; wait for it to finish (or press Esc) and retry");
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    const settled = readLocalRecord(stateDir, session.sessionId);
    if (settled && settled.state !== "owned") throw new Error(`Session ${session.sessionId} is already fenced or moved`);
    const reason = localBlockedReason(stateDir, session.sessionId, session.sessionFile);
    if (reason) throw new Error(reason);
    const epoch = settled?.epoch ?? 0;
    writeLocalRecord(stateDir, { sessionId: session.sessionId, sessionFile: session.sessionFile, state: "fenced", epoch, moveId, cwd: session.cwd, ...(this.options.host ? { host: this.options.host } : {}) });
    return { daemonId: localDaemonId(), epoch };
  }

  private export(moveId: string, includeWorkspace?: boolean, compression?: "gzip" | "none"): { size: number; sha256: string; files: number; worktreeFiles: number; excluded: number } {
    const { session, stateDir } = this.options;
    const record = readLocalRecord(stateDir, session.sessionId);
    if (record?.state !== "fenced" || record.moveId !== moveId) throw new Error(`Session ${session.sessionId} is not fenced by move ${moveId}`);
    const dir = join(movesDir(stateDir), moveId);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const outFile = join(dir, "bundle.tar");
    const hasTranscript = session.sessionFile !== undefined && existsSync(session.sessionFile);
    const manifest = createBundle({
      ...(includeWorkspace !== undefined ? { includeWorkspace } : {}),
      ...(compression !== undefined ? { compression } : {}),
      cwd: session.cwd,
      outFile,
      agent: { kind: "pi", version: PI_VERSION, extensions: { ...SERVER_EXTENSION_VERSIONS } },
      session: {
        id: session.sessionId,
        ...(session.name ? { name: session.name } : {}),
        ...(session.model ? { model: session.model } : {}),
        ...(session.createdAt ? { createdAt: session.createdAt } : {}),
        metadata: { cwdName: basename(session.cwd) },
      },
      ownership: { epoch: record.epoch, from: localDaemonId(), moveId },
      sessionFiles: hasTranscript ? [{ name: basename(session.sessionFile!), path: session.sessionFile! }] : [],
      stateFiles: [{ name: "session-index.json", content: JSON.stringify({ name: session.name, model: session.model, createdAt: session.createdAt }) }],
    });
    return { size: statSync(outFile).size, sha256: sha256File(outFile), files: manifest.totals.files, worktreeFiles: manifest.totals.worktreeFiles, excluded: manifest.excluded.length };
  }
}
