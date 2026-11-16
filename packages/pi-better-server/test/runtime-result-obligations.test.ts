import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeResultSupervision } from "../src/runtime/result-supervision.ts";

const { openStore } = await import(new URL("../../operation-coordinator/index.ts", import.meta.url).href);

test("unavailable result authority has a bounded verification obligation, not a permanent lease", t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const root = mkdtempSync(join(tmpdir(), "result-obligations-"));
  const store = openStore({ path: join(root, "operation-coordinator.sqlite") });
  let supervisor: RuntimeResultSupervision | undefined;
  try {
    const owner = { kind: "parent-session", sessionId: "exact-parent", workspace: root };
    store.registerOperation({ operationId: "operation", taskId: "task", launchToken: "token", owner,
      observer: { kind: "local-supervisor", version: "1" }, supervision: { hostId: "frontend" } });
    store.handoffResultSupervision({ operationId: "operation", expectedHostId: "frontend",
      directory: join(root, "captured"), hostId: "server:old", epoch: "old" });
    supervisor = new RuntimeResultSupervision(root, "new", 1000);
    assert.equal(supervisor.livenessReasons().length, 1);
    assert.equal(supervisor.manages("operation"), true);
    assert.equal(supervisor.manages("foreign"), false);
    assert.equal(supervisor.livenessReasons()[0].nextDeadline, 2000);
    assert.deepEqual(supervisor.livenessReasons()[0].owner, { ...owner, branchId: null, goalId: null });
    assert.match(supervisor.reason!, /permission-unavailable/);
    t.mock.timers.tick(1000);
    assert.deepEqual(supervisor.livenessReasons(), []);
    assert.match(supervisor.reason!, /permission-unavailable/);
    const inspections = supervisor.metrics.inspections;
    for (let i = 0; i < 4; i++) { t.mock.timers.tick(1000); supervisor.reconcile(); }
    assert.equal(supervisor.metrics.inspections, inspections);
    assert.equal(store.getOperation("operation")?.terminalRevision, 0, "no invented terminal result");
    assert.equal(store.resultSupervision("operation")?.epoch, "old", "unavailable permissions never transfer authority");
    store.recordTerminalOutcome({ operationId: "operation", owner, outcome: "succeeded", eventId: "terminal",
      evidence: [{ kind: "terminal-record", ref: join(root, "result") }] });
    supervisor.reconcile();
    assert.equal(supervisor.manages("operation"), false, "terminal authority clears the active obligation");
    assert.deepEqual(supervisor.livenessReasons(), []);
    assert.equal(store.resultSupervisions().length, 1, "retained history does not become a lease");
  } finally { supervisor?.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
