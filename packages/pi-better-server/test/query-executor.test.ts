import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { Worker } from "node:worker_threads";
import { WorkQueryExecutor } from "../src/runtime/query-executor.ts";
import { WorkClient } from "../src/runtime/work-client.mjs";

async function fixture(options: { intervalMs?: number; capacity?: number; timeoutMs?: number; watchdogMs?: number; workerUrl?: URL; onTerminalLogsChanged?: (ids: string[]) => Promise<void> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "query-root-"));
  mkdirSync(join(root, "runs"));
  const transport = mkdtempSync("/tmp/query-socket-");
  const executor = new WorkQueryExecutor(root, "query-instance", { ...options,
    workerUrl: options.workerUrl ?? new URL("./support/slow-query-worker.mjs", import.meta.url),
    modelOptions: { baseDir: root, durableDir: join(root, "durable"), intervalMs: options.intervalMs ?? 60000 } });
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    const queries = executor.connect(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        const command = JSON.parse(line);
        const reply = (data: unknown, error?: unknown) => {
          if (!socket.destroyed) socket.write(JSON.stringify({ type: "response", id: command.id,
            success: !error, data, error: error ? String(error) : undefined }) + "\n");
        };
        if (["hello", "ping"].includes(command.type)) { reply({ ok: true }); continue; }
        try { void queries.handle(command).then(data => {
          if (!socket.destroyed) socket.write(JSON.stringify({ type: "response", id: command.id, success: true }).slice(0, -1) + ',"data":' + data.json + "}\n");
        }, error => reply(undefined, error)); }
        catch (error) { reply(undefined, error); }
      }
    });
  });
  const path = join(transport, "query.sock");
  server.listen(path); await once(server, "listening");
  const clients: WorkClient[] = [];
  const client = async () => { const value = new WorkClient(path, root); clients.push(value); await value.ready; return value; };
  const worker = (executor as unknown as { worker: Worker }).worker;
  const bootstrapped = new Promise<void>(resolve => {
    const listener = (message: any) => { if (message.type === "fixture-ready") { worker.off("message", listener); resolve(); } };
    worker.on("message", listener);
  });
  const stall = async (iterations = 3000000) => {
    const started = new Promise<void>(resolve => {
      const listener = (message: any) => { if (message.type === "diagnostic-started") { worker.off("message", listener); resolve(); } };
      worker.on("message", listener);
    });
    const finished = new Promise<number>((resolve, reject) => {
      const cleanup = () => { worker.off("message", listener); worker.off("exit", exited); worker.off("error", failed); };
      const listener = (message: any) => { if (message.type === "diagnostic-finished") { cleanup(); resolve(message.durationMs); } };
      const exited = (code: number) => { cleanup(); reject(new Error(`diagnostic worker exited before completing SQLite work (code ${code})`)); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      worker.on("message", listener); worker.once("exit", exited); worker.once("error", failed);
    });
    // Some watchdog tests intentionally discard the completion promise.
    void finished.catch(() => {});
    worker.postMessage({ type: "diagnostic-stall", iterations }); await started;
    return { finished };
  };
  const close = async () => {
    clients.forEach(client => client.close()); sockets.forEach(socket => socket.destroy());
    await new Promise<void>(resolve => server.close(() => resolve())); await executor.close();
    rmSync(root, { recursive: true, force: true }); rmSync(transport, { recursive: true, force: true });
  };
  return { executor, client, stall, worker, bootstrapped, close, root, path };
}

async function ready(client: WorkClient) {
  await client.subscribe({});
  if (client.snapshot?.status === "ready") return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { stop(); reject(new Error("read worker did not finish its initial inventory")); }, 5000);
    const stop = client.onChange(snapshot => { if (snapshot.status === "ready") { clearTimeout(timeout); stop(); resolve(); } });
  });
}

test("identical Work identities do not share visible results across admitted roots", { timeout: 10000 }, async () => {
  const left = await fixture(), right = await fixture();
  try {
    const clients = [await left.client(), await right.client()];
    await Promise.all(clients.map(ready));
    for (const [index, f] of [left, right].entries()) {
      mkdirSync(join(f.root, "runs/sa_same"));
      writeFileSync(join(f.root, "runs/sa_same/meta.json"), JSON.stringify({ id: "sa_same", cwd: "/same-workspace",
        callbackOrigin: { cwd: "/same-workspace", sessionId: "same-session" }, status: "completed", startedAt: 1, name: `root-${index}` }));
      await f.executor.livenessReasons();
    }
    const scope = { cwd: "/same-workspace", sessionId: "same-session", id: "sa_same" };
    assert.equal((await clients[0]!.get(scope)).rows[0]!.meta.name, "root-0");
    assert.equal((await clients[1]!.get(scope)).rows[0]!.meta.name, "root-1");
    assert.equal((await clients[0]!.get({ ...scope, sessionId: "other" })).rows.length, 0);
  } finally { await left.close(); await right.close(); }
});

for (const count of [1, 5, 10]) test(`${count} socket clients share scoped query and encoding work`, { timeout: 15000 }, async () => {
  const f = await fixture();
  const scope = { cwd: join(f.root, "b"), limit: 1 };
  const write = (id: string, cwd: string, name: string) => {
    mkdirSync(join(f.root, "runs", id), { recursive: true });
    writeFileSync(join(f.root, "runs", id, "meta.json"), JSON.stringify({ id, cwd, name, status: "completed", startedAt: 1 }));
  };
  try {
    const first = await f.client(); await ready(first);
    write("sa_a", join(f.root, "a"), "a"); write("sa_b1", scope.cwd, "b1"); write("sa_b2", scope.cwd, "b2");
    await f.executor.livenessReasons();
    const clients = [first, ...await Promise.all(Array.from({ length: count - 1 }, () => f.client()))];
    for (const client of clients) await client.subscribe(scope);
    const page = await first.get(scope);
    const before = f.executor.metrics() as any;
    let events = 0;
    let phase = "metadata-update";
    const frameSummary = (value: any) => {
      const cursor = value.nextCursor ?? value.rows?.[0]?.cursor;
      let publicationScope;
      if (cursor) {
        try {
          const [key, instanceId, tokenRevision] = JSON.parse(Buffer.from(cursor, "base64url").toString());
          publicationScope = { key, instanceId, tokenRevision };
        } catch (error) { publicationScope = { decodeError: String(error) }; }
      }
      return { status: value.status, reason: value.reason, seq: value.seq, scopeRevision: value.scopeRevision,
        instanceId: value.instanceId, publicationScope, observedRevisionVector: value.observedRevisionVector,
        resyncRequired: value.resyncRequired, resyncReason: value.resyncReason,
        totalMatching: value.totalMatching, activity: value.activity, nextDeadline: value.nextDeadline,
        rows: value.rows?.map((row: any) => ({ id: row.meta.id, cwd: row.meta.cwd, name: row.meta.name,
          origin: row.meta.callbackOrigin, state: row.assignment.state, sourceRevision: row.sourceRevision })) };
    };
    const frames: Array<{ subscriber: number; phase: string; snapshot: ReturnType<typeof frameSummary> }> = [];
    const stops = clients.map((client, subscriber) => client.onChange(value => {
      events++;
      if (frames.length < 32) frames.push({ subscriber, phase, snapshot: frameSummary(value) });
    }));
    write("sa_a", join(f.root, "a"), "unrelated"); await f.executor.livenessReasons();
    phase = "log-append";
    appendFileSync(join(f.root, "runs/sa_a/output.log"), '{"type":"agent_end"}\n'); await f.executor.livenessReasons();
    phase = "workspace-move";
    write("sa_a", join(f.root, "c"), "moved"); await f.executor.livenessReasons();
    phase = "terminal-update";
    const meta = join(f.root, "runs/sa_a/meta.json");
    writeFileSync(meta, JSON.stringify({ id: "sa_a", cwd: join(f.root, "c"), status: "failed", startedAt: 1 }));
    await f.executor.livenessReasons();
    phase = "deletion";
    rmSync(join(f.root, "runs/sa_a"), { recursive: true }); await f.executor.livenessReasons();
    phase = "final-scoped-read";
    for (const client of clients) await client.get(scope);
    const unchanged = f.executor.metrics() as any;
    try { assert.equal(events, 0, "unrelated content sends no scoped frames"); }
    catch (error) {
      console.error(`Scoped publication failure: ${JSON.stringify({ scope, clients: count, events,
        omittedFrames: events - frames.length, baseline: frameSummary(page), frames,
        final: clients.map(client => frameSummary(client.snapshot)), before, after: unchanged })}`);
      throw error;
    }
    assert.equal(unchanged.queryCount, before.queryCount, "unrelated content retains the cached page");
    assert.equal(unchanged.serializationCount, before.serializationCount);
    const next = await first.get({ ...scope, cursor: page.nextCursor });
    assert.equal(next.rows.length, 1);
    const baseline = f.executor.metrics() as any;
    const received = clients.map(client => new Promise<void>(resolve => {
      const stop = client.onChange(value => { if (value.rows.some((row: any) => row.meta.name === "changed")) { stop(); resolve(); } });
    }));
    write("sa_b2", scope.cwd, "changed"); await f.executor.livenessReasons(); await Promise.all(received);
    await first.get(scope);
    const changed = f.executor.metrics() as any;
    assert.equal(changed.queryCount - baseline.queryCount, 1);
    assert.equal(changed.serializationCount - baseline.serializationCount, 1);
    assert.equal(changed.eventEncoding.serializations - baseline.eventEncoding.serializations, 1);
    assert.equal(changed.eventEncoding.frames - baseline.eventEncoding.frames, count);
    assert.ok(changed.eventEncoding.bytes > baseline.eventEncoding.bytes);
    stops.forEach(stop => stop());
  } finally { await f.close(); }
});

test("stalled diagnostic completion rejects when its worker exits", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const client = await f.client(); await ready(client);
    const busy = await f.stall();
    const rejected = assert.rejects(busy.finished, /worker exited before completing/);
    await f.worker.terminate();
    await rejected;
  } finally { await f.close(); }
});

test("slow caller cancellation preserves other clients and ignores late replies", { timeout: 10000 }, async t => {
  const f = await fixture({ timeoutMs: 700, watchdogMs: 2000,
    workerUrl: new URL("./support/cancellable-query-worker.mjs", import.meta.url) });
  try {
    const a = await f.client(), b = await f.client(); await ready(b);
    const epoch = b.snapshot!.instanceId;
    const blocked = new Promise<void>(resolve => f.worker.on("message", message => { if (message.type === "query-blocked") resolve(); }));
    const began = performance.now();
    const slow = assert.rejects(a.request("runtime_get_snapshot", { scope: { id: "sa_slow" } }), /runtime-timeout: caller/);
    await blocked;
    await new Promise(resolve => setTimeout(resolve, 150));
    const queued = b.request("runtime_get_snapshot", { scope: { limit: 2 } });
    const controlStart = performance.now();
    assert.equal((await b.request("ping")).ok, true);
    assert.deepEqual(await a.request("runtime_unsubscribe"), { unsubscribed: true });
    const controlMs = performance.now() - controlStart;
    await slow;
    const timeoutMs = performance.now() - began;
    assert.equal((await queued).status, "ready", "cancellation frees execution without waiting for the slow source");
    assert.equal(f.executor.metrics().executor.restarts, 0);
    assert.equal(b.snapshot!.instanceId, epoch);
    f.worker.postMessage({ type: "release-query" });
    const fresh = await b.get({ limit: 3 });
    assert.equal(fresh.status, "ready");
    assert.equal(f.executor.metrics().executor.worker, "running");
    assert.equal(f.executor.metrics().executor.active, 0);
    assert.ok(controlMs < 500);
    t.diagnostic(JSON.stringify({ timeoutMs, controlMs, rebuilding: fresh.status, restart: f.executor.metrics().executor.restarts,
      queueMs: f.executor.metrics().executor.waitMs, executionMs: f.executor.metrics().executor.readMs }));
  } finally { await f.close(); }
});

test("shared callers have separate deadlines and queue timeouts retain bounded admission", { timeout: 10000 }, async () => {
  const f = await fixture({ timeoutMs: 800, watchdogMs: 2500, capacity: 2,
    workerUrl: new URL("./support/cancellable-query-worker.mjs", import.meta.url) });
  try {
    const a = await f.client(), b = await f.client(), c = await f.client(); await ready(a);
    const first = assert.rejects(a.request("runtime_get_snapshot", { scope: { id: "sa_slow" } }), /runtime-timeout/);
    const queued = assert.rejects(c.request("runtime_get_snapshot", { scope: { limit: 2 } }), /runtime-overloaded: queued/);
    await new Promise(resolve => setTimeout(resolve, 450));
    const survivor = b.request("runtime_get_snapshot", { scope: { id: "sa_slow" } });
    await assert.rejects(c.get({ limit: 3 }), /queue is full/);
    await Promise.all([first, queued]);
    assert.equal(f.executor.metrics().executor.queued, 0);
    f.worker.postMessage({ type: "release-query" });
    assert.equal((await survivor).status, "ready");
    assert.equal(f.executor.metrics().executor.restarts, 0);
    assert.equal(f.executor.metrics().executor.singleflightHits, 1);
    assert.equal(f.executor.metrics().executor.queueTimeouts, 1);
    assert.equal(f.executor.metrics().executor.callerTimeouts, 1);
  } finally { await f.close(); }
});

test("watchdog recovers a genuinely wedged worker while socket control stays responsive", { timeout: 10000 }, async t => {
  const f = await fixture({ timeoutMs: 400, watchdogMs: 1200,
    workerUrl: new URL("./support/cancellable-query-worker.mjs", import.meta.url) });
  try {
    // The 400 ms read deadline tests the wedge, not cold worker imports.
    let startupTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([f.bootstrapped, new Promise<never>((_, reject) => {
        startupTimeout = setTimeout(() => reject(new Error("query fixture did not bootstrap within budget")), 5000);
      })]);
    } finally { clearTimeout(startupTimeout); }
    const a = await f.client(), b = await f.client(); await ready(a); await ready(b);
    const epoch = b.snapshot!.instanceId;
    const wedged = new Promise<void>(resolve => f.worker.on("message", message => { if (message.type === "wedged") resolve(); }));
    f.worker.postMessage({ type: "wedge" }); await wedged;
    const began = performance.now();
    await assert.rejects(a.get({ limit: 1 }), /deadline exceeded/);
    const control = performance.now(); assert.equal((await b.request("ping")).ok, true);
    const controlMs = performance.now() - control;
    const until = Date.now() + 5000;
    while (b.snapshot?.instanceId === epoch || b.snapshot?.status !== "ready") {
      assert.ok(Date.now() < until, "wedged worker did not recover within budget");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(f.executor.metrics().executor.restarts, 1);
    assert.ok(controlMs < 500);
    t.diagnostic(JSON.stringify({ restartMs: performance.now() - began, controlMs, metrics: f.executor.metrics() }));
  } finally { await f.close(); }
});

test("cold bootstrap caller deadline does not imply a wedged read worker", { timeout: 10000 }, async t => {
  const f = await fixture({ timeoutMs: 400, watchdogMs: 2000,
    workerUrl: new URL("./support/cold-cancellable-query-worker.mjs", import.meta.url) });
  try {
    const client = await f.client();
    const began = performance.now();
    await assert.rejects(client.subscribe({}), /runtime-timeout: caller read deadline exceeded/);
    assert.equal((await client.request("ping")).ok, true);
    assert.equal(f.executor.metrics().executor.callerTimeouts, 1);
    await f.bootstrapped;
    await ready(client);
    assert.equal(client.snapshot?.status, "ready");
    assert.equal(f.executor.metrics().executor.restarts, 0);
    t.diagnostic(JSON.stringify({ startupMs: performance.now() - began, metrics: f.executor.metrics() }));
  } finally { await f.close(); }
});

test("responsive rebuilding outlives the watchdog without claiming source readiness", { timeout: 10000 }, async t => {
  const f = await fixture({ watchdogMs: 800,
    workerUrl: new URL("./support/blocked-inventory-worker.mjs", import.meta.url) });
  try {
    await f.bootstrapped;
    const a = await f.client(), b = await f.client();
    const began = performance.now();
    for (let i = 0; i < 6; i++) {
      assert.equal((await a.get({ limit: 1 })).status, "rebuilding");
      assert.equal((await b.request("ping")).ok, true);
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert.equal(f.executor.metrics().executor.restarts, 0);
    assert.equal(f.executor.metrics().executor.timeouts, 0);
    assert.equal(f.executor.observation().status, "rebuilding");
    t.diagnostic(JSON.stringify({ rebuildingMs: performance.now() - began, metrics: f.executor.metrics() }));
    f.worker.postMessage({ type: "release-inventory" });
    await ready(b);
  } finally { await f.close(); }
});

test("an exact-ID query returns rebuilding without blocking all reads on the initial inventory", { timeout: 10000 }, async () => {
  const f = await fixture({ timeoutMs: 500, workerUrl: new URL("./support/blocked-inventory-worker.mjs", import.meta.url) });
  try {
    const blocked = new Promise<void>(resolve => {
      f.worker.on("message", message => { if (message.type === "inventory-blocked") resolve(); });
    });
    const client = await f.client();
    await blocked;
    const [exact, other] = await Promise.all([
      client.request("runtime_get_snapshot", { scope: { id: "sa_initial_inventory", limit: 1 } }),
      client.get({ limit: 2 }),
    ]);
    assert.equal(exact.status, "rebuilding");
    assert.equal(other.status, "rebuilding");
    assert.equal(f.executor.metrics().executor.timeouts, 0);
    assert.equal(f.executor.metrics().executor.worker, "running");
    f.worker.postMessage({ type: "release-inventory" });
    await ready(client);
    assert.equal((await client.get({ id: "sa_initial_inventory", limit: 1 })).status, "ready");
  } finally { await f.close(); }
});

test("an exact-ID client waits for indexing without occupying the shared read queue", { timeout: 10000 }, async () => {
  const f = await fixture({ workerUrl: new URL("./support/blocked-inventory-worker.mjs", import.meta.url) });
  try {
    const blocked = new Promise<void>(resolve => {
      f.worker.on("message", message => { if (message.type === "inventory-blocked") resolve(); });
    });
    const client = await f.client(); await blocked;
    f.worker.postMessage({ type: "release-inventory" });
    await ready(client);
    const indexing = new Promise<void>(resolve => {
      const listener = (message: any) => { if (message.type === "inventory-blocked") { f.worker.off("message", listener); resolve(); } };
      f.worker.on("message", listener);
    });
    f.worker.postMessage({ type: "block-inventory" }); await indexing;
    const directory = join(f.root, "runs/sa_client_retry"); mkdirSync(directory);
    writeFileSync(join(directory, "meta.json"), JSON.stringify({ id: "sa_client_retry", sessionId: "retry", cwd: f.root,
      status: "completed", startedAt: 1 }));
    let completed = false;
    const pending = client.get({ id: "sa_client_retry", limit: 1 }).then(value => { completed = true; return value; });
    assert.equal((await client.get({ limit: 2 })).status, "ready");
    assert.equal(completed, false, "the unrelated read completes while the exact ID is still awaiting inventory");
    f.worker.postMessage({ type: "release-inventory" });
    let result = await pending;
    // get() deliberately returns rebuilding after its bounded retry window.
    // Loaded runners may spend that window initializing the real inventory.
    if (result.status === "rebuilding") {
      assert.equal(result.rows.length, 0);
      await ready(client);
      result = await client.get({ id: "sa_client_retry", limit: 1 });
    }
    assert.equal(result.status, "ready");
    assert.equal(result.rows[0]!.meta.id, "sa_client_retry");
    assert.equal(f.executor.metrics().executor.timeouts, 0);
  } finally { await f.close(); }
});

test("an exact-ID client retries indexing even when another assignment makes the inventory degraded", { timeout: 10000 }, async () => {
  const f = await fixture({ workerUrl: new URL("./support/blocked-inventory-worker.mjs", import.meta.url) });
  const blocked = () => new Promise<void>(resolve => {
    const listener = (message: any) => { if (message.type === "inventory-blocked") { f.worker.off("message", listener); resolve(); } };
    f.worker.on("message", listener);
  });
  try {
    const initial = blocked();
    const directory = join(f.root, "runs/sa_unverified"); mkdirSync(directory);
    writeFileSync(join(directory, "meta.json"), JSON.stringify({ id: "sa_unverified", sessionId: "unverified", cwd: f.root,
      status: "completed", startedAt: 1, operations: { conversationId: "unverified", workspace: f.root } }));
    const client = await f.client(); await initial;
    const degraded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(new Error("unverified fixture did not become degraded")); }, 5000);
      const stop = client.onChange(value => { if (value.status === "degraded" && value.rows.length) { clearTimeout(timer); stop(); resolve(); } });
    });
    await client.subscribe({}); f.worker.postMessage({ type: "release-inventory" }); await degraded;
    const held = blocked(); f.worker.postMessage({ type: "block-inventory" }); await held;
    const next = join(f.root, "runs/sa_degraded_retry"); mkdirSync(next);
    writeFileSync(join(next, "meta.json"), JSON.stringify({ id: "sa_degraded_retry", sessionId: "new", cwd: f.root,
      status: "lost", startedAt: 2 }));
    const pending = client.get({ id: "sa_degraded_retry", limit: 1 });
    assert.equal((await client.get({ limit: 2 })).status, "degraded");
    f.worker.postMessage({ type: "release-inventory" });
    const value = await pending;
    assert.equal(value.rows[0]?.meta.id, "sa_degraded_retry");
    assert.equal(value.rows[0]?.assignment.verified, true);
    assert.equal(f.executor.metrics().executor.timeouts, 0);
  } finally { await f.close(); }
});

test("an exact-ID client stops retrying a stalled inventory within its retry budget", { timeout: 10000 }, async () => {
  const f = await fixture({ timeoutMs: 500, workerUrl: new URL("./support/blocked-inventory-worker.mjs", import.meta.url) });
  try {
    const client = await f.client();
    const began = performance.now();
    assert.equal((await client.get({ id: "sa_pending", limit: 1 })).status, "rebuilding");
    assert.ok(performance.now() - began < 5000);
    assert.equal(f.executor.metrics().executor.timeouts, 0);
    assert.equal(f.executor.metrics().executor.active, 0);
    assert.equal(f.executor.metrics().executor.worker, "running");
  } finally { await f.close(); }
});

test("a failed worker recovers existing subscriptions under a new observation epoch", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const directory = join(f.root, "runs", "sa_recovery");
    mkdirSync(directory);
    const write = (name: string) => writeFileSync(join(directory, "meta.json"), JSON.stringify({
      id: "sa_recovery", cwd: f.root, status: "completed", startedAt: 1, name,
    }));
    write("first");
    const client = await f.client();
    await ready(client);
    await client.subscribe({ id: "sa_recovery", limit: 1 });
    write("latest");
    const until = Date.now() + 3000;
    while (client.snapshot?.rows[0]?.meta.name !== "latest") {
      assert.ok(Date.now() < until, "the original subscription did not observe the source update");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const previous = client.snapshot!;
    assert.ok(previous.seq > 1);
    let resynced = false;
    const recovered = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(new Error("read worker never recovered the existing subscription")); }, 3000);
      const stop = client.onChange(snapshot => {
        if (snapshot.instanceId !== previous.instanceId && snapshot.resyncRequired) resynced = true;
        if (snapshot.status === "ready" && snapshot.instanceId !== previous.instanceId && snapshot.rows[0]?.meta.name === "latest") {
          clearTimeout(timer); stop(); resolve();
        }
      });
    });
    await f.worker.terminate();
    await recovered;
    assert.equal(client.closed, false);
    assert.equal(resynced, true);
    assert.equal(f.executor.metrics().executor.worker, "running");
    assert.equal((await client.get({ id: "sa_recovery", limit: 1 })).rows[0]!.meta.name, "latest");
  } finally { await f.close(); }
});

test("repeated worker failures exhaust a bounded recovery budget", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const client = await f.client();
    await ready(client);
    for (let attempt = 0; attempt < 3; attempt++) {
      const epoch = client.snapshot!.instanceId;
      const worker = (f.executor as unknown as { worker: Worker }).worker;
      await worker.terminate();
      if (attempt < 2) {
        const until = Date.now() + 3000;
        while (client.snapshot?.status !== "ready" || client.snapshot.instanceId === epoch) {
          assert.ok(Date.now() < until, "a permitted recovery did not finish");
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
    }
    await assert.rejects(client.get({}), /recovery budget exhausted/);
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(f.executor.metrics().executor.restarts, 2);
    assert.equal(f.executor.metrics().executor.worker, "stopped");
    assert.equal(f.executor.metrics().executor.recoveryPending, false);
    assert.equal((await client.request("ping")).ok, true);
  } finally { await f.close(); }
});

test("closing an executor cancels pending recovery without starting another worker", { timeout: 5000 }, async () => {
  const f = await fixture();
  try {
    const client = await f.client();
    await ready(client);
    await f.worker.terminate();
    assert.equal(f.executor.metrics().executor.recoveryPending, true);
    await f.executor.close();
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(f.executor.metrics().executor.restarts, 0);
    assert.equal(f.executor.metrics().executor.recoveryPending, false);
    assert.equal(f.executor.metrics().executor.worker, "stopped");
  } finally { await f.close(); }
});

test("slow real SQLite work leaves socket RPC responsive and overlapping reads share bounded admission", { timeout: 20000 }, async t => {
  const f = await fixture({ capacity: 2 });
  try {
    const a = await f.client(), b = await f.client(), c = await f.client();
    await ready(a);
    const busy = await f.stall();
    const first = a.get({ limit: 1 });
    const shared = b.get({ limit: 1 });
    void first.catch(() => {}); void shared.catch(() => {});
    const abandoned = c.get({ limit: 2 });
    const cancelled = assert.rejects(abandoned, /client closed|disconnected/);
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const started = performance.now(); await b.request("ping"); times.push(performance.now() - started);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(f.executor.metrics().executor.active, 1);
    assert.equal(f.executor.metrics().executor.queued, 1);
    assert.equal(f.executor.metrics().executor.singleflightHits, 1);
    await assert.rejects(b.get({ limit: 3 }), /runtime-overloaded/);
    c.close(); await cancelled;
    const until = Date.now() + 1000;
    while (f.executor.metrics().executor.queued) {
      assert.ok(Date.now() < until, "disconnected queued work was not released");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const firstCancelled = assert.rejects(first, /client closed|disconnected/);
    a.close(); await firstCancelled;
    const value = await shared;
    assert.equal(value.status, "ready");
    const duration = await busy.finished;
    const ordered = [...times].sort((a, b) => a - b);
    assert.ok(ordered.at(-1)! < duration / 2, "slow SQLite must not stall main-thread socket handling");
    t.diagnostic(JSON.stringify({ sqliteMs: duration, socketMs: { p50: ordered[9], p95: ordered[18], p99: ordered[19] },
      metrics: f.executor.metrics(), cpu: process.cpuUsage(), rss: process.memoryUsage().rss }));
    const before = (await b.request("runtime_get_metrics")).queryCount;
    await b.get({ limit: 1 });
    const after = await b.request("runtime_get_metrics");
    assert.equal(after.queryCount, before, "the worker cache avoids repeated SQLite for a warmed scope");
    assert.ok(after.cacheHits > 0);
    assert.equal(after.sqlite.active, 1, "the query index owns the attached checkpoint store when no coordinator source is present");
  } finally { await f.close(); }
});

test("the worker watchdog rejects readers and bounds close while native SQLite finishes before worker exit", { timeout: 60000 }, async t => {
  const f = await fixture({ watchdogMs: 3000 });
  try {
    const client = await f.client();
    await ready(client);
    await f.stall(60000000);
    const began = performance.now();
    const exit = once(f.worker, "exit");
    const active = assert.rejects(client.get({ limit: 1 }), /deadline exceeded/);
    const queued = assert.rejects(client.get({ limit: 2 }), /deadline exceeded/);
    await Promise.all([active, queued]);
    const rejectedMs = performance.now() - began;
    assert.equal(f.executor.metrics().executor.active, 0);
    assert.equal(f.executor.metrics().executor.queued, 0);
    assert.equal(f.executor.metrics().executor.status, "degraded");
    assert.equal(f.executor.observation().status, "degraded", "cached status cannot report a failed worker as ready");
    await assert.rejects(client.get({}), /deadline exceeded/);
    assert.equal(client.snapshot!.status, "degraded", "a dead worker must never leave its cached scope authoritative");
    assert.equal((await client.request("ping")).ok, true, "the main socket remains usable after worker failure");
    assert.equal((await client.request("runtime_get_metrics")).executor.status, "degraded");
    const started = performance.now(); await f.executor.close();
    const closeMs = performance.now() - started;
    assert.ok(closeMs < 1500, "native SQLite cannot retain executor shutdown beyond its close budget");
    await exit;
    assert.equal((f.executor.metrics().sqlite as { active: number }).active, 0, "worker exit releases its actual database connections");
    assert.equal(f.executor.metrics().coordinatorConnections, 0);
    assert.equal(f.executor.metrics().indexConnections, 0);
    t.diagnostic(JSON.stringify({ rejectedMs, closeMs, workerExitMs: performance.now() - began,
      limitation: "Native SQLite completion delays worker/process exit; the guardian owns the process hard-stop budget." }));
  } finally { await f.close(); }
});

test("worker events coalesce behind one acknowledgment and scope changes discard pending old-scope frames", { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    const client = await f.client(); await ready(client);
    const post = f.worker.postMessage.bind(f.worker);
    const acknowledgments: unknown[] = [];
    let events = 0, revisions = 0, hold = true;
    f.worker.on("message", message => { if (message.type === "event") events++; if (message.type === "revision") revisions++; });
    f.worker.postMessage = (message: any) => {
      if (hold && ["event-consumed", "revision-consumed"].includes(message.type)) acknowledgments.push(message);
      else post(message);
    };
    const write = (name: string) => {
      const dir = join(f.root, "runs", "sa_credit"); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "meta.json"), JSON.stringify({ id: "sa_credit", cwd: f.root, status: "completed", startedAt: 1, name }));
    };
    const until = async (name: string) => {
      const deadline = Date.now() + 5000;
      while ((await client.get({ id: "sa_credit" })).rows[0]?.meta.name !== name) {
        assert.ok(Date.now() < deadline, "external write did not reach the worker index");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    write("first"); await until("first");
    write("second"); await until("second");
    write("latest"); await until("latest");
    assert.equal(events, 1, "only one full event is in the worker mailbox without an acknowledgment");
    assert.equal(revisions, 1, "root invalidations also have bounded producer credit");
    await client.subscribe({ id: "sa_other_scope" });
    assert.equal(client.snapshot!.rows.length, 0);
    hold = false;
    acknowledgments.forEach(message => post(message));
    await client.request("ping");
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(client.snapshot!.rows.length, 0, "pending old-scope rows cannot overwrite a new subscription");
  } finally { await f.close(); }
});


test("diagnostic liveness does not wait behind SQLite while fresh idle checks still do", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const client = await f.client();
    await ready(client);
    await f.executor.livenessReasons();
    const { finished } = await f.stall();
    const began = performance.now();
    const observation = f.executor.observation();
    assert.ok(performance.now() - began < 100, "diagnostics must not block on the read worker");
    assert.equal(observation.status, "ready");
    assert.ok(observation.observedAt);
    const queued = f.executor.metrics().executor.queued;
    for (let i = 0; i < 100; i++) f.executor.observation();
    assert.equal(f.executor.metrics().executor.queued, queued, "status probes enqueue no worker work");
    let checked = false;
    const fresh = f.executor.livenessReasons().then(() => { checked = true; });
    assert.equal(checked, false, "fresh shutdown checks cannot use the diagnostic cache");
    await finished;
    await fresh;
  } finally { await f.close(); }
});

test("diagnostic observation uses pushed state without initiating another inventory", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const client = await f.client();
    await ready(client);
    await f.executor.livenessReasons();
    const before = f.executor.metrics();
    assert.equal(typeof before.inventories, "number");
    f.executor.observation();
    assert.equal(f.executor.metrics().executor.completed, before.executor.completed,
      "diagnostic polling uses the pushed observation without a worker request");
    assert.equal(f.executor.metrics().inventories, before.inventories,
      "diagnostic polling must not initiate expensive fresh inventories");
  } finally { await f.close(); }
});

test('Subagents and Background share one coordinator read connection in the query worker', async t => {
  const f = await fixture();
  const { openStore } = await import(new URL('../../operation-coordinator/index.ts', import.meta.url).href);
  const store = openStore({ path: join(f.root, 'operation-coordinator.sqlite') }); store.close();
  try {
    const client = await f.client();
    await f.executor.livenessReasons();
    await client.get({ cwd: f.root, active: true });
    await client.get({ background: true, cwd: f.root, sessionId: 'shared-reader', active: true });
    assert.equal((f.executor.metrics().sqlite as any).active, 2, 'one coordinator and one derived connection with inbox and checkpoints attached, regardless of domain');
    assert.equal((f.executor.metrics().sqlite as any).opens, 2, 'both inbox attachments reuse the existing derived handle without another constructor open');
    assert.equal((f.executor.metrics().sqlite as any).maximum, 2, 'Background attachment cannot temporarily exceed the existing handle budget');
    assert.equal(f.executor.metrics().coordinatorConnections, 1);
    t.diagnostic(JSON.stringify({ retainedBudget: 2, sqlite: f.executor.metrics().sqlite }));
  } finally { await f.close(); }
});

test("assignment wait, resume claim, cancellation, outcome and receipt cross the real socket", { timeout: 10000 }, async t => {
  const f = await fixture({ intervalMs: 25 });
  const { openStore } = await import(new URL('../../operation-coordinator/index.ts', import.meta.url).href);
  const store = openStore({ path: join(f.root, 'operation-coordinator.sqlite') });
  const owner = { kind: "worker-conversation", sessionId: "worker", workspace: f.root };
  const recipient = { kind: "parent-session", sessionId: "parent", workspace: f.root };
  store.registerAssignment({ assignmentId: "assignment", owner, recipient });
  mkdirSync(join(f.root, "runs", "attempt"));
  writeFileSync(join(f.root, "runs", "attempt", "meta.json"), JSON.stringify({ id: "attempt", sessionId: "worker", cwd: f.root, status: "completed", startedAt: 1,
    assignment: { assignmentId: "assignment", owner, recipient }, callbackOrigin: { cwd: f.root, sessionId: "parent" } }));
  const client = await f.client();
  const observed = async (predicate: (snapshot: any) => boolean) => {
    const current = await client.get({ id: "attempt" });
    if (predicate(current)) return current;
    return new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => { stop(); reject(new Error("assignment socket observation did not advance")); }, 3000);
      const stop = client.onChange(snapshot => { if (predicate(snapshot)) { clearTimeout(timeout); stop(); resolve(snapshot); } });
    });
  };
  try {
    await client.subscribe({ id: "attempt" });
    await observed(s => s.status === "ready" && s.rows.length === 1);
    store.registerOperation({ operationId: "dependency", taskId: "task", launchToken: "launch", owner, observer: { kind: "background-tasks", version: "1" } });
    const wait = store.registerWait({ waitId: "wait", owner, dependencies: [{ operationId: "dependency" }], origin: { assignmentRef: "assignment", attemptId: "attempt" }, continuationNote: "Continue" }).wait;
    await observed(s => s.rows[0]?.assignment.state === "waiting" && s.activity.active === 1);
    store.recordTerminalOutcome({ operationId: "dependency", eventId: "terminal", owner, outcome: "succeeded", evidence: [{ kind: "summary", ref: "fixture-result", summary: "Completed dependency" }] });
    const claim = store.claimResume({ waitId: wait.waitId, generation: wait.generation, expectedCancelEpoch: 0, lease: { ownerId: "host" }, reservedCheckpointId: "checkpoint" }).claim;
    await observed(s => s.rows[0]?.assignment.reason === "resume-claimed");
    store.cancelWait({ waitId: wait.waitId, generation: wait.generation, owner, expectedCancelEpoch: 0, reason: "cancel" });
    assert.throws(() => store.publishResumeAttempt({ waitId: wait.waitId, generation: wait.generation, claimId: claim.claimId, claimToken: claim.claimToken, attemptId: "forbidden", launchToken: "forbidden" }), /cancel|claim|phase/i);
    store.recordAssignmentOutcome({ assignmentId: "assignment", owner, recipient, revision: 1, outcome: "cancelled", reason: "cancel", evidence: [], waits: [{ waitId: wait.waitId, generation: wait.generation, cancelEpoch: 1 }], processUncertain: false });
    await observed(s => s.rows[0]?.assignment.state === "cancelled");
    store.receiptAssignmentOutcome({ assignmentId: "assignment", recipient, revision: 1, entryId: "entry" });
    await observed(s => s.rows[0]?.recipientPending === false);
    const sqlite = f.executor.metrics().sqlite as any;
    assert.equal(sqlite.active, 2, "the full receipt journey retains only the source and shared derived handles");
    assert.ok(sqlite.maximum <= 2, "inbox transactions do not open an extra SQLite handle");
    t.diagnostic(JSON.stringify({ retainedBudget: 2, sqlite }));
    assert.equal(store.getWait(wait).phase, "cancelled");
    assert.equal(store.getAssignmentOutcome("assignment").disposition, null, "derived observation must not consume a result");
    assert.equal(store.listOutbox().find((event: any) => event.type === "assignment-outcome").state, "delivered");
  } finally { store.close(); await f.close(); }
});


test("real runner timeout and canonical result supervision progress during stalled SQLite reads", { timeout: 20000 }, async t => {
  const { acquireMutationStore } = await import("../src/runtime/mutation-store.ts");
  const { RuntimeResultSupervision } = await import("../src/runtime/result-supervision.ts");
  const { createLocalSupervisor } = await import(new URL("../../pi-better-background-tasks/src/supervisor/index.ts", import.meta.url).href);
  const { supervisorTaskIdForToken } = await import(new URL("../../pi-better-background-tasks/src/supervisor/store.ts", import.meta.url).href);
  const f = await fixture({ watchdogMs: 15000 });
  const lease = acquireMutationStore(f.root);
  const directory = join(f.root, "supervisor");
  const supervisor = createLocalSupervisor({ directory });
  const token = "slow-read-deadline", taskId = supervisorTaskIdForToken(token), operationId = "slow-read-operation";
  const owner = { kind: "parent-session", sessionId: "exact-recipient", workspace: f.root };
  let host: InstanceType<typeof RuntimeResultSupervision> | undefined;
  try {
    const client = await f.client(); await ready(client);
    lease.store.registerOperation({ operationId, taskId, launchToken: token, owner,
      observer: { kind: "local-supervisor", version: "1" }, supervision: { hostId: "accepted-host" }, authorityRef: "explicit-test-command" });
    lease.store.handoffResultSupervision({ operationId, expectedHostId: "accepted-host", directory,
      hostId: "server:slow-read-epoch", epoch: "slow-read-epoch",
      capability: { adapter: "background-results-v1", captured: { authorized: true }, current: { authorized: true } } });
    lease.store.registerWait({ waitId: "slow-read-wait", owner, dependencies: [{ operationId }], continuationNote: "Inspect timeout evidence" });
    host = new RuntimeResultSupervision(f.root, "slow-read-epoch");
    const busy = await f.stall(12000000);
    let readFinished = false;
    void busy.finished.then(() => { readFinished = true; }, () => {});
    const began = performance.now();
    await supervisor.start({ token, operationId, cwd: f.root, timeoutSeconds: 0.2,
      argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] });
    const sockets: number[] = [];
    while (lease.store.getOperation(operationId).terminalRevision === 0) {
      assert.ok(performance.now() - began < 2000, "runner deadline must reach canonical terminal state within two seconds despite slow reads");
      const started = performance.now(); await client.request("ping"); sockets.push(performance.now() - started);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const publicationMs = performance.now() - began;
    assert.equal(readFinished, false, "supervision must complete while the real SQLite query is still blocked");
    const operation = lease.store.getOperation(operationId);
    assert.equal(operation.terminalOutcome, "failed");
    assert.equal(operation.terminalRevision, 1);
    assert.equal(lease.store.listOutbox({ recipient: owner }).length, 1);
    assert.equal(lease.store.listOutbox({ recipient: { ...owner, sessionId: "foreign" } }).length, 0);
    sockets.sort((a,b)=>a-b);
    assert.ok(sockets.at(-1)! < 250, "socket control response remains within the documented rebuild budget");
    t.diagnostic(JSON.stringify({ sqliteMs: await busy.finished, publicationMs,
      socketMs: { p50: sockets[Math.floor(sockets.length*.5)], p95: sockets[Math.floor(sockets.length*.95)], p99: sockets.at(-1) } }));
  } finally {
    await supervisor.stop(taskId).catch(() => undefined);
    host?.close(); lease.release(); await f.close();
  }
});


test("explicit internal read demand recovers without foreground connections", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    await f.executor.snapshot({});
    await f.worker.terminate();
    assert.equal(f.executor.metrics().executor.clients, 0);
    assert.equal(f.executor.metrics().executor.recoveryPending, false);
    await assert.rejects(f.executor.livenessReasons(), /runtime-unhealthy/);
    const until = Date.now() + 4000;
    while (f.executor.metrics().executor.restarts === 0) {
      assert.ok(Date.now() < until); await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(await f.executor.livenessReasons(), []);
    assert.equal(f.executor.metrics().executor.clients, 0);
    assert.equal(f.executor.metrics().executor.worker, "running");
  } finally { await f.close(); }
});

for (const outcome of ["success", "failure"]) test(`old fold ${outcome} cannot affect a replacement read worker`, { timeout: 10000 }, async () => {
  const folds: Array<{ resolve(): void; reject(error: Error): void }> = [];
  const f = await fixture({ workerUrl: new URL("./support/fold-recovery-worker.mjs", import.meta.url),
    onTerminalLogsChanged: () => new Promise<void>((resolve, reject) => folds.push({ resolve, reject })) });
  const waitFor = async (predicate: () => boolean) => {
    const until = Date.now() + 4000;
    while (!predicate()) { assert.ok(Date.now() < until); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  try {
    const client = await f.client(); await ready(client);
    f.worker.postMessage({ type: "diagnostic-fold", id: "old" });
    await waitFor(() => folds.length === 1);
    await f.worker.terminate();
    await waitFor(() => f.executor.metrics().executor.restarts === 1);
    const replacement = (f.executor as unknown as { worker: Worker }).worker;
    let acknowledgements = 0;
    replacement.on("message", message => { if (message.type === "diagnostic-fold-ack") acknowledgements++; });
    replacement.postMessage({ type: "diagnostic-fold", id: "new" });
    await waitFor(() => folds.length === 2);
    if (outcome === "success") folds[0]!.resolve(); else folds[0]!.reject(new Error("old fold failed"));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(acknowledgements, 0, "old completion must not acknowledge the new batch");
    assert.equal(f.executor.metrics().executor.worker, "running", "old failure must not terminate replacement");
    folds[1]!.resolve();
    await waitFor(() => acknowledgements === 1);
    assert.equal(f.executor.metrics().executor.restarts, 1);
    await client.get({});
  } finally { await f.close(); }
});


for (const rootRecreated of [false, true]) test(`a raw directory observed before metadata still publishes the original atomic writer commit (${rootRecreated ? "recreated root" : "existing root"})`, { timeout: 15000 }, async () => {
  const f = await fixture();
  const { measureEventPublication } = await import(new URL("../scripts/event-publication/measure.mjs", import.meta.url).href);
  try {
    const client = await f.client(); await ready(client);
    const id = "sa_metadata_gap", directory = join(f.root, "runs", id), metaPath = join(directory, "meta.json");
    const scope = { cwd: f.root, sessionId: "parent", limit: 10 };
    await client.subscribe(scope);
    if (rootRecreated) {
      mkdirSync(directory);
      writeFileSync(metaPath, JSON.stringify({ id, cwd: f.root, status: "completed", startedAt: 1,
        callbackOrigin: { cwd: f.root, sessionId: "parent" }, name: "before-root" }));
      const wait = async (condition: () => boolean) => {
        const until = Date.now() + 1000;
        while (!condition()) {
          assert.ok(Date.now() < until, "root gap publication missing");
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      };
      await wait(() => client.snapshot?.rows[0]?.meta.name === "before-root");
      renameSync(join(f.root, "runs"), join(f.root, "retired-runs"));
      await wait(() => client.snapshot?.status === "degraded");
      assert.equal(client.snapshot?.rows[0]?.meta.name, "before-root");
    }
    const before = f.executor.metrics().inventories ?? 0;
    mkdirSync(directory, { recursive: true });
    const until = Date.now() + 1000;
    do {
      // Query capture refreshes metrics, never requests inventory repair.
      await client.get(scope);
      assert.ok(Date.now() < until, "raw directory creation hint was not processed");
      if ((f.executor.metrics().inventories ?? 0) > before && client.snapshot?.rows.length === 0) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (true);
    writeFileSync(metaPath, JSON.stringify({ id, sessionId: "worker", cwd: f.root, status: "completed", startedAt: 1,
      endedAt: Date.now(), callbackOrigin: { cwd: f.root, sessionId: "parent" }, name: "original" }));
    const report = await measureEventPublication({ socketPath: f.path, agentDir: f.root, scope, metaPath, taskId: id,
      subscribers: 1, commits: 1, phase: rootRecreated ? "metadata-after-root-recreation" : "metadata-after-directory-hint", diagnostics: () => f.executor.metrics() });
    assert.ok(report.ms.max <= 1000, JSON.stringify(report));
    await client.get(scope);
    assert.equal(f.executor.metrics().sourceWatchers, 2);
  } finally { await f.close(); }
});

test("directory entry watchers publish repeated atomic commits without the inventory fallback", { timeout: 15000 }, async () => {
  const f = await fixture(); // fallback interval is 60 seconds, longer than this test
  const { measureEventPublication } = await import(new URL("../scripts/event-publication/measure.mjs", import.meta.url).href);
  try {
    const id = "sa_atomic", directory = join(f.root, "runs", id), metaPath = join(directory, "meta.json");
    mkdirSync(directory);
    const meta = { id, sessionId: "worker", cwd: f.root, status: "completed", startedAt: 1, endedAt: Date.now(),
      callbackOrigin: { cwd: f.root, sessionId: "parent" }, name: "original" };
    writeFileSync(metaPath, JSON.stringify(meta));
    const client = await f.client(); await ready(client);
    const scope = { cwd: f.root, sessionId: "parent", limit: 10 };
    for (const subscribers of [1, 5, 10]) {
      const report = await measureEventPublication({ socketPath: f.path, agentDir: f.root, scope, metaPath, taskId: id, subscribers, commits: 5,
        phase: "initial-directory", diagnostics: () => f.executor.metrics() });
      assert.ok(report.ms.max <= 1000, JSON.stringify(report));
      assert.equal(f.executor.metrics().sourceWatchers, 2, "one root and one raw directory, independent of clients/files");
    }
    // Replacing the directory itself must retire its old inode watcher.
    renameSync(directory, join(f.root, "old-run")); mkdirSync(directory);
    writeFileSync(metaPath, JSON.stringify({ ...meta, name: "replaced-directory" }));
    await client.subscribe(scope);
    const until = Date.now() + 1000;
    while (client.snapshot?.rows[0]?.meta.name !== "replaced-directory") {
      assert.ok(Date.now() < until, "directory replacement was not published"); await new Promise(resolve => setTimeout(resolve, 10));
    }
    const report = await measureEventPublication({ socketPath: f.path, agentDir: f.root, scope, metaPath, taskId: id, subscribers: 1, commits: 5,
      phase: "replaced-directory", diagnostics: () => f.executor.metrics() });
    assert.ok(report.ms.max <= 1000, JSON.stringify(report));
    // The entire source root can also move while its pathname is immediately
    // recreated. Identity checks must rebind both root and child watchers.
    renameSync(join(f.root, "runs"), join(f.root, "old-runs-root"));
    mkdirSync(directory, { recursive: true });
    writeFileSync(metaPath, JSON.stringify({ ...meta, name: "replaced-root" }));
    const rootBy = Date.now() + 1000;
    while (client.snapshot?.rows[0]?.meta.name !== "replaced-root") {
      assert.ok(Date.now() < rootBy, "root replacement was not published"); await new Promise(resolve => setTimeout(resolve, 10));
    }
    const rootReport = await measureEventPublication({ socketPath: f.path, agentDir: f.root, scope, metaPath, taskId: id, subscribers: 1, commits: 5,
      phase: "replaced-root", diagnostics: () => f.executor.metrics() });
    assert.ok(rootReport.ms.max <= 1000, JSON.stringify(rootReport));
    assert.equal(f.executor.metrics().sourceWatchers, 2);
    rmSync(directory, { recursive: true });
    const removedBy = Date.now() + 1000;
    while (client.snapshot?.rows.length) {
      assert.ok(Date.now() < removedBy, "directory deletion was not published"); await new Promise(resolve => setTimeout(resolve, 10));
    }
    await client.get(scope);
    assert.equal(f.executor.metrics().sourceWatchers, 1, "deleted raw directories release their watchers");
  } finally { await f.close(); }
  assert.equal(f.executor.metrics().executor.worker, "stopped");
});

for (const source of ["runs", "attempts", "session-state"]) test(`source ${source} recreation after observed absence publishes without fallback`, { timeout: 10000 }, async t => {
  const f = await fixture();
  const durable = join(f.root, "durable"), sessionDir = join(durable, "sessions");
  const root = source === "runs" ? join(f.root, source) : join(durable, source);
  const id = "sa_root_gap";
  const meta = { id, sessionId: "worker", cwd: f.root, status: "completed", startedAt: 1, endedAt: 2,
    name: "before-root", recipe: { version: 1, sessionId: "worker", sessionDir, cwd: f.root } };
  const archive = () => { mkdirSync(join(durable, "attempts"), { recursive: true }); writeFileSync(join(durable, "attempts", `${id}.json`), JSON.stringify({ version: 1, meta })); };
  const writeSource = (name: string) => {
    mkdirSync(root, { recursive: true });
    if (source === "runs") { mkdirSync(join(root, id)); writeFileSync(join(root, id, "meta.json"), JSON.stringify({ ...meta, name })); }
    else if (source === "attempts") writeFileSync(join(root, `${id}.json`), JSON.stringify({ version: 1, meta: { ...meta, name } }));
    else writeFileSync(join(root, "worker.json"), JSON.stringify({ version: 1, sessionId: "worker", attemptId: "sa_newer", status: "killed", startedAt: 3 }));
  };
  const wait = async (condition: () => boolean, description: string) => {
    const until = Date.now() + 1000;
    while (!condition()) { assert.ok(Date.now() < until, description); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  try {
    if (source === "session-state") archive();
    writeSource("before-root");
    const client = await f.client(); await ready(client); await client.subscribe({ cwd: f.root, limit: 10 });
    const count = source === "session-state" ? 0 : 1;
    await wait(() => client.snapshot?.rows.length === count, "initial source membership");
    const before = f.executor.metrics(), oldInode = String(statSync(root).ino);
    renameSync(root, join(f.root, `retired-${source}`));
    // This is a publication barrier, not a sleep or a forced read/inventory:
    // the worker has actually imported ENOENT before the new root is created.
    await wait(() => client.snapshot?.status === "degraded", "missing source root was not published");
    assert.equal(client.snapshot?.rows.length, count, "unavailable roots retain verified rows and marker coverage");
    writeSource("after-root");
    const newInode = String(statSync(root).ino);
    assert.notEqual(newInode, oldInode);
    await wait(() => client.snapshot?.status === "ready" && client.snapshot.rows.length === count && (count === 0 || client.snapshot.rows[0]?.meta.name === "after-root"), "recreated source root was not published");
    if (count) {
      const path = source === "runs" ? join(root, id, "meta.json") : join(root, `${id}.json`);
      const value = { ...meta, name: "after-rearm" };
      writeFileSync(path + ".tmp", JSON.stringify(source === "runs" ? value : { version: 1, meta: value }));
      renameSync(path + ".tmp", path);
      try {
        await wait(() => client.snapshot?.rows[0]?.meta.name === "after-rearm", `replacement root watcher was not rearmed: ${JSON.stringify({ source, oldInode, newInode, before })}`);
      } catch (error) {
        t.diagnostic(JSON.stringify({ source, snapshot: client.snapshot, metrics: f.executor.metrics() }));
        throw error;
      }
    }
    t.diagnostic(JSON.stringify({ source, oldInode, newInode, before, after: f.executor.metrics() }));
  } finally { await f.close(); }
});

test("root recreation after an observed absence publishes without inventory fallback", { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    const id = "sa_root_gap", directory = join(f.root, "runs", id);
    const meta = { id, sessionId: "worker", cwd: f.root, status: "completed", startedAt: 1,
      endedAt: Date.now(), callbackOrigin: { cwd: f.root, sessionId: "parent" }, name: "original" };
    mkdirSync(directory);
    writeFileSync(join(directory, "meta.json"), JSON.stringify(meta));
    const client = await f.client(); await ready(client);
    await client.subscribe({ cwd: f.root, sessionId: "parent", limit: 10 });
    const waitForEvent = async (condition: () => boolean) => {
      const deadline = Date.now() + 3000;
      while (!condition()) {
        assert.ok(Date.now() < deadline, `missing root event: ${JSON.stringify(f.executor.metrics())}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    await waitForEvent(() => client.snapshot?.rows.length === 1);
    renameSync(join(f.root, "runs"), join(f.root, "old-runs"));
    // Let the reader observe ENOENT and retire the old inode watcher first.
    await waitForEvent(() => client.snapshot?.status === "degraded");
    assert.equal(client.snapshot?.rows.length, 1, "unavailable roots retain verified rows");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "meta.json"), JSON.stringify({ ...meta, name: "recreated" }));
    await waitForEvent(() => client.snapshot?.status === "ready" && client.snapshot.rows[0]?.meta.name === "recreated");
  } finally { await f.close(); }
});
