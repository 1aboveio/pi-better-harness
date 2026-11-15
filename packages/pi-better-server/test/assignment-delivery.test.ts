import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv } from "./helpers.ts";
import { AssignmentDelivery } from "../src/runtime/assignment-delivery.ts";
import { acquireMutationStore, mutationStoreMetrics } from "../src/runtime/mutation-store.ts";

test("fixed recipient delivery refuses foreign scopes and receipts never consume retained outcomes", () => {
  const env = makeEnv();
  const lease = acquireMutationStore(env.agentDir);
  const recipient = { kind: "parent-session" as const, sessionId: "parent", workspace: env.agentDir, branchId: "branch", goalId: "goal" };
  const owner = { ...recipient, kind: "worker-conversation", sessionId: "worker" };
  const port = new AssignmentDelivery(env.agentDir, recipient);
  try {
    lease.store.registerAssignment({ assignmentId: "assignment", owner, recipient });
    lease.store.recordAssignmentOutcome({ assignmentId: "assignment", owner, recipient, revision: 1,
      outcome: "failed", reason: "fixture", evidence: [], waits: [], processUncertain: false });
    for (const field of ["sessionId", "workspace", "branchId", "goalId"]) {
      const foreign = new AssignmentDelivery(env.agentDir, { ...recipient, [field]: "foreign" });
      try { assert.throws(() => foreign.get("assignment"), /recipient-refused/); }
      finally { foreign.close(); }
    }
    assert.equal(port.get("assignment").disposition, null);
    const receipt = port.receipt("assignment", 1, "transcript-entry");
    assert.deepEqual(port.receipt("assignment", 1, "transcript-entry"), receipt);
    assert.equal(port.get("assignment").disposition, null);
    assert.deepEqual(mutationStoreMetrics(env.agentDir), { active: 1, leases: 2 });
  } finally { port.close(); lease.release(); }
});
