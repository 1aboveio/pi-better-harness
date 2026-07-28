import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ensureTaskDir, listMetas, logPathFor, metaPathFor, readMeta, writeMeta } from "./registry.js";
import type { BackgroundTaskMeta } from "./types.js";

describe("registry meta sweep cache", () => {
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