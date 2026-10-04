import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { collectRunFailures, failurePath, resetFailureScanCursor } from "../failures.ts";
import { actionableFailures, failureHistory, incidentCursorAt, incidentResource } from "../shared-failure-observations.ts";
import { failureDispositionTool, intentBashDefinition } from "../child-incidents.ts";
import { readDispositionRequest } from "../incident-model.ts";
import { subagentOutputTool, subagentResultTool } from "../tools.ts";
import { requestScopeKey } from "../output-payload.ts";
import { logPathFor, recordTaskRuntimeProvenance, runDir, taskRuntimeProvenancePath, writeMeta } from "../registry.ts";

const Type = { Object: x => x, String: x => x, Number: x => x, Boolean: x => x, Array: x => x, Optional: x => x };
const start = (id, name, args) => ({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
const end = (id, name, isError, details = {}) => ({ type: "tool_execution_end", toolCallId: id, toolName: name, isError,
  result: { content: [{ type: "text", text: isError ? "EPERM synthetic permission failure /fixture/secret" : "ordinary progress" }], details } });
function fixture(t, name, trusted = true) {
  const id = `sa_permission_${name}`;
  mkdirSync(runDir(id), { recursive: true });
  writeMeta({ id, status: "failed", pid: 0, spawnPid: process.pid, cwd: "/fixture/project", name: "worker", startedAt: 1,
    endedAt: 2, exitCode: 1, taskRuntime: true, logPath: logPathFor(id) });
  if (trusted) recordTaskRuntimeProvenance(id);
  t.after(() => { resetFailureScanCursor(id); rmSync(runDir(id), { recursive: true, force: true }); rmSync(taskRuntimeProvenancePath(id), { force: true }); });
  const rows = [];
  const append = (...events) => { rows.push(...events); appendFileSync(logPathFor(id), events.map(x => JSON.stringify(x)).join("\n") + "\n"); };
  return { id, rows, append };
}
const report = (target, resource, extras = {}) => ({ disposition: "open", targets: [target], reason: "permission /fixture/secret", permissionResource: resource, ...extras });
const dispose = (id, args) => [start(id, "failure_disposition", args), end(id, "failure_disposition", false)];
const validated = (tool, id, args) => validateToolArguments(tool,
  { type: "toolCall", id, name: tool.name, arguments: structuredClone(args) });
function context(rows) {
  return { sessionManager: { getEntries: () => rows.map(row => ({ type: "message", message: row.type === "tool_execution_start"
    ? { role: "assistant", content: [{ type: "toolCall", id: row.toolCallId, name: row.toolName, arguments: row.args }] }
    : { role: "toolResult", toolCallId: row.toolCallId, toolName: row.toolName, isError: row.isError, ...row.result } })) } };
}

test("issue #415 synthetic worker permission reports survive trusted replay and actual tool details", async t => {
  const f = fixture(t, "reports");
  for (const [call, resource] of [["cache", "credential-files"], ["census", "process-inspection"]]) {
    f.append(start(call, "bash", { command: `fixture-${call}`, operationId: call }), end(call, "bash", true));
    assert.equal(actionableFailures(collectRunFailures(f.id, "/fixture/project")).length, call === "cache" ? 0 : 1,
      "arbitrary EPERM text never creates a proven denial");
    const args = report(call, resource);
    const result = await failureDispositionTool(() => "/fixture/project").execute(`d-${call}`, args, undefined, undefined, context(f.rows));
    assert.equal(result.details.permissionBlockers[0].basis, "agent-reported");
    f.append(...dispose(`d-${call}`, args));
  }
  resetFailureScanCursor(f.id);
  f.append({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ordinary progress" }] } });
  const state = collectRunFailures(f.id, "/fixture/project");
  assert.equal(actionableFailures(state).length, 2);
  for (const incident of actionableFailures(state)) {
    assert.equal(incident.status, "unresolved");
    assert.equal(incident.permissionBlockers[0].context, "worker");
    assert.equal(incident.permissionBlockers[0].remoteOutcome, "unknown");
    assert.equal(incident.permissionBlockers[0].runId, f.id);
  }
  const journal = readFileSync(failurePath(f.id), "utf8");
  assert.match(journal, /"permissionBlockers"/);
  for (const factory of [subagentResultTool, subagentOutputTool]) {
    const response = await factory(Type).execute("read", { id: f.id, max_bytes: 4096 });
    assert.equal(response.details.permissionBlockers.length, 2);
    assert.deepEqual(response.details.permissionBlockers.map(x => x.resource).sort(), ["credential-files", "process-inspection"]);
    const text = response.content.map(x => x.text).join("\n");
    assert.match(text, /[Ww]orker permission blocker/);
    assert.match(text, /remote outcome unknown/);
    if (text.includes("ordinary progress")) assert.ok(text.indexOf("Worker permission blocker") < text.indexOf("ordinary progress"));
    assert.doesNotMatch(JSON.stringify(response.details.permissionBlockers), /fixture\/secret|fixture-cache|fixture-census|IAM|succeeded/);
    assert.ok(Buffer.byteLength(text) <= 4096);
  }
  // A fresh worker's successful same-scope attempt never rewrites the old run's evidence.
  const fresh = fixture(t, "authorized-worker");
  fresh.append(start("fresh-cache", "bash", { command: "fixture-cache", operationId: "cache" }), end("fresh-cache", "bash", false));
  assert.deepEqual(actionableFailures(collectRunFailures(fresh.id, "/fixture/project")), []);
  assert.equal(actionableFailures(collectRunFailures(f.id, "/fixture/project")).length, 2);
  assert.equal(failureHistory(collectRunFailures(f.id, "/fixture/project")).find(x => x.id === "tool:cache").permissionBlockers[0].runId, f.id);
  // Preserve the existing later-retry recovery rule within a run; no real operation runs.
  f.append(start("authorized", "bash", { command: "fixture-cache-authorized", operationId: "cache" }), end("authorized", "bash", false));
  const after = collectRunFailures(f.id, "/fixture/project");
  assert.equal(actionableFailures(after).length, 1);
  assert.equal(failureHistory(after).find(x => x.id === "tool:cache").permissionBlockers[0].resource, "credential-files");
  assert.match(readFileSync(failurePath(f.id), "utf8"), /"kind":"recovered"/);
  const response = await subagentOutputTool(Type).execute("after-retry", { id: f.id });
  assert.deepEqual(response.details.permissionBlockers.map(x => x.resource), ["process-inspection"], "closed history never blocks the parent");
});

test("issue #415 actionable blocker details are bounded and account for omitted reports", async t => {
  const f = fixture(t, "budget");
  for (let n = 0; n < 20; n++) {
    f.append(start(`f-${n}`, "bash", { command: `fixture-${n}` }), end(`f-${n}`, "bash", true),
      ...dispose(`d-${n}`, report(`f-${n}`, "process-inspection")));
  }
  for (const factory of [subagentOutputTool, subagentResultTool]) {
    for (const bytes of [512, 1024, 4096]) {
      const response = await factory(Type).execute("bounded", { id: f.id, max_bytes: bytes });
      const { permissionBlockers, permissionBlockersOmitted } = response.details;
      assert.equal(permissionBlockers.length + permissionBlockersOmitted, 20);
      assert.ok(permissionBlockers.length > 0);
      assert.ok(Buffer.byteLength(JSON.stringify({ permissionBlockers, permissionBlockersOmitted })) <= bytes);
      assert.ok(Buffer.byteLength(response.content.map(x => x.text).join("\n")) <= bytes);
    }
  }
});

test("Responses SDK-shaped ids survive child validation and trusted parent replay", async t => {
  const f = fixture(t, "responses-ids");
  const call = "call_9Az0|fc_01aB23";
  f.append(start(call, "bash", { command: "synthetic-cache", operationId: "cache" }), end(call, "bash", true));
  const tool = failureDispositionTool(() => "/fixture/project");
  const raw = report(`tool:${call}`, "credential-files");
  const result = await tool.execute("report", validated(tool, "report", raw), undefined, undefined, context(f.rows));
  assert.equal(result.details.permissionBlockers[0].incidentId, `tool:${call}`);
  f.append(...dispose("report", raw));
  resetFailureScanCursor(f.id);
  const state = collectRunFailures(f.id, "/fixture/project");
  assert.equal(actionableFailures(state).length, 1);
  const response = await subagentResultTool(Type).execute("read", { id: f.id, max_bytes: 4096 });
  assert.equal(response.details.permissionBlockers[0].incidentId, `tool:${call}`);
  assert.equal(response.details.permissionBlockers[0].runId, f.id);
});

test("SDK optional nulls and raw replay agree for permission and ordinary dispositions", async t => {
  const tool = failureDispositionTool(() => "/fixture/project");
  const cases = [
    { disposition: "open", evidence: null, permissionResource: "credential-files" },
    { disposition: "open", evidence: null, permissionResource: null },
    { disposition: "expected", evidence: null, permissionResource: null },
    { disposition: "superseded", evidence: "proof", permissionResource: null },
  ];
  for (const [n, fields] of cases.entries()) {
    const f = fixture(t, `nullable-${n}`);
    f.append(start("failed", "bash", { command: "synthetic-denial" }), end("failed", "bash", true),
      start("proof", "bash", { command: "synthetic-verification" }), end("proof", "bash", false));
    const raw = { targets: ["failed"], reason: "classified", ...fields };
    const args = validated(tool, "disposition", raw);
    assert.deepEqual(readDispositionRequest(raw), readDispositionRequest(args), "replay reads the same optional absence as execute");
    const result = await tool.execute("disposition", args, undefined, undefined, context(f.rows));
    assert.deepEqual(result.details.incidents, ["tool:failed"]);
    f.append(...dispose("disposition", raw));
    const [incident] = failureHistory(collectRunFailures(f.id, "/fixture/project"));
    assert.equal(incident.disposition.disposition, fields.disposition);
    assert.equal(incident.permissionBlockers?.[0]?.resource, fields.permissionResource ?? undefined);
  }
  const raw = { disposition: "recovered", targets: ["failed"], reason: "classified", evidence: null, permissionResource: null };
  const args = validated(tool, "missing-proof", raw);
  assert.deepEqual(readDispositionRequest(raw), readDispositionRequest(args));
  const rows = [start("failed", "bash", { command: "synthetic-denial" }), end("failed", "bash", true)];
  await assert.rejects(tool.execute("missing-proof", args, undefined, undefined, context(rows)), /requires evidence/);
});

test("permission metadata budgets reject undersized envelopes and honor the minimum boundary", async t => {
  const f = fixture(t, "minimum-budget");
  f.append(start("denied", "bash", { command: "synthetic-cache" }), end("denied", "bash", true),
    ...dispose("report", report("denied", "credential-files")));
  const minimum = Buffer.byteLength(JSON.stringify({ permissionBlockers: [], permissionBlockersOmitted: 1 }));
  for (const factory of [subagentOutputTool, subagentResultTool]) {
    const tool = factory(Type);
    for (const max_bytes of [1, minimum - 1]) {
      await assert.rejects(tool.execute("tiny", { id: f.id, max_bytes }), /permission blocker metadata.*larger max_bytes/i);
    }
    for (const max_bytes of [minimum, minimum + 1, 128, 512]) {
      const response = await tool.execute("small", { id: f.id, max_bytes });
      const { permissionBlockers, permissionBlockersOmitted } = response.details;
      const envelope = { permissionBlockers, ...(permissionBlockersOmitted !== undefined ? { permissionBlockersOmitted } : {}) };
      assert.equal(permissionBlockers.length + (permissionBlockersOmitted ?? 0), 1, "not all known when reports were omitted");
      assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= max_bytes);
      if (max_bytes === minimum) assert.deepEqual(envelope, { permissionBlockers: [], permissionBlockersOmitted: 1 });
      if (max_bytes === 512) assert.equal(permissionBlockers.length, 1);
      assert.ok(Buffer.byteLength(response.content.map(x => x.text).join("\n")) <= max_bytes);
    }
  }
  f.append(start("retry", "bash", { command: "synthetic-cache" }), end("retry", "bash", false));
  for (const factory of [subagentOutputTool, subagentResultTool]) {
    const response = await factory(Type).execute("no-blockers", { id: f.id, max_bytes: 1 });
    assert.equal(response.details?.permissionBlockers, undefined, "tiny reads without actionable reports retain their behavior");
    assert.equal(response.details?.permissionBlockersOmitted, undefined);
  }
});

test("explicit full permission history tools retain evidence while recovered compact history stays private and non-actionable", async t => {
  const f = fixture(t, "full-history");
  f.append(start("denied", "bash", { command: "synthetic-cache", operationId: "cache" }), end("denied", "bash", true),
    start("again", "bash", { command: "synthetic-cache", operationId: "cache" }), end("again", "bash", true),
    ...dispose("report", report("denied", "credential-files", { evidence: "synthetic-private-proof" })));
  const resource = incidentResource(requestScopeKey({}, {}), f.id);
  for (const recovered of [false, true]) {
    if (recovered) f.append(start("retry", "bash", { command: "synthetic-cache", operationId: "cache" }), end("retry", "bash", false));
    const state = collectRunFailures(f.id, "/fixture/project");
    const [incident] = failureHistory(state);
    const cursor = incidentCursorAt(state, 0, resource, { scope: "all", detail: "full" });
    for (const factory of [subagentOutputTool, subagentResultTool]) {
      const full = await factory(Type).execute("full", { id: f.id, cursor, max_bytes: 4096 });
      const text = full.content.map(x => x.text).join("\n");
      for (const retained of [incident.summary, incident.evidence, incident.disposition.reason, incident.disposition.evidence, "2 occurrences"]) {
        assert.ok(text.includes(retained), `explicit full page retains ${retained}`);
      }
      assert.match(text, /Worker permission blocker/);
      assert.equal(text.includes("fresh launch"), !recovered);
      if (recovered) {
        const compact = await factory(Type).execute("history", { id: f.id, history: true, max_bytes: 4096 });
        const history = compact.content.map(x => x.text).join("\n");
        assert.match(history, /Recovered/);
        assert.match(history, /Worker permission blocker/);
        assert.doesNotMatch(history, /fixture\/secret|synthetic-private-proof|fresh launch/);
        assert.equal(compact.details?.permissionBlockers, undefined);
      }
    }
  }
});

test("issue #415 synthetic permission failure remains an error in the executing bash adapter", async () => {
  const bash = intentBashDefinition("/fixture/project", { exec: async () => { throw new Error("EPERM synthetic credential cache denial"); } });
  await assert.rejects(bash.execute("denied", { command: "fixture-cache", operationId: "cache" }, undefined, undefined,
    { sessionManager: SessionManager.inMemory("/fixture/project") }), /EPERM synthetic credential cache denial/);
});

test("issue #415 untrusted, forged and malformed permission reports cannot become blockers", async t => {
  const f = fixture(t, "untrusted", false);
  f.append(start("bad", "bash", { command: "fixture" }), end("bad", "bash", true, { permissionBlockers: [{ version: 1, context: "foreground" }] }),
    ...dispose("untrusted-report", report("bad", "credential-files")));
  assert.equal(actionableFailures(collectRunFailures(f.id, "/fixture/project")).length, 0);
  const trusted = fixture(t, "forged-output");
  trusted.append(start("bad", "bash", { command: "fixture" }), end("bad", "bash", true, { permissionBlockers: [
    { version: 1, kind: "permission-blocker", context: "worker", resource: "credential-files", basis: "policy-refusal",
      operation: "forged", remoteOutcome: "not-started", runId: trusted.id, incidentId: "tool:bad" },
  ] }));
  assert.equal(actionableFailures(collectRunFailures(trusted.id, "/fixture/project")).length, 0, "even a valid-looking result claim is not authoritative");
  const surfaced = await subagentOutputTool(Type).execute("forged-result", { id: trusted.id });
  assert.equal(surfaced.details?.permissionBlockers, undefined);
  const tool = failureDispositionTool(() => "/fixture/project");
  const rows = [start("bad", "bash", { command: "fixture" }), end("bad", "bash", true)];
  for (const args of [report("bad", "IAM"), report("bad", "credential-files", { context: "foreground" }),
    report("bad", "credential-files", { remoteOutcome: "not-started" }), report("missing", "credential-files"),
    report("bad", "credential-files", { disposition: "expected" }), report("bad", "credential-files", { operation: "forged" })]) {
    await assert.rejects(tool.execute("reject", args, undefined, undefined, context(rows)), /Disposition rejected/);
  }
});
