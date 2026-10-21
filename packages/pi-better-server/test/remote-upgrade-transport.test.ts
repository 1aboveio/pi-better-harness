import assert from "node:assert/strict";
import { once, getEventListeners } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { DaemonClient, HandshakeError } from "../src/client.ts";
import { resolveTarget, type Target } from "../src/remote/target.ts";
import { openUpgradeTransport } from "../src/remote-client/upgrade-transport.ts";

function resources() {
  const closed = { target: 0, client: 0 };
  const target: Target = {
    socketPath: "/private/forward.sock", close: async () => { closed.target++; },
    forwardSocket: async socketPath => ({ socketPath, close: async () => {} }),
  };
  const client = {
    server: { capabilities: ["native-client-v1"] }, close: () => { closed.client++; },
  } as unknown as DaemonClient;
  return { closed, target, client };
}

test("upgrade setup announces transport recovery and retains ownership until adopted", async () => {
  const { target, client, closed } = resources();
  const abort = new AbortController();
  const replacement = await openUpgradeTransport({ host: "isolated", remoteDir: "/preserved/state", ensureServer: true, managedRuntime: true }, {
    resolveTarget: async options => {
      assert.equal(options.ensureServer, false);
      assert.equal(options.signal, abort.signal);
      assert.equal(options.remoteDir, "/preserved/state");
      return target;
    },
    connectClient: async (socket, options) => {
      assert.equal(socket, target.socketPath);
      assert.equal(options?.signal, abort.signal);
      assert.deepEqual(options?.hello, { capabilities: ["runtime-reconnect-v1"] });
      return client;
    },
  }, abort.signal);
  assert.equal(replacement.client, client);
  assert.deepEqual(closed, { target: 0, client: 0 });
  await replacement.dispose?.();
  assert.deepEqual(closed, { target: 1, client: 0 }, "the adopted session owns client teardown");
});

test("cancellation before setup does not resolve or connect", async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(openUpgradeTransport({}, {
    resolveTarget: async () => { throw new Error("must not resolve"); },
  }, abort.signal), { name: "AbortError" });
});

test("a target arriving after cancellation is cleaned without connecting", async () => {
  const { target, closed } = resources();
  const abort = new AbortController();
  await assert.rejects(openUpgradeTransport({}, {
    resolveTarget: async () => { abort.abort(); return target; },
    connectClient: async () => { throw new Error("must not connect"); },
  }, abort.signal), { name: "AbortError" });
  assert.deepEqual(closed, { target: 1, client: 0 });
});

test("a failed replacement handshake releases only its provisional target", async () => {
  const { target, closed } = resources();
  await assert.rejects(openUpgradeTransport({}, {
    resolveTarget: async () => target,
    connectClient: async () => { throw new Error("handshake rejected"); },
  }, new AbortController().signal), /handshake rejected/);
  assert.deepEqual(closed, { target: 1, client: 0 });
});

for (const reason of ["cancelled", "incompatible"] as const) {
  test(`a ${reason} client arriving during replacement setup is closed with its target`, async () => {
    const { target, client, closed } = resources();
    const abort = new AbortController();
    await assert.rejects(openUpgradeTransport({}, {
      resolveTarget: async () => target,
      connectClient: async () => {
        if (reason === "cancelled") abort.abort();
        else client.server!.capabilities = [];
        return client;
      },
    }, abort.signal), reason === "cancelled" ? { name: "AbortError" } : /does not support/);
    assert.deepEqual(closed, { target: 1, client: 1 });
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function helloServer(t: TestContext, respond: (socket: Socket, request: any, attempt: number) => void) {
  const root = mkdtempSync("/tmp/put-");
  const socketPath = join(root, "daemon.sock");
  const sockets = new Set<Socket>();
  const requests: any[] = [];
  let attempts = 0;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    const attempt = ++attempts;
    let data = "";
    socket.on("data", chunk => {
      data += chunk;
      for (;;) {
        const end = data.indexOf("\n");
        if (end < 0) break;
        const request = JSON.parse(data.slice(0, end));
        data = data.slice(end + 1);
        requests.push(request);
        respond(socket, request, attempt);
      }
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  return { socketPath, requests };
}

function hello(socket: Socket, request: any, buildId: string) {
  socket.write(JSON.stringify({ id: request.id, type: "response", success: true, data: {
    protocolVersion: 1, piVersion: VERSION, capabilities: ["native-client-v1"], buildId, instanceId: `${buildId}-instance`,
  } }) + "\n");
}

test("closed old transport and valid old hello are cleaned before reaching the announced build; only hello is sent", async t => {
  const peers = new Map<number, Socket>();
  const f = await helloServer(t, (socket, request, attempt) => {
    peers.set(attempt, socket);
    if (attempt === 1) socket.destroy();
    else hello(socket, request, attempt === 2 ? "old-build" : "announced-build");
  });
  const controller = new AbortController();
  let resolved = 0;
  const closed: number[] = [];
  const replacement = await openUpgradeTransport({ socket: f.socketPath, ensureServer: true, managedRuntime: true }, {
    resolveTarget: async options => {
      const attempt = ++resolved;
      assert.deepEqual(closed, Array.from({ length: attempt - 1 }, (_, index) => index + 1));
      const target = await resolveTarget(options);
      assert.equal(target.serverDir, undefined, "an explicit socket must not invent a state directory");
      return { ...target, close: async () => {
        // Wait for peer close to prove the helper closed the provisional real client too.
        const peer = peers.get(attempt);
        if (peer && !peer.destroyed) await once(peer, "close");
        closed.push(attempt);
        await target.close();
      } };
    },
    retryDelayMs: 1,
  }, controller.signal, "announced-build");
  assert.equal((replacement.client.server as any).buildId, "announced-build");
  assert.equal(resolved, 3);
  assert.deepEqual(closed, [1, 2]);
  assert.deepEqual(f.requests.map(request => request.type), ["hello", "hello", "hello"]);
  assert.ok(f.requests.every(request => request.capabilities.includes("runtime-reconnect-v1")));
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  replacement.client.close();
  await replacement.dispose?.();
  assert.deepEqual(closed, [1, 2, 3]);
});

for (const error of [
  Object.assign(new Error("not ready"), { code: "ENOENT" }),
  Object.assign(new Error("not ready"), { code: "ECONNREFUSED" }),
  Object.assign(new Error("not ready"), { code: "ECONNRESET" }),
  Object.assign(new Error("not ready"), { code: "ETIMEDOUT" }),
  new DOMException("not ready", "TimeoutError"), new Error("Timeout"),
]) {
  test(`retries transient setup failure ${"code" in error ? error.code : error.name + ":" + error.message}`, async () => {
    const { target, client, closed } = resources();
    Object.assign(client.server!, { buildId: "announced-build" });
    let attempts = 0;
    const replacement = await openUpgradeTransport({}, {
      resolveTarget: async () => target,
      connectClient: async () => { if (++attempts === 1) throw error; return client; },
      retryDelayMs: 1,
    }, new AbortController().signal, "announced-build");
    assert.equal(attempts, 2);
    assert.deepEqual(closed, { target: 1, client: 0 });
    replacement.client.close();
    await replacement.dispose?.();
  });
}

for (const failure of ["handshake", "capability", "SDK", "identity", "configuration", "missing ssh"] as const) {
  test(`does not retry permanent ${failure} failure while waiting for a build`, async () => {
    const { target, client, closed } = resources();
    Object.assign(client.server!, { buildId: "old-build", instanceId: "old-instance", piVersion: VERSION, protocolVersion: 1 });
    if (failure === "capability") client.server!.capabilities = [];
    if (failure === "SDK") client.server!.piVersion = "incompatible";
    if (failure === "identity") delete (client.server as any).buildId;
    let attempts = 0;
    await assert.rejects(openUpgradeTransport({}, {
      resolveTarget: async () => {
        attempts++;
        if (failure === "configuration") throw new Error("--remote-dir must be an absolute path");
        if (failure === "missing ssh") throw Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" });
        return target;
      },
      connectClient: async () => {
        if (failure === "handshake") throw new HandshakeError("connection closed");
        return client;
      },
      retryDelayMs: 1,
    }, new AbortController().signal, "announced-build"), failure === "handshake" ? { name: "HandshakeError" }
      : failure === "missing ssh" ? /spawn ssh ENOENT/ : failure === "configuration" ? /absolute path/ : failure === "capability" ? /does not support/ : failure === "SDK" ? /incompatible SDK/ : /no build or instance/);
    assert.equal(attempts, 1);
    assert.deepEqual(closed, { target: ["configuration", "missing ssh"].includes(failure) ? 0 : 1, client: ["configuration", "missing ssh", "handshake"].includes(failure) ? 0 : 1 });
  });
}

test("cancellation during backoff prevents another attempt and removes signal listeners", async () => {
  const { target, closed } = resources();
  const cleaned = deferred<void>();
  const controller = new AbortController();
  let attempts = 0;
  const pending = openUpgradeTransport({}, {
    resolveTarget: async () => { attempts++; return { ...target, close: async () => { await target.close(); cleaned.resolve(); } }; },
    connectClient: async () => { throw new Error("connection closed"); },
    retryDelayMs: 60_000,
  }, controller.signal, "announced-build");
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await cleaned.promise;
  await nextTurn();
  controller.abort();
  await rejected;
  assert.equal(attempts, 1);
  assert.deepEqual(closed, { target: 1, client: 0 });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

for (const stage of ["target", "client"] as const) {
  test(`cancellation returns promptly and disposes a late ${stage} even if setup ignores the signal`, async () => {
    const { target, client, closed } = resources();
    const controller = new AbortController();
    const arrived = deferred<void>();
    const lateTarget = deferred<Target>(), lateClient = deferred<DaemonClient>();
    const pending = openUpgradeTransport({}, {
      resolveTarget: async () => { if (stage === "target") { arrived.resolve(); return lateTarget.promise; } return target; },
      connectClient: async () => { arrived.resolve(); return lateClient.promise; },
    }, controller.signal, "announced-build");
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await arrived.promise;
    controller.abort();
    await rejected;
    lateTarget.resolve(target);
    lateClient.resolve(client);
    await nextTurn();
    assert.deepEqual(closed, { target: 1, client: stage === "client" ? 1 : 0 });
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
}

test("a valid old build stops at the deadline instead of being adopted or retried forever", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { target, client, closed } = resources();
  Object.assign(client.server!, { buildId: "old-build", instanceId: "old-instance", piVersion: VERSION, protocolVersion: 1 });
  let attempts = 0;
  const controller = new AbortController();
  const pending = openUpgradeTransport({}, {
    resolveTarget: async () => { attempts++; return target; }, connectClient: async () => client,
    timeoutMs: 100, retryDelayMs: 250,
  }, controller.signal, "announced-build");
  const rejected = assert.rejects(pending, { name: "TimeoutError" });
  await nextTurn();
  assert.deepEqual(closed, { target: 1, client: 1 });
  t.mock.timers.tick(100);
  await rejected;
  assert.equal(attempts, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("the deadline returns even if target cleanup is delayed, while cleanup remains owned", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { target, closed } = resources();
  const cleanup = deferred<void>();
  let cleanupStarted = false;
  const pending = openUpgradeTransport({}, {
    resolveTarget: async () => ({ ...target, close: async () => { cleanupStarted = true; await cleanup.promise; await target.close(); } }),
    connectClient: async () => { throw new Error("connection closed"); }, timeoutMs: 100,
  }, new AbortController().signal, "announced-build");
  const rejected = assert.rejects(pending, { name: "TimeoutError" });
  await nextTurn();
  assert.equal(cleanupStarted, true);
  t.mock.timers.tick(100);
  await rejected;
  cleanup.resolve();
  await nextTurn();
  assert.deepEqual(closed, { target: 1, client: 0 });
});

test("the bounded deadline aborts a stalled real hello and releases its target", async t => {
  const received = deferred<Socket>();
  const f = await helloServer(t, socket => { received.resolve(socket); });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  let closed = 0;
  const pending = openUpgradeTransport({ socket: f.socketPath }, {
    resolveTarget: async options => ({ ...await resolveTarget(options), close: async () => { closed++; } }),
    timeoutMs: 100,
  }, controller.signal, "announced-build");
  const rejected = assert.rejects(pending, { name: "TimeoutError" });
  const peer = await received.promise;
  const peerClosed = once(peer, "close");
  t.mock.timers.tick(100);
  await rejected;
  await peerClosed;
  assert.equal(closed, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.deepEqual(f.requests.map(request => request.type), ["hello"]);
});