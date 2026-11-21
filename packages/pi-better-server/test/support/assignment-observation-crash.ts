import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkReadModel } from "../../src/runtime/read-model.ts";
const { openStore } = await import(new URL("../../../operation-coordinator/index.ts", import.meta.url).href);
const [root, boundary] = process.argv.slice(2) as [string, string];
mkdirSync(join(root, "runs", "attempt"), { recursive: true });
const owner = { kind: "worker-conversation", sessionId: "worker", workspace: root };
const recipient = { kind: "parent-session", sessionId: "parent", workspace: root };
const store = openStore({ path: join(root, "operation-coordinator.sqlite") });
store.registerAssignment({ assignmentId: "assignment", owner, recipient });
store.recordAssignmentOutcome({ assignmentId: "assignment", owner, recipient, revision: 1, outcome: "failed", reason: "fixture", evidence: [], waits: [], processUncertain: false });
writeFileSync(join(root, "runs", "attempt", "meta.json"), JSON.stringify({ id: "attempt", sessionId: "worker", cwd: root, status: "completed", startedAt: 1, assignment: { assignmentId: "assignment", owner, recipient } }));
const model = new WorkReadModel(root, "crashing-reader", { baseDir: root, durableDir: join(root, "archive"), intervalMs: 60000 });
await model.reconcile();
store.receiptAssignmentOutcome({ assignmentId: "assignment", recipient, revision: 1, entryId: "receipt" });
const internal = model as any;
if (boundary === "before-receive") process.exit(23);
if (boundary === "after-receive") {
  const changes = internal.reader.changes.bind(internal.reader);
  internal.reader.changes = () => { changes(); process.exit(23); };
}
if (boundary === "before-apply") {
  internal.db.function("crash", () => process.exit(23));
  internal.db.exec("CREATE TRIGGER crash_before_apply BEFORE UPDATE ON rows BEGIN SELECT crash(); END");
}
if (boundary === "after-apply") internal.reader.acknowledgeChanges = () => process.exit(23);
await model.reconcile(false);
throw new Error(`Crash boundary was not reached: ${boundary}`);
