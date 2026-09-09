import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { baseDir, ensureTaskDir, getRegistryIoMetrics, listActiveMetasForOrigin, listMetas, listMetasForOrigin, logPathFor, metaPathFor, readMeta, resetRegistryIoMetrics, writeMeta } from "./registry.js";
import type { BackgroundTaskMeta } from "./types.js";

describe("registry meta sweep cache", () => {
  it("isolates durable test metadata by Vitest worker pool", () => {
    expect(process.env.VITEST_POOL_ID).toMatch(/^\d+$/);
    expect(baseDir()).toContain(`pi-better-background-tasks-vitest-${process.env.VITEST_POOL_ID}`);
  });

  it("does not re-read terminal metadata on repeated broad sweeps", () => {
    const meta = fixtureMeta("succeeded", "terminal cached");
    ensureTaskDir(meta.id);
    writeFileSync(metaPathFor(meta.id), JSON.stringify(meta, null, 2));

    expect(listMetas().find((candidate) => candidate.id === meta.id)?.name).toBe("terminal cached");

    writeFileSync(metaPathFor(meta.id), JSON.stringify({ ...meta, name: "externally changed" }, null, 2));

    expect(listMetas().find((candidate) => candidate.id === meta.id)?.name).toBe("terminal cached");
    expect(readMeta(meta.id)?.name).toBe("externally changed");
  });

  it("continues re-reading running metadata during broad sweeps", () => {
    const meta = fixtureMeta("running", "running first");
    ensureTaskDir(meta.id);
    writeFileSync(metaPathFor(meta.id), JSON.stringify(meta, null, 2));

    expect(listMetas().find((candidate) => candidate.id === meta.id)?.name).toBe("running first");

    writeFileSync(metaPathFor(meta.id), JSON.stringify({ ...meta, name: "running changed" }, null, 2));

    expect(listMetas().find((candidate) => candidate.id === meta.id)?.name).toBe("running changed");
  });

  it("updates cached terminal metadata through normal writes", () => {
    const meta = fixtureMeta("failed", "terminal written");
    writeMeta(meta);
    writeMeta({ ...meta, dismissedAt: 123 });

    expect(listMetas().find((candidate) => candidate.id === meta.id)?.dismissedAt).toBe(123);
  });
});

function fixtureMeta(status: BackgroundTaskMeta["status"], name: string): BackgroundTaskMeta {
  const id = `bg_registry_test_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const now = Date.now();
  return {
    id,
    name,
    kind: "command_watch",
    status,
    startedAt: now,
    endedAt: status === "running" ? undefined : now,
    logPath: logPathFor(id),
    callback: false,
    cwd: process.cwd(),
    spawnPid: process.pid,
  };
}

describe("session-owned registry index", () => {
  it("lists only metadata owned by the requested session", () => {
    const sessionId = `session-a-${process.pid}-${Date.now()}`;
    const ours = fixtureMeta("running", "owned");
    ours.callbackOrigin = { cwd: "/tmp/project", sessionId };
    const foreign = fixtureMeta("running", "foreign");
    foreign.callbackOrigin = { cwd: "/tmp/project", sessionId: "session-b" };
    writeMeta(ours);
    writeMeta(foreign);

    expect(listMetasForOrigin({ cwd: "/tmp/project", sessionId }).map((meta) => meta.id)).toEqual([ours.id]);
  });

  it("refreshes an indexed running record after a normal write", () => {
    const origin = { cwd: "/tmp/project", sessionId: "session-refresh" };
    const meta = fixtureMeta("running", "before");
    meta.callbackOrigin = origin;
    writeMeta(meta);

    expect(listMetasForOrigin(origin)[0]?.name).toBe("before");
    writeMeta({ ...meta, name: "after" });
    expect(listMetasForOrigin(origin)[0]?.name).toBe("after");
  });

  it("serves repeated owned reads entirely from process memory", () => {
    const origin = { cwd: "/tmp/project", sessionId: `session-cache-${process.pid}-${Date.now()}` };
    const meta = fixtureMeta("running", "memory resident");
    meta.callbackOrigin = origin;
    writeMeta(meta);
    expect(listMetasForOrigin(origin)).toHaveLength(1);

    resetRegistryIoMetrics();
    for (let index = 0; index < 100; index += 1) listMetasForOrigin(origin);

    expect(getRegistryIoMetrics()).toEqual({
      fullDirectoryReads: 0,
      indexDirectoryReads: 0,
      metadataFileReads: 0,
      indexRevisionChecks: 100,
    });
  });

  it("moves terminal transitions out of the active owner index", () => {
    const origin = { cwd: "/tmp/project", sessionId: `session-active-${process.pid}-${Date.now()}` };
    const meta = fixtureMeta("running", "active");
    meta.callbackOrigin = origin;
    writeMeta(meta);
    expect(listActiveMetasForOrigin(origin).map((candidate) => candidate.id)).toEqual([meta.id]);

    writeMeta({ ...meta, status: "succeeded", endedAt: Date.now() });
    expect(listActiveMetasForOrigin(origin)).toEqual([]);
    expect(listMetasForOrigin(origin).map((candidate) => candidate.id)).toEqual([meta.id]);
  });
});