import { InteractiveMode, VERSION } from "@earendil-works/pi-coding-agent";

/**
 * Private compatibility boundary for the native Pi 1.2.0 TUI only.
 * Install during extension loading, before InteractiveMode.init(). No second TUI
 * or local AgentSession is created for a remote connection.
 *
 * RemoteSession must supply native synchronous read state and native session
 * methods, plus bindExtensions with remote command/UI routing. Queue clearing
 * may be asynchronous; if unsupported, abort still works but dequeue reports it.
 * Its executeBash must execute remotely; its dispose must detach, not kill the
 * hosted session. Local extensions must honor Pi's session_shutdown contract.
 * Arbitrary extension-owned timers cannot be sandboxed by an in-process bridge.
 * New/fork/tree/clone/resume/import/reload are intentionally unavailable remotely.
 */
export interface Pi12Bridge {
  attach(remoteSession: unknown): Promise<void>;
  disconnect(): Promise<void>;
  readonly mode?: unknown;
}

// Runtime-only members are deliberately confined to this file. Do not import a
// dist path: bundled Pi injects its actual class through the public SDK export.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Native = Record<PropertyKey, any>;
type Method = (this: Native, ...args: any[]) => any;

const KEY = Symbol.for("pi-better-server.pi-1.2-bridge.v1");
const SUPPORTED_VERSION = "1.2.0";
const blockedUi = {
  handleClearCommand: "/new",
  showUserMessageSelector: "/fork",
  handleCloneCommand: "/clone",
  showTreeSelector: "/tree",
  showSessionSelector: "/resume",
  handleResumeSession: "/resume",
  handleImportCommand: "/import",
  handleReloadCommand: "/reload",
  showTrustSelector: "/trust",
  handleShareCommand: "/share",
  showSettingsSelector: "/settings",
  handleLoginCommand: "/login",
  showOAuthSelector: "/logout",
  handleExportCommand: "/export",
  handleDebugCommand: "/debug",
  showModelsSelector: "/scoped-models",
  handleBugCommand: "/bug",
} as const;
const blockedCommands = new Set<string>(Object.values(blockedUi));
const blockedHost = ["newSession", "fork", "switchSession", "importFromJsonl"] as const;
const requiredUi = [
  "init", "rebindCurrentSession", "resetExtensionUI", "clearStatusIndicator",
  "disposeActiveSelector", "setupEditorSubmitHandler", "showWarning", "showError",
  "updateEditorBorderColor", "cycleThinkingLevel", "selectThinkingLevel", "handleNameCommand",
  "restoreQueuedMessagesToEditor", "handleDequeue", "handleEvent",
  "rebuildChatFromMessages", "updatePendingMessagesDisplay",
  ...Object.keys(blockedUi),
];
const executionEntrypoints = [
  "prompt", "continue", "runPromptMessages", "runContinuation", "sendUserMessage",
  "sendCustomMessage", "steer", "followUp", "executeBash",
] as const;
const requiredSession = [
  "subscribe", "bindExtensions", "prompt", "steer", "followUp", "abort", "waitForIdle",
  "executeBash", "abortBash", "dispose", "getContextUsage", "getSessionStats",
  "getToolDefinition", "getSteeringMessages", "getFollowUpMessages", "clearQueue",
  "setModel", "cycleModel", "setThinkingLevel",
  "getAvailableThinkingLevels", "setSessionName",
];

interface Installation {
  managers: WeakMap<object, Controller>;
  modes: WeakMap<object, Controller>;
}

function failure(message: string): Error {
  return new Error(`Pi remote bridge requires native Pi ${SUPPORTED_VERSION}: ${message}`);
}

function object(value: unknown, label: string): Native {
  if (value === null || typeof value !== "object") throw failure(`${label} is missing.`);
  return value as Native;
}

function methods(value: Native, names: readonly string[], label: string): void {
  const missing = names.filter((name) => typeof value[name] !== "function");
  if (missing.length) throw failure(`${label} lacks ${missing.join(", ")}. Nothing was attached.`);
}

function writable(value: Native, name: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if ((descriptor && (!("value" in descriptor) || !descriptor.writable || !descriptor.configurable)) ||
      (!descriptor && !Object.isExtensible(value))) {
    throw failure(`${name} cannot be replaced safely.`);
  }
}

function installation(): Installation | undefined {
  return (InteractiveMode.prototype as Native)[KEY] as Installation | undefined;
}

/** Idempotent across extension reloads, including jiti module cache replacement. */
export function installPi12Bridge(): void {
  if (VERSION !== SUPPORTED_VERSION) throw failure(`running ${VERSION}; /remote is unavailable. Local Pi is unchanged.`);
  if (installation()) return;
  const prototype = InteractiveMode.prototype as Native;
  methods(prototype, requiredUi, "InteractiveMode.prototype");
  for (const name of ["init", "rebindCurrentSession"]) writable(prototype, name);
  const state: Installation = { managers: new WeakMap(), modes: new WeakMap() };
  const init = prototype.init as Method;
  const rebind = prototype.rebindCurrentSession as Method;
  const capture = (mode: Native): Controller => {
    let controller = state.modes.get(mode);
    if (!controller) {
      controller = new Controller(mode, state);
      state.modes.set(mode, controller);
    }
    state.managers.set(object(mode.sessionManager, "sessionManager"), controller);
    return controller;
  };
  Object.defineProperty(prototype, KEY, { value: state });
  prototype.init = function (this: Native, ...args: unknown[]) {
    capture(this);
    return init.apply(this, args);
  };
  prototype.rebindCurrentSession = function (this: Native, ...args: unknown[]) {
    capture(this);
    return rebind.apply(this, args);
  };
}

/** Undefined in print/RPC mode, or if installation happened after TUI startup. */
export function getPi12Bridge(sessionManager: object): Pi12Bridge | undefined {
  return installation()?.managers.get(sessionManager);
}

class Controller implements Pi12Bridge {
  private readonly host: Native;
  private remote: Native | undefined;
  private local: { manager: Native; cwd: string; agentDir: string } | undefined;
  private changing = false;
  private guarded = false;
  private readonly restores: (() => void)[] = [];

  readonly mode: Native;
  private readonly state: Installation;

  constructor(mode: Native, state: Installation) {
    this.mode = mode;
    this.state = state;
    this.host = object(mode.runtimeHost, "InteractiveMode.runtimeHost");
    this.checkHost();
  }

  private checkHost(): void {
    methods(this.mode, requiredUi, "InteractiveMode");
    methods(this.host, ["teardownCurrent", "apply", "createRuntime", "finishSessionReplacement", "dispose", ...blockedHost], "runtimeHost");
    if (typeof this.host.rebindSession !== "function" || typeof this.host.beforeSessionInvalidate !== "function") {
      throw failure("runtimeHost lifecycle callbacks are missing.");
    }
    writable(this.host, "_session");
    for (const name of [...Object.keys(blockedUi), "setupEditorSubmitHandler", "cycleThinkingLevel", "selectThinkingLevel", "handleNameCommand", "restoreQueuedMessagesToEditor", "handleDequeue", "handleEvent"]) writable(this.mode, name);
    for (const name of blockedHost) writable(this.host, name);
    object(this.host.services, "runtimeHost.services");
    methods(object(this.mode.pendingTools, "InteractiveMode.pendingTools"), ["clear", "set"], "pendingTools");
    methods(object(this.mode.entriesRenderedByBoundaryCompaction, "InteractiveMode.entriesRenderedByBoundaryCompaction"), ["clear"], "entriesRenderedByBoundaryCompaction");
    methods(object(this.mode.programStatus, "InteractiveMode.programStatus"), ["reset"], "programStatus");
  }

  private warning(operation: string): { cancelled: true } {
    const guidance = operation === "/settings"
      ? "Use /model or /thinking for supported remote controls. Disconnect /remote to change local settings."
      : "Disconnect /remote before using this local operation.";
    this.mode.showWarning(`${operation} is unavailable while connected remotely. ${guidance}`);
    return { cancelled: true };
  }

  private replace(target: Native, name: string, method: Method): void {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    Object.defineProperty(target, name, { configurable: true, writable: true, value: method });
    this.restores.push(() => {
      if (descriptor) Object.defineProperty(target, name, descriptor);
      else delete target[name];
    });
  }

  private guard(): void {
    if (this.guarded) return;
    this.guarded = true;
    for (const [name, command] of Object.entries(blockedUi)) {
      this.replace(this.mode, name, () => this.warning(command));
    }
    for (const name of blockedHost) {
      this.replace(this.host, name, async () => this.warning(name));
    }
    const handleEvent = this.mode.handleEvent as Method;
    let snapshotTools: Map<string, Native> | undefined;
    this.replace(this.mode, "handleEvent", (event: Native) => {
      if (event.type === "remote_snapshot") {
        this.mode.streamingComponent = undefined;
        this.mode.streamingMessage = undefined;
        this.mode.pendingTools.clear();
        this.mode.entriesRenderedByBoundaryCompaction.clear();
        this.mode.clearStatusIndicator();
        this.mode.programStatus.reset();
        // Rebuild from the replaced cache's persisted entries, not messages:
        // messages may already include the partial assistant replayed next.
        this.mode.rebuildChatFromMessages();
        snapshotTools = this.remote?.isStreaming ? new Map(this.mode.pendingTools) : undefined;
        this.mode.updatePendingMessagesDisplay();
        this.mode.footer.invalidate();
        this.mode.updateEditorBorderColor();
        this.mode.updateTerminalTitle();
        this.mode.ui.requestRender();
        return;
      }
      if (event.type === "agent_start" && snapshotTools) {
        const tools = snapshotTools;
        snapshotTools = undefined;
        // In 1.2.0 this case runs synchronously and clears pendingTools before
        // returning its Promise. Keep the rebuilt rows for synthetic tool starts.
        const result = handleEvent.call(this.mode, event);
        for (const [id, component] of tools) this.mode.pendingTools.set(id, component);
        return result;
      }
      return handleEvent.call(this.mode, event);
    });
    // Include arguments/whitespace variants that native dispatch otherwise sends
    // through prompt(), and gate submission while teardown/rebind is in flight.
    const setup = this.mode.setupEditorSubmitHandler as Method;
    this.replace(this.mode, "setupEditorSubmitHandler", () => {
      setup.call(this.mode);
      this.wrapSubmit();
    });
    this.wrapSubmit();
    this.replace(this.mode, "restoreQueuedMessagesToEditor", async (options?: Native) => {
      if (this.changing || !this.remote) return 0;
      const remote = this.remote;
      let restored = 0;
      try {
        const queue = await remote.clearQueue();
        const all = [...queue.steering, ...queue.followUp, ...this.mode.compactionQueuedMessages.map((message: Native) => message.text)];
        this.mode.compactionQueuedMessages = [];
        restored = all.length;
        if (restored) {
          const current = options?.currentText ?? this.mode.editor.getText();
          this.mode.editor.setText([all.join("\n\n"), current].filter((text: string) => text.trim()).join("\n\n"));
        }
        this.mode.updatePendingMessagesDisplay();
      } catch (error) {
        this.mode.showError(`Remote queue could not be restored: ${String(error)}`);
      } finally {
        if (options?.abort) {
          try { await remote.abort(); }
          catch (error) { this.mode.showError(`Remote abort failed: ${String(error)}`); }
        }
      }
      return restored;
    });
    this.replace(this.mode, "handleDequeue", async () => {
      await this.mode.restoreQueuedMessagesToEditor();
    });
    this.replace(this.mode, "cycleThinkingLevel", () => this.uiAction(async () => {
      const levels = this.remote!.getAvailableThinkingLevels() as string[];
      if (levels.length <= 1) {
        this.mode.showStatus("Current model does not support thinking");
        return;
      }
      const index = levels.indexOf(this.remote!.thinkingLevel);
      const level = levels[(index + 1) % levels.length];
      await this.remote!.setThinkingLevel(level);
      this.mode.showStatus(`Thinking level: ${level}`);
    }));
    this.replace(this.mode, "selectThinkingLevel", (level, persist) => this.uiAction(async () => {
      await this.remote!.setThinkingLevel(level, { persist });
      this.mode.showStatus(persist ? `Default thinking level: ${level}` : `Thinking level: ${level}`);
    }));
    const nameCommand = this.mode.handleNameCommand as Method;
    this.replace(this.mode, "handleNameCommand", (text: string) => {
      const name = text.replace(/^\/name\s*/, "").trim();
      if (!name) return nameCommand.call(this.mode, text);
      return this.uiAction(async () => {
        await this.remote!.setSessionName(name);
        this.mode.updateTerminalTitle();
        this.mode.showStatus(`Session name set: ${this.remote!.sessionManager.getSessionName() ?? name}`);
      });
    });
  }

  private wrapSubmit(): void {
    const editor = this.mode.defaultEditor as Native;
    const submit = editor.onSubmit as Method;
    this.replace(editor, "onSubmit", (text: string) => {
      if (this.changing) return this.warning("Input during session replacement");
      const command = text.trim().split(/\s+/, 1)[0]?.toLowerCase();
      if (command && blockedCommands.has(command)) {
        editor.setText("");
        return this.warning(command);
      }
      return submit.call(editor, text);
    });
  }

  private async uiAction(action: () => Promise<void>): Promise<void> {
    if (this.changing || !this.remote) { this.warning("Input during session replacement"); return; }
    try {
      await action();
      this.mode.footer.invalidate();
      this.mode.updateEditorBorderColor();
      this.mode.ui.requestRender();
    } catch (error) {
      this.mode.showError(error instanceof Error ? error.message : String(error));
    }
  }

  private unguard(): void {
    for (const restore of this.restores.splice(0).reverse()) restore();
    this.guarded = false;
  }

  private detachUi(): void {
    this.mode.unsubscribe?.();
    this.mode.unsubscribe = undefined;
    this.mode.disposeActiveSelector();
    this.mode.clearStatusIndicator();
  }

  private remoteView(remote: Native): Native {
    // Do not let user_bash hooks supply local operations or a local full result.
    // The normal native BashExecutionComponent calls remote.executeBash instead.
    const runner = new Proxy({}, {
      get: (_target, key) => {
        if (key === "emitUserBash") return async () => undefined;
        const value = remote.extensionRunner[key];
        return typeof value === "function" ? value.bind(remote.extensionRunner) : value;
      },
    });
    return new Proxy(remote, {
      get: (target, key) => {
        if (key === "extensionRunner") return runner;
        if (key === "reload" || key === "navigateTree") return async () => this.warning(String(key));
        if (key === "bindExtensions") return async (bindings: Native) => {
          const actions = { ...bindings.commandContextActions };
          for (const name of ["newSession", "fork", "switchSession", "navigateTree", "reload"]) {
            actions[name] = async () => this.warning(name);
          }
          await target.bindExtensions({ ...bindings, commandContextActions: actions });
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  async attach(remoteSession: unknown): Promise<void> {
    if (this.changing) throw failure("a session replacement is already in progress.");
    if (this.remote === remoteSession) return;
    if (this.remote || this.local) throw failure("disconnect the current remote session before attaching another.");
    this.checkHost();
    if (!this.mode.isInitialized) throw failure("the interactive UI has not finished starting.");
    const remote = object(remoteSession, "RemoteSession");
    const local = object(this.host.session, "local session");
    if (remote === local || remote.agent === local.agent || remote.sessionManager === local.sessionManager) {
      throw failure("RemoteSession must not reuse the local executor or session manager.");
    }
    methods(remote, requiredSession, "RemoteSession");
    for (const name of ["sessionManager", "settingsManager", "resourceLoader", "modelRuntime", "extensionRunner", "agent", "state"]) object(remote[name], `RemoteSession.${name}`);
    for (const name of ["messages", "scopedModels", "promptTemplates"]) {
      if (!Array.isArray(remote[name])) throw failure(`RemoteSession.${name} must be native synchronous array state.`);
    }
    writable(remote, "settingsManager");
    methods(remote.sessionManager, ["getCwd", "getSessionName", "getSessionId", "getEntryCount", "getEntries", "getLeafId", "buildContextEntries"], "RemoteSession.sessionManager");
    methods(remote.extensionRunner, ["hasHandlers", "emit", "getRegisteredCommands", "getShortcuts"], "RemoteSession.extensionRunner");
    methods(local, ["abort", "abortBash", "dispose", "prompt", "executeBash"], "local session");
    const editor = object(this.mode.defaultEditor, "InteractiveMode.defaultEditor");
    methods(editor, ["onSubmit", "setText"], "InteractiveMode.defaultEditor");
    writable(editor, "onSubmit");
    for (const target of [local, object(local.agent, "local agent")]) {
      for (const name of executionEntrypoints) {
        if (typeof target[name] === "function") writable(target, name);
      }
    }
    if (local.isBashRunning) throw failure("wait for the local ! command to finish before connecting.");
    this.local = { manager: local.sessionManager, cwd: this.host.cwd, agentDir: this.host.services.agentDir };
    this.changing = true;
    this.guard();
    this.detachUi();
    try {
      // Native teardown aborts/settles tools, emits session_shutdown, resets
      // extension UI synchronously, invalidates extension contexts, and disposes
      // retries, bash, cache warming and the agent subscription, in that order.
      await this.host.teardownCurrent("resume");
      this.retire(local);
      // Theme, keybindings and terminal preferences belong to this local UI;
      // borrowing these settings does not borrow its agent or tool executor.
      remote.settingsManager = local.settingsManager;
      this.remote = remote;
      this.host.apply({ session: this.remoteView(remote), services: this.host.services, diagnostics: [], modelFallbackMessage: undefined });
      this.state.managers.set(remote.sessionManager, this);
      await this.host.finishSessionReplacement();
    } catch (error) {
      // Teardown can fail before its final dispose (for example during UI
      // cleanup). Never leave that outgoing executor live during recovery.
      local.dispose();
      this.retire(local);
      try { await this.restoreLocal(); }
      catch (recovery) {
        // Fail closed: never unguard or resume a disposed local executor.
        throw failure(`attach failed (${String(error)}); local recovery failed (${String(recovery)}). Restart Pi to resume the original history.`);
      }
      throw error;
    } finally {
      this.changing = false;
    }
  }

  private retire(local: Native): void {
    // Pi dispose invalidates extension APIs but direct AgentSession/Agent
    // references remain callable. This executor is never resurrected on return.
    for (const target of [local, local.agent]) {
      for (const name of executionEntrypoints) {
        if (typeof target[name] === "function") {
          Object.defineProperty(target, name, {
            configurable: true, writable: true,
            value: () => Promise.reject(failure("the outgoing local executor is disposed; use the current session.")),
          });
        }
      }
    }
  }

  private async restoreLocal(): Promise<void> {
    const saved = this.local;
    if (!saved) return;
    this.detachUi();
    if (this.remote) {
      // Disconnect is a client detach, not an abort of the hosted agent. The
      // native host teardown would call remote.abort(), so only run its UI
      // invalidation callback before disposing the remote client bindings.
      try { this.host.beforeSessionInvalidate(); }
      finally { await this.remote.dispose(); }
    }
    const result = await this.host.createRuntime({
      cwd: saved.cwd,
      agentDir: saved.agentDir,
      sessionManager: saved.manager,
      sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile: this.remote?.sessionFile },
    });
    this.host.apply(result);
    this.remote = undefined;
    // Native binding must run without the remote wrappers so local extension
    // shortcuts and command actions belong to the newly created runtime.
    this.unguard();
    this.state.managers.set(result.session.sessionManager, this);
    try {
      await this.host.finishSessionReplacement();
      this.local = undefined;
    } catch (error) {
      this.guard();
      await this.host.teardownCurrent("resume");
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.changing) throw failure("a session replacement is already in progress.");
    if (!this.local) return;
    this.changing = true;
    try { await this.restoreLocal(); }
    finally { this.changing = false; }
  }
}
