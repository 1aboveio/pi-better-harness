import test from "node:test";
import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { createServer, connect, type Socket } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { register, createRequire, syncBuiltinESMExports } from "node:module";
import { WorkClient } from "../src/runtime/work-client.mjs";
import { WorkReadModel } from "../src/runtime/read-model.ts";
import { WorkQueries } from "../src/runtime/queries.ts";

function fixtureRoot(name: string) {
  const parent = resolve("../../.work/753");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, `${name}-`));
}

test("one real daemon shares unchanged scope observations across 1, 5 and 10 socket clients", { timeout: 30000 }, async () => {
  const root = fixtureRoot("runtime");
  const transport = mkdtempSync("/tmp/p753-");
  const agent = join(root, "agent");
  const runs = join(root, "pi-better-subagents/runs");
  mkdirSync(agent); mkdirSync(runs, { recursive: true });
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ piBetterHarness: { subagents: { healthLongToolMs: 1 } } }));
  const coordinatorPath = new URL("../../pi-better-subagents/shared-operation-coordinator/index.ts", import.meta.url).href;
  const { openStore } = await import(coordinatorPath);
  openStore({ path: join(agent, "operation-coordinator.sqlite") }).close();
  for (let i = 0; i < 50; i++) {
    const id = `sa_shared_${i}`;
    mkdirSync(join(runs, id));
    writeFileSync(join(runs, id, "meta.json"), JSON.stringify({ id, sessionId: `worker-${i}`, cwd: root,
      status: "completed", startedAt: i, endedAt: Date.now(), callbackOrigin: { cwd: root, sessionId: "parent" },
      operations: { conversationId: `worker-${i}`, workspace: root } }));
  }
  writeFileSync(join(runs, "sa_shared_0", "output.log"), [
    { type: "tool_execution_start", toolCallId: "display-proof", toolName: "bash", at: Date.now() - 1000, args: {} },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 100, output: 20, cost: { total: 0.01 } } } },
  ].map(event => JSON.stringify(event)).join("\n") + "\n");
  const child = fork(new URL("./support/work-daemon.ts", import.meta.url), [], {
    execArgv: ["--import", "tsx"], env: { ...process.env, TMPDIR: root, PI_CODING_AGENT_DIR: agent, PI_SERVER_DIR: transport }, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let errors = "";
  child.stderr!.on("data", data => { errors += data; });
  const clients: WorkClient[] = [];
  const readers: ReturnType<typeof fork>[] = [];
  let proxy: ReturnType<typeof createServer> | undefined;
  const proxySockets = new Set<Socket>();
  try {
    const message = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(`daemon startup failed: ${errors}`); })]);
    const socket = (message[0] as { ready: string }).ready;
    const first = new WorkClient(socket, agent); clients.push(first);
    await first.subscribe({ cwd: root, sessionId: "parent", limit: 100 });
    if (first.snapshot?.status !== "ready") await new Promise<void>(resolve => {
      const stop = first.onChange(snapshot => { if (snapshot.status === "ready") { stop(); resolve(); } });
    });
    const before = await first.request("runtime_get_metrics");
    const actualConnections = async () => {
      const reply = once(child, "message"); child.send("metrics");
      return (await reply)[0].sqlite;
    };
    const sqliteBefore = await actualConnections();
    assert.equal(sqliteBefore.active, 2, "one actual index and one actual coordinator connection are retained by the daemon");
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
      assert.deepEqual(await actualConnections(), sqliteBefore, "queries do not open extra SQLite connections");
    }
    for (const count of [1, 5, 10]) {
      while (readers.length < count) {
        const reader = fork(new URL("./support/work-reader.mjs", import.meta.url), [], {
          execArgv: [], env: { ...process.env, WORK_SOCKET: socket, WORK_AGENT_DIR: agent,
            WORK_SCOPE: JSON.stringify({ cwd: root, sessionId: "parent", limit: 100 }) }, stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        readers.push(reader);
        const [ready] = await once(reader, "message");
        assert.equal(ready.snapshot.rows.length, 50);
        assert.equal(ready.snapshot.scopeRevision, first.snapshot!.scopeRevision);
      }
      const after = await first.request("runtime_get_metrics");
      assert.equal(after.projections, before.projections, `${count} independent client processes do not project unchanged scopes`);
      assert.equal(after.metadataReads, before.metadataReads, `${count} independent client processes do not reread metadata`);
      assert.equal(after.coordinatorConnections, 1);
      assert.equal(after.indexConnections, 1);
      assert.deepEqual(await actualConnections(), sqliteBefore, "independent processes share the same actual retained SQLite connections");
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
      const displayed = hooks.listRows().find((row: any) => row.id === "sa_shared_0");
      assert.equal(displayed.tool, "bash");
      assert.match(displayed.tokens, /120/);
      assert.ok(displayed.facts.some((fact: string) => /bash/.test(fact)), "cached health facts preserve configured long-tool diagnostics without client I/O");
      assert.equal(localConnections, 0, "actual registered provider paints never open the coordinator");
      const result = await tools.get("subagent_result").execute("result", { id: "sa_shared_0", all: true }, undefined, undefined, ctx);
      assert.equal(result.details.assignment.revision, first.snapshot!.rows.find(row => row.meta.id === "sa_shared_0")!.assignment.revision);
      assert.equal(result.details.snapshot.instanceId, first.snapshot!.instanceId);
      assert.equal(result.details.snapshot.seq, first.snapshot!.seq);
      assert.deepEqual(result.details.snapshot.observedRevisionVector, first.snapshot!.observedRevisionVector);
      assert.equal(localConnections, 0, "actual result observation uses the server batch, not a new local projector");
      const list = tools.get("subagent_list");
      const page = await list.execute("list", { all: true, limit: 2, max_bytes: 4096, status: ["completed"] }, undefined, undefined, ctx);
      assert.equal(page.details.snapshot.totalMatching, 50);
      assert.equal(page.details.snapshot.rows.length, 2);
      const cursor = page.content[0].text.match(/nextCursor=(\S+)/)[1];
      const next = await list.execute("list-next", { all: true, limit: 2, max_bytes: 4096, status: ["completed"], cursor }, undefined, undefined, ctx);
      assert.notEqual(page.details.snapshot.rows[0].meta.id, next.details.snapshot.rows[0].meta.id);
      assert.equal(localConnections, 0, "actual list handler consumes the server index without opening local SQLite");
      let detail;
      for (let attempt = 0; attempt < 100; attempt++) {
        detail = hooks.renderDetail("sa_shared_0").detail;
        if (detail.status !== "rebuilding") break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(detail.status, "completed");
      assert.match(detail.evidence.text, /done/);
      assert.equal(detail.metadata.find((item: any) => item.label === "revision").value, result.details.assignment.revision);
      const registryPath = new URL("../../pi-better-subagents/registry.ts", import.meta.url).href;
      const registryIo = await import(registryPath);
      registryIo.resetRegistryIoMetrics();
      const filesystem = createRequire(import.meta.url)("node:fs");
      const originalIo = new Map(["readFileSync", "statSync", "openSync"].map(name => [name, filesystem[name]]));
      let paintIo = 0;
      for (const [name, read] of originalIo) filesystem[name] = (...args: any[]) => { paintIo++; return read(...args); };
      syncBuiltinESMExports();
      try {
        for (let frame = 0; frame < 60; frame++) { hooks.renderDetail("sa_shared_0"); hooks.listRows(); }
      } finally {
        for (const [name, read] of originalIo) filesystem[name] = read;
        syncBuiltinESMExports();
      }
      assert.equal(paintIo, 0, "60 actual registered list/detail draws perform no filesystem reads, stats or opens");
      assert.equal(registryIo.getRegistryIoMetrics().metadataFileReads, 0, "registered detail draws consume the cached server snapshot");
      assert.equal(localConnections, 0, "registered detail draws never open a local coordinator");
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
    let dropNext = false, dropped = false;
    proxy = createServer(downstream => {
      const upstream = connect(socket); proxySockets.add(upstream); proxySockets.add(downstream);
      downstream.pipe(upstream);
      upstream.setEncoding("utf8");
      let buffer = "";
      upstream.on("data", chunk => {
        buffer += chunk;
        while (buffer.includes("\n")) {
          const index = buffer.indexOf("\n"), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          const frame = JSON.parse(line);
          // A non-atomic fixture write may publish a transient degraded snapshot first.
          if (dropNext && frame.event?.type === "runtime_snapshot"
            && frame.event.snapshot.rows.find((row: any) => row.meta.id === "sa_shared_0")?.meta.name === "gap-one") {
            dropped = true; continue;
          }
          if (frame.event?.snapshot?.rows.find((row: any) => row.meta.id === "sa_shared_0")?.meta.name === "gap-two") dropNext = false;
          downstream.write(line + "\n");
        }
      });
      upstream.on("error", () => downstream.destroy());
      downstream.on("error", () => upstream.destroy());
    });
    const proxyPath = join(transport, "gap.sock"); proxy.listen(proxyPath); await once(proxy, "listening");
    const gapped = new WorkClient(proxyPath, agent); clients.push(gapped);
    await gapped.subscribe({ cwd: root, sessionId: "parent", limit: 100 });
    const waitName = (client: WorkClient, name: string) => new Promise<void>(resolve => {
      const stop = client.onChange(snapshot => {
        if (snapshot.rows.find(row => row.meta.id === "sa_shared_0")?.meta.name === name) { stop(); resolve(); }
      });
    });
    const path = join(runs, "sa_shared_0", "meta.json");
    const { readFileSync } = await import("node:fs");
    const original = JSON.parse(readFileSync(path, "utf8"));
    dropNext = true;
    const intermediate = waitName(first, "gap-one");
    writeFileSync(path, JSON.stringify({ ...original, name: "gap-one" })); await intermediate;
    const resumed = waitName(gapped, "gap-two");
    writeFileSync(path, JSON.stringify({ ...original, name: "gap-two" })); await resumed;
    assert.equal(dropped, true);
    assert.equal(gapped.snapshot!.resyncRequired, true);
    assert.equal(gapped.snapshot!.resyncReason, "sequence-gap");
    const disconnected = clients.at(-1)!;
    disconnected.close();
    assert.equal(disconnected.snapshot!.status, "degraded");
    assert.ok(disconnected.snapshot!.rows.length > 0, "disconnect preserves stale observations rather than faking an empty scope");
    await assert.rejects(disconnected.resync(), /disconnected/);
    const reconnected = new WorkClient(socket, agent); clients.push(reconnected);
    const fresh = await reconnected.subscribe({ cwd: root, sessionId: "parent", limit: 100 });
    assert.equal(fresh.status, "ready");
    assert.equal(fresh.instanceId, first.snapshot!.instanceId);
    assert.equal(fresh.seq, first.snapshot!.seq, "a new transport takes a fresh atomic snapshot after disconnect");
    assert.equal(fresh.rows.find(row => row.meta.id === "sa_shared_0")!.meta.name, "gap-two");
  } finally {
    await Promise.all(readers.map(async reader => {
      if (reader.exitCode !== null) return;
      const exited = once(reader, "exit"); reader.send("stop"); await exited;
    }));
    clients.forEach(client => client.close());
    for (const socket of proxySockets) socket.destroy();
    if (proxy) await new Promise<void>(resolve => proxy!.close(() => resolve()));
    if (child.exitCode === null) { child.send("stop"); await once(child, "exit"); }
    rmSync(transport, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("registered Navigator preserves older active rows and the same consumers recover across daemon replacement", { timeout: 30000 }, async () => {
  const root = fixtureRoot("consumer");
  const transport = mkdtempSync("/tmp/p753-");
  const agent = join(root, "agent"), runs = join(root, "pi-better-subagents/runs");
  mkdirSync(agent); mkdirSync(runs, { recursive: true });
  const saved = new Map(["PI_CODING_AGENT_DIR", "TMPDIR", "PI_CATALOG_ACCEPTANCE_PROBE"].map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = agent; process.env.TMPDIR = root; process.env.PI_CATALOG_ACCEPTANCE_PROBE = "1";
  const launch = async () => {
    const worker = fork(new URL("./support/work-daemon.ts", import.meta.url), [], { execArgv: ["--import", "tsx"],
      env: { ...process.env, PI_SERVER_DIR: transport }, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    await once(worker, "message"); return worker;
  };
  let child = await launch();
  const stop = async () => { if (child.exitCode === null) { const exited = once(child, "exit"); child.send("stop"); await exited; } };
  const until = async (check: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 10000;
    while (!await check()) { assert.ok(Date.now() < deadline, "production observation did not converge"); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  const handlers = new Map<string, Function>(), tools = new Map<string, any>();
  const ctx = { cwd: root, mode: "tui", hasUI: true, isIdle: () => true,
    sessionManager: { getSessionId: () => "parent", getBranch: () => [] },
    ui: { theme: { fg: (_c: string, s: string) => s }, notify() {}, setStatus() {}, setWidget() {}, getEditorComponent() {}, setEditorComponent() {} } };
  try {
    register(new URL("../../pi-better-subagents/tests/pi_host_stub_hooks.mjs", import.meta.url));
    const { default: extension } = await import(new URL("../../pi-better-subagents/index.ts", import.meta.url).href);
    const observation = await import(new URL("../../pi-better-subagents/work-observation.ts", import.meta.url).href);
    extension({ on: (name: string, fn: Function) => handlers.set(name, fn), registerTool: (tool: any) => tools.set(tool.name, tool), sendMessage() {} });
    await handlers.get("session_start")!({}, ctx);
    for (let i = 0; i < 201; i++) {
      const id = `sa_review_${i}`; mkdirSync(join(runs, id));
      writeFileSync(join(runs, id, "meta.json"), JSON.stringify({ id, cwd: root, sessionId: `worker-${i}`,
        callbackOrigin: { cwd: root, sessionId: "parent" }, spawnPid: process.pid, pid: process.pid,
        status: i === 0 ? "running" : "completed", startedAt: i, ...(i ? { endedAt: 1 } : {}) }));
    }
    await until(() => observation.workObservation()?.activity.active === 1);
    await until(async () => (await observation.observedList({ cwd: root })).totalMatching === 201);
    assert.equal((await observation.observedList({ cwd: root })).totalMatching, 201);
    const hooks = (globalThis as any)[Symbol.for("pi-better-subagents.acceptance-hooks")];
    const provider = (globalThis as any)[Symbol.for("pi-better-harness.navigator.state")].providers.get("subagents");
    assert.equal(hooks.listRows().find((row: any) => row.id === "sa_review_0")?.status, "running");
    assert.equal(provider.visibleCount(), 1, "expired terminal history never hides the older active row or its count");
    for (let i = 0; i < 201; i++) {
      const id = `sa_active_page_${i}`; mkdirSync(join(runs, id));
      writeFileSync(join(runs, id, "meta.json"), JSON.stringify({ id, cwd: root, sessionId: `active-${i}`,
        callbackOrigin: { cwd: root, sessionId: "parent" }, spawnPid: process.pid, pid: process.pid, status: "running", startedAt: 1000 + i }));
    }
    await until(() => observation.workObservation()?.activity.active === 202);
    assert.equal(provider.visibleCount(), 202, "active pages are complete beyond the transport page size");
    assert.ok(hooks.listRows().some((row: any) => row.id === "sa_review_0"));
    for (const mode of ["tool-retry", "subscription-only"]) {
      const previous = observation.workObservation().instanceId;
      await stop();
      await until(() => observation.workObservation()?.status === "degraded");
      assert.ok(observation.workObservation().rows.some((row: any) => row.meta.id === "sa_review_0"));
      child = await launch();
      if (mode === "tool-retry") {
        const listed = await observation.observedList({ cwd: root, active: true });
        assert.equal(listed.totalMatching, 202);
        const assignment = await observation.observedAssignment("sa_review_0");
        assert.equal(assignment.assignment.state, "running");
      }
      await until(() => observation.workObservation()?.status === "ready" && observation.workObservation()?.instanceId !== previous);
      assert.equal(provider.visibleCount(), 202);
      assert.ok(hooks.listRows().some((row: any) => row.id === "sa_review_0"));
      const result = await tools.get("subagent_result").execute("review", { id: "sa_review_0", all: true }, undefined, undefined, ctx);
      assert.equal(result.details.assignment.state, "running");
      assert.equal(result.details.snapshot.instanceId, observation.workObservation().instanceId);
    }
    writeFileSync(join(runs, "sa_review_0", "meta.json"), JSON.stringify({ id: "sa_review_0", cwd: root, sessionId: "worker-0",
      callbackOrigin: { cwd: root, sessionId: "parent" }, spawnPid: process.pid, pid: process.pid,
      status: "completed", startedAt: 0, endedAt: Date.now() }));
    await until(() => hooks.listRows().find((row: any) => row.id === "sa_review_0")?.status === "completed");
    assert.equal(provider.visibleCount(), 201, "recent completion remains visible without counting it as active");
    const beforeClose = observation.workObservation().seq;
    assert.equal(provider.close("sa_review_0").action, "dismissed");
    assert.equal(observation.workObservation().seq, beforeClose, "the server snapshot has not advanced synchronously");
    assert.ok(!hooks.listRows().some((row: any) => row.id === "sa_review_0"), "confirmed dismissal must hide a stale cached row before the next server observation");
    await until(() => Boolean(observation.workObservation()?.rows.find((row: any) => row.meta.id === "sa_review_0")?.meta.dismissedAt));
    assert.ok(!hooks.listRows().some((row: any) => row.id === "sa_review_0"), "the acknowledged dismissal must not reappear");
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx); await stop();
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true }); rmSync(transport, { recursive: true, force: true });
  }
});

test("10000 durable records use bounded indexed history pages; a single archive replacement projects only its family", { timeout: 60000 }, async () => {
  const root = fixtureRoot("history");
  const durable = join(root, "durable"), archives = join(durable, "attempts"), sessions = join(durable, "sessions");
  mkdirSync(archives, { recursive: true });
  const meta = (i: number) => ({ id: `sa_history_${i}`, sessionId: `conversation-${i}`, cwd: root, status: "completed", startedAt: i,
    recipe: { version: 1, sessionId: `conversation-${i}`, cwd: root, sessionDir: sessions } });
  for (let i = 0; i < 10000; i++) writeFileSync(join(archives, `sa_history_${i}.json`), JSON.stringify({ version: 1, meta: meta(i) }));
  const runs = join(root, "runs"); mkdirSync(runs);
  for (let i = 0; i < 7; i++) {
    const id = `sa_active_${i}`; mkdirSync(join(runs, id));
    writeFileSync(join(runs, id, "meta.json"), JSON.stringify({ id, cwd: root, status: "running", startedAt: 20000 + i }));
  }
  const model = new WorkReadModel(root, "history-instance", { baseDir: root, durableDir: durable, intervalMs: 60000 });
  try {
    await model.reconcile();
    assert.equal(model.snapshot().status, "ready");
    const before = { ...model.metrics };
    for (let i = 0; i < 60; i++) assert.equal(model.snapshot({ active: true }).rows.length, 7);
    const first = model.snapshot({ cwd: root, statuses: ["completed"], limit: 3 });
    assert.equal(first.totalMatching, 10000);
    assert.deepEqual(first.rows.map(row => row.meta.id), ["sa_history_9999", "sa_history_9998", "sa_history_9997"]);
    const next = model.snapshot({ cwd: root, statuses: ["completed"], limit: 3, cursor: first.nextCursor });
    assert.deepEqual(next.rows.map(row => row.meta.id), ["sa_history_9996", "sa_history_9995", "sa_history_9994"]);
    assert.deepEqual(model.metrics, before, "indexed queries perform no inventory, metadata reads or projections");
    const changed = { ...meta(9999), name: "external replacement" };
    execFileSync(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], process.argv[2])", join(archives, "sa_history_9999.json"), JSON.stringify({ version: 1, meta: changed })]);
    await model.reconcile();
    assert.equal(model.snapshot({ id: changed.id }).rows[0]!.meta.name, "external replacement");
    assert.equal(model.metrics.metadataReads - before.metadataReads, 1);
    assert.equal(model.metrics.projections - before.projections, 1);
    assert.throws(() => model.snapshot({ cwd: root, statuses: ["completed"], limit: 3, cursor: first.nextCursor }), /resync_required/);
    const markers = join(durable, "session-state"); mkdirSync(markers);
    writeFileSync(join(markers, "conversation-9999.json"), JSON.stringify({ version: 1, sessionId: "conversation-9999", attemptId: "sa_newer_failed", status: "failed", startedAt: 30000, at: Date.now() }));
    await model.reconcile();
    assert.equal(model.snapshot({ id: changed.id }).rows.length, 0, "a later failed conversation marker hides the stale completed archive");
  } finally { await model.close(); rmSync(root, { recursive: true, force: true }); }
});

test("watch overflow and lost notifications reconcile external writes once and retain stale degraded rows", { timeout: 10000 }, async () => {
  const root = fixtureRoot("inventory");
  const runs = join(root, "runs"); mkdirSync(runs);
  const model = new WorkReadModel(root, "instance", { baseDir: root, durableDir: join(root, "durable"), intervalMs: 50 });
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
    const watchers = (model as unknown as { watchers: import("node:fs").FSWatcher[] }).watchers;
    assert.ok(watchers.length > 0);
    watchers[0]!.emit("error", new Error("injected kernel watcher overflow"));
    assert.equal(model.snapshot().status, "degraded", "the production watcher error callback exposes unknown freshness");
    await model.reconcile();
    watchers.forEach(watcher => watcher.close());
    let cancelRecovery = () => {};
    const recovered = new Promise<void>((resolve, reject) => {
      // With every watcher closed, only the unref'ed production poll remains.
      // This owned observation has a deadline; an idle runtime itself must not keep Node alive.
      const deadline = setTimeout(() => { off(); reject(new Error("lost-notification observation did not recover")); }, 10000);
      const off = model.onChange(() => {
        if (model.snapshot().rows[0]?.assignment.state === "failed") { clearTimeout(deadline); off(); resolve(); }
      });
      cancelRecovery = () => { clearTimeout(deadline); off(); };
    });
    try {
      execFileSync(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], process.argv[2])", path, JSON.stringify({ ...meta, status: "failed" })]);
      await recovered;
    } finally { cancelRecovery(); }
    assert.equal(model.snapshot().rows[0]!.assignment.state, "failed");
    assert.equal(model.metrics.metadataReads - reads, 1, "lost notifications require only one shared changed-record import");
    assert.equal(model.metrics.projections - projections, 1);
    writeFileSync(path, "not json");
    await model.reconcile();
    assert.equal(model.snapshot().status, "degraded");
    assert.equal(model.snapshot().rows[0]!.assignment.state, "failed");
    writeFileSync(path, JSON.stringify(meta));
    await model.reconcile();
    assert.equal(model.snapshot().rows[0]!.assignment.state, "completed");
    writeFileSync(path, JSON.stringify({ ...meta, status: "running", pid: 4194304 }));
    await model.reconcile();
    assert.equal(model.snapshot().rows[0]!.assignment.processStatus, "exited");
    assert.equal(model.snapshot().rows[0]!.assignment.state, "waiting", "a dead PID does not manufacture assignment completion");
  } finally { await model.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a paused real socket has bounded queued snapshots and receives explicit resync after draining", { timeout: 10000 }, async () => {
  const root = fixtureRoot("slow");
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
