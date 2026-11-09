/** Local receiver for the shared move protocol. */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { SessionManager, SettingsManager, VERSION as PI_VERSION, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { assertExistingDirectory, rewriteSessionTranscript } from "../core/adapter.ts";
import { materializeWorkspace, verifyBundle } from "../core/bundle.ts";
import { InboundTransfer } from "../core/transfer.ts";
import type { MoveEndpoint } from "../move/orchestrate.ts";
import type { CommitAck } from "../move/service.ts";
import { localDaemonId, movesDir, readLocalRecord, removeMoveDir, writeLocalRecord } from "./local-state.ts";

export interface LocalSinkOptions {
  stateDir: string;
  cwd: string;
  /** Additional flat SDK session directories, e.g. an active caller's --session-dir. */
  sessionDirs?: readonly string[];
  /** Active callers can name transcripts outside SDK-discoverable storage. */
  sessionFiles?: readonly string[];
}

export type LocalCommitAck = CommitAck & { sessionFile: string };

interface Inbound {
  sessionId: string;
  sourceSessionId: string;
  includeWorkspace?: boolean;
  transfer: InboundTransfer;
  committing?: Promise<LocalCommitAck>;
  ack?: LocalCommitAck;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/;
function checkId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error("Invalid transfer id");
  return value;
}

function majorMinor(version: string): string {
  const match = /^v?(\d+)\.(\d+)/.exec(version);
  return match ? `${match[1]}.${match[2]}` : version;
}

export class LocalSink implements MoveEndpoint {
  private readonly options: LocalSinkOptions;
  private readonly inbound = new Map<string, Inbound>();
  private readonly aborted = new Set<string>();

  constructor(options: LocalSinkOptions) {
    this.options = options;
  }

  private assertCanImport(sessionId: string): void {
    const previous = readLocalRecord(this.options.stateDir, sessionId);
    if (previous && previous.state !== "moved") throw new Error(`Session ${sessionId} is already ${previous.state} locally; refusing a second writer`);
  }

  private async assertNoTranscriptCollision(sessionId: string, content?: string): Promise<void> {
    // SDK discovery is bounded to the current agent's storage, not a home-directory scan.
    // Unknown custom roots must be supplied by callers; they cannot be discovered globally.
    const roots = new Set(this.options.sessionDirs ?? []);
    const environmentRoot = process.env.PI_CODING_AGENT_SESSION_DIR;
    if (environmentRoot) roots.add(environmentRoot);
    const previous = readLocalRecord(this.options.stateDir, sessionId);
    for (const cwd of new Set([process.cwd(), this.options.cwd, previous?.cwd].filter((cwd): cwd is string => Boolean(cwd)))) {
      const root = SettingsManager.create(cwd).getSessionDir?.();
      if (root) roots.add(root);
    }
    const sessions: Array<Pick<SessionInfo, "path" | "id" | "cwd">> = await SessionManager.listAll();
    for (const root of roots) sessions.push(...await SessionManager.listAll(root));
    for (const path of this.options.sessionFiles ?? []) {
      if (!existsSync(path)) continue;
      const header = JSON.parse(readFileSync(path, "utf8").split("\n")[0]!);
      if (header?.type === "session") sessions.push({ path, id: header.id, cwd: header.cwd });
    }
    this.assertCanImport(sessionId);
    const settled = readLocalRecord(this.options.stateDir, sessionId);
    const incoming = content?.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
    for (const session of sessions.filter((session) => session.id === sessionId)) {
      // Retained snapshots can span workspaces after repeated returns. A tombstone
      // exempts only an unchanged ancestor of the verified incoming history.
      if (settled?.state === "moved") {
        if (!incoming) continue; // The verified transcript is available only at commit.
        const saved = readFileSync(session.path, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
        if (saved[0]?.timestamp === incoming[0]?.timestamp && saved.length <= incoming.length &&
          saved.slice(1).every((entry, index) => isDeepStrictEqual(entry, incoming[index + 1]))) continue;
      }
      throw new Error(`EEXIST: Session ${sessionId} already has a local transcript at ${session.path}; refusing a second writer`);
    }
  }

  async call(command: Record<string, unknown>): Promise<{ data?: unknown }> {
    const moveId = checkId(command.moveId);
    switch (command.type) {
      case "move_begin": {
        if (this.aborted.has(moveId)) throw new Error(`Move ${moveId} was aborted`);
        if (this.inbound.has(moveId)) throw new Error(`Move ${moveId} already started`);
        const sessionId = checkId(command.sessionId);
        const sourceSessionId = command.sourceSessionId === undefined ? sessionId : checkId(command.sourceSessionId);
        if ((command.copy === true) !== (sourceSessionId !== sessionId)) throw new Error("Copy requires a different destination session id; handoff must preserve the source id");
        if ([...this.inbound.values()].some((item) => item.sessionId === sessionId && !item.ack)) throw new Error(`Session ${sessionId} already has an inbound transfer`);
        this.assertCanImport(sessionId);
        if (command.includeWorkspace === false) assertExistingDirectory(this.options.cwd);
        await this.assertNoTranscriptCollision(sessionId);
        if (this.aborted.has(moveId)) throw new Error(`Move ${moveId} was aborted`);
        if (this.inbound.has(moveId)) throw new Error(`Move ${moveId} already started`);
        if ([...this.inbound.values()].some((item) => item.sessionId === sessionId && !item.ack)) throw new Error(`Session ${sessionId} already has an inbound transfer`);
        const transfer = new InboundTransfer(join(movesDir(this.options.stateDir), moveId, "bundle.tar"), command.size as number, command.sha256 as string);
        this.inbound.set(moveId, { sessionId, sourceSessionId, ...(command.includeWorkspace !== undefined ? { includeWorkspace: command.includeWorkspace as boolean } : {}), transfer });
        return { data: {} };
      }
      case "move_write": {
        const inbound = this.inbound.get(moveId);
        if (!inbound) throw new Error(`Move ${moveId} was not started or was aborted`);
        if (inbound.committing || inbound.ack) throw new Error(`Move ${moveId} already committing or committed`);
        return { data: { received: inbound.transfer.write(command.offset as number, Buffer.from(command.data as string, "base64")) } };
      }
      case "move_commit":
        return { data: await this.commit(moveId) };
      case "move_abort": {
        const inbound = this.inbound.get(moveId);
        if (inbound && inbound.sessionId !== command.sessionId) throw new Error("Abort sessionId does not match the transfer");
        await inbound?.committing?.catch(() => undefined);
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

  private async commit(moveId: string): Promise<LocalCommitAck> {
    if (this.aborted.has(moveId)) throw new Error(`Move ${moveId} was aborted`);
    const inbound = this.inbound.get(moveId);
    if (!inbound) throw new Error(`Move ${moveId} was not started or was aborted`);
    if (inbound.ack) return inbound.ack;
    inbound.committing ??= this.commitOnce(moveId, inbound);
    return inbound.committing;
  }

  private async commitOnce(moveId: string, inbound: Inbound): Promise<LocalCommitAck> {
    const { stateDir } = this.options;
    const moveDir = join(movesDir(stateDir), moveId);
    const dest = resolve(this.options.cwd);
    inbound.transfer.finish();
    const extracted = verifyBundle(inbound.transfer.path, join(moveDir, "work"));
    let sessionFile: string | undefined;
    let workspaceBuilt = false;
    const destExisted = existsSync(dest);
    try {
      const { manifest } = extracted;
      if (manifest.session.id !== inbound.sourceSessionId) throw new Error(`Bundle is for session ${manifest.session.id}, not ${inbound.sourceSessionId}`);
      if (manifest.ownership.moveId !== moveId) throw new Error("Bundle ownership moveId does not match the transfer");
      const includeWorkspace = manifest.workspaceIncluded !== false;
      if (inbound.includeWorkspace !== undefined && inbound.includeWorkspace !== includeWorkspace) throw new Error("Bundle workspace mode does not match the transfer request");
      this.assertCanImport(inbound.sessionId);
      const previous = readLocalRecord(stateDir, inbound.sessionId);
      if (previous?.state === "moved" && (previous.movedTo !== manifest.ownership.from || manifest.ownership.epoch <= previous.epoch)) {
        throw new Error(`Session ${inbound.sessionId} is not returning from its known owner at a newer epoch`);
      }
      if (manifest.agent.kind !== "pi") throw new Error(`Bundle was made by ${manifest.agent.kind}; this machine resumes Pi sessions`);
      if (majorMinor(manifest.agent.version) !== majorMinor(PI_VERSION)) {
        throw new Error(`Pi version mismatch: bundle from pi ${manifest.agent.version}, this machine runs pi ${PI_VERSION}. Both must be on the same major.minor.`);
      }
      if (!includeWorkspace) assertExistingDirectory(this.options.cwd);
      const transcript = manifest.files.find((file) => file.role === "session");
      const manager = SessionManager.create(dest, undefined, { id: inbound.sessionId });
      const content = transcript
        ? rewriteSessionTranscript(readFileSync(join(extracted.dir, transcript.path), "utf8"), inbound.sourceSessionId, inbound.sessionId, dest)
        : `${JSON.stringify(manager.getHeader())}\n`;
      const dir = manager.getSessionDir();
      await this.assertNoTranscriptCollision(inbound.sessionId, content);
      const settled = readLocalRecord(stateDir, inbound.sessionId);
      if (settled?.state === "moved" && (settled.movedTo !== manifest.ownership.from || manifest.ownership.epoch <= settled.epoch)) {
        throw new Error(`Session ${inbound.sessionId} is not returning from its known owner at a newer epoch`);
      }
      const built = includeWorkspace ? materializeWorkspace(extracted, dest) : { cwd: dest, files: 0, bytes: 0 };
      workspaceBuilt = includeWorkspace;
      mkdirSync(dir, { recursive: true });
      const candidate = manager.getSessionFile()!;
      writeFileSync(candidate, content, { flag: "wx", mode: 0o600 });
      sessionFile = candidate;
      const epoch = Math.max(manifest.ownership.epoch + 1, (settled?.epoch ?? 0) + 1);
      writeLocalRecord(stateDir, { sessionId: inbound.sessionId, sessionFile, state: "owned", epoch, moveId, cwd: built.cwd, ...(settled?.host ? { host: settled.host } : {}) });
      inbound.ack = { sessionId: inbound.sessionId, daemonId: localDaemonId(), cwd: built.cwd, epoch, worktreeFiles: built.files, worktreeBytes: built.bytes, verified: true, sessionFile };
      return inbound.ack;
    } catch (error) {
      if (workspaceBuilt) {
        if (destExisted) for (const name of readdirSync(dest)) rmSync(join(dest, name), { recursive: true, force: true });
        else rmSync(dest, { recursive: true, force: true });
      }
      if (sessionFile) rmSync(sessionFile, { force: true });
      throw error;
    } finally {
      rmSync(extracted.dir, { recursive: true, force: true });
      rmSync(moveDir, { recursive: true, force: true });
    }
  }
}
