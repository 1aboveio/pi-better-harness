import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkReadModel } from "../src/runtime/read-model.ts";
import { LogCheckpoints } from "../src/runtime/log-checkpoints.ts";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
const { openDatabase, createContext } = await import(new URL("../../operation-coordinator/src/sqlite.ts", import.meta.url).href);
const { ensureSchema } = await import(new URL("../../operation-coordinator/src/schema.ts", import.meta.url).href);
const { ensureAssignmentChanges } = await import(new URL("../../operation-coordinator/src/assignment-changes.ts", import.meta.url).href);
const watch = (() => Object.assign(new EventEmitter(), { close() {}, ready: Promise.resolve() })) as any;

test("actual read models open under a derived reservation and refresh under a coordinator WAL writer", async () => {
  const root = mkdtempSync(join(tmpdir(), "model-sql-contention-"));
  const source = openDatabase(join(root, "operation-coordinator.sqlite"), { busyTimeoutMs: 0 });
  const ctx = createContext(source); ensureSchema(ctx); ensureAssignmentChanges(ctx);
  const options = { baseDir: join(root, "runs"), durableDir: join(root, "archive"), intervalMs: 60000, watch };
  const first = new WorkReadModel(root, "sql-first", options);
  let second: WorkReadModel | undefined;
  try {
    (first as any).db.exec("BEGIN IMMEDIATE");
    assert.doesNotThrow(() => { second = new WorkReadModel(root, "sql-second", options); });
    (first as any).db.exec("ROLLBACK");
    await first.reconcile(); await second!.reconcile();
    source.exec("BEGIN IMMEDIATE; INSERT INTO coordinator_state VALUES('held-writer','uncommitted')");
    await first.reconcile(); await second!.reconcile();
    for (const model of [first, second!]) {
      assert.equal(model.snapshot({ background: true, cwd: root, sessionId: "sql-parent" }).status, "ready");
      assert.equal(model.metrics.indexConnections, 1);
      assert.equal(model.backgroundMetrics.changes.queuedHints, 0);
    }
    source.exec("ROLLBACK");
  } finally {
    if ((first as any).db.isTransaction) (first as any).db.exec("ROLLBACK");
    if (source.isTransaction) source.exec("ROLLBACK");
    await second?.close(); await first.close(); source.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint initialization rejects an unknown schema without retaining another handle or attachment", () => {
  const root = mkdtempSync(join(tmpdir(), "checkpoint-schema-"));
  const path = join(root, "checkpoints.sqlite"), seed = new DatabaseSync(path);
  seed.exec("CREATE TABLE checkpoints(path TEXT PRIMARY KEY)"); seed.close();
  const owner = new DatabaseSync(":memory:");
  try {
    assert.throws(() => new LogCheckpoints(path), /Unsupported checkpoint schema/);
    assert.throws(() => new LogCheckpoints(path, owner), /Unsupported checkpoint schema/);
    assert.deepEqual(owner.prepare("PRAGMA database_list").all().map(row => row.name), ["main"]);
  } finally { owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test("failed deferred checkpoint acquisition releases its attachment and shutdown releases the physical owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "checkpoint-owner-failure-"));
  const seed = new DatabaseSync(join(root, "runtime-log-checkpoints.sqlite"));
  seed.exec("CREATE TABLE checkpoints(path TEXT PRIMARY KEY)"); seed.close();
  const sqlite = createRequire(import.meta.url)("node:sqlite"), Original = sqlite.DatabaseSync;
  let active = 0;
  sqlite.DatabaseSync = class extends Original {
    constructor(...args: any[]) { super(...args); active++; }
    close() { super.close(); active--; }
  };
  let model: WorkReadModel | undefined;
  try {
    model = new WorkReadModel(root, "bad-schema", { watch });
    assert.equal(model.metrics.checkpoints.acquisitionAttempts, 0, "construction does not acquire a deferred checkpoint");
    await model.reconcile();
    assert.equal(model.snapshot().status, "degraded");
    assert.match(model.snapshot().reason!, /Unsupported checkpoint schema/);
    assert.equal(model.metrics.checkpoints.contentions, 0, "unknown schema is not safe lock deferral");
    assert.equal((model as any).checkpoints.ready, false);
    assert.deepEqual((model as any).db.prepare("PRAGMA database_list").all().map((row: any) => row.name), ["main", "background_inbox"]);
    await model.close(); model = undefined;
    assert.equal(active, 0);
  } finally { await model?.close(); sqlite.DatabaseSync = Original; rmSync(root, { recursive: true, force: true }); }
});
