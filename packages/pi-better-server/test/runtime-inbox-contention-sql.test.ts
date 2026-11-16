import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkReadModel } from "../src/runtime/read-model.ts";
const { openDatabase, createContext } = await import(new URL("../../operation-coordinator/src/sqlite.ts", import.meta.url).href);
const { ensureSchema } = await import(new URL("../../operation-coordinator/src/schema.ts", import.meta.url).href);
const { ensureAssignmentChanges } = await import(new URL("../../operation-coordinator/src/assignment-changes.ts", import.meta.url).href);

test("actual read models open under a derived reservation and refresh under a coordinator WAL writer", async () => {
  const root = mkdtempSync(join(tmpdir(), "model-sql-contention-"));
  const source = openDatabase(join(root, "operation-coordinator.sqlite"), { busyTimeoutMs: 0 });
  const ctx = createContext(source); ensureSchema(ctx); ensureAssignmentChanges(ctx);
  const options = { baseDir: join(root, "runs"), durableDir: join(root, "archive"), intervalMs: 60000 };
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
