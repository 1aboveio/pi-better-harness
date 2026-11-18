import test from "node:test";
import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { createServer, connect, type Socket } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { once, EventEmitter } from "node:events";
import goalExtension from "../../pi-better-goal/src/index.ts";
import { register, createRequire, syncBuiltinESMExports } from "node:module";
import { WorkClient } from "../src/runtime/work-client.mjs";
import { WorkReadModel } from "../src/runtime/read-model.ts";
import { WorkQueries } from "../src/runtime/queries.ts";
import { privateRuntimeNode } from "./private-runtime-node.ts";
import { runtimeWorkFailureState } from "./support/runtime-work-failure-state.ts";
import { historyPhaseMetrics } from "./support/history-phase-metrics.ts";

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
    writeFileSync(join(runs, id, "output.log"), JSON.stringify({ type: "agent_end", messages: [] }) + "\n");
  }
  writeFileSync(join(runs, "sa_shared_0", "output.log"), [
    { type: "tool_execution_start", toolCallId: "display-proof", toolName: "bash", at: Date.now() - 1000, args: {} },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 100, output: 20, cost: { total: 0.01 } } } },
    { type: "agent_end", messages: [] },
  ].map(event => JSON.stringify(event)).join("\n") + "\n");
  const child = fork(new URL("./support/work-daemon.ts", import.meta.url), [], {
    execPath: privateRuntimeNode().node, execArgv: ["--import", "tsx"], env: { ...process.env, TMPDIR: root, PI_CODING_AGENT_DIR: agent, PI_SERVER_DIR: transport }, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let errors = "";
  child.stderr!.on("data", data => { errors += data; });
  const clients: WorkClient[] = [];
  const readers: ReturnType<typeof fork>[] = [];
  let proxy: ReturnType<typeof createServer> | undefined;
  const proxySockets = new Set<Socket>();
  let phase = "daemon-startup";
  let lastToolRequest: unknown;
  let capturedPage: any;
  let suppliedCursor: string | undefined;
  const requests: unknown[] = [];
  const cursorIdentity = (cursor?: string) => {
    if (!cursor) return undefined;
    try {
      const [scopeKey, instanceId, tokenRevision, startedAt, id] = JSON.parse(Buffer.from(cursor, "base64url").toString());
      return { cursor, scopeKey, instanceId, tokenRevision, startedAt, id };
    } catch (error) { return { cursor, decodeError: String(error) }; }
  };
  const snapshotIdentity = (snapshot: any) => snapshot && ({ instanceId: snapshot.instanceId, seq: snapshot.seq,
    scopeRevision: snapshot.scopeRevision, status: snapshot.status, reason: snapshot.reason,
    observedRevisionVector: snapshot.observedRevisionVector, totalMatching: snapshot.totalMatching,
    nextCursor: cursorIdentity(snapshot.nextCursor), rows: snapshot.rows?.slice(0, 4).map((row: any) => ({
      id: row.meta.id, sourceRevision: row.sourceRevision, assignmentRevision: row.assignment?.revision,
      cursor: cursorIdentity(row.cursor) })) });
  const track = (client: WorkClient) => {
    const request = client.request.bind(client);
    client.request = (type, params) => {
      requests.push({ phase, type, params }); if (requests.length > 8) requests.shift();
      return request(type, params);
    };
    return client;
  };
  try {
    const message = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(`daemon startup failed: ${errors}`); })]);
    const socket = (message[0] as { ready: string }).ready;
    const first = track(new WorkClient(socket, agent)); clients.push(first);
    phase = "initial-subscribe";
    await first.subscribe({ cwd: root, sessionId: "parent", limit: 100 });
    if (first.snapshot?.status !== "ready") await new Promise<void>(resolve => {
      const stop = first.onChange(snapshot => { if (snapshot.status === "ready") { stop(); resolve(); } });
    });
    const before = await first.request("runtime_get_metrics");
    const actualConnections = async () => {
      const reply = once(child, "message"); child.send("metrics");
      const main = (await reply)[0].sqlite;
      const worker = (await first.request("runtime_get_metrics")).sqlite;
      return { opens: main.opens + worker.opens, active: main.active + worker.active,
        maximum: main.maximum + worker.maximum };
    };
    const sqliteBefore = await actualConnections();
    assert.equal(sqliteBefore.active, 2, "one coordinator and one derived connection retain the query index, durable inbox and checkpoints");
    assert.equal(first.snapshot!.rows.length, 50);
    for (const count of [1, 5, 10]) {
      phase = `shared-scope-clients-${count}`;
      while (clients.length < count) {
        const client = track(new WorkClient(socket, agent)); clients.push(client);
        await client.subscribe({ cwd: root, sessionId: "parent", limit: 100 });
      }
      for (const client of clients) {
        const snapshot = await client.get({ cwd: root, sessionId: "parent", limit: 100 });
        assert.equal(snapshot.scopeRevision, first.snapshot!.scopeRevision);
        assert.equal(snapshot.rows.length, 50);
      }
      const cold = await first.request("runtime_get_metrics");
      const scope = { cwd: root, sessionId: "parent", limit: count + 100 };
      const overlapping = await Promise.all(clients.map(client => client.get(scope)));
      assert.ok(overlapping.every(snapshot => snapshot.scopeRevision === overlapping[0]!.scopeRevision));
      const after = await first.request("runtime_get_metrics");
      assert.equal(after.queryCount - cold.queryCount, 1, `${count} clients execute one underlying cold scope query`);
      await Promise.all(clients.map(client => client.get(scope)));
      assert.equal((await first.request("runtime_get_metrics")).queryCount, after.queryCount, "warm reads use the bounded shared cache");
      assert.equal(after.projections, before.projections);
      assert.equal(after.metadataReads, before.metadataReads);
      assert.equal(after.coordinatorConnections, 1);
      assert.equal(after.indexConnections, 1);
      assert.deepEqual(await actualConnections(), sqliteBefore, "queries do not open extra SQLite connections");
    }
    for (const count of [1, 5, 10]) {
      phase = `independent-readers-${count}`;
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
    const goalHandlers = new Map<string, Function>();
    const events = new EventEmitter();
    const tools = new Map<string, any>();
    const ctx = { cwd: root, mode: "tui", hasUI: true, isIdle: () => true,
      sessionManager: { getSessionId: () => "parent", getBranch: () => [] },
      ui: { theme: { fg: (_c: string, s: string) => s }, notify() {}, setStatus() {}, setWidget() {},
        getEditorComponent() { return undefined; }, setEditorComponent() {} } };
    const sqlite = createRequire(import.meta.url)("node:sqlite");
    const OriginalDatabase = sqlite.DatabaseSync;
    let localConnections = 0;
    try {
      extension({ events, on: (key: string, fn: Function) => handlers.set(key, fn), registerTool: (tool: any) => tools.set(tool.name, tool), sendMessage() {} } as never);
      phase = "extension-session-start";
      await handlers.get("session_start")!({}, ctx);
      goalExtension({ events, on: (key: string, fn: Function) => goalHandlers.set(key, fn),
        registerTool() {}, registerCommand() {}, appendEntry() {}, sendMessage() {} } as never);
      await goalHandlers.get("session_start")!({}, ctx);
      const request = WorkClient.prototype.request;
      let goalQueries = 0;
      WorkClient.prototype.request = function(type: string, params?: any) {
        if (type === "runtime_get_snapshot") goalQueries++;
        return request.call(this, type, params);
      };
      try {
        for (let frame = 0; frame < 60; frame++) {
          await goalHandlers.get("before_agent_start")!({ systemPrompt: "base" }, ctx);
        }
        assert.equal(goalQueries, 0, "warmed Goal with the real Subagent provider sends no full-state socket queries");
      } finally { WorkClient.prototype.request = request; }
      sqlite.DatabaseSync = class extends OriginalDatabase { constructor(...args: any[]) { super(...args); localConnections++; } };
      const hooks = (globalThis as any)[Symbol.for("pi-better-subagents.acceptance-hooks")];
      for (let frame = 0; frame < 60; frame++) assert.equal(hooks.listRows().length, 50);
      const displayed = hooks.listRows().find((row: any) => row.id === "sa_shared_0");
      assert.equal(displayed.tool, "bash");
      assert.match(displayed.tokens, /120/);
      assert.ok(displayed.facts.some((fact: string) => /bash/.test(fact)), "cached health facts preserve configured long-tool diagnostics without client I/O");
      const logBefore = await first.request("runtime_get_metrics");
      phase = "navigator-log-publication";
      appendFileSync(join(runs, "sa_shared_0", "output.log"), JSON.stringify({ type: "tool_execution_start", toolCallId: "new-tool", toolName: "read", at: Date.now() - 1000 }) + "\n");
      for (let retry = 0; hooks.listRows().find((row: any) => row.id === "sa_shared_0")?.tool !== "read"; retry++) {
        assert.ok(retry < 200, "Navigator did not consume the changed log snapshot");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const logAfter = await first.request("runtime_get_metrics");
      assert.equal(logAfter.logProjections - logBefore.logProjections, 1);
      assert.equal(logAfter.assignmentProjections - logBefore.assignmentProjections, 0);
      assert.equal(localConnections, 0, "actual registered provider paints never open the coordinator");
      phase = "subagent-result";
      lastToolRequest = { tool: "subagent_result", call: "result", params: { id: "sa_shared_0", all: true } };
      const result = await tools.get("subagent_result").execute("result", { id: "sa_shared_0", all: true }, undefined, undefined, ctx);
      assert.equal(result.details.assignment.revision, first.snapshot!.rows.find(row => row.meta.id === "sa_shared_0")!.assignment.revision);
      assert.equal(result.details.snapshot.instanceId, first.snapshot!.instanceId);
      assert.equal(result.details.snapshot.seq, first.snapshot!.seq);
      assert.deepEqual(result.details.snapshot.observedRevisionVector, first.snapshot!.observedRevisionVector);
      assert.equal(localConnections, 0, "actual result observation uses the server batch, not a new local projector");
      const list = tools.get("subagent_list");
      phase = "list-first-page";
      lastToolRequest = { tool: "subagent_list", call: "list", params: { all: true, limit: 2, max_bytes: 4096, status: ["completed"] } };
      const page = await list.execute("list", { all: true, limit: 2, max_bytes: 4096, status: ["completed"] }, undefined, undefined, ctx);
      capturedPage = snapshotIdentity(page.details.snapshot);
      assert.equal(page.details.snapshot.totalMatching, 50);
      assert.equal(page.details.snapshot.rows.length, 2);
      const cursor = page.content[0].text.match(/nextCursor=(\S+)/)[1];
      suppliedCursor = cursor;
      phase = "list-next-page";
      lastToolRequest = { tool: "subagent_list", call: "list-next", params: { all: true, limit: 2, max_bytes: 4096, status: ["completed"], cursor } };
      const next = await list.execute("list-next", { all: true, limit: 2, max_bytes: 4096, status: ["completed"], cursor }, undefined, undefined, ctx);
      assert.notEqual(page.details.snapshot.rows[0].meta.id, next.details.snapshot.rows[0].meta.id);
      assert.equal(localConnections, 0, "actual list handler consumes the server index without opening local SQLite");
      let detail;
      phase = "cached-detail";
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
      assert.ok(displayed.facts.some((fact: string) => /long bash/.test(fact)));
      phase = "health-threshold-publication";
      writeFileSync(join(agent, "settings.json"), JSON.stringify({ piBetterHarness: { subagents: { healthLongToolMs: 600000 } } }));
      const thresholdDeadline = Date.now() + 10000;
      while (hooks.listRows().find((row: any) => row.id === "sa_shared_0").facts.some((fact: string) => /long (bash|read)/.test(fact))) {
        assert.ok(Date.now() < thresholdDeadline, "Navigator did not observe new health thresholds");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      phase = "health-list";
      lastToolRequest = { tool: "subagent_list", call: "health-list", params: { all: true, limit: 100 } };
      const refreshed = await tools.get("subagent_list").execute("health-list", { all: true, limit: 100 }, undefined, undefined, ctx);
      assert.ok(refreshed.details.snapshot.rows.length > 0);
      assert.ok(refreshed.details.snapshot.rows.every((row: any) => row.health.thresholds.longToolMs === 600000), "tool and Navigator share the updated judgment");
    } finally {
      sqlite.DatabaseSync = OriginalDatabase;
      await goalHandlers.get("session_shutdown")?.({}, ctx);
      await handlers.get("session_shutdown")?.({}, ctx);
      for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
    phase = "explicit-replay-resync";
    const replay = await first.request("runtime_subscribe", { scope: { cwd: root }, sinceSeq: -1, instanceId: first.snapshot!.instanceId });
    assert.equal(replay.resyncRequired, true);
    assert.equal(replay.resyncReason, "replay-truncated");
    phase = "explicit-instance-resync";
    const epoch = await first.request("runtime_subscribe", { scope: { cwd: root }, sinceSeq: 0, instanceId: "old-instance" });
    assert.equal(epoch.resyncReason, "instance-changed");
    await first.subscribe({ cwd: root, sessionId: "parent", limit: 100 });
    phase = "external-assignment-publication";
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
    phase = "dropped-event-subscribe";
    const gapped = track(new WorkClient(proxyPath, agent)); clients.push(gapped);
    await gapped.subscribe({ cwd: root, sessionId: "parent", limit: 100 });
    let observedGap = false;
    const stopGapObservation = gapped.onChange(snapshot => {
      if (snapshot.resyncRequired && snapshot.resyncReason === "sequence-gap") observedGap = true;
    });
    const waitName = (client: WorkClient, name: string) => new Promise<void>(resolve => {
      const stop = client.onChange(snapshot => {
        if (snapshot.rows.find(row => row.meta.id === "sa_shared_0")?.meta.name === name) { stop(); resolve(); }
      });
    });
    const path = join(runs, "sa_shared_0", "meta.json");
    const { readFileSync } = await import("node:fs");
    const original = JSON.parse(readFileSync(path, "utf8"));
    dropNext = true;
    phase = "dropped-event-gap-one";
    const intermediate = waitName(first, "gap-one");
    writeFileSync(path, JSON.stringify({ ...original, name: "gap-one" })); await intermediate;
    phase = "dropped-event-gap-two";
    const resumed = waitName(gapped, "gap-two");
    writeFileSync(path, JSON.stringify({ ...original, name: "gap-two" })); await resumed;
    assert.equal(dropped, true);
    assert.equal(observedGap, true, "the first complete snapshot after the dropped event reports the gap");
    stopGapObservation();
    phase = "disconnect-and-reconnect";
    const disconnected = clients.at(-1)!;
    disconnected.close();
    assert.equal(disconnected.snapshot!.status, "degraded");
    assert.ok(disconnected.snapshot!.rows.length > 0, "disconnect preserves stale observations rather than faking an empty scope");
    await assert.rejects(disconnected.resync(), /disconnected/);
    const reconnected = track(new WorkClient(socket, agent)); clients.push(reconnected);
    const fresh = await reconnected.subscribe({ cwd: root, sessionId: "parent", limit: 100 });
    assert.equal(fresh.status, "ready");
    assert.equal(fresh.instanceId, first.snapshot!.instanceId);
    assert.equal(fresh.seq, first.snapshot!.seq, "a new transport takes a fresh atomic snapshot after disconnect");
    assert.equal(fresh.rows.find(row => row.meta.id === "sa_shared_0")!.meta.name, "gap-two");
  } catch (error) {
    console.error(`Runtime work cursor failure: ${JSON.stringify({ phase, error: String(error), lastToolRequest,
      requests, suppliedCursor: cursorIdentity(suppliedCursor), capturedPage,
      cachedClients: clients.slice(0, 12).map(client => snapshotIdentity(client.snapshot)) })}`);
    throw error;
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

test("registered Navigator preserves older active rows and the same consumers recover across daemon replacement", { timeout: 30000 }, async t => {
  let child: ReturnType<typeof fork> | undefined, launching: ReturnType<typeof fork> | undefined, observation: any;
  let replacement = "initial";
  const phase = runtimeWorkFailureState(t, "navigator-replacement", () => {
    const cached = observation?.workObservation();
    const process = launching ?? child;
    return { replacement, child: process && { pid: process.pid, exitCode: process.exitCode, signalCode: process.signalCode, connected: process.connected },
      observation: cached && { status: cached.status, reason: cached.reason, instanceId: cached.instanceId, seq: cached.seq,
        active: cached.activity?.active, rows: cached.rows?.length, sample: cached.rows?.slice(0, 8).map((row: any) => ({ id: row.meta.id, status: row.meta.status })) } };
  });
  const root = fixtureRoot("consumer");
  const transport = mkdtempSync("/tmp/p753-");
  const agent = join(root, "agent"), runs = join(root, "pi-better-subagents/runs");
  mkdirSync(agent); mkdirSync(runs, { recursive: true });
  const saved = new Map(["PI_CODING_AGENT_DIR", "TMPDIR", "PI_CATALOG_ACCEPTANCE_PROBE"].map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = agent; process.env.TMPDIR = root; process.env.PI_CATALOG_ACCEPTANCE_PROBE = "1";
  const launch = async () => {
    phase(`daemon:${replacement}:ready-message`);
    const worker = fork(new URL("./support/work-daemon.ts", import.meta.url), [], { execArgv: ["--import", "tsx"],
      env: { ...process.env, PI_SERVER_DIR: transport }, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    launching = worker;
    await once(worker, "message"); launching = undefined; return worker;
  };
  child = await launch();
  const stop = async () => { phase(`daemon:${replacement}:exit`); if (child!.exitCode === null) { const exited = once(child!, "exit"); child!.send("stop"); await exited; } };
  const until = async (label: string, check: () => boolean | Promise<boolean>) => {
    phase(label);
    const deadline = Date.now() + 10000;
    while (!await check()) { assert.ok(Date.now() < deadline, "production observation did not converge"); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  const handlers = new Map<string, Function>(), tools = new Map<string, any>();
  const ctx = { cwd: root, mode: "tui", hasUI: true, isIdle: () => true,
    sessionManager: { getSessionId: () => "parent", getBranch: () => [] },
    ui: { theme: { fg: (_c: string, s: string) => s }, notify() {}, setStatus() {}, setWidget() {}, getEditorComponent() {}, setEditorComponent() {} } };
  try {
    register(new URL("../../pi-better-subagents/tests/pi_host_stub_hooks.mjs", import.meta.url));
    phase("extension:import");
    const { default: extension } = await import(new URL("../../pi-better-subagents/index.ts", import.meta.url).href);
    observation = await import(new URL("../../pi-better-subagents/work-observation.ts", import.meta.url).href);
    extension({ on: (name: string, fn: Function) => handlers.set(name, fn), registerTool: (tool: any) => tools.set(tool.name, tool), sendMessage() {} });
    phase("extension:session-start");
    await handlers.get("session_start")!({}, ctx);
    for (let i = 0; i < 201; i++) {
      const id = `sa_review_${i}`; mkdirSync(join(runs, id));
      writeFileSync(join(runs, id, "meta.json"), JSON.stringify({ id, cwd: root, sessionId: `worker-${i}`,
        callbackOrigin: { cwd: root, sessionId: "parent" }, spawnPid: process.pid, pid: process.pid,
        status: i === 0 ? "running" : "completed", startedAt: i, ...(i ? { endedAt: 1 } : {}) }));
      writeFileSync(join(runs, id, "output.log"), [
        { type: "message_end", message: { role: "assistant", usage: { input: 120, cost: { total: 0.01 } } } },
        { type: "tool_execution_start", toolCallId: "recovery", toolName: "bash", at: Date.now() },
        { type: "message_update", message: { role: "assistant", content: "x".repeat(67000) } },
      ].map(event => JSON.stringify(event) + "\n").join(""));
    }
    await until("initial:active-observation", () => observation.workObservation()?.activity.active === 1);
    await until("initial:201-history-list", async () => (await observation.observedList({ cwd: root })).totalMatching === 201);
    phase("initial:201-history-list-confirmation");
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
    await until("initial:202-active-pages", () => observation.workObservation()?.activity.active === 202);
    assert.equal(provider.visibleCount(), 202, "active pages are complete beyond the transport page size");
    assert.ok(hooks.listRows().some((row: any) => row.id === "sa_review_0"));
    for (const mode of ["tool-retry", "subscription-only"]) {
      replacement = mode;
      const previous = observation.workObservation().instanceId;
      await stop();
      await until(`${mode}:disconnect-observed`, () => observation.workObservation()?.status === "degraded");
      assert.ok(observation.workObservation().rows.some((row: any) => row.meta.id === "sa_review_0"));
      child = await launch();
      if (mode === "tool-retry") {
        phase(`${mode}:active-list`);
        const listed = await observation.observedList({ cwd: root, active: true });
        assert.equal(listed.totalMatching, 202);
        phase(`${mode}:older-active-assignment`);
        const assignment = await observation.observedAssignment("sa_review_0");
        assert.equal(assignment.assignment.state, "running");
      }
      await until(`${mode}:same-consumer-new-instance`, () => observation.workObservation()?.status === "ready" && observation.workObservation()?.instanceId !== previous);
      assert.equal(provider.visibleCount(), 202);
      assert.ok(hooks.listRows().some((row: any) => row.id === "sa_review_0"));
      const restored = hooks.listRows().find((row: any) => row.id === "sa_review_0");
      assert.equal(restored.tool, "bash");
      assert.match(restored.tokens, /120/);
      phase(`${mode}:result-tool`);
      const result = await tools.get("subagent_result").execute("review", { id: "sa_review_0", all: true }, undefined, undefined, ctx);
      assert.equal(result.details.assignment.state, "running");
      assert.equal(result.details.snapshot.instanceId, observation.workObservation().instanceId);
      phase(`${mode}:list-tool`);
      let listed = await tools.get("subagent_list").execute("recovered-list", { all: true, limit: 100 }, undefined, undefined, ctx);
      let row = listed.details.snapshot.rows.find((row: any) => row.meta.id === "sa_review_0");
      while (!row && listed.details.snapshot.nextCursor) {
        phase(`${mode}:list-tool-next-page`);
        listed = await tools.get("subagent_list").execute("recovered-page", { all: true, limit: 100, cursor: listed.details.snapshot.nextCursor }, undefined, undefined, ctx);
        row = listed.details.snapshot.rows.find((row: any) => row.meta.id === "sa_review_0");
      }
      assert.ok(row, "the recovered list contains the older active task across pages");
      assert.ok(row.display.spend.includes("0.01"));
      assert.equal(row.health.facts.activeTools.length, 1);
    }
    writeFileSync(join(runs, "sa_review_0", "meta.json"), JSON.stringify({ id: "sa_review_0", cwd: root, sessionId: "worker-0",
      callbackOrigin: { cwd: root, sessionId: "parent" }, spawnPid: process.pid, pid: process.pid,
      status: "completed", startedAt: 0, endedAt: Date.now() }));
    await until("final:older-active-completion", () => hooks.listRows().find((row: any) => row.id === "sa_review_0")?.status === "completed");
    assert.equal(provider.visibleCount(), 201, "recent completion remains visible without counting it as active");
    const beforeClose = observation.workObservation().seq;
    assert.equal(provider.close("sa_review_0").action, "dismissed");
    assert.equal(observation.workObservation().seq, beforeClose, "the server snapshot has not advanced synchronously");
    assert.ok(!hooks.listRows().some((row: any) => row.id === "sa_review_0"), "confirmed dismissal must hide a stale cached row before the next server observation");
    await until("final:dismissal-observed", () => Boolean(observation.workObservation()?.rows.find((row: any) => row.meta.id === "sa_review_0")?.meta.dismissedAt));
    assert.ok(!hooks.listRows().some((row: any) => row.id === "sa_review_0"), "the acknowledged dismissal must not reappear");
  } finally {
    phase("cleanup:session-shutdown");
    await handlers.get("session_shutdown")?.({}, ctx); await stop();
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true }); rmSync(transport, { recursive: true, force: true });
  }
});

test("10000 durable records use bounded indexed history pages; a single archive replacement projects only its family", { timeout: 60000 }, async t => {
  let model: WorkReadModel | undefined;
  const phase = runtimeWorkFailureState(t, "10000-history", () => {
    const state = model as any;
    return state && { pending: Boolean(state.pending), imported: state.imported, dirty: state.dirty, repair: Boolean(state.repair),
      hints: state.hints.size, files: state.files.size, projected: state.projected.size, status: state.state, reason: state.reason,
      sourceErrors: state.sourceErrors.size, counters: state.counters, scheduling: state.scheduling, sourceWork: state.sourceWork,
      checkpoints: state.checkpoints.metrics };
  });
  const started = performance.now();
  let archivesWritten = 0, activeWritten = 0, reported = false;
  const phases: { phase: string; elapsedMs: number; metrics: unknown }[] = [];
  const mark = (phase: string) => {
    phases.push({ phase, elapsedMs: Math.round(performance.now() - started), metrics: historyPhaseMetrics(model) });
    if (phases.length > 32) phases.shift();
  };
  const report = (cause: "abort" | "failure") => {
    if (reported) return;
    reported = true;
    const state = model as any;
    console.error(JSON.stringify({ historyDeadlineFailure: { cause, elapsedMs: Math.round(performance.now() - started),
      archivesWritten, activeWritten, phases, metrics: historyPhaseMetrics(model),
      model: state && { state: state.state, imported: state.imported, pending: Boolean(state.pending), repair: Boolean(state.repair) } } }));
  };
  const aborted = () => report("abort");
  t.signal.addEventListener("abort", aborted, { once: true });
  t.after(() => t.signal.removeEventListener("abort", aborted));
  mark("fixture-setup");
  const root = fixtureRoot("history");
  const durable = join(root, "durable"), archives = join(durable, "attempts"), sessions = join(durable, "sessions");
  mkdirSync(archives, { recursive: true });
  const meta = (i: number) => ({ id: `sa_history_${i}`, sessionId: `conversation-${i}`, cwd: root, status: "completed", startedAt: i,
    assignment: { assignmentId: `history-assignment-${i}` },
    recipe: { version: 1, sessionId: `conversation-${i}`, cwd: root, sessionDir: sessions } });
  phase("seed:10000-archives");
  for (let i = 0; i < 10000; i++) {
    writeFileSync(join(archives, `sa_history_${i}.json`), JSON.stringify({ version: 1, meta: meta(i) }));
    archivesWritten++;
    if (archivesWritten % 1000 === 0) mark("archive-setup-progress");
  }
  const runs = join(root, "runs"); mkdirSync(runs);
  for (let i = 0; i < 7; i++) {
    const id = `sa_active_${i}`; mkdirSync(join(runs, id));
    writeFileSync(join(runs, id, "meta.json"), JSON.stringify({ id, cwd: root, status: "running", startedAt: 20000 + i }));
    activeWritten++;
  }
  mark("coordinator-import-and-open");
  const coordinatorPath = new URL("../../pi-better-subagents/shared-operation-coordinator/index.ts", import.meta.url).href;
  const { openStore } = await import(coordinatorPath);
  const writer = openStore({ path: join(root, "operation-coordinator.sqlite") });
  mark("model-construction");
  model = new WorkReadModel(root, "history-instance", { baseDir: root, durableDir: durable, intervalMs: 60000 });
  try {
    phase("reconcile:first-import");
    mark("initial-reconcile");
    await model.reconcile();
    mark("indexed-history-queries");
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
    phase("archive:external-replacement-process");
    mark("external-process-archive-replacement");
    execFileSync(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], process.argv[2])", join(archives, "sa_history_9999.json"), JSON.stringify({ version: 1, meta: changed })]);
    phase("reconcile:one-archive-replacement");
    mark("archive-replacement-reconcile");
    await model.reconcile();
    mark("archive-family-and-cursor-checks");
    assert.equal(model.snapshot({ id: changed.id }).rows[0]!.meta.name, "external replacement");
    assert.equal(model.metrics.metadataReads - before.metadataReads, 1);
    assert.equal(model.metrics.projections - before.projections, 1);
    assert.throws(() => model.snapshot({ cwd: root, statuses: ["completed"], limit: 3, cursor: first.nextCursor }), /resync_required/);
    const markers = join(durable, "session-state"); mkdirSync(markers);
    writeFileSync(join(markers, "conversation-9999.json"), JSON.stringify({ version: 1, sessionId: "conversation-9999", attemptId: "sa_newer_failed", status: "failed", startedAt: 30000, at: Date.now() }));
    phase("reconcile:conversation-marker");
    mark("conversation-marker-reconcile");
    await model.reconcile();
    mark("coordinator-wait-registration");
    assert.equal(model.snapshot({ id: changed.id }).rows.length, 0, "a later failed conversation marker hides the stale completed archive");
    const projected = model.metrics.projections;
    const owner = { kind: "worker-conversation" as const, sessionId: "conversation-9998", workspace: root };
    writer.registerOperation({ operationId: "history-op", taskId: "history-task", launchToken: "history-token", owner,
      observer: { kind: "background-tasks", version: "1" }, supervision: { hostId: "history-host", runnerId: "history-runner" }, authorityRef: "scope" });
    writer.registerWait({ waitId: "history-wait", owner, dependencies: [{ operationId: "history-op" }],
      origin: { attemptId: "sa_history_9998", assignmentRef: "history-assignment-9998" }, continuationNote: "Interpret evidence." });
    phase("reconcile:one-assignment-wait");
    mark("coordinator-wait-reconcile");
    await model.reconcile();
    mark("coordinator-outcome-registration");
    assert.equal(model.snapshot({ id: "sa_history_9998" }).rows[0]!.assignment.state, "waiting");
    assert.equal(model.metrics.projections - projected, 1, "one coordinator change must not reproject unrelated historical conversations");
    const beforeOutcome = model.metrics.projections;
    const decision = { assignmentId: "history-assignment-9997", owner: { ...owner, sessionId: "conversation-9997" },
      recipient: { kind: "parent-session", sessionId: "parent", workspace: root }, revision: 1,
      outcome: "failed", reason: "Retained diagnosis", evidence: [], waits: [], processUncertain: false };
    writer.registerAssignment(decision);
    writer.recordAssignmentOutcome(decision);
    phase("reconcile:one-assignment-outcome");
    mark("coordinator-outcome-reconcile");
    await model.reconcile();
    mark("external-schema-open");
    assert.equal(model.snapshot({ id: "sa_history_9997" }).rows[0]!.assignment.state, "failed");
    assert.equal(model.metrics.projections - beforeOutcome, 1, "outcome-only changes invalidate their own conversation");
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    const external = new DatabaseSync(join(root, "operation-coordinator.sqlite"));
    try {
      external.exec("UPDATE schema_meta SET value = 'unsupported' WHERE key = 'schema_version'");
      phase("reconcile:unsupported-schema");
      mark("unsupported-schema-reconcile");
      await model.reconcile();
      mark("unsupported-schema-checks");
      assert.equal(model.snapshot().status, "degraded", "a schema-only change invalidates previously verified observations");
      assert.equal(model.snapshot({ id: "sa_history_9997" }).rows[0]!.assignment.verified, false);
      external.exec("UPDATE schema_meta SET value = '4' WHERE key = 'schema_version'");
      phase("reconcile:restored-schema");
      mark("restored-schema-reconcile");
      await model.reconcile();
      mark("restored-schema-checks");
      assert.equal(model.snapshot().status, "ready", "compatible coordinator state recovers without restarting the read model");
    } finally { external.close(); }
  } catch (error) { report("failure"); throw error; }
  finally {
    phase("cleanup:model-close");
    mark("model-close"); await model.close();
    mark("writer-close-and-fixture-removal"); writer.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent coordinator writes cannot starve an initial inventory or hide later assignment changes", { timeout: 10000 }, async t => {
  let observedModel: WorkReadModel | undefined;
  const trace = (phase: string) => {
    if (process.env.PI_TEST_RUNTIME_WORK_PHASES === "1") t.diagnostic(JSON.stringify({ case: "coordinator-churn", phase,
      owner: observedModel && { closed: (observedModel as any).closed, readerInitialized: Boolean((observedModel as any).reader),
        watchers: (observedModel as any).watchers.size, parentWatchers: (observedModel as any).rootParents.size },
      resources: process.getActiveResourcesInfo() }));
  };
  trace("callback-entered");
  const root = fixtureRoot("coordinator-churn");
  const run = join(root, "runs/sa_churn"); mkdirSync(run, { recursive: true });
  writeFileSync(join(run, "meta.json"), JSON.stringify({ id: "sa_churn", sessionId: "worker", cwd: root,
    status: "completed", startedAt: 1, operations: { conversationId: "worker", workspace: root } }));
  const { openStore } = await import(new URL("../../pi-better-subagents/shared-operation-coordinator/index.ts", import.meta.url).href);
  const path = join(root, "operation-coordinator.sqlite");
  const writer = openStore({ path });
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const external = new DatabaseSync(path);
  external.exec("CREATE TABLE diagnostic_churn(value INTEGER); INSERT INTO diagnostic_churn VALUES(0)");
  const model = new WorkReadModel(root, "churn-instance", { baseDir: root, durableDir: join(root, "durable"), intervalMs: 60000 });
  observedModel = model;
  let cleanup: Promise<void> | undefined;
  const close = () => cleanup ??= (async () => {
    await model.close(); external.close(); writer.close(); rmSync(root, { recursive: true, force: true });
  })();
  t.after(async () => { trace("after-callback-before-cleanup"); await close(); trace("after-cleanup"); });
  trace("model-constructed");
  try {
    // Install once after ordinary reader acquisition, without a warm-up scan.
    const scan = (model as any).scan.bind(model);
    (model as any).scan = (paths: string[]) => {
      (model as any).scan = scan;
      const reader = (model as any).reader;
      const read = reader.read.bind(reader);
      reader.read = (owner: any) => {
        const observation = read(owner);
        external.exec("UPDATE diagnostic_churn SET value = value + 1");
        return observation;
      };
      return scan(paths);
    };
    await model.reconcile();
    assert.equal(model.snapshot().status, "ready", "an unrelated commit during every projection must not discard the whole inventory");
    assert.equal(model.snapshot().rows[0]!.assignment.state, "completed");
    const owner = { kind: "worker-conversation" as const, sessionId: "worker", workspace: root };
    writer.registerOperation({ operationId: "churn-op", taskId: "churn-task", launchToken: "churn-token", owner,
      observer: { kind: "background-tasks", version: "1" }, supervision: { hostId: "churn-host", runnerId: "churn-runner" }, authorityRef: "scope" });
    writer.registerWait({ waitId: "churn-wait", owner, dependencies: [{ operationId: "churn-op" }],
      origin: { attemptId: "sa_churn" }, continuationNote: "Interpret evidence." });
    await model.reconcile();
    assert.equal(model.snapshot().status, "ready");
    assert.equal(model.snapshot().rows[0]!.assignment.state, "waiting", "a later coordinator snapshot must observe the new wait");
    trace("assertions-complete");
  } finally { trace("finally-entered"); await close(); trace("finally-complete"); }
});

test("source churn retries reuse completed historical parsing without publishing an inconsistent snapshot", async () => {
  const root = fixtureRoot("source-churn");
  const metas = ["history", "changing"].map(name => ({ id: `sa_${name}`, sessionId: name, cwd: root,
    status: "completed", startedAt: 1, operations: { conversationId: name, workspace: root } }));
  for (const meta of metas) {
    mkdirSync(join(root, "runs", meta.id), { recursive: true });
    writeFileSync(join(root, "runs", meta.id, "meta.json"), JSON.stringify(meta));
  }
  const { openStore } = await import(new URL("../../pi-better-subagents/shared-operation-coordinator/index.ts", import.meta.url).href);
  const writer = openStore({ path: join(root, "operation-coordinator.sqlite") });
  const model = new WorkReadModel(root, "source-churn", { baseDir: root, durableDir: join(root, "durable"), intervalMs: 60000 });
  let changed = false;
  try {
    const scan = (model as any).scan.bind(model);
    (model as any).scan = (paths: string[]) => {
      (model as any).scan = scan;
      const reader = (model as any).reader;
      const read = reader.read.bind(reader);
      reader.read = (owner: any) => {
        if (!changed) {
          changed = true;
          assert.equal(model.snapshot().rows.length, 0);
          writeFileSync(join(root, "runs/sa_changing/meta.json"), JSON.stringify({ ...metas[1], name: "latest" }));
        }
        return read(owner);
      };
      return scan(paths);
    };
    await model.reconcile();
    assert.equal(model.snapshot().status, "ready");
    assert.equal(model.snapshot({ id: "sa_changing" }).rows[0]!.meta.name, "latest");
    assert.equal(model.metrics.metadataReads, 3, "unchanged historical metadata survives an abandoned scan");
    assert.equal(model.metrics.projections, 3, "only the changed family needs projection again");
  } finally { await model.close(); writer.close(); rmSync(root, { recursive: true, force: true }); }
});

test("source retry invalidates cached assignments when a newer journal position arrives", async () => {
  const root = fixtureRoot("source-journal-churn");
  const metas = ["history", "changing"].map(name => ({ id: `sa_${name}`, sessionId: name, cwd: root,
    status: "completed", startedAt: 1, operations: { conversationId: name, workspace: root } }));
  for (const meta of metas) {
    mkdirSync(join(root, "runs", meta.id), { recursive: true });
    writeFileSync(join(root, "runs", meta.id, "meta.json"), JSON.stringify(meta));
  }
  const { openStore } = await import(new URL("../../pi-better-subagents/shared-operation-coordinator/index.ts", import.meta.url).href);
  const writer = openStore({ path: join(root, "operation-coordinator.sqlite") });
  const model = new WorkReadModel(root, "journal-churn", { baseDir: root, durableDir: join(root, "durable"), intervalMs: 60000 });
  let changed = false;
  try {
    const scan = (model as any).scan.bind(model);
    (model as any).scan = (paths: string[]) => {
      (model as any).scan = scan;
      const reader = (model as any).reader;
      const read = reader.read.bind(reader);
      reader.read = (owner: any) => {
        const result = read(owner);
        if (!changed) {
          changed = true;
          writeFileSync(join(root, "runs/sa_changing/meta.json"), JSON.stringify({ ...metas[1], name: "latest" }));
          const owner = { kind: "worker-conversation" as const, sessionId: "history", workspace: root };
          writer.registerOperation({ operationId: "retry-op", taskId: "retry-task", launchToken: "retry-token", owner,
            observer: { kind: "background-tasks", version: "1" }, supervision: { hostId: "host", runnerId: "runner" }, authorityRef: "scope" });
          writer.registerWait({ waitId: "retry-wait", owner, dependencies: [{ operationId: "retry-op" }],
            origin: { attemptId: "sa_history" }, continuationNote: "Interpret evidence." });
        }
        return result;
      };
      return scan(paths);
    };
    await model.reconcile();
    assert.equal(model.snapshot().status, "ready");
    assert.equal(model.snapshot({ id: "sa_history" }).rows[0]!.assignment.state, "waiting");
    assert.equal(model.snapshot({ id: "sa_changing" }).rows[0]!.meta.name, "latest");
    assert.equal(model.metrics.metadataReads, 3);
    assert.equal(model.metrics.projections, 4, "the changed file and newer assignment obligation each invalidate their cached family");
    assert.equal(model.metrics.assignments.pending, 0);
  } finally { await model.close(); writer.close(); rmSync(root, { recursive: true, force: true }); }
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
    const watchers = (model as unknown as { watchers: Map<string, import("node:fs").FSWatcher> }).watchers;
    assert.ok(watchers.size > 0);
    watchers.values().next().value!.emit("error", new Error("injected kernel watcher overflow"));
    assert.equal(model.snapshot().status, "degraded", "the production watcher error callback exposes unknown freshness");
    await model.reconcile();
    // Reconciliation may replace the failed watcher; close the current map,
    // not a snapshot of the pre-overflow handles. Recovery must use the poll.
    watchers.forEach(watcher => watcher.close());
    let cancelRecovery = () => {};
    const recovered = new Promise<void>((resolve, reject) => {
      // Backported from reviewed754 f845: the observer owns its bounded wait.
      // With every watcher closed, only the unref'ed production poll remains.
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

test("a paused real socket has bounded queued snapshots and receives explicit resync after draining", { timeout: 10000 }, async t => {
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
  let cancelResync = () => {};
  try {
    queries.handle({ type: "runtime_subscribe", scope: {} });
    // Identical invalidations are coalesced; backpressure needs real content changes.
    for (let i = 0; i < 1000; i++) model.invalidate(`watcher overflow ${i}`);
    assert.ok(accepted.writableLength <= 103000, `queued bytes exceeded one snapshot plus the queue allowance: ${accepted.writableLength}`);
    const resynced = new Promise<void>((resolve, reject) => {
      cancelResync = () => reject(t.signal.reason);
      t.signal.addEventListener("abort", cancelResync, { once: true });
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
    t.signal.removeEventListener("abort", cancelResync);
    client.destroy(); accepted.destroy(); queries.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await model.close(); rmSync(root, { recursive: true, force: true }); rmSync(transport, { recursive: true, force: true });
  }
});

test("pending recipient query retains old terminal obligations with scoped bounded pages", async () => {
  const root = fixtureRoot("pending-recipient");
  const runs = join(root, "runs"); mkdirSync(runs);
  for (let i = 0; i < 205; i++) {
    const id = `sa_owed_${i}`; mkdirSync(join(runs, id));
    writeFileSync(join(runs, id, "meta.json"), JSON.stringify({ id, sessionId: id, cwd: root,
      callbackOrigin: { cwd: root, sessionId: i === 204 ? "foreign" : "parent" }, status: "completed",
      startedAt: i, endedAt: 1, callback: true, completionCallbackPendingAt: 1,
      ...(i === 203 ? { completionCallbackSentAt: 2 } : {}) }));
  }
  const model = new WorkReadModel(root, "pending-instance", { baseDir: root, durableDir: join(root, "durable"), intervalMs: 60000 });
  try {
    await model.reconcile();
    assert.equal(model.snapshot({ cwd: root, sessionId: "parent", active: false, endedAfter: Date.now() - 30000 }).rows.length, 0);
    const scope = { cwd: root, sessionId: "parent", pendingRecipient: true, limit: 200 };
    const before = { ...model.metrics };
    const first = model.snapshot(scope);
    assert.equal(first.totalMatching, 203); assert.equal(first.rows.length, 200); assert.ok(first.nextCursor);
    const second = model.snapshot({ ...scope, cursor: first.nextCursor });
    assert.equal(second.rows.length, 3); assert.equal(second.nextCursor, undefined);
    assert.equal(new Set([...first.rows, ...second.rows].map(row => row.meta.id)).size, 203);
    assert.throws(() => model.snapshot({ pendingRecipient: true }), /exact conversation/);
    for (let i = 0; i < 10; i++) model.snapshot(scope);
    assert.equal(model.metrics.metadataReads, before.metadataReads);
    assert.equal(model.metrics.projections, before.projections);
  } finally { await model.close(); rmSync(root, { recursive: true, force: true }); }
});


test("old handled terminal records re-enter pending scope for new failure journal attention", async () => {
  const root = fixtureRoot("pending-failure");
  const id = "sa_old_lost", directory = join(root, "runs", id); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "meta.json"), JSON.stringify({ id, sessionId: id, cwd: root,
    callbackOrigin: { cwd: root, sessionId: "parent" }, status: "lost", startedAt: 1, endedAt: 2,
    lostCallbackSentAt: 3, completionCallbackSentAt: 3, callback: true }));
  const model = new WorkReadModel(root, "failure-instance", { baseDir: root, durableDir: join(root, "durable"), intervalMs: 60000 });
  const scope = { cwd: root, sessionId: "parent", pendingRecipient: true };
  const record = { observedAt: 4, event: { id: "late-gap", operation: "child-log", kind: "incomplete", summary: "Late observation gap" } };
  try {
    await model.reconcile(); assert.equal(model.snapshot(scope).rows.length, 0);
    writeFileSync(join(directory, "failures.jsonl"), JSON.stringify(record) + "\n");
    await model.reconcile();
    assert.equal(model.snapshot(scope).rows[0]?.meta.id, id);
    const counters = { ...model.metrics };
    for (let i = 0; i < 10; i++) assert.equal(model.snapshot(scope).rows.length, 1);
    assert.equal(model.metrics.projections, counters.projections);
    writeFileSync(join(directory, "failures.jsonl"), JSON.stringify(record) + "\n" + JSON.stringify({ observedAt: 5, event: { id: "receipt", operation: "attention-delivery", kind: "delivered", incidents: ["late-gap"] } }) + "\n");
    await model.reconcile(); assert.equal(model.snapshot(scope).rows.length, 0);
  } finally { await model.close(); rmSync(root, { recursive: true, force: true }); }
});
