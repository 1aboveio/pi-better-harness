import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { startTaskExpiry } from "../src/runtime/task-expiry.ts";
import { acquireMutationStore } from "../src/runtime/mutation-store.ts";

test("startup fails expired work once, cancels expired waits and preserves newer work and completed results", t => {
  const root = mkdtempSync(join(tmpdir(), "task-expiry-"));
  const control = acquireMutationStore(root);
  t.after(() => { control.release(); rmSync(root, { recursive: true, force: true }); });
  const { store } = control;
  const owner = { kind: "parent-session", workspace: root, sessionId: "parent" };
  for (const operationId of ["expired", "fresh", "finished"]) {
    store.registerOperation({ operationId, taskId: operationId, launchToken: operationId, owner, observer: { kind: "test", version: "1" } });
  }
  const { wait } = store.registerWait({ waitId: "old-wait", owner, dependencies: [{ operationId: "expired" }], continuationNote: "Read result" });
  store.recordTerminalOutcome({ operationId: "finished", owner, eventId: "finished", outcome: "succeeded", reason: "already finished" });
  const db = new DatabaseSync(join(root, "operation-coordinator.sqlite"));
  const cutoff = Date.now() - 24 * 60 * 60_000;
  try {
    db.prepare("UPDATE operations SET created_at = ? WHERE operation_id != 'fresh'").run(cutoff);
    db.prepare("UPDATE waits SET created_at = ?").run(cutoff);
  } finally { db.close(); }
  const errors: string[] = [];
  for (let i = 0; i < 2; i++) startTaskExpiry(control, message => errors.push(message))();
  assert.deepEqual(errors, []);
  const expired = store.getOperation("expired");
  assert.equal(expired.terminalRevision, 1);
  assert.equal(expired.terminalOutcome, "failed");
  assert.match(expired.terminalReason, /24-hour/);
  assert.equal(store.getOperation("fresh").phase, "running");
  assert.equal(store.getOperation("finished").terminalOutcome, "succeeded");
  assert.equal(store.getWait(wait).phase, "cancelled");
  assert.equal(store.getWait(wait).cancelEpoch, 1);
});
