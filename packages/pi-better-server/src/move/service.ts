/**
 * Daemon side of `pi-remote move`: the Pi-specific glue between the agent-agnostic
 * core (bundle, ownership, transfer) and this daemon's session registry.
 *
 * Source: fence (at a safe boundary) -> export -> serve chunks -> retire | unfence.
 * Target: begin -> write* -> commit (verify, rebuild workspace, open session) | abort.
 * The CLI drives both ends; see orchestrate.ts for the order and failure handling.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { createBundle, materializeWorkspace, sha256File, verifyBundle } from "../core/bundle.ts";
import { InboundTransfer, readChunk } from "../core/transfer.ts";
import { SERVER_EXTENSION_VERSIONS } from "../handshake.ts";
import { importedDirFor, movesDirFor } from "../paths.ts";
import type { MoveCommand } from "../protocol.ts";
import type { IndexEntry, SessionRegistry } from "../registry.ts";

const MAX_READ_BYTES = 4 * 1024 * 1024;
const DEFAULT_FENCE_WAIT_MS = 30_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/;

export interface CommitAck {
  sessionId: string;
  daemonId: string;
  cwd: string;
  epoch: number;
  worktreeFiles: number;
  worktreeBytes: number;
  /** The rebuilt workspace matched the manifest's per-file checksums. */
  verified: true;
}

interface Inbound {
  sessionId: string;
  cwd?: string;
  transfer: InboundTransfer;
  ack?: CommitAck;
}

function majorMinor(version: string): string {
  const match = /^v?(\d+)\.(\d+)/.exec(version);
  return match ? `${match[1]}.${match[2]}` : version;
}

function checkId(label: string, value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} must be 6-128 letters, digits, "-" or "_"`);
  return value;
}

function splitModel(value: string): { provider: string; modelId: string } | undefined {
  const slash = value.indexOf("/");
  return slash < 1 ? undefined : { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

export class MoveService {
  private readonly registry: SessionRegistry;
  private readonly serverDir: string;
  private readonly inbound = new Map<string, Inbound>();
  private readonly aborted = new Set<string>();

  constructor(registry: SessionRegistry, serverDir: string) {
    this.registry = registry;
    this.serverDir = serverDir;
  }

  async handle(command: MoveCommand): Promise<Record<string, unknown>> {
    switch (command.type) {
      case "move_fence":
        return { sessionId: command.sessionId, data: await this.fence(command.sessionId, checkId("moveId", command.moveId), command.waitMs ?? DEFAULT_FENCE_WAIT_MS) };
      case "move_export":
        return { sessionId: command.sessionId, data: this.export(command.sessionId, checkId("moveId", command.moveId)) };
      case "move_read":
        return { data: this.read(checkId("moveId", command.moveId), command.offset, command.length) };
      case "move_retire":
        await this.retire(command.sessionId, checkId("moveId", command.moveId), command.movedTo);
        return { sessionId: command.sessionId };
      case "move_unfence":
        await this.unfence(command.sessionId, command.moveId);
        return { sessionId: command.sessionId };
      case "move_begin":
        this.begin(command);
        return { sessionId: command.sessionId };
      case "move_write":
        return { data: { received: this.write(checkId("moveId", command.moveId), command.offset, command.data) } };
      case "move_commit":
        return { data: await this.commit(checkId("moveId", command.moveId)) };
      case "move_abort":
        return { data: this.abort(checkId("moveId", command.moveId), command.sessionId) };
    }
  }

  // ---- source side ----

  private async fence(sessionId: string, moveId: string, waitMs: number): Promise<{ daemonId: string; epoch: number }> {
    if (!this.registry.entry(sessionId)) throw new Error(`Unknown session: ${sessionId}`);
    // Safe boundary: no turn running or starting. Waiting here is harmless; nothing is fenced yet.
    const deadline = Date.now() + waitMs;
    while (this.registry.get(sessionId)?.turnActive) {
      if (Date.now() >= deadline) throw new Error(`Session ${sessionId} is mid-turn; wait for it to finish (or steer it) and retry the move`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    // No await between the last check and the fence, so no prompt can slip in.
    const record = this.registry.ownership.fence(sessionId, moveId);
    await this.registry.release(sessionId);
    return { daemonId: this.registry.ownership.daemonId, epoch: record.epoch };
  }

  private export(sessionId: string, moveId: string): { size: number; sha256: string; files: number; worktreeFiles: number; excluded: number } {
    const record = this.registry.ownership.get(sessionId);
    if (record.state !== "fenced" || record.moveId !== moveId) throw new Error(`Session ${sessionId} is not fenced by move ${moveId}`);
    const entry = this.registry.entry(sessionId);
    if (!entry) throw new Error(`Unknown session: ${sessionId}`);
    const dir = join(movesDirFor(this.serverDir), moveId);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const outFile = join(dir, "bundle.tar");
    const hasTranscript = entry.sessionFile !== "" && existsSync(entry.sessionFile);
    const manifest = createBundle({
      cwd: entry.cwd,
      outFile,
      agent: { kind: "pi", version: PI_VERSION, extensions: { ...SERVER_EXTENSION_VERSIONS } },
      session: {
        id: sessionId,
        ...(entry.name ? { name: entry.name } : {}),
        ...(entry.model ? { model: `${entry.model.provider}/${entry.model.modelId}` } : {}),
        createdAt: entry.createdAt,
        metadata: { cwdName: basename(entry.cwd) },
      },
      ownership: { epoch: record.epoch, from: this.registry.ownership.daemonId, moveId },
      sessionFiles: hasTranscript ? [{ name: basename(entry.sessionFile), path: entry.sessionFile }] : [],
      stateFiles: [{ name: "session-index.json", content: JSON.stringify({ name: entry.name, model: entry.model, createdAt: entry.createdAt }) }],
    });
    return { size: statSync(outFile).size, sha256: sha256File(outFile), files: manifest.totals.files, worktreeFiles: manifest.totals.worktreeFiles, excluded: manifest.excluded.length };
  }

  private read(moveId: string, offset: number, length: number): { data: string; eof: boolean } {
    const file = join(movesDirFor(this.serverDir), moveId, "bundle.tar");
    if (!existsSync(file)) throw new Error(`No exported bundle for move ${moveId}`);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length <= 0) throw new Error("move_read needs a non-negative integer offset and a positive length");
    const { data, eof } = readChunk(file, offset, Math.min(length, MAX_READ_BYTES));
    return { data: data.toString("base64"), eof };
  }

  private async retire(sessionId: string, moveId: string, movedTo: string): Promise<void> {
    this.registry.ownership.retire(sessionId, moveId, movedTo);
    await this.registry.retire(sessionId);
    rmSync(join(movesDirFor(this.serverDir), moveId), { recursive: true, force: true });
  }

  private async unfence(sessionId: string, moveId: string | undefined): Promise<void> {
    const fencedBy = this.registry.ownership.get(sessionId).moveId;
    this.registry.ownership.unfence(sessionId, moveId);
    if (fencedBy) rmSync(join(movesDirFor(this.serverDir), fencedBy), { recursive: true, force: true });
    if (this.registry.entry(sessionId)?.status === "running") await this.registry.open(sessionId);
  }

  // ---- target side ----

  private begin(command: Extract<MoveCommand, { type: "move_begin" }>): void {
    const moveId = checkId("moveId", command.moveId);
    const sessionId = checkId("sessionId", command.sessionId);
    if (this.aborted.has(moveId)) throw new Error(`Move ${moveId} was aborted`);
    if (this.inbound.has(moveId)) throw new Error(`Move ${moveId} already started`);
    if (!Number.isInteger(command.size) || command.size < 0 || typeof command.sha256 !== "string") throw new Error("move_begin needs size and sha256");
    const existing = this.registry.entry(sessionId);
    if (existing && existing.status === "running" && !this.registry.ownership.blockedReason(sessionId)) {
      throw new Error(`Session ${sessionId} already exists on this daemon`);
    }
    if (command.cwd !== undefined && !command.cwd.startsWith("/")) throw new Error("move_begin cwd must be an absolute path");
    const transfer = new InboundTransfer(join(movesDirFor(this.serverDir), moveId, "bundle.tar"), command.size, command.sha256);
    this.inbound.set(moveId, { sessionId, ...(command.cwd ? { cwd: command.cwd } : {}), transfer });
  }

  private write(moveId: string, offset: number, data: string): number {
    const inbound = this.inbound.get(moveId);
    if (!inbound) throw new Error(`Move ${moveId} was not started or was aborted`);
    return inbound.transfer.write(offset, Buffer.from(data, "base64"));
  }

  private async commit(moveId: string): Promise<CommitAck> {
    if (this.aborted.has(moveId)) throw new Error(`Move ${moveId} was aborted`);
    const inbound = this.inbound.get(moveId);
    if (!inbound) throw new Error(`Move ${moveId} was not started or was aborted`);
    if (inbound.ack) return inbound.ack; // retry after a lost reply
    const moveDir = join(movesDirFor(this.serverDir), moveId);
    const { sessionId } = inbound;

    inbound.transfer.finish(); // size + sha256 of the whole archive
    const extracted = verifyBundle(inbound.transfer.path, join(moveDir, "work"));
    let dest: string | undefined;
    let importedDir: string | undefined;
    const previousOwnership = this.registry.ownership.peek(sessionId);
    const previousEntry = this.registry.entry(sessionId) as IndexEntry | undefined;
    let acquired = false;
    try {
      const { manifest } = extracted;
      if (manifest.session.id !== sessionId) throw new Error(`Bundle is for session ${manifest.session.id}, not ${sessionId}`);
      if (manifest.agent.kind !== "pi") throw new Error(`Bundle was made by ${manifest.agent.kind}; this daemon hosts Pi sessions`);
      if (majorMinor(manifest.agent.version) !== majorMinor(PI_VERSION)) {
        throw new Error(`Pi version mismatch: bundle from pi ${manifest.agent.version}, this daemon runs pi ${PI_VERSION}. Both must be on the same major.minor.`);
      }
      const cwdName = typeof manifest.session.metadata?.cwdName === "string" ? manifest.session.metadata.cwdName : "workspace";
      dest = resolve(inbound.cwd ?? join(this.serverDir, "workspaces", sessionId, cwdName));
      const built = materializeWorkspace(extracted, dest);

      importedDir = join(importedDirFor(this.serverDir), sessionId);
      rmSync(importedDir, { recursive: true, force: true });
      const transcript = manifest.files.find((file) => file.role === "session");
      let sessionFile = "";
      if (transcript) {
        mkdirSync(importedDir, { recursive: true, mode: 0o700 });
        sessionFile = join(importedDir, basename(transcript.path));
        copyFileSync(join(extracted.dir, transcript.path), sessionFile);
      }
      const model = manifest.session.model ? splitModel(manifest.session.model) : undefined;
      const now = new Date().toISOString();

      const record = this.registry.ownership.acquire(sessionId, manifest.ownership.epoch + 1, moveId);
      acquired = true;
      await this.registry.adopt({
        sessionId,
        cwd: built.cwd,
        sessionFile,
        status: "running",
        ...(manifest.session.name ? { name: manifest.session.name } : {}),
        ...(model ? { model } : {}),
        createdAt: manifest.session.createdAt ?? now,
        updatedAt: now,
      });
      inbound.ack = { sessionId, daemonId: this.registry.ownership.daemonId, cwd: built.cwd, epoch: record.epoch, worktreeFiles: built.files, worktreeBytes: built.bytes, verified: true };
      return inbound.ack;
    } catch (error) {
      if (acquired) {
        this.registry.ownership.release(sessionId, previousOwnership);
        await this.registry.forget(sessionId, previousEntry);
      }
      if (dest) rmSync(dest, { recursive: true, force: true });
      if (importedDir) rmSync(importedDir, { recursive: true, force: true });
      throw error;
    } finally {
      rmSync(extracted.dir, { recursive: true, force: true });
      rmSync(moveDir, { recursive: true, force: true });
    }
  }

  /** Cancel an inbound move. If it already committed, say so instead of undoing it: the target owns the session. */
  private abort(moveId: string, sessionId: string): { committed: boolean } {
    const inbound = this.inbound.get(moveId);
    const record = this.registry.ownership.get(sessionId);
    const committed = inbound?.ack !== undefined || (record.state === "owned" && record.moveId === moveId);
    if (committed) return { committed: true };
    this.aborted.add(moveId);
    inbound?.transfer.abort();
    this.inbound.delete(moveId);
    rmSync(join(movesDirFor(this.serverDir), moveId), { recursive: true, force: true });
    return { committed: false };
  }
}
