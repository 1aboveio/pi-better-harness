import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireMutationStore } from "../src/runtime/mutation-store.ts";
import { WorkReadModel } from "../src/runtime/read-model.ts";
import { withFixtureCleanup } from "./support/fixture-outcome.ts";

test("actual mutation root and composed read model preserve readonly snapshots, rollback and durable replay on two handles", async t => {
  const sqlite = createRequire(import.meta.url)("node:sqlite"), Original = sqlite.DatabaseSync;
  const live = new Set<any>();
  let maximum = 0;
  sqlite.DatabaseSync = class extends Original {
    constructor(...args: any[]) { super(...args); live.add(this); maximum = Math.max(maximum, live.size); }
    close() { super.close(); live.delete(this); }
  };
  t.after(() => { sqlite.DatabaseSync = Original; });
  const root = mkdtempSync(join(tmpdir(), "two-handles-"));
  let mutation = acquireMutationStore(root);
  const store = mutation.store;
  const watch = (_path: string, listener: (...args: any[]) => void) => {
    const value: any = new EventEmitter(); value.on("change", listener);
    value.ready = Promise.resolve(); value.close = () => {}; return value;
  };
  const owner = { kind: "worker-conversation" as const, sessionId: "captured", workspace: root, branchId: null, goalId: null };
  const binding = { version: 1 as const, assignmentId: "assignment", owner, recipient: { ...owner, kind: "parent-session" as const, sessionId: "parent" } };
  store.registerAssignment({ ...binding, attemptId: "sa_test" });
  store.registerOperation({ operationId: "operation", taskId: "task", launchToken: "token", owner, observer: { kind: "local-supervisor", version: "1" } });
  store.registerWait({ waitId: "wait", owner, dependencies: [{ operationId: "operation" }], continuationNote: "Interpret evidence", origin: { assignmentRef: "assignment", attemptId: "sa_test" } });
  mkdirSync(join(root, "runs/sa_test"), { recursive: true });
  writeFileSync(join(root, "runs/sa_test/meta.json"), JSON.stringify({ id: "sa_test", cwd: root, sessionId: "captured", status: "completed", startedAt: 1, assignment: binding }));
  writeFileSync(join(root, "runs/sa_test/output.log"), '{"type":"agent_end","messages":[]}\n');
  const options = { baseDir: root, durableDir: join(root, "durable"), supervisorDirectory: join(root, "supervisor"), intervalMs: 60000, watch };
  let model = new WorkReadModel(root, "composed", options);
  await withFixtureCleanup(async () => {
    await model.reconcile();
    assert.equal(live.size, 2);
    const reader = (model as any).reader, db = (model as any).db;
    db.exec("CREATE TABLE operations(operation_id TEXT); INSERT INTO operations VALUES('derived-shadow')");
    assert.equal(reader.connection().prepare("SELECT operation_id FROM operations").get().operation_id, "operation",
      "source facade must qualify canonical tables instead of resolving a derived shadow");
    for (const sql of ["INSERT INTO coordinator_source.coordinator_state VALUES('forbidden','bad')",
      "UPDATE coordinator_source.schema_meta SET value='bad'", "DELETE FROM coordinator_source.operations", "CREATE TABLE coordinator_source.forbidden(value)"]) {
      assert.throws(() => db.exec(sql), /readonly/i);
    }
    const pending = reader.changes();
    const snapshot = reader.beginSnapshot();
    assert.equal(reader.connection(false).prepare("SELECT phase FROM waits WHERE wait_id='wait'").get().phase, "waiting");
    store.recordTerminalOutcome({ operationId: "operation", owner, eventId: "terminal", outcome: "succeeded", evidence: [{ kind: "terminal-record", ref: "result" }] });
    assert.equal(reader.connection(false).prepare("SELECT phase FROM waits WHERE wait_id='wait'").get().phase, "waiting");
    snapshot.commit();
    assert.equal(reader.connection().prepare("SELECT phase FROM waits WHERE wait_id='wait'").get().phase, "ready");
    assert.equal(live.size, 2);
    const before = model.snapshot({ id: "sa_test" }).rows[0]!.sourceRevision;
    const execute = db.exec.bind(db);
    let refused = false;
    db.exec = (sql: string) => {
      if (sql === "COMMIT" && !refused) { refused = true; throw new Error("injected owner commit failure"); }
      return execute(sql);
    };
    (model as any).refreshAssignments();
    assert.equal(refused, true);
    assert.equal((model as any).projected.get("sa_test").sourceRevision, before, "failed owner commit cannot publish assignment application");
    assert.equal(JSON.parse(db.prepare("SELECT payload FROM rows WHERE id='sa_test'").get().payload).sourceRevision, before);
    assert.ok(reader.changeMetrics.pending > 0, "durable received obligations must survive failed application");
    assert.equal(db.isTransaction, false);
    db.exec = execute;
    await model.reconcile();
    assert.notEqual(model.snapshot({ id: "sa_test" }).rows[0]!.sourceRevision, before);
    assert.equal(model.snapshot().status, "ready", model.snapshot().reason);
    assert.equal(live.size, 2);
    const sourceOwner = [...live].find(value => value.prepare("PRAGMA database_list").all().some((entry: any) => entry.name === "main" && entry.file === join(root, "operation-coordinator.sqlite")))!;
    sourceOwner.exec("UPDATE schema_meta SET value='unsupported' WHERE key='schema_version'");
    await model.reconcile();
    assert.equal(model.snapshot().status, "degraded");
    assert.equal(model.snapshot().rows.length, 1, "unsupported source cannot discard its last verified row");
    sourceOwner.exec("UPDATE schema_meta SET value='4' WHERE key='schema_version'");
    await model.reconcile();
    assert.equal(model.snapshot().status, "ready", model.snapshot().reason);
    const committed = (model as any).projected.get("sa_test").sourceRevision;
    const checkpointCommits = model.metrics.checkpoints.commits;
    appendFileSync(join(root, "runs/sa_test/output.log"), '{"type":"message_end","message":{"role":"assistant","content":"later display"}}\n');
    db.exec = (sql: string) => { if (sql === "COMMIT") throw new Error("injected full observation commit failure"); return execute(sql); };
    await model.reconcile();
    assert.equal((model as any).projected.get("sa_test").sourceRevision, committed);
    assert.equal(model.metrics.checkpoints.commits, checkpointCommits, "released savepoint must not publish checkpoint commits after owner rollback");
    assert.equal(db.isTransaction, false);
    db.exec = execute;
    await model.reconcile();
    assert.equal(model.snapshot().status, "ready", model.snapshot().reason);
    assert.notEqual(model.snapshot().rows[0]!.sourceRevision, committed);
    const parent = { ...owner, kind: "parent-session" as const, sessionId: "parent" };
    store.registerOperation({ operationId: "background", taskId: "bgs_0123456789abcdef0123", launchToken: "background-token", owner: parent, observer: { kind: "local-supervisor", version: "1" } });
    store.recordTerminalOutcome({ operationId: "background", owner: parent, eventId: "background-terminal", outcome: "succeeded", evidence: [{ kind: "terminal-record", ref: "background-result" }] });
    const background = (model as any).background, scope = { background: true, cwd: root, sessionId: "parent" };
    background.read(scope); background.refresh();
    const backgroundBefore = JSON.stringify(background.rows);
    const appliedBefore = background.changeMetrics.applied;
    store.registerWait({ waitId: "background-wait", owner: parent, dependencies: [{ operationId: "background" }], continuationNote: "Read background evidence" });
    db.exec = (sql: string) => { if (sql === "COMMIT") throw new Error("injected Background commit failure"); return execute(sql); };
    background.refresh();
    assert.equal(JSON.stringify(background.rows), backgroundBefore, "Background cannot publish provisional map changes on failed owner commit");
    assert.equal(background.changeMetrics.applied, appliedBefore);
    assert.equal(db.isTransaction, false);
    db.exec = execute;
    background.refresh();
    assert.equal(background.read(scope)[0].waits[0].waitId, "background-wait");
    assert.equal(live.size, 2);
    const publishedRevision = model.snapshot().rows[0]!.sourceRevision;
    await model.close();
    assert.equal(live.size, 1);
    model = new WorkReadModel(root, "reopened", options);
    await model.reconcile();
    assert.equal(model.snapshot().status, "ready", model.snapshot().reason);
    assert.equal(live.size, 2);
    assert.ok(model.metrics.checkpoints.restores > 0, "owner commit must persist actual log checkpoints for reopen");
    assert.equal(model.snapshot().rows[0]!.sourceRevision, publishedRevision, "checkpoint replay after rollback must reproduce the committed projection");
    const generation = model.metrics.assignments.generation;
    mutation.release();
    assert.equal(live.size, 1);
    const canonical = join(root, "operation-coordinator.sqlite");
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(canonical + suffix)) renameSync(canonical + suffix, canonical + suffix + ".old");
    await model.reconcile();
    assert.equal(existsSync(canonical), false, "missing canonical source must never be created by the reader");
    assert.equal(model.snapshot().status, "degraded");
    assert.equal(model.snapshot().rows.length, 1, "missing source must retain the previously observed row");
    assert.equal(live.size, 1);
    mutation = acquireMutationStore(root);
    await model.reconcile();
    assert.equal(live.size, 2, "inode replacement must not open a hidden source handle");
    assert.notEqual(model.metrics.assignments.generation, generation);
    assert.equal((model as any).reader.connection(false).prepare("SELECT count(*) AS n FROM waits").get().n, 0,
      "replacement facade cannot keep reading the retired inode");
    assert.equal(model.snapshot().status, "ready", model.snapshot().reason);
    assert.equal(pending instanceof Map, true);
  }, async () => { try { await model.close(); } finally { mutation.release(); rmSync(root, { recursive: true, force: true }); } });
  assert.equal(live.size, 0);
  assert.equal(maximum, 2, "repair/reopen/replacement cannot hide a temporary third source connection");
});

test("bounded baseline slices keep committed query coverage while the canonical writer continues", { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "composed-slices-"));
  const mutation = acquireMutationStore(root);
  const watch = (_path: string, listener: (...args: any[]) => void) => {
    const value: any = new EventEmitter(); value.on("change", listener); value.ready = Promise.resolve(); value.close = () => {}; return value;
  };
  for (let i = 0; i < 260; i++) {
    const id = `sa_slice_${i}`;
    mkdirSync(join(root, "runs", id), { recursive: true });
    writeFileSync(join(root, "runs", id, "meta.json"), JSON.stringify({ id, sessionId: id, cwd: root, status: "completed", startedAt: i }));
  }
  const model = new WorkReadModel(root, "slices", { baseDir: root, durableDir: join(root, "durable"), supervisorDirectory: join(root, "supervisor"), intervalMs: 60000, watch });
  let running = true, writes = 0;
  let writeError: unknown;
  const writer = () => {
    if (!running) return;
    try {
      mutation.store.cancellationRuntimeEpoch(`writer-${++writes}`);
      const snapshot = model.snapshot();
      assert.equal(snapshot.totalMatching, (model as any).projected.size, "query must serve only committed projection coverage during repair");
    } catch (error) { writeError = error; running = false; return; }
    setImmediate(writer);
  };
  setImmediate(writer);
  try {
    await model.reconcile();
    running = false;
    assert.equal(writeError, undefined);
    assert.ok(writes > 1, "canonical writer must complete multiple commits across bounded observation slices");
    assert.equal(model.snapshot().status, "ready", model.snapshot().reason);
    assert.equal(model.snapshot().totalMatching, 260);
    assert.equal((model as any).reader.changeMetrics.pending, 0, "baseline acknowledgement cannot outrun completed coverage");
  } finally { running = false; await model.close(); mutation.release(); rmSync(root, { recursive: true, force: true }); }
});
