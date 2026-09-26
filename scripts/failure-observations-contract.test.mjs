import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const targets = [
  "packages/pi-better-subagents/shared-failure-observations.ts",
  "packages/pi-better-background-tasks/src/shared-failure-observations.ts",
];

test("both failure consumers ship the same shared observation implementation", () => {
  const expected = "// Generated from packages/failure-observations/index.ts. Do not edit directly.\n" +
    readFileSync(resolve(root, "packages/failure-observations/index.ts"), "utf8");
  for (const target of targets) assert.equal(readFileSync(resolve(root, target), "utf8"), expected, target);
});

for (const target of targets) {
  test(`${target}: failures survive unrelated success and replay; delivery requires a receipt`, async () => {
    const core = await import(resolve(root, target));
    const failure = { id: "tsc:attempt-1", operation: "project:tsc", kind: "failure", summary: "TypeScript exited 2" };
    let state = core.reduceFailure(core.emptyFailureState(), failure, 1000);
    state = core.reduceFailure(state, { id: "git:attempt-1", operation: "project:git", kind: "recovered", incidents: [failure.id] }, 2000);
    assert.match(core.formatFailureSummary(state), /TypeScript exited 2/);
    state = JSON.parse(JSON.stringify(state));
    const pending = core.pendingFailureAttention(state, 100_000);
    assert.deepEqual(pending.incidents, [failure.id]);
    assert.deepEqual(core.pendingFailureAttention(state, 100_001), pending);
    state = core.reduceFailure(state, { id: "notification:receipt", operation: "notification", kind: "delivered", incidents: pending.incidents }, 100_002);
    assert.equal(core.pendingFailureAttention(state, 100_003), undefined);
    assert.match(core.formatFailureSummary(state), /TypeScript exited 2/, "delivery is not recovery");
    state = core.reduceFailure(state, { id: "tsc:attempt-2", operation: failure.operation, kind: "recovered", incidents: [failure.id] }, 100_004);
    assert.equal(core.formatFailureSummary(state), "");
    assert.deepEqual(core.reduceFailure(state, failure, 100_005), state, "replay cannot undo recovery");
  });
}
