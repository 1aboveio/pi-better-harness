import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SettingsManager, SessionManager, type AgentSession, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { SessionActivity } from "./session-activity.ts";
import { readGitBranch } from "./git.ts";
import { join } from "node:path";
import { EventLog, type EventLogOptions } from "./event-log.ts";
import { HostedSession } from "./hosted-session.ts";
import { checkProviderAuth } from "./move/auth.ts";
import { OwnershipStore } from "./core/ownership.ts";
import { indexPathFor, ownershipPathFor } from "./paths.ts";
import type { DaemonCommand, SessionStatus, SessionSummary } from "./protocol.ts";

export interface IndexEntry {
  sessionId: string;
  cwd: string;
  sessionFile: string;
  status: SessionStatus;
  name?: string;
  /** Last model in use; covers a session that crashed before its first message reached disk. */
  model?: { provider: string; modelId: string };
  createdAt: string;
  updatedAt: string;
  /** Meaningful activity, independent of metadata writes. Offline time counts as idle. */
  lastActivityAt?: string;
  /** Recovery marker only, never evidence that interrupted work should be replayed. */
  activityBusy?: boolean;
}

interface IndexFile {
  version: 1;
  sessions: IndexEntry[];
}

export type CreateSessionRequest = Extract<DaemonCommand, { type: "create_session" }>;

export interface SessionRegistryOptions {
  serverDir: string;
  /** Inactivity expiry; zero disables it. Defaults to 24 hours. */
  sessionIdleMs?: number;
  now?: () => number;
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
  /** Sessions being released: a new host for the same id waits, so two EventLogs never share a file. */
  private readonly releasing = new Map<string, Promise<void>>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly resumeErrors = new Map<string, string>();
  private readonly log: (message: string) => void;
  private readonly options: SessionRegistryOptions;
  private readonly now: () => number;
  private readonly sessionIdleMs: number;
  private creating = 0;
  private stopping = false;
  private shutdownTask: Promise<void> | undefined;
  /** Which sessions this daemon may write to; fenced and moved-away sessions are not resumed or opened. */
  readonly ownership: OwnershipStore;

  constructor(options: SessionRegistryOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.sessionIdleMs = options.sessionIdleMs ?? 86_400_000;
    if (!Number.isFinite(this.sessionIdleMs) || this.sessionIdleMs < 0) throw new Error("sessionIdleMs must be a non-negative finite number");
    this.log = options.log ?? (() => undefined);
    this.ownership = new OwnershipStore(ownershipPathFor(options.serverDir));
    this.load();
  }

  /** Owned running entries include failed resumes: they may still be recoverable. */
  get activeCount(): number {
    return [...this.entries.values()].filter((entry) => entry.status === "running" && !this.ownership.blockedReason(entry.sessionId)).length;
  }

  get hasPendingOperations(): boolean {
    return this.creating > 0 || this.operations.size > 0 || this.pending.size > 0 || this.releasing.size > 0;
  }

  /** Recheck under the same serialization as open/close; no await between the final check and fencing. */
  async expireIdle(now = this.now()): Promise<string[]> {
    if (this.sessionIdleMs === 0) return [];
    const expired = await Promise.all([...this.entries.keys()].map((sessionId) => this.serialize(sessionId, async () => {
      const entry = this.entries.get(sessionId);
      const hosted = this.live.get(sessionId);
      if (!entry || entry.status !== "running" || !hosted || this.ownership.blockedReason(sessionId)) return undefined;
      await hosted.refreshActivity();
      if (this.ownership.blockedReason(sessionId)) return undefined;
      this.workChanged(sessionId);
      const last = Date.parse(entry.lastActivityAt ?? entry.updatedAt);
      if (hosted.executionActive || hosted.activityChecking || !Number.isFinite(last) || now - last < this.sessionIdleMs) return undefined;
      // dispose fences dispatch synchronously, including references fetched before this expiry.
      await this.closeNow(sessionId);
      return sessionId;
    })));
    return expired.filter((id): id is string => id !== undefined);
  }

  /** Resume every session the index marks running, at its last persisted entry. */
  async resumeAll(): Promise<void> {
    const running = [...this.entries.values()].filter((entry) => entry.status === "running" && !this.ownership.blockedReason(entry.sessionId));
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
    if (this.stopping) throw new Error("Session registry is shutting down");
    this.creating++;
    try { return await this.createNow(request); }
    finally { this.creating--; }
  }

  private async createNow(request: CreateSessionRequest): Promise<SessionSummary> {
    const sessionId = randomUUID();
    const cwd = request.cwd ?? process.cwd();
    const manager = SessionManager.create(cwd, undefined, { id: sessionId });
    const now = new Date(this.now()).toISOString();
    const entry: IndexEntry = { sessionId, cwd, sessionFile: manager.getSessionFile() ?? "", status: "running", createdAt: now, updatedAt: now, lastActivityAt: now };
    this.entries.set(sessionId, entry);
    return this.serialize(sessionId, async () => {
      try {
        const hosted = await this.host(entry, manager, !request.model && !this.options.sessionOptions?.model);
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
    });
  }

  /** Attach to a hosted session, or bring a closed / not-yet-resumed one back to life. */
  open(sessionId: string): Promise<SessionSummary> {
    return this.serialize(sessionId, () => this.openNow(sessionId));
  }

  /** Rename without hosting a closed session or changing its lifecycle state. */
  rename(sessionId: string, name: string): Promise<SessionSummary> {
    return this.serialize(sessionId, async () => {
      const entry = this.entries.get(sessionId);
      if (!entry) throw new Error(`Unknown session: ${sessionId}`);
      const blocked = this.ownership.blockedReason(sessionId);
      if (blocked) throw new Error(blocked);
      if (typeof name !== "string" || !name.trim()) throw new Error("name must be a non-empty string");
      const trimmed = name.trim();
      const hosted = this.live.get(sessionId);
      if (hosted) {
        hosted.session.setSessionName(trimmed);
        this.touch(sessionId, false);
      } else {
        let savedName = trimmed;
        if (entry.sessionFile && existsSync(entry.sessionFile)) {
          const manager = SessionManager.open(entry.sessionFile, undefined, entry.cwd);
          manager.appendSessionInfo(trimmed);
          savedName = manager.getSessionName() ?? trimmed;
        }
        entry.name = savedName;
        entry.updatedAt = new Date(this.now()).toISOString();
        this.persist();
      }
      return this.summarize(entry);
    });
  }

  /**
   * Run open / rename / close / retire / release / forget for one session one after another,
   * so each sees the settled result of the one before and the last call wins:
   * `closed` and a live session can never coexist once the calls have settled.
   */
  private serialize<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error("Session registry is shutting down"));
    const prior = this.operations.get(sessionId) ?? Promise.resolve();
    const result = prior.then(run, run);
    const tail = result.catch(() => undefined);
    this.operations.set(sessionId, tail);
    void tail.then(() => {
      if (this.operations.get(sessionId) === tail) this.operations.delete(sessionId);
    });
    return result;
  }

  private async openNow(sessionId: string): Promise<SessionSummary> {
    const entry = this.entries.get(sessionId);
    if (!entry) throw new Error(`Unknown session: ${sessionId}`);
    const blocked = this.ownership.blockedReason(sessionId);
    if (blocked) throw new Error(blocked);
    const releasing = this.releasing.get(sessionId);
    if (releasing) await releasing;
    if (!this.live.has(sessionId)) {
      entry.status = "running";
      await this.host(entry);
      this.resumeErrors.delete(sessionId);
      this.persist();
    }
    this.touch(sessionId);
    return this.summarize(entry);
  }

  /** Stop the session for good: abort any turn, release it, and do not resume it on boot. */
  close(sessionId: string): Promise<void> {
    if (!this.entries.has(sessionId)) return Promise.reject(new Error(`Unknown session: ${sessionId}`));
    return this.serialize(sessionId, () => this.closeNow(sessionId));
  }

  private async closeNow(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) throw new Error(`Unknown session: ${sessionId}`);
    await this.releaseLive(sessionId, true);
    entry.status = "closed";
    entry.activityBusy = false;
    entry.updatedAt = new Date(this.now()).toISOString();
    this.resumeErrors.delete(sessionId);
    this.persist();
  }

  /** The index row for a session, or undefined. */
  entry(sessionId: string): Readonly<IndexEntry> | undefined {
    return this.entries.get(sessionId);
  }

  /** Release one live session without changing what the index says; the opposite of `open`. Used to fence it. */
  release(sessionId: string): Promise<void> {
    return this.serialize(sessionId, () => this.releaseLive(sessionId, false));
  }

  /**
   * Take a session out of `live` and dispose it. A start still in flight is awaited
   * first, so it cannot register itself after the release; `releasing` holds new hosts
   * back until the old session's events have stopped.
   */
  private releaseLive(sessionId: string, abort: boolean): Promise<void> {
    const prior = this.releasing.get(sessionId);
    this.live.get(sessionId)?.fence();
    const run = (async () => {
      await prior;
      await this.pending.get(sessionId)?.catch(() => undefined);
      const hosted = this.live.get(sessionId);
      this.live.delete(sessionId);
      if (hosted) await hosted.dispose({ abort });
    })();
    const tracked = run.finally(() => {
      if (this.releasing.get(sessionId) === tracked) this.releasing.delete(sessionId);
    });
    this.releasing.set(sessionId, tracked);
    return tracked;
  }

  /** Mark a session whose ownership went to another daemon as closed here. */
  retire(sessionId: string): Promise<void> {
    return this.serialize(sessionId, async () => {
      await this.releaseLive(sessionId, false);
      const entry = this.entries.get(sessionId);
      if (entry) {
        entry.status = "closed";
        entry.updatedAt = new Date(this.now()).toISOString();
        this.persist();
      }
    });
  }

  /** Dry-run the provider's credentials as a session on this daemon would resolve them. */
  checkProviderAuth(provider: string): Promise<void> {
    return checkProviderAuth(provider, this.options.serverDir, this.options.sessionOptions);
  }

  /** Add (or replace a closed) session that arrived from another daemon, then host it. */
  async adopt(entry: IndexEntry): Promise<SessionSummary> {
    if (this.stopping) throw new Error("Session registry is shutting down");
    if (this.live.has(entry.sessionId)) throw new Error(`Session ${entry.sessionId} is already live here`);
    this.entries.set(entry.sessionId, { ...entry, status: "running" });
    try {
      return await this.open(entry.sessionId);
    } catch (error) {
      this.entries.delete(entry.sessionId);
      this.persist();
      throw error;
    }
  }

  /** Drop a session adopted by a move that is being rolled back. */
  forget(sessionId: string, previous: IndexEntry | undefined): Promise<void> {
    return this.serialize(sessionId, async () => {
      await this.releaseLive(sessionId, false);
      if (previous) this.entries.set(sessionId, previous);
      else this.entries.delete(sessionId);
      this.persist();
    });
  }

  /** Release every live session without changing what the index says should be running. */
  shutdown(): Promise<void> {
    this.stopping = true;
    this.shutdownTask ??= (async () => {
      await Promise.allSettled([...this.operations.values(), ...this.pending.values(), ...this.releasing.values()]);
      const hosted = [...this.live.values()];
      this.live.clear();
      await Promise.all(hosted.map((session) => session.dispose({ abort: true })));
    })();
    return this.shutdownTask;
  }

  private async discard(sessionId: string): Promise<void> {
    const hosted = this.live.get(sessionId);
    this.live.delete(sessionId);
    this.entries.delete(sessionId);
    if (hosted) await hosted.dispose({ abort: true });
  }

  private host(entry: IndexEntry, manager?: SessionManager, useDefaultModel = false): Promise<HostedSession> {
    const releasing = this.releasing.get(entry.sessionId);
    if (releasing) return releasing.then(() => this.host(entry, manager, useDefaultModel));
    const existing = this.live.get(entry.sessionId);
    if (existing) return Promise.resolve(existing);
    const inFlight = this.pending.get(entry.sessionId);
    if (inFlight) return inFlight;
    const started = this.start(entry, manager, useDefaultModel).finally(() => this.pending.delete(entry.sessionId));
    this.pending.set(entry.sessionId, started);
    return started;
  }

  private async start(entry: IndexEntry, manager?: SessionManager, useDefaultModel = false): Promise<HostedSession> {
    const sessionManager = manager ?? this.reopen(entry);
    const activity = new SessionActivity(this.log);
    let session: AgentSession | undefined;
    let hosted: HostedSession | undefined;
    try {
      const supplied = this.options.sessionOptions;
      const settingsManager = supplied?.settingsManager ?? SettingsManager.create(entry.cwd, supplied?.agentDir ?? getAgentDir());
      let resourceLoader = supplied?.resourceLoader;
      if (!resourceLoader) {
        resourceLoader = new DefaultResourceLoader({
          cwd: entry.cwd, agentDir: supplied?.agentDir ?? getAgentDir(), settingsManager, eventBus: activity.runtimeEvents,
          extensionsOverride: (base) => ({
            ...base,
            extensions: base.extensions.map((extension) => ({
              ...extension,
              tools: new Map([...extension.tools].map(([name, tool]) => [name, { ...tool, definition: activity.wrapTool(tool.definition) }])),
            })),
          }),
        });
        const reload = resourceLoader.reload.bind(resourceLoader);
        resourceLoader.reload = async (...args) => {
          // SDK 0.82 leaves pi.events subscriptions alive after session_shutdown.
          // Revoke them before factories run, including listeners added during shutdown.
          // extensionsOverride runs too late: new factories have already subscribed there.
          activity.resetRuntime();
          await reload(...args);
        };
        await resourceLoader.reload();
      } else {
        this.log(`session ${entry.sessionId}: automatic expiry disabled with a caller-owned resource loader because background activity is unobservable`);
        activity.markUnobservable();
      }
      ({ session } = await createAgentSession({ ...supplied, customTools: supplied?.customTools?.map((tool) => activity.wrapTool(tool)), settingsManager, resourceLoader, cwd: entry.cwd, sessionManager }));
      if (useDefaultModel) await this.initializeDefaultModel(session);
      if (!manager) await this.restoreSavedModel(session, sessionManager, entry.model);
      const events = new EventLog(join(this.options.serverDir, "events", `${entry.sessionId}.jsonl`), this.options.eventLog);
      const runtime = new HostedSession(session, events, (kind) => {
        if (this.live.get(entry.sessionId) !== runtime || runtime.isDisposed) return;
        if (kind === "work") this.workChanged(entry.sessionId);
        else this.touch(entry.sessionId, kind !== "metadata");
      }, activity);
      hosted = runtime;
      await runtime.bindUi();
      this.live.set(entry.sessionId, runtime);
      // Restoring context never replays interrupted tools. A confirmed interrupted run gets a fresh window.
      if (entry.activityBusy) entry.lastActivityAt = new Date(this.now()).toISOString();
      entry.activityBusy = runtime.executionActive;
      entry.sessionFile = session.sessionFile ?? entry.sessionFile;
      this.persist();
      return runtime;
    } catch (error) {
      this.live.delete(entry.sessionId);
      activity.dispose();
      if (hosted) await hosted.dispose({ abort: true });
      else session?.dispose();
      throw error;
    }
  }

  /** Extension providers register after the SDK selects its initial model. Only new sessions use defaults. */
  private async initializeDefaultModel(session: AgentSession): Promise<void> {
    const provider = session.settingsManager.getDefaultProvider();
    const modelId = session.settingsManager.getDefaultModel();
    if (!provider || !modelId) return;
    if (session.model?.provider === provider && session.model.id === modelId) return;
    const model = session.modelRuntime.getModel(provider, modelId);
    const unavailable = () => new Error(`Configured model ${provider}/${modelId} is unavailable. Check the daemon's provider extension, credentials, and default model settings, or request an explicit model.`);
    if (!model) throw unavailable();
    // Legacy SDK setters save defaults. Isolate only those writes, never mutate or
    // restore shared settings while an asynchronous credential check is in flight.
    const settings = session.settingsManager;
    const descriptor = Object.getOwnPropertyDescriptor(session, "settingsManager");
    const sessionSettings = new Proxy(settings, {
      get(target, key) {
        if (["setDefaultModelAndProvider", "setDefaultThinkingLevel", "setModelThinkingLevel"].includes(String(key))) return () => {};
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      Object.defineProperty(session, "settingsManager", { value: sessionSettings, configurable: true, writable: true });
      await session.setModel(model);
      if (this.options.sessionOptions?.thinkingLevel !== undefined) {
        session.setThinkingLevel(this.options.sessionOptions.thinkingLevel);
      }
    } catch {
      // Auth failures can contain credential helper output. Do not expose it to clients.
      throw unavailable();
    } finally {
      if (descriptor) Object.defineProperty(session, "settingsManager", descriptor);
      else delete (session as unknown as Record<string, unknown>).settingsManager;
    }
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
    const manager = SessionManager.create(entry.cwd, undefined, { id: entry.sessionId });
    // Setup-only sessions have no transcript; their indexed name must reach the new manager.
    if (entry.name) manager.appendSessionInfo(entry.name);
    return manager;
  }

  private workChanged(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    const hosted = this.live.get(sessionId);
    if (!entry || !hosted || hosted.isDisposed) return;
    const busy = hosted.executionActive;
    if (busy === !!entry.activityBusy) return;
    entry.activityBusy = busy;
    if (!busy) this.touch(sessionId);
    else this.persist();
  }

  private touch(sessionId: string, meaningful = true): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.updatedAt = new Date(this.now()).toISOString();
    if (meaningful) entry.lastActivityAt = entry.updatedAt;
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
    const owned = this.ownership.get(entry.sessionId).state;
    return {
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      sessionFile: entry.sessionFile,
      status: entry.status,
      ...(name ? { name } : {}),
      ...(model ? { model: `${model.provider}/${model.id}` } : {}),
      ...(branch ? { branch } : {}),
      ...(owned !== "owned" ? { ownership: owned } : {}),
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
    for (const entry of parsed.sessions) {
      entry.lastActivityAt ??= entry.updatedAt;
      this.entries.set(entry.sessionId, entry);
    }
  }

  private persist(): void {
    const path = indexPathFor(this.options.serverDir);
    const file: IndexFile = { version: 1, sessions: [...this.entries.values()] };
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  }
}
