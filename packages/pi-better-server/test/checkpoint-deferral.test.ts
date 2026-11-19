import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LogCheckpoints } from "../src/runtime/log-checkpoints.ts";
import { WorkReadModel } from "../src/runtime/read-model.ts";
import { WorkQueries } from "../src/runtime/queries.ts";
const { AssignmentInbox } = await import(new URL("../../operation-coordinator/assignment-inbox.mjs", import.meta.url).href);
const { openStore } = await import(new URL("../src/runtime/domain/subagents/shared-operation-coordinator/index.domain.mjs", import.meta.url).href);

// The SQLite and query owners are real; only filesystem notification and the
// external socket boundary are replaced. No worker, socket or subprocess opens.
const watch = (() => Object.assign(new EventEmitter(), { close() {}, ready: Promise.resolve() })) as any;
const names = (db: DatabaseSync) => db.prepare("PRAGMA database_list").all().map(row => row.name);
const fixture = () => mkdtempSync(join(tmpdir(), "checkpoint-deferral-"));

test("exclusive checkpoint owner defers once per repair tick, keeps consumer coverage incomplete, then restores on the same owner", async t => {
  const sqlite = createRequire(import.meta.url)("node:sqlite"), Original = sqlite.DatabaseSync;
  const live = new Set<any>();
  let maximum = 0;
  sqlite.DatabaseSync = class extends Original {
    constructor(...args: any[]) { super(...args); live.add(this); maximum = Math.max(maximum, live.size); }
    prepare(sql: string) {
      if (/^ATTACH\b/i.test(sql)) assert.equal(this.isTransaction, false, "acquisition must precede the owner transaction");
      return super.prepare(sql);
    }
    close() { super.close(); live.delete(this); }
  };
  t.after(() => { sqlite.DatabaseSync = Original; });
  const root = fixture(), baseDir = join(root, "raw"), agent = join(root, "agent");
  const directory = join(baseDir, "runs", "sa_checkpoint_deferred"), log = join(directory, "output.log");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "meta.json"), JSON.stringify({ id: "sa_checkpoint_deferred", cwd: root,
    sessionId: "child", status: "completed", startedAt: 1, endedAt: 2 }));
  writeFileSync(log, JSON.stringify({ type: "message_end", message: { role: "assistant",
    usage: { input: 3, output: 2, cost: { total: 0.01 } } } }) + "\n");
  const options = { baseDir, durableDir: join(root, "archive"), intervalMs: 1000, watch };
  const seed = new WorkReadModel(agent, "seed", options);
  try { await seed.reconcile(); assert.equal(seed.snapshot().status, "ready"); }
  finally { await seed.close(); }
  // The independent lock holder is counted explicitly, not an application handle.
  const writer = new sqlite.DatabaseSync(":memory:");
  const checkpoints = new LogCheckpoints(join(agent, "runtime-log-checkpoints.sqlite"), writer);
  assert.ok(checkpoints.load(log), "normal prior fold was persisted");
  writer.exec("BEGIN EXCLUSIVE");
  t.mock.timers.enable({ apis: ["setInterval"] });
  const model = new WorkReadModel(agent, "deferred", options), owner = (model as any).db;
  const socket = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0,
    write(line: string) { frames.push(JSON.parse(line)); }, destroy() {} });
  const frames: any[] = [], queries = new WorkQueries(model, socket as any);
  let modelClosed = false;
  const control = openStore({ path: join(agent, "operation-coordinator.sqlite") });
  const command = { type: "runtime_subscribe", scope: {} };
  const assertHandles = () => {
    assert.ok(live.has(writer));
    assert.ok(live.has(owner));
    assert.equal(live.size, 3, "two application handles plus the exact external checkpoint lock holder");
  };
  try {
    assertHandles();
    assert.equal(owner.prepare("PRAGMA busy_timeout").get().timeout, 0);
    assert.equal((queries.handle(command) as any).status, "rebuilding");
    await Promise.all(Array.from({ length: 32 }, () => model.reconcile(true)));
    assert.equal(model.metrics.checkpoints.acquisitionAttempts, 1);
    assert.equal(model.metrics.checkpoints.contentions, 1);
    assert.ok(!names(owner).includes("log_checkpoints"));
    for (let tick = 0; tick < 3; tick++) {
      const before: number = model.metrics.checkpoints.acquisitionAttempts;
      const began = performance.now();
      control.registerAssignment({ assignmentId: `independent_control_${tick}`,
        owner: { kind: "worker-conversation", sessionId: "worker", workspace: root },
        recipient: { kind: "parent-session", sessionId: "parent", workspace: root } });
      model.fileHint(model.runs, "sa_checkpoint_deferred");
      await Promise.all(Array.from({ length: 32 }, () => model.reconcile(true)));
      assert.equal(model.metrics.checkpoints.acquisitionAttempts, before, "callers and hints do not retry");
      assert.throws(() => model.livenessReasons(), /checkpoint coverage is unverified/);
      assert.throws(() => model.upgradeObligations(), /Runtime observation rebuilding/);
      assert.equal(model.observation().status, "rebuilding");
      assert.equal((queries.handle({ type: "runtime_get_snapshot", scope: {} }) as any).status, "rebuilding");
      assert.deepEqual(queries.handle({ type: "runtime_unsubscribe" }), { unsubscribed: true });
      queries.handle(command);
      t.mock.timers.tick(1000);
      await model.reconcile(false);
      assert.equal(model.metrics.checkpoints.acquisitionAttempts, before + 1, "one attempt per existing interval");
      assert.equal(model.metrics.inventories, 0, "no source coverage or applied cursor before initialization");
      assertHandles();
      assert.equal(owner.isTransaction, false);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(model.metrics.checkpoints.acquisitionAttempts, before + 1, "no finally recursion or drain spin");
      const controlMs = performance.now() - began;
      assert.ok(controlMs < 400, `control and query work must fit the unchanged 400ms caller bound: ${controlMs}`);
      t.diagnostic(JSON.stringify({ tick, controlMs, callerBoundMs: 400, watchdogBoundMs: 1200,
        attempts: model.metrics.checkpoints.acquisitionAttempts, status: model.observation().status }));
    }
    writer.exec("ROLLBACK");
    await model.reconcile();
    assert.equal(model.metrics.checkpoints.acquisitionAttempts, 4, "release alone does not renew the attempt");
    t.mock.timers.tick(1000);
    await model.reconcile(false);
    await model.reconcile();
    assert.equal((model as any).db, owner);
    assert.equal(model.metrics.indexConnections, 1);
    assertHandles();
    assert.equal(model.snapshot().status, "ready", model.snapshot().reason);
    assert.equal(model.metrics.checkpoints.restores, 1);
    assert.ok(model.metrics.checkpoints.commits >= 1);
    assert.ok((model.snapshot().rows[0] as any).display.spend.includes("0.01"));
    assert.ok(frames.some(frame => frame.event?.snapshot?.status === "ready"), "actual subscription receives recovered coverage");
    assert.equal(model.observation().status, "ready");
    assert.doesNotThrow(() => model.livenessReasons());
    const acquisitionMetrics = (model as any).checkpoints.metrics;
    await model.close();
    modelClosed = true;
    t.mock.timers.tick(10000);
    assert.equal(acquisitionMetrics.acquisitionAttempts, 5, "no acquisition after shutdown");
  } finally {
    queries.close();
    if (writer.isTransaction) writer.exec("ROLLBACK");
    if (!modelClosed) await model.close();
    checkpoints.close(); writer.close(); control.close();
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(live.size, 0);
  assert.equal(maximum, 3, "no transient handle beyond the two owners and known lock holder");
});

test("schema contention after ATTACH releases only the participant's attachment and replays after release", () => {
  const root = fixture(), path = join(root, "checkpoints.sqlite");
  const writer = new DatabaseSync(":memory:"), owner = new DatabaseSync(":memory:");
  const first = new LogCheckpoints(path, writer), deferred = new LogCheckpoints(path, owner, { defer: true });
  owner.exec("CREATE TABLE retained(value); INSERT INTO retained VALUES(42)");
  try {
    writer.exec("DROP TABLE log_checkpoints.checkpoints; BEGIN IMMEDIATE");
    assert.equal(deferred.initialize(), false, "ATTACH succeeds but CREATE cannot acquire the writer");
    assert.equal(deferred.ready, false);
    assert.deepEqual(names(owner), ["main"]);
    assert.throws(() => deferred.load("missing"), /coverage is unavailable/);
    assert.throws(() => deferred.save("missing", {}), /coverage is unavailable/);
    writer.exec("ROLLBACK");
    assert.equal(deferred.initialize(), true);
    deferred.save("replayed", { offset: 42 });
    assert.deepEqual(first.load("replayed"), { offset: 42 });
    deferred.close(); deferred.close();
    assert.equal(owner.prepare("SELECT value FROM retained").get()!.value, 42);
  } finally {
    if (writer.isTransaction) writer.exec("ROLLBACK");
    deferred.close(); first.close(); owner.close(); writer.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("uninitialized and duplicate participants never detach another participant or close a borrowed owner", () => {
  const root = fixture(), owner = new DatabaseSync(":memory:"), path = join(root, "checkpoints.sqlite");
  const original = new LogCheckpoints(path, owner);
  const unopened = new LogCheckpoints(path, owner, { defer: true });
  try {
    original.save("retained", { n: 1 });
    const neverAttempted = new LogCheckpoints(path, owner, { defer: true });
    neverAttempted.close();
    assert.equal(neverAttempted.metrics.acquisitionAttempts, 0);
    assert.deepEqual(original.load("retained"), { n: 1 });
    assert.throws(() => unopened.initialize(), /already in use/);
    assert.equal(unopened.metrics.contentions, 0);
    unopened.close(); unopened.close();
    assert.deepEqual(original.load("retained"), { n: 1 });
    assert.throws(() => unopened.initialize(), /closed/);
    owner.exec("BEGIN");
    const pinned = new LogCheckpoints(path, owner, { defer: true });
    assert.throws(() => pinned.initialize(), /unpinned owner/);
    pinned.close(); owner.exec("ROLLBACK");
  } finally { unopened.close(); original.close(); owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test("non-contention bootstrap failure stays degraded, does not retry, and shutdown cancels future acquisition", async t => {
  const root = fixture();
  writeFileSync(join(root, "runtime-log-checkpoints.sqlite"), "not a SQLite database");
  t.mock.timers.enable({ apis: ["setInterval"] });
  const model = new WorkReadModel(root, "corrupt", { baseDir: join(root, "raw"), durableDir: join(root, "archive"), watch });
  try {
    await model.reconcile();
    const acquisitionMetrics = (model as any).checkpoints.metrics;
    assert.equal(model.snapshot().status, "degraded");
    assert.match(model.snapshot().reason!, /not a database/);
    assert.equal(model.metrics.checkpoints.contentions, 0);
    t.mock.timers.tick(1000); await model.reconcile();
    assert.equal(acquisitionMetrics.acquisitionAttempts, 1);
    assert.ok(!names((model as any).db).includes("log_checkpoints"));
  } finally { await model.close(); rmSync(root, { recursive: true, force: true }); }
});

test("closing while contended releases pending initialization without waiting for the exact writer", async t => {
  const root = fixture(), writer = new DatabaseSync(":memory:");
  const checkpoint = new LogCheckpoints(join(root, "runtime-log-checkpoints.sqlite"), writer);
  writer.exec("BEGIN EXCLUSIVE");
  t.mock.timers.enable({ apis: ["setInterval"] });
  const model = new WorkReadModel(root, "closing", { baseDir: join(root, "raw"), durableDir: join(root, "archive"), watch });
  try {
    await model.reconcile();
    const pending = model.reconcile();
    const acquisitionMetrics = (model as any).checkpoints.metrics;
    await model.close(); await pending;
    t.mock.timers.tick(10000);
    await model.reconcile();
    assert.equal(acquisitionMetrics.acquisitionAttempts, 1);
    assert.equal(writer.isTransaction, true, "shutdown did not need writer release");
  } finally {
    writer.exec("ROLLBACK"); checkpoint.close(); writer.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("partial attachment cleanup failure is reported, retained as owned, and never mistaken for deferred success", () => {
  const root = fixture(), owner = new DatabaseSync(":memory:"), path = join(root, "checkpoints.sqlite");
  let failCleanup = true;
  const boundary = new Proxy(owner, { get(target, key) {
    if (key === "exec") return (sql: string) => {
      if (sql.startsWith("CREATE TABLE") && failCleanup)
        throw Object.assign(new Error("injected initialization lock"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
      if (sql.startsWith("DETACH") && failCleanup) throw new Error("injected owned detach failure");
      return target.exec(sql);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const checkpoint = new LogCheckpoints(path, boundary, { defer: true });
  try {
    assert.throws(() => checkpoint.initialize(), (error: any) => error instanceof AggregateError
      && error.errors.length === 2 && /owned detach failure/.test(String(error.errors[1])));
    assert.equal(checkpoint.ready, false);
    assert.equal(checkpoint.metrics.contentions, 0, "failed cleanup cannot be treated as a safe lock deferral");
    assert.deepEqual(names(owner), ["main", "log_checkpoints"]);
    assert.throws(() => checkpoint.close(), /owned detach failure/);
    failCleanup = false;
    checkpoint.close();
    assert.deepEqual(names(owner), ["main"]);
    assert.equal(owner.prepare("SELECT 42 AS value").get()!.value, 42);
  } finally { failCleanup = false; checkpoint.close(); owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test("inbox exclusive acquisition shares the repair permission and never verifies empty coverage", async t => {
  const root = fixture(), agent = join(root, "agent"), baseDir = join(root, "raw");
  const id = "sa_inbox_contended", directory = join(baseDir, "runs", id);
  mkdirSync(directory, { recursive: true }); mkdirSync(agent);
  const source = openStore({ path: join(agent, "operation-coordinator.sqlite") });
  const ownerRef = { kind: "worker-conversation", sessionId: "worker", workspace: root };
  const recipient = { kind: "parent-session", sessionId: "parent", workspace: root };
  source.registerAssignment({ assignmentId: id, owner: ownerRef, recipient });
  source.recordAssignmentOutcome({ assignmentId: id, owner: ownerRef, recipient, revision: 1,
    outcome: "failed", reason: "fixture", evidence: [], waits: [], processUncertain: false });
  writeFileSync(join(directory, "meta.json"), JSON.stringify({ id, cwd: root, sessionId: "worker", status: "completed",
    startedAt: 1, assignment: { assignmentId: id, owner: ownerRef, recipient }, callbackOrigin: { cwd: root, sessionId: "parent" } }));
  const options = { baseDir, durableDir: join(root, "archive"), intervalMs: 1000, watch };
  const seed = new WorkReadModel(agent, "inbox-seed", options);
  let oldApplied: number;
  try { await seed.reconcile(); oldApplied = seed.metrics.assignments.applied; }
  finally { await seed.close(); }
  const writer = new DatabaseSync(join(agent, "runtime-read-repair", "assignments.sqlite"));
  writer.exec("BEGIN EXCLUSIVE");
  // Source writer and lock holder already exist; count all worker acquisitions.
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
  t.after(() => { sqlite.DatabaseSync = Original; });
  t.mock.timers.enable({ apis: ["setInterval"] });
  let model: WorkReadModel | undefined;
  try {
    // This constructor is the exact native failing boundary, not a substitute inbox.
    assert.doesNotThrow(() => { model = new WorkReadModel(agent, "inbox-deferred", options); });
    const current = model!, db = (current as any).db;
    source.receiptAssignmentOutcome({ assignmentId: id, recipient, revision: 1, entryId: "received-during-lock" });
    await Promise.all(Array.from({ length: 32 }, () => current.reconcile(true)));
    assert.equal(current.metrics.initialization.attempts, 1);
    assert.equal(current.metrics.checkpoints.acquisitionAttempts, 1, "checkpoint attachment succeeded independently");
    assert.deepEqual(names(db), ["main", "log_checkpoints"], "failed assignment ATTACH retains checkpoints without acquiring Background prematurely");
    const frames: any[] = [];
    const socket = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0,
      write(line: string) { frames.push(JSON.parse(line)); }, destroy() {} });
    const queries = new WorkQueries(current, socket as any);
    try {
      for (let tick = 0; tick < 3; tick++) {
        const before: number = current.metrics.initialization.attempts;
        const began = performance.now();
        current.fileHint(current.runs, id);
        await Promise.all(Array.from({ length: 32 }, () => current.reconcile(true)));
        assert.equal(current.metrics.initialization.attempts, before);
        assert.equal((queries.handle({ type: "runtime_subscribe", scope: {} }) as any).status, "rebuilding");
        assert.equal((queries.handle({ type: "runtime_get_snapshot", scope: { background: true, cwd: root, sessionId: "parent" } }) as any).status, "rebuilding");
        const history = queries.handle({ type: "runtime_get_snapshot", scope: {
          background: true, backgroundHistory: true, cwd: root, sessionId: "parent" } }) as any;
        assert.equal(history.status, "rebuilding", "history cannot dereference a reader before acquisition");
        assert.equal(history.backgroundIndex, undefined, "unverified history must not mint an index or cursor");
        assert.equal(current.backgroundMetrics.history?.inventories ?? 0, 0, "unavailable history never inventories the source");
        assert.equal(current.observation().status, "rebuilding");
        assert.throws(() => current.livenessReasons(), /unverified/);
        assert.throws(() => current.upgradeObligations(), /rebuilding/);
        assert.equal(current.metrics.assignments.applied, null, "unavailable cursor is unknown, not verified zero");
        assert.equal(current.metrics.inventories, 0);
        assert.equal(live.size, 1, "deferral retains one worker handle, plus the existing root mutation owner");
        assert.equal(db.isTransaction, false);
        queries.handle({ type: "runtime_unsubscribe" });
        queries.handle({ type: "runtime_subscribe", scope: {} });
        t.mock.timers.tick(1000); await current.reconcile(false);
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(current.metrics.initialization.attempts, before + 1);
        assert.equal(current.metrics.checkpoints.acquisitionAttempts, 1);
        assert.ok(performance.now() - began < 400, "query/control remains within original caller deadline");
      }
      writer.exec("ROLLBACK");
      assert.equal(writer.prepare("SELECT applied FROM position").get()!.applied, oldApplied!);
      await current.reconcile(); assert.equal(current.metrics.initialization.attempts, 4);
      t.mock.timers.tick(1000); await current.reconcile(false); await current.reconcile();
      assert.equal((current as any).db, db);
      assert.equal(current.snapshot().status, "ready", current.snapshot().reason);
      assert.equal(current.metrics.initialization.attempts, 5);
      assert.equal(current.snapshot({ id }).rows[0]!.recipientPending, false);
      assert.equal(current.metrics.assignments.pending, 0);
      assert.equal(live.size, 1, "recovery cannot open a separate canonical source handle");
      assert.equal(current.metrics.indexConnections, 1);
      assert.equal(current.metrics.coordinatorConnections, 1);
      assert.ok(current.metrics.assignments.applied > oldApplied!);
      assert.ok(frames.some(frame => frame.event?.snapshot?.status === "ready"));
      const scope = { background: true, backgroundHistory: true, cwd: root, sessionId: "parent" };
      queries.handle({ type: "runtime_get_snapshot", scope });
      await (current as any).background.history.pending;
      const verifiedHistory = queries.handle({ type: "runtime_get_snapshot", scope }) as any;
      assert.equal(verifiedHistory.status, "ready", verifiedHistory.reason);
      assert.equal(verifiedHistory.totalMatching, 0, "empty history is verified only after ordinary source initialization");
    } finally { queries.close(); }
  } finally {
    if (writer.isTransaction) writer.exec("ROLLBACK");
    await model?.close(); writer.close(); source.close(); rmSync(root, { recursive: true, force: true });
  }
  assert.equal(maximum, 1);
  assert.equal(live.size, 0);
});

test("inbox schema contention releases only its newly acquired alias before same-owner replay", () => {
  const root = fixture(), path = join(root, "inbox.sqlite");
  const writer = new DatabaseSync(path), owner = new DatabaseSync(":memory:");
  writer.exec("CREATE TABLE retained(value); BEGIN IMMEDIATE");
  try {
    assert.throws(() => new AssignmentInbox(path, owner), /database is locked/);
    assert.deepEqual(names(owner), ["main"], "failed schema initialization must release its exact alias");
    writer.exec("ROLLBACK");
    const inbox = new AssignmentInbox(path, owner);
    try {
      assert.equal(inbox.metrics.repairs, 0);
      assert.throws(() => new AssignmentInbox(path, owner), /already in use/);
      assert.equal(inbox.metrics.repairs, 0, "duplicate failure must not detach existing participant");
    } finally { inbox.close(); }
    assert.equal(owner.prepare("SELECT 42 AS n").get()!.n, 42);
  } finally {
    if (writer.isTransaction) writer.exec("ROLLBACK");
    owner.close(); writer.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("Background inbox schema contention preserves the existing assignment alias", () => {
  const root = fixture(), path = join(root, "background.sqlite");
  const writer = new DatabaseSync(path), owner = new DatabaseSync(":memory:");
  const assignment = new AssignmentInbox(join(root, "assignment.sqlite"), owner);
  writer.exec("CREATE TABLE retained(value); BEGIN IMMEDIATE");
  try {
    assert.throws(() => new AssignmentInbox(path, owner, { entityPrefix: "background:" }), /database is locked/);
    assert.deepEqual(names(owner), ["main", "assignment_inbox"], "cleanup cannot detach the earlier assignment participant");
    assert.equal(assignment.metrics.repairs, 0);
    writer.exec("ROLLBACK");
    const background = new AssignmentInbox(path, owner, { entityPrefix: "background:" });
    try {
      assert.deepEqual(names(owner), ["main", "assignment_inbox", "background_inbox"]);
      assert.equal(background.metrics.repairs, 0);
    } finally { background.close(); }
    assert.equal(assignment.metrics.repairs, 0);
    assert.deepEqual(names(owner), ["main", "assignment_inbox"]);
  } finally {
    if (writer.isTransaction) writer.exec("ROLLBACK");
    assignment.close(); owner.close(); writer.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("inbox corruption is not lock deferral and close does not require an initialized reader", async t => {
  const root = fixture();
  mkdirSync(join(root, "runtime-read-repair"));
  writeFileSync(join(root, "runtime-read-repair", "assignments.sqlite"), "not a SQLite database");
  t.mock.timers.enable({ apis: ["setInterval"] });
  const model = new WorkReadModel(root, "inbox-corrupt", { baseDir: join(root, "raw"), durableDir: join(root, "archive"), watch });
  try {
    await model.reconcile();
    assert.equal(model.snapshot().status, "degraded");
    assert.match(model.snapshot().reason!, /not a database/);
    assert.equal(model.metrics.initialization.contentions, 0);
    assert.equal(model.metrics.assignments.applied, null);
    assert.deepEqual(names((model as any).db), ["main", "log_checkpoints"], "corrupt assignment initialization cannot acquire the later Background participant");
    t.mock.timers.tick(1000); await model.reconcile();
    assert.equal(model.metrics.initialization.attempts, 1);
    assert.throws(() => model.livenessReasons(), /unverified/);
  } finally { await model.close(); rmSync(root, { recursive: true, force: true }); }
});
