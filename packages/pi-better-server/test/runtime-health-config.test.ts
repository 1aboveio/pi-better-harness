import test from "node:test";
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { WorkReadModel } from "../src/runtime/read-model.ts";
import { WorkQueries } from "../src/runtime/queries.ts";
import { WorkClient } from "../src/runtime/work-client.mjs";

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
