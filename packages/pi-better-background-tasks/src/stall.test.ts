import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { observeBackgroundTaskStall } from "./stall.js";
import type { BackgroundTaskMeta } from "./types.js";

function meta(overrides: Partial<BackgroundTaskMeta> = {}): BackgroundTaskMeta {
  return {
    id: "bg_stall",
    kind: "process",
    status: "running",
    startedAt: 100,
    lastProgressAt: 100,
    logPath: join(mkdtempSync(join(tmpdir(), "bg-stall-")), "output.log"),
    cwd: "/tmp",
    spawnPid: 1,
    ...overrides,
  };
}

describe("background task stall observation", () => {
  it("marks a silent process stalled but accepts newer output as progress", () => {
    const task = meta();
    expect(observeBackgroundTaskStall(task, 300_100).state).toBe("stalled");

    writeFileSync(task.logPath, "progress\n");
    utimesSync(task.logPath, new Date(0), new Date(250_000));
    expect(observeBackgroundTaskStall(task, 300_100).state).toBe("healthy");
  });

  it("uses completed watcher polls as progress", () => {
    const task = meta({ kind: "command_watch", lastCheckedAt: 250_000 });
    expect(observeBackgroundTaskStall(task, 300_100).state).toBe("healthy");
  });
});