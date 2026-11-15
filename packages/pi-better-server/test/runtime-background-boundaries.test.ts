import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdtempSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Socket } from "node:net";
import { BackgroundObservation } from "../src/runtime/background.ts";
import { WorkQueryExecutor } from "../src/runtime/query-executor.ts";
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
    const events: any[] = [];
    socket.write = (line: string) => { events.push(JSON.parse(line)); return true; };
    await client.handle({ type: "runtime_subscribe", scope });
    writer.registerWait({ waitId: "terminal-wait", owner, dependencies: [{ operationId: "history-op" }], continuationNote: "Read terminal evidence" });
    const deadline = Date.now() + 5000;
    while (!events.some(event => event.event?.snapshot?.status === "ready" && event.event.snapshot.rows[0]?.meta.waits[0]?.waitId === "terminal-wait")) {
      assert.ok(Date.now() < deadline, "coordinator-only terminal history changes did not notify the subscriber"); await delay(20);
    }
    assert.equal((await read()).rows[0].meta.waits[0].waitId, "terminal-wait", "waits added after completion invalidate the indexed projection");
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
  const executor = new WorkQueryExecutor(root, "page-instance", {
    modelOptions: { baseDir: join(root, "subagents"), durableDir: join(root, "archives"), intervalMs: 50 },
  });
  const socket = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0, write: () => true });
  const client = executor.connect(socket as unknown as Socket);
  const scope = { background: true, backgroundHistory: true, cwd: root, sessionId: "parent", limit: 3, statuses: ["succeeded"] };
  const read = async (cursor?: string) => {
    const deadline = Date.now() + 20000;
    for (;;) {
      const page = JSON.parse((await client.handle({ type: "runtime_get_snapshot", scope: { ...scope, cursor } })).json);
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
    const before = (await client.handle({ type: "runtime_get_metrics" })).json;
    assert.ok(JSON.parse(before).sqlite.active <= 3, "history reuses the worker's derived index and two coordinator readers");
  } finally {
    client.close(); await executor.close(); writer.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("Background indexed pages merge legacy rows and fence cursors and off-page incidents", { timeout: 15000 }, async () => {
  const root = mkdtempSync("/tmp/p754-mixed-");
  const writer = openStore({ path: join(root, "operation-coordinator.sqlite") });
  const executor = new WorkQueryExecutor(root, "mixed-instance", { modelOptions: { baseDir: join(root, "subagents"), durableDir: join(root, "archives"), intervalMs: 50 } });
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
    assert.equal(metrics.background.history.metadataReads, 7, "six initial records and one changed record are the only legacy metadata reads");
  } finally {
    client.close(); await executor.close(); writer.close();
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
