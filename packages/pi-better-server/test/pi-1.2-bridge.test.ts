import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

// Substitute only Pi's third-party host. Run the bridge unchanged, including its
// startup capture, validation, lifecycle ordering, and rollback implementation.
async function fixture(version = "1.2.0") {
  const events: string[] = [];
  class InteractiveMode {
    [key: string]: any;
    constructor(host: any) {
      this.runtimeHost = host;
      this.isInitialized = true;
      this.defaultEditor = { text: "", onSubmit: async (text: string) => this.session.prompt(text),
        setText(text: string) { this.text = text; }, getText() { return this.text; } };
      this.editor = this.defaultEditor;
      this.compactionQueuedMessages = [];
      this.footer = { invalidations: 0, invalidate() { this.invalidations++; } };
      this.ui = { renders: 0, terminal: {}, requestRender() { this.renders++; } };
      this.renderer = {};
      this.pendingTools = new Map();
      this.entriesRenderedByBoundaryCompaction = new Set();
      this.programStatus = { reset() {} };
      this.chatContainer = { children: [] as any[], clear() { this.children = []; }, addChild(child: any) { this.children.push(child); } };
      this.themeController = { setThemeName: (name: string) => events.push(`theme:${name}`) };
      this.unsubscribe = () => events.push("unsubscribe-local");
      host.beforeSessionInvalidate = () => this.resetExtensionUI();
      host.rebindSession = () => this.rebindCurrentSession();
    }
    get session() { return this.runtimeHost.session; }
    get sessionManager() { return this.session.sessionManager; }
    async init() { this.setupEditorSubmitHandler(); }
    async rebindCurrentSession() {
      this.unsubscribe?.();
      this.unsubscribe = this.session.subscribe(async (event: any) => { await this.handleEvent(event); });
      await this.session.bindExtensions({ commandContextActions: {}, mode: "tui" });
    }
    resetExtensionUI() { events.push("reset-ui"); }
    clearStatusIndicator() {}
    disposeActiveSelector() {}
    setupEditorSubmitHandler() {
      this.defaultEditor.onSubmit = async (text: string) => {
        text = text.trim();
        const command = text.split(" ", 1)[0];
        const handlers: Record<string, () => any> = {
          "/reload": () => this.handleReloadCommand(),
          "/trust": () => this.showTrustSelector(), "/share": () => this.handleShareCommand(),
          "/settings": () => this.showSettingsSelector(), "/login": () => this.handleLoginCommand(),
          "/logout": () => this.showOAuthSelector("logout"), "/export": () => this.handleExportCommand(text),
          "/debug": () => this.handleDebugCommand(), "/scoped-models": () => this.showModelsSelector(),
          "/bug": () => this.handleBugCommand(), "/model": () => this.session.setModel({ id: "selected" }),
          "/thinking": () => this.selectThinkingLevel(text.slice(10).trim(), false),
          "/copy": () => events.push("copy"), "/session": () => events.push("session-info"),
          "/changelog": () => events.push("changelog"), "/hotkeys": () => events.push("hotkeys"),
        };
        if (command && handlers[command]) return handlers[command]();
        return this.session.prompt(text);
      };
    }
    // Pi 1.2's relevant rendering contract: agent_start clears tool tracking;
    // history renders persisted entries, while message_start owns the live row.
    async handleEvent(event: any) {
      if (event.type === "agent_start") this.pendingTools.clear();
      if (event.type === "message_start" && event.message.role === "assistant") {
        this.streamingMessage = event.message;
        this.streamingComponent = { kind: "message", message: event.message };
        this.chatContainer.addChild(this.streamingComponent);
      }
      if (["message_update", "message_end"].includes(event.type) && this.streamingComponent) {
        this.streamingMessage = event.message;
        this.streamingComponent.message = event.message;
        if (event.type === "message_end") {
          this.streamingMessage = undefined;
          this.streamingComponent = undefined;
        }
      }
      if (event.type === "tool_execution_start") {
        let component = this.pendingTools.get(event.toolCallId);
        if (!component) {
          component = { kind: "tool", id: event.toolCallId };
          this.pendingTools.set(event.toolCallId, component);
          this.chatContainer.addChild(component);
        }
        component.started = true;
      }
      if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
        const component = this.pendingTools.get(event.toolCallId);
        if (component) component.result = event.partialResult ?? event.result;
        if (event.type === "tool_execution_end") this.pendingTools.delete(event.toolCallId);
      }
      events.push(`native:${event.type}`);
    }
    rebuildChatFromMessages() {
      this.chatContainer.clear();
      this.pendingTools.clear();
      for (const entry of this.sessionManager.buildContextEntries()) {
        if (entry.type === "custom") {
          this.chatContainer.addChild({ kind: "entry", entry });
          continue;
        }
        const message = entry.message;
        if (message.role === "toolResult") {
          const component = this.pendingTools.get(message.toolCallId);
          if (component) component.result = message;
          this.pendingTools.delete(message.toolCallId);
          continue;
        }
        this.chatContainer.addChild({ kind: "message", message });
        for (const content of message.content) {
          if (content.type !== "toolCall") continue;
          const component = { kind: "tool", id: content.id };
          this.chatContainer.addChild(component);
          this.pendingTools.set(content.id, component);
        }
      }
    }
    showTrustSelector() { events.push("unsafe:trust"); }
    handleShareCommand() { events.push("unsafe:share"); }
    showSettingsSelector() { events.push("unsafe:settings"); }
    handleLoginCommand() { events.push("unsafe:login"); }
    showOAuthSelector(_mode?: string) { events.push("unsafe:oauth"); }
    handleExportCommand(_text?: string) { events.push("unsafe:export"); }
    handleDebugCommand() { events.push("unsafe:debug"); }
    showModelsSelector() { events.push("unsafe:scoped-models"); }
    handleBugCommand() { events.push("unsafe:bug"); }
    showWarning(message: string) { events.push(`warning:${message}`); }
    showError(message: string) { events.push(`error:${message}`); }
    showStatus() {}
    updateEditorBorderColor() {}
    updateTerminalTitle() {}
    restoreQueuedMessagesToEditor(_options?: unknown) {}
    handleDequeue() {}
    updatePendingMessagesDisplay() {}
    cycleThinkingLevel() {}
    selectThinkingLevel(_level?: string, _persist?: boolean) {}
    handleNameCommand() {}
    handleClearCommand() { events.push("local-new"); }
    showUserMessageSelector() { events.push("local-fork"); }
    handleCloneCommand() { events.push("local-clone"); }
    showTreeSelector() { events.push("local-tree"); }
    showSessionSelector() { events.push("local-resume"); }
    handleResumeSession() { events.push("local-resume"); }
    handleImportCommand() { events.push("local-import"); }
    handleReloadCommand() { events.push("local-reload"); }
  }
  const key = `pi12-bridge-test-${fixtureId++}`;
  (globalThis as any)[key] = { InteractiveMode, VERSION: version };
  const sdk = `data:text/javascript,${encodeURIComponent(`const sdk = globalThis[${JSON.stringify(key)}]; export const InteractiveMode = sdk.InteractiveMode, VERSION = sdk.VERSION;`)}`;
  const source = await readFile(new URL("../src/remote-client/pi-1.2-bridge.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    transformers: { before: [context => root => ts.visitNode(root, function visit(node: ts.Node): ts.VisitResult<ts.Node> {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "@earendil-works/pi-coding-agent") {
        return context.factory.updateImportDeclaration(node, node.modifiers, node.importClause, context.factory.createStringLiteral(sdk), node.attributes);
      }
      return ts.visitEachChild(node, visit, context);
    }) as ts.SourceFile] },
  }).outputText;
  const bridge = await import(`data:text/javascript,${encodeURIComponent(output)}`);
  delete (globalThis as any)[key];
  const manager = { history: ["original history"], getCwd: () => "/local", getSessionName: () => "local", getSessionId: () => "local-id",
    getEntryCount: () => 1, getEntries: () => [], getLeafId: () => null, buildContextEntries: () => [] };
  const session = (label: string, sessionManager: any = { ...manager, history: [] }): any => {
    const listeners = new Set<(event: any) => any>();
    const value: any = {
      entries: [], sessionManager, agent: { prompt: async () => events.push(`${label}-agent-prompt`) }, state: {}, settingsManager: {},
      resourceLoader: {}, modelRuntime: {}, messages: [], scopedModels: [], promptTemplates: [],
      extensionRunner: Object.freeze({ hasHandlers: () => false, emit: async () => {}, getRegisteredCommands: () => [], getShortcuts: () => new Map(),
        emitUserBash: () => { throw new Error("local shell interceptor must never run"); } }),
      subscribe: (listener: (event: any) => any) => {
        events.push(`subscribe-${label}`);
        listeners.add(listener);
        return () => { listeners.delete(listener); events.push(`unsubscribe-${label}`); };
      },
      emit: (event: any) => Promise.all([...listeners].map(listener => listener(event))),
      bindExtensions: async () => { events.push(`bind-${label}`); },
      reload: async () => { events.push(`${label}-reload`); },
      prompt: async () => events.push(`${label}-prompt`), steer: async () => {}, followUp: async () => {},
      abort: async () => { events.push(`abort-${label}`); }, waitForIdle: async () => {},
      executeBash: async (command: string) => { events.push(`${label}-bash:${command}`); return { output: label }; },
      abortBash() {}, dispose: () => { events.push(`dispose-${label}`); },
      getContextUsage() {}, getSessionStats() {}, getToolDefinition() {}, getSteeringMessages: () => [], getFollowUpMessages: () => [],
      clearQueue: () => ({ steering: [], followUp: [] }),
      setModel: async (model: any) => { events.push(`${label}-model:${model.id}`); }, cycleModel: async () => {},
      thinkingLevel: "off", setThinkingLevel: async function (level: string) { this.thinkingLevel = level; },
      getAvailableThinkingLevels: () => ["off", "high"], setSessionName: async () => {},
    };
    sessionManager.buildContextEntries = () => value.entries;
    sessionManager.getEntries = () => value.entries;
    return value;
  };
  const local = session("local", manager);
  const remote = session("remote");
  let failRebind = false;
  let failCreate = false;
  const host: any = {
    _session: local, get session() { return this._session; }, services: { agentDir: "/isolated-agent" }, cwd: "/local",
    async teardownCurrent() { await this.session.abort(); events.push("shutdown-local"); this.beforeSessionInvalidate(); this.session.dispose(); },
    apply(result: any) { this._session = result.session; },
    async createRuntime(options: any) {
      if (failCreate) throw new Error("create failed");
      events.push("create-local");
      return { session: session("fresh", options.sessionManager), services: this.services };
    },
    async finishSessionReplacement() {
      if (failRebind && this.session.sessionManager === remote.sessionManager) throw new Error("remote bind failed");
      await this.rebindSession();
    },
    dispose() {}, newSession() {}, fork() {}, switchSession() {}, importFromJsonl() {},
  };
  const mode = new InteractiveMode(host);
  return { bridge, InteractiveMode, mode, host, local, remote, manager, events,
    failBind: () => { failRebind = true; }, failRecovery: () => { failCreate = true; } };
}
let fixtureId = 0;

async function captured() {
  const f = await fixture();
  f.bridge.installPi12Bridge();
  await f.mode.init();
  return { ...f, controller: f.bridge.getPi12Bridge(f.manager)! };
}

test("unsupported versions and missing host members reject before patching the prototype", async () => {
  const f = await fixture("1.2.1");
  const init = f.InteractiveMode.prototype.init;
  assert.throws(() => f.bridge.installPi12Bridge(), /running 1.2.1/);
  assert.equal(f.InteractiveMode.prototype.init, init);
  assert.equal(f.bridge.getPi12Bridge(f.manager), undefined);
  const missing = await fixture();
  const before = missing.InteractiveMode.prototype.init;
  delete (missing.InteractiveMode.prototype as any).resetExtensionUI;
  assert.throws(() => missing.bridge.installPi12Bridge(), /lacks resetExtensionUI/);
  assert.equal(missing.InteractiveMode.prototype.init, before);
});

test("capture is idempotent; invalid adapters and local bash leave the live session untouched", async () => {
  const f = await captured();
  const init = f.InteractiveMode.prototype.init;
  f.bridge.installPi12Bridge();
  assert.equal(f.InteractiveMode.prototype.init, init);
  assert.equal(f.controller.mode, f.mode);
  await assert.rejects(f.controller.attach({}), /RemoteSession lacks/);
  await assert.rejects(f.controller.attach(f.local), /must not reuse/);
  f.local.isBashRunning = true;
  await assert.rejects(f.controller.attach(f.remote), /local ! command/);
  assert.equal(f.host.session, f.local);
  assert.deepEqual(f.events, []);
});

test("attach tears down local work, gates native commands, and routes bash with a frozen runner", async () => {
  const f = await captured();
  const renderer = f.mode.renderer;
  const newCommand = f.mode.handleClearCommand;
  await f.controller.attach(f.remote);
  assert.deepEqual(f.events.slice(0, 7), ["unsubscribe-local", "abort-local", "shutdown-local", "reset-ui", "dispose-local", "subscribe-remote", "bind-remote"]);
  assert.equal(f.mode.renderer, renderer);
  assert.equal(f.host.session.settingsManager, f.local.settingsManager);
  assert.equal(f.bridge.getPi12Bridge(f.remote.sessionManager), f.controller);
  await f.controller.attach(f.remote);
  assert.equal(f.events.filter(value => value === "dispose-local").length, 1);
  for (const command of ["/new", "/fork", "/tree", "/reload", "/resume", "/import path", "/new extra"]) {
    await f.mode.defaultEditor.onSubmit(command);
  }
  assert.equal(f.events.filter(value => value === "remote-reload").length, 1);
  assert.equal(f.events.includes("local-reload"), false);
  f.mode.handleClearCommand();
  f.mode.showTreeSelector();
  assert.equal((await f.host.newSession()).cancelled, true);
  assert.equal(f.events.some(value => value === "local-new" || value === "local-tree" || value === "remote-prompt"), false);
  assert.equal(await f.host.session.extensionRunner.emitUserBash({ command: "pwd" }), undefined);
  assert.equal((await f.host.session.executeBash("pwd")).output, "remote");
  await assert.rejects(f.local.prompt("must not run"), /outgoing local executor is disposed/);
  await assert.rejects(f.local.agent.prompt("must not run"), /outgoing local executor is disposed/);
  await assert.rejects(f.local.executeBash("must not run"), /outgoing local executor is disposed/);
  await f.mode.cycleThinkingLevel();
  assert.equal(f.remote.thinkingLevel, "high");
  f.remote.clearQueue = async () => { throw new Error("clear_queue unsupported"); };
  await f.mode.restoreQueuedMessagesToEditor({ abort: true });
  assert.equal(f.events.includes("abort-remote"), true);
  assert.equal(f.events.some(value => value.includes("clear_queue unsupported")), true);
  const abortCount = f.events.filter(value => value === "abort-remote").length;
  await f.controller.disconnect();
  assert.equal(f.mode.handleClearCommand, newCommand);
  assert.equal(f.mode.renderer, renderer);
  assert.equal(f.host.session.sessionManager, f.manager);
  assert.notEqual(f.host.session, f.local);
  assert.deepEqual(f.manager.history, ["original history"]);
  assert.equal(f.events.filter(value => value === "abort-remote").length, abortCount);
  assert.equal(f.events.includes("dispose-remote"), true);
  f.mode.handleClearCommand();
  assert.equal(f.events.at(-1), "local-new");
  const count = f.events.length;
  await f.controller.disconnect();
  assert.equal(f.events.length, count);
});

test("remote built-ins fail closed for whitespace, arguments, case variants, and direct UI calls", async () => {
  const f = await captured();
  const handlers = [
    ["/trust", "showTrustSelector"], ["/share", "handleShareCommand"],
    ["/settings", "showSettingsSelector"], ["/login", "handleLoginCommand"],
    ["/logout", "showOAuthSelector"], ["/export", "handleExportCommand"],
    ["/debug", "handleDebugCommand"], ["/scoped-models", "showModelsSelector"],
    ["/bug", "handleBugCommand"],
  ] as const;
  const originals = handlers.map(([, method]) => f.mode[method]);
  await f.controller.attach(f.remote);
  // Native rebinding may install another submit callback; it must stay guarded.
  f.mode.setupEditorSubmitHandler();
  for (const [command, method] of handlers) {
    for (const text of [command, ` \t${command}\n`, `${command} argument`, `${command}\targument`, command.toUpperCase()]) {
      f.mode.defaultEditor.setText(text);
      const warnings = f.events.filter(event => event.startsWith("warning:")).length;
      await f.mode.defaultEditor.onSubmit(text);
      assert.equal(f.mode.defaultEditor.getText(), "", text);
      assert.equal(f.events.filter(event => event.startsWith("warning:")).length, warnings + 1, text);
      assert.match(f.events.at(-1)!, new RegExp(`${command} is unavailable while connected remotely`));
    }
    assert.deepEqual(await f.mode[method](), { cancelled: true }, method);
  }
  assert.equal(f.events.some(event => event.startsWith("unsafe:") || event === "remote-prompt"), false);
  f.mode.showSettingsSelector();
  assert.match(f.events.at(-1)!, /\/model.*\/thinking/);
  await f.controller.disconnect();
  for (const [index, [, method]] of handlers.entries()) assert.equal(f.mode[method], originals[index]);
  f.mode.showTrustSelector();
  assert.equal(f.events.at(-1), "unsafe:trust");
});

test("remote model/thinking, local display/copy/theme, and unrelated commands remain available", async () => {
  const f = await captured();
  const theme = f.mode.themeController;
  await f.controller.attach(f.remote);
  for (const text of ["/copy", "/session", "/changelog", "/hotkeys", "/model", "/thinking high", "/trustworthy", "/custom"]) {
    await f.mode.defaultEditor.onSubmit(text);
  }
  assert.equal(f.remote.thinkingLevel, "high");
  for (const event of ["copy", "session-info", "changelog", "hotkeys", "remote-model:selected"]) {
    assert.equal(f.events.includes(event), true, event);
  }
  assert.equal(f.events.filter(event => event === "remote-prompt").length, 2);
  assert.equal(f.mode.themeController, theme);
  f.mode.themeController.setThemeName("light");
  assert.equal(f.events.at(-1), "theme:light");
  f.remote.setThinkingLevel = async () => { throw new Error("remote thinking rejected"); };
  await f.mode.defaultEditor.onSubmit("/thinking high");
  assert.equal(f.events.at(-1), "error:remote thinking rejected");
  assert.equal(f.events.some(event => event.startsWith("warning:")), false);
  await f.controller.disconnect();
});

test("remote_snapshot rebuilds replaced history before active starts without duplicate partials or tools", async () => {
  for (const streaming of [false, true]) {
    const f = await captured();
    await f.controller.attach(f.remote);
    const { editor, defaultEditor, ui, renderer } = f.mode;
    const terminal = ui.terminal;
    editor.setText("draft survives resync");
    f.mode.compactionQueuedMessages = [{ text: "local queued draft", mode: "steer" }];
    const assistant = (text: string, content: any[] = []) => ({ role: "assistant", content: [{ type: "text", text }, ...content] });
    const stale = assistant("stale partial");
    await f.remote.emit({ type: "message_start", message: stale });
    await f.remote.emit({ type: "tool_execution_start", toolCallId: "stale-tool" });
    f.mode.entriesRenderedByBoundaryCompaction.add("reused-entry-id");
    // Replace the synchronous cache before notifying the native subscription.
    const history = assistant("authoritative history", [
      { type: "toolCall", id: "completed-tool", name: "read", arguments: {} },
      ...(streaming ? [{ type: "toolCall", id: "active-tool", name: "bash", arguments: {} }] : []),
    ]);
    const completedResult = { role: "toolResult", toolCallId: "completed-tool", content: [{ type: "text", text: "done" }] };
    const custom = { type: "custom", id: "reused-entry-id", data: "persisted notice" };
    f.remote.entries = [{ type: "message", message: history }, { type: "message", message: completedResult }, custom];
    const partial = assistant("new partial");
    f.remote.messages = [history, completedResult, ...(streaming ? [partial] : [])];
    f.remote.isStreaming = streaming;
    const renders = ui.renders;
    const snapshot = f.remote.emit({ type: "remote_snapshot", snapshot: { messages: f.remote.messages } });
    // The adapter does not await listeners between the snapshot and replay starts.
    assert.equal(f.mode.streamingMessage, undefined);
    assert.equal(f.mode.streamingComponent, undefined);
    assert.equal(f.mode.pendingTools.has("stale-tool"), false);
    assert.equal(f.mode.entriesRenderedByBoundaryCompaction.size, 0);
    assert.deepEqual(f.mode.chatContainer.children.filter((row: any) => row.kind === "message").map((row: any) => row.message), [history]);
    const replay: Promise<unknown>[] = [];
    if (streaming) {
      const rebuiltTool = f.mode.pendingTools.get("active-tool");
      assert.ok(rebuiltTool);
      replay.push(f.remote.emit({ type: "agent_start" }), f.remote.emit({ type: "turn_start" }),
        f.remote.emit({ type: "message_start", message: partial }),
        f.remote.emit({ type: "tool_execution_start", toolCallId: "active-tool", toolName: "bash", args: {} }),
        f.remote.emit({ type: "tool_execution_update", toolCallId: "active-tool", partialResult: { content: ["partial output"] } }));
      assert.equal(f.mode.pendingTools.get("active-tool"), rebuiltTool);
      assert.equal(f.mode.chatContainer.children.filter((row: any) => row.kind === "tool" && row.id === "active-tool").length, 1);
      const final = assistant("final response");
      replay.push(f.remote.emit({ type: "message_update", message: final }), f.remote.emit({ type: "message_end", message: final }),
        f.remote.emit({ type: "tool_execution_end", toolCallId: "active-tool", result: { content: ["final output"] } }));
      assert.equal(rebuiltTool.started, true);
      assert.deepEqual(rebuiltTool.result, { content: ["final output"] });
      assert.equal(f.mode.pendingTools.size, 0);
      assert.deepEqual(f.mode.chatContainer.children.filter((row: any) => row.kind === "message").map((row: any) => row.message), [history, final]);
    } else {
      assert.equal(f.mode.pendingTools.size, 0);
    }
    await Promise.all([snapshot, ...replay]);
    assert.equal(f.mode.chatContainer.children.filter((row: any) => row.kind === "entry").length, 1);
    assert.equal(f.mode.editor, editor);
    assert.equal(f.mode.defaultEditor, defaultEditor);
    assert.equal(f.mode.ui, ui);
    assert.equal(f.mode.ui.terminal, terminal);
    assert.equal(f.mode.renderer, renderer);
    assert.equal(editor.getText(), "draft survives resync");
    assert.deepEqual(f.mode.compactionQueuedMessages, [{ text: "local queued draft", mode: "steer" }]);
    assert.ok(ui.renders > renders);
    assert.equal(f.events.filter(event => event === "subscribe-remote").length, 1);
    assert.equal(f.events.includes("native:remote_snapshot"), false);
    // A later ordinary agent_start must clear pending tools normally.
    f.mode.pendingTools.set("old-turn", {});
    await f.remote.emit({ type: "agent_start" });
    assert.equal(f.mode.pendingTools.size, 0);
    const handleEvent = f.mode.handleEvent;
    await f.controller.disconnect();
    assert.notEqual(f.mode.handleEvent, handleEvent);
  }
});

test("failed remote bind recreates local history; failed recovery keeps local operations gated", async () => {
  for (const recoveryFails of [false, true]) {
    const f = await captured();
    f.failBind();
    if (recoveryFails) f.failRecovery();
    await assert.rejects(f.controller.attach(f.remote), recoveryFails ? /local recovery failed/ : /remote bind failed/);
    await assert.rejects(f.local.prompt("must not run"), /outgoing local executor is disposed/);
    if (recoveryFails) {
      assert.equal((await f.host.newSession()).cancelled, true);
      f.mode.handleClearCommand();
      assert.equal(f.events.includes("local-new"), false);
    } else {
      assert.equal(f.host.session.sessionManager, f.manager);
      assert.deepEqual(f.manager.history, ["original history"]);
      f.mode.handleClearCommand();
      assert.equal(f.events.at(-1), "local-new");
    }
    assert.equal(f.events.includes("abort-remote"), false);
  }
});
