import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { Worker } from "node:worker_threads";
import { WorkQueryExecutor } from "../src/runtime/query-executor.ts";
import { WorkClient } from "../src/runtime/work-client.mjs";

async function fixture(options: { capacity?: number; timeoutMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "query-root-"));
  mkdirSync(join(root, "runs"));
  const transport = mkdtempSync("/tmp/query-socket-");
  const executor = new WorkQueryExecutor(root, "query-instance", { ...options,
    workerUrl: new URL("./support/slow-query-worker.mjs", import.meta.url),
    modelOptions: { baseDir: root, durableDir: join(root, "durable"), intervalMs: 60000 } });
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
  const stall = async (iterations = 3000000) => {
    const started = new Promise<void>(resolve => {
      const listener = (message: any) => { if (message.type === "diagnostic-started") { worker.off("message", listener); resolve(); } };
      worker.on("message", listener);
    });
    const finished = new Promise<number>(resolve => {
      const listener = (message: any) => { if (message.type === "diagnostic-finished") { worker.off("message", listener); resolve(message.durationMs); } };
      worker.on("message", listener);
    });
    worker.postMessage({ type: "diagnostic-stall", iterations }); await started;
    return { finished };
  };
  const close = async () => {
    clients.forEach(client => client.close()); sockets.forEach(socket => socket.destroy());
    await new Promise<void>(resolve => server.close(() => resolve())); await executor.close();
    rmSync(root, { recursive: true, force: true }); rmSync(transport, { recursive: true, force: true });
  };
  return { executor, client, stall, worker, close, root };
}

async function ready(client: WorkClient) {
  await client.subscribe({});
  if (client.snapshot?.status === "ready") return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { stop(); reject(new Error("read worker did not finish its initial inventory")); }, 5000);
    const stop = client.onChange(snapshot => { if (snapshot.status === "ready") { clearTimeout(timeout); stop(); resolve(); } });
  });
}

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
    assert.equal(after.sqlite.active, 1, "only the derived index exists when no coordinator source is present");
  } finally { await f.close(); }
});

test("an active read deadline rejects readers and bounds close while native SQLite finishes before worker exit", { timeout: 60000 }, async t => {
  const f = await fixture();
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

test('Subagents and Background share one coordinator read connection in the query worker', async () => {
  const f = await fixture();
  const { openStore } = await import(new URL('../../operation-coordinator/index.ts', import.meta.url).href);
  const store = openStore({ path: join(f.root, 'operation-coordinator.sqlite') }); store.close();
  try {
    const client = await f.client();
    await f.executor.livenessReasons();
    await client.get({ cwd: f.root, active: true });
    await client.get({ background: true, cwd: f.root, sessionId: 'shared-reader', active: true });
    assert.equal((f.executor.metrics().sqlite as any).active, 2, 'one coordinator plus one derived index, regardless of domain');
    assert.equal(f.executor.metrics().coordinatorConnections, 1);
  } finally { await f.close(); }
});


test("real runner timeout and canonical result supervision progress during stalled SQLite reads", { timeout: 20000 }, async t => {
  const { acquireMutationStore } = await import("../src/runtime/mutation-store.ts");
  const { RuntimeResultSupervision } = await import("../src/runtime/result-supervision.ts");
  const { createLocalSupervisor } = await import("../../pi-better-background-tasks/src/supervisor/index.ts");
  const { supervisorTaskIdForToken } = await import("../../pi-better-background-tasks/src/supervisor/store.ts");
  const f = await fixture();
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
    void busy.finished.then(() => { readFinished = true; });
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
