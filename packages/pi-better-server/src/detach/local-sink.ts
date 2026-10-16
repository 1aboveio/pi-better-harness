/**
 * This machine as the target end of a move (`pi-remote return`): it answers the
 * move_begin / write / commit / abort commands a daemon does, rebuilds the
 * workspace on disk and puts the transcript where `pi` finds it, so the shared
 * `moveSession` orchestration pulls a session home unchanged.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { SessionManager, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { materializeWorkspace, verifyBundle } from "../core/bundle.ts";
import { InboundTransfer } from "../core/transfer.ts";
import type { MoveEndpoint } from "../move/orchestrate.ts";
import type { CommitAck } from "../move/service.ts";
import { localDaemonId, movesDir, readLocalRecord, removeMoveDir, writeLocalRecord } from "./local-state.ts";

export interface LocalSinkOptions {
  stateDir: string;
  /** Directory to rebuild the workspace in; absent or empty. */
  cwd: string;
}

/** What the local target adds to a daemon's acknowledgement. */
export type LocalCommitAck = CommitAck & { sessionFile?: string };

interface Inbound {
  sessionId: string;
  transfer: InboundTransfer;
  ack?: LocalCommitAck;
}

function majorMinor(version: string): string {
  const match = /^v?(\d+)\.(\d+)/.exec(version);
  return match ? `${match[1]}.${match[2]}` : version;
}

/** Rewrite the transcript header's cwd so Pi resumes it in the rebuilt workspace. */
function withCwd(transcript: string, cwd: string): string {
  const newline = transcript.indexOf("\n");
  const first = newline === -1 ? transcript : transcript.slice(0, newline);
  try {
    const header = JSON.parse(first) as { type?: string; cwd?: string };
    if (header.type !== "session") return transcript;
    return `${JSON.stringify({ ...header, cwd })}${newline === -1 ? "" : transcript.slice(newline)}`;
  } catch {
    return transcript;
  }
}

export class LocalSink implements MoveEndpoint {
  private readonly options: LocalSinkOptions;
  private readonly inbound = new Map<string, Inbound>();
  private readonly aborted = new Set<string>();

  constructor(options: LocalSinkOptions) {
    this.options = options;
  }

  async call(command: Record<string, unknown>): Promise<{ data?: unknown }> {
    const moveId = command.moveId as string;
    switch (command.type) {
      case "move_begin": {
        if (this.aborted.has(moveId)) throw new Error(`Move ${moveId} was aborted`);
        if (this.inbound.has(moveId)) throw new Error(`Move ${moveId} already started`);
        const sessionId = command.sessionId as string;
        const transfer = new InboundTransfer(join(movesDir(this.options.stateDir), moveId, "bundle.tar"), command.size as number, command.sha256 as string);
        this.inbound.set(moveId, { sessionId, transfer });
        return { data: {} };
      }
      case "move_write": {
        const inbound = this.inbound.get(moveId);
        if (!inbound) throw new Error(`Move ${moveId} was not started or was aborted`);
        return { data: { received: inbound.transfer.write(command.offset as number, Buffer.from(command.data as string, "base64")) } };
      }
      case "move_commit":
        return { data: this.commit(moveId) };
      case "move_abort": {
        const inbound = this.inbound.get(moveId);
        if (inbound?.ack) return { data: { committed: true } };
        this.aborted.add(moveId);
        inbound?.transfer.abort();
        this.inbound.delete(moveId);
        removeMoveDir(this.options.stateDir, moveId);
        return { data: { committed: false } };
      }
      default:
        throw new Error(`This machine cannot handle ${String(command.type)} as a move target`);
    }
  }

  private commit(moveId: string): LocalCommitAck {
    if (this.aborted.has(moveId)) throw new Error(`Move ${moveId} was aborted`);
    const inbound = this.inbound.get(moveId);
    if (!inbound) throw new Error(`Move ${moveId} was not started or was aborted`);
    if (inbound.ack) return inbound.ack;
    const { stateDir } = this.options;
    const moveDir = join(movesDir(stateDir), moveId);
    const dest = resolve(this.options.cwd);
    inbound.transfer.finish();
    const extracted = verifyBundle(inbound.transfer.path, join(moveDir, "work"));
    let sessionFile: string | undefined;
    let built: ReturnType<typeof materializeWorkspace> | undefined;
    try {
      const { manifest } = extracted;
      if (manifest.session.id !== inbound.sessionId) throw new Error(`Bundle is for session ${manifest.session.id}, not ${inbound.sessionId}`);
      if (manifest.agent.kind !== "pi") throw new Error(`Bundle was made by ${manifest.agent.kind}; this machine resumes Pi sessions`);
      if (majorMinor(manifest.agent.version) !== majorMinor(PI_VERSION)) {
        throw new Error(`Pi version mismatch: bundle from pi ${manifest.agent.version}, this machine runs pi ${PI_VERSION}. Both must be on the same major.minor.`);
      }
      built = materializeWorkspace(extracted, dest);
      const transcript = manifest.files.find((file) => file.role === "session");
      if (transcript) {
        const dir = SessionManager.create(built.cwd).getSessionDir();
        mkdirSync(dir, { recursive: true });
        sessionFile = join(dir, basename(transcript.path));
        writeFileSync(sessionFile, withCwd(readFileSync(join(extracted.dir, transcript.path), "utf8"), built.cwd), { mode: 0o600 });
      }
      const epoch = manifest.ownership.epoch + 1;
      const previous = readLocalRecord(stateDir, inbound.sessionId);
      writeLocalRecord(stateDir, { sessionId: inbound.sessionId, state: "owned", epoch: Math.max(epoch, (previous?.epoch ?? 0) + 1), moveId, cwd: built.cwd, ...(previous?.host ? { host: previous.host } : {}) });
      inbound.ack = { sessionId: inbound.sessionId, daemonId: localDaemonId(), cwd: built.cwd, epoch, worktreeFiles: built.files, worktreeBytes: built.bytes, verified: true, ...(sessionFile ? { sessionFile } : {}) };
      return inbound.ack;
    } catch (error) {
      // materializeWorkspace cleans up after itself; only a later failure leaves a workspace we built.
      if (built) rmSync(dest, { recursive: true, force: true });
      if (sessionFile) rmSync(sessionFile, { force: true });
      throw error;
    } finally {
      rmSync(extracted.dir, { recursive: true, force: true });
      rmSync(moveDir, { recursive: true, force: true });
    }
  }
}
