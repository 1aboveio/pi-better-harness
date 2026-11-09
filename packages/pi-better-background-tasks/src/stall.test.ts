import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { backgroundTaskProgressAt, observeBackgroundTaskStall } from "./stall.js";
import type { BackgroundTaskMeta } from "./types.js";

const startedAt = Date.parse("2026-10-25T00:00:00Z");
let directory: string;

function meta(overrides: Partial<BackgroundTaskMeta> = {}): BackgroundTaskMeta {
  return {
    id: "bg_stall",
    kind: "process",
    status: "running",
    startedAt,
    lastProgressAt: startedAt,
    logPath: join(directory, "output.log"),
    cwd: directory,
    spawnPid: 1,
    ...overrides,
  };
}

function outputAt(task: BackgroundTaskMeta, at: number): void {
  writeFileSync(task.logPath, "progress\n");
  utimesSync(task.logPath, new Date(at), new Date(at));
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "bg-stall-"));
  vi.useFakeTimers();
  vi.setSystemTime(startedAt + 300_000);
  vi.stubEnv("PI_BETTER_STALL_QUIET_MS", "60000");
  vi.stubEnv("PI_BETTER_STALL_MS", "300000");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe("background task stall observation", () => {
  it.each([
    [59_999, "healthy"],
    [60_000, "quiet"],
    [299_999, "quiet"],
    [300_000, "stalled"],
  ] as const)("classifies %i ms of silence as %s without changing lifecycle", (silence, state) => {
    const task = meta();
    const observation = observeBackgroundTaskStall(task, startedAt + silence);
    expect(observation.state).toBe(state);
    expect(observation.observedAt).toBe(startedAt);
    expect(observation.ageMs).toBe(silence);
    expect(task.status).toBe("running");
  });

  it("accepts newer process output as progress without a metadata refresh", () => {
    const task = meta();
    expect(observeBackgroundTaskStall(task).state).toBe("stalled");
    outputAt(task, startedAt + 250_000);
    expect(observeBackgroundTaskStall(task)).toMatchObject({ state: "healthy", observedAt: startedAt + 250_000, ageMs: 50_000 });
    expect(task.lastProgressAt).toBe(startedAt);
  });

  it("never replaces recorded progress with an older log timestamp", () => {
    const task = meta({ lastProgressAt: startedAt + 250_000 });
    outputAt(task, startedAt + 1_000);
    expect(backgroundTaskProgressAt(task)).toBe(startedAt + 250_000);
    expect(observeBackgroundTaskStall(task).state).toBe("healthy");
  });

  it("does not treat a watch's completed polls or its own log writes as progress", () => {
    const task = meta({ kind: "command_watch", lastCheckedAt: startedAt + 290_000 });
    outputAt(task, startedAt + 250_000);
    expect(backgroundTaskProgressAt(task)).toBe(startedAt);
    expect(observeBackgroundTaskStall(task)).toMatchObject({ state: "stalled", observedAt: startedAt, ageMs: 300_000 });
  });

  it("advances a watch once its observed state changes", () => {
    const task = meta({ kind: "command_watch", lastCheckedAt: startedAt + 290_000, lastProgressAt: startedAt + 250_000 });
    expect(observeBackgroundTaskStall(task)).toMatchObject({ state: "healthy", observedAt: startedAt + 250_000, ageMs: 50_000 });
  });

  it("falls back to launch time for a restored task without progress metadata or readable log", () => {
    const task = meta({ lastProgressAt: undefined });
    expect(observeBackgroundTaskStall(task)).toMatchObject({ state: "stalled", observedAt: startedAt, ageMs: 300_000 });
  });

  it.each(["succeeded", "failed", "cancelled", "timed_out"] as const)("does not classify terminal %s work as stalled", (status) => {
    expect(observeBackgroundTaskStall(meta({ status, endedAt: startedAt + 1_000 })).state).not.toBe("stalled");
  });

  it("honors configured thresholds at inclusive boundaries", () => {
    vi.stubEnv("PI_BETTER_STALL_QUIET_MS", "1000");
    vi.stubEnv("PI_BETTER_STALL_MS", "2000");
    const task = meta();
    expect(observeBackgroundTaskStall(task, startedAt + 999).state).toBe("healthy");
    expect(observeBackgroundTaskStall(task, startedAt + 1_000).state).toBe("quiet");
    expect(observeBackgroundTaskStall(task, startedAt + 1_999).state).toBe("quiet");
    expect(observeBackgroundTaskStall(task, startedAt + 2_000).state).toBe("stalled");
  });

  it("ignores invalid duration overrides and clamps clock skew to zero silence", () => {
    vi.stubEnv("PI_BETTER_STALL_QUIET_MS", "NaN");
    vi.stubEnv("PI_BETTER_STALL_MS", "-1");
    expect(observeBackgroundTaskStall(meta(), startedAt + 60_000).state).toBe("quiet");
    expect(observeBackgroundTaskStall(meta(), startedAt + 300_000).state).toBe("stalled");
    expect(observeBackgroundTaskStall(meta(), startedAt - 1_000)).toMatchObject({ state: "healthy", ageMs: 0 });
  });
});
