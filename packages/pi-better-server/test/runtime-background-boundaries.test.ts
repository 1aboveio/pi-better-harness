import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Socket } from "node:net";
import { BackgroundObservation } from "../src/runtime/background.ts";
import { WorkQueryExecutor } from "../src/runtime/query-executor.ts";
import { WorkReadModel } from "../src/runtime/read-model.ts";
import { workScope } from "../src/runtime/queries.ts";
const { openStore } = await import(new URL("../../operation-coordinator/index.ts", import.meta.url).href);
const { writeMeta, taskDir } = await import(new URL("../../pi-better-background-tasks/src/registry.ts", import.meta.url).href);
const { formatList } = await import(new URL("../../pi-better-background-tasks/src/output.ts", import.meta.url).href);

test("Background history queries observe work completed between shared active refreshes", { timeout: 15000 }, async () => {
  const root = mkdtempSync("/tmp/p754-history-");
  const writer = openStore({ path: join(root, "operation-coordinator.sqlite") });
  const executor = new WorkQueryExecutor(root, "history-instance", {
    modelOptions: { baseDir: join(root, "subagents"), durableDir: join(root, "archives"), intervalMs: 50 },
  });
  const socket = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0, write: (_line: string): boolean => true });
  const client = executor.connect(socket as unknown as Socket);
  const scope = { background: true, backgroundHistory: true, cwd: root, sessionId: "parent" };
  const read = async () => {
    const deadline = Date.now() + 10000;
    for (;;) {
      const snapshot = JSON.parse((await client.handle({ type: "runtime_get_snapshot", scope })).json);
      if (snapshot.status !== "rebuilding") return snapshot;
      assert.ok(Date.now() < deadline, "history index did not recover");
      await delay(20);
    }
  };
  try {
    await read(); await delay(200);
    assert.equal((await read()).rows.length, 0);
    const owner = { kind: "parent-session", sessionId: "parent", workspace: root };
    writer.registerOperation({ operationId: "history-op", taskId: "bgs_00000000000000000000", launchToken: "history-token",
      owner, observer: { kind: "local-supervisor", version: "1" } });
    writer.recordTerminalOutcome({ operationId: "history-op", eventId: "history-complete", owner,
      outcome: "succeeded", evidence: [{ kind: "terminal-record", ref: "history-complete" }] });
    await delay(200);
    const history = await read();
    assert.equal(history.rows.length, 1, "a warmed history scope must include a newly completed operation");
    assert.equal(history.rows[0].meta.status, "succeeded");
    const beforeWait = JSON.parse((await client.handle({ type: "runtime_get_metrics" })).json).background.history;
    const events: any[] = [];
    socket.write = (line: string) => { events.push(JSON.parse(line)); return true; };
    await client.handle({ type: "runtime_subscribe", scope });
    writer.registerWait({ waitId: "terminal-wait", owner, dependencies: [{ operationId: "history-op" }], continuationNote: "Read terminal evidence" });
    const deadline = Date.now() + 5000;
    while (!events.some(event => event.event?.snapshot?.status === "ready" && event.event.snapshot.rows[0]?.meta.waits[0]?.waitId === "terminal-wait")) {
      assert.ok(Date.now() < deadline, "coordinator-only terminal history changes did not notify the subscriber"); await delay(20);
    }
    assert.equal((await read()).rows[0].meta.waits[0].waitId, "terminal-wait", "waits added after completion invalidate the indexed projection");
    const afterWait = JSON.parse((await client.handle({ type: "runtime_get_metrics" })).json).background.history;
    assert.equal(afterWait.inventories, beforeWait.inventories, "a dependent wait updates history without restarting its baseline");
    assert.ok(afterWait.incrementalBatches > beforeWait.incrementalBatches);
  } finally {
    client.close(); await executor.close(); writer.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("Background fences replaced or removed coordinator connections", () => {
  const root = mkdtempSync("/tmp/p754-source-");
  const path = join(root, "operation-coordinator.sqlite");
  const writer = openStore({ path });
  writer.registerOperation({ operationId: "old-op", taskId: "bgs_00000000000000000001", launchToken: "old-token",
    owner: { kind: "parent-session", sessionId: "parent", workspace: root }, observer: { kind: "local-supervisor", version: "1" } });
  writer.close();
  const observation = new BackgroundObservation(root);
  try {
    assert.equal(observation.read({ cwd: root, sessionId: "parent" }).length, 1);
    assert.equal(observation.status, "ready");
    const replacement = join(root, "replacement.sqlite");
    openStore({ path: replacement }).close();
    renameSync(replacement, path);
    observation.refresh();
    assert.equal(observation.read({ cwd: root, sessionId: "parent" }).length, 0, "replacement facts must supersede the retained database");
    unlinkSync(path);
    observation.refresh();
    assert.equal(observation.status, "degraded");
    observation.refresh();
    assert.equal(observation.status, "degraded", "missing known authority cannot become a healthy empty source on retry");
    openStore({ path }).close();
    observation.refresh();
    assert.equal(observation.status, "ready");
  } finally { observation.close(); rmSync(root, { recursive: true, force: true }); }
});

test("one-shot Background origins have a fixed retained-scope budget", () => {
  const root = mkdtempSync("/tmp/p754-scopes-");
  const observation = new BackgroundObservation(root);
  try {
    const key = JSON.stringify([root, "subscribed-parent"]);
    const release = observation.retain({ cwd: root, sessionId: "subscribed-parent" });
    for (let i = 0; i < 500; i++) observation.read({ cwd: root, sessionId: `session-${i}` });
    const scopes = (observation as unknown as { legacy: Map<string, unknown> }).legacy;
    assert.ok(scopes.size <= 128, "past sessions must not accumulate permanent polling work");
    assert.ok(scopes.has(key), "a live subscription keeps its observation while one-shot scopes churn");
    release(); release();
    for (let i = 500; i < 700; i++) observation.read({ cwd: root, sessionId: `session-${i}` });
    assert.equal(scopes.has(key), false, "disconnect releases the scope for bounded eviction");
  } finally { observation.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Background history applies bounded pages, status filters and stable cursors in the worker", { timeout: 30000 }, async () => {
  const root = mkdtempSync("/tmp/p754-pages-");
  const writer = openStore({ path: join(root, "operation-coordinator.sqlite") });
  let executor: WorkQueryExecutor | undefined;
  let client: ReturnType<WorkQueryExecutor["connect"]> | undefined;
  const scope = { background: true, backgroundHistory: true, cwd: root, sessionId: "parent", limit: 3, statuses: ["succeeded"] };
  const read = async (cursor?: string) => {
    const deadline = Date.now() + 20000;
    for (;;) {
      const page = JSON.parse((await client!.handle({ type: "runtime_get_snapshot", scope: { ...scope, cursor } })).json);
      if (page.status !== "rebuilding") return page;
      assert.ok(Date.now() < deadline, "history index did not recover");
      await delay(20);
    }
  };
  try {
    const owner = { kind: "parent-session", sessionId: "parent", workspace: root };
    for (let i = 0; i < 1200; i++) {
      const operationId = `page-op-${i}`;
      writer.registerOperation({ operationId, taskId: `bgs_${i.toString(16).padStart(20, "0")}`, launchToken: operationId,
        owner, observer: { kind: "local-supervisor", version: "1" } });
      writer.recordTerminalOutcome({ operationId, eventId: operationId, owner, outcome: "succeeded",
        evidence: [{ kind: "terminal-record", ref: operationId }] });
    }
    // Synchronous fixture writes must finish before the parent must service
    // worker heartbeats; this test measures indexed reads, not fixture setup.
    executor = new WorkQueryExecutor(root, "page-instance", {
      modelOptions: { baseDir: join(root, "subagents"), durableDir: join(root, "archives"), intervalMs: 50 },
    });
    const socket = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0, write: () => true });
    client = executor.connect(socket as unknown as Socket);
    const first = await read();
    assert.equal(first.rows.length, 3);
    assert.equal(first.totalMatching, 1200);
    assert.ok(first.nextCursor);
    assert.ok((first.backgroundIndex?.records.length ?? 0) <= 4, "the response cannot carry a hidden full-history metadata array");
    const next = await read(first.nextCursor);
    assert.equal(next.rows.length, 3);
    assert.ok(next.rows.every((row: any) => !first.rows.some((previous: any) => previous.meta.id === row.meta.id)));
    writer.registerOperation({ operationId: "new-active", taskId: "bgs_ffffffffffffffffffff", launchToken: "new-active", owner,
      observer: { kind: "local-supervisor", version: "1" } });
    const active = await read();
    assert.equal(active.totalMatching, 1200);
    assert.equal(active.activity.active, 1);
    assert.notEqual(active.scopeRevision, first.scopeRevision, "independent activity participates in a filtered history revision");
    const metrics = JSON.parse((await client.handle({ type: "runtime_get_metrics" })).json);
    assert.equal(metrics.sqlite.active, 1, "history composes its coordinator reader on the sole derived handle");
    assert.equal(metrics.sqlite.maximum, 1);
    assert.equal(metrics.coordinatorConnections, 1);
    assert.equal(metrics.indexConnections, 1);
    assert.equal(metrics.executor.restarts, 0, "indexed history does not restart the read worker");
  } finally {
    client?.close(); await executor?.close(); writer.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("Background indexed pages merge legacy rows and fence cursors and off-page incidents", { timeout: 15000 }, async t => {
  const root = mkdtempSync("/tmp/p754-mixed-");
  const writer = openStore({ path: join(root, "operation-coordinator.sqlite") });
  const executor = new WorkQueryExecutor(root, "mixed-instance", {
    workerUrl: new URL("./support/history-metadata-evidence-worker.mjs", import.meta.url),
    modelOptions: { baseDir: join(root, "subagents"), durableDir: join(root, "archives"), intervalMs: 50 } });
  const socket = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0, write: (_line: string): boolean => true });
  const client = executor.connect(socket as unknown as Socket);
  const scope = { background: true, backgroundHistory: true, cwd: root, sessionId: "parent", limit: 2, statuses: ["succeeded"] };
  const origin = { cwd: root, sessionId: "parent" };
  const ids = ["bg_754_owned_1", "bg_754_owned_2", "bg_754_foreign", "bg_754_sessionless_own", "bg_754_sessionless_foreign", "bg_754_sessionless_foreign_2"];
  const read = async (changes: object = {}) => {
    const deadline = Date.now() + 10000;
    for (;;) {
      const page = JSON.parse((await client.handle({ type: "runtime_get_snapshot", scope: { ...scope, ...changes } })).json);
      if (page.status !== "rebuilding") { assert.equal(page.status, "ready", page.reason); return page; }
      assert.ok(Date.now() < deadline); await delay(20);
    }
  };
  try {
    const owner = { kind: "parent-session", workspace: root, sessionId: "parent" };
    for (let i = 0; i < 2; i++) {
      const operationId = `mixed-${i}`;
      writer.registerOperation({ operationId, taskId: `bgs_${(i + 3000).toString(16).padStart(20, "0")}`, launchToken: operationId,
        owner, observer: { kind: "local-supervisor", version: "1" } });
      writer.recordTerminalOutcome({ operationId, eventId: operationId, owner, outcome: "succeeded", evidence: [{ kind: "terminal-record", ref: operationId }] });
    }
    ids.slice(0, 3).forEach((id, i) => writeMeta({ id, status: "succeeded", kind: "process", startedAt: 1000 + i, endedAt: 2000 + i,
      logPath: join(taskDir(id), "output.log"), cwd: root, callbackOrigin: { ...origin, sessionId: i === 2 ? "foreign" : "parent" } }));
    ids.slice(3).forEach((id, i) => writeMeta({ id, status: "succeeded", kind: "process", startedAt: 5000 - i, endedAt: 6000 + i,
      logPath: join(taskDir(id), "output.log"), cwd: root, callbackOrigin: { cwd: root }, spawnPid: process.pid + (i ? 1 : 0) }));
    const first = await read();
    assert.equal(first.totalMatching, 4);
    assert.equal(first.rows.length, 2);
    const second = await read({ cursor: first.nextCursor });
    assert.deepEqual(second.rows.map((row: any) => row.meta.id), [ids[1], ids[0]]);
    assert.equal(second.nextCursor, undefined);
    const text = formatList({ origin, limit: 2, statuses: ["succeeded"], maxBytes: 600 }, first.backgroundIndex);
    assert.match(text, /4 background tasks/);
    assert.ok(Buffer.byteLength(text) <= 600);
    const statusCursor = text.match(/statusCursor=(\S+)/)![1];
    const stable = await read({ cursor: statusCursor });
    assert.equal((await read({ cursor: statusCursor })).seq, stable.seq, "unchanged reads do not advance the shared revision");
    assert.match(formatList({ origin, limit: 2, statuses: ["succeeded"], cursor: statusCursor }, stable.backgroundIndex), /unchanged/);
    appendFileSync(join(taskDir(ids[0]), "failures.jsonl"), '{"id":"new-incident","operation":"test","kind":"failure","summary":"off-page failure"}\n');
    await delay(1100);
    const changed = await read({ cursor: statusCursor });
    assert.notEqual(changed.scopeRevision, stable.scopeRevision, "off-page facts participate in the public scope revision");
    const changedText = formatList({ origin, limit: 2, statuses: ["succeeded"], cursor: statusCursor }, changed.backgroundIndex);
    assert.doesNotMatch(changedText, /unchanged/);
    assert.match(changedText, /change=failure/);
    const foreign = await read({ sessionId: "foreign", cursor: first.nextCursor });
    assert.equal(foreign.totalMatching, 1);
    assert.equal(foreign.rows[0].meta.id, ids[2]);
    const sessionless = await read({ sessionId: undefined, processId: process.pid, limit: 1 });
    assert.equal(sessionless.totalMatching, 1);
    assert.equal(sessionless.rows[0].meta.id, ids[3], "a newer foreign process cannot consume the only visible slot");
    const otherProcess = await read({ sessionId: undefined, processId: process.pid + 1, limit: 1 });
    assert.ok(otherProcess.nextCursor);
    const crossProcess = await read({ sessionId: undefined, processId: process.pid, limit: 1, cursor: otherProcess.nextCursor });
    assert.equal(crossProcess.rows[0].meta.id, ids[3], "another process's cursor must reset instead of skipping owned rows");
    const events: any[] = [];
    socket.write = (line: any) => { events.push(JSON.parse(line)); return true; };
    await client.handle({ type: "runtime_subscribe", scope });
    writeMeta({ id: ids[0], status: "succeeded", kind: "process", startedAt: 1000, endedAt: 2000, name: "changed-without-get",
      logPath: join(taskDir(ids[0]), "output.log"), cwd: root, callbackOrigin: origin });
    const deadline = Date.now() + 10000;
    while (!events.some(event => event.event?.snapshot?.status === "ready" && event.event.snapshot.backgroundIndex.page.contentRevision !== changed.backgroundIndex.page.contentRevision)) {
      assert.ok(Date.now() < deadline, "a completed-history subscriber was not notified"); await delay(20);
    }
    const metrics = JSON.parse((await client.handle({ type: "runtime_get_metrics" })).json);
    if (metrics.background.history.metadataReads !== 7) {
      try { t.diagnostic(JSON.stringify({ mixedHistoryReadFailure: { metadataReads: metrics.background.history.metadataReads,
        reads: metrics.historyMetadataEvidence } }).slice(0, 8192)); } catch {}
    }
    assert.equal(metrics.background.history.metadataReads, 7, "six initial records and one changed record are the only legacy metadata reads");
  } finally {
    client.close(); await executor.close(); writer.close();
    for (const id of ids) rmSync(taskDir(id), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("an off-page failure hint cannot publish ready before its queued projection runs", { timeout: 15000 }, async () => {
  const root = mkdtempSync("/tmp/p754-offpage-boundary-");
  const baseDir = join(root, "raw");
  const model = new WorkReadModel(root, "offpage-boundary", { baseDir, durableDir: join(root, "archive"), intervalMs: 60000 });
  const ids = ["bg_boundary_old", "bg_boundary_middle", "bg_boundary_new"];
  const scope = { background: true, backgroundHistory: true, cwd: root, sessionId: "parent", limit: 1 };
  let history: any, refresh: any;
  const drain = async () => {
    const deadline = Date.now() + 10000;
    for (;;) {
      const value = model.snapshot(scope);
      if (value.status === "ready") return value;
      assert.ok(Date.now() < deadline, value.reason);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  };
  try {
    ids.forEach((id, i) => writeMeta({ id, status: "succeeded", kind: "process", startedAt: i + 1, endedAt: i + 2,
      logPath: join(taskDir(id), "output.log"), cwd: root, callbackOrigin: { cwd: root, sessionId: "parent" } }));
    await model.reconcile();
    const stable = await drain();
    const foreign = model.snapshot({ ...scope, sessionId: "foreign" });
    assert.deepEqual(stable.rows.map(row => row.meta.id), [ids[2]]);
    history = (model as any).background.history;
    refresh = history.startRefresh;
    let held = false;
    history.startRefresh = () => { held = true; };
    const before = history.db.prepare("SELECT failure FROM background_history WHERE key=?").get(`l:${ids[0]}`).failure;
    appendFileSync(join(taskDir(ids[0]), "failures.jsonl"), '{"id":"boundary-incident","operation":"test","kind":"failure","summary":"off-page failure"}\n');
    // Deliver the real file's notification at a controlled point, independently
    // of OS event coalescing. The production watcher callback queues the work.
    const watcher = history.watchers.get(join(taskDir(ids[0]), "../.."));
    assert.ok(watcher);
    watcher.emit("change", "change", `tasks/${ids[0]}/failures.jsonl`);
    const deadline = Date.now() + 10000;
    while (!held) {
      assert.ok(Date.now() < deadline, "off-page notification did not schedule its projection");
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.ok(history.dirtyLegacy.has(ids[0]), "the exact off-page ID remains owed while refresh is held");
    // Run real source work while the already-notified history projection is held.
    const directory = join(baseDir, "runs", "sa_boundary_source");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "meta.json"), JSON.stringify({ id: "sa_boundary_source", cwd: root, sessionId: "worker", status: "completed", startedAt: 1 }));
    await model.reconcile();
    assert.equal(history.db.prepare("SELECT failure FROM background_history WHERE key=?").get(`l:${ids[0]}`).failure, before);
    assert.equal(model.snapshot(scope).status, "rebuilding", "queued off-page facts must fence ready publication before the scheduled refresh starts");
    history.startRefresh = refresh;
    refresh.call(history);
    const changed = await drain();
    assert.notEqual(changed.scopeRevision, stable.scopeRevision, "the actual off-page failure changes the public scope revision");
    assert.notEqual(changed.backgroundIndex.page.failureRevision, stable.backgroundIndex.page.failureRevision);
    assert.equal(changed.backgroundIndex.page.contentRevision, stable.backgroundIndex.page.contentRevision);
    const unchanged = model.snapshot({ ...scope, sessionId: "foreign" });
    assert.equal(unchanged.rows.length, 0);
    assert.equal(unchanged.scopeRevision, foreign.scopeRevision, "off-page failure revisions stay within the owning scope");
  } finally {
    if (history && refresh) history.startRefresh = refresh;
    await model.close();
    for (const id of ids) rmSync(taskDir(id), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("Background status filters accept runner states independently of Subagent states", () => {
  assert.deepEqual(workScope({ background: true, statuses: ["starting", "lost"] }).statuses, ["starting", "lost"]);
  assert.throws(() => workScope({ statuses: ["starting"] }), /status filter/);
  const origin = { cwd: "/tmp/p754-states", sessionId: "parent" };
  const text = formatList({ origin, statuses: ["running"], limit: 1 }, { records: [{ id: "starting-task", found: true, readable: true,
    meta: { id: "starting-task", durable: true, active: true, status: "starting", callbackOrigin: origin, kind: "process", startedAt: 1000 } }] } as any);
  assert.match(text, /starting-task starting/);
});

test("shared Background discovery bounds visible terminals independently of old callback obligations", async () => {
  const root = mkdtempSync("/tmp/p751-bg-pending-");
  let now = Date.now() - 60000;
  const writer = openStore({ path: join(root, "operation-coordinator.sqlite"), now: () => now });
  const observation = new BackgroundObservation(root);
  const owner = { kind: "parent-session", sessionId: "owed-parent", workspace: root };
  const taskId = (id: string) => `bgs_${createHash("sha256").update(id).digest("hex").slice(0, 20)}`;
  const terminal = (operationId: string, pending: boolean, recipient = owner) => {
    writer.registerOperation({ operationId, taskId: taskId(operationId), launchToken: operationId,
      owner: recipient, observer: { kind: "local-supervisor", version: "1" } });
    writer.setParentCallbackPending(taskId(operationId), pending);
    writer.recordTerminalOutcome({ operationId, eventId: operationId, owner: recipient, outcome: "succeeded",
      evidence: [{ kind: "terminal-record", ref: operationId }] });
  };
  try {
    terminal("old-owed", true);
    terminal("old-disabled", false);
    terminal("foreign-owed", true, { ...owner, sessionId: "foreign" });
    for (let index = 0; index < 300; index++) terminal(`old-pending-${String(index).padStart(4, "0")}`, true);
    now = Date.now();
    // All finish before the first shared observation, including a second page.
    for (let index = 0; index < 300; index++) terminal(`recent-${String(index).padStart(4, "0")}`, false);
    observation.read({ background: true, cwd: root, sessionId: owner.sessionId });
    for (let page = 0; page < 4; page++) observation.refresh();
    const rows = observation.read({ background: true, cwd: root, sessionId: owner.sessionId });
    assert.equal(rows.filter((row: any) => row.operationId.startsWith("recent-")).length, 256);
    assert.ok(rows.some((row: any) => row.operationId === "recent-0299"), "newest fast completion is discovered without observing it running");
    assert.equal(rows.filter((row: any) => row.callbackPending).length, 256, "visible pointers cannot expand to the full obligation backlog");
    assert.ok(rows.some((row: any) => row.operationId === "old-owed" && row.callbackPending));
    assert.ok(!rows.some((row: any) => row.operationId === "old-disabled" || row.operationId === "foreign-owed"));
    writer.setParentCallbackPending(taskId("old-owed"), false);
    for (let page = 0; page < 4; page++) observation.refresh();
    assert.ok(!observation.read({ background: true, cwd: root, sessionId: owner.sessionId }).some((row: any) => row.operationId === "old-owed"));
  } finally { await observation.close(); writer.close(); rmSync(root, { recursive: true, force: true }); }
});


test("pending callback backlog exceeding the wire allowance stays compact without sidecar reads", async () => {
  const root = mkdtempSync("/tmp/p751-bg-large-pending-");
  const directory = join(root, "supervisor"), owner = { kind: "parent-session", sessionId: "parent", workspace: root };
  const writer = openStore({ path: join(root, "operation-coordinator.sqlite"), now: () => Date.now() - 60000 });
  const observation = new BackgroundObservation(root, directory);
  mkdirSync(join(directory, "observed"), { recursive: true });
  try {
    for (let i = 0; i < 600; i++) {
      const operationId = `pending-${String(i).padStart(4, "0")}`, taskId = `bgs_${i.toString(16).padStart(20, "0")}`;
      writer.registerOperation({ operationId, taskId, launchToken: operationId, owner, observer: { kind: "local-supervisor", version: "1" } });
      writer.recordTerminalOutcome({ operationId, eventId: operationId, owner, outcome: "succeeded", evidence: [{ kind: "terminal-record", ref: operationId }] });
      writeFileSync(join(directory, "observed", `${taskId}.json`), JSON.stringify({ command: "x".repeat(8192), callback: false }));
    }
    const scope = { background: true, cwd: root, sessionId: owner.sessionId };
    const initial = observation.read(scope);
    assert.equal(initial.length, 256);
    assert.ok(Buffer.byteLength(JSON.stringify(initial)) < 256 * 1024);
    assert.equal(observation.metrics.runnerSnapshots, 0, "pending pointers never inspect runner or sidecar payloads");
    for (let i = 0; i < 10; i++) observation.refresh();
    assert.deepEqual(observation.read(scope), initial, "unchanged observations neither accumulate pages nor churn visible membership");
    for (const row of initial) writer.setParentCallbackPending(row.id, false);
    observation.refresh();
    const next = observation.read(scope);
    assert.equal(next.length, 256);
    assert.ok(next.every((row: any) => !initial.some((old: any) => old.id === row.id)), "manager pruning advances visible pointers without requiring full backlog projection");
    assert.equal(observation.metrics.runnerSnapshots, 0);
  } finally { await observation.close(); writer.close(); rmSync(root, { recursive: true, force: true }); }
});

test("recent terminal cache follows atomic sidecar changes without timed rereads or foreign-scope crowding", async () => {
  const root = mkdtempSync("/tmp/p751-bg-terminal-cache-"), directory = join(root, "supervisor");
  let now = Date.now();
  const writer = openStore({ path: join(root, "operation-coordinator.sqlite"), now: () => now });
  const observation = new BackgroundObservation(root, directory);
  const owner = { kind: "parent-session", sessionId: "parent", workspace: root };
  mkdirSync(join(directory, "observed"), { recursive: true });
  try {
    for (let i = 0; i < 300; i++) {
      const operationId = `cache-${i}`, taskId = `bgs_${i.toString(16).padStart(20, "0")}`, recipient = i ? { ...owner, sessionId: "foreign" } : owner;
      writer.registerOperation({ operationId, taskId, launchToken: operationId, owner: recipient, observer: { kind: "local-supervisor", version: "1" } });
      writer.recordTerminalOutcome({ operationId, eventId: operationId, owner: recipient, outcome: "succeeded", evidence: [{ kind: "terminal-record", ref: operationId }] });
      writer.setParentCallbackPending(taskId, false);
      now++;
    }
    const path = join(directory, "observed", "bgs_00000000000000000000.json");
    writeFileSync(path, JSON.stringify({ name: "original" }));
    const scope = { background: true, cwd: root, sessionId: owner.sessionId };
    assert.equal(observation.read(scope)[0]?.name, "original", "foreign completions cannot crowd the exact owner's recent window");
    observation.refresh();
    const snapshots = observation.metrics.runnerSnapshots;
    await delay(1100);
    observation.refresh();
    assert.equal(observation.metrics.runnerSnapshots, snapshots, "unchanged terminal projections have no periodic expiry");
    writeFileSync(`${path}.tmp`, JSON.stringify({ name: "changed" }));
    renameSync(`${path}.tmp`, path);
    observation.refresh();
    assert.equal(observation.read(scope)[0]?.name, "changed", "atomic sidecar replacement invalidates the cached projection");
  } finally { await observation.close(); writer.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a malformed observed sidecar does not block scoped Background history or its repair", async () => {
  const root = mkdtempSync("/tmp/bg-history-gap-"), directory = join(root, "supervisor");
  const writer = openStore({ path: join(root, "operation-coordinator.sqlite"), now: () => Date.now() - 60000 });
  const sessions = ["requested", "other"];
  const ids = sessions.map((_, i) => "bgs_" + String(i + 1).padStart(20, "0"));
  mkdirSync(join(directory, "observed"), { recursive: true });
  const damaged = join(directory, "observed", ids[1] + ".json");
  writeFileSync(damaged, '{"name":"old"}trailing bytes');
  for (const [i, sessionId] of sessions.entries()) {
    const owner = { kind: "parent-session", workspace: root, sessionId };
    writer.registerOperation({ operationId: ids[i], taskId: ids[i], launchToken: ids[i], owner, observer: { kind: "local-supervisor", version: "1" } });
    writer.recordTerminalOutcome({ operationId: ids[i], eventId: ids[i], owner, outcome: "succeeded", evidence: [{ kind: "terminal-record", ref: ids[i] }] });
  }
  const model = new WorkReadModel(root, "history-gap", { supervisorDirectory: directory, baseDir: join(root, "runs"), durableDir: join(root, "archives") });
  const read = async (sessionId: string, expected: number, backgroundAll = false) => {
    const scope = { cwd: root, sessionId, background: true, backgroundHistory: true, backgroundAll, limit: 3 };
    const end = Date.now() + 3000;
    for (;;) {
      const page = model.snapshot(scope);
      if (page.status === "ready" && page.rows.length === expected) return page;
      assert.ok(Date.now() < end, String(page.reason ?? page.status)); await delay(20);
    }
  };
  try {
    await model.reconcile();
    assert.equal((await read("requested", 1)).backgroundIndex.page.unreadable, 0);
    assert.equal((await read("other", 0)).backgroundIndex.page.unreadable, 1);
    assert.equal((await read("requested", 1, true)).backgroundIndex.page.unreadable, 1);
    writeFileSync(damaged, '{"name":"repaired"}');
    const recovered = await read("other", 1);
    assert.equal(recovered.backgroundIndex.page.unreadable, 0);
    assert.equal(recovered.rows[0]?.meta?.name, "repaired");
  } finally { await model.close(); writer.close(); rmSync(root, { recursive: true, force: true }); }
});
