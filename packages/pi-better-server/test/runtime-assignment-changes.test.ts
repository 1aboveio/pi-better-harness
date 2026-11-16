import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkReadModel } from "../src/runtime/read-model.ts";
const { openStore } = await import(new URL("../src/runtime/domain/subagents/shared-operation-coordinator/index.domain.mjs", import.meta.url).href);

test("assignment receipt updates only its exact assignment within a shared conversation", async () => {
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
  const model = new WorkReadModel(agent, "test", { baseDir, durableDir: join(root, "archive"), intervalMs: 60000 });
  try {
    await model.reconcile(); await model.reconcile();
    const before = model.metrics;
    const b = model.snapshot({ id: "b" }).rows[0]!.sourceRevision;
    store.receiptAssignmentOutcome({ assignmentId: "a", recipient, revision: 1, entryId: "entry" });
    await model.reconcile();
    assert.equal(model.metrics.assignmentProjections - before.assignmentProjections, 1);
    assert.equal(model.snapshot({ id: "b" }).rows[0]!.sourceRevision, b);
    assert.equal(model.metrics.logProjections, before.logProjections);
    assert.equal(model.metrics.assignments.pending, 0);
    const unrelated = model.metrics.assignmentProjections;
    store.setUpgradeFence("unrelated");
    await model.reconcile();
    assert.equal(model.metrics.assignmentProjections, unrelated);
  } finally { await model.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
