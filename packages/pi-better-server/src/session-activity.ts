import { AsyncLocalStorage } from "node:async_hooks";
import { createEventBus, type AgentSession, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";

interface ActivityProvider {
  id: string;
  scope?: "session";
  getActivity(ctx: ExtensionContext): { items: Array<{ active: boolean }> } | Promise<{ items: Array<{ active: boolean }> }>;
  onActivityChanged?(notify: () => void): () => void;
}

/** One bus per runtime; legacy providers may conservatively report process-wide work. */
export class SessionActivity {
  readonly events = createEventBus();
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

  constructor(log: (message: string) => void) {
    this.log = log;
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
    return { ...tool, execute: (...args) => this.toolContext.run(args[0], () => tool.execute(...args)) };
  }

  get busy(): boolean { return this.unobservable || this.active; }
  get checking(): boolean { return this.refreshing !== undefined; }

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
    // Defer collection so the guard is installed before invoking arbitrary provider code.
    const run = Promise.resolve().then(async () => {
      let observed: number;
      do {
        observed = this.revision;
        let active = false;
        try {
          const ctx = this.session!.extensionRunner.createContext();
          for (const provider of this.providers.values()) {
            try {
              const snapshot = await provider.getActivity(ctx);
              active ||= snapshot.items.some((item) => item.active);
            } catch (error) {
              // An unavailable owned-work observation cannot establish that work finished.
              active = true;
              this.log(`session activity provider ${provider.id} failed: ${String(error)}`);
            }
          }
        } catch (error) {
          active = true;
          this.log(`session activity observation failed: ${String(error)}`);
        }
        if (this.disposed) return;
        const wasBusy = this.busy;
        this.active = active;
        if (this.busy !== wasBusy) this.changed();
      } while (observed !== this.revision);
    });
    this.refreshing = run.finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  dispose(): void {
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers.values()) unsubscribe();
    this.unsubscribers.clear();
    this.events.clear();
  }
}
