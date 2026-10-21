import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { DaemonClient } from "../src/client.ts";
import { encodeLine, LineDecoder } from "../src/protocol.ts";
import { RemoteClientSession, type ClientSnapshot } from "../src/remote-client/session.ts";
import { waitFor } from "./helpers.ts";

const targetBuild = "b".repeat(64);
const notice = { operationId: "upgrade-operation", buildId: targetBuild };
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 1, stopReason: "stop" });

function snapshot(generation: string): ClientSnapshot {
  return {
    generation, lastSeq: 10, sessionId: "session-a", cwd: "/remote/work", sessionFile: "/remote/history.jsonl",
    state: { model: undefined, thinkingLevel: "off", isStreaming: false, isCompacting: false,
      steeringMode: "all", followUpMode: "one-at-a-time", sessionId: "session-a", sessionFile: "/remote/history.jsonl",
      autoCompactionEnabled: true, messageCount: 1, pendingMessageCount: 0 },
    messages: [assistant("retained remote history")], entries: [], leafId: null, tools: [], commands: [], models: [], contextUsage: undefined, stats: {},
  };
}

async function peer(t: TestContext, generation: string, buildId = targetBuild) {
  const root = mkdtempSync("/tmp/pur-");
  const sockets = new Set<Socket>();
  const calls: any[] = [];
  let seq = 10;
  let socketCloses = 0;
  const state = snapshot(generation);
  const fixture = { handle: undefined as ((command: any) => Promise<any> | any) | undefined };
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => { sockets.delete(socket); socketCloses++; });
    socket.on("error", () => undefined);
    socket.setEncoding("utf8");
    const decoder = new LineDecoder(line => {
      const command = JSON.parse(line);
      calls.push(command);
      void (async () => {
        let data = await fixture.handle?.(command);
        if (data === undefined) {
          if (command.type === "client_snapshot") data = state;
          if (command.type === "subscribe") data = { generation, lastSeq: seq, truncated: false };
          if (command.type === "acquire_control") data = { needsInput: [] };
          if (command.type === "get_available_thinking_levels") data = { levels: ["off"] };
        }
        socket.write(encodeLine({ id: command.id, type: "response", command: command.type, success: true, data }));
      })().catch(error => socket.write(encodeLine({ id: command.id, type: "response", command: command.type, success: false, error: String(error) })));
    }, () => socket.destroy());
    socket.on("data", (chunk: string) => decoder.push(chunk));
  });
  await new Promise<void>(resolve => server.listen(join(root, "s.sock"), resolve));
  const client = await DaemonClient.connect(join(root, "s.sock"), { hello: false });
  client.server = Object.assign({ protocolVersion: 1, piVersion: VERSION, extensionVersions: {} }, {
    build: { format: 1 as const, contentId: buildId, sourceDigest: "d".repeat(64), piSdkVersion: VERSION,
      nodeVersion: "24.14.1", platform: "darwin-arm64" as const, dependencyLockDigest: "e".repeat(64), protocolVersion: 1, serverVersion: "0.1.0" },
    instanceId: generation,
  });
  t.after(async () => {
    client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  return {
    client, calls, snapshot: state,
    get socketCloses() { return socketCloses; },
    set handle(value: typeof fixture.handle) { fixture.handle = value; },
    send(event: any, envelope: Record<string, unknown> = {}) {
      const message = { type: "event", sessionId: state.sessionId, generation, seq: ++seq, event, ...envelope };
      for (const socket of sockets) socket.write(encodeLine(message));
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function deliver(remote: Awaited<ReturnType<typeof peer>>, event: any, envelope: Record<string, unknown> = {}) {
  const received = deferred();
  const detach = remote.client.onEvent(() => received.resolve());
  remote.send(event, envelope);
  await received.promise;
  detach();
}

async function restart(old: Awaited<ReturnType<typeof peer>>, statuses: string[]) {
  old.send({ type: "runtime_upgrade", phase: "restarting", ...notice });
  await waitFor("upgrade notice armed", () => statuses.includes("restarting"));
  old.client.close();
}

test("announced upgrade replaces only transport and restores snapshots, live events and control without replay", { timeout: 15_000 }, async t => {
  const old = await peer(t, "old-instance", "a".repeat(64));
  const next = await peer(t, "new-instance");
  const statuses: string[] = [];
  let disconnected = 0;
  let replaced = 0;
  let cleanup = 0;
  const session = await RemoteClientSession.connect(old.client, "session-a", {
    reconnectAfterUpgrade: async received => { assert.deepEqual(received, notice); return { client: next.client, dispose: () => { cleanup++; } }; },
    onReconnected: client => { assert.equal(client, next.client); replaced++; },
    onUpgradeStatus: phase => statuses.push(phase), onDisconnect: () => { disconnected++; },
  });
  t.after(() => session.dispose());
  const identity = [session.agent, session.sessionManager, session.modelRuntime, session.extensionRunner];
  const events: string[] = [];
  session.subscribe(event => { events.push(event.type); });
  await restart(old, statuses);
  await waitFor("native view resumed", () => statuses.includes("ready"));
  assert.deepEqual([session.agent, session.sessionManager, session.modelRuntime, session.extensionRunner], identity);
  assert.equal(session.generation, "new-instance");
  assert.equal(session.getLastAssistantText(), "retained remote history");
  assert.equal(replaced, 1);
  assert.equal(disconnected, 0);
  assert.equal(events.filter(type => type === "remote_snapshot").length, 1);
  assert.equal(next.calls.filter(command => command.type === "acquire_control").length, 1);
  assert.equal(next.calls.some(command => ["prompt", "steer", "follow_up", "bash", "abort"].includes(command.type)), false);
  await session.prompt("new remote request");
  assert.equal(next.calls.filter(command => command.type === "prompt").length, 1);
  next.send({ type: "message_start", message: assistant("live after upgrade") });
  next.send({ type: "message_end", message: assistant("live after upgrade") });
  await waitFor("live upgraded reply", () => session.getLastAssistantText() === "live after upgrade");
  session.dispose();
  await waitFor("replacement transport cleaned", () => cleanup === 1);
});

for (const kind of ["unannounced", "invalid"] as const) {
  test(`${kind} disconnect does not invoke upgrade recovery`, async t => {
    const old = await peer(t, "old-instance");
    let reconnects = 0;
    let disconnected = 0;
    const session = await RemoteClientSession.connect(old.client, "session-a", {
      reconnectAfterUpgrade: async () => { reconnects++; throw new Error("must not reconnect"); },
      onDisconnect: () => { disconnected++; },
    });
    t.after(() => session.dispose());
    if (kind === "invalid") old.send({ type: "runtime_upgrade", phase: "restarting", buildId: "../bad", operationId: "bad" });
    old.client.close();
    await waitFor("ordinary disconnect", () => disconnected === 1);
    await assert.rejects(session.prompt("do not execute locally"), /connection closed/);
    assert.equal(reconnects, 0);
  });
}

for (const invalid of ["build", "SDK", "instance", "missing instance", "controller"] as const) {
  test(`upgrade reconnect refuses wrong ${invalid} without replay or stealing control`, { timeout: 15_000 }, async t => {
    const old = await peer(t, "old-instance", "a".repeat(64));
    const next = await peer(t, invalid === "instance" ? "old-instance" : "new-instance", invalid === "build" ? "c".repeat(64) : targetBuild);
    if (invalid === "SDK") next.client.server!.piVersion = "99.0.0";
    if (invalid === "missing instance") delete next.client.server!.instanceId;
    if (invalid === "controller") next.handle = command => { if (command.type === "acquire_control") throw new Error("controller already held"); };
    const statuses: string[] = [];
    let disconnected = 0;
    const session = await RemoteClientSession.connect(old.client, "session-a", {
      reconnectAfterUpgrade: async () => ({ client: next.client }),
      onUpgradeStatus: phase => statuses.push(phase), onDisconnect: () => { disconnected++; },
    });
    t.after(() => session.dispose());
    await restart(old, statuses);
    await waitFor("failed recovery", () => disconnected === 1);
    assert.equal(statuses.includes("ready"), false);
    await assert.rejects(session.prompt("not replayed"), /build|SDK|instance|controller/);
    assert.equal(next.calls.some(command => ["prompt", "steer", "follow_up", "bash", "abort"].includes(command.type)), false);
  });
}

test("an announced stop racing initial control acquisition finishes attachment on the replacement", { timeout: 15_000 }, async t => {
  const old = await peer(t, "old-instance", "a".repeat(64));
  const next = await peer(t, "new-instance");
  old.handle = command => {
    if (command.type === "acquire_control") {
      old.send({ type: "runtime_upgrade", phase: "restarting", ...notice });
      throw new Error("daemon is stopping");
    }
  };
  const session = await RemoteClientSession.connect(old.client, "session-a", {
    reconnectAfterUpgrade: async () => ({ client: next.client }),
  });
  t.after(() => session.dispose());
  assert.equal(session.generation, "new-instance");
  assert.equal(session.getLastAssistantText(), "retained remote history");
  assert.equal(next.calls.filter(command => command.type === "acquire_control").length, 1);
  assert.equal(next.calls.some(command => command.type === "prompt"), false);
});

test("failed recovery during initial control acquisition rejects instead of returning a failed adapter", { timeout: 15_000 }, async t => {
  const old = await peer(t, "old-instance", "a".repeat(64));
  const next = await peer(t, "new-instance");
  old.handle = command => {
    if (command.type === "acquire_control") {
      old.send({ type: "runtime_upgrade", phase: "restarting", ...notice });
      throw new Error("daemon is stopping");
    }
  };
  next.handle = command => { if (command.type === "client_snapshot") throw new Error("replacement snapshot unavailable"); };
  await assert.rejects(RemoteClientSession.connect(old.client, "session-a", {
    reconnectAfterUpgrade: async () => ({ client: next.client }),
  }), /replacement snapshot unavailable/);
  assert.equal(next.calls.some(command => command.type === "acquire_control"), false);
});

test("disconnecting the UI during recovery aborts setup and disposes a late replacement", { timeout: 15_000 }, async t => {
  const old = await peer(t, "old-instance", "a".repeat(64));
  const next = await peer(t, "new-instance");
  const statuses: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let signal: AbortSignal | undefined;
  let cleanup = 0;
  const session = await RemoteClientSession.connect(old.client, "session-a", {
    reconnectAfterUpgrade: async (_notice, received) => { signal = received; await held; return { client: next.client, dispose: () => { cleanup++; } }; },
    onUpgradeStatus: phase => statuses.push(phase),
  });
  await restart(old, statuses);
  await waitFor("replacement setup started", () => Boolean(signal));
  await assert.rejects(session.prompt("not queued"), /paused.*not.*replayed/);
  session.dispose();
  assert.equal(signal!.aborted, true);
  release();
  await waitFor("late replacement disposed", () => cleanup === 1);
  assert.equal(next.calls.some(command => command.type === "client_snapshot"), false);
});

test("an upgrade notice during an older metadata read still recovers with a fresh snapshot", { timeout: 15_000 }, async t => {
  const old = await peer(t, "old-instance", "a".repeat(64));
  const next = await peer(t, "new-instance");
  next.snapshot.tools = [{ name: "new-build-tool" }];
  const statuses: string[] = [];
  const session = await RemoteClientSession.connect(old.client, "session-a", {
    reconnectAfterUpgrade: async () => ({ client: next.client }), onUpgradeStatus: phase => statuses.push(phase),
  });
  t.after(() => session.dispose());
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  old.handle = async command => { if (command.type === "client_snapshot") { await held; return old.snapshot; } };
  const rejected = assert.rejects(session.setModel({ provider: "fake", id: "fake-1" }), /not replayed/);
  await waitFor("old metadata read pending", () => old.calls.filter(command => command.type === "client_snapshot").length === 2);
  try {
    await restart(old, statuses);
    await rejected;
    await waitFor("fresh upgraded metadata", () => statuses.includes("ready"));
    assert.ok(session.getToolDefinition("new-build-tool"));
    assert.equal(next.calls.some(command => command.type === "set_model"), false);
  } finally { release(); }
});

test("a retained old close callback cannot fail the replacement transport", { timeout: 15_000 }, async t => {
  const old = await peer(t, "old-instance", "a".repeat(64));
  const next = await peer(t, "new-instance");
  const statuses: string[] = [];
  let lateClose!: () => void;
  let disconnected = 0;
  const subscribe = old.client.onClose.bind(old.client);
  t.mock.method(old.client, "onClose", (listener: () => void) => { lateClose = listener; return subscribe(listener); });
  const session = await RemoteClientSession.connect(old.client, "session-a", {
    reconnectAfterUpgrade: async () => ({ client: next.client }), onUpgradeStatus: phase => statuses.push(phase),
    onDisconnect: () => { disconnected++; },
  });
  t.after(() => session.dispose());
  await restart(old, statuses);
  await waitFor("new transport ready", () => statuses.includes("ready"));
  lateClose();
  await session.prompt("only the replacement receives this");
  assert.equal(disconnected, 0);
  assert.equal(next.calls.filter(command => command.type === "prompt").length, 1);
});

test("an ambiguous request on the old connection is rejected once and never replayed after upgrade", { timeout: 15_000 }, async t => {
  const old = await peer(t, "old-instance", "a".repeat(64));
  const next = await peer(t, "new-instance");
  const statuses: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  old.handle = async command => { if (command.type === "prompt") await held; };
  const session = await RemoteClientSession.connect(old.client, "session-a", {
    reconnectAfterUpgrade: async () => ({ client: next.client }), onUpgradeStatus: phase => statuses.push(phase),
  });
  t.after(() => { release(); session.dispose(); });
  const rejected = assert.rejects(session.prompt("ambiguous original"), /not replayed/);
  await waitFor("old request admitted", () => old.calls.some(command => command.type === "prompt"));
  await restart(old, statuses);
  await rejected;
  await waitFor("view recovered without replay", () => statuses.includes("ready"));
  assert.equal(next.calls.some(command => command.type === "prompt"), false);
  release();
});

test("a logged restart during the first snapshot attaches to the replacement and transfers disposal ownership", { timeout: 10_000 }, async t => {
  const old = await peer(t, "old-instance", "a".repeat(64));
  const next = await peer(t, "new-instance");
  const held = deferred();
  const requested = deferred();
  old.handle = async command => { if (command.type === "client_snapshot") { requested.resolve(); await held.promise; } };
  t.after(() => held.resolve());
  const statuses: string[] = [];
  let cleanup = 0;
  let reconnects = 0;
  let current = old.client;
  const connecting = RemoteClientSession.connect(old.client, "session-a", {
    reconnectAfterUpgrade: async received => {
      assert.deepEqual(received, notice);
      reconnects++;
      return { client: next.client, dispose: () => { cleanup++; } };
    },
    onReconnected: client => { current = client; },
    onUpgradeStatus: phase => statuses.push(phase),
  });
  await requested.promise;
  await deliver(old, { type: "runtime_upgrade", phase: "restarting", ...notice });
  old.client.close();
  const session = await connecting;
  t.after(() => session.dispose());
  assert.equal(reconnects, 1);
  assert.equal(current, next.client);
  assert.equal(session.generation, "new-instance");
  assert.deepEqual(statuses, ["restarting", "reconnecting", "ready"]);
  assert.equal(next.calls.filter(command => command.type === "acquire_control").length, 1);
  assert.equal(next.calls.some(command => command.type === "prompt"), false);
  await session.prompt("request after the first snapshot recovered");
  assert.equal(old.calls.some(command => command.type === "prompt"), false);
  assert.equal(next.calls.filter(command => command.type === "prompt").length, 1);
  session.dispose();
  session.dispose();
  await waitFor("adopted bootstrap transport closed once", () => cleanup === 1 && next.socketCloses === 1);
});

test("bootstrap recovery keeps the final owner when the first replacement restarts during attachment", { timeout: 10_000 }, async t => {
  const old = await peer(t, "old-instance", "a".repeat(64));
  const next = await peer(t, "new-instance");
  const final = await peer(t, "final-instance", "c".repeat(64));
  const secondNotice = { operationId: "second-upgrade", buildId: "c".repeat(64) };
  const held = deferred();
  const requested = deferred();
  old.handle = async command => { if (command.type === "client_snapshot") { requested.resolve(); await held.promise; } };
  next.handle = command => {
    if (command.type === "acquire_control") {
      next.send({ type: "runtime_upgrade", phase: "restarting", ...secondNotice });
      throw new Error("daemon is stopping");
    }
  };
  t.after(() => held.resolve());
  const received: unknown[] = [];
  const cleaned: string[] = [];
  const adopted: DaemonClient[] = [];
  const connecting = RemoteClientSession.connect(old.client, "session-a", {
    reconnectAfterUpgrade: async value => {
      received.push(value);
      const selected = received.length === 1 ? next : final;
      return { client: selected.client, dispose: () => { cleaned.push(selected.snapshot.generation); } };
    },
    onReconnected: client => adopted.push(client),
  });
  await requested.promise;
  await deliver(old, { type: "runtime_upgrade", phase: "restarting", ...notice });
  old.client.close();
  const session = await connecting;
  t.after(() => session.dispose());
  assert.deepEqual(received, [notice, secondNotice]);
  assert.deepEqual(adopted, [final.client]);
  assert.equal(session.generation, "final-instance");
  await session.prompt("work after both initial transports restarted");
  assert.equal(next.calls.some(command => command.type === "prompt"), false);
  assert.equal(final.calls.filter(command => command.type === "prompt").length, 1);
  session.dispose();
  await waitFor("bootstrap owners both disposed", () => cleaned.length === 2 && next.socketCloses === 1 && final.socketCloses === 1);
  assert.deepEqual(cleaned, ["new-instance", "final-instance"]);
});

for (const invalid of ["session", "fractional sequence", "zero sequence", "stale sequence", "missing generation", "different generation"] as const) {
  test(`first snapshot recovery rejects a notice with ${invalid}`, { timeout: 10_000 }, async t => {
    const old = await peer(t, "old-instance");
    const held = deferred();
    const requested = deferred();
    old.handle = async command => { if (command.type === "client_snapshot") { requested.resolve(); await held.promise; } };
    t.after(() => held.resolve());
    let reconnects = 0;
    const connecting = assert.rejects(RemoteClientSession.connect(old.client, "session-a", {
      reconnectAfterUpgrade: async () => { reconnects++; throw new Error("unexpected recovery"); },
    }), /connection closed/);
    await requested.promise;
    await deliver(old, { type: "turn_start" });
    const envelope = invalid === "session" ? { sessionId: "session-b" }
      : invalid === "fractional sequence" ? { seq: 12.5 }
      : invalid === "zero sequence" ? { seq: 0 }
      : invalid === "stale sequence" ? { seq: 11 }
      : { generation: invalid === "missing generation" ? undefined : "other-generation" };
    await deliver(old, { type: "runtime_upgrade", phase: "restarting", ...notice }, envelope);
    old.client.close();
    await connecting;
    assert.equal(reconnects, 0);
  });
}

for (const invalid of ["build", "SDK", "instance", "missing instance"] as const) {
  test(`first snapshot recovery validates replacement ${invalid} before adoption`, { timeout: 10_000 }, async t => {
    const old = await peer(t, "old-instance", "a".repeat(64));
    const next = await peer(t, invalid === "instance" ? "old-instance" : "new-instance", invalid === "build" ? "c".repeat(64) : targetBuild);
    if (invalid === "SDK") next.client.server!.piVersion = "99.0.0";
    if (invalid === "missing instance") delete next.client.server!.instanceId;
    const held = deferred();
    const requested = deferred();
    old.handle = async command => { if (command.type === "client_snapshot") { requested.resolve(); await held.promise; } };
    t.after(() => held.resolve());
    let cleanup = 0;
    const connecting = assert.rejects(RemoteClientSession.connect(old.client, "session-a", {
      reconnectAfterUpgrade: async () => ({ client: next.client, dispose: () => { cleanup++; } }),
    }), /build|SDK|instance/);
    await requested.promise;
    await deliver(old, { type: "runtime_upgrade", phase: "restarting", ...notice });
    old.client.close();
    await connecting;
    await waitFor("invalid bootstrap replacement closed", () => next.socketCloses === 1);
    assert.equal(cleanup, 1);
    assert.equal(next.calls.length, 0);
  });
}

test("replacement readiness waits for the subscription cursor while replay metadata is held", { timeout: 10_000 }, async t => {
  const old = await peer(t, "old-instance", "a".repeat(64));
  const next = await peer(t, "new-instance");
  const metadata = deferred();
  const requested = deferred();
  let snapshots = 0;
  next.handle = async command => {
    if (command.type === "client_snapshot" && ++snapshots === 2) { requested.resolve(); await metadata.promise; }
    if (command.type === "subscribe") {
      next.send({ type: "turn_end" });
      next.send({ type: "session_info_changed", name: "replayed through twelve" });
      return { generation: "new-instance", lastSeq: 12, truncated: false };
    }
  };
  const statuses: string[] = [];
  let replaced = 0;
  const session = await RemoteClientSession.connect(old.client, "session-a", {
    reconnectAfterUpgrade: async () => ({ client: next.client }),
    onReconnected: () => { replaced++; }, onUpgradeStatus: phase => statuses.push(phase),
  });
  t.after(() => { metadata.resolve(); session.dispose(); });
  await restart(old, statuses);
  await requested.promise;
  assert.equal(session.lastSeq, 11);
  assert.equal(session.isIdle, false);
  assert.equal(statuses.includes("ready"), false);
  assert.equal(replaced, 0);
  await assert.rejects(session.prompt("must stay paused at eleven"), /reconnecting/);
  metadata.resolve();
  await waitFor("subscription replay completed", () => statuses.includes("ready"));
  assert.equal(session.lastSeq, 12);
  assert.equal(session.sessionName, "replayed through twelve");
  assert.equal(session.isIdle, true);
  await session.prompt("allowed after twelve");
  assert.deepEqual(next.calls.filter(command => command.type === "prompt").map(command => command.message), ["allowed after twelve"]);
});

for (const stage of ["acquire_control", "get_available_thinking_levels", "replay"] as const) {
  for (const closeBeforeReady of [false, true]) {
    test(`second upgrade announced during ${stage}, closing ${closeBeforeReady ? "before" : "after"} ready, reaches the successive build`, { timeout: 10_000 }, async t => {
      const old = await peer(t, "old-instance", "a".repeat(64));
      const next = await peer(t, "new-instance");
      const final = await peer(t, "final-instance", "c".repeat(64));
      const secondNotice = { operationId: "second-upgrade", buildId: "c".repeat(64) };
      const held = deferred();
      const requested = deferred();
      let snapshots = 0;
      next.handle = async command => {
        if (stage === "replay" && command.type === "subscribe") {
          next.send({ type: "turn_end" });
          return { generation: "new-instance", lastSeq: 12, truncated: false };
        }
        if (command.type === "client_snapshot") snapshots++;
        if (command.type === stage || (stage === "replay" && command.type === "client_snapshot" && snapshots === 2)) {
          requested.resolve();
          await held.promise;
        }
      };
      const statuses: Array<{ phase: string; buildId: string }> = [];
      const received: unknown[] = [];
      const cleaned: string[] = [];
      const adopted: DaemonClient[] = [];
      let disconnected = 0;
      const session = await RemoteClientSession.connect(old.client, "session-a", {
        reconnectAfterUpgrade: async value => {
          received.push(value);
          const selected = received.length === 1 ? next : final;
          return { client: selected.client, dispose: () => { cleaned.push(selected.snapshot.generation); } };
        },
        onReconnected: client => adopted.push(client),
        onUpgradeStatus: (phase, value) => statuses.push({ phase, buildId: value.buildId }),
        onDisconnect: () => { disconnected++; },
      });
      t.after(() => { held.resolve(); session.dispose(); });
      const identity = session.agent;
      await deliver(old, { type: "runtime_upgrade", phase: "restarting", ...notice });
      old.client.close();
      await requested.promise;
      await deliver(next, { type: "runtime_upgrade", phase: "restarting", ...secondNotice });
      if (!closeBeforeReady) {
        held.resolve();
        await waitFor("first replacement ready", () => statuses.some(value => value.phase === "ready" && value.buildId === targetBuild));
      }
      next.client.close();
      await waitFor("second replacement ready", () => statuses.some(value => value.phase === "ready" && value.buildId === secondNotice.buildId));
      assert.deepEqual(received, [notice, secondNotice]);
      assert.equal(session.agent, identity);
      assert.equal(session.generation, "final-instance");
      assert.equal(disconnected, 0);
      assert.deepEqual(adopted, closeBeforeReady ? [final.client] : [next.client, final.client]);
      assert.equal(next.calls.some(command => command.type === "prompt"), false);
      assert.equal(final.calls.some(command => command.type === "prompt"), false);
      await session.prompt("only the current client receives new work");
      assert.deepEqual(final.calls.filter(command => command.type === "prompt").map(command => command.message), ["only the current client receives new work"]);
      session.dispose();
      session.dispose();
      await waitFor("both owned transports closed", () => cleaned.length === 2 && next.socketCloses === 1 && final.socketCloses === 1);
      assert.deepEqual(cleaned, ["new-instance", "final-instance"]);
      assert.equal(old.socketCloses, 1);
      held.resolve();
    });
  }
}

for (const stage of ["client_snapshot", "acquire_control"] as const) {
  test(`detach after replacement adoption with held ${stage} cleans up once and cannot resume`, { timeout: 10_000 }, async t => {
    const old = await peer(t, "old-instance", "a".repeat(64));
    const next = await peer(t, "new-instance");
    const held = deferred();
    const requested = deferred();
    next.handle = async command => { if (command.type === stage) { requested.resolve(); await held.promise; } };
    const statuses: string[] = [];
    let cleanup = 0;
    let replaced = 0;
    let signal: AbortSignal | undefined;
    const session = await RemoteClientSession.connect(old.client, "session-a", {
      reconnectAfterUpgrade: async (_notice, value) => { signal = value; return { client: next.client, dispose: () => { cleanup++; } }; },
      onReconnected: () => { replaced++; }, onUpgradeStatus: phase => statuses.push(phase),
    });
    t.after(() => { held.resolve(); session.dispose(); });
    await restart(old, statuses);
    await requested.promise;
    session.dispose();
    session.dispose();
    await waitFor("adopted replacement disposed", () => cleanup === 1 && next.socketCloses === 1);
    assert.equal(signal!.aborted, true);
    held.resolve();
    await assert.rejects(session.prompt("detached work"), /detached/);
    assert.equal(replaced, 0);
    assert.equal(statuses.includes("ready"), false);
    assert.equal(next.calls.some(command => command.type === "get_available_thinking_levels"), false);
    assert.equal(next.calls.some(command => command.type === "prompt"), false);
  });
}
