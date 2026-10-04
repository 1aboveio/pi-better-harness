import assert from "node:assert/strict";
import test from "node:test";
import { isPermissionBlocker, permissionBlockerKey, type PermissionBlocker } from "./permission-blocker.ts";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyFailureState, reduceFailure, observeFailures, readFailureState, actionablePermissionBlockers,
  failureRevision, formatFailureLines, incidentCursorAt, pageFailureIncidents, type FailureEvent } from "./index.ts";

const report: PermissionBlocker = { version: 1, kind: "permission-blocker", context: "worker",
  resource: "credential-files", basis: "agent-reported", operation: "credential-cache",
  remoteOutcome: "unknown", incidentId: "tool:cache", runId: "sa_fixture" };

test("strict permission contract rejects malformed claims and raw command/path payloads", () => {
  assert.equal(isPermissionBlocker(report), true);
  for (const bad of [null, [], {}, { ...report, version: 2 }, { ...report, resource: "IAM" },
    { ...report, remoteOutcome: "succeeded" }, { ...report, basis: "stdout" },
    { ...report, context: "parent" }, { ...report, operation: "cat /secret/auth.json" },
    { ...report, operation: "/secret/auth.json" }, { ...report, runId: "/secret/run" },
    { ...report, incidentId: null }, { ...report, argv: ["secret"] }, { ...report, token: "secret" }]) {
    assert.equal(isPermissionBlocker(bad), false, JSON.stringify(bad));
  }
});

test("stable key ignores object property order but separates context, resource and run", () => {
  const reversed = Object.fromEntries(Object.entries(report).reverse());
  assert.equal(permissionBlockerKey(report), permissionBlockerKey(reversed as PermissionBlocker));
  for (const other of [{ ...report, context: "foreground" as const }, { ...report, runId: "sa_new" },
    { ...report, resource: "process-inspection" as const }, { ...report, operation: "new-operation" }]) {
    assert.notEqual(permissionBlockerKey(report), permissionBlockerKey(other));
  }
});

test("permission incident references admit bounded Responses SDK ids without widening operation identity", () => {
  const incidentId = "tool:call_9Az0|fc_01aB23";
  assert.equal(isPermissionBlocker({ ...report, incidentId }), true);
  assert.equal(isPermissionBlocker({ ...report, incidentId: "t".repeat(200) }), true);
  for (const incidentId of ["t".repeat(201), "tool:/secret/auth.json", "tool:call|../secret", "tool:call|free form", "tool:call\nitem"]) {
    assert.equal(isPermissionBlocker({ ...report, incidentId }), false);
  }
  for (const field of ["operation", "runId", "policySnapshotId"]) {
    assert.equal(isPermissionBlocker({ ...report, [field]: "call_9Az0|fc_01aB23" }), false, field);
  }
});

test("permission annotations preserve full evidence and recovery history but compact rows do not leak raw fields", () => {
  const failure: FailureEvent = { id: report.incidentId!, kind: "failure", operation: report.operation, category: "tool",
    summary: "EPERM /fixture/private-cache token=private-token", evidence: "/fixture/private-run/output.log#byte=42" };
  let state = reduceFailure(emptyFailureState(), failure, 1000);
  state = reduceFailure(state, { ...failure, id: "second-failure" }, 1100);
  const open: FailureEvent = { id: "open", kind: "disposition", operation: "disposition", disposition: "open",
    reason: "inspect /fixture/private-reason", evidence: "private-proof", incidents: [failure.id], permissionBlockers: [report] };
  state = reduceFailure(state, open, 1200);
  const [compact] = formatFailureLines(state);
  assert.match(compact!, /Worker permission blocker: credential-files/);
  assert.match(compact!, /2 occurrences/);
  assert.match(compact!, /fresh launch/);
  assert.doesNotMatch(compact!, /private-cache|private-token|private-run|private-reason|private-proof/);
  const [full] = formatFailureLines(state, { scope: "all", detail: "full" });
  for (const retained of [failure.summary!, failure.evidence!, open.reason!, open.evidence!, "2 occurrences", "Worker permission blocker"]) {
    assert.ok(full!.includes(retained), `full evidence retains ${retained}`);
  }
  state = reduceFailure(state, { id: "recovery", kind: "recovered", operation: report.operation, incidents: [failure.id] }, 1300);
  assert.deepEqual(formatFailureLines(state), []);
  for (const detail of ["compact", "full"] as const) {
    const [history] = formatFailureLines(state, { scope: "all", detail });
    assert.match(history!, /Recovered/);
    assert.match(history!, /Worker permission blocker/);
    assert.doesNotMatch(history!, /fresh launch/);
  }
  const history = pageFailureIncidents(state, { scope: "all", detail: "full", maxBytes: 4096 });
  assert.equal(history.hasMore, false);
  assert.ok(history.text.includes(failure.summary!));
  assert.ok(history.text.includes(failure.evidence!));
  assert.ok(history.text.includes(open.reason!));
  assert.ok(history.text.includes(open.evidence!));
});

test("permission disposition changes poll and incident cursors without changing failure evidence", () => {
  const failure: FailureEvent = { id: "tool:cache", kind: "failure", operation: report.operation, category: "tool", summary: "EPERM", at: 1000 };
  let state = reduceFailure(emptyFailureState(), failure, 1000);
  const revision = failureRevision(state);
  const cursor = incidentCursorAt(state, 0, "fixture", { scope: "all" });
  state = reduceFailure(state, { id: "d", kind: "disposition", operation: "disposition", disposition: "open",
    reason: "permission", incidents: [failure.id], permissionBlockers: [report] }, 2000);
  assert.notEqual(failureRevision(state), revision, "a same-log-size status poll must see newly actionable metadata");
  assert.equal(pageFailureIncidents(state, { cursor, resource: "fixture", scope: "all" }).reset, "source-replaced");
  assert.equal(state.observations[Object.keys(state.observations)[0]!]!.status, "unresolved");
});

test("malformed or misbound permission metadata is rejected whole and durable replay retains history", t => {
  const dir = mkdtempSync(join(tmpdir(), "permission-journal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "failures.jsonl");
  const failure: FailureEvent = { id: "tool:cache", kind: "failure", operation: report.operation, category: "tool", summary: "synthetic EPERM" };
  const state = observeFailures(path, [failure], 1000);
  const open: FailureEvent = { id: "d", kind: "disposition", operation: "disposition", disposition: "open",
    reason: "permission", incidents: [failure.id], permissionBlockers: [report] };
  for (const change of [{ context: "foreground" }, { remoteOutcome: "not-started" }, { operation: "other" },
    { basis: "policy-refusal" }, { incidentId: "missing" }, { policySnapshotId: "unproven" }]) {
    const bad = { ...open, permissionBlockers: [{ ...report, ...change }] } as FailureEvent;
    assert.deepEqual(reduceFailure(state, bad, 2000), state);
    assert.deepEqual(observeFailures(path, [bad], 2000), state);
  }
  observeFailures(path, [open], 2000);
  const records = readFileSync(path, "utf8");
  // Append the same event again, as an at-least-once producer might after a restart.
  appendFileSync(path, records.split("\n").filter(Boolean).at(-1)! + "\n");
  assert.equal(actionablePermissionBlockers(readFailureState(path)).length, 1);
  assert.equal(Object.values(readFailureState(path).observations).length, 1, "duplicate replay is not an observation gap");
  observeFailures(path, [{ id: "authorized", kind: "recovered", operation: report.operation, incidents: [failure.id] }], 3000);
  assert.deepEqual(actionablePermissionBlockers(readFailureState(path)), []);
  assert.deepEqual(Object.values(readFailureState(path).observations)[0]!.permissionBlockers, [report]);
});
