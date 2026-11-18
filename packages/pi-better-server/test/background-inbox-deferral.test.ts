import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireMutationStore } from "../src/runtime/mutation-store.ts";
import { WorkReadModel } from "../src/runtime/read-model.ts";
import { WorkQueries } from "../src/runtime/queries.ts";
import { BackgroundObservation } from "../src/runtime/background.ts";
import { LogCheckpoints, isSqliteLockContention } from "../src/runtime/log-checkpoints.ts";

const watch = (() => Object.assign(new EventEmitter(), { close() {}, ready: Promise.resolve() })) as any;
const aliases = (db: any) => db.prepare("PRAGMA database_list").all().map((row: any) => row.name);

test("exclusive Background inbox defers all consumers on two application handles until the next repair opportunity", async t => {
  const sqlite = createRequire(import.meta.url)("node:sqlite"), Original = sqlite.DatabaseSync;
  const live = new Set<any>();
  let maximum = 0;
  sqlite.DatabaseSync = class extends Original {
    constructor(...args: any[]) { super(...args); live.add(this); maximum = Math.max(maximum, live.size); }
    prepare(sql: string) {
      if (/^ATTACH\b/i.test(sql)) assert.equal(this.isTransaction, false);
      return super.prepare(sql);
    }
    close() { super.close(); live.delete(this); }
  };
  const root = mkdtempSync(join(tmpdir(), "background-inbox-deferred-"));
  t.after(() => { for (const db of live) db.close(); sqlite.DatabaseSync = Original; rmSync(root, { recursive: true, force: true }); });
  const mutation = acquireMutationStore(root);
  const owner = { kind: "parent-session" as const, sessionId: "parent", workspace: root };
  mutation.store.registerOperation({ operationId: "operation", taskId: "bgs_0123456789abcdef0123", launchToken: "token", owner,
    observer: { kind: "local-supervisor", version: "1" } });
  const options = { baseDir: join(root, "raw"), durableDir: join(root, "archive"), supervisorDirectory: join(root, "supervisor"), intervalMs: 1000, watch };
  const scope = { background: true, cwd: root, sessionId: "parent" };
  const seed = new WorkReadModel(root, "seed", options);
  try { await seed.reconcile(); assert.equal(seed.snapshot(scope).status, "ready"); }
  finally { await seed.close(); }
  const writer = new sqlite.DatabaseSync(join(root, "runtime-read-repair", "background.sqlite"));
  const before = writer.prepare("SELECT * FROM position").get();
  const repair = writer.prepare("SELECT * FROM background_file_repair").get();
  writer.exec("BEGIN EXCLUSIVE");
  t.mock.timers.enable({ apis: ["setInterval"] });
  let model: WorkReadModel | undefined, queries: WorkQueries | undefined;
  try {
    assert.doesNotThrow(() => { model = new WorkReadModel(root, "contended", options); });
    const current = model!, db = (current as any).db, background = (current as any).background;
    const frames: any[] = [];
    const socket = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0,
      write(line: string) { frames.push(JSON.parse(line)); }, destroy() {} });
    queries = new WorkQueries(current, socket as any);
    await Promise.all(Array.from({ length: 32 }, () => current.reconcile()));
    mutation.store.recordTerminalOutcome({ operationId: "operation", eventId: "terminal", owner, outcome: "succeeded", evidence: [{ kind: "terminal-record", ref: "result" }] });
    for (let tick = 0; tick < 3; tick++) {
      const began = performance.now();
      const attempts = current.metrics.initialization.attempts;
      mutation.store.cancellationRuntimeEpoch(`control-${tick}`);
      current.fileHint(current.runs, "sa_hint");
      await Promise.all(Array.from({ length: 32 }, () => current.reconcile()));
      for (const requested of [{}, scope, { ...scope, backgroundHistory: true }]) {
        assert.equal((queries.handle({ type: "runtime_subscribe", scope: requested }) as any).status, "rebuilding");
        assert.equal((queries.handle({ type: "runtime_get_snapshot", scope: requested }) as any).status, "rebuilding");
        queries.handle({ type: "runtime_unsubscribe" });
      }
      const release = background.retain(scope); release();
      assert.deepEqual(background.read(scope), []);
      assert.equal(background.refresh(), false);
      assert.throws(() => background.livenessReasons(), /unverified/);
      assert.throws(() => background.historyIndex(scope), /unverified/);
      assert.equal(background.changeMetrics.applied, null);
      assert.equal(background.changeMetrics.repairAfter, null);
      assert.equal(background.historyMetrics.inventories, 0);
      assert.equal(current.metrics.inventories, 0);
      assert.throws(() => current.livenessReasons(), /unverified/);
      assert.throws(() => current.upgradeObligations(), /rebuilding/);
      assert.equal(current.metrics.initialization.attempts, attempts);
      assert.deepEqual(aliases(db), ["main", "log_checkpoints", "assignment_inbox"]);
      assert.ok(live.has(writer));
      assert.equal(live.size, 3, "two application handles plus exact independent lock holder");
      assert.equal(db.isTransaction, false);
      t.mock.timers.tick(1000); await current.reconcile(false);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(current.metrics.initialization.attempts, attempts + 1);
      assert.equal(current.metrics.checkpoints.acquisitionAttempts, 1);
      const controlMs = performance.now() - began;
      assert.ok(controlMs < 400);
      t.diagnostic(JSON.stringify({ tick, controlMs, callerBoundMs: 400, attempts: current.metrics.initialization.attempts,
        applicationHandles: live.size - 1, externalLockHolders: 1, status: current.observation().status }));
    }
    writer.exec("ROLLBACK");
    assert.deepEqual(writer.prepare("SELECT * FROM position").get(), before);
    assert.deepEqual(writer.prepare("SELECT * FROM background_file_repair").get(), repair);
    await current.reconcile(); assert.equal(current.metrics.initialization.attempts, 4);
    queries.handle({ type: "runtime_subscribe", scope });
    t.mock.timers.tick(1000); await current.reconcile(false); await current.reconcile();
    assert.equal(current.metrics.initialization.attempts, 5);
    assert.equal((current as any).db, db);
    assert.equal(current.snapshot(scope).status, "ready");
    assert.equal(current.snapshot(scope).rows[0]!.meta.status, "succeeded");
    assert.ok(frames.some(frame => frame.event?.snapshot?.status === "ready"));
    assert.equal(live.size, 3);
    assert.equal(background.changeMetrics.pending, 0);
  } finally {
    queries?.close(); if (writer.isTransaction) writer.exec("ROLLBACK");
    await model?.close(); writer.close(); mutation.release();
  }
  assert.equal(live.size, 0);
  assert.equal(maximum, 3);
});

test("Background repair-schema contention cleans only its alias and restores persisted repair state on the same owner", async () => {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const root = mkdtempSync(join(tmpdir(), "background-repair-deferred-"));
  const seed = new BackgroundObservation(root); await seed.close();
  const writer = new DatabaseSync(join(root, "runtime-read-repair", "background.sqlite"));
  const owner = new DatabaseSync(":memory:");
  const checkpoint = new LogCheckpoints(join(root, "checkpoint.sqlite"), owner);
  const background = new BackgroundObservation(root, join(root, "supervisor"), owner, undefined, undefined, { defer: true });
  try {
    writer.exec("DROP TABLE background_file_repair; BEGIN IMMEDIATE");
    assert.throws(() => background.initialize(), isSqliteLockContention);
    assert.deepEqual(aliases(owner), ["main", "log_checkpoints"]);
    assert.equal(background.ready, false);
    writer.exec("ROLLBACK; CREATE TABLE background_file_repair(singleton INTEGER PRIMARY KEY, identity TEXT, after_id TEXT, complete INTEGER); INSERT INTO background_file_repair VALUES(1,'saved-generation','saved-cursor',0)");
    background.initialize(); background.initialize();
    assert.equal(background.ready, true);
    assert.equal(background.changeMetrics.repairAfter, "saved-cursor");
    assert.equal(background.changeMetrics.operationRepairComplete, false);
    assert.equal(background.status, "rebuilding", "acquisition alone cannot publish verified coverage");
    await background.close(); await background.close();
    assert.deepEqual(aliases(owner), ["main", "log_checkpoints"]);
    assert.equal(owner.prepare("SELECT count(*) AS n FROM background_history").get().n, 0);
    assert.throws(() => background.initialize(), /closed/);
  } finally {
    if (writer.isTransaction) writer.exec("ROLLBACK");
    await background.close(); checkpoint.close(); owner.close(); writer.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("Background corruption stays degraded without retries and close before initialization never acquires", async t => {
  const root = mkdtempSync(join(tmpdir(), "background-corrupt-deferred-"));
  mkdirSync(join(root, "runtime-read-repair"));
  writeFileSync(join(root, "runtime-read-repair", "background.sqlite"), "not a SQLite database");
  t.mock.timers.enable({ apis: ["setInterval"] });
  const options = { baseDir: join(root, "raw"), durableDir: join(root, "archive"), watch };
  const unopened = new WorkReadModel(root, "unopened", options);
  await unopened.close(); assert.equal(unopened.metrics.initialization.attempts, 0);
  const model = new WorkReadModel(root, "corrupt", options);
  try {
    await model.reconcile();
    assert.equal(model.snapshot().status, "degraded");
    assert.match(model.snapshot().reason!, /not a database/);
    assert.equal(model.backgroundMetrics.changes.applied, null);
    assert.equal(model.metrics.initialization.contentions, 0);
    t.mock.timers.tick(3000); await model.reconcile();
    assert.equal(model.metrics.initialization.attempts, 1);
    assert.ok(!aliases((model as any).db).includes("background_inbox"));
    assert.throws(() => model.livenessReasons(), /unverified/);
  } finally { await model.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Background partial cleanup failure retains both errors and exact alias ownership until close succeeds", async () => {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const root = mkdtempSync(join(tmpdir(), "background-cleanup-deferred-")), owner = new DatabaseSync(":memory:");
  let fail = true;
  const boundary = new Proxy(owner, { get(target, key) {
    if (key === "exec") return (sql: string) => {
      if (fail && sql.startsWith("CREATE TABLE IF NOT EXISTS background_inbox.background_file_repair"))
        throw Object.assign(new Error("injected repair schema lock"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
      if (fail && sql === "DETACH DATABASE background_inbox") throw new Error("injected Background cleanup refusal");
      return target.exec(sql);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const background = new BackgroundObservation(root, join(root, "supervisor"), boundary, undefined, undefined, { defer: true });
  try {
    owner.exec("BEGIN"); assert.throws(() => background.initialize(), /unpinned/); owner.exec("ROLLBACK");
    assert.throws(() => background.initialize(), (error: any) => error instanceof AggregateError
      && error.errors.length === 2 && !isSqliteLockContention(error) && /cleanup refusal/.test(String(error.errors[1])));
    assert.equal(background.ready, false);
    assert.deepEqual(aliases(owner), ["main", "background_inbox"]);
    assert.throws(() => background.close(), /cleanup refusal/);
    fail = false; await background.close(); await background.close();
    assert.deepEqual(aliases(owner), ["main"]);
    assert.equal(owner.prepare("SELECT 42 AS n").get().n, 42);
  } finally { fail = false; await background.close(); owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test("closing a model while the Background exclusive writer remains held settles and cancels acquisition", async t => {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const root = mkdtempSync(join(tmpdir(), "background-close-deferred-"));
  const seed = new BackgroundObservation(root); await seed.close();
  const writer = new DatabaseSync(join(root, "runtime-read-repair", "background.sqlite"));
  writer.exec("BEGIN EXCLUSIVE");
  t.mock.timers.enable({ apis: ["setInterval"] });
  const model = new WorkReadModel(root, "closing", { baseDir: join(root, "raw"), durableDir: join(root, "archive"), watch });
  let closed = false;
  try {
    await model.reconcile();
    const metrics = (model as any).initialization;
    assert.equal(metrics.attempts, 1);
    await model.close();
    closed = true;
    assert.equal(writer.isTransaction, true);
    t.mock.timers.tick(10000); await model.reconcile();
    assert.equal(metrics.attempts, 1);
  } finally { if (!closed) await model.close(); writer.exec("ROLLBACK"); writer.close(); rmSync(root, { recursive: true, force: true }); }
});

test("partial initialization publication remains non-ready when an already-attached assignment inbox becomes exclusively locked", async t => {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const root = mkdtempSync(join(tmpdir(), "partial-inbox-publication-"));
  t.mock.timers.enable({ apis: ["setInterval"] });
  const model = new WorkReadModel(root, "partial", { baseDir: join(root, "raw"), durableDir: join(root, "archive"), watch });
  const background = (model as any).background, initialize = background.initialize.bind(background);
  let writer: any;
  background.initialize = () => {
    writer ??= new DatabaseSync(":memory:");
    writer.prepare("ATTACH DATABASE ? AS assignment_inbox").run(join(root, "runtime-read-repair", "assignments.sqlite"));
    writer.prepare("ATTACH DATABASE ? AS background_inbox").run(join(root, "runtime-read-repair", "background.sqlite"));
    writer.exec("BEGIN EXCLUSIVE");
    return initialize();
  };
  const publications: any[] = [];
  const stop = model.onChange(() => { publications.push({ metrics: model.metrics, background: model.backgroundMetrics, observation: model.observation() }); });
  try {
    await assert.doesNotReject(model.reconcile());
    assert.ok(publications.length);
    assert.equal(publications.at(-1).observation.status, "rebuilding");
    assert.equal(publications.at(-1).metrics.assignments.applied, null);
    assert.equal(model.snapshot().status, "rebuilding");
    assert.equal(model.metrics.initialization.attempts, 1);
    writer.exec("ROLLBACK");
    background.initialize = initialize;
    await model.reconcile(); assert.equal(model.metrics.initialization.attempts, 1);
    t.mock.timers.tick(1000); await model.reconcile();
    assert.equal(model.snapshot().status, "ready", model.snapshot().reason);
  } finally { stop(); if (writer?.isTransaction) writer.exec("ROLLBACK"); await model.close(); writer?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("initialized observation diagnostics report unknown cursors rather than throw under a real derived-owner exclusive lock", async () => {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const root = mkdtempSync(join(tmpdir(), "initialized-inbox-publication-"));
  const mutation = acquireMutationStore(root);
  const model = new WorkReadModel(root, "initialized", { baseDir: join(root, "raw"), durableDir: join(root, "archive"), watch });
  const writer = new DatabaseSync(":memory:");
  try {
    await model.reconcile(); model.snapshot({ background: true, cwd: root, sessionId: "parent" });
    writer.prepare("ATTACH DATABASE ? AS assignment_inbox").run(join(root, "runtime-read-repair", "assignments.sqlite"));
    writer.prepare("ATTACH DATABASE ? AS background_inbox").run(join(root, "runtime-read-repair", "background.sqlite"));
    const attempts = model.metrics.initialization.attempts;
    writer.exec("BEGIN EXCLUSIVE");
    assert.throws(() => (model as any).reader.changeMetrics, isSqliteLockContention);
    assert.throws(() => (model as any).background.inbox.metrics, isSqliteLockContention);
    assert.equal(model.metrics.assignments.applied, null);
    assert.equal(model.backgroundMetrics.changes.applied, null);
    assert.equal(model.metrics.initialization.attempts, attempts);
    writer.exec("ROLLBACK");
    assert.equal(model.metrics.assignments.applied, 0);
    assert.equal(model.backgroundMetrics.changes.applied, 0);
    const reader = (model as any).reader, descriptor = Object.getOwnPropertyDescriptor(reader, "changeMetrics")!;
    const failure = new Error("non-contention diagnostic failure");
    Object.defineProperty(reader, "changeMetrics", { configurable: true, get() { throw failure; } });
    try { assert.throws(() => model.metrics, error => error === failure); }
    finally { Object.defineProperty(reader, "changeMetrics", descriptor); }
    const inbox = (model as any).background.inbox;
    Object.defineProperty(inbox, "metrics", { configurable: true, get() { throw failure; } });
    try { assert.throws(() => model.backgroundMetrics, error => error === failure); }
    finally { delete inbox.metrics; }
  } finally { if (writer.isTransaction) writer.exec("ROLLBACK"); await model.close(); writer.close(); mutation.release(); rmSync(root, { recursive: true, force: true }); }
});
