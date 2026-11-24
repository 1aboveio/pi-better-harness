import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { supervisorDecision, decisionDurationMs } from "../src/runtime/supervisor-decisions.ts";
import { SharedReadDiagnosis } from "../src/runtime/shared-read-diagnosis.ts";

test("three affected owners get one shared read-plane diagnosis; a verified recovery separates recurrences", () => {
  const diagnosis = new SharedReadDiagnosis();
  const first = diagnosis.inspect("degraded", 3)!;
  assert.deepEqual(diagnosis.inspect("degraded", 3), first);
  assert.deepEqual(diagnosis.inspect("degraded", 3), first);
  assert.equal(diagnosis.inspect("ready", 3), undefined);
  assert.notEqual(diagnosis.inspect("degraded", 3)?.id, first.id);
  assert.notEqual(diagnosis.inspect("rebuilding", 4)?.id, first.id);
});

test("one answer survives reopen and is valid only for the exact proposal and trusted workspace", t => {
  const root = mkdtempSync(join(tmpdir(), "pi-decisions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scope = { reference: "deployment-123", operation: "stop observer", host: "r5", resource: "observer-12", effect: "interrupt local watcher" };
  const owner = { sessionId: "a", cwd: root, projectTrusted: true };
  const ask = (sessionId: string, action: string, extra: object = {}, now = 0) =>
    supervisorDecision(root, { ...owner, sessionId }, { scope, action, ...extra }, now);
  const leader = ask("a", "decision-request");
  assert.equal(leader.status, "ask");
  const token = "token" in leader ? leader.token : undefined;
  assert.ok(token);
  assert.equal(ask("b", "decision-request").status, "pending");
  assert.equal(ask("b", "decision-answer", { token, answer: "approved" }).status, "stale");
  assert.equal(ask("a", "decision-answer", { token, answer: "approved" }).status, "approved");
  assert.equal(ask("b", "decision-query").status, "approved");
  for (const field of ["reference", "host", "resource", "effect", "operation"]) {
    assert.equal(ask("a", "decision-query", { scope: { ...scope, [field]: "different" } }).status, "missing");
  }
  assert.equal(supervisorDecision(root, { ...owner, cwd: root + "/different" }, { action: "decision-query", scope }, 0).status, "missing");
  assert.throws(() => supervisorDecision(root, { ...owner, projectTrusted: false }, { action: "decision-query", scope }));
  assert.equal(ask("b", "decision-query", {}, decisionDurationMs + 1).status, "missing");
});
