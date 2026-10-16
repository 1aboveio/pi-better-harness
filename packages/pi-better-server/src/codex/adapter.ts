/**
 * The Codex side of the move core. A Codex thread is one rollout file plus whatever
 * the app-server derives from it, so a move carries the rollout and the workspace;
 * the target app-server indexes the imported rollout itself. Codex credentials
 * (auth.json) are never part of a bundle: the target host signs in on its own.
 *
 * Source threads stay on the local Codex app-server; a retired thread is archived
 * there (the tombstone) so no client can continue it by accident.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { AgentMoveAdapter, ImportRequest, MovePreflightContext, SessionBundleSpec } from "../core/adapter.ts";
import type { BundleManifest } from "../core/bundle.ts";
import { OwnershipStore } from "../core/ownership.ts";
import { ownershipPathFor } from "../paths.ts";
import { SERVER_EXTENSION_VERSIONS } from "../handshake.ts";
import { readRolloutMeta, readThreadName, rewriteRolloutCwd } from "./rollout.ts";
import type { CodexRuntime } from "./runtime.ts";

export const CODEX_AGENT_KIND = "codex";
const THREAD_STATE_FILE = "codex-thread.json";

interface ThreadState {
  /** Rollout path relative to the sessions directory, so the target files it in the same place. */
  rolloutRelPath: string;
  originalCwd: string;
  threadName?: string;
}

export interface CodexImportSnapshot {
  /** The rollout this import replaced, kept until the move commits or is rolled back. */
  backup?: { path: string; saved: string };
  /** Path the import wrote, if it created a new rollout. */
  created?: string;
  wasArchived: boolean;
}

export class CodexMoveAdapter implements AgentMoveAdapter {
  readonly kind = CODEX_AGENT_KIND;
  readonly ownership: OwnershipStore;
  private readonly runtime: CodexRuntime;
  private readonly serverDir: string;
  private readonly busy = new Map<string, boolean>();

  constructor(runtime: CodexRuntime, serverDir: string) {
    this.runtime = runtime;
    this.serverDir = serverDir;
    this.ownership = new OwnershipStore(ownershipPathFor(serverDir));
  }

  // ---- source side ----

  hasSession(sessionId: string): boolean {
    // A fenced thread sits in archived_sessions (see stop), so look there too.
    return (this.runtime.rolloutPath(sessionId) ?? this.runtime.archivedRolloutPath(sessionId)) !== undefined;
  }

  /**
   * The app-server owns the truth about a running turn. isBusy is synchronous, so it
   * answers from the last status it read and refreshes in the background; the fence
   * loop polls it, and the source preflight primes it.
   */
  isBusy(sessionId: string): boolean {
    void this.refreshBusy(sessionId);
    return this.busy.get(sessionId) ?? false;
  }

  private async refreshBusy(sessionId: string): Promise<boolean> {
    try {
      const client = await this.runtime.client();
      const { thread } = await client.call<{ thread: { status?: { type?: string } } }>("thread/read", { threadId: sessionId, includeTurns: false });
      const active = thread.status?.type === "active";
      this.busy.set(sessionId, active);
      return active;
    } catch {
      // Unreachable app-server: nothing is running through it.
      this.busy.set(sessionId, false);
      return false;
    }
  }

  /**
   * Fence the thread against every client of the source app-server, not just this daemon's own
   * connection: archiving unloads the thread for all of them and turn/start then fails with
   * "thread not found", so a TUI attached through `pi-remote attach` or `codex resume --remote`
   * cannot start or continue a turn until the move is aborted (resume() unarchives) or retired.
   */
  async stop(sessionId: string): Promise<void> {
    await this.archive(sessionId);
    this.busy.set(sessionId, false);
  }

  private async archive(sessionId: string): Promise<void> {
    if (!this.runtime.rolloutPath(sessionId)) return; // already archived
    try {
      const client = await this.runtime.client();
      await client.call("thread/unsubscribe", { threadId: sessionId }).catch(() => undefined);
      await client.call("thread/archive", { threadId: sessionId });
    } catch (error) {
      // No app-server to ask: nobody can drive the thread through it, but keep it out of sessions/ ourselves.
      const file = this.runtime.rolloutPath(sessionId);
      if (!file) return;
      try {
        mkdirSync(this.runtime.archivedDir, { recursive: true });
        renameSync(file, join(this.runtime.archivedDir, basename(file)));
      } catch {
        throw error;
      }
    }
    if (this.runtime.rolloutPath(sessionId)) throw new Error(`Could not take Codex thread ${sessionId} out of service on the source`);
  }

  private async unarchive(sessionId: string): Promise<void> {
    if (this.runtime.rolloutPath(sessionId)) return;
    const archived = this.runtime.archivedRolloutPath(sessionId);
    if (!archived) return;
    try {
      const client = await this.runtime.client();
      await client.call("thread/unarchive", { threadId: sessionId });
    } catch (error) {
      const name = basename(archived);
      const day = /^rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(name);
      const dir = day ? join(this.runtime.sessionsDir, day[1]!, day[2]!, day[3]!) : this.runtime.sessionsDir;
      try {
        mkdirSync(dir, { recursive: true });
        renameSync(archived, join(dir, name));
      } catch {
        throw error;
      }
    }
  }

  bundleSession(sessionId: string): SessionBundleSpec {
    const file = this.runtime.rolloutPath(sessionId) ?? this.runtime.archivedRolloutPath(sessionId);
    if (!file) throw new Error(`Unknown Codex thread: ${sessionId}`);
    const meta = readRolloutMeta(file);
    const name = readThreadName(this.runtime.home, sessionId);
    const state: ThreadState = { rolloutRelPath: this.sessionsRelPath(file), originalCwd: meta.cwd, ...(name ? { threadName: name } : {}) };
    return {
      cwd: meta.cwd,
      agent: { kind: this.kind, version: this.runtime.version(), extensions: { ...SERVER_EXTENSION_VERSIONS } },
      session: {
        id: sessionId,
        ...(name ? { name } : {}),
        ...(meta.createdAt ? { createdAt: meta.createdAt } : {}),
        metadata: { cwdName: basename(meta.cwd) },
      },
      sessionFiles: [{ name: basename(file), path: file }],
      stateFiles: [{ name: THREAD_STATE_FILE, content: JSON.stringify(state) }],
    };
  }

  /** Where the rollout files under sessions/: YYYY/MM/DD/<name>, derived from the name for an archived one. */
  private sessionsRelPath(file: string): string {
    const name = basename(file);
    const day = /^rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(name);
    return day ? join(day[1]!, day[2]!, day[3]!, name) : relative(this.runtime.sessionsDir, file);
  }

  async retire(sessionId: string): Promise<void> {
    // Already archived by stop(); archive() is a no-op then and keeps the tombstone.
    await this.archive(sessionId);
  }

  async resume(sessionId: string): Promise<void> {
    // The move failed or was aborted: put the thread back where clients can load it.
    await this.unarchive(sessionId);
  }

  // ---- target side ----

  assertCanImport(sessionId: string): void {
    if (this.runtime.rolloutPath(sessionId) && !this.ownership.blockedReason(sessionId)) {
      throw new Error(`Codex thread ${sessionId} already exists on this host`);
    }
  }

  checkBundle(manifest: BundleManifest): void {
    if (manifest.agent.kind !== this.kind) throw new Error(`Bundle was made by ${manifest.agent.kind}; this daemon hosts Codex threads`);
    const local = this.runtime.version();
    if (manifest.agent.version !== local) {
      throw new Error(`Codex CLI version mismatch: bundle from codex-cli ${manifest.agent.version}, this host runs codex-cli ${local}. Both ends must run the same version.`);
    }
  }

  snapshot(sessionId: string): CodexImportSnapshot {
    const active = this.runtime.rolloutPath(sessionId);
    const archived = this.runtime.archivedRolloutPath(sessionId);
    const existing = active ?? archived;
    if (!existing) return { wasArchived: false };
    const saved = join(this.serverDir, "imported", `${sessionId}.rollout.bak`);
    mkdirSync(dirname(saved), { recursive: true, mode: 0o700 });
    copyFileSync(existing, saved);
    return { backup: { path: existing, saved }, wasArchived: active === undefined };
  }

  async importSession(request: ImportRequest): Promise<void> {
    const { sessionId, manifest } = request;
    const rolloutFile = manifest.files.find((file) => file.role === "session");
    const stateFile = manifest.files.find((file) => file.role === "state" && basename(file.path) === THREAD_STATE_FILE);
    if (!rolloutFile || !stateFile) throw new Error("Bundle has no Codex rollout");
    const state = JSON.parse(readFileSync(join(request.extractedDir, stateFile.path), "utf8")) as ThreadState;
    const sessionsDir = this.runtime.sessionsDir;
    const target = resolve(sessionsDir, state.rolloutRelPath);
    if (relative(sessionsDir, target).startsWith("..")) throw new Error(`Bundle rollout path escapes the sessions directory: ${state.rolloutRelPath}`);

    const client = await this.runtime.client();
    // A copy from an earlier visit (the tombstone of a move away) is dropped first, with the app-server's index row for it:
    // the row keeps the old cwd, and it is only rebuilt from a rollout the app-server has not seen. snapshot() kept a copy
    // of the file, so a failed move puts it back.
    const stale = this.runtime.rolloutPath(sessionId) ?? this.runtime.archivedRolloutPath(sessionId);
    if (stale) {
      await client.call("thread/delete", { threadId: sessionId }).catch(() => undefined);
      rmSync(stale, { force: true });
    }
    const destination = target;

    const original = readFileSync(join(request.extractedDir, rolloutFile.path), "utf8");
    const rewritten = rewriteRolloutCwd(original, state.originalCwd, request.cwd).text;
    mkdirSync(dirname(destination), { recursive: true });
    const temp = `${destination}.${process.pid}.tmp`;
    writeFileSync(temp, rewritten, { mode: 0o600 });
    renameSync(temp, destination);

    // The app-server indexes the rollout when it first reads it. Read, then load the thread.
    const { thread } = await client.call<{ thread: { id: string; cwd: string } }>("thread/read", { threadId: sessionId, includeTurns: false });
    if (thread.id !== sessionId) throw new Error(`Imported rollout reads back as thread ${thread.id}, not ${sessionId}`);
    if (thread.cwd !== request.cwd) throw new Error(`Imported thread points at ${thread.cwd}, expected ${request.cwd}`);
    const turns = await client.call<{ data: unknown[] }>("thread/turns/list", { threadId: sessionId, limit: 1 });
    if (!Array.isArray(turns.data)) throw new Error("Imported thread has no readable history");
    await client.call("thread/resume", { threadId: sessionId, excludeTurns: true });
    await client.call("thread/unsubscribe", { threadId: sessionId }).catch(() => undefined);
    if (state.threadName) await client.call("thread/name/set", { threadId: sessionId, name: state.threadName }).catch(() => undefined);
    // Imported: the rollback copy is no longer needed.
    rmSync(join(this.serverDir, "imported", `${sessionId}.rollout.bak`), { force: true });
  }

  async restore(sessionId: string, snapshot: unknown): Promise<void> {
    const before = (snapshot ?? { wasArchived: false }) as CodexImportSnapshot;
    const client = await this.runtime.client().catch(() => undefined);
    await client?.call("thread/unsubscribe", { threadId: sessionId }).catch(() => undefined);
    const current = this.runtime.rolloutPath(sessionId);
    if (before.backup) {
      if (current) rmSync(current, { force: true });
      mkdirSync(dirname(before.backup.path), { recursive: true });
      copyFileSync(before.backup.saved, before.backup.path);
      rmSync(before.backup.saved, { force: true });
    } else {
      if (current) rmSync(current, { force: true });
      await client?.call("thread/delete", { threadId: sessionId }).catch(() => undefined);
    }
  }

  async preflight(context: MovePreflightContext): Promise<void> {
    this.runtime.assertPinned();
    this.runtime.version();
    if (context.side === "source") {
      if (!this.runtime.rolloutPath(context.sessionId)) throw new Error(`Unknown Codex thread: ${context.sessionId}`);
      await this.refreshBusy(context.sessionId);
    } else {
      await this.runtime.ensureDaemon();
      if (!existsSync(this.runtime.home)) throw new Error(`CODEX_HOME ${this.runtime.home} does not exist on this host`);
    }
  }
}
