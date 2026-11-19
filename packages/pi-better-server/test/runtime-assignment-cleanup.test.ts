import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createLocalSupervisor, supervisorTaskIdForToken } from "../../pi-better-background-tasks/src/supervisor/index.ts";
import { acquireMutationStore } from "../src/runtime/mutation-store.ts";
import { RuntimeResultSupervision } from "../src/runtime/result-supervision.ts";

test("restarted supervision stops only the committed assignment's runner", { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "assignment-cleanup-"));
  const directory = join(root, "supervisor");
  const supervisor = createLocalSupervisor({ directory });
  const lease = acquireMutationStore(root);
  const owner = { kind: "worker-conversation", sessionId: "shared-conversation", workspace: root };
  const recipient = { kind: "parent-session", sessionId: "parent", workspace: root };
  const tasks = ["ending", "independent"].map(id => ({ id, token: `token-${id}`, taskId: supervisorTaskIdForToken(`token-${id}`) }));
  let host: RuntimeResultSupervision | undefined;
  try {
    for (const { id, token, taskId } of tasks) {
      lease.store.registerAssignment({ assignmentId: id, attemptId: `attempt-${id}`, owner, recipient });
      lease.store.registerOperation({ operationId: id, taskId, launchToken: token, owner, assignmentAttemptId: `attempt-${id}`,
        observer: { kind: "local-supervisor", version: "1" }, supervision: { hostId: "original" }, authorityRef: "test" });
      lease.store.handoffResultSupervision({ operationId: id, expectedHostId: "original", directory,
        hostId: "server:previous", epoch: "previous",
        capability: { adapter: "background-results-v1", captured: { authorized: true }, current: { authorized: true } } });
      await supervisor.start({ operationId: id, token, cwd: root, argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] });
    }
    assert.deepEqual(lease.store.listAssignmentCleanupOperations(10), []);
    lease.store.recordAssignmentOutcome({ assignmentId: "ending", revision: 1, owner, recipient, outcome: "succeeded",
      reason: "Done", processUncertain: false, evidence: [], waits: [] });
    host = new RuntimeResultSupervision(root, "replacement");
    const deadline = Date.now() + 8000;
    while (lease.store.getOperation("ending").terminalRevision === 0 && Date.now() < deadline) await delay(25);
    assert.equal(lease.store.getOperation("ending").terminalOutcome, "cancelled", host.reason);
    assert.equal(supervisor.inspect(tasks[0]!.taskId)?.result?.groupCleanup, "empty");
    assert.equal(supervisor.inspect(tasks[1]!.taskId)?.terminal, false);
    assert.equal(lease.store.getOperation("independent").terminalRevision, 0);
    assert.deepEqual(lease.store.listAssignmentCleanupOperations(10), []);
  } finally {
    host?.close();
    for (const { taskId, token } of tasks) await supervisor.stop(taskId, { token }).catch(() => undefined);
    lease.release();
    rmSync(root, { recursive: true, force: true });
  }
});