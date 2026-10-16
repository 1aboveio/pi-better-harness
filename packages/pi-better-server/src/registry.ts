import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createAgentSession, SessionManager, type AgentSession, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { readGitBranch } from "./git.ts";
import { join } from "node:path";
import { EventLog, type EventLogOptions } from "./event-log.ts";
import { HostedSession } from "./hosted-session.ts";
import { indexPathFor } from "./paths.ts";
import type { DaemonCommand, SessionStatus, SessionSummary } from "./protocol.ts";

interface IndexEntry {
  sessionId: string;
  cwd: string;
  sessionFile: string;
  status: SessionStatus;
  name?: string;
  /** Last model in use; covers a session that crashed before its first message reached disk. */
  model?: { provider: string; modelId: string };
  createdAt: string;
  updatedAt: string;
}

interface IndexFile {
  version: 1;
  sessions: IndexEntry[];
}

export type CreateSessionRequest = Extract<DaemonCommand, { type: "create_session" }>;

export interface SessionRegistryOptions {
  serverDir: string;
  /** Extra `createAgentSession` options for every hosted session (resource loader, tools, ...). */
  sessionOptions?: Omit<CreateAgentSessionOptions, "cwd" | "sessionManager">;
  log?: (message: string) => void;
  /** Bounds for each session's replay ring and on-disk event log. */
  eventLog?: EventLogOptions;
}

/**
 * Owns every hosted session and the on-disk index that says which ones should
 * be running. The index holds only routing facts (id, cwd, session file,
 * status); the conversation itself lives in the normal Pi session JSONL.
 * A session is "running" until someone closes it, so a daemon that dies
 * (even by kill -9) comes back up with the same set.
 */
export class SessionRegistry {
  private readonly entries = new Map<string, IndexEntry>();
  private readonly live = new Map<string, HostedSession>();
  private readonly pending = new Map<string, Promise<HostedSession>>();
  private readonly resumeErrors = new Map<string, string>();
  private readonly log: (message: string) => void;
  private readonly options: SessionRegistryOptions;

  constructor(options: SessionRegistryOptions) {
    this.options = options;
    this.log = options.log ?? (() => undefined);
    this.load();
  }

  /** Resume every session the index marks running, at its last persisted entry. */
  async resumeAll(): Promise<void> {
    const running = [...this.entries.values()].filter((entry) => entry.status === "running");
    await Promise.all(
      running.map(async (entry) => {
        try {
          await this.host(entry);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.resumeErrors.set(entry.sessionId, message);
          this.log(`failed to resume ${entry.sessionId}: ${message}`);
        }
      }),
    );
  }

  list(): SessionSummary[] {
    return [...this.entries.values()].map((entry) => this.summarize(entry)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(sessionId: string): HostedSession | undefined {
    return this.live.get(sessionId);
  }

  resumeError(sessionId: string): string | undefined {
    return this.resumeErrors.get(sessionId);
  }

  async create(request: CreateSessionRequest): Promise<SessionSummary> {
    const sessionId = randomUUID();
    const cwd = request.cwd ?? process.cwd();
    const manager = SessionManager.create(cwd, undefined, { id: sessionId });
    const now = new Date().toISOString();
    const entry: IndexEntry = { sessionId, cwd, sessionFile: manager.getSessionFile() ?? "", status: "running", createdAt: now, updatedAt: now };
    this.entries.set(sessionId, entry);
    try {
      const hosted = await this.host(entry, manager);
      if (request.model) {
        const models = await hosted.session.modelRuntime.getAvailable();
        const model = models.find((m) => m.provider === request.model?.provider && m.id === request.model?.modelId);
        if (!model) throw new Error(`Model not found: ${request.model.provider}/${request.model.modelId}`);
        await hosted.session.setModel(model);
      }
      if (request.thinkingLevel) hosted.session.setThinkingLevel(request.thinkingLevel);
      if (request.name) hosted.session.setSessionName(request.name);
      this.touch(sessionId);
    } catch (error) {
      await this.discard(sessionId);
      throw error;
    }
    this.persist();
    return this.summarize(entry);
  }

  /** Attach to a hosted session, or bring a closed / not-yet-resumed one back to life. */
  async open(sessionId: string): Promise<SessionSummary> {
    const entry = this.entries.get(sessionId);
    if (!entry) throw new Error(`Unknown session: ${sessionId}`);
    if (!this.live.has(sessionId)) {
      entry.status = "running";
      await this.host(entry);
      this.resumeErrors.delete(sessionId);
      this.persist();
    }
    return this.summarize(entry);
  }

  /** Stop the session for good: abort any turn, release it, and do not resume it on boot. */
  async close(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) throw new Error(`Unknown session: ${sessionId}`);
    const hosted = this.live.get(sessionId);
    this.live.delete(sessionId);
    this.pending.delete(sessionId);
    if (hosted) await hosted.dispose({ abort: true });
    entry.status = "closed";
    entry.updatedAt = new Date().toISOString();
    this.resumeErrors.delete(sessionId);
    this.persist();
  }

  /** Release every live session without changing what the index says should be running. */
  async shutdown(): Promise<void> {
    const hosted = [...this.live.values()];
    this.live.clear();
    await Promise.all(hosted.map((session) => session.dispose({ abort: true })));
  }

  private async discard(sessionId: string): Promise<void> {
    const hosted = this.live.get(sessionId);
    this.live.delete(sessionId);
    this.entries.delete(sessionId);
    if (hosted) await hosted.dispose({ abort: true });
  }

  private host(entry: IndexEntry, manager?: SessionManager): Promise<HostedSession> {
    const existing = this.live.get(entry.sessionId);
    if (existing) return Promise.resolve(existing);
    const inFlight = this.pending.get(entry.sessionId);
    if (inFlight) return inFlight;
    const started = this.start(entry, manager).finally(() => this.pending.delete(entry.sessionId));
    this.pending.set(entry.sessionId, started);
    return started;
  }

  private async start(entry: IndexEntry, manager?: SessionManager): Promise<HostedSession> {
    const sessionManager = manager ?? this.reopen(entry);
    const { session } = await createAgentSession({ ...this.options.sessionOptions, cwd: entry.cwd, sessionManager });
    if (!manager) await this.restoreSavedModel(session, sessionManager, entry.model);
    const events = new EventLog(join(this.options.serverDir, "events", `${entry.sessionId}.jsonl`), this.options.eventLog);
    const hosted = new HostedSession(session, events, () => this.touch(entry.sessionId));
    await hosted.bindUi();
    this.live.set(entry.sessionId, hosted);
    entry.sessionFile = session.sessionFile ?? entry.sessionFile;
    this.persist();
    return hosted;
  }

  /**
   * Pi restores a session's model before extension-provided providers register,
   * so a model from such a provider falls back to the default. Put the saved one
   * back without writing a new model_change entry: resuming must not alter history.
   */
  private async restoreSavedModel(session: AgentSession, manager: SessionManager, indexed: IndexEntry["model"]): Promise<void> {
    const saved = manager.buildSessionContext().model ?? indexed;
    if (!saved || (session.model?.provider === saved.provider && session.model.id === saved.modelId)) return;
    const model = (await session.modelRuntime.getAvailable()).find((m) => m.provider === saved.provider && m.id === saved.modelId);
    if (model) session.agent.state.model = model;
  }

  /** Reopen at the last persisted entry; a session that never reached disk restarts empty under the same id. */
  private reopen(entry: IndexEntry): SessionManager {
    if (entry.sessionFile && existsSync(entry.sessionFile)) return SessionManager.open(entry.sessionFile, undefined, entry.cwd);
    return SessionManager.create(entry.cwd, undefined, { id: entry.sessionId });
  }

  private touch(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.updatedAt = new Date().toISOString();
    const name = this.live.get(sessionId)?.session.sessionName;
    if (name) entry.name = name;
    const model = this.live.get(sessionId)?.session.model;
    if (model) entry.model = { provider: model.provider, modelId: model.id };
    this.persist();
  }

  private summarize(entry: IndexEntry): SessionSummary {
    const hosted = this.live.get(entry.sessionId);
    const model = hosted?.session.model;
    const name = hosted?.session.sessionName ?? entry.name;
    const branch = readGitBranch(entry.cwd);
    return {
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      sessionFile: entry.sessionFile,
      status: entry.status,
      ...(name ? { name } : {}),
      ...(model ? { model: `${model.provider}/${model.id}` } : {}),
      ...(branch ? { branch } : {}),
      isStreaming: hosted?.isStreaming ?? false,
      lastSeq: hosted?.lastSeq ?? 0,
      hasController: hosted?.hasController ?? false,
      needsInput: hosted?.needsInput ?? [],
      live: hosted !== undefined,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }

  private load(): void {
    const path = indexPathFor(this.options.serverDir);
    if (!existsSync(path)) return;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as IndexFile;
    for (const entry of parsed.sessions) this.entries.set(entry.sessionId, entry);
  }

  private persist(): void {
    const path = indexPathFor(this.options.serverDir);
    const file: IndexFile = { version: 1, sessions: [...this.entries.values()] };
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  }
}
