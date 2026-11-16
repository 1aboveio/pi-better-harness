import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkReadModel } from "../src/runtime/read-model.ts";
const { openStore } = await import(new URL("../../operation-coordinator/index.ts", import.meta.url).href);

test("unsupported assignment schema settles degraded repair and recovers only after source change", async t => {
  const root = mkdtempSync(join(tmpdir(), "unsupported-repair-"));
  const durable = join(root, "durable"), archives = join(durable, "attempts");
  mkdirSync(archives, { recursive: true });
  for (let i = 0; i < 260; i++) {
    const meta = { id: `sa_history_${i}`, sessionId: `conversation-${i}`, cwd: root, status: "completed", startedAt: i,
      assignment: { assignmentId: `history-assignment-${i}` },
      recipe: { version: 1, sessionId: `conversation-${i}`, cwd: root, sessionDir: join(durable, "sessions") } };
    writeFileSync(join(archives, `${meta.id}.json`), JSON.stringify({ version: 1, meta }));
  }
  const store = openStore({ path: join(root, "operation-coordinator.sqlite") });
  const external = new DatabaseSync(join(root, "operation-coordinator.sqlite"));
  const model = new WorkReadModel(root, "unsupported-repair", { baseDir: root, durableDir: durable, intervalMs: 60000 });
  const scan = (model as any).measuredScan.bind(model);
  let scans = 0;
  try {
    await model.reconcile();
    const owner = { kind: "worker-conversation", sessionId: "conversation-1", workspace: root };
    store.registerOperation({ operationId: "history-op", taskId: "history-task", launchToken: "history-token", owner,
      observer: { kind: "background-tasks", version: "1" }, supervision: { hostId: "history-host", runnerId: "history-runner" }, authorityRef: "scope" });
    store.registerWait({ waitId: "history-wait", owner, dependencies: [{ operationId: "history-op" }],
      origin: { attemptId: "sa_history_1", assignmentRef: "history-assignment-1" }, continuationNote: "Interpret evidence." });
    await model.reconcile();
    const decision = { assignmentId: "history-assignment-2", owner: { ...owner, sessionId: "conversation-2" },
      recipient: { kind: "parent-session", sessionId: "parent", workspace: root }, revision: 1,
      outcome: "failed", reason: "Retained diagnosis", evidence: [], waits: [], processUncertain: false };
    store.registerAssignment(decision); store.recordAssignmentOutcome(decision);
    await model.reconcile();
    const verified = model.snapshot();
    assert.equal(verified.status, "ready");
    (model as any).measuredScan = async (...args: any[]) => {
      scans++;
      if (scans > 12) throw new Error("controlled repeated-repair limit");
      return scan(...args);
    };
    external.exec("UPDATE schema_meta SET value='unsupported' WHERE key='schema_version'");
    await model.reconcile();
    t.diagnostic(JSON.stringify({ scans, status: model.snapshot().status, reason: model.snapshot().reason,
      repairEntries: model.metrics.scheduling.repairEntries, projected: model.snapshot().rows.length }));
    assert.equal(scans, 0, "a known unsupported schema must settle without an internal metadata repair walk");
    const degraded = model.snapshot();
    assert.equal(degraded.status, "degraded");
    assert.match(degraded.reason!, /Unsupported assignment source schema/);
    assert.deepEqual(degraded.rows.map(row => row.meta), verified.rows.map(row => row.meta));
    assert.equal(model.snapshot({ id: "sa_history_2" }).rows[0]!.assignment.verified, false);
    const changedPath = join(archives, "sa_history_2.json");
    const oldMeta = model.snapshot({ id: "sa_history_2" }).rows[0]!.meta;
    writeFileSync(changedPath, JSON.stringify({ version: 1, meta: { ...oldMeta, name: "deferred replacement" } }));
    model.fileHint(archives, "sa_history_2.json");
    await model.reconcile(false);
    assert.equal(model.snapshot({ id: "sa_history_2" }).rows[0]!.meta.name, undefined);
    assert.ok((model as any).hints.size > 0, "incompatible source must retain, not discard, pending file work");
    const settled = model.metrics;
    const writes = (model as any).db.prepare("SELECT total_changes() AS n").get().n;
    const settledSeq = degraded.seq;
    for (let i = 0; i < 3; i++) await model.reconcile(false);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal((model as any).pending, undefined);
    assert.equal((model as any).repair, undefined);
    assert.equal(model.metrics.scheduling.repairEntries, settled.scheduling.repairEntries);
    assert.equal(model.snapshot().seq, settledSeq, "unchanged rejected input must not publish idle revisions");
    assert.equal((model as any).db.prepare("SELECT total_changes() AS n").get().n, writes);
    external.exec("UPDATE schema_meta SET value='4' WHERE key='schema_version'");
    await model.reconcile();
    assert.equal(model.snapshot().status, "ready");
    assert.ok(model.snapshot().rows.every(row => row.assignment.verified));
    assert.equal(model.snapshot({ id: "sa_history_2" }).rows[0]!.meta.name, "deferred replacement");
    assert.equal(model.metrics.metadataReads - settled.metadataReads, 1);
    assert.equal(model.metrics.projections - settled.projections, 1);
  } finally {
    (model as any).measuredScan = scan;
    await model.close(); external.close(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});
