import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { createWorkerOperationsHost } from "../worker-waits.ts";
import { createOperationBridgeClient } from "../child-operations.ts";
import { createToolDescriptor } from "../operation-bridge-types.ts";
import { createOperationBridgeHost } from "../worker-operations-host.ts";
import { registerAssignmentAttempt, commitAssignmentTerminal, readOutcome, coordinatorPath } from "../assignment-outcomes.ts";
import { readAssignmentReport } from "../assignment-report.ts";
import { openStore } from "../shared-operation-coordinator/index.ts";
import { writeMeta, readMeta, runDir, logPathFor } from "../registry.ts";

async function fixture(id, registration = {}, shared) {
  const workspace = mkdtempSync(join(tmpdir(), "assignment-report-"));
  const binding = { version: 1, assignmentId: id,
    owner: { kind: "worker-conversation", sessionId: id, workspace, branchId: null, goalId: null },
    recipient: { kind: "parent-session", sessionId: "parent", workspace, branchId: null, goalId: null } };
  registerAssignmentAttempt(binding, id);
  mkdirSync(runDir(id), { recursive: true });
  writeFileSync(logPathFor(id), "");
  writeFileSync(join(workspace, "work.txt"), "actual synchronous work\n");
  writeMeta({ id, assignment: binding, status: "running", sessionId: id, cwd: workspace, logPath: logPathFor(id),
    pid: process.pid, spawnPid: process.pid, startedAt: 1, promptPreview: "work" });
  const pi = shared?.pi ?? { events: new EventEmitter() };
  const host = shared?.host ?? createWorkerOperationsHost({ pi, childExtensionPath: new URL("../child-operations.ts", import.meta.url).pathname });
  const handle = await host.register({ assignment: binding, runId: id, attemptId: id, conversationId: id, workspace, authorityReference: id,
    ...registration,
    policy: { version: 1, sandbox: null, tools: [], clean: true, deadlineAt: null, authorityReference: id, workspace },
    tools: ["report_assignment_result"], schemas: [createToolDescriptor("report_assignment_result")],
    capabilities: { background: { spawn: false, watch: false, status: false, log: false }, wait: false, acknowledge: false, parking: false, reportAssignment: true } });
  const client = createOperationBridgeClient({ endpoint: handle.endpoint, token: handle.token, runId: id, conversationId: id });
  await client.handshake();
  const report = { status: "complete", reason: "Synchronous work checked", evidence: [{ path: "work.txt", explanation: "Actual work artifact" }] };
  return { id, binding, workspace, host, client, handle, report, pi,
    send: (input = report) => client.request("report_assignment_result", input),
    close: async () => { await client.close(); await host.close(); } };
}

test("report-only bridge retains actual bytes, retries identically, and rejects conflicting/missing/foreign evidence and stale authority", async () => {
  const f = await fixture("report-boundary");
  try {
    assert.equal(f.client.descriptor.capabilities.reportAssignment, true);
    assert.equal(f.client.descriptor.capabilities.wait, false);
    await assert.rejects(() => f.send({ ...f.report, evidence: [{ path: "missing", explanation: "missing" }] }), /ENOENT|no such file/);
    await assert.rejects(() => f.send({ ...f.report, assignmentId: "foreign" }), (error) => error.code === "schema-invalid" || error.code === "authority-field");
    const foreign = join(tmpdir(), "foreign-report.txt"); writeFileSync(foreign, "foreign");
    await assert.rejects(() => f.send({ ...f.report, evidence: [{ path: foreign, explanation: "foreign" }] }), /Foreign/);
    symlinkSync(foreign, join(f.workspace, "foreign-link"));
    await assert.rejects(() => f.send({ ...f.report, evidence: [{ path: "foreign-link", explanation: "foreign symlink" }] }), /Foreign/);
    writeFileSync(join(f.workspace, "oversized"), Buffer.alloc(65537));
    await assert.rejects(() => f.send({ ...f.report, evidence: [{ path: "oversized", explanation: "too large" }] }), /65536/);
    assert.equal(readMeta(f.id).assignmentReport, undefined, "refused evidence cannot publish a report reference");
    const receipt = await f.send();
    assert.equal(readOutcome(readMeta(f.id)), null, "live report is not a terminal assignment decision");
    writeFileSync(join(f.workspace, "work.txt"), "changed after report");
    assert.deepEqual(await f.send(), receipt, "retry returns the retained snapshot rather than recapturing mutable input");
    const report = readAssignmentReport(readMeta(f.id));
    assert.equal(report.evidence.length, 1);
    assert.equal(readFileSync(report.evidence[0].path, "utf8"), "actual synchronous work\n", "retained bytes survive source mutation");
    await assert.rejects(() => f.send({ ...f.report, status: "incomplete" }), /Conflicting/);
    const invalid = createOperationBridgeClient({ endpoint: f.handle.endpoint, token: "x".repeat(40), runId: f.id, conversationId: f.id });
    try { await assert.rejects(() => invalid.handshake(), (error) => error.code === "invalid-token"); } finally { await invalid.close(); }
    f.pi.events.emit("pi-better-sandbox:policy", { state: "enabled", permissions: { enabled: true, projectFiles: "off", outsideProject: "off", storedCredentials: "off", commands: true, network: false } });
    await assert.rejects(() => f.send(), /permission/);
    f.host.release(f.id, "superseded");
    await assert.rejects(() => f.send(), (error) => ["run-unknown", "run-revoked", "closed"].includes(error.code));
    const stale = createOperationBridgeClient({ endpoint: f.handle.endpoint, token: "x".repeat(40), runId: f.id, conversationId: f.id });
    try { await assert.rejects(() => stale.handshake(), (error) => ["run-unknown", "run-revoked"].includes(error.code)); } finally { await stale.close(); }
  } finally { await f.close(); }
});

test("concurrent report-only children share one authenticated transport and teardown", async () => {
  const pi = { events: new EventEmitter() };
  const transports = [];
  const host = createWorkerOperationsHost({ pi, childExtensionPath: new URL("../child-operations.ts", import.meta.url).pathname,
    hostFactory: async (options) => { const transport = await createOperationBridgeHost(options); transports.push(transport); return transport; } });
  const [a, b] = await Promise.all([fixture("report-parallel-a", {}, { host, pi }), fixture("report-parallel-b", {}, { host, pi })]);
  try {
    assert.equal(a.handle.endpoint, b.handle.endpoint, "one parent host owns both ordinary children");
    await Promise.all([a.send(), b.send()]);
    await host.close();
    await assert.rejects(() => a.send(), (error) => error.code === "closed");
    await assert.rejects(() => b.send(), (error) => error.code === "closed");
  } finally { await a.close(); await b.close(); await Promise.all(transports.map((transport) => transport.close())); }
});

test("a superseded conversation writer lease cannot publish an assignment report", async () => {
  const f = await fixture("report-stale-lease", { writerLeaseId: "superseded-lease" });
  try {
    await assert.rejects(() => f.send(), /writer lease changed/);
    assert.equal(readMeta(f.id).assignmentReport, undefined);
  } finally { await f.close(); }
});

test("an exited writer cannot report while its metadata still awaits finalization", async () => {
  const f = await fixture("report-exited-writer");
  try {
    writeMeta({ ...readMeta(f.id), pid: 4194304 });
    await assert.rejects(() => f.send(), /writer has exited/);
    assert.equal(readMeta(f.id).assignmentReport, undefined);
  } finally { await f.close(); }
});

test("foreign or corrupted retained report cannot establish success during recovery", async () => {
  const f = await fixture("report-recovery-integrity");
  try {
    await f.send();
    const meta = readMeta(f.id);
    assert.throws(() => readAssignmentReport({ ...meta, assignmentReport: { ...meta.assignmentReport, attemptId: "prior-attempt" } }), /Foreign/);
    const report = readAssignmentReport(meta);
    writeFileSync(report.evidence[0].path, "corrupted retained bytes");
    const terminal = { ...meta, status: "completed", exitCode: 0 };
    writeMeta(terminal);
    const outcome = commitAssignmentTerminal(terminal);
    assert.equal(outcome.outcome, "failed");
    assert.match(outcome.reason, /unverified.*changed/);
    assert.equal(commitAssignmentTerminal(terminal).eventId, outcome.eventId);
  } finally { await f.close(); }
});

test("complete reporting cannot bypass real unresolved waits; incomplete wins over a completion acknowledgement; crash wins over reports", async () => {
  for (const [id, status, reportStatus] of [["report-wait", "completed", "complete"], ["report-incomplete", "completed", "incomplete"], ["report-crash", "failed", "complete"]]) {
    const f = await fixture(id);
    const store = openStore({ path: coordinatorPath() });
    try {
      store.registerOperation({ operationId: id, taskId: id, launchToken: id, owner: f.binding.owner, observer: { kind: "test", version: "1" } });
      const { wait } = store.registerWait({ owner: f.binding.owner, dependencies: [{ operationId: id }], continuationNote: "Interpret actual result", origin: { assignmentRef: id, attemptId: id } });
      if (reportStatus === "incomplete") {
        store.recordTerminalOutcome({ operationId: id, eventId: `end-${id}`, owner: f.binding.owner, outcome: "succeeded", evidence: [{ kind: "artifact", ref: join(f.workspace, "work.txt") }] });
        store.recordEvidenceRead({ ...wait, owner: f.binding.owner, operationId: id, terminalRevision: 1 });
        store.acknowledgeResult({ ...wait, owner: f.binding.owner, disposition: "assignment-complete", terminalRevisions: [{ operationId: id, revision: 1 }], note: "Dependency interpreted" });
      }
      await f.send({ ...f.report, status: reportStatus });
      const meta = { ...readMeta(id), status, exitCode: status === "failed" ? 1 : 0 };
      writeMeta(meta);
      const outcome = commitAssignmentTerminal(meta);
      if (id === "report-wait") {
        assert.equal(outcome, null);
        assert.equal(store.getWait(wait).acknowledgement, null);
      } else assert.equal(outcome.outcome, "failed");
      await assert.rejects(() => f.send(), /authoritative/);
    } finally { await f.close(); store.close(); }
  }
});
