import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { DaemonClient } from "../src/client.ts";
import { startDaemon } from "../src/index.ts";
import { encodeLine, LineDecoder } from "../src/protocol.ts";
import { RemoteClientSession, RemoteModelRuntime, RemoteSessionCache, RemoteSessionManager, SnapshotRequiredError, type ClientSnapshot } from "../src/remote-client/session.ts";
import { gate, makeEnv, waitFor } from "./helpers.ts";

function snapshot(overrides: Partial<ClientSnapshot> = {}): ClientSnapshot {
  return {
    generation: "generation-a", lastSeq: 10, sessionId: "session-a", cwd: "/remote/work", name: "Remote work",
    sessionFile: "/remote/sessions/session-a.jsonl",
    state: {
      model: undefined, thinkingLevel: "off", isStreaming: false, isCompacting: false,
      steeringMode: "all", followUpMode: "one-at-a-time", sessionId: "session-a",
      sessionFile: "/remote/sessions/session-a.jsonl", autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0,
    },
    messages: [], entries: [], leafId: null, tools: [], commands: [], models: [], contextUsage: undefined, stats: {}, ...overrides,
  };
}

function event(cache: RemoteSessionCache, value: Record<string, unknown>, seq = cache.snapshot.lastSeq + 1) {
  return { sessionId: cache.snapshot.sessionId, generation: cache.snapshot.generation, seq, event: value };
}

// A wire peer deliberately bypasses daemon sanitization and controls response/replay timing.
async function wire(t: TestContext, initial = snapshot()) {
  const root = mkdtempSync("/tmp/rcs-");
  const sockets = new Set<Socket>();
  const calls: any[] = [];
  const peer = {
    snapshot: initial,
    handle: undefined as undefined | ((command: any) => Promise<any> | any),
    send: (message: any) => { for (const socket of sockets) socket.write(encodeLine({ type: "event", ...message })); },
  };
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    const decoder = new LineDecoder(line => {
      const command = JSON.parse(line);
      calls.push(command);
      void (async () => {
        let data;
        if (peer.handle) data = await peer.handle(command);
        if (data === undefined) {
          switch (command.type) {
            case "client_snapshot": data = peer.snapshot; break;
            case "subscribe": data = { generation: peer.snapshot.generation, lastSeq: peer.snapshot.lastSeq, truncated: false }; break;
            case "acquire_control": data = { needsInput: [] }; break;
            case "get_available_thinking_levels": data = { levels: ["off"] }; break;
            case "bash": data = { output: "wire-bash", exitCode: 0 }; break;
          }
        }
        socket.write(encodeLine({ id: command.id, type: "response", success: true, data }));
      })().catch(error => socket.write(encodeLine({ id: command.id, type: "response", success: false, error: String(error) })));
    }, () => socket.destroy());
    socket.on("data", (chunk: string) => decoder.push(chunk));
  });
  await new Promise<void>(resolve => server.listen(join(root, "daemon.sock"), resolve));
  const client = await DaemonClient.connect(join(root, "daemon.sock"), { hello: false });
  t.after(async () => {
    client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  return { get current() { return peer.snapshot; }, set current(value: ClientSnapshot) { peer.snapshot = value; },
    set handle(value: ((command: any) => Promise<any> | any) | undefined) { peer.handle = value; },
    send: peer.send, client, calls };
}

const publicModel = { provider: "remote", id: "model-1", name: "Remote model", reasoning: true,
  input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000,
  maxTokens: 100, thinkingLevels: ["off", "high"], subscription: true, authType: "oauth" };
const credentialModel = { ...publicModel, headers: { Authorization: "Bearer wire-secret" },
  baseUrl: "https://user:wire-secret@example.invalid/?api_key=wire-secret", apiKey: "wire-secret",
  credentials: { token: "wire-secret" }, providerOptions: { token: "wire-secret" } };

function modelSnapshot() {
  const value = snapshot({ models: [credentialModel] });
  Object.assign(value.state, { model: credentialModel,
    scopedModels: [{ model: credentialModel, thinkingLevel: "high" }],
    routedModel: { model: credentialModel, thinkingLevel: "high" } });
  return value;
}

function assertSafeModels(session: RemoteClientSession) {
  assert.deepEqual(session.model, publicModel);
  assert.deepEqual(session.state.model, publicModel);
  assert.deepEqual(session.modelRuntime.getAvailableSnapshot(), [publicModel]);
  assert.deepEqual(session.scopedModels, [{ model: publicModel, thinkingLevel: "high" }]);
  assert.deepEqual(session.routedModel, { model: publicModel, thinkingLevel: "high" });
  assert.equal(JSON.stringify([session.state, session.modelRuntime.getModels()]).includes("wire-secret"), false);
}

const assistant = { role: "assistant", content: [], timestamp: 1, stopReason: "pending" };

test("replay duplicates and other sessions do not mutate state; gaps and generation changes require a snapshot", () => {
  const cache = new RemoteSessionCache(snapshot());
  const start = event(cache, { type: "agent_start" });
  assert.equal(cache.apply(start)?.type, "agent_start");
  assert.equal(cache.state.isStreaming, true);
  assert.equal(cache.apply(start), undefined);
  assert.equal(cache.apply({ ...start, sessionId: "other", seq: 500 }), undefined);
  const before = structuredClone(cache.snapshot);
  for (const invalid of [
    { ...start, seq: 13 }, { ...start, seq: 11, generation: "generation-b" },
    { ...start, seq: NaN }, { ...start, seq: "12" },
  ]) assert.throws(() => cache.apply(invalid), SnapshotRequiredError);
  assert.deepEqual(cache.snapshot, before);
  cache.replace(snapshot({ generation: "generation-b", lastSeq: 20 }));
  assert.equal(cache.apply(event(cache, { type: "agent_start" }))?.type, "agent_start");
});

test("delta streams become native cumulative messages and final messages replace partials exactly once", () => {
  const cache = new RemoteSessionCache(snapshot());
  cache.apply(event(cache, { type: "message_start", message: assistant }));
  const partials: string[] = [];
  for (const delta of ["Hello", " world"]) {
    const update = cache.apply(event(cache, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } }));
    partials.push(update!.message.content[0].text);
  }
  assert.deepEqual(partials, ["Hello", "Hello world"]);
  cache.apply(event(cache, { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "call-1", toolName: "read" } }));
  cache.apply(event(cache, { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"path":' } }));
  const complete = cache.apply(event(cache, { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '"README.md"}' } }));
  assert.deepEqual(complete!.message.content[1].arguments, { path: "README.md" });
  const final = { ...assistant, content: [{ type: "text", text: "Authoritative final text" }], stopReason: "stop" };
  const end = event(cache, { type: "message_end", message: final });
  cache.apply(end);
  cache.apply(end);
  assert.deepEqual(cache.snapshot.messages, [final]);
  assert.equal(cache.streamingMessage, undefined);
});

test("Pi 1.2 agent_end is not idle; tools, queues, names, thinking and settling update the rendering cache", () => {
  const cache = new RemoteSessionCache(snapshot());
  cache.apply(event(cache, { type: "agent_start" }));
  cache.apply(event(cache, { type: "tool_execution_start", toolCallId: "tool-a", toolName: "bash", args: { command: "pwd" } }));
  assert.deepEqual([...cache.pendingToolCalls], ["tool-a"]);
  cache.apply(event(cache, { type: "tool_execution_end", toolCallId: "tool-a", result: { content: [] } }));
  assert.equal(cache.pendingToolCalls.size, 0);
  cache.apply(event(cache, { type: "queue_update", steering: ["change"], followUp: ["later"] }));
  assert.equal(cache.state.pendingMessageCount, 2);
  assert.deepEqual(cache.steering, ["change"]);
  cache.apply(event(cache, { type: "session_info_changed", name: "Renamed remotely" }));
  cache.apply(event(cache, { type: "thinking_level_changed", level: "high" }));
  cache.apply(event(cache, { type: "agent_end", willRetry: true }));
  assert.equal(cache.state.isStreaming, true);
  cache.apply(event(cache, { type: "auto_retry_start", attempt: 2 }));
  assert.equal(cache.retryAttempt, 2);
  cache.apply(event(cache, { type: "compaction_start" }));
  assert.equal(cache.state.isCompacting, true);
  cache.apply(event(cache, { type: "agent_settled" }));
  assert.equal(cache.state.isStreaming, false);
  assert.equal(cache.state.isCompacting, false);
  assert.equal(cache.retryAttempt, 0);
  assert.equal(cache.snapshot.name, "Renamed remotely");
  assert.equal(cache.state.thinkingLevel, "high");
});

test("read-only session tree uses the active branch and Pi compaction projection, with defensive copies", () => {
  const entry = (id: string, parentId: string | null, text: string) => ({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: text, timestamp: 1 } });
  const entries = [entry("a", null, "summarized"), entry("b", "a", "retained"), entry("abandoned", "a", "wrong branch"),
    { type: "compaction", id: "c", parentId: "b", timestamp: "2026-01-01T00:00:01Z", summary: "Summary", firstKeptEntryId: "b", tokensBefore: 100 }, entry("d", "c", "after")];
  const cache = new RemoteSessionCache(snapshot({ entries, leafId: "d" }));
  const manager = new RemoteSessionManager(cache);
  assert.deepEqual(manager.getBranch().map(entry => entry.id), ["a", "b", "c", "d"]);
  assert.deepEqual(manager.buildContextEntries().map(entry => entry.id), ["c", "b", "d"]);
  assert.deepEqual(manager.getTree()[0].children.map((node: any) => node.entry.id), ["b", "abandoned"]);
  manager.getEntries()[0].message.content = "changed locally";
  assert.equal(manager.getEntry("a").message.content, "summarized");
  assert.equal(manager.getCwd(), "/remote/work");
  assert.equal(manager.getSessionName(), "Remote work");
  for (const operation of [() => manager.appendMessage(), () => manager.appendLabelChange(), () => manager.setSessionFile(), () => manager.branch(), () => manager.flush()]) {
    assert.throws(operation, /not supported.*no local execution or persistence/);
  }
  assert.deepEqual(cache.snapshot.entries, entries);
});

test("model metadata has no credentials or executor and callers cannot mutate the remote catalog", async () => {
  const models = [{ provider: "remote", id: "model-1", name: "Remote model" }];
  const runtime = new RemoteModelRuntime(new RemoteSessionCache(snapshot({ models })));
  assert.deepEqual(runtime.getModels("remote"), models);
  runtime.getAvailableSnapshot()[0].name = "local edit";
  assert.equal(runtime.getModel("remote", "model-1").name, "Remote model");
  assert.deepEqual(runtime.getProviders().map(provider => provider.id), ["remote"]);
  assert.equal(runtime.getProvider("remote").stream, undefined);
  for (const operation of [() => runtime.getAuth(), () => runtime.login(), () => runtime.listCredentials(), () => runtime.streamSimple(), () => runtime.registerProvider()]) {
    assert.throws(operation, /not supported/);
  }
  await assert.rejects(runtime.refresh(), /no remote connection/);
});

test("credential-bearing wire models are sanitized on attach, refresh, selection, metadata refresh and reconciliation", { timeout: 10_000 }, async t => {
  const f = await wire(t, modelSnapshot());
  f.handle = command => {
    if (command.type === "get_available_models") return { models: [credentialModel] };
    if (command.type === "set_model") return credentialModel;
    if (command.type === "cycle_model") return { model: credentialModel, thinkingLevel: "high", isScoped: false };
  };
  const session = await RemoteClientSession.connect(f.client, "session-a");
  t.after(() => session.dispose());
  assertSafeModels(session);
  await session.modelRuntime.refresh();
  assertSafeModels(session);
  await session.setModel(publicModel);
  assertSafeModels(session);
  const cycled = await session.cycleModel();
  assert.deepEqual(cycled, { model: publicModel, thinkingLevel: "high", isScoped: false });
  Object.assign(cycled.model, { headers: { Authorization: "Bearer local-edit" } });
  session.model.headers = { Authorization: "Bearer local-edit" };
  assertSafeModels(session);
  const changed = untilEvent(session, "remote_snapshot");
  f.current = { ...modelSnapshot(), generation: "generation-b" };
  f.send({ sessionId: "session-a", generation: "generation-b", seq: 11, event: { type: "agent_start" } });
  const redraw = await changed;
  assert.equal(JSON.stringify(redraw).includes("wire-secret"), false);
  assertSafeModels(session);
});

test("cache replacement sanitizes models without mutating wire input", () => {
  const incoming = modelSnapshot();
  const cache = new RemoteSessionCache(incoming);
  assert.deepEqual(cache.snapshot.models, [publicModel]);
  assert.deepEqual(cache.state.model, publicModel);
  cache.replace(incoming);
  assert.deepEqual(cache.snapshot.models, [publicModel]);
  assert.equal(incoming.models[0].headers.Authorization, "Bearer wire-secret");
});

test("bash snapshot restores an active partial and waits for the subscribed cursor without duplicate starts", { timeout: 10_000 }, async t => {
  const f = await wire(t);
  const session = await RemoteClientSession.connect(f.client, "session-a");
  t.after(() => session.dispose());
  const partial = { ...assistant, content: [{ type: "text", text: "before" }] };
  f.current = snapshot({ lastSeq: 12, activeMessage: partial,
    state: { ...snapshot().state, isStreaming: true }, messages: [] });
  let subscribe = 0;
  let releaseReplay!: () => void;
  const replayRequested = new Promise<void>(resolve => { releaseReplay = resolve; });
  f.handle = command => {
    if (command.type === "subscribe") {
      subscribe++;
      releaseReplay();
      return { generation: "generation-a", lastSeq: 13, truncated: false };
    }
  };
  const events: any[] = [];
  session.subscribe(value => { events.push(value); });
  let completed = false;
  const bash = session.executeBash("printf wire-bash").then(result => { completed = true; return result; });
  await replayRequested;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false, "bash waits for replay promised by the subscribe response");
  f.send({ sessionId: "session-a", generation: "generation-a", seq: 13,
    event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " after" } } });
  await bash;
  assert.equal(subscribe, 1);
  assert.equal(session.lastSeq, 13);
  assert.equal(session.state.streamMessage.content[0].text, "before after");
  assert.equal(session.isStreaming, true);
  assert.equal(session.isIdle, false);
  assert.equal(events.filter(value => value.type === "remote_snapshot").length, 1);
  assert.equal(events.filter(value => ["agent_start", "turn_start", "message_start"].includes(value.type)).length, 0);
  const ended = untilEvent(session, "message_end");
  const final = { ...partial, content: [{ type: "text", text: "before after" }], stopReason: "stop" };
  f.send({ sessionId: "session-a", generation: "generation-a", seq: 14, event: { type: "message_end", message: final } });
  await ended;
  assert.deepEqual(session.messages, [final]);
});

test("snapshot-restored partials already in history are updated and finalized exactly once", () => {
  const partial = { ...assistant, content: [{ type: "text", text: "before" }] };
  const cache = new RemoteSessionCache(snapshot({ activeMessage: partial, messages: [partial] }));
  cache.apply(event(cache, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " after" } }));
  const final = { ...partial, content: [{ type: "text", text: "before after" }], stopReason: "stop" };
  cache.apply(event(cache, { type: "message_end", message: final }));
  assert.deepEqual(cache.snapshot.messages, [final]);
});

test("bash retries a truncated subscription and keeps newer deltas buffered during the snapshot", { timeout: 10_000 }, async t => {
  const partial = { ...assistant, content: [{ type: "text", text: "before" }] };
  const initial = snapshot({ activeMessage: partial, state: { ...snapshot().state, isStreaming: true } });
  const f = await wire(t, initial);
  const session = await RemoteClientSession.connect(f.client, "session-a");
  t.after(() => session.dispose());
  let snapshotRequested!: () => void;
  const requested = new Promise<void>(resolve => { snapshotRequested = resolve; });
  let releaseSnapshot!: () => void;
  const held = new Promise<void>(resolve => { releaseSnapshot = resolve; });
  let snapshots = 0;
  let subscriptions = 0;
  const bashMessage = { role: "bashExecution", command: "printf wire-bash", output: "wire-bash", timestamp: 2 };
  const updated = { ...partial, content: [{ type: "text", text: "before during" }] };
  f.handle = async command => {
    if (command.type === "client_snapshot" && ++snapshots === 1) {
      snapshotRequested();
      await held;
      return initial;
    }
    if (command.type === "subscribe") {
      if (++subscriptions === 1) return { generation: initial.generation, lastSeq: 11, truncated: true };
      const delta = { sessionId: "session-a", generation: initial.generation, seq: 12,
        event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " after" } } };
      f.send(delta);
      f.send(delta);
      return { generation: initial.generation, lastSeq: 12, truncated: false };
    }
  };
  const events: any[] = [];
  session.subscribe(value => { events.push(value); });
  events.length = 0;
  const bash = session.executeBash("printf wire-bash");
  await requested;
  f.send({ sessionId: "session-a", generation: initial.generation, seq: 11,
    event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " during" } } });
  f.current = { ...initial, lastSeq: 11, activeMessage: updated, messages: [bashMessage] };
  releaseSnapshot();
  await bash;
  assert.equal(subscriptions, 2);
  assert.equal(session.lastSeq, 12);
  assert.equal(session.state.streamMessage.content[0].text, "before during after");
  assert.deepEqual(session.messages, [bashMessage, { ...updated, content: [{ type: "text", text: "before during after" }] }]);
  assert.deepEqual(events.map(value => value.type), ["remote_snapshot", "message_update"]);
});

test("an older metadata refresh cannot overwrite a completed bash snapshot", { timeout: 10_000 }, async t => {
  const f = await wire(t, modelSnapshot());
  const session = await RemoteClientSession.connect(f.client, "session-a");
  t.after(() => session.dispose());
  let refreshRequested!: () => void;
  const requested = new Promise<void>(resolve => { refreshRequested = resolve; });
  let releaseRefresh!: () => void;
  const held = new Promise<void>(resolve => { releaseRefresh = resolve; });
  let snapshots = 0;
  f.handle = async command => {
    if (command.type === "set_model") return credentialModel;
    if (command.type === "client_snapshot" && ++snapshots === 1) {
      refreshRequested();
      await held;
      return modelSnapshot();
    }
  };
  const selection = session.setModel(publicModel);
  await requested;
  const message = { role: "bashExecution", command: "printf wire-bash", output: "wire-bash", timestamp: 2 };
  const entries = [{ type: "message", id: "bash-entry", parentId: null, message }];
  f.current = { ...modelSnapshot(), messages: [message], entries, leafId: "bash-entry", stats: { messages: 1 } };
  await session.executeBash("printf wire-bash");
  releaseRefresh();
  await selection;
  assert.deepEqual(session.messages, [message]);
  assert.deepEqual(session.sessionManager.getEntries(), entries);
  assert.equal(session.sessionManager.getLeafId(), "bash-entry");
  assert.deepEqual(session.getSessionStats(), { messages: 1 });
});

test("disposing and failed attach unsubscribe the transport close listener", async t => {
  const f = await wire(t);
  const onClose = f.client.onClose.bind(f.client);
  let subscriptions = 0;
  t.mock.method(f.client, "onClose", (listener: () => void) => {
    subscriptions++;
    const unsubscribe = onClose(listener);
    return () => { subscriptions--; unsubscribe(); };
  });
  const session = await RemoteClientSession.connect(f.client, "session-a");
  assert.equal(subscriptions, 1);
  session.dispose();
  session.dispose();
  assert.equal(subscriptions, 0);
  f.current = { ...snapshot(), sessionId: "wrong-session" };
  await assert.rejects(RemoteClientSession.connect(f.client, "session-a"), /different session/);
  assert.equal(subscriptions, 0);
  assert.equal(f.calls.some(command => command.type === "abort" || command.type === "abort_bash"), false);
});

test("bash fails closed after repeated replay truncation and unsubscribes close exactly once", { timeout: 10_000 }, async t => {
  const f = await wire(t);
  const onClose = f.client.onClose.bind(f.client);
  let subscriptions = 0;
  t.mock.method(f.client, "onClose", (listener: () => void) => {
    subscriptions++;
    const unsubscribe = onClose(listener);
    return () => { subscriptions--; unsubscribe(); };
  });
  const session = await RemoteClientSession.connect(f.client, "session-a");
  t.after(() => session.dispose());
  f.handle = command => command.type === "subscribe" ? { generation: "generation-a", lastSeq: 10, truncated: true } : undefined;
  await assert.rejects(session.executeBash("printf wire-bash"), /could not establish a contiguous subscription/);
  assert.equal(session.isBashRunning, false);
  assert.equal(session.isIdle, false);
  assert.equal(subscriptions, 0);
  await assert.rejects(session.prompt("must not run"), /could not establish a contiguous subscription/);
  session.dispose();
  assert.equal(subscriptions, 0);
  assert.equal(f.calls.some(command => command.type === "abort" || command.type === "abort_bash"), false);
});

for (const trigger of ["explicit", "event"] as const) {
  test(`reload ${trigger} refresh cannot reuse a snapshot captured before resources changed`, { timeout: 10_000 }, async t => {
    const f = await wire(t);
    f.client.server = { protocolVersion: 1, piVersion: VERSION, extensionVersions: {}, capabilities: ["remote-reload-v1"] };
    const session = await RemoteClientSession.connect(f.client, "session-a");
    t.after(() => session.dispose());
    let captured!: () => void;
    const snapshotCaptured = new Promise<void>(resolve => { captured = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let accepted!: () => void;
    const reloadAccepted = new Promise<void>(resolve => { accepted = resolve; });
    let hold = true;
    const update = () => { f.current = { ...f.current, tools: [{ name: "new_remote_tool", description: "After reload" }], commands: [{ name: "new_remote_command" }] }; };
    f.handle = async command => {
      if (command.type === "set_model") return publicModel;
      if (command.type === "client_snapshot" && hold) {
        hold = false;
        const previous = structuredClone(f.current);
        captured();
        await held;
        return previous;
      }
      if (command.type === "client_reload") { update(); accepted(); return {}; }
    };
    const modelChange = session.setModel(publicModel);
    await snapshotCaptured;
    try {
      if (trigger === "explicit") {
        const reload = session.reload();
        await reloadAccepted;
        release();
        await Promise.all([modelChange, reload]);
      } else {
        update();
        const observed = untilEvent(session, "remote_resources_reloaded");
        f.send({ sessionId: "session-a", generation: "generation-a", seq: 11, event: { type: "remote_resources_reloaded" } });
        await observed;
        release();
        await modelChange;
        await waitFor("resources from a post-reload snapshot", () => Boolean(session.getToolDefinition("new_remote_tool")), 2_000);
      }
      assert.ok(session.getToolDefinition("new_remote_tool"));
      assert.ok(session.extensionRunner.getRegisteredCommands().some((command: any) => command.name === "new_remote_command"));
    } finally { release(); }
  });
}

async function hosted(t: TestContext, configure?: (env: ReturnType<typeof makeEnv>) => void) {
  const previous = { ...process.env };
  const env = makeEnv();
  configure?.(env);
  Object.assign(process.env, env.vars);
  const daemon = await startDaemon({ serverDir: env.serverDir });
  const clients: DaemonClient[] = [];
  const sessions: RemoteClientSession[] = [];
  t.after(async () => {
    for (const session of sessions) session.dispose();
    for (const client of clients) client.close();
    await daemon.stop();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  const client = async () => {
    const connection = await DaemonClient.connect(daemon.socketPath);
    clients.push(connection);
    return connection;
  };
  const owner = await client();
  const created = await owner.call({ type: "create_session", cwd: env.cwd, model: { provider: "fake", modelId: "fake-1" } });
  const sessionId = created.sessionId!;
  const attach = async (connection = owner, options = {}) => {
    const session = await RemoteClientSession.connect(connection, sessionId, options);
    sessions.push(session);
    return session;
  };
  return { env, daemon, owner, client, attach, sessionId };
}

function untilEvent(session: RemoteClientSession, type: string, accept: (event: any) => boolean = () => true): Promise<any> {
  return new Promise(resolve => {
    const detach = session.subscribe(event => {
      if (event.type !== type || !accept(event)) return;
      detach();
      resolve(event);
    });
  });
}

test("real daemon: remote UI notifications, statuses and text widgets reach native presentation methods", { timeout: 30_000 }, async t => {
  const f = await hosted(t);
  const session = await f.attach();
  const received: unknown[] = [];
  await session.bindExtensions({ uiContext: {
    notify: (message: string, type: string) => received.push(["notify", message, type]),
    setStatus: (key: string, text: string | undefined) => received.push(["status", key, text]),
    setWidget: (key: string, lines: string[], options: unknown) => received.push(["widget", key, lines, options]),
  } });
  const remoteUi = f.daemon.registry.get(f.sessionId)!.session.extensionRunner.getUIContext();
  remoteUi.notify("Remote notice", "warning");
  remoteUi.setStatus("remote-task", "Running");
  remoteUi.setWidget("remote-widget", ["Remote progress"], { placement: "belowEditor" });
  remoteUi.setStatus("remote-task", undefined);
  await waitFor("four forwarded UI calls", () => received.length === 4);
  assert.deepEqual(received, [
    ["notify", "Remote notice", "warning"], ["status", "remote-task", "Running"],
    ["widget", "remote-widget", ["Remote progress"], { placement: "belowEditor" }], ["status", "remote-task", undefined],
  ]);
});

test("real daemon: a changed hosted generation replaces the cache and resumes a contiguous event subscription", { timeout: 30_000 }, async t => {
  const f = await hosted(t);
  const session = await f.attach();
  const firstSettled = untilEvent(session, terminalEvent);
  await session.prompt("before restart");
  await firstSettled;
  await session.waitForIdle();
  const previousGeneration = session.generation;
  await f.owner.call({ type: "close_session", sessionId: f.sessionId });
  await f.owner.call({ type: "open_session", sessionId: f.sessionId });
  // A real re-subscription brings events from the replacement hosted session to
  // the existing transport; the adapter must notice its new generation.
  await f.owner.call({ type: "subscribe", sessionId: f.sessionId });
  const replaced = untilEvent(session, "remote_snapshot");
  await f.owner.call({ type: "prompt", sessionId: f.sessionId, message: "tool generation" });
  await replaced;
  assert.notEqual(session.generation, previousGeneration);
  assert.ok(session.messages.some(message => message.role === "assistant" && message.content.some((block: any) => block.text === "echo:before restart")));
  const settled = untilEvent(session, terminalEvent);
  gate(f.env, "generation").release();
  await settled;
  assert.equal(session.getLastAssistantText(), "tool-done:gate:generation");
  assert.equal(session.messages.filter(message => message.role === "user" && (typeof message.content === "string" ? message.content === "before restart" : message.content.some((block: any) => block.text === "before restart"))).length, 1);
});

test("real daemon: model/settings changes, steering, follow-up and explicit abort execute on the hosted session", { timeout: 30_000 }, async t => {
  const f = await hosted(t);
  const session = await f.attach();
  await session.setModel(session.model);
  await session.setThinkingLevel("high");
  assert.equal(session.thinkingLevel, "off", "the remote non-reasoning model clamps thinking levels");
  assert.equal(await session.cycleThinkingLevel(), undefined);
  await session.prompt("tool queue");
  await waitFor("queue fixture tool started", () => gate(f.env, "queue").started());
  await session.steer("remote steer");
  await session.followUp("remote follow-up");
  assert.equal((await f.owner.call({ type: "get_state", sessionId: f.sessionId })).data.pendingMessageCount, 2);
  const followUp = untilEvent(session, "message_end", event => event.message.role === "assistant" && event.message.content.some((block: any) => block.text === "echo:remote follow-up"));
  gate(f.env, "queue").release();
  await followUp;
  await session.waitForIdle();
  assert.ok(session.messages.some(message => message.role === "user" && (typeof message.content === "string" ? message.content === "remote steer" : message.content.some((block: any) => block.text === "remote steer"))));
  await session.prompt("tool explicit-abort");
  await waitFor("abort fixture tool started", () => gate(f.env, "explicit-abort").started());
  await session.abort();
  assert.equal(gate(f.env, "explicit-abort").finished(), true);
  assert.equal((await f.owner.call({ type: "get_state", sessionId: f.sessionId })).data.isStreaming, false);
});

const terminalEvent = VERSION.startsWith("0.") ? "agent_end" : "agent_settled";

test("real daemon: prompt acceptance does not wait for tool completion, events render once and metadata stays remote", { timeout: 30_000 }, async t => {
  const f = await hosted(t);
  const session = await f.attach(f.owner, { onLocalCommand: async (text: string) => text === "/local" });
  const events: any[] = [];
  session.subscribe(event => { events.push(event); });
  assert.equal(await session.prompt("/local"), "handled");
  assert.equal(session.messages.length, 0);
  await session.prompt("tool accepted");
  await waitFor("fixture tool started", () => gate(f.env, "accepted").started());
  assert.equal(session.isStreaming, true);
  assert.equal(session.isIdle, false);
  const settled = untilEvent(session, terminalEvent);
  gate(f.env, "accepted").release();
  await settled;
  await session.waitForIdle();
  assert.equal(session.getLastAssistantText(), "tool-done:gate:accepted");
  assert.equal(events.filter(event => event.type === "tool_execution_end").length, 1);
  const remote = await f.owner.call({ type: "client_snapshot", sessionId: f.sessionId });
  await waitFor("lifecycle metadata refreshed", () => session.sessionManager.getEntryCount() === remote.data.entries.length);
  assert.deepEqual(session.sessionManager.getEntries(), remote.data.entries);
  await session.setSessionName("Named through adapter");
  assert.equal((await f.owner.call({ type: "get_state", sessionId: f.sessionId })).data.sessionName, "Named through adapter");
  assert.equal(session.sessionManager.getSessionName(), "Named through adapter");
  assert.equal(session.extensionRunner.resolveToolRenderers("read", () => "native renderer"), "native renderer");
  assert.equal(session.getToolDefinition("gate").execute, undefined);
  const nativeBase = new URL(".", import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { initTheme } = await import(new URL("modes/interactive/theme/theme.js", nativeBase).href);
  const { FooterComponent } = await import(new URL("modes/interactive/components/footer.js", nativeBase).href);
  initTheme("dark", false);
  const footer = new FooterComponent(session, {
    getGitBranch: () => undefined, getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1,
  });
  const rendered = footer.render(120).join("\n");
  assert.match(rendered, /Named through adapter/);
  assert.match(rendered, /fake-1/);
  footer.dispose();
  await assert.rejects(session.setModel({ provider: "fake", id: "not-a-model" }), /Model not found/);
  assert.deepEqual(await session.clearQueue(), { steering: [], followUp: [] });
  assert.throws(() => session.recordBashResult(), /daemon owns persistence/);
});

test("real daemon: asynchronous queue restoration clears only the remote queued messages", { timeout: 30_000 }, async t => {
  const f = await hosted(t);
  const session = await f.attach();
  await session.prompt("tool restore-queue");
  await waitFor("queue restoration tool", () => gate(f.env, "restore-queue").started());
  await session.steer("restore this steering message");
  await session.followUp("restore this follow-up");
  assert.deepEqual(await session.clearQueue(), {
    steering: ["restore this steering message"], followUp: ["restore this follow-up"],
  });
  assert.equal((await f.owner.call({ type: "get_state", sessionId: f.sessionId })).data.pendingMessageCount, 0);
  const settled = untilEvent(session, terminalEvent);
  gate(f.env, "restore-queue").release();
  await settled;
  await session.waitForIdle();
  assert.equal(session.getLastAssistantText(), "tool-done:gate:restore-queue");
});

test("native command metadata retains the local remote menu and disconnect suggestions", async t => {
  const f = await hosted(t);
  const actions: string[] = [];
  const session = await f.attach(f.owner, { onLocalCommand: async (text: string) => { actions.push(text); return true; } });
  const command = session.extensionRunner.getCommand("remote");
  assert.ok(command);
  assert.deepEqual(command.getArgumentCompletions("li").map((item: any) => item.value), ["list"]);
  assert.deepEqual(command.getArgumentCompletions("dis").map((item: any) => item.value), ["disconnect"]);
  await command.handler("");
  await command.handler("list");
  await command.handler("disconnect");
  assert.deepEqual(actions, ["/remote", "/remote list", "/remote disconnect"]);
  assert.deepEqual((await f.owner.call({ type: "get_messages", sessionId: f.sessionId })).data.messages, []);
});

test("real daemon: metadata command handlers forward remotely and bash streams through the adapter", { timeout: 30_000 }, async t => {
  const f = await hosted(t);
  const session = await f.attach();
  const settled = untilEvent(session, terminalEvent);
  const command = session.extensionRunner.getCommand("kick");
  assert.ok(command, "the remote fixture's command is discoverable");
  await command.handler("from-command");
  await settled;
  assert.equal(session.getLastAssistantText(), "echo:from-command");
  const output: string[] = [];
  const redraws: any[] = [];
  session.subscribe(event => { if (event.type === "remote_snapshot") redraws.push(event); });
  const result = await session.executeBash("printf remote-shell", chunk => output.push(chunk));
  assert.equal(result.output, "remote-shell");
  assert.equal(output.join(""), "remote-shell");
  const remote = (await f.owner.call({ type: "client_snapshot", sessionId: f.sessionId })).data;
  assert.ok(remote.messages.some((message: any) => message.role === "bashExecution" && message.output === "remote-shell"));
  assert.deepEqual(session.messages, remote.messages);
  assert.deepEqual(session.sessionManager.getEntries(), remote.entries);
  assert.equal(session.sessionManager.getLeafId(), remote.leafId);
  assert.deepEqual(session.getSessionStats(), remote.stats);
  assert.equal(redraws.length, 1);
  assert.deepEqual(redraws[0].snapshot.messages, remote.messages);
  assert.equal(session.isBashRunning, false);
  await assert.rejects(session.executeBash("printf forbidden", undefined, { operations: {} }), /Local bash operations/);
});

test("real daemon: intercepted bash without agent events synchronizes messages, entries and stats", { timeout: 30_000 }, async t => {
  const f = await hosted(t, env => {
    writeFileSync(join(env.agentDir, "extensions", "shell.ts"), `export default function (pi) {
      pi.on("user_bash", () => ({ result: { output: "intercepted-shell", exitCode: 0, cancelled: false, truncated: false } }));
    }`);
  });
  const session = await f.attach();
  const events: string[] = [];
  session.subscribe(event => { events.push(event.type); });
  const result = await session.executeBash("printf must-not-execute", undefined, { excludeFromContext: true });
  assert.equal(result.output, "intercepted-shell");
  const remote = (await f.owner.call({ type: "client_snapshot", sessionId: f.sessionId })).data;
  assert.equal(remote.messages.at(-1).excludeFromContext, true);
  assert.deepEqual(session.messages, remote.messages);
  assert.deepEqual(session.sessionManager.getEntries(), remote.entries);
  assert.deepEqual(session.getSessionStats(), remote.stats);
  assert.deepEqual(events, ["remote_snapshot"]);
});

test("real daemon: bash redraw preserves a running remote tool and its completion", { timeout: 30_000 }, async t => {
  const f = await hosted(t);
  const session = await f.attach();
  await session.prompt("tool bash-redraw");
  await waitFor("remote tool before bash", () => gate(f.env, "bash-redraw").started());
  await waitFor("cached tool before bash", () => session.state.pendingToolCalls.size > 0);
  const events: string[] = [];
  session.subscribe(event => { events.push(event.type); });
  events.length = 0;
  await session.executeBash("printf concurrent-shell");
  assert.equal(session.isStreaming, true);
  assert.deepEqual([...session.state.pendingToolCalls], [...f.daemon.registry.get(f.sessionId)!.session.state.pendingToolCalls]);
  assert.equal(events.filter(type => type === "remote_snapshot").length, 1);
  assert.equal(events.filter(type => ["agent_start", "turn_start", "tool_execution_start"].includes(type)).length, 0);
  const settled = untilEvent(session, "agent_settled");
  const synchronized = untilEvent(session, "remote_snapshot");
  gate(f.env, "bash-redraw").release();
  await settled;
  await synchronized;
  await session.waitForIdle();
  assert.equal(session.getLastAssistantText(), "tool-done:gate:bash-redraw");
  assert.equal(events.filter(type => type === "tool_execution_end").length, 1);
  const remote = (await f.owner.call({ type: "client_snapshot", sessionId: f.sessionId })).data;
  assert.ok(remote.messages.some((message: any) => message.role === "bashExecution" && message.output === "concurrent-shell"));
  assert.deepEqual(session.messages, remote.messages);
  assert.deepEqual(session.sessionManager.getEntries(), remote.entries);
  assert.deepEqual(session.getSessionStats(), remote.stats);
});

test("real daemon: reconnecting a pending dialog presents it once and sends its answer under the control lease", { timeout: 30_000 }, async t => {
  const f = await hosted(t);
  const pending = new Promise<void>(resolve => {
    const detach = f.owner.onEvent(event => {
      if ((event.event as { type?: string } | undefined)?.type !== "extension_ui_request") return;
      detach();
      resolve();
    });
  });
  await f.owner.call({ type: "prompt", sessionId: f.sessionId, message: "ask Remote question" });
  await pending;
  const session = await f.attach();
  const settled = untilEvent(session, terminalEvent);
  const dialogs: string[] = [];
  await session.bindExtensions({ uiContext: {
    input: async (title: string) => { dialogs.push(title); return "answer-from-native-ui"; },
    notify: () => undefined,
  } });
  await settled;
  assert.deepEqual(dialogs, ["Remote question"]);
  assert.equal(session.getLastAssistantText(), "tool-done:answer:answer-from-native-ui");
  assert.deepEqual((await f.owner.call({ type: "get_state", sessionId: f.sessionId })).data.needsInput, []);
});

test("real daemon: disposing detaches and releases control without aborting the remote tool or closing the shared client", { timeout: 30_000 }, async t => {
  const f = await hosted(t);
  const session = await f.attach();
  await session.prompt("tool detach");
  await waitFor("fixture tool started", () => gate(f.env, "detach").started());
  session.dispose();
  session.dispose();
  await assert.rejects(session.prompt("must not run"), /detached/);
  assert.equal((await f.owner.call({ type: "get_state", sessionId: f.sessionId })).data.isStreaming, true);
  const nextClient = await f.client();
  const next = await f.attach(nextClient);
  const rendered: string[] = [];
  next.subscribe(event => { rendered.push(event.type); });
  assert.ok(rendered.includes("tool_execution_start"), "snapshot restores in-flight tool presentation");
  const settled = untilEvent(next, terminalEvent);
  gate(f.env, "detach").release();
  await settled;
  assert.equal(next.getLastAssistantText(), "tool-done:gate:detach");
});

test("real daemon: transport loss rejects remote commands but leaves the local disconnect escape reachable", { timeout: 30_000 }, async t => {
  const f = await hosted(t);
  let disconnected!: () => void;
  const closed = new Promise<void>(resolve => { disconnected = resolve; });
  let escaped = false;
  const session = await f.attach(f.owner, {
    onDisconnect: disconnected,
    onLocalCommand: async (text: string) => {
      if (text !== "/remote disconnect") return false;
      escaped = true;
      return true;
    },
  });
  await session.prompt("tool disconnected");
  await waitFor("fixture tool started", () => gate(f.env, "disconnected").started());
  const idle = assert.rejects(session.waitForIdle(), /Remote connection closed/);
  f.owner.close();
  await closed;
  await idle;
  assert.equal(session.isIdle, false);
  await assert.rejects(session.abort(), /Remote connection closed/);
  await assert.rejects(session.prompt("must not run"), /Remote connection closed/);
  assert.equal(await session.prompt("/remote disconnect"), "handled");
  assert.equal(escaped, true);
  const next = await f.attach(await f.client());
  assert.equal(next.isStreaming, true);
  const settled = untilEvent(next, terminalEvent);
  gate(f.env, "disconnected").release();
  await settled;
  assert.equal(next.getLastAssistantText(), "tool-done:gate:disconnected");
});
