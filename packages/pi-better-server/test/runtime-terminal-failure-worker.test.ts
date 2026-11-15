import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WorkReadModel } from "../src/runtime/read-model.ts";
import { WorkClient } from "../src/runtime/work-client.mjs";
import { acquireMutationStore } from "../src/runtime/mutation-store.ts";
const domain = "../../pi-better-subagents/";
const { startWorkRuntimeFixture } = await import(domain + "tests/work-runtime-fixture.mjs");
const { writeMeta, runDir, logPathFor } = await import(domain + "registry.ts");
const { failurePath, readRunFailures, pendingFailureAttention } = await import(domain + "failures.ts");
const delay = () => new Promise(resolve => setTimeout(resolve, 10));

test("derived fold index bounds batches and preserves overflow and in-flight revisions", async () => {
  const root = process.env.PI_CODING_AGENT_DIR!, base = join(root, "index-runs"); mkdirSync(root, { recursive: true });
  for (let i = 0; i < 260; i++) {
    const id = `index_${i}`, dir = join(base, "runs", id); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ id, sessionId: id, cwd: root, status: "lost", startedAt: 1, endedAt: 2, management: { root } }));
    writeFileSync(join(dir, "output.log"), "{}\n");
  }
  const model = new WorkReadModel(root, "bounded-index", { baseDir: base, intervalMs: 0 });
  try {
    await model.reconcile(); const first = model.terminalLogChanges(); assert.equal(first.length, 128);
    appendFileSync(join(base, "runs", first[0]!.id, "output.log"), "{malformed\n");
    await model.reconcile(); model.acknowledgeTerminalLogs(first);
    const seen = new Set(first.map(entry => entry.id)); let newer = false;
    for (;;) {
      const batch = model.terminalLogChanges(); if (!batch.length) break;
      assert.ok(batch.length <= 128);
      newer ||= batch.some(entry => entry.id === first[0]!.id && entry.revision !== first[0]!.revision);
      for (const entry of batch) seen.add(entry.id);
      model.acknowledgeTerminalLogs(batch);
    }
    assert.equal(seen.size, 260); assert.equal(newer, true, "old acknowledgement cannot lose newer log content");
  } finally { model.close(); }
});

test("large cold log folding stays off the socket thread and drains overflow without losing failures", { timeout: 60000 }, async (t) => {
  const root = process.env.PI_CODING_AGENT_DIR!, cwd = process.cwd(); mkdirSync(root, { recursive: true });
  const lease = acquireMutationStore(root); lease.store.subagentLaunchJournal().epoch("prior"); lease.release();
  const daemon = await startWorkRuntimeFixture(), client = new WorkClient(daemon.socketPath, root);
  const ids = Array.from({ length: 132 }, (_, i) => `fold_overflow_${i}`);
  try {
    await client.request("runtime_get_snapshot", { scope: { cwd } });
    for (const id of ids) {
      mkdirSync(runDir(id), { recursive: true });
      if (id === ids[0]) { writeFileSync(logPathFor(id), Buffer.alloc(128 * 1024 * 1024, 120)); appendFileSync(logPathFor(id), "\n{malformed\n"); }
      else writeFileSync(logPathFor(id), "{malformed\n");
      writeMeta({ id, sessionId: id, status: "lost", cwd, startedAt: Date.now() - 120000, endedAt: Date.now() - 60000,
        lostCallbackSentAt: Date.now() - 60000, callback: true, pid: 0, spawnPid: 0, promptPreview: "fixture", logPath: logPathFor(id),
        callbackOrigin: { sessionId: "offline", cwd }, management: { root, instance: "prior", epoch: 1 } });
    }
    let observedFolding = false, maximumMs = 0; const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const start = performance.now(); const status = await client.request("runtime_get_status");
      maximumMs = Math.max(maximumMs, performance.now() - start);
      observedFolding ||= status.subagentManagement?.failureFold?.inFlight === true;
      if (ids.every(id => existsSync(failurePath(id)))) break;
      await delay();
    }
    assert.ok(ids.every(id => Boolean(pendingFailureAttention(readRunFailures(id), Date.now(), { terminal: true }))), "all overflow IDs retain their exact owed failure");
    assert.equal(observedFolding, true, "socket samples overlap mechanical folding");
    t.diagnostic(`Maximum socket status latency during 128 MiB cold scan: ${maximumMs.toFixed(1)}ms`);
    assert.ok(maximumMs < 1000, `socket status blocked for ${maximumMs}ms during cold folding`);
  } finally { client.close(); await daemon(); }
});

test("replacement manager revokes queued mechanical folds and close releases the worker", { timeout: 30000 }, async () => {
  if (Number(process.versions.node.split(".")[0]) < 24) {
    const executable = process.env.PI_TEST_PRIVATE_RUNTIME_NODE;
    assert.ok(executable, "managed runtime tests require the pinned Node 24 executable");
    execFileSync(executable, ["--import", "tsx", "--import", fileURLToPath(new URL("../../../scripts/isolate-registry.mjs", import.meta.url)), "--test", "--test-name-pattern=replacement manager revokes", fileURLToPath(import.meta.url)], { timeout: 20000, env: process.env });
    return;
  }
  const root = process.env.PI_CODING_AGENT_DIR!, id = "fold_revoked";
  const { createSubagentLaunch } = await import("../src/runtime/subagent-launch.ts");
  const first = await createSubagentLaunch(root, "fold-first", {});
  let second: any;
  try {
    mkdirSync(runDir(id), { recursive: true }); writeFileSync(logPathFor(id), "{malformed\n");
    writeMeta({ id, sessionId: id, status: "failed", cwd: root, pid: 0, spawnPid: 0, startedAt: 1, endedAt: 2, callback: false, promptPreview: "fixture", logPath: logPathFor(id), management: { root, instance: "fold-first", epoch: first.status().runtimeEpoch } });
    const fold = first.foldTerminalFailures([id]);
    const rejected = assert.rejects(fold, /revoked/);
    const startedBy = Date.now() + 5000;
    while (!first.status().failureFold.inFlight) { assert.ok(Date.now() < startedBy, "mechanical fold was not admitted"); await delay(); }
    second = await createSubagentLaunch(root, "fold-second", {});
    await rejected;
    assert.equal(existsSync(failurePath(id)), false, "revoked worker cannot publish canonical failure evidence");
    await first.close(); assert.equal(first.status().failureFold.worker, false);
    await second.foldTerminalFailures([id]);
    assert.ok(existsSync(failurePath(id)), "current journal owner can fold the retained obligation");
  } finally { await first.close(); await second?.close(); }
});
