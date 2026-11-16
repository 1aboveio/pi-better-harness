import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { WorkReadModel } from "../src/runtime/read-model.ts";
const { openStore } = await import(new URL("../src/runtime/domain/subagents/shared-operation-coordinator/index.domain.mjs", import.meta.url).href);

for (const crash of ["none", "before-apply", "after-apply", "retry", "unverified"]) test(`assignment receipt uses indexed dispatch and recovers ${crash}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "assignment-changes-"));
  const agent = join(root, "agent"), baseDir = join(root, "raw");
  mkdirSync(agent); mkdirSync(join(baseDir, "runs"), { recursive: true });
  const store = openStore({ path: join(agent, "operation-coordinator.sqlite") });
  const owner = { kind: "worker-conversation" as const, sessionId: "worker", workspace: root };
  const recipient = { kind: "parent-session" as const, sessionId: "parent", workspace: root };
  for (const id of ["a", "b"]) {
    store.registerAssignment({ assignmentId: id, owner, recipient });
    store.recordAssignmentOutcome({ assignmentId: id, owner, recipient, revision: 1, outcome: "failed", reason: "test", evidence: [], waits: [], processUncertain: false });
    mkdirSync(join(baseDir, "runs", id));
    writeFileSync(join(baseDir, "runs", id, "meta.json"), JSON.stringify({ id, cwd: root, sessionId: "worker", status: "completed", startedAt: 1,
      assignment: { assignmentId: id, owner, recipient }, callbackOrigin: { cwd: root, sessionId: "parent" } }));
  }
  const createModel = () => new WorkReadModel(agent, "test", { baseDir, durableDir: join(root, "archive"), intervalMs: 60000 });
  let model = createModel();
  try {
    await model.reconcile(); await model.reconcile();
    const before = model.metrics;
    const b = model.snapshot({ id: "b" }).rows[0]!.sourceRevision;
    const scopeB = model.snapshot({ id: "b" }).scopeRevision;
    const scopeA = model.snapshot({ id: "a" }).scopeRevision;
    const read = (model as any).reader.read.bind((model as any).reader);
    if (crash === "unverified") (model as any).reader.read = () => ({ verified: false, waits: [], reason: "injected unavailable source" });
    if (crash === "before-apply" || crash === "retry") (model as any).db.exec("CREATE TRIGGER fail_projection BEFORE UPDATE ON rows BEGIN SELECT RAISE(ABORT,'injected application crash'); END");
    if (crash === "after-apply") (model as any).reader.acknowledgeChanges = () => { throw new Error("injected post-application crash"); };
    store.receiptAssignmentOutcome({ assignmentId: "a", recipient, revision: 1, entryId: "entry" });
    await model.reconcile(false);
    if (crash === "retry" || crash === "unverified") {
      assert.equal(model.snapshot().status, "degraded");
      assert.equal(model.metrics.assignments.pending, 1);
      if (crash === "retry") (model as any).db.exec("DROP TRIGGER fail_projection");
      else (model as any).reader.read = read;
      await model.reconcile(false);
      assert.equal(model.snapshot().status, "ready");
    }
    if (!["none", "retry", "unverified"].includes(crash)) {
      assert.equal(model.metrics.assignments.pending, 1);
      assert.equal(model.snapshot().status, "degraded");
      await model.close(); model = createModel();
      await model.reconcile();
      assert.equal(model.metrics.assignments.pending, 0);
      assert.equal(model.snapshot({ id: "a" }).rows[0]!.recipientPending, false);
      assert.equal(model.snapshot({ id: "b" }).rows[0]!.sourceRevision, b);
      return;
    }
    assert.equal(model.metrics.assignmentProjections - before.assignmentProjections, 1);
    if (crash === "none") {
      assert.equal(model.snapshot({ id: "b" }).scopeRevision, scopeB, "parent scope routing preserves unrelated assignment scopes");
      assert.notEqual(model.snapshot({ id: "a" }).scopeRevision, scopeA);
    }
    assert.equal(model.metrics.inventories, before.inventories, "indexed receipt dispatch must not scan the source inventory");
    assert.equal(model.snapshot({ id: "b" }).rows[0]!.sourceRevision, b);
    assert.equal(model.metrics.logProjections, before.logProjections);
    assert.equal(model.metrics.assignments.pending, 0);
    const unrelated = model.metrics.assignmentProjections;
    store.setUpgradeFence("unrelated");
    await model.reconcile();
    assert.equal(model.metrics.assignmentProjections, unrelated);
  } finally { await model.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("bounded baseline hands off continuous receipts and rebuilds a truncated journal without false ready", async () => {
  const root = mkdtempSync(join(tmpdir(), "assignment-baseline-"));
  mkdirSync(join(root, "runs"));
  const store = openStore({ path: join(root, "operation-coordinator.sqlite") });
  const owner = { kind: "worker-conversation", sessionId: "worker", workspace: root };
  const recipient = { kind: "parent-session", sessionId: "parent", workspace: root };
  store.registerAssignment({ assignmentId: "target", owner, recipient });
  store.recordAssignmentOutcome({ assignmentId: "target", owner, recipient, revision: 1, outcome: "failed", reason: "fixture", evidence: [], waits: [], processUncertain: false });
  for (let i = 0; i < 260; i++) {
    const id = `attempt_${i}`;
    mkdirSync(join(root, "runs", id));
    writeFileSync(join(root, "runs", id, "meta.json"), JSON.stringify({ id, sessionId: "worker", cwd: root, status: "completed", startedAt: i,
      ...(i === 259 ? { assignment: { assignmentId: "target", owner, recipient } } : {}) }));
  }
  const model = new WorkReadModel(root, "baseline", { baseDir: root, durableDir: join(root, "archive"), intervalMs: 60000 });
  const source = new DatabaseSync(join(root, "operation-coordinator.sqlite"));
  try {
    await model.reconcile(false);
    assert.equal(model.snapshot().status, "rebuilding");
    assert.equal(model.metrics.assignments.applied, 0);
    store.receiptAssignmentOutcome({ assignmentId: "target", recipient, revision: 1, entryId: "during-baseline" });
    for (let page = 0; page < 20 && model.snapshot().status !== "ready"; page++) await model.reconcile(false);
    assert.equal(model.snapshot().status, "ready");
    assert.equal(model.snapshot({ id: "attempt_259" }).rows[0]!.recipientPending, false);
    source.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4200)
      INSERT INTO assignment_changes(entity,assignment_id,session_id,workspace) SELECT 'receipt','target','worker',? FROM n`).run(root);
    const repairs = model.metrics.assignments.repairs;
    await model.reconcile(false);
    assert.equal(model.snapshot().status, "rebuilding");
    assert.equal(model.metrics.assignments.repairs, repairs + 1);
    assert.equal(model.metrics.assignments.applied, 0);
    for (let page = 0; page < 20 && model.snapshot().status !== "ready"; page++) await model.reconcile(false);
    assert.equal(model.snapshot().status, "ready");
    assert.equal(model.metrics.assignments.pending, 0);
    source.exec("UPDATE schema_meta SET value='999' WHERE key='schema_version'");
    await model.reconcile(false);
    assert.equal(model.snapshot().status, "degraded");
    source.exec("UPDATE schema_meta SET value='4' WHERE key='schema_version'; DROP TABLE assignment_change_source");
    const compatibility = model.metrics.scheduling.repairEntries;
    await model.reconcile(false);
    assert.equal(model.snapshot().status, "rebuilding");
    assert.ok(model.metrics.scheduling.repairEntries - compatibility <= 128, "legacy sources share the bounded repair budget");
    for (let page = 0; page < 20 && model.snapshot().status !== "ready"; page++) await model.reconcile(false);
    assert.equal(model.snapshot().status, "ready");
  } finally { await model.close(); source.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
