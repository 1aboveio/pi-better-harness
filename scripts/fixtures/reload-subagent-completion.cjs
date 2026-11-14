// The fake CLI models a worker making an explicit decision over checked output.
// Use the real store contracts; agent_end and answer prose are not that decision.
require("tsx/cjs");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { readMeta } = require("../../packages/pi-better-subagents/registry.ts");
const { coordinatorPath } = require("../../packages/pi-better-subagents/assignment-outcomes.ts");
const { openStore } = require("../../packages/pi-better-subagents/shared-operation-coordinator/index.ts");

module.exports = function acknowledgeCheckedAnswer(attemptId) {
  const meta = readMeta(attemptId);
  assert.ok(meta?.assignment, "the spawned worker has an immutable assignment");
  const entries = readFileSync(meta.logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(entries.some((entry) => entry.type === "message_end"
    && entry.message?.content?.some((part) => part.type === "text" && part.text === "reload-survives answer")),
  "the requested answer was retained across reload");
  const owner = meta.assignment.owner;
  const operationId = `answer-check-${attemptId}`;
  const store = openStore({ path: coordinatorPath() });
  try {
    store.registerOperation({ operationId, taskId: operationId, launchToken: operationId,
      owner, observer: { kind: "reload-answer-verifier", version: "1" } });
    const terminal = store.recordTerminalOutcome({ operationId, eventId: `checked-${attemptId}`, owner,
      outcome: "succeeded", evidence: [{ kind: "log", ref: meta.logPath, summary: "Exact requested answer checked after parent reload" }] });
    const { wait } = store.registerWait({ owner, dependencies: [{ operationId }], continuationNote: "Interpret answer verification",
      origin: { assignmentRef: meta.assignment.assignmentId, attemptId } });
    store.recordEvidenceRead({ ...wait, owner, operationId, terminalRevision: terminal.operation.terminalRevision });
    store.acknowledgeResult({ ...wait, owner, disposition: "assignment-complete",
      terminalRevisions: [{ operationId, revision: terminal.operation.terminalRevision }], note: "Verified the requested retained answer after reload; assignment complete." });
  } finally { store.close(); }
};
