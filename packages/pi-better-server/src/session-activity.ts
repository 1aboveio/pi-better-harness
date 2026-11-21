import { AsyncLocalStorage } from "node:async_hooks";
import { createEventBus, type AgentSession, type EventBus, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";

interface ActivityProvider {
  id: string;
  scope?: "session";
  getActivity(ctx: ExtensionContext): { items: Array<{ active: boolean }> } | Promise<{ items: Array<{ active: boolean }> }>;
  onActivityChanged?(notify: () => void): () => void;
}

/** One bus per hosted session; legacy providers may conservatively report process-wide work. */
export class SessionActivity {
  private recordCounter = 0;
  private handlerRecords = new Map<number, number>();
  private providerRecords = new Map<string, { lastProgressAt: number; state: string }>();
  private refreshStartedAt: number | undefined;
  lifecycleReasons() {
    return [
      ...[...this.handlerRecords].map(([id, lastProgressAt]) => ({ kind: 'hosted-handler', id, lastProgressAt })),
      ...[...this.providerRecords].map(([id, record]) => ({ kind: 'hosted-provider', id, ...record })),
      ...(this.refreshStartedAt === undefined ? [] : [{ kind: 'hosted-observation', id: 'provider-refresh', lastProgressAt: this.refreshStartedAt }]),
      ...(this.unobservable ? [{ kind: 'hosted-retention', id: 'caller-owned-loader', lastProgressAt: null, recovery: 'caller-owned-loader-cannot-prove-background-idleness' }] : []),
    ].map(record => ({ executionDeadline: null, nextDeadline: null, recovery: 'existing-hosted-session-idle-and-admission-policy', ...record }));
  }
  readonly events = createEventBus();
  private readonly runtimeUnsubscribers = new Set<() => void>();
  /** Extensions share the host bus, but their subscriptions end at each loader reload. */
  readonly runtimeEvents: EventBus = {
    emit: (channel, data) => {
      if (this.runtimeRevoked || this.disposed) {
        if (channel === "pi-better-runtime:connect") (data as { reject?: (error: Error) => void })?.reject?.(new Error("runtime-unavailable: hosted session revoked"));
        return;
      }
      this.events.emit(channel, data);
    },
    on: (channel, handler) => {
      if (this.disposed || this.runtimeRevoked) return () => undefined;
      const unsubscribe = this.events.on(channel, (data) => {
        // An emit already in progress can still hold a removed listener.
        if (!this.runtimeUnsubscribers.has(release) || this.runtimeRevoked) return;
        this.pendingHandlers++;
        const record = ++this.recordCounter;
        this.handlerRecords.set(record, Date.now());
        let asynchronous = false;
        try {
          const result = handler(data) as unknown as void | Promise<void>;
          if (result && typeof result.then === "function") {
            asynchronous = true;
            this.changed();
            return Promise.resolve(result).finally(() => { this.pendingHandlers--; this.handlerRecords.delete(record); this.changed(); });
          }
          return result;
        } finally { if (!asynchronous) { this.pendingHandlers--; this.handlerRecords.delete(record); } }
      });
      const release = () => {
        this.runtimeUnsubscribers.delete(release);
        unsubscribe();
      };
      this.runtimeUnsubscribers.add(release);
      return release;
    },
  };
  private readonly providers = new Map<string, ActivityProvider>();
  private readonly toolContext = new AsyncLocalStorage<string>();
  private readonly unsubscribers = new Map<string, () => void>();
  private session: AgentSession | undefined;
  private changed: () => void = () => undefined;
  private revision = 0;
  private refreshing: Promise<void> | undefined;
  private disposed = false;
  private active = false;
  private unobservable = false;
  private legacySubagentsLogged = false;
  private readonly log: (message: string) => void;
  private readonly enterTool: () => () => void;
  private readonly enterCommand: () => () => void;
  private pendingHandlers = 0;
  private runtimeRevoked = false;
  private readonly workClients = new Set<{ close(): void }>();

  constructor(log: (message: string) => void, enterTool: () => () => void = () => () => undefined, enterCommand = enterTool, workClient?: () => import("./runtime/work-client.mjs").WorkClient) {
    this.enterTool = enterTool;
    this.enterCommand = enterCommand;
    this.log = log;
    this.events.on("pi-better-runtime:connect", (request: any) => {
      if (!workClient || this.disposed || this.runtimeRevoked || typeof request?.accept !== "function") return;
      try {
        const client = workClient();
        this.workClients.add(client);
        client.onChange(() => { if (client.closed) this.workClients.delete(client); });
        request.accept(client);
      } catch (error) { request.reject?.(error); }
    });
    this.events.on("pi-better-goal:register-provider", (value) => {
      const provider = value as ActivityProvider | undefined;
      if (!provider || typeof provider.id !== "string" || typeof provider.getActivity !== "function" || this.disposed) return;
      if (provider.id === "subagents" && provider.scope !== "session" && !this.legacySubagentsLogged) {
        this.legacySubagentsLogged = true;
        this.log("session idle protection for legacy subagents is conservative: provider reports process-wide work without session ownership; active work may protect unrelated sessions");
      }
      this.unsubscribers.get(provider.id)?.();
      this.providers.set(provider.id, provider);
      if (provider.onActivityChanged) this.unsubscribers.set(provider.id, provider.onActivityChanged(() => {
        this.revision++;
        void this.refresh();
      }));
      this.revision++;
      if (this.session) void this.refresh();
    });
  }

  get toolCallId(): string | undefined { return this.toolContext.getStore(); }

  wrapTool(tool: ToolDefinition): ToolDefinition {
    return { ...tool, execute: async (...args) => {
      const release = this.enterTool();
      try { return await this.toolContext.run(args[0], () => tool.execute(...args)); }
      finally { release(); }
    } };
  }

  wrapCommand<T extends (...args: any[]) => Promise<void>>(handler: T): T {
    return (async (...args: Parameters<T>) => {
      const release = this.enterCommand();
      try { await handler(...args); }
      finally { release(); }
    }) as T;
  }

  get busy(): boolean { return this.unobservable || this.active || this.pendingHandlers > 0; }
  get checking(): boolean { return this.refreshing !== undefined; }

  /** After shutdown, before any new factories run; the host admission guard has already proved idleness. */
  resetRuntime(): void {
    for (const client of this.workClients) client.close();
    this.workClients.clear();
    for (const unsubscribe of this.unsubscribers.values()) unsubscribe();
    this.unsubscribers.clear();
    for (const unsubscribe of this.runtimeUnsubscribers) unsubscribe();
    this.providers.clear();
    this.providerRecords.clear();
    this.active = false;
    this.revision++;
  }

  /** A fenced runtime cannot receive late bus callbacks or register new background providers. */
  revokeRuntime(): void {
    this.runtimeRevoked = true;
    for (const client of this.workClients) client.close();
    this.workClients.clear();
    for (const unsubscribe of this.runtimeUnsubscribers) unsubscribe();
  }

  /** Missing background signals cannot establish idleness for this runtime. */
  markUnobservable(): void {
    if (this.disposed || this.unobservable) return;
    const wasBusy = this.busy;
    this.unobservable = true;
    if (!wasBusy) this.changed();
  }

  attach(session: AgentSession, changed: () => void): void {
    this.session = session;
    this.changed = changed;
    this.events.emit("pi-better-goal:ready", {});
  }

  refresh(): Promise<void> {
    if (this.disposed || !this.session) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    this.refreshStartedAt = Date.now();
    // Defer collection so the guard is installed before invoking arbitrary provider code.
    const run = Promise.resolve().then(async () => {
      let observed: number;
      do {
        observed = this.revision;
        let active = false;
        try {
          const ctx = this.session!.extensionRunner.createContext();
          this.providerRecords.delete('@context');
          for (const provider of this.providers.values()) {
            try {
              const snapshot = await provider.getActivity(ctx);
              const busy = snapshot.items.some((item) => item.active);
              if (busy && !this.providerRecords.has(provider.id)) this.providerRecords.set(provider.id, { lastProgressAt: Date.now(), state: 'active' });
              if (!busy) this.providerRecords.delete(provider.id);
              active ||= busy;
            } catch (error) {
              // An unavailable owned-work observation cannot establish that work finished.
              active = true;
              if (!this.providerRecords.has(provider.id)) this.providerRecords.set(provider.id, { lastProgressAt: Date.now(), state: 'observation-unavailable' });
              this.log(`session activity provider ${provider.id} failed: ${String(error)}`);
            }
          }
        } catch (error) {
          active = true;
          if (!this.providerRecords.has('@context')) this.providerRecords.set('@context', { lastProgressAt: Date.now(), state: 'context-observation-unavailable' });
          this.log(`session activity observation failed: ${String(error)}`);
        }
        if (this.disposed) return;
        const wasBusy = this.busy;
        this.active = active;
        if (this.busy !== wasBusy) this.changed();
      } while (observed !== this.revision);
    });
    this.refreshing = run.finally(() => { this.refreshing = undefined; this.refreshStartedAt = undefined; });
    return this.refreshing;
  }

  dispose(): void {
    this.disposed = true;
    this.resetRuntime();
    this.events.clear();
  }
}
