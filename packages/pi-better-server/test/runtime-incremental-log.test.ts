import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WorkClient } from "../src/runtime/work-client.mjs";

const fixturePath = "../../pi-better-subagents/tests/work-runtime-fixture.mjs";
const coordinatorPath = "../src/runtime/domain/subagents/shared-operation-coordinator/index.domain.mjs";
const { startWorkRuntimeFixture } = await import(fixturePath);
const { openStore } = await import(coordinatorPath);
const task = (client: WorkClient): any => client.snapshot?.rows.find((r: any) => r.meta.id === "sa_incremental_0");

test("96 sibling logs share reads and only the appended task updates socket snapshots", { timeout: 30000 }, async t => {
  const parent = resolve("../../.work/798"); mkdirSync(parent, { recursive: true });
  const root = realpathSync(mkdtempSync(join(parent, "incremental-")));
  const agent = join(root, "agent"), runs = join(root, "pi-better-subagents/runs");
  mkdirSync(agent); mkdirSync(runs, { recursive: true });
  openStore({ path: join(agent, "operation-coordinator.sqlite") }).close();
  const event = (value: any) => JSON.stringify(value) + "\n";
  for (let i = 0; i < 96; i++) {
    const id = `sa_incremental_${i}`; mkdirSync(join(runs, id));
    writeFileSync(join(runs, id, "meta.json"), JSON.stringify({ id, sessionId: "same-worker", cwd: root,
      status: "running", pid: process.pid, startedAt: i, callback: false,
      ...(i === 0 ? { operations: { conversationId: "same-worker", workspace: root } } : {}),
      callbackOrigin: { cwd: root, sessionId: "parent" } }));
    writeFileSync(join(runs, id, "output.log"), event({ type: "tool_execution_start", toolCallId: "tool", toolName: "bash", at: 100 })
      + event({ type: "message_update", message: { role: "assistant", content: "x".repeat(67000) } }));
  }
  const daemon = await startWorkRuntimeFixture({ ...process.env, PI_CODING_AGENT_DIR: agent, TMPDIR: root });
  const navigator = new WorkClient(daemon.socketPath, agent), active = new WorkClient(daemon.socketPath, agent);
  const scope = { cwd: root, sessionId: "parent", limit: 100 };
  const waitFor = async (check: () => boolean) => {
    const deadline = Date.now() + 10000;
    while (!check()) { assert.ok(Date.now() < deadline, JSON.stringify(daemon.diagnostics())); await new Promise(r => setTimeout(r, 20)); }
  };
  try {
    await navigator.subscribe(scope); await active.subscribe({ ...scope, active: true });
    await waitFor(() => navigator.snapshot?.status === "ready" && navigator.snapshot.rows.length === 96 && active.snapshot?.rows.length === 96);
    const original = await navigator.get(scope), before = await navigator.request("runtime_get_metrics");
    const log = join(runs, "sa_incremental_0/output.log");
    const appended = event({ type: "tool_execution_end", toolCallId: "tool", toolName: "bash", at: 200 })
      + event({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "offline", usage: { input: 3, output: 2, cost: { total: 0.01 } } } });
    appendFileSync(log, appended);
    await waitFor(() => task(navigator)?.health?.facts.model.state === "error");
    await waitFor(() => task(active)?.health?.facts.model.state === "error");
    const after = await navigator.request("runtime_get_metrics"), updated = await navigator.get(scope);
    assert.equal(after.projections - before.projections, 1);
    assert.equal(after.assignmentProjections - before.assignmentProjections, 0);
    assert.equal(after.logProjections - before.logProjections, 1);
    assert.equal(after.healthProjections - before.healthProjections, 1);
    assert.equal(after.failureProjections - before.failureProjections, 0);
    assert.equal(after.logReads.reads - before.logReads.reads, 1);
    assert.equal(after.logReads.bytes - before.logReads.bytes, Buffer.byteLength(appended) + 256);
    assert.equal(after.logReads.parsedEvents - before.logReads.parsedEvents, 2);
    assert.equal(after.logReads.healthFolded - before.logReads.healthFolded, 2);
    assert.equal(after.logReads.displayFolded - before.logReads.displayFolded, 2);
    for (const row of updated.rows.filter((r: any) => r.meta.id !== "sa_incremental_0")) {
      assert.equal(row.sourceRevision, original.rows.find((r: any) => r.meta.id === row.meta.id)!.sourceRevision);
    }
    t.diagnostic(JSON.stringify({ before, after }));
    // A complete but unterminated usage event is speculative for display and
    // excluded from health until its newline arrives. It must not bill twice.
    const recovery = JSON.stringify({ type: "message_end", at: 300, message: { role: "assistant", stopReason: "stop", usage: { input: 7, output: 1, cost: { total: 0.02 } } } });
    appendFileSync(log, recovery);
    await waitFor(() => task(navigator)?.display?.spend.includes("0.03"));
    appendFileSync(log, "\n" + event({ type: "agent_settled", at: 400 }));
    await waitFor(() => task(navigator)?.health?.facts.sawAgentSettled);
    const final: any = (await navigator.get(scope)).rows.find((r: any) => r.meta.id === "sa_incremental_0");
    assert.equal(final.health.facts.model.state, "ok");
    assert.equal(final.health.facts.activeTools.length, 0);
    assert.equal(final.health.rawLog.windowTruncated, undefined);
    assert.ok(final.display.spend.includes("0.03"));
    const beforeLineage = await navigator.get(scope);
    const resumed = "sa_incremental_resume";
    mkdirSync(join(runs, resumed));
    writeFileSync(join(runs, resumed, "meta.json"), JSON.stringify({ id: resumed, sessionId: "same-worker", cwd: root,
      status: "completed", startedAt: 1000, callback: false, resumedFrom: "sa_incremental_0", rootRunId: "sa_incremental_0",
      operations: { conversationId: "same-worker", workspace: root, resumeLaunchToken: "fixture-token" },
      callbackOrigin: { cwd: root, sessionId: "parent" } }));
    await waitFor(() => task(navigator)?.assignment.attemptId === resumed);
    const lineage = await navigator.get(scope);
    for (const row of beforeLineage.rows.filter((r: any) => r.meta.id !== "sa_incremental_0")) {
      assert.equal(lineage.rows.find((r: any) => r.meta.id === row.meta.id)!.assignment.revision, row.assignment.revision);
    }
  } finally { navigator.close(); active.close(); await daemon(); rmSync(root, { recursive: true, force: true }); }
});
