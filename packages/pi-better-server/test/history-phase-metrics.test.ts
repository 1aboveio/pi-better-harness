import test from "node:test";
import assert from "node:assert/strict";
import { historyPhaseMetrics } from "./support/history-phase-metrics.ts";
const { AssignmentInbox } = await import(new URL("../../operation-coordinator/assignment-inbox.mjs", import.meta.url).href);

test("history cleanup phase retains explicit unavailable metrics after the actual SQLite owner closes", () => {
  const inbox = new AssignmentInbox(":memory:");
  assert.equal((historyPhaseMetrics(inbox) as any).pending, 0);
  inbox.close();
  assert.throws(() => inbox.metrics, /database is not open/);
  assert.deepEqual(historyPhaseMetrics(inbox), { unavailable: "database is not open" });
  assert.equal(historyPhaseMetrics(), undefined);
});

test("failed diagnostic sample cannot replace the original failure", () => {
  const source = { get metrics() { throw new Error("retired metric owner"); } };
  const original = new Error("original history assertion");
  assert.throws(() => {
    try { throw original; }
    finally { assert.deepEqual(historyPhaseMetrics(source), { unavailable: "retired metric owner" }); }
  }, error => error === original);
});
