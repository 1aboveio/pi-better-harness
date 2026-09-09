import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "subagent-owned-index-"));
process.env.TMPDIR = ROOT;

const {
  getRegistryIoMetrics,
  listActiveMetasForParent,
  listMetasForOrigin,
  listMetasForParent,
  logPathFor,
  resetRegistryIoMetrics,
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