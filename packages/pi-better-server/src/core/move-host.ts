/**
 * Daemon side of `pi-remote move`, agent-agnostic: the command handlers for both
 * ends of a move, built on the bundle, transfer and ownership core. Everything
 * specific to one agent goes through an AgentMoveAdapter (adapter.ts).
 *
 * Source: fence (at a safe boundary) -> export -> serve chunks -> retire | unfence.
 * Target: begin -> write* -> commit (verify, rebuild workspace, import session) | abort.
 * The CLI drives both ends; see move/orchestrate.ts for the order and failure handling.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createBundle, materializeWorkspace, sha256File, verifyBundle } from "./bundle.ts";
import { assertExistingDirectory, type AgentMoveAdapter } from "./adapter.ts";
import { InboundTransfer, readChunk } from "./transfer.ts";
import type { MoveCommand } from "../protocol.ts";

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
  sessionFile?: string;
}

interface Inbound {
  sessionId: string;
  sourceSessionId: string;
  includeWorkspace?: boolean;
  committing?: Promise<CommitAck>;
  cwd?: string;
  rebindProvider?: string;
  transfer: InboundTransfer;
  ack?: CommitAck;
}

function checkId(label: string, value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} must be 6-128 letters, digits, "-" or "_"`);
  return value;
}

export class MoveHost {
  private readonly adapter: AgentMoveAdapter;
  private readonly serverDir: string;
  private readonly movesDir: string;
  private readonly inbound = new Map<string, Inbound>();
  private readonly aborted = new Set<string>();

  constructor(adapter: AgentMoveAdapter, serverDir: string, movesDir: string) {
    this.adapter = adapter;
    this.serverDir = serverDir;
    this.movesDir = movesDir;
  }

  async handle(command: MoveCommand): Promise<Record<string, unknown>> {
    switch (command.type) {
      case "move_fence":
        return { sessionId: command.sessionId, data: await this.fence(command.sessionId, checkId("moveId", command.moveId), command.waitMs ?? DEFAULT_FENCE_WAIT_MS) };
      case "move_export":
        return { sessionId: command.sessionId, data: this.export(command.sessionId, checkId("moveId", command.moveId), command.includeWorkspace, command.compression) };
      case "move_read":
        return { data: this.read(checkId("moveId", command.moveId), command.offset, command.length) };
      case "move_retire":
        await this.retire(command.sessionId, checkId("moveId", command.moveId), command.movedTo);
        return { sessionId: command.sessionId };
      case "move_unfence":
        await this.unfence(command.sessionId, command.moveId);
        return { sessionId: command.sessionId };
      case "move_begin":
        await this.begin(command);
        return { sessionId: command.sessionId };
      case "move_write":
        return { data: { received: this.write(checkId("moveId", command.moveId), command.offset, command.data) } };
      case "move_commit":
        return { data: await this.commit(checkId("moveId", command.moveId)) };
      case "move_abort":
        return { data: await this.abort(checkId("moveId", command.moveId), command.sessionId) };
      case "move_preflight": {
        if (command.includeWorkspace === false && command.dir !== undefined) assertExistingDirectory(command.dir);
        const report = (await this.adapter.readiness?.(command)) ?? { checks: [] };
        return { data: { daemonId: this.adapter.ownership.daemonId, ...report } };
      }
    }
  }

  // ---- source side ----

  private async fence(sessionId: string, moveId: string, waitMs: number): Promise<{ daemonId: string; epoch: number }> {
    const { adapter } = this;
    if (!adapter.hasSession(sessionId)) throw new Error(`Unknown session: ${sessionId}`);
    await adapter.preflight?.({ side: "source", sessionId, moveId });
    // Safe boundary: no turn running or starting. Waiting here is harmless; nothing is fenced yet.
    const deadline = Date.now() + waitMs;
    while (adapter.isBusy(sessionId)) {
      if (Date.now() >= deadline) throw new Error(`Session ${sessionId} is mid-turn; wait for it to finish (or steer it) and retry the move`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    // No await between the last check and the fence, so no prompt can slip in.
    const record = adapter.ownership.fence(sessionId, moveId);
    try {
      await adapter.stop(sessionId);
    } catch (error) {
      adapter.ownership.unfence(sessionId, moveId);
      await adapter.resume(sessionId);
      throw error;
    }
    return { daemonId: adapter.ownership.daemonId, epoch: record.epoch };
  }

  private export(sessionId: string, moveId: string, includeWorkspace?: boolean, compression?: "gzip" | "none"): { size: number; sha256: string; files: number; worktreeFiles: number; excluded: number } {
    const { adapter } = this;
    const record = adapter.ownership.get(sessionId);
    if (record.state !== "fenced" || record.moveId !== moveId) throw new Error(`Session ${sessionId} is not fenced by move ${moveId}`);
    if (!adapter.hasSession(sessionId)) throw new Error(`Unknown session: ${sessionId}`);
    const dir = join(this.movesDir, moveId);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const outFile = join(dir, "bundle.tar");
    const manifest = createBundle({
      ...adapter.bundleSession(sessionId),
      ...(includeWorkspace !== undefined ? { includeWorkspace } : {}),
      ...(compression !== undefined ? { compression } : {}),
      outFile,
      ownership: { epoch: record.epoch, from: adapter.ownership.daemonId, moveId },
    });
    return { size: statSync(outFile).size, sha256: sha256File(outFile), files: manifest.totals.files, worktreeFiles: manifest.totals.worktreeFiles, excluded: manifest.excluded.length };
  }

  private read(moveId: string, offset: number, length: number): { data: string; eof: boolean } {
    const file = join(this.movesDir, moveId, "bundle.tar");
    if (!existsSync(file)) throw new Error(`No exported bundle for move ${moveId}`);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length <= 0) throw new Error("move_read needs a non-negative integer offset and a positive length");
    const { data, eof } = readChunk(file, offset, Math.min(length, MAX_READ_BYTES));
    return { data: data.toString("base64"), eof };
  }

  private async retire(sessionId: string, moveId: string, movedTo: string): Promise<void> {
    this.adapter.ownership.retire(sessionId, moveId, movedTo);
    await this.adapter.retire(sessionId);
    rmSync(join(this.movesDir, moveId), { recursive: true, force: true });
  }

  private async unfence(sessionId: string, moveId: string | undefined): Promise<void> {
    const fencedBy = this.adapter.ownership.get(sessionId).moveId;
    this.adapter.ownership.unfence(sessionId, moveId);
    if (fencedBy) rmSync(join(this.movesDir, fencedBy), { recursive: true, force: true });
    await this.adapter.resume(sessionId);
  }

  // ---- target side ----

  private async begin(command: Extract<MoveCommand, { type: "move_begin" }>): Promise<void> {
    const moveId = checkId("moveId", command.moveId);
    const sessionId = checkId("sessionId", command.sessionId);
    const sourceSessionId = command.sourceSessionId === undefined ? sessionId : checkId("sourceSessionId", command.sourceSessionId);
    if ((command.copy === true) !== (sourceSessionId !== sessionId)) throw new Error("Copy requires a different destination session id; handoff must preserve the source id");
    if (command.includeWorkspace === false) assertExistingDirectory(command.cwd);
    if (this.aborted.has(moveId)) throw new Error(`Move ${moveId} was aborted`);
    if (this.inbound.has(moveId)) throw new Error(`Move ${moveId} already started`);
    if (!Number.isInteger(command.size) || command.size < 0 || typeof command.sha256 !== "string") throw new Error("move_begin needs size and sha256");
    this.adapter.assertCanImport(sessionId);
    if (command.cwd !== undefined && !command.cwd.startsWith("/")) throw new Error("move_begin cwd must be an absolute path");
    await this.adapter.preflight?.({ side: "target", sessionId, moveId, ...(command.cwd ? { cwd: command.cwd } : {}) });
    // Preflight is async: a duplicate or an abort may have landed while it ran.
    if (this.aborted.has(moveId)) throw new Error(`Move ${moveId} was aborted`);
    if (this.inbound.has(moveId)) throw new Error(`Move ${moveId} already started`);
    if ([...this.inbound.values()].some((item) => item.sessionId === sessionId && !item.ack)) throw new Error(`Session ${sessionId} already has an inbound transfer`);
    this.adapter.assertCanImport(sessionId);
    const transfer = new InboundTransfer(join(this.movesDir, moveId, "bundle.tar"), command.size, command.sha256);
    this.inbound.set(moveId, { sessionId, sourceSessionId, ...(command.includeWorkspace !== undefined ? { includeWorkspace: command.includeWorkspace } : {}), ...(command.cwd ? { cwd: command.cwd } : {}), ...(command.rebindProvider ? { rebindProvider: command.rebindProvider } : {}), transfer });
  }

  private write(moveId: string, offset: number, data: string): number {
    const inbound = this.inbound.get(moveId);
    if (!inbound) throw new Error(`Move ${moveId} was not started or was aborted`);
    if (inbound.committing || inbound.ack) throw new Error(`Move ${moveId} is already committing or committed`);
    return inbound.transfer.write(offset, Buffer.from(data, "base64"));
  }

  private async commit(moveId: string): Promise<CommitAck> {
    const inbound = this.inbound.get(moveId);
    if (!inbound || this.aborted.has(moveId)) throw new Error(`Move ${moveId} was not started or was aborted`);
    if (inbound.ack) return inbound.ack;
    inbound.committing ??= this.commitOnce(moveId, inbound);
    return inbound.committing;
  }

  private async commitOnce(moveId: string, inbound: Inbound): Promise<CommitAck> {
    const { adapter } = this;
    const moveDir = join(this.movesDir, moveId);
    const { sessionId } = inbound;

    inbound.transfer.finish(); // size + sha256 of the whole archive
    const extracted = verifyBundle(inbound.transfer.path, join(moveDir, "work"));
    let dest: string | undefined;
    let workspaceBuilt = false;
    let destExisted = false;
    const previousOwnership = adapter.ownership.peek(sessionId);
    const snapshot = adapter.snapshot(sessionId);
    let acquired = false;
    try {
      const { manifest } = extracted;
      if (manifest.session.id !== inbound.sourceSessionId) throw new Error(`Bundle is for session ${manifest.session.id}, not ${inbound.sourceSessionId}`);
      if (manifest.ownership.moveId !== moveId) throw new Error("Bundle ownership moveId does not match the transfer");
      const includeWorkspace = manifest.workspaceIncluded !== false;
      if (inbound.includeWorkspace !== undefined && inbound.includeWorkspace !== includeWorkspace) throw new Error("Bundle workspace mode does not match the transfer request");
      adapter.assertCanImport(sessionId);
      if (previousOwnership?.state === "moved" && (previousOwnership.movedTo !== manifest.ownership.from || manifest.ownership.epoch <= previousOwnership.epoch)) {
        throw new Error(`Session ${sessionId} is not returning from its known owner at a newer epoch`);
      }
      adapter.checkBundle(manifest);
      const cwdName = typeof manifest.session.metadata?.cwdName === "string" ? manifest.session.metadata.cwdName : "workspace";
      if (basename(cwdName) !== cwdName || cwdName === "." || cwdName === "..") throw new Error("Invalid workspace name in bundle");
      dest = resolve(inbound.cwd ?? join(this.serverDir, "workspaces", sessionId, cwdName));
      let built;
      if (includeWorkspace) {
        destExisted = existsSync(dest);
        built = materializeWorkspace(extracted, dest);
        workspaceBuilt = true;
      } else {
        assertExistingDirectory(inbound.cwd);
        built = { cwd: inbound.cwd, files: 0, bytes: 0 };
      }

      const record = adapter.ownership.acquire(sessionId, manifest.ownership.epoch + 1, moveId);
      acquired = true;
      const imported = await adapter.importSession({ sessionId, sourceSessionId: inbound.sourceSessionId, moveId, manifest, extractedDir: extracted.dir, cwd: built.cwd, ...(inbound.rebindProvider ? { rebindProvider: inbound.rebindProvider } : {}) });
      inbound.ack = { sessionId, daemonId: adapter.ownership.daemonId, cwd: built.cwd, epoch: record.epoch, worktreeFiles: built.files, worktreeBytes: built.bytes, verified: true, ...(imported?.sessionFile ? { sessionFile: imported.sessionFile } : {}) };
      return inbound.ack;
    } catch (error) {
      if (acquired) {
        await adapter.restore(sessionId, snapshot);
        adapter.ownership.release(sessionId, previousOwnership);
      }
      if (dest && workspaceBuilt) {
        if (destExisted) for (const name of readdirSync(dest)) rmSync(join(dest, name), { recursive: true, force: true });
        else rmSync(dest, { recursive: true, force: true });
      }
      throw error;
    } finally {
      rmSync(extracted.dir, { recursive: true, force: true });
      rmSync(moveDir, { recursive: true, force: true });
    }
  }

  /** Cancel an inbound move. If it already committed, say so instead of undoing it: the target owns the session. */
  private async abort(moveId: string, sessionId: string): Promise<{ committed: boolean }> {
    const inbound = this.inbound.get(moveId);
    if (inbound && inbound.sessionId !== sessionId) throw new Error("Abort sessionId does not match the transfer");
    // An import may be awaiting provider startup. Do not report failure while it can still commit.
    await inbound?.committing?.catch(() => undefined);
    const record = this.adapter.ownership.get(sessionId);
    const committed = inbound?.ack !== undefined || (record.state === "owned" && record.moveId === moveId);
    if (committed) return { committed: true };
    this.aborted.add(moveId);
    inbound?.transfer.abort();
    this.inbound.delete(moveId);
    rmSync(join(this.movesDir, moveId), { recursive: true, force: true });
    return { committed: false };
  }
}
