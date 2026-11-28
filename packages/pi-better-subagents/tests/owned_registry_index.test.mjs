import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parkedWaitForRun, parkedWaitsForResumedAttempt, reconcileParkedWaits, settleResumedAttemptExit } from "../worker-waits.ts";

const ROOT = mkdtempSync(join(tmpdir(), "subagent-owned-index-"));
process.env.TMPDIR = ROOT;

const {
  getRegistryIoMetrics,
  listActiveMetasForParent,
  listMetasForOrigin,
  listMetasForParent,
  listMetas,
  listPendingParkedRuns,
  logPathFor,
  parkRecordPath,
  resetRegistryIoMetrics,
  runDir,
  scanParkRecords,
  writeMeta,
} = await import("../registry.ts");

function meta(id, spawnPid, sessionId) {
  return {
    id,
    status: "running",
    pid: spawnPid + 100,
    spawnPid,
    cwd: "/tmp/project",
    callbackOrigin: { cwd: "/tmp/project", sessionId },
    promptPreview: id,
    startedAt: Date.now(),
    logPath: logPathFor(id),
    sessionId: `child-${id}`,
  };
}

describe("owned subagent registry indexes", () => {
  it("lists runs by parent without foreign records", () => {
    writeMeta(meta("sa_parent_a", 1001, "session-a"));
    writeMeta(meta("sa_parent_b", 1002, "session-b"));
    assert.deepEqual(listMetasForParent(1001).map((run) => run.id), ["sa_parent_a"]);
  });

  it("lists runs by callback origin without sibling sessions", () => {
    assert.deepEqual(
      listMetasForOrigin({ cwd: "/tmp/project", sessionId: "session-b" }).map((run) => run.id),
      ["sa_parent_b"],
    );
  });

  it("serves repeated owned reads without more filesystem reads", () => {
    listMetasForParent(1001);
    resetRegistryIoMetrics();
    for (let index = 0; index < 100; index += 1) listMetasForParent(1001);
    assert.deepEqual(getRegistryIoMetrics(), {
      fullDirectoryReads: 0,
      indexDirectoryReads: 0,
      metadataFileReads: 0,
      indexRevisionChecks: 100,
    });
  });

  it("does not re-read ordinary history while finding pending parks", () => {
    const history = Array.from({ length: 200 }, (_, index) => meta(`sa_history_${index}`, 2000 + index, "old-session"));
    resetRegistryIoMetrics();
    assert.deepEqual(listPendingParkedRuns(history), []);
    assert.equal(getRegistryIoMetrics().metadataFileReads, 0);
  });

  it("does not inspect every ordinary run when resolving a resumed attempt", () => {
    for (let index = 0; index < 30; index += 1) {
      writeMeta(meta(`sa_resume_history_${index}`, 3000 + index, "old-session"));
    }
    resetRegistryIoMetrics();
    listMetas();
    const baselineReads = getRegistryIoMetrics().metadataFileReads;
    resetRegistryIoMetrics();
    assert.deepEqual(parkedWaitsForResumedAttempt("sa_unrelated_resume"), []);
    assert.equal(getRegistryIoMetrics().metadataFileReads, baselineReads);
  });

  it("does not re-read ordinary history during startup reconciliation", async () => {
    resetRegistryIoMetrics();
    listMetas();
    const baselineReads = getRegistryIoMetrics().metadataFileReads;
    resetRegistryIoMetrics();
    await reconcileParkedWaits(undefined, { resume: async () => "skipped" });
    assert.equal(getRegistryIoMetrics().metadataFileReads, baselineReads);
  });

  it("recovers a park file published before its metadata mirror", async () => {
    const run = meta("sa_unmirrored_park", 4000, "park-owner");
    writeMeta(run);
    writeFileSync(parkRecordPath(run.id), JSON.stringify({
      version: 1,
      waitId: "wait-unmirrored",
      generation: 1,
      attemptId: run.id,
      parkedAt: Date.now(),
      phase: "resuming",
      resumedBy: "sa_previous_writer",
    }));
    assert.deepEqual(listPendingParkedRuns([run]).map((entry) => entry.id), [run.id]);
    assert.deepEqual(parkedWaitsForResumedAttempt("sa_previous_writer").map((entry) => entry.runId), [run.id]);
    assert.equal(parkedWaitForRun(run.id)?.waitId, "wait-unmirrored");
    assert.deepEqual((await Array.fromAsync(scanParkRecords([run]))).map(entry => entry.record.waitId), ["wait-unmirrored"]);
    resetRegistryIoMetrics();
    const result = await settleResumedAttemptExit({ attemptId: "sa_previous_writer", service: undefined,
      priorPark: { runId: run.id, waitId: "wait-unmirrored", generation: 2 } });
    assert.equal(result.outcome, "ignored", "an obsolete generation cannot settle a newer park");
    assert.equal(getRegistryIoMetrics().fullDirectoryReads, 0);
  });

  it("protects and reconciles a live park when its metadata still says consumed", async () => {
    const run = meta("sa_stale_park_mirror", 4010, "park-owner");
    const park = { version: 1, waitId: "wait-stale", generation: 1, attemptId: run.id, parkedAt: 1 };
    run.park = { ...park, phase: "consumed" };
    writeMeta(run);
    const live = { ...park, generation: 2, phase: "resuming", resumedBy: "sa_unpublished_attempt" };
    writeFileSync(parkRecordPath(run.id), JSON.stringify(live));

    assert.deepEqual(listPendingParkedRuns([run]).map(entry => entry.id), [run.id]);
    const pending = await Array.fromAsync(scanParkRecords([run], record => record.phase === "resuming"));
    assert.deepEqual(pending.map(entry => entry.record), [live]);
    await reconcileParkedWaits(undefined, { resume: async () => assert.fail("missing writer proof") });
    assert.equal(parkedWaitForRun(run.id)?.phase, "held");
  });

  it("releases a consumed park even if its metadata still says waiting", async () => {
    const run = meta("sa_stale_waiting_mirror", 4011, "park-owner");
    run.park = { version: 1, waitId: "wait-ended", generation: 1, attemptId: run.id, parkedAt: 1, phase: "waiting" };
    writeMeta(run);
    writeFileSync(parkRecordPath(run.id), JSON.stringify({ ...run.park, phase: "consumed" }));
    assert.deepEqual(listPendingParkedRuns([run]), []);
    assert.deepEqual(await Array.fromAsync(scanParkRecords([run], record => record.phase === "waiting")), []);
  });

  it("uses listed dispositions without probing reclaimed park directories", async t => {
    const runs = ["consumed", "cancelled", "waiting"].map((phase, index) => ({
      ...meta(`sa_archived_park_${index}`, 4100 + index, "park-owner"),
      park: { version: 1, waitId: `wait-${index}`, generation: 1, attemptId: `attempt-${index}`, parkedAt: 1, phase },
    }));
    resetRegistryIoMetrics();
    const reads = [
      t.mock.method(fs.promises, "readFile"),
      t.mock.method(fs, "readFileSync"),
      t.mock.method(fs, "existsSync"),
    ];
    syncBuiltinESMExports();
    try {
      const listed = await Array.fromAsync(scanParkRecords(runs));
      assert.deepEqual(listed.map(entry => entry.record), runs.map(run => run.park));
      assert.deepEqual(listPendingParkedRuns(runs).map(run => run.park), [runs[2].park]);
      for (const read of reads) {
        assert.ok(read.mock.calls.every(call => !String(call.arguments[0]).endsWith("/park.json")));
      }
      assert.equal(getRegistryIoMetrics().metadataFileReads, 0);
    } finally {
      for (const read of reads) read.mock.restore();
      syncBuiltinESMExports();
    }
  });

  it("services queued callbacks between batches of reclaimed runs", async () => {
    let serviced = false;
    const history = Array.from({ length: 1024 }, (_, i) => ({ id: `sa_reclaimed_${i}`, park: { phase: "waiting" } }));
    let seen = 0;
    for await (const entry of scanParkRecords(history)) {
      if (++seen === 1) setImmediate(() => { serviced = true; });
      if (seen === 33) assert.ok(serviced, "the second batch must allow pending I/O to run");
    }
    assert.equal(seen, history.length);
  });

  it("answers a socket request while checking historical park sidecars", { timeout: 5000 }, async () => {
    const history = Array.from({ length: 1024 }, (_, i) => ({ id: `sa_scan_history_${i}` }));
    for (const { id } of history) mkdirSync(runDir(id), { recursive: true });
    let finished = false;
    const server = createServer(socket => socket.once("data", () => socket.end(finished ? "finished" : "scanning")));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const client = createConnection(server.address().port, "127.0.0.1");
    let scan;
    try {
      await once(client, "connect");
      const reply = once(client, "data");
      scan = Array.fromAsync(scanParkRecords(history)).finally(() => { finished = true; });
      client.write("hello");
      assert.equal(String((await reply)[0]), "scanning");
      assert.deepEqual(await scan, []);
    } finally {
      client.destroy();
      await new Promise(resolve => server.close(resolve));
      await scan;
      for (const { id } of history) rmSync(runDir(id), { recursive: true });
    }
  });

  it("removes terminal transitions from the active parent index", () => {
    const active = meta("sa_active_transition", 1003, "session-c");
    writeMeta(active);
    assert.deepEqual(listActiveMetasForParent(1003).map((run) => run.id), [active.id]);

    writeMeta({ ...active, status: "completed", endedAt: Date.now() });
    assert.deepEqual(listActiveMetasForParent(1003), []);
    assert.deepEqual(listMetasForParent(1003).map((run) => run.id), [active.id]);
  });
});

process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }));
