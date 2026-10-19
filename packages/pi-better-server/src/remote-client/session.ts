import { posix, win32 } from "node:path";
import { buildContextEntries, buildSessionContext, SettingsManager, type RpcSessionState } from "@earendil-works/pi-coding-agent";
import type { DaemonClient } from "../client.ts";
import { remoteArgumentCompletions } from "./menu.ts";

// Wire metadata and native UI objects differ between Pi 0.82 (repo types) and 1.2.
// These values are presentation data only; none are an executable Agent or provider.
type Presentation = Record<string, any>;
type SessionEvent = Presentation & { type: string };
type Envelope = { sessionId?: string; seq?: unknown; generation?: unknown; event?: any };
type Listener = (event: any) => void | Promise<void>;

export interface ClientSnapshot {
  generation: string;
  lastSeq: number;
  sessionId: string;
  cwd: string;
  name?: string;
  sessionFile: string;
  state: RpcSessionState;
  messages: any[];
  entries: any[];
  leafId: string | null;
  tools: any[];
  commands: any[];
  models: any[];
  contextUsage: any;
  stats: any;
  activeMessage?: any;
  activeTools?: any[];
}

export interface RemoteClientSessionOptions {
  onDisconnect?: () => void;
  onLocalCommand?: (text: string) => Promise<boolean>;
}

function unsupported(operation: string): never {
  throw new Error(`${operation} is not supported by the remote session; no local execution or persistence is allowed`);
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

// Only display metadata crosses into the presentation cache. Transport options
// (including headers and credential-bearing URLs) are never needed by the UI.
function modelMetadata(model: any): any {
  if (model == null) return model;
  const safe: Presentation = {};
  for (const key of ["id", "provider", "name", "api", "reasoning", "input", "cost", "contextWindow", "maxTokens",
    "thinkingLevels", "subscription", "authType"]) {
    if (Object.hasOwn(model, key)) safe[key] = copy(model[key]);
  }
  return safe;
}

function sanitizeModels(value: Presentation): void {
  if (value.model && typeof value.model === "object") value.model = modelMetadata(value.model);
  if (Array.isArray(value.models)) value.models = value.models.map(modelMetadata);
  if (Array.isArray(value.scopedModels)) {
    value.scopedModels = value.scopedModels.map(({ model, thinkingLevel }: Presentation) => ({ model: modelMetadata(model), thinkingLevel }));
  }
  if (value.routedModel) {
    value.routedModel = { model: modelMetadata(value.routedModel.model), thinkingLevel: value.routedModel.thinkingLevel };
  }
}

export class SnapshotRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotRequiredError";
  }
}

function validateSnapshot(snapshot: ClientSnapshot): void {
  if (!snapshot || typeof snapshot.generation !== "string" || !snapshot.generation ||
    !Number.isSafeInteger(snapshot.lastSeq) || snapshot.lastSeq < 0 ||
    typeof snapshot.sessionId !== "string" || typeof snapshot.cwd !== "string" ||
    typeof snapshot.sessionFile !== "string" || !snapshot.state ||
    ![snapshot.messages, snapshot.entries, snapshot.tools, snapshot.commands, snapshot.models].every(Array.isArray) ||
    !(snapshot.leafId === null || typeof snapshot.leafId === "string")) {
    throw new Error("Invalid client_snapshot response");
  }
}

/** The authoritative remote projection. Exported so replay semantics can be tested without faking a daemon. */
export class RemoteSessionCache {
  snapshot!: ClientSnapshot;
  streamingMessage: any;
  readonly pendingToolCalls = new Set<string>();
  readonly toolExecutions = new Map<string, any>();
  steering: string[] = [];
  followUp: string[] = [];
  retryAttempt = 0;
  private messageIndex: number | undefined;
  private readonly argumentBuffers = new Map<number, string>();

  constructor(snapshot: ClientSnapshot) {
    this.replace(snapshot);
  }

  replace(snapshot: ClientSnapshot): void {
    validateSnapshot(snapshot);
    this.snapshot = copy(snapshot);
    sanitizeModels(this.snapshot);
    sanitizeModels(this.snapshot.state);
    const state = this.snapshot.state as Presentation;
    this.steering = copy(state.steering ?? []);
    this.followUp = copy(state.followUp ?? []);
    this.retryAttempt = state.retryAttempt ?? 0;
    this.pendingToolCalls.clear();
    this.toolExecutions.clear();
    this.streamingMessage = copy(snapshot.activeMessage ?? state.streamMessage);
    for (const tool of snapshot.activeTools ?? []) {
      this.pendingToolCalls.add(tool.toolCallId);
      this.toolExecutions.set(tool.toolCallId, copy(tool));
    }
    const last = this.snapshot.messages.length - 1;
    this.messageIndex = this.streamingMessage && last >= 0 &&
      JSON.stringify(this.snapshot.messages[last]) === JSON.stringify(this.streamingMessage) ? last : undefined;
    this.argumentBuffers.clear();
  }

  get state(): Presentation {
    return { ...this.snapshot.state, messages: this.snapshot.messages, tools: this.snapshot.tools,
      streamMessage: this.streamingMessage, pendingToolCalls: new Set(this.pendingToolCalls) };
  }

  /** Reject gaps before touching state. Duplicate/replayed events have no observable effect. */
  apply(envelope: Envelope): SessionEvent | undefined {
    if (envelope.sessionId !== this.snapshot.sessionId) return undefined;
    if (envelope.generation !== undefined && envelope.generation !== this.snapshot.generation) {
      throw new SnapshotRequiredError("Remote session generation changed");
    }
    const seq = envelope.seq;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
      throw new SnapshotRequiredError("Invalid remote event sequence");
    }
    if (seq <= this.snapshot.lastSeq) return undefined;
    if (seq !== this.snapshot.lastSeq + 1) throw new SnapshotRequiredError("Remote event sequence has a gap");
    const event = copy(envelope.event) as SessionEvent;
    if (!event || typeof event.type !== "string") throw new SnapshotRequiredError("Invalid remote event");
    sanitizeModels(event);
    const state = this.snapshot.state as Presentation;
    switch (event.type) {
      case "agent_start":
        state.isStreaming = true;
        this.pendingToolCalls.clear();
        this.toolExecutions.clear();
        break;
      // Pi 1.2 can retry/compact after agent_end. Only agent_settled is idle.
      case "agent_settled":
        state.isStreaming = false;
        state.isCompacting = false;
        this.retryAttempt = 0;
        this.streamingMessage = undefined;
        this.pendingToolCalls.clear();
        break;
      case "message_start":
        this.messageIndex = this.snapshot.messages.length;
        this.snapshot.messages.push(event.message);
        this.argumentBuffers.clear();
        if (event.message.role === "assistant") this.streamingMessage = event.message;
        break;
      case "message_update": {
        const message = event.message ?? this.updateDelta(event);
        if (!message) throw new SnapshotRequiredError("Streaming update has no starting message");
        event.message = message;
        this.streamingMessage = message;
        if (this.messageIndex === undefined) this.messageIndex = this.snapshot.messages.length;
        this.snapshot.messages[this.messageIndex] = message;
        break;
      }
      case "message_end":
        if (this.messageIndex === undefined) this.snapshot.messages.push(event.message);
        else this.snapshot.messages[this.messageIndex] = event.message;
        this.messageIndex = undefined;
        this.streamingMessage = undefined;
        this.argumentBuffers.clear();
        break;
      case "tool_execution_start":
        this.pendingToolCalls.add(event.toolCallId);
        this.toolExecutions.set(event.toolCallId, event);
        break;
      case "tool_execution_update":
        this.toolExecutions.set(event.toolCallId, event);
        break;
      case "tool_execution_end":
        this.pendingToolCalls.delete(event.toolCallId);
        this.toolExecutions.delete(event.toolCallId);
        break;
      case "queue_update":
        this.steering = event.steering;
        this.followUp = event.followUp;
        state.pendingMessageCount = this.steering.length + this.followUp.length;
        break;
      case "session_info_changed":
        this.snapshot.name = event.name;
        state.sessionName = event.name;
        break;
      case "thinking_level_changed": state.thinkingLevel = event.level; break;
      case "compaction_start":
      case "auto_compaction_start": state.isCompacting = true; break;
      case "compaction_end":
      case "auto_compaction_end": state.isCompacting = false; break;
      case "auto_retry_start": this.retryAttempt = event.attempt; break;
      case "auto_retry_end": this.retryAttempt = 0; break;
      case "entry_appended":
        if (!this.snapshot.entries.some((entry) => entry.id === event.entry.id)) {
          this.snapshot.entries.push(event.entry);
          this.snapshot.leafId = event.entry.id;
        }
        break;
    }
    this.snapshot.lastSeq = seq;
    return event;
  }

  private updateDelta(event: SessionEvent): any {
    if (!this.streamingMessage) return undefined;
    const message = copy(this.streamingMessage);
    const update = event.assistantMessageEvent;
    if (!update) return undefined;
    const index = update.contentIndex;
    const content = message.content;
    switch (update.type) {
      case "text_start": content[index] = { type: "text", text: "" }; break;
      case "thinking_start": content[index] = { type: "thinking", thinking: "" }; break;
      case "text_delta":
      case "thinking_delta": {
        const key = update.type === "text_delta" ? "text" : "thinking";
        content[index] ??= { type: key, [key]: "" };
        content[index][key] += update.delta;
        break;
      }
      case "text_end": content[index] = { type: "text", text: update.content }; break;
      case "thinking_end": content[index] = { type: "thinking", thinking: update.content }; break;
      case "toolcall_start":
        content[index] = { type: "toolCall", id: update.id, name: update.toolName, arguments: {} };
        this.argumentBuffers.set(index, "");
        break;
      case "toolcall_delta": {
        const json = (this.argumentBuffers.get(index) ?? "") + update.delta;
        this.argumentBuffers.set(index, json);
        try { content[index].arguments = JSON.parse(json); } catch { /* The final toolcall_end carries complete arguments. */ }
        break;
      }
      case "toolcall_end": content[index] = update.toolCall; break;
      case "done": return update.message;
      case "error": return update.error;
    }
    if (event.usage) message.usage = event.usage;
    return message;
  }
}

/** Presentation-only tree. Never instantiates a SessionManager or opens a session file. */
export class RemoteSessionManager {
  private readonly cache: RemoteSessionCache;
  constructor(cache: RemoteSessionCache) { this.cache = cache; }
  getCwd(): string { return this.cache.snapshot.cwd; }
  getSessionId(): string { return this.cache.snapshot.sessionId; }
  getSessionFile(): string { return this.cache.snapshot.sessionFile; }
  getSessionName(): string | undefined { return this.cache.snapshot.name; }
  getSessionDir(): string {
    const file = this.getSessionFile();
    return (file.includes("\\") ? win32 : posix).dirname(file);
  }
  isPersisted(): boolean { return Boolean(this.getSessionFile()); }
  usesDefaultSessionDir(): boolean { return false; }
  getLeafId(): string | null { return this.cache.snapshot.leafId; }
  getLeafEntry(): any { return this.getEntry(this.getLeafId() ?? ""); }
  getEntries(): any[] { return copy(this.cache.snapshot.entries); }
  getEntryCount(): number { return this.cache.snapshot.entries.length; }
  getChildren(parentId: string): any[] { return this.getEntries().filter((entry) => entry.parentId === parentId); }
  getEntry(id: string): any { return copy(this.cache.snapshot.entries.find((entry) => entry.id === id)); }
  getHeader(): never { return unsupported("Session header (not included in client_snapshot)"); }
  getBranch(fromId?: string): any[] {
    const entries = new Map(this.cache.snapshot.entries.map((entry) => [entry.id, entry]));
    const branch: any[] = [];
    const seen = new Set<string>();
    let entry = entries.get(fromId ?? this.getLeafId());
    while (entry && !seen.has(entry.id)) {
      seen.add(entry.id);
      branch.push(entry);
      entry = entries.get(entry.parentId);
    }
    return copy(branch.reverse());
  }
  buildContextEntries(): any[] {
    return copy(buildContextEntries(this.cache.snapshot.entries, this.getLeafId()));
  }
  buildSessionContext(): any {
    return copy(buildSessionContext(this.cache.snapshot.entries, this.getLeafId()));
  }
  getLabel(id: string): string | undefined {
    return this.cache.snapshot.entries.filter((entry) => entry.type === "label" && entry.targetId === id).at(-1)?.label;
  }
  getTree(): any[] {
    const entries = this.getEntries();
    const nodes = new Map<string, any>(entries.map((entry) => [entry.id, { entry, children: [], label: this.getLabel(entry.id) }]));
    const roots: any[] = [];
    for (const entry of entries) {
      const node = nodes.get(entry.id);
      const parent = nodes.get(entry.parentId);
      if (!parent || entry.parentId === entry.id) roots.push(node);
      else parent.children.push(node);
    }
    return roots;
  }
  appendMessage(): never { return unsupported("sessionManager.appendMessage"); }
  appendCustomEntry(): never { return unsupported("sessionManager.appendCustomEntry"); }
  appendCustomMessageEntry(): never { return unsupported("sessionManager.appendCustomMessageEntry"); }
  appendLabelChange(): never { return unsupported("sessionManager.appendLabelChange"); }
  appendSessionInfo(): never { return unsupported("sessionManager.appendSessionInfo"); }
  appendModelChange(): never { return unsupported("sessionManager.appendModelChange"); }
  appendThinkingLevelChange(): never { return unsupported("sessionManager.appendThinkingLevelChange"); }
  appendCompaction(): never { return unsupported("sessionManager.appendCompaction"); }
  appendUsage(): never { return unsupported("sessionManager.appendUsage"); }
  appendContextEdit(): never { return unsupported("sessionManager.appendContextEdit"); }
  branchWithSummary(): never { return unsupported("sessionManager.branchWithSummary"); }
  createBranchedSession(): never { return unsupported("sessionManager.createBranchedSession"); }
  branch(): never { return unsupported("sessionManager.branch"); }
  resetLeaf(): never { return unsupported("sessionManager.resetLeaf"); }
  newSession(): never { return unsupported("sessionManager.newSession"); }
  setSessionFile(): never { return unsupported("sessionManager.setSessionFile"); }
  flush(): never { return unsupported("sessionManager.flush"); }
}

/** Model metadata, never provider implementations, credentials, or a local catalog. */
export class RemoteModelRuntime {
  private readonly cache: RemoteSessionCache;
  private readonly refreshRemote?: () => Promise<void>;
  constructor(cache: RemoteSessionCache, refreshRemote?: () => Promise<void>) {
    this.cache = cache;
    this.refreshRemote = refreshRemote;
  }
  getAvailableSnapshot(): any[] { return copy(this.cache.snapshot.models); }
  async getAvailable(provider?: string): Promise<any[]> { return this.getModels(provider); }
  getModels(provider?: string): any[] { return this.getAvailableSnapshot().filter((model) => !provider || model.provider === provider); }
  getAllModels(provider?: string): any[] { return this.getModels(provider); }
  getModel(provider: string, id: string): any { return this.getModels(provider).find((model) => model.id === id); }
  getPhysicalModel(provider: string, id: string): any { return this.getModel(provider, id); }
  getProviders(): any[] {
    return [...new Set(this.cache.snapshot.models.map((model) => model.provider))].map((id) => ({ id, name: id, auth: {} }));
  }
  getProvider(id: string): any { return this.getProviders().find((provider) => provider.id === id); }
  getError(): undefined { return undefined; }
  // Subscription indication is metadata only, not an inference from local credentials.
  isUsingSubscription(provider: string): boolean { return this.getModels(provider).some((model) => model.subscription === true); }
  isUsingOAuth(provider: string): boolean { return this.getModels(provider).some((model) => model.authType === "oauth"); }
  getProviderAuthStatus(provider: string): any {
    return { configured: this.getModels(provider).length > 0, label: "Remote daemon" };
  }
  getAuth(): never { return unsupported("modelRuntime.getAuth (remote credentials)"); }
  checkAuth(): never { return unsupported("modelRuntime.checkAuth (remote credentials)"); }
  listCredentials(): never { return unsupported("modelRuntime.listCredentials"); }
  login(): never { return unsupported("modelRuntime.login"); }
  logout(): never { return unsupported("modelRuntime.logout"); }
  async refresh(): Promise<any> {
    if (!this.refreshRemote) return unsupported("modelRuntime.refresh (no remote connection)");
    await this.refreshRemote();
    return { aborted: false, errors: new Map() };
  }
  setRuntimeApiKey(): never { return unsupported("modelRuntime.setRuntimeApiKey"); }
  registerProvider(): never { return unsupported("modelRuntime.registerProvider"); }
  stream(): never { return unsupported("modelRuntime.stream"); }
  streamSimple(): never { return unsupported("modelRuntime.streamSimple"); }
  complete(): never { return unsupported("modelRuntime.complete"); }
  completeSimple(): never { return unsupported("modelRuntime.completeSimple"); }
  removeRuntimeApiKey(): never { return unsupported("modelRuntime.removeRuntimeApiKey"); }
  unregisterProvider(): never { return unsupported("modelRuntime.unregisterProvider"); }
}

export class RemoteClientSession {
  readonly sessionManager: RemoteSessionManager;
  readonly modelRuntime: RemoteModelRuntime;
  readonly extensionRunner: Presentation;
  readonly resourceLoader: Presentation;
  readonly agent: Presentation;
  // In-memory presentation preferences only. The bridge may replace these with
  // the existing local UI preferences; neither option persists remote state.
  settingsManager: any;
  private readonly client: DaemonClient;
  private readonly cache: RemoteSessionCache;
  private readonly options: RemoteClientSessionOptions;
  private readonly listeners = new Set<Listener>();
  private readonly dialogs = new Map<string, Presentation>();
  private readonly dialogControllers = new Map<string, AbortController>();
  private readonly uiRequests: SessionEvent[] = [];
  private readonly idleWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  private readonly eventWaiters = new Set<{ generation: string; seq: number; resolve: () => void; reject: (error: Error) => void }>();
  private subscribedSeq = 0;
  private uiContext: any;
  private bindings: Presentation = {};
  private detachEvents?: () => void;
  private deactivateClose?: () => void;
  private detached = false;
  private failed?: Error;
  private controller = false;
  private reconciling?: Promise<void>;
  private buffered: Envelope[] = [];
  private receiving = false;
  private bashOutput?: (chunk: string) => void;
  private bashRunning = false;
  private pendingBashSnapshot = false;

  private constructor(client: DaemonClient, snapshot: ClientSnapshot, options: RemoteClientSessionOptions) {
    this.client = client;
    this.options = options;
    this.cache = new RemoteSessionCache(snapshot);
    this.sessionManager = new RemoteSessionManager(this.cache);
    this.modelRuntime = new RemoteModelRuntime(this.cache, async () => {
      const data = await this.request("get_available_models");
      this.cache.snapshot.models = data.models.map(modelMetadata);
    });
    this.settingsManager = SettingsManager.inMemory();
    const session = this;
    this.agent = Object.freeze({
      get state() { return session.state; },
      get signal() { return session.presentationSignal.signal; },
      get transport() { return undefined; },
      hasQueuedMessages: () => this.pendingMessageCount > 0,
      abort: () => unsupported("agent.abort; use session.abort to abort remotely"),
      prompt: () => unsupported("agent.prompt; use session.prompt"),
      setModel: () => unsupported("agent.setModel; use session.setModel"),
      setTools: () => unsupported("agent.setTools"),
    });
    this.extensionRunner = Object.freeze({
      getRegisteredCommands: () => this.commands().filter((command) => command.source !== "prompt"),
      getCommand: (name: string) => this.commands().find((command) => command.invocationName === name),
      getCommandDiagnostics: () => [],
      getShortcutDiagnostics: () => [],
      getShortcuts: () => new Map(),
      getMarkdownTransformers: () => [],
      getEntryRenderer: () => undefined,
      getMessageRenderer: () => undefined,
      resolveToolRenderers: (_name: string, fallback: () => unknown) => fallback(),
      getModelRegistry: () => this.modelRuntime,
      hasHandlers: () => false,
      emit: async (event: SessionEvent) => {
        if (event.type !== "session_shutdown") return unsupported(`Local extension event '${event.type}'`);
        // Only the local presentation binding is shutting down, not the remote extensions.
      },
      // No local extension interceptors. executeBash forwards the actual execution to the daemon.
      emitUserBash: async () => undefined,
    });
    this.resourceLoader = Object.freeze({
      getExtensions: () => ({ extensions: [], errors: [], warnings: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: this.promptTemplates, diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPromptSource: () => undefined,
      getAppendSystemPromptSources: () => [],
      getPathMetadata: () => new Map(),
      reload: () => unsupported("resourceLoader.reload"),
    });
  }

  private readonly presentationSignal = new AbortController();

  static async connect(client: DaemonClient, sessionId: string, options: RemoteClientSessionOptions = {}): Promise<RemoteClientSession> {
    // Listen before reading the snapshot: the supplied client may already be subscribed.
    let session: RemoteClientSession | undefined;
    const early: Envelope[] = [];
    let closed = false;
    const detach = client.onEvent((event) => {
      if (event.sessionId !== sessionId) return;
      if (session) session.receive(event);
      else early.push(event);
    });
    const detachClose = client.onClose(() => { closed = true; session?.disconnect(); });
    try {
      const response = await client.call({ type: "client_snapshot", sessionId });
      validateSnapshot(response.data);
      if (response.data.sessionId !== sessionId) throw new Error("client_snapshot returned a different session");
      session = new RemoteClientSession(client, response.data, options);
      session.detachEvents = detach;
      session.deactivateClose = detachClose;
      if (closed) throw new Error("Remote connection closed during snapshot");
      session.buffered.push(...early);
      await session.resubscribe();
      const lease = await session.request("acquire_control");
      session.controller = true;
      for (const dialog of lease?.needsInput ?? []) session.dialogs.set(dialog.id, dialog);
      await session.loadThinkingLevels();
      session.receiving = true;
      session.drain();
      await session.flushReceivedEvents();
      return session;
    } catch (error) {
      if (session) session.dispose();
      else { detach(); detachClose(); }
      throw error;
    }
  }

  get sessionId(): string { return this.cache.snapshot.sessionId; }
  get sessionFile(): string { return this.cache.snapshot.sessionFile; }
  get sessionName(): string | undefined { return this.cache.snapshot.name; }
  get cwd(): string { return this.cache.snapshot.cwd; }
  get generation(): string { return this.cache.snapshot.generation; }
  get lastSeq(): number { return this.cache.snapshot.lastSeq; }
  get state(): Presentation { return copy(this.cache.state); }
  get messages(): any[] { return copy(this.cache.snapshot.messages); }
  get model(): any { return copy(this.cache.snapshot.state.model); }
  get thinkingLevel(): any { return this.cache.snapshot.state.thinkingLevel; }
  get isStreaming(): boolean { return this.cache.snapshot.state.isStreaming; }
  get isCompacting(): boolean { return this.cache.snapshot.state.isCompacting; }
  get isIdle(): boolean { return !this.detached && !this.failed && !this.isStreaming && !this.isCompacting && !this.bashRunning && !this.reconciling && this.lastSeq >= this.subscribedSeq; }
  get isBashRunning(): boolean { return this.bashRunning; }
  get retryAttempt(): number { return this.cache.retryAttempt; }
  get pendingMessageCount(): number { return this.cache.snapshot.state.pendingMessageCount; }
  get autoCompactionEnabled(): boolean { return this.cache.snapshot.state.autoCompactionEnabled; }
  get steeringMode(): any { return this.cache.snapshot.state.steeringMode; }
  get followUpMode(): any { return this.cache.snapshot.state.followUpMode; }
  get scopedModels(): any[] { return copy((this.cache.snapshot.state as Presentation).scopedModels ?? []); }
  get systemPrompt(): string {
    const prompt = (this.cache.snapshot.state as Presentation).systemPrompt;
    return typeof prompt === "string" ? prompt : unsupported("systemPrompt (not included in client_snapshot)");
  }
  get routedModel(): any { return copy((this.cache.snapshot.state as Presentation).routedModel); }
  get cacheWarmingStatus(): any { return copy((this.cache.snapshot.state as Presentation).cacheWarmingStatus); }
  get promptTemplates(): any[] { return this.commands().filter((command) => command.source === "prompt"); }
  get skills(): any[] { return []; }
  getContextUsage(): any { return copy(this.cache.snapshot.contextUsage); }
  getSessionStats(): any { return copy(this.cache.snapshot.stats); }
  getSteeringMessages(): string[] { return [...this.cache.steering]; }
  getFollowUpMessages(): string[] { return [...this.cache.followUp]; }
  getAllTools(): any[] { return copy(this.cache.snapshot.tools); }
  getActiveToolNames(): string[] { return this.cache.snapshot.tools.map((tool) => tool.name); }
  getToolDefinition(name: string): any { return copy(this.cache.snapshot.tools.find((tool) => tool.name === name)); }
  getLastAssistantText(): string | undefined {
    const message = [...this.cache.snapshot.messages].reverse().find((message) => message.role === "assistant");
    return message?.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("") || undefined;
  }
  supportsThinking(): boolean { return Boolean(this.model?.reasoning); }
  getAvailableThinkingLevels(): string[] {
    const levels = (this.cache.snapshot.state as Presentation).availableThinkingLevels ?? this.model?.thinkingLevels;
    if (levels) return [...levels];
    if (!this.supportsThinking()) return ["off"];
    return unsupported("Available thinking levels (missing remote metadata)");
  }

  subscribe(listener: Listener): () => void {
    this.assertConnected();
    this.listeners.add(listener);
    for (const event of this.activeEvents()) this.deliver(listener, event);
    return () => { this.listeners.delete(listener); };
  }

  private activeEvents(): SessionEvent[] {
    const initial: SessionEvent[] = [];
    if (this.isStreaming) initial.push({ type: "agent_start" }, { type: "turn_start" });
    if (this.cache.streamingMessage) initial.push({ type: "message_start", message: copy(this.cache.streamingMessage) });
    for (const tool of this.cache.toolExecutions.values()) {
      if (!this.cache.pendingToolCalls.has(tool.toolCallId)) continue;
      initial.push({ ...copy(tool), type: "tool_execution_start" });
      if (tool.partialResult) initial.push({ ...copy(tool), type: "tool_execution_update" });
    }
    return initial;
  }

  async bindExtensions(bindings: Presentation): Promise<void> {
    this.assertConnected();
    this.bindings = bindings;
    this.uiContext = bindings.uiContext;
    for (const request of this.uiRequests.splice(0)) this.present(request);
    this.presentDialogs();
  }

  async prompt(text: string, options: Presentation = {}): Promise<any> {
    if (await this.options.onLocalCommand?.(text)) return "handled";
    this.assertConnected();
    if (options.tools || options.systemPrompt) return unsupported("Per-prompt local tools/system prompt");
    const data = await this.request("prompt", { message: text, images: options.images, streamingBehavior: options.streamingBehavior });
    options.preflightResult?.(data?.disposition ?? "started");
    return data?.disposition;
  }
  async steer(text: string, images?: any[]): Promise<any> { return (await this.request("steer", { message: text, images }))?.disposition; }
  async followUp(text: string, images?: any[]): Promise<any> { return (await this.request("follow_up", { message: text, images }))?.disposition; }
  async abort(): Promise<void> { await this.request("abort"); }
  async abortBash(): Promise<void> { await this.request("abort_bash"); }
  async abortRetry(): Promise<void> { await this.request("abort_retry"); }
  async compact(customInstructions?: string): Promise<any> {
    const result = await this.request("compact", { customInstructions });
    await this.flushReceivedEvents();
    return result;
  }
  async exportToHtml(outputPath?: string): Promise<string> { return (await this.request("export_html", { outputPath })).path; }
  async setModel(model: Presentation, _options?: Presentation): Promise<void> {
    const result = await this.request("set_model", { provider: model.provider, modelId: model.id });
    this.cache.snapshot.state.model = modelMetadata(result);
    await this.refreshPresentation();
    await this.loadThinkingLevels();
  }
  async cycleModel(direction: "forward" | "backward" = "forward"): Promise<any> {
    if (direction !== "forward") return unsupported("Backward model cycling (RPC has no direction)");
    const result = await this.request("cycle_model");
    if (result) {
      sanitizeModels(result);
      this.cache.snapshot.state.model = result.model;
      this.cache.snapshot.state.thinkingLevel = result.thinkingLevel;
      await this.loadThinkingLevels();
    }
    return copy(result ?? undefined);
  }
  setThinkingLevel(level: string, _options?: Presentation): Promise<void> { return this.setting("set_thinking_level", { level }, "thinkingLevel", level); }
  setAutoCompactionEnabled(enabled: boolean): Promise<void> { return this.setting("set_auto_compaction", { enabled }, "autoCompactionEnabled", enabled); }
  setAutoRetryEnabled(enabled: boolean): Promise<void> { return this.setting("set_auto_retry", { enabled }, "autoRetryEnabled", enabled); }
  setSteeringMode(mode: string): Promise<void> { return this.setting("set_steering_mode", { mode }, "steeringMode", mode); }
  setFollowUpMode(mode: string): Promise<void> { return this.setting("set_follow_up_mode", { mode }, "followUpMode", mode); }
  setSessionName(name: string): Promise<void> {
    return this.setting("set_session_name", { name }, "sessionName", name.trim()).then(() => { this.cache.snapshot.name = name.trim(); });
  }
  private setting(type: string, payload: Presentation, key: string, value: unknown): Promise<void> {
    const operation = this.request(type, payload).then(async () => {
      if (type === "set_thinking_level") {
        const state = await this.request("get_state");
        value = state.thinkingLevel;
      }
      (this.cache.snapshot.state as Presentation)[key] = value;
    });
    // Native UI uses synchronous setters. Observe failures even when it ignores the returned promise.
    void operation.catch((error) => this.report(error));
    return operation;
  }
  async executeBash(command: string, onChunk?: (chunk: string) => void, options: Presentation = {}): Promise<any> {
    this.assertConnected();
    if (options.operations) return unsupported("Local bash operations");
    if (this.bashRunning) throw new Error("A remote bash command is already running on this client");
    this.bashRunning = true;
    this.bashOutput = onChunk;
    try {
      const result = await this.request("bash", { command, excludeFromContext: options.excludeFromContext });
      this.pendingBashSnapshot = true;
      await this.flushReceivedEvents();
      // recordBashResult persists without normal message/entry events, including
      // intercepted user_bash results. Rebase at a snapshot cursor before redraw.
      await this.reconcile();
      if (!this.isStreaming) this.pendingBashSnapshot = false;
      await this.flushReceivedEvents();
      return result;
    } finally {
      this.bashOutput = undefined;
      this.bashRunning = false;
      this.resolveIdle();
    }
  }
  waitForIdle(): Promise<void> {
    this.assertConnected();
    if (this.isIdle) return Promise.resolve();
    return new Promise((resolve, reject) => this.idleWaiters.add({ resolve, reject }));
  }

  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    const result = await this.request("clear_queue");
    this.cache.steering = [];
    this.cache.followUp = [];
    (this.cache.snapshot.state as Presentation).pendingMessageCount = 0;
    return copy(result);
  }
  async cycleThinkingLevel(): Promise<string | undefined> {
    const result = await this.request("cycle_thinking_level");
    if (result?.level) this.cache.snapshot.state.thinkingLevel = result.level;
    return result?.level;
  }
  private async loadThinkingLevels(): Promise<void> {
    const result = await this.request("get_available_thinking_levels");
    (this.cache.snapshot.state as Presentation).availableThinkingLevels = copy(result.levels);
  }
  abortCompaction(): never { return unsupported("abortCompaction (no daemon RPC)"); }
  abortBranchSummary(): never { return unsupported("abortBranchSummary (no daemon RPC)"); }
  navigateTree(): never { return unsupported("navigateTree (no daemon RPC)"); }
  setScopedModels(): never { return unsupported("setScopedModels (no daemon RPC)"); }
  setCacheWarmingMode(): never { return unsupported("setCacheWarmingMode (no daemon RPC)"); }
  recordBashResult(): never { return unsupported("recordBashResult (daemon owns persistence)"); }
  exportToJsonl(): never { return unsupported("exportToJsonl (no daemon RPC)"); }
  reload(): never { return unsupported("reload (no daemon RPC)"); }
  getUserMessagesForForking(): never { return unsupported("Forking a pinned remote session"); }

  /** Detach only. The caller owns the connection; a lost UI never aborts the remote agent. */
  dispose(): void {
    if (this.detached) return;
    this.detached = true;
    this.detachEvents?.();
    this.deactivateClose?.();
    this.deactivateClose = undefined;
    this.listeners.clear();
    this.buffered = [];
    this.uiRequests.length = 0;
    this.cancelLocalDialogs();
    this.uiContext = undefined;
    this.bindings = {};
    this.rejectIdle(new Error("Remote session detached"));
    if (this.controller) {
      this.controller = false;
      void this.client.call({ type: "release_control", sessionId: this.sessionId }).catch(() => undefined);
    }
  }

  private commands(): any[] {
    const commands: any[] = this.cache.snapshot.commands.filter((command) => !this.options.onLocalCommand || (command.invocationName ?? command.name) !== "remote").map((command) => ({ ...copy(command), invocationName: command.invocationName ?? command.name,
      filePath: command.sourceInfo?.path ?? `remote:/commands/${command.name}`,
      sourceInfo: command.sourceInfo ?? { path: "remote", source: "remote", scope: "project", origin: "top-level" },
      handler: (args: string) => this.prompt(`/${command.invocationName ?? command.name}${args ? ` ${args}` : ""}`) }));
    if (this.options.onLocalCommand) commands.unshift({
      name: "remote", invocationName: "remote", description: "Open remote connection options",
      filePath: "client:/remote", sourceInfo: { path: "client", source: "client", scope: "user", origin: "top-level" },
      getArgumentCompletions: (prefix: string) => remoteArgumentCompletions(prefix, true),
      handler: (args: string) => this.prompt(`/remote${args ? ` ${args}` : ""}`),
    });
    return commands;
  }
  private assertConnected(): void {
    if (this.failed) throw this.failed;
    if (this.detached) throw new Error("Remote session is detached");
  }
  private async request(type: string, payload: Presentation = {}): Promise<any> {
    this.assertConnected();
    const reads = ["client_snapshot", "subscribe", "acquire_control", "get_available_thinking_levels", "get_available_models"];
    if (this.reconciling && !reads.includes(type)) throw new Error("Remote snapshot reconciliation is in progress; commands are disabled until it completes");
    return (await this.client.call({ ...payload, type, sessionId: this.sessionId })).data;
  }
  private async resubscribe(): Promise<void> {
    const response = await this.request("subscribe", { sinceSeq: this.lastSeq });
    if (response?.truncated || (response?.generation !== undefined && response.generation !== this.generation)) {
      await this.reconcile();
    } else {
      this.trackSubscription(response);
    }
  }
  private trackSubscription(response: Presentation | undefined): void {
    const seq = response?.lastSeq ?? this.lastSeq;
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error("Invalid remote subscription cursor");
    this.subscribedSeq = Math.max(seq, this.lastSeq);
  }
  private receive(envelope: Envelope): void {
    if (this.detached || this.failed) return;
    this.buffered.push(envelope);
    if (this.receiving) this.drain();
  }
  private draining = false;
  private drain(): void {
    if (this.draining || this.reconciling || !this.receiving || this.detached || this.failed) return;
    this.draining = true;
    void this.drainEvents().catch((error) => this.fail(error)).finally(() => {
      this.draining = false;
      if (this.buffered.length) this.drain();
    });
  }
  private async drainEvents(): Promise<void> {
    while (this.buffered.length && !this.reconciling && !this.detached && !this.failed) {
      const envelope = this.buffered.shift()!;
      try {
        const event = this.cache.apply(envelope);
        if (!event) continue;
        // Entries must be ready before native compaction handling rebuilds the chat.
        if (["compaction_end", "auto_compaction_end"].includes(event.type)) await this.reconcile();
        if (event.type === "agent_end" && this.client.server?.piVersion.startsWith("0.") && !event.willRetry) {
          this.cache.snapshot.state.isStreaming = false;
        }
        if (event.type === "extension_ui_request") this.present(event);
        else if (event.type === "extension_ui_resolved") {
          this.dialogs.delete(event.id);
          this.dialogControllers.get(event.id)?.abort();
          this.dialogControllers.delete(event.id);
        } else {
          if (event.type === "bash_execution_update") this.bashOutput?.(event.delta);
          this.emit(event);
        }
        // Persisted message IDs and usage are not in message_end events. Refresh on
        // lifecycle boundaries, never on an interval and never by polling tools.
        // Bash results executed during a run are persisted only when Pi settles.
        if (event.type === "agent_settled" && this.pendingBashSnapshot) {
          await this.reconcile();
          this.pendingBashSnapshot = this.isStreaming;
        } else if (["agent_settled", "turn_end"].includes(event.type)) await this.refreshPresentation();
        this.resolveEventWaiters();
        this.resolveIdle();
      } catch (error) {
        if (error instanceof SnapshotRequiredError) await this.reconcile();
        else throw error;
      }
    }
  }
  private reconcile(): Promise<void> {
    if (this.reconciling) return this.reconciling;
    this.reconciling = (async () => {
      this.cancelLocalDialogs();
      for (let attempt = 0; attempt < 3; attempt++) {
        const snapshot = await this.request("client_snapshot") as ClientSnapshot;
        if (snapshot.sessionId !== this.sessionId) throw new Error("client_snapshot returned a different session");
        this.assertConnected();
        this.cache.replace(snapshot);
        this.subscribedSeq = this.lastSeq;
        this.buffered = this.buffered.filter((envelope) =>
          (envelope.generation === undefined || envelope.generation === this.generation) &&
          typeof envelope.seq === "number" && envelope.seq > this.lastSeq);
        const replay = await this.request("subscribe", { sinceSeq: this.lastSeq });
        if (replay?.truncated || (replay?.generation !== undefined && replay.generation !== this.generation)) continue;
        this.trackSubscription(replay);
        if (this.controller) {
          const lease = await this.request("acquire_control");
          for (const dialog of lease?.needsInput ?? []) this.dialogs.set(dialog.id, dialog);
        }
        await this.loadThinkingLevels();
        this.assertConnected();
        this.emit({ type: "remote_snapshot", snapshot: copy(this.cache.snapshot) });
        return;
      }
      throw new Error("Remote snapshot could not establish a contiguous subscription");
    })().catch((error) => {
      this.fail(error);
      throw error;
    }).finally(() => {
      this.reconciling = undefined;
      this.drain();
      this.presentDialogs();
      this.resolveEventWaiters();
      this.resolveIdle();
    });
    return this.reconciling;
  }
  private presentationRefresh?: Promise<void>;
  private refreshPresentation(): Promise<void> {
    if (this.presentationRefresh) return this.presentationRefresh;
    this.presentationRefresh = (async () => {
      const previous = this.cache.snapshot;
      const snapshot = await this.request("client_snapshot") as ClientSnapshot;
      validateSnapshot(snapshot);
      if (snapshot.sessionId !== this.sessionId) throw new Error("client_snapshot returned a different session");
      if (this.detached || this.failed || this.reconciling || this.cache.snapshot !== previous) return;
      if (snapshot.generation !== this.generation) { await this.reconcile(); return; }
      // Keep the live message/lifecycle cursor: this request may cover later events
      // still in transit. Only replace presentation data omitted by native events.
      for (const key of ["entries", "leafId", "tools", "models", "commands", "contextUsage", "stats"] as const) {
        (this.cache.snapshot as Presentation)[key] = copy(snapshot[key]);
      }
      sanitizeModels(this.cache.snapshot);
      this.emit({ type: "remote_metadata_updated" });
      this.emit({ type: "session_info_changed", name: this.sessionName });
    })().finally(() => { this.presentationRefresh = undefined; });
    return this.presentationRefresh;
  }
  private disconnect(): void {
    if (this.detached || this.failed) return;
    this.controller = false;
    this.fail(new Error("Remote connection closed; reconnect and obtain a fresh snapshot before sending commands"));
    this.options.onDisconnect?.();
  }
  private fail(error: unknown): void {
    if (this.detached || this.failed) return;
    this.failed = error instanceof Error ? error : new Error(String(error));
    this.detachEvents?.();
    this.deactivateClose?.();
    this.deactivateClose = undefined;
    this.cancelLocalDialogs();
    this.rejectIdle(this.failed);
    this.report(this.failed);
  }
  private report(error: unknown): void {
    if (this.detached) return;
    const message = error instanceof Error ? error.message : String(error);
    this.uiContext?.notify?.(message, "error");
    this.bindings.onError?.({ extensionPath: "remote", error: message });
  }
  private deliver(listener: Listener, event: SessionEvent): void {
    try { void Promise.resolve(listener(copy(event))).catch((error) => this.report(error)); }
    catch (error) { this.report(error); }
  }
  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) this.deliver(listener, event);
  }
  private async flushReceivedEvents(): Promise<void> {
    for (;;) {
      this.assertConnected();
      if (this.reconciling) await this.reconciling;
      const seq = this.buffered.reduce((last, event) => typeof event.seq === "number" ? Math.max(last, event.seq) : last,
        Math.max(this.lastSeq, this.subscribedSeq));
      if (seq <= this.lastSeq) return;
      await new Promise<void>((resolve, reject) => this.eventWaiters.add({ generation: this.generation, seq, resolve, reject }));
    }
  }
  private resolveEventWaiters(): void {
    for (const waiter of this.eventWaiters) {
      if (waiter.generation === this.generation && waiter.seq > this.lastSeq) continue;
      this.eventWaiters.delete(waiter);
      waiter.resolve();
    }
  }
  private resolveIdle(): void {
    if (!this.isIdle) return;
    for (const waiter of this.idleWaiters) waiter.resolve();
    this.idleWaiters.clear();
  }
  private rejectIdle(error: Error): void {
    for (const waiter of this.idleWaiters) waiter.reject(error);
    this.idleWaiters.clear();
    for (const waiter of this.eventWaiters) waiter.reject(error);
    this.eventWaiters.clear();
  }
  private cancelLocalDialogs(): void {
    for (const controller of this.dialogControllers.values()) controller.abort();
    this.dialogControllers.clear();
    this.dialogs.clear();
  }
  private presentDialogs(): void {
    if (!this.controller || !this.uiContext || this.reconciling || this.detached || this.failed) return;
    for (const dialog of this.dialogs.values()) {
      if (!this.dialogControllers.has(dialog.id)) void this.showDialog(dialog).catch((error) => this.report(error));
    }
  }
  private present(request: SessionEvent): void {
    if (["select", "confirm", "input", "editor"].includes(request.method)) {
      this.dialogs.set(request.id, request);
      this.presentDialogs();
      return;
    }
    if (!this.uiContext) { this.uiRequests.push(request); return; }
    const ui = this.uiContext;
    switch (request.method) {
      case "notify": ui.notify(request.message, request.notifyType); break;
      case "setStatus": ui.setStatus(request.statusKey, request.statusText); break;
      case "setWidget":
        if (request.widgetLines !== undefined && (!Array.isArray(request.widgetLines) || !request.widgetLines.every((line: unknown) => typeof line === "string"))) {
          throw new Error("Remote custom widget components are not supported; only text lines are supported");
        }
        ui.setWidget(request.widgetKey, request.widgetLines, { placement: request.widgetPlacement });
        break;
      case "setTitle": ui.setTitle(request.title); break;
      case "set_editor_text": ui.setEditorText(request.text); break;
      default: throw new Error(`Remote extension UI method '${request.method}' is not supported`);
    }
  }
  private async showDialog(dialog: Presentation): Promise<void> {
    const controller = new AbortController();
    this.dialogControllers.set(dialog.id, controller);
    const ui = this.uiContext;
    const options = { signal: controller.signal, timeout: dialog.timeout };
    let answer: Presentation;
    try {
      let result: unknown;
      switch (dialog.method) {
        case "select": result = await ui.select(dialog.title, dialog.options, options); break;
        case "confirm": result = await ui.confirm(dialog.title, dialog.message, options); break;
        case "input": result = await ui.input(dialog.title, dialog.placeholder, options); break;
        case "editor": result = await ui.editor(dialog.title, dialog.prefill); break;
        default: return unsupported(`Remote dialog '${dialog.method}'`);
      }
      answer = dialog.method === "confirm" && typeof result === "boolean" ? { confirmed: result }
        : typeof result === "string" ? { value: result } : { cancelled: true };
    } catch (error) {
      if (!controller.signal.aborted) this.report(error);
      answer = { cancelled: true };
    }
    if (controller.signal.aborted || !this.controller || this.detached || this.failed || !this.dialogs.has(dialog.id)) return;
    try { await this.request("extension_ui_response", { requestId: dialog.id, ...answer }); }
    finally { this.dialogs.delete(dialog.id); this.dialogControllers.delete(dialog.id); }
  }
}
