import test from "node:test";
import assert from "node:assert/strict";
const domain = "../src/runtime/domain/subagents/";
const { recoverLaunchMetadata } = await import(domain + "managed-launch-recovery.domain.mjs");
const management = { root: "/runtime", instance: "replacement", epoch: 2 };
const frozen = { id: "sa_recovery_1", sessionId: "sa_recovery_1", status: "running", pid: 0,
  spawnPid: 100, spawnPidStartTime: "original-parent", cwd: "/workspace", startedAt: 1,
  promptPreview: "original task", logPath: "/runtime/attempt.log", management: { ...management, epoch: 1 },
  recipe: { cwd: "/workspace", tools: "read" }, assignment: { assignmentId: "original-assignment" } };
const attempt = { id: frozen.id, sessionId: frozen.sessionId, lease: "lease-token", recoveryMeta: frozen };
const evidence = { pidExists: () => true, startToken: () => "writer-start",
  lease: () => ({ token: "lease-token", attemptId: frozen.id }) };

test("fenced pre-bootstrap attempt becomes lost without inventing a writer or changing its owner", () => {
  const recovered = recoverLaunchMetadata(attempt, management, evidence, 200);
  assert.equal(recovered.status, "lost"); assert.equal(recovered.pid, 0);
  assert.equal(recovered.endedAt, 200); assert.equal(recovered.spawnPid, 100);
  assert.deepEqual(recovered.assignment, frozen.assignment);
  assert.deepEqual(recovered.recipe, frozen.recipe);
});

test("bootstrapped writer recovery preserves exact process identity and original launch snapshot", () => {
  const recovered = recoverLaunchMetadata({ ...attempt, bootstrapped: true, writerPid: 200, writerStartTime: "writer-start" }, management, evidence, 200);
  assert.equal(recovered.status, "running"); assert.equal(recovered.pid, 200);
  assert.equal(recovered.pidStartTime, "writer-start"); assert.equal(recovered.pgid, 200);
  assert.equal(recovered.spawnPidStartTime, "original-parent");
  assert.deepEqual(recovered.management, management);
  assert.equal(recovered.supervisionInterruptedReason, "runtime-launch-recovery");
});

test("unknown live writer or changed writer authority refuses recovery", () => {
  const live = { ...attempt, bootstrapped: true, writerPid: 200, writerStartTime: "writer-start" };
  assert.throws(() => recoverLaunchMetadata({ ...live, writerStartTime: undefined }, management, evidence), /writer-identity-unknown/);
  assert.throws(() => recoverLaunchMetadata(live, management, { ...evidence, startToken: () => undefined }), /writer-identity-unknown/);
  assert.throws(() => recoverLaunchMetadata(live, management, { ...evidence, lease: () => undefined }), /writer-authority-unknown/);
  assert.throws(() => recoverLaunchMetadata({ ...attempt, recoveryMeta: undefined }, management, evidence), /recovery-evidence-missing/);
});

test("dead or recycled writer retains its old identity for ordinary log and group reconciliation", () => {
  const live = { ...attempt, bootstrapped: true, writerPid: 200, writerStartTime: "old-writer" };
  for (const probe of [{ ...evidence, pidExists: () => false }, evidence]) {
    const recovered = recoverLaunchMetadata(live, management, { ...probe, lease: () => undefined });
    assert.equal(recovered.pidStartTime, "old-writer");
    assert.equal(recovered.status, "running");
  }
});
