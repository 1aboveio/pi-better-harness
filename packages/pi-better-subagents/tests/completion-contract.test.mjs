import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createWorkerOperationsHost, planWorkerBridgeTools } from "../worker-waits.ts";
import { installChildOperationBridge, readChildOperationBridgeConfig, verifyDescriptor } from "../child-operations.ts";
import { createBridgeDescriptor, createToolDescriptor } from "../operation-bridge-types.ts";
import { createOperationBridgeHost } from "../worker-operations-host.ts";
import { commitAssignmentTerminal, registerAssignmentAttempt } from "../assignment-outcomes.ts";
import { readAssignmentReport } from "../assignment-report.ts";
import { logPathFor, readMeta, runDir, writeMeta } from "../registry.ts";

test("explicit tool lists and exclusions cannot admit a wait without interpretation tools", () => {
  for (const input of [
    { allow: ["wait_for_operations", "bg_task_status"], excluded: [] },
    { allow: ["wait_for_operations", "acknowledge_operation_result"], excluded: [] },
    { allow: ["wait_for_operations", "acknowledge_operation_result", "bg_task_status"], excluded: ["acknowledge_operation_result"] },
  ]) assert.throws(() => planWorkerBridgeTools({ ...input, clean: false, explicitTools: true }), /wait_for_operations.*requires/);
  const plan = planWorkerBridgeTools({ allow: ["wait_for_operations", "acknowledge_operation_result", "bg_task_log"], excluded: [], clean: false, explicitTools: true });
  assert.deepEqual(plan.tools.sort(), ["acknowledge_operation_result", "bg_task_log", "wait_for_operations"]);
});

test("host registration and child handshake reject a filtered wait capability bundle", async () => {
  const host = await createOperationBridgeHost();
  const capabilities = { background: { spawn: false, watch: false, status: true, log: false }, wait: true, parking: true, acknowledge: false };
  const tools = [createToolDescriptor("wait_for_operations"), createToolDescriptor("bg_task_status")];
  try {
    assert.throws(() => host.registerRun({ runId: "incoherent", conversationId: "incoherent", workspace: tmpdir(), authorityReference: "test",
      capabilities, tools, ownership: () => true, handlers: { wait_for_operations: async () => ({}), bg_task_status: async () => ({}), checkpoint: async () => ({}), park_failed: async () => ({}) } }), /wait_for_operations.*requires/);
    const descriptor = createBridgeDescriptor("incoherent", "incoherent", tools, capabilities,
      { maxRequestBytes: 65536, maxResponseBytes: 65536, requestTimeoutMs: 1000 });
    assert.throws(() => verifyDescriptor(descriptor, { runId: "incoherent", conversationId: "incoherent" }), /wait_for_operations.*requires/);
  } finally { await host.close(); }
});

const complete = { status: "complete", reason: "Actual local work is complete", evidence: [{ path: "work.txt", explanation: "Checked local artifact" }] };
const incomplete = { ...complete, status: "incomplete", reason: "Work remains", remaining_work: ["Finish the local check"] };
const reportCall = (arguments_, turn) => ({ type: "toolCall", id: `report-${turn}`, name: "report_assignment_result", arguments: arguments_ });
const stopped = [{ type: "text", text: "Returning the current result." }];

async function sdkFixture(t, respond, { deadlineAt = null, savedCorrection = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "completion-contract-"));
  const sessionManager = SessionManager.create(root, join(root, "sessions"));
  const id = sessionManager.getSessionId();
  const binding = { version: 1, assignmentId: id,
    owner: { kind: "worker-conversation", sessionId: id, workspace: root, branchId: null, goalId: null },
    recipient: { kind: "parent-session", sessionId: "parent", workspace: root, branchId: null, goalId: null } };
  registerAssignmentAttempt(binding, id);
  mkdirSync(runDir(id), { recursive: true });
  writeFileSync(logPathFor(id), "");
  writeFileSync(join(root, "work.txt"), "Actual local work passed.\n");
  writeMeta({ id, assignment: binding, status: "running", sessionId: id, cwd: root, logPath: logPathFor(id), pid: process.pid, spawnPid: process.pid, startedAt: Date.now(), promptPreview: "Complete local work" });
  const host = createWorkerOperationsHost({ pi: { events: new EventEmitter() }, childExtensionPath: "unused" });
  const capabilities = { background: { spawn: false, watch: false, status: false, log: false }, wait: false, acknowledge: false, parking: false, reportAssignment: true };
  const handle = await host.register({ assignment: binding, runId: id, attemptId: id, conversationId: id, workspace: root, authorityReference: id,
    policy: { version: 1, sandbox: null, tools: [], clean: true, deadlineAt, authorityReference: id, workspace: root },
    tools: ["report_assignment_result"], schemas: [createToolDescriptor("report_assignment_result")], capabilities });
  let requests = 0;
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const provider = { baseUrl: "https://example.invalid", apiKey: "offline-fixture", api: "openai-completions",
    models: [{ id: "offline", name: "Completion fixture", input: ["text"], reasoning: false, contextWindow: 128000, maxTokens: 1024, cost }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const next = respond(++requests, context);
      const content = Array.isArray(next) ? next : next.content;
      const stopReason = next.stopReason ?? (content.some(part => part.type === "toolCall") ? "toolUse" : "stop");
      const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, stopReason, timestamp: Date.now(),
        usage: { ...cost, totalTokens: 0, cost: { ...cost, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: "done", reason: stopReason, message }); stream.end(message); });
      return stream;
    } };
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), refreshOnCreate: false,
    modelsPath: join(root, "models.json"), modelsStorePath: join(root, "models-store.json") });
  modelRuntime.registerProvider("completion-test", provider);
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [{ name: "completion-under-test", factory(pi) {
      pi.registerProvider("completion-test", provider);
      if (savedCorrection) sessionManager.appendCustomEntry("pi-subagent-completion", { attemptId: savedCorrection === "prior" ? "prior-attempt" : id, correctionUsed: true });
      const read = readChildOperationBridgeConfig(handle.env);
      assert.equal(read.status, "ready");
      assert.equal(read.config.deadlineAt, deadlineAt);
      installChildOperationBridge(pi, { config: read.config, handshakeAttempts: 1 });
    } }] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager, modelRuntime, resourceLoader: loader, sessionManager,
    model: modelRuntime.getModel("completion-test", "offline"), noTools: "builtin" });
  const errors = [];
  await session.bindExtensions({ onError: error => errors.push(String(error)) });
  t.after(async () => {
    await session.abort();
    await session._extensionRunner.emit({ type: "session_shutdown" });
    session.dispose();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, id, session, sessionManager, errors, requests: () => requests,
    report: () => readAssignmentReport(readMeta(id)),
    finish: () => commitAssignmentTerminal({ ...readMeta(id), status: "completed", exitCode: 0, endedAt: Date.now() }) };
}

test("real SDK corrects a normal stop without a report before assignment finalization", async t => {
  const f = await sdkFixture(t, turn => turn === 2 ? [reportCall(complete, turn)] : stopped);
  await f.session.prompt("Complete the local assignment and report actual evidence.");
  assert.equal(f.requests(), 3);
  assert.equal(f.report()?.status, "complete");
  assert.equal(f.finish()?.outcome, "succeeded");
  assert.deepEqual(f.errors, []);
});

test("real SDK corrects refused evidence after a normal stop", async t => {
  const bad = { ...complete, evidence: [{ path: "missing.txt", explanation: "Missing artifact" }] };
  const f = await sdkFixture(t, turn => turn === 1 ? [reportCall(bad, turn)] : turn === 3 ? [reportCall(complete, turn)] : stopped);
  await f.session.prompt("Report actual evidence.");
  assert.equal(f.requests(), 4);
  assert.equal(f.report()?.status, "complete");
  assert.equal(f.finish()?.outcome, "succeeded");
});

test("real SDK gives unblocked remaining work one chance before accepting an immutable report", async t => {
  const f = await sdkFixture(t, turn => turn === 1 ? [reportCall(incomplete, turn)] : turn === 2 ? [reportCall(complete, turn)] : stopped);
  await f.session.prompt("Finish the local check before returning.");
  assert.equal(f.requests(), 3);
  assert.equal(f.report()?.status, "complete");
  assert.equal(f.finish()?.outcome, "succeeded");
});

for (const [name, options, first, expectedRequests] of [
  ["repeated normal stops", {}, stopped, 2],
  ["expired deadline", { deadlineAt: 1 }, stopped, 1],
  ["persisted correction budget", { savedCorrection: true }, stopped, 1],
  ["model error", {}, { content: stopped, stopReason: "error" }, 1],
  ["model abort", {}, { content: stopped, stopReason: "aborted" }, 1],
]) test(`real SDK bounds completion correction for ${name}`, async t => {
  const f = await sdkFixture(t, () => first, options);
  await f.session.prompt("Complete local work.");
  assert.equal(f.requests(), expectedRequests);
  assert.equal(f.report(), null);
  assert.equal(f.finish()?.outcome, "failed");
});

test("real SDK preserves a concrete blocker without continuing the assignment", async t => {
  const f = await sdkFixture(t, turn => turn === 1 ? [reportCall({ ...incomplete, blocker: { kind: "external-input", reason: "Need an unavailable native device" } }, turn)] : stopped);
  await f.session.prompt("Validate on the native device if available.");
  assert.equal(f.requests(), 2);
  assert.equal(f.report()?.status, "incomplete");
  assert.equal(f.finish()?.outcome, "failed");
});

test("real SDK shares one correction budget across report correction and unfinished work", async t => {
  const f = await sdkFixture(t, turn => turn === 2 ? [reportCall(incomplete, turn)] : stopped);
  await f.session.prompt("Finish local work.");
  assert.equal(f.requests(), 3);
  assert.equal(f.report()?.status, "incomplete");
  assert.equal(f.finish()?.outcome, "failed");
});

test("real SDK accepts a repeated incomplete report after its single continuation opportunity", async t => {
  const f = await sdkFixture(t, turn => turn <= 2 ? [reportCall(incomplete, turn)] : stopped);
  await f.session.prompt("Finish local work.");
  assert.equal(f.requests(), 3);
  assert.equal(f.report()?.status, "incomplete");
  assert.equal(f.finish()?.outcome, "failed");
});

test("real SDK keeps a previously accepted report immutable without starting correction", async t => {
  const f = await sdkFixture(t, turn => turn === 1 ? [reportCall(complete, turn)] : turn === 2 ? [reportCall(incomplete, turn)] : stopped);
  await f.session.prompt("Report actual completed work.");
  assert.equal(f.requests(), 3);
  assert.equal(f.report()?.status, "complete");
  assert.equal(f.finish()?.outcome, "succeeded");
});

test("real SDK scopes saved correction budgets to the exact attempt", async t => {
  const f = await sdkFixture(t, turn => turn === 2 ? [reportCall(complete, turn)] : stopped, { savedCorrection: "prior" });
  await f.session.prompt("Report actual completed work.");
  assert.equal(f.requests(), 3);
  assert.equal(f.report()?.status, "complete");
});

test("real SDK reload does not replenish a spent completion correction", async t => {
  const f = await sdkFixture(t, () => stopped);
  await f.session.prompt("Complete local work.");
  assert.equal(f.requests(), 2);
  await f.session.reload();
  await f.session.prompt("Inspect the same attempt after reload.");
  assert.equal(f.requests(), 3);
  assert.deepEqual(f.errors, []);
});
