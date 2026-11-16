import test from "node:test";
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { WorkReadModel } from "../src/runtime/read-model.ts";
import { WorkQueries } from "../src/runtime/queries.ts";
import { WorkClient } from "../src/runtime/work-client.mjs";

test("unchanged health facts advance quiet and stale deadlines for shared readers", { timeout: 10000 }, async t => {
  const parent = resolve("../../.work/797"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "deadline-")), transport = mkdtempSync("/tmp/p797-");
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  // Keep the process proof deterministic on hosts that forbid ps in test sandboxes.
  const childProcess = createRequire(import.meta.url)("node:child_process"), execFile = childProcess.execFileSync;
  const pidStartTime = "Mon Nov 16 00:00:00 2026";
  t.mock.method(childProcess, "execFileSync", (file: string, args: string[], ...rest: any[]) => {
    if (file === "ps" && JSON.stringify(args) === JSON.stringify(["-o", "lstart=", "-p", String(process.pid)])) return pidStartTime;
    return execFile(file, args, ...rest);
  });
  syncBuiltinESMExports();
  writeFileSync(join(root, "settings.json"), JSON.stringify({ piBetterHarness: { subagents: { healthQuietMs: 1000, healthStaleMs: 5000 } } }));
  const id = "sa_deadline", dir = join(root, "runs", id); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ id, cwd: root, sessionId: "worker", status: "running", pid: process.pid, pidStartTime, spawnPid: process.pid, startedAt: 1000 }));
  writeFileSync(join(dir, "output.log"), "{}\n");
  const model = new WorkReadModel(root, "deadline-instance", { baseDir: root, durableDir: join(root, "durable"), intervalMs: 60000 });
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); const queries = new WorkQueries(model, socket); let buffer = "";
    socket.setEncoding("utf8"); socket.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const at = buffer.indexOf("\n"), command = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
        const data = command.type === "hello" ? { capabilities: [] } : queries.handle(command);
        socket.write(JSON.stringify({ type: "response", id: command.id, success: true, data }) + "\n");
      }
    });
  });
  const clients: WorkClient[] = [];
  try {
    await model.reconcile(); assert.equal(model.snapshot().status, "ready");
    server.listen(join(transport, "work.sock")); await once(server, "listening");
    for (let i = 0; i < 2; i++) {
      const client = new WorkClient(join(transport, "work.sock"), root); clients.push(client);
      assert.equal((await client.subscribe({ active: true })).nextDeadline, 2000);
    }
    const initial = model.snapshot(), metrics = model.metrics;
    const fs = createRequire(import.meta.url)("node:fs"), open = fs.openSync, readFile = fs.readFileSync;
    let logReads = 0;
    t.mock.method(fs, "openSync", (...args: any[]) => { if (String(args[0]).endsWith("/output.log")) logReads++; return open(...args); });
    t.mock.method(fs, "readFileSync", (...args: any[]) => { if (String(args[0]).endsWith("/output.log")) logReads++; return readFile(...args); });
    syncBuiltinESMExports();
    try {
      // No settings, metadata or log write occurs while the clock crosses both boundaries.
      for (const [time, expected] of [[2000, 6000], [2500, 6000], [6000, null], [6500, null]] as const) {
        now = time;
        assert.equal(model.livenessReasons().find(reason => reason.id === id)?.nextDeadline, expected);
        for (const client of clients) {
          const snapshot: any = await client.get({ active: true });
          assert.equal(snapshot.nextDeadline, expected);
          assert.equal(snapshot.rows[0].health.nextDeadline, expected);
        }
        const published = clients.map(client => onceSnapshot(client, expected));
        const shouldPublish = time === 2000 || time === 6000;
        await model.reconcile();
        if (shouldPublish) await Promise.all(published.map(result => result.promise));
        published.forEach(result => result.stop());
        assert.equal(model.snapshot().nextDeadline, expected);
        assert.equal(model.livenessReasons().find(reason => reason.id === id)?.nextDeadline, expected);
        assert.equal(model.snapshot().observedRevisionVector.healthConfig, initial.observedRevisionVector.healthConfig);
        assert.equal(model.snapshot().rows[0]!.assignment.state, "running");
      }
      assert.equal(logReads, 0, "deadline expiry must not reopen or reread task logs");
      assert.equal(model.metrics.projections, metrics.projections, "deadline expiry does not reproject assignments");
      assert.equal(model.metrics.healthRecomputations - metrics.healthRecomputations, 2, "each expired transition is refreshed once");
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    clients.forEach(client => client.close()); sockets.forEach(socket => socket.destroy());
    await new Promise<void>(resolve => server.close(() => resolve())); await model.close();
    rmSync(root, { recursive: true, force: true }); rmSync(transport, { recursive: true, force: true });
  }
});

function onceSnapshot(client: WorkClient, deadline: number | null) {
  let stop = () => {};
  const promise = new Promise<void>(resolve => { stop = client.onChange(snapshot => { if (snapshot.nextDeadline === deadline) resolve(); }); });
  return { promise, stop: () => stop() };
}

test("shared query worker expires cached snapshots at each health deadline", { timeout: 10000 }, async () => {
  const parent = resolve("../../.work/797"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "worker-deadline-"));
  writeFileSync(join(root, "settings.json"), JSON.stringify({ piBetterHarness: { subagents: { healthQuietMs: 1000, healthStaleMs: 5000 } } }));
  const dir = join(root, "runs/sa_worker_deadline"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ id: "sa_worker_deadline", cwd: root, status: "running", pid: process.pid, spawnPid: process.pid, startedAt: 1000 }));
  writeFileSync(join(dir, "output.log"), "{}\n");
  const worker = new Worker(new URL("./support/deadline-query-worker.mjs", import.meta.url), {
    execArgv: [], workerData: { agentDir: root, instanceId: "deadline-worker", modelOptions: { baseDir: root, durableDir: join(root, "durable"), intervalMs: 60000 } },
  });
  const message = (match: (value: any) => boolean) => new Promise<any>((resolve, reject) => {
    const cleanup = () => { worker.off("message", received); worker.off("error", failed); };
    const received = (value: any) => { if (match(value)) { cleanup(); resolve(value); } };
    const failed = (error: Error) => { cleanup(); reject(error); };
    worker.on("message", received); worker.on("error", failed);
  });
  worker.on("message", value => { if (value.type === "revision") worker.postMessage({ type: "revision-consumed" }); });
  let serial = 0;
  const snapshot = async () => {
    const id = ++serial, reply = message(value => value.type === "reply" && value.id === id);
    worker.postMessage({ type: "query", id, connection: 1, generation: 1, command: { type: "runtime_get_snapshot", scope: { active: true } } });
    const result = await reply; assert.equal(result.error, undefined);
    return { snapshot: JSON.parse(result.json), metrics: result.metrics };
  };
  try {
    await message(value => value.type === "revision" && value.observation.status === "ready");
    const first = await snapshot(); assert.equal(first.snapshot.nextDeadline, 2000);
    assert.equal((await snapshot()).metrics.queryCount, first.metrics.queryCount, "unchanged query shares the cache");
    for (const [now, expected] of [[2500, 6000], [6000, null]] as const) {
      const clock = message(value => value.type === "test-clock" && value.now === now);
      worker.postMessage({ type: "test-clock", now }); await clock;
      const result = await snapshot(); assert.equal(result.snapshot.nextDeadline, expected);
      assert.equal(result.snapshot.rows[0].health.nextDeadline, expected);
      assert.equal(result.metrics.projections, first.metrics.projections);
      assert.equal(result.metrics.healthRecomputations, first.metrics.healthRecomputations);
      assert.equal(result.snapshot.scopeRevision, first.snapshot.scopeRevision, "read-time expiry does not manufacture a source change");
    }
  } finally { await worker.terminate(); rmSync(root, { recursive: true, force: true }); }
});

for (const count of [48, 96]) test(`${count} same-group tasks share content-based health invalidation over sockets`, { timeout: 20000 }, async t => {
  const parent = resolve("../../.work/797"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "health-"));
  const transport = mkdtempSync("/tmp/p797-");
  const settings = join(root, "settings.json");
  const config = (quiet = 1000, theme = "dark") => JSON.stringify({ theme, piBetterHarness: { subagents: { healthQuietMs: quiet, healthLongToolMs: 60000 + quiet } } });
  writeFileSync(settings, config());
  for (let i = 0; i < count; i++) {
    const id = `sa_health_${i}`, dir = join(root, "runs", id); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ id, cwd: root, sessionId: "same-worker", status: "running", pid: process.pid, spawnPid: process.pid, startedAt: 1 }));
    writeFileSync(join(dir, "output.log"), JSON.stringify({ type: "tool_execution_start", toolCallId: "call", toolName: "bash", at: Date.now() - 5000 }) + "\n");
  }
  const fs = createRequire(import.meta.url)("node:fs");
  const original = { openSync: fs.openSync, readSync: fs.readSync, closeSync: fs.closeSync, readFileSync: fs.readFileSync };
  const logs = new Set<number>(); let bytes = 0;
  fs.openSync = (...args: any[]) => { const fd = original.openSync(...args); if (String(args[0]).endsWith("/output.log")) logs.add(fd); return fd; };
  fs.readSync = (...args: any[]) => { const n = original.readSync(...args); if (logs.has(args[0])) bytes += n; return n; };
  fs.closeSync = (fd: number) => { logs.delete(fd); return original.closeSync(fd); };
  fs.readFileSync = (...args: any[]) => { const value = original.readFileSync(...args); if (String(args[0]).endsWith("/output.log")) bytes += Buffer.byteLength(value); return value; };
  syncBuiltinESMExports();
  const model = new WorkReadModel(root, "health-instance", { baseDir: root, durableDir: join(root, "durable"), intervalMs: 60000 });
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); const queries = new WorkQueries(model, socket); let buffer = "";
    socket.setEncoding("utf8"); socket.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const at = buffer.indexOf("\n"), command = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
        const data = command.type === "hello" ? { capabilities: [] } : queries.handle(command);
        socket.write(JSON.stringify({ type: "response", id: command.id, success: true, data }) + "\n");
      }
    });
  });
  const clients: WorkClient[] = [];
  try {
    await model.reconcile(); assert.equal(model.snapshot().status, "ready"); assert.ok(bytes > 0);
    server.listen(join(transport, "work.sock")); await once(server, "listening");
    for (let i = 0; i < 5; i++) { const client = new WorkClient(join(transport, "work.sock"), root); clients.push(client); await client.subscribe({ cwd: root, limit: 100 }); }
    const before = await clients[0]!.get({ cwd: root, limit: 100 });
    const metrics = model.metrics; bytes = 0;
    for (const [reason, content, atomic] of [["unrelated-settings", config(1000, "light"), false], ["same-content", config(1000, "light"), false], ["atomic-replacement", config(1000, "light"), true]] as const) {
      writeFileSync(atomic ? settings + ".tmp" : settings, content); if (atomic) renameSync(settings + ".tmp", settings);
      await model.reconcile();
      for (const client of clients) {
        const after = await client.get({ cwd: root, limit: 100 });
        assert.equal(after.scopeRevision, before.scopeRevision, reason);
        assert.equal(after.observedRevisionVector.healthConfig, before.observedRevisionVector.healthConfig, reason);
      }
      assert.equal(bytes, 0, reason); assert.equal(model.metrics.healthRecomputations, metrics.healthRecomputations, reason);
      t.diagnostic(JSON.stringify({ reason, logReadBytes: bytes, healthRecomputations: model.metrics.healthRecomputations - metrics.healthRecomputations, clients: clients.length, tasks: count }));
    }
    writeFileSync(settings, config(2000)); await model.reconcile();
    for (const client of clients) {
      const after: any = await client.get({ cwd: root, limit: 100 });
      assert.notEqual(after.scopeRevision, before.scopeRevision);
      assert.ok(after.rows.every((row: any) => row.health.thresholds.quietMs === 2000 && row.assignment.state === "running"));
      assert.equal(after.rows[0].health.nextDeadline - (before.rows[0] as any).health.nextDeadline, 1000);
    }
    assert.ok(model.livenessReasons().filter(reason => reason.kind === "worker").every(reason => reason.nextDeadline !== null));
    assert.equal(bytes, 0); assert.equal(model.metrics.projections, metrics.projections);
    assert.equal(model.metrics.healthRecomputations - metrics.healthRecomputations, count);
    writeFileSync(settings, "invalid json"); await model.reconcile();
    const degraded = await clients[0]!.get({ cwd: root, limit: 100 });
    assert.equal(degraded.status, "degraded"); assert.match(degraded.reason!, /Health configuration unavailable/);
    assert.ok(degraded.rows.every(row => row.assignment.state === "running")); assert.equal(bytes, 0);
    rmSync(settings); mkdirSync(settings); await model.reconcile();
    assert.equal((await clients[0]!.get({})).status, "degraded", "unreadable config is not healthy success");
    rmSync(settings, { recursive: true }); mkdirSync(join(root, "extensions"));
    writeFileSync(join(root, "extensions/pi-better-subagents-config.json"), JSON.stringify({ healthQuietMs: 3000 }));
    await model.reconcile();
    assert.equal((model.snapshot().rows[0] as any).health.thresholds.quietMs, 3000, "legacy fallback");
    writeFileSync(settings, config(4000)); await model.reconcile();
    assert.equal((model.snapshot().rows[0] as any).health.thresholds.quietMs, 4000, "namespaced config wins");
    rmSync(settings); rmSync(join(root, "extensions/pi-better-subagents-config.json")); await model.reconcile();
    assert.equal(model.snapshot().status, "ready", "absent config uses domain defaults");
    assert.equal(bytes, 0);
  } finally {
    clients.forEach(client => client.close()); sockets.forEach(socket => socket.destroy());
    await new Promise<void>(resolve => server.close(() => resolve())); await model.close();
    Object.assign(fs, original); syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true }); rmSync(transport, { recursive: true, force: true });
  }
});
