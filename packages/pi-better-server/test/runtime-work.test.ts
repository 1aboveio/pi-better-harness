import test from "node:test";
import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { createServer, connect, type Socket } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { register, createRequire } from "node:module";
import { WorkClient } from "../src/runtime/work-client.mjs";
import { WorkReadModel } from "../src/runtime/read-model.ts";
import { WorkQueries } from "../src/runtime/queries.ts";

test("one real daemon shares unchanged scope observations across 1, 5 and 10 socket clients", { timeout: 30000 }, async () => {
  const root = mkdtempSync(resolve("../../.work/753/runtime-"));
  const transport = mkdtempSync("/tmp/p753-");
  const agent = join(root, "agent");
  const runs = join(root, "pi-better-subagents/runs");
  mkdirSync(agent); mkdirSync(runs, { recursive: true });
  const coordinatorPath = new URL("../../operation-coordinator/index.ts", import.meta.url).href;
  const { openStore } = await import(coordinatorPath);
  openStore({ path: join(agent, "operation-coordinator.sqlite") }).close();
  for (let i = 0; i < 50; i++) {
    const id = `sa_shared_${i}`;
    mkdirSync(join(runs, id));
    writeFileSync(join(runs, id, "meta.json"), JSON.stringify({ id, sessionId: `worker-${i}`, cwd: root,
      status: "completed", startedAt: i, endedAt: Date.now(), callbackOrigin: { cwd: root, sessionId: "parent" },
      operations: { conversationId: `worker-${i}`, workspace: root } }));
  }
  const child = fork(new URL("./support/work-daemon.ts", import.meta.url), [], {
    execArgv: ["--import", "tsx"], env: { ...process.env, TMPDIR: root, PI_CODING_AGENT_DIR: agent, PI_SERVER_DIR: transport }, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let errors = "";
  child.stderr!.on("data", data => { errors += data; });
  const clients: WorkClient[] = [];
  try {
    const message = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(`daemon startup failed: ${errors}`); })]);
    const socket = (message[0] as { ready: string }).ready;
    const first = new WorkClient(socket, agent); clients.push(first);
    await first.subscribe({ cwd: root, sessionId: "parent", limit: 100 });
    if (first.snapshot?.status !== "ready") await new Promise<void>(resolve => {
      const stop = first.onChange(snapshot => { if (snapshot.status === "ready") { stop(); resolve(); } });
    });
    const before = await first.request("runtime_get_metrics");
    assert.equal(first.snapshot!.rows.length, 50);
    for (const count of [1, 5, 10]) {
      while (clients.length < count) {
        const client = new WorkClient(socket, agent); clients.push(client);
        await client.subscribe({ cwd: root, sessionId: "parent", limit: 100 });
      }
      for (const client of clients) {
        const snapshot = await client.get({ cwd: root, sessionId: "parent", limit: 100 });
        assert.equal(snapshot.scopeRevision, first.snapshot!.scopeRevision);
        assert.equal(snapshot.rows.length, 50);
      }
      const after = await first.request("runtime_get_metrics");
      assert.equal(after.projections, before.projections);
      assert.equal(after.metadataReads, before.metadataReads);
      assert.equal(after.coordinatorConnections, 1);
      assert.equal(after.indexConnections, 1);
    }
    const saved = new Map(["PI_CODING_AGENT_DIR", "TMPDIR", "PI_CATALOG_ACCEPTANCE_PROBE"].map(key => [key, process.env[key]]));
    process.env.PI_CODING_AGENT_DIR = agent; process.env.TMPDIR = root; process.env.PI_CATALOG_ACCEPTANCE_PROBE = "1";
    register(new URL("../../pi-better-subagents/tests/pi_host_stub_hooks.mjs", import.meta.url));
    const extensionPath = new URL("../../pi-better-subagents/index.ts", import.meta.url).href;
    const { default: extension } = await import(extensionPath);
    const handlers = new Map<string, Function>();
    const tools = new Map<string, any>();
    const ctx = { cwd: root, mode: "tui", hasUI: true, isIdle: () => true,
      sessionManager: { getSessionId: () => "parent", getBranch: () => [] },
      ui: { theme: { fg: (_c: string, s: string) => s }, notify() {}, setStatus() {}, setWidget() {},
        getEditorComponent() { return undefined; }, setEditorComponent() {} } };
    const sqlite = createRequire(import.meta.url)("node:sqlite");
    const OriginalDatabase = sqlite.DatabaseSync;
    let localConnections = 0;
    try {
      extension({ on: (key: string, fn: Function) => handlers.set(key, fn), registerTool: (tool: any) => tools.set(tool.name, tool), sendMessage() {} } as never);
      await handlers.get("session_start")!({}, ctx);
      sqlite.DatabaseSync = class extends OriginalDatabase { constructor(...args: any[]) { super(...args); localConnections++; } };
      const hooks = (globalThis as any)[Symbol.for("pi-better-subagents.acceptance-hooks")];
      for (let frame = 0; frame < 60; frame++) assert.equal(hooks.listRows().length, 50);
      assert.equal(localConnections, 0, "actual registered provider paints never open the coordinator");
      const result = await tools.get("subagent_result").execute("result", { id: "sa_shared_0", all: true }, undefined, undefined, ctx);
      assert.equal(result.details.assignment.revision, first.snapshot!.rows.find(row => row.meta.id === "sa_shared_0")!.assignment.revision);
      assert.equal(result.details.snapshot.instanceId, first.snapshot!.instanceId);
      assert.equal(localConnections, 0, "actual result observation uses the server batch, not a new local projector");
    } finally {
      sqlite.DatabaseSync = OriginalDatabase;
      await handlers.get("session_shutdown")?.({}, ctx);
      for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
    const replay = await first.request("runtime_subscribe", { scope: { cwd: root }, sinceSeq: -1, instanceId: first.snapshot!.instanceId });
    assert.equal(replay.resyncRequired, true);
    assert.equal(replay.resyncReason, "replay-truncated");
    const epoch = await first.request("runtime_subscribe", { scope: { cwd: root }, sinceSeq: 0, instanceId: "old-instance" });
    assert.equal(epoch.resyncReason, "instance-changed");
    await first.subscribe({ cwd: root, sessionId: "parent", limit: 100 });
    const changed = new Promise<void>(resolve => {
      const stop = first.onChange(snapshot => {
        if (snapshot.rows.find(row => row.meta.id === "sa_shared_0")?.assignment.state === "waiting") { stop(); resolve(); }
      });
    });
    const writer = openStore({ path: join(agent, "operation-coordinator.sqlite") });
    try {
      const owner = { kind: "worker-conversation", sessionId: "worker-0", workspace: root };
      writer.registerOperation({ operationId: "external-op", taskId: "external-task", launchToken: "token", owner,
        observer: { kind: "background-tasks", version: "1" }, supervision: { hostId: "host", runnerId: "runner" }, authorityRef: "scope" });
      writer.registerWait({ waitId: "external-wait", owner, dependencies: [{ operationId: "external-op" }], origin: { attemptId: "sa_shared_0" }, continuationNote: "Interpret external evidence." });
      await changed;
      assert.equal(first.snapshot!.rows.find(row => row.meta.id === "sa_shared_0")!.assignment.state, "waiting");
    } finally { writer.close(); }
    const disconnected = clients.at(-1)!;
    disconnected.close();
    assert.equal(disconnected.snapshot!.status, "degraded");
    assert.ok(disconnected.snapshot!.rows.length > 0, "disconnect preserves stale observations rather than faking an empty scope");
    await assert.rejects(disconnected.resync(), /disconnected/);
  } finally {
    clients.forEach(client => client.close());
    if (child.exitCode === null) { child.send("stop"); await once(child, "exit"); }
    rmSync(transport, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory reconciliation rereads changed records only and retains stale rows on corrupt external writes", async () => {
  const root = mkdtempSync(resolve("../../.work/753/inventory-"));
  const runs = join(root, "runs"); mkdirSync(runs);
  const model = new WorkReadModel(root, "instance", { baseDir: root, durableDir: join(root, "durable"), intervalMs: 60000 });
  const meta = { id: "sa_external", cwd: root, sessionId: "worker", status: "completed", startedAt: 1 };
  mkdirSync(join(runs, meta.id));
  const path = join(runs, meta.id, "meta.json");
  writeFileSync(path, JSON.stringify(meta));
  try {
    await model.reconcile();
    assert.equal(model.snapshot().rows[0]!.assignment.state, "completed");
    const reads = model.metrics.metadataReads, projections = model.metrics.projections;
    await model.reconcile();
    assert.equal(model.metrics.metadataReads, reads);
    assert.equal(model.metrics.projections, projections);
    execFileSync(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], process.argv[2])", path, JSON.stringify({ ...meta, status: "failed" })]);
    await model.reconcile();
    assert.equal(model.snapshot().rows[0]!.assignment.state, "failed");
    writeFileSync(path, "not json");
    await model.reconcile();
    assert.equal(model.snapshot().status, "degraded");
    assert.equal(model.snapshot().rows[0]!.assignment.state, "failed");
    model.invalidate("watcher overflow");
    writeFileSync(path, JSON.stringify(meta));
    await model.reconcile();
    assert.equal(model.snapshot().rows[0]!.assignment.state, "completed");
  } finally { await model.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a paused real socket has bounded queued snapshots and receives explicit resync after draining", { timeout: 10000 }, async () => {
  const root = mkdtempSync(resolve("../../.work/753/slow-"));
  const transport = mkdtempSync("/tmp/p753-");
  const runs = join(root, "runs", "sa_slow"); mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, "meta.json"), JSON.stringify({ id: "sa_slow", cwd: root, status: "completed", startedAt: 1, promptPreview: "x".repeat(100000) }));
  const model = new WorkReadModel(root, "slow-instance", { baseDir: root, intervalMs: 60000 });
  let accepted!: Socket;
  let queries!: WorkQueries;
  const server = createServer(socket => { accepted = socket; queries = new WorkQueries(model, socket, 1024); });
  const path = join(transport, "test.sock");
  await model.reconcile();
  server.listen(path); await once(server, "listening");
  const client = connect(path); client.pause();
  await once(server, "connection");
  try {
    queries.handle({ type: "runtime_subscribe", scope: {} });
    for (let i = 0; i < 1000; i++) model.invalidate("watcher overflow");
    assert.ok(accepted.writableLength <= 103000, `queued bytes exceeded one snapshot plus the queue allowance: ${accepted.writableLength}`);
    const resynced = new Promise<void>((resolve, reject) => {
      let buffer = "";
      client.setEncoding("utf8");
      client.on("data", chunk => {
        buffer += chunk;
        while (buffer.includes("\n")) {
          const index = buffer.indexOf("\n"), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          try { if (JSON.parse(line).event.type === "resync_required") resolve(); } catch (error) { reject(error); }
        }
      });
    });
    client.resume(); await resynced;
  } finally {
    client.destroy(); accepted.destroy(); queries.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await model.close(); rmSync(root, { recursive: true, force: true }); rmSync(transport, { recursive: true, force: true });
  }
});
