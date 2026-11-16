import assert from "node:assert/strict";
import test from "node:test";

test("fixed Server launch domain refuses waits without terminal interpretation capabilities", async () => {
  const domain = "../src/runtime/domain/subagents/";
  const { planWorkerBridgeTools } = await import(domain + "worker-waits.domain.mjs");
  assert.throws(() => planWorkerBridgeTools({ allow: ["wait_for_operations", "bg_task_status"], excluded: [], clean: false, explicitTools: true }),
    /wait_for_operations.*requires/);
  const plan = planWorkerBridgeTools({ allow: ["wait_for_operations", "bg_task_status", "acknowledge_operation_result"], excluded: [], clean: false, explicitTools: true });
  assert.equal(plan.capabilities.wait, true);
  assert.equal(plan.capabilities.acknowledge, true);
});

test("fixed Server launch domain carries the original deadline to the child", async () => {
  const domain = "../src/runtime/domain/subagents/";
  const { childEnvironment } = await import(domain + "worker-waits.domain.mjs");
  const { readChildOperationBridgeConfig } = await import(domain + "child-operations.domain.mjs");
  const deadlineAt = Date.now() + 30000;
  const result = readChildOperationBridgeConfig(childEnvironment("a".repeat(43), "unix:///tmp/completion-fixture.sock", {
    runId: "deadline-fixture", conversationId: "deadline-fixture", attemptId: "deadline-fixture", policy: { deadlineAt },
  }));
  assert.equal(result.status, "ready");
  assert.equal(result.config.deadlineAt, deadlineAt);
});
