import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

for (const fixed of [false, true]) test(`${fixed ? "fixed domain" : "canonical"} recovered writer exiting between health observations cannot bypass terminal-log finalization`, async t => {
  t.mock.method(childProcess, "execFileSync", () => "fixture-process-start");
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const base = fixed ? "../src/runtime/domain/subagents/" : "../../pi-better-subagents/";
  const suffix = fixed ? ".domain.mjs" : ".ts";
  const { reconcileInterruptedRun } = await import(new URL(`${base}finalization${suffix}`, import.meta.url).href);
  const { writeMeta, readMeta, runDir, logPathFor } = await import(new URL(`${base}registry${suffix}`, import.meta.url).href);
  const root = mkdtempSync(join(tmpdir(), "interrupted-race-")), previous = process.env.TMPDIR;
  process.env.TMPDIR = root;
  try {
    const id = "sa_recovered_race";
    mkdirSync(runDir(id), { recursive: true });
    writeMeta({ id, status: "running", pid: 4756, pidStartTime: "captured-start", pgid: 4756,
      spawnPid: 3764, cwd: root, sessionId: id, callback: false, startedAt: 1,
      logPath: logPathFor(id), supervisionInterruptedAt: 2, management: { root, instance: "replacement", epoch: 2 } });
    let probes = 0;
    const probe = { pidExists: () => ++probes === 1, startToken: () => "captured-start", groupId: () => 4756, groupAlive: () => false };
    const first = reconcileInterruptedRun(readMeta(id), probe, 3);
    assert.equal(first.reconciliation.status, "running", "one pass cannot make a second loss decision after skipping the log on live evidence");
    writeFileSync(logPathFor(id), [
      { type: "tool_execution_start", toolCallId: "launch-report", toolName: "report_assignment_result" },
      { type: "tool_execution_end", toolCallId: "launch-report", toolName: "report_assignment_result", isError: false },
      { type: "agent_end", messages: [] }, { type: "agent_settled" },
    ].map(value => JSON.stringify(value)).join("\n") + "\n");
    const second = reconcileInterruptedRun(readMeta(id), probe, 4);
    assert.equal(second.finalization?.applied, true);
    assert.equal(readMeta(id).status, "completed");
    assert.equal(readMeta(id).exitCode, null, "unobserved exit code must remain unknown");
    assert.deepEqual(readMeta(id).management, { root, instance: "replacement", epoch: 2 });
    assert.equal(readMeta(id).pidStartTime, "captured-start");
    for (const [name, interrupted, log] of [
      ["incomplete", true, [{ type: "agent_start" }]],
      ["open_tool", true, [{ type: "tool_execution_start", toolCallId: "open", toolName: "read" }, { type: "agent_end" }]],
      ["unowned", false, [{ type: "agent_end" }]],
    ] as const) {
      const other = `sa_${name}`;
      writeMeta({ ...readMeta(id), id: other, status: "running", logPath: logPathFor(other), supervisionInterruptedAt: interrupted ? 2 : undefined });
      writeFileSync(logPathFor(other), log.map(value => JSON.stringify(value)).join("\n") + "\n");
      const outcome = reconcileInterruptedRun(readMeta(other), probe, 5);
      assert.equal(outcome.reconciliation.status, "lost");
      assert.equal(outcome.finalization, undefined, "loss cannot manufacture coherent owned terminal evidence");
      assert.equal(readMeta(other).status, "running", "caller still owns the fenced loss write");
    }
    writeMeta({ ...readMeta(id), status: "lost" });
    assert.equal(reconcileInterruptedRun(readMeta(id), probe, 6).finalization, undefined,
      "a previously committed loss must not be reopened by this pre-loss check");
    assert.equal(readMeta(id).status, "lost");
  } finally {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
