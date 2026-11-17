import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
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
    await assert.rejects(() => f.send({ ...f.report, evidence: [{ path: foreign, explanation: "foreign" }] }), /Foreign.*assigned workspace.*retry/);
    symlinkSync(foreign, join(f.workspace, "foreign-link"));
    await assert.rejects(() => f.send({ ...f.report, evidence: [{ path: "foreign-link", explanation: "foreign symlink" }] }), /Foreign.*assigned workspace.*retry/);
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

test("a read-only worker can correct oversized evidence with a retained byte excerpt", async () => {
  const f = await fixture("report-large-excerpt");
  try {
    const source = Buffer.alloc(106732, "x");
    source.write("workflow evidence", 70000);
    writeFileSync(join(f.workspace, "android.yml"), source);
    const permissions = { enabled: true, projectFiles: "read", outsideProject: "off", storedCredentials: "off", commands: true, network: false };
    writeMeta({ ...readMeta(f.id), operations: { policy: { sandbox: { permissions } } } });
    f.pi.events.on("pi-better-sandbox:policy-request", () => f.pi.events.emit("pi-better-sandbox:policy", { state: "enabled", permissions }));
    const evidence = { path: "android.yml", explanation: "Relevant workflow commands" };
    await assert.rejects(() => f.send({ ...f.report, evidence: [evidence] }), (error) => {
      assert.match(error.message, /android\.yml.*106732.*65536.*max_bytes/);
      assert.equal(error.retryable, true);
      return true;
    });
    assert.match(readMeta(f.id).assignmentReportRejection.reason, /106732/);
    const input = { ...f.report, evidence: [{ ...evidence, offset: 70000, max_bytes: 4096 }] };
    await f.send(input);
    assert.equal(readMeta(f.id).assignmentReportRejection, undefined);
    const report = readAssignmentReport(readMeta(f.id));
    assert.deepEqual(report.evidence[0].range, { offset: 70000, bytes: 4096, sourceBytes: 106732 });
    assert.deepEqual(readFileSync(report.evidence[0].path), source.subarray(70000, 74096));
    writeFileSync(join(f.workspace, "android.yml"), "changed");
    await f.send(input);
    await assert.rejects(() => f.send({ ...input, evidence: [{ ...evidence, offset: 0, max_bytes: 4096 }] }), /Conflicting/);
    const terminal = { ...readMeta(f.id), status: "completed", exitCode: 0 };
    writeMeta(terminal);
    assert.equal(commitAssignmentTerminal(terminal).outcome, "succeeded");
  } finally { await f.close(); }
});

test("rejected evidence remains actionable when an otherwise clean child exits", async () => {
  const f = await fixture("report-rejected-outcome");
  try {
    writeFileSync(join(f.workspace, "large"), Buffer.alloc(106732));
    await assert.rejects(() => f.send({ ...f.report, evidence: [{ path: "large", explanation: "source" }] }));
    const terminal = { ...readMeta(f.id), status: "completed", exitCode: 0 };
    writeMeta(terminal);
    const outcome = commitAssignmentTerminal(terminal);
    assert.equal(outcome.outcome, "failed");
    assert.match(outcome.reason, /Assignment report rejected:.*large.*106732.*max_bytes/);
    assert.equal(readMeta(f.id).exitCode, 0);
  } finally { await f.close(); }
});

test("byte excerpts reject invalid ranges and preserve the workspace boundary", async () => {
  const f = await fixture("report-excerpt-boundary");
  try {
    for (const range of [{ offset: 1 }, { offset: 999, max_bytes: 1 }, { offset: -1, max_bytes: 1 }, { max_bytes: 65537 }, { max_bytes: 0 }]) {
      await assert.rejects(() => f.send({ ...f.report, evidence: [{ ...f.report.evidence[0], ...range }] }));
      assert.equal(readMeta(f.id).assignmentReport, undefined);
    }
    await assert.rejects(() => f.send({ ...f.report, evidence: [{ path: "/etc/hosts", explanation: "foreign excerpt", max_bytes: 16 }] }), /Foreign/);
    await f.send({ ...f.report, evidence: [{ ...f.report.evidence[0], max_bytes: 65536 }] });
    assert.equal(readAssignmentReport(readMeta(f.id)).evidence[0].range.bytes, Buffer.byteLength("actual synchronous work\n"));
  } finally { await f.close(); }
});

test("incomplete reports preserve remaining work and concrete blockers for the parent", async () => {
  const f = await fixture("report-incomplete-detail");
  try {
    await f.send({ ...f.report, status: "incomplete", reason: "Native validation is blocked", remaining_work: ["Run native compatibility checks"],
      blocker: { kind: "permission", reason: "ADB access has not been granted" } });
    const report = readAssignmentReport(readMeta(f.id));
    assert.deepEqual(report.remainingWork, ["Run native compatibility checks"]);
    assert.deepEqual(report.blocker, { kind: "permission", reason: "ADB access has not been granted" });
    await f.send({ ...f.report, status: "incomplete", reason: "Native validation is blocked", remaining_work: report.remainingWork,
      blocker: { reason: "ADB access has not been granted", kind: "permission" } });
    const terminal = { ...readMeta(f.id), status: "completed", exitCode: 0 };
    writeMeta(terminal);
    const outcome = commitAssignmentTerminal(terminal);
    assert.equal(outcome.outcome, "failed");
    assert.match(outcome.reason, /Assignment incomplete:.*ADB access.*Run native compatibility/);
  } finally { await f.close(); }
});

test("authenticated schema refusals retain the latest diagnostic without accepting a report", async () => {
  const f = await fixture("report-schema-rejected");
  try {
    await assert.rejects(() => f.send({ ...f.report, evidence: [{ ...f.report.evidence[0], offset: -1, max_bytes: 1 }] }), /less than 0/);
    assert.match(readMeta(f.id).assignmentReportRejection.reason, /offset.*less than 0/);
    await assert.rejects(() => f.send({ ...f.report, evidence: [{ ...f.report.evidence[0], max_bytes: 65537 }] }), /greater than 65536/);
    assert.match(readMeta(f.id).assignmentReportRejection.reason, /max_bytes.*greater than 65536/);
    assert.equal(readMeta(f.id).assignmentReport, undefined);
    const terminal = { ...readMeta(f.id), status: "completed", exitCode: 0 };
    writeMeta(terminal);
    assert.match(commitAssignmentTerminal(terminal).reason, /Assignment report rejected:.*max_bytes/);
    const rejection = readMeta(f.id).assignmentReportRejection;
    await assert.rejects(() => f.send({ ...f.report, evidence: [] }), /authoritative/);
    assert.deepEqual(readMeta(f.id).assignmentReportRejection, rejection);
  } finally { await f.close(); }
});

test("unavailable current permission evidence is retained and can be corrected without widening access", async () => {
  const f = await fixture("report-policy-rejected");
  let projectFiles = "invalid";
  f.pi.events.on("pi-better-sandbox:policy-request", () => f.pi.events.emit("pi-better-sandbox:policy", {
    state: "enabled", permissions: { enabled: true, projectFiles, outsideProject: "off", storedCredentials: "off", commands: true, network: false },
  }));
  try {
    await assert.rejects(() => f.send(), /Invalid/);
    assert.match(readMeta(f.id).assignmentReportRejection.reason, /Invalid/);
    assert.equal(readMeta(f.id).assignmentReport, undefined);
    projectFiles = "read";
    await f.send();
    assert.equal(readMeta(f.id).assignmentReportRejection, undefined);
  } finally { await f.close(); }
});

test("maximum incomplete detail stays within the terminal reason bound and retains full detail", async () => {
  const f = await fixture("report-incomplete-bound");
  try {
    const remaining = Array.from({ length: 8 }, (_, i) => `${i}:${"x".repeat(1022)}`);
    await f.send({ ...f.report, status: "incomplete", reason: "r".repeat(2048), remaining_work: remaining,
      blocker: { kind: "external-input", reason: "b".repeat(1024) } });
    const terminal = { ...readMeta(f.id), status: "completed", exitCode: 0 };
    writeMeta(terminal);
    const outcome = commitAssignmentTerminal(terminal);
    assert.equal(outcome.outcome, "failed");
    assert.equal(outcome.reason.length, 8192);
    assert.deepEqual(readAssignmentReport(terminal).remainingWork, remaining);
  } finally { await f.close(); }
});

test("report prose rejected by the coordinator is refused before report acceptance", async () => {
  const f = await fixture("report-coordinator-text");
  try {
    for (const change of [
      { reason: "Checked Bearer exampletoken12345" },
      { reason: "Checked\nwith evidence" },
      { evidence: [{ path: "work.txt", explanation: "Bearer exampletoken12345" }] },
      { status: "incomplete", remaining_work: ["Bearer exampletoken12345"] },
      { status: "incomplete", blocker: { kind: "external-input", reason: "Bearer exampletoken12345" } },
    ]) {
      await assert.rejects(() => f.send({ ...f.report, ...change }), /Invalid/);
      assert.equal(readMeta(f.id).assignmentReport, undefined);
    }
    await f.send();
    const terminal = { ...readMeta(f.id), status: "completed", exitCode: 0 };
    writeMeta(terminal);
    assert.equal(commitAssignmentTerminal(terminal).outcome, "succeeded");
  } finally { await f.close(); }
});

test("terminalization tolerates legacy report prose that the coordinator refuses", async () => {
  const f = await fixture("report-legacy-coordinator-text");
  try {
    await f.send();
    const previous = readMeta(f.id);
    const report = JSON.parse(readFileSync(previous.assignmentReport.path, "utf8"));
    report.reason = "Checked Bearer exampletoken12345";
    const text = JSON.stringify(report);
    const digest = createHash("sha256").update(text).digest("hex");
    const path = join(runDir(f.id), "assignment-report-v1", `${digest}.json`);
    writeFileSync(path, text);
    writeMeta({ ...previous, assignmentReport: { ...previous.assignmentReport, path, digest } });
    const terminal = { ...readMeta(f.id), status: "completed", exitCode: 0 };
    writeMeta(terminal);
    const outcome = commitAssignmentTerminal(terminal);
    assert.equal(outcome.outcome, "failed");
    assert.match(outcome.reason, /unverified/);
    assert.equal(JSON.stringify(outcome).includes("exampletoken12345"), false);
  } finally { await f.close(); }
});

test("contradictory completion can be corrected before commitment and full-size excerpts stay bounded", async () => {
  const f = await fixture("report-contradictory-completion");
  try {
    await assert.rejects(() => f.send({ ...f.report, remaining_work: ["Still needs validation"] }), /complete.*remaining work/);
    await assert.rejects(() => f.send({ ...f.report, blocker: { kind: "permission", reason: "Access denied" } }), /complete.*blocker/);
    writeFileSync(join(f.workspace, "large"), Buffer.alloc(106732, "y"));
    await f.send({ ...f.report, evidence: [{ path: "large", explanation: "Bounded source excerpt", max_bytes: 65536 }] });
    const report = readAssignmentReport(readMeta(f.id));
    assert.equal(readFileSync(report.evidence[0].path).length, 65536);
    assert.equal(readMeta(f.id).assignmentReportRejection, undefined);
    const accepted = readMeta(f.id).assignmentReport;
    await assert.rejects(() => f.send(), /Conflicting/);
    assert.deepEqual(readMeta(f.id).assignmentReport, accepted);
    assert.equal(readMeta(f.id).assignmentReportRejection, undefined);
  } finally { await f.close(); }
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
