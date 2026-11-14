import { appendFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { failurePath, recordFailure } from "./failures.js";
import { readMeta, taskDir, writeMeta } from "./registry.js";
import { actionableFailures, failureCounts, failureHistory, formatFailureLines, formatPendingAttention, pendingFailureAttention, readFailureState } from "./shared-failure-observations.js";
import { observeTaskStallAttention } from "./stall-attention.js";
import { observeBackgroundTaskStall } from "./stall.js";
import type { BackgroundTaskMeta } from "./types.js";

const startedAt = Date.parse("2026-10-25T00:00:00Z");
let sequence = 0;
let task: BackgroundTaskMeta;
const at = (elapsed: number) => vi.setSystemTime(startedAt + elapsed);
const state = () => readFailureState(failurePath(task.id));

beforeEach(() => {
  vi.useFakeTimers();
  at(0);
  vi.stubEnv("PI_BETTER_STALL_QUIET_MS", "60000");
  vi.stubEnv("PI_BETTER_STALL_MS", "300000");
  const id = `bg_stall_observation_${++sequence}`;
  rmSync(taskDir(id), { recursive: true, force: true });
  task = { id, kind: "process", status: "running", startedAt, lastProgressAt: startedAt,
    logPath: `${taskDir(id)}/output.log`, cwd: process.cwd(), spawnPid: process.pid,
    callback: true };
  writeMeta(task);
  writeFileSync(task.logPath, "");
  utimesSync(task.logPath, new Date(startedAt), new Date(startedAt));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(taskDir(task.id), { recursive: true, force: true });
});

describe("silent task observation", () => {
  it("is visible without notifying at either the running or terminal boundary", () => {
    at(300_000);
    expect(observeBackgroundTaskStall(task).state).toBe("stalled");
    expect(observeTaskStallAttention(task)).toBe(false);
    expect(failureHistory(state())).toEqual([expect.objectContaining({ category: "stall", status: "unresolved" })]);
    expect(formatFailureLines(state(), { scope: "all" })[0]).toContain("Suspected stall");
    expect(actionableFailures(state())).toEqual([]);
    expect(failureCounts(state()).actionRequired).toBe(0);
    expect(failureCounts(state()).unclassified).toBe(0);
    expect(pendingFailureAttention(state(), Date.now())).toBeUndefined();
    expect(pendingFailureAttention(state(), Date.now(), { terminal: true })).toBeUndefined();
    expect(task.status).toBe("running");
  });

  it("records a single observation for repeated checks and closes it on progress", () => {
    at(300_000);
    expect(observeTaskStallAttention(task)).toBe(false);
    expect(failureHistory(state())).toHaveLength(1);
    at(800_000);
    expect(observeTaskStallAttention(readMeta(task.id)!)).toBe(false);
    expect(failureHistory(state())[0]?.count).toBe(1);
    appendFileSync(task.logPath, "progress\n");
    utimesSync(task.logPath, new Date(startedAt + 800_000), new Date(startedAt + 800_000));
    expect(observeTaskStallAttention(task)).toBe(false);
    expect(failureHistory(state())[0]?.status).toBe("resolved");
    expect(failureCounts(state()).recovered).toBe(0);
    at(1_100_000);
    expect(observeTaskStallAttention(task)).toBe(false);
    expect(failureHistory(state())).toHaveLength(2);
    expect(failureHistory(state()).filter((x) => x.status === "unresolved")).toHaveLength(1);
  });

  it.each(["succeeded", "failed", "cancelled", "timed_out"] as const)(
    "recovers a recorded silent spell when a task becomes %s", (status) => {
      at(300_000);
      observeTaskStallAttention(task);
      task.status = status;
      expect(observeTaskStallAttention(task)).toBe(false);
      expect(failureHistory(state())[0]?.status).toBe("resolved");
      expect(actionableFailures(state())).toEqual([]);
    },
  );

  it("does not hide actual failures alongside a silent spell", () => {
    at(300_000);
    observeTaskStallAttention(task);
    recordFailure(task, "watch-poll", "watch command failed", "error", { category: "ssh" });
    expect(actionableFailures(state()).map((x) => x.operation)).toEqual(["watch-poll"]);
    const pending = pendingFailureAttention(state(), Date.now() + 60_000)!;
    expect(pending.incidents).toHaveLength(1);
    expect(formatPendingAttention(state(), pending.incidents)).not.toContain("other active failure");
    expect(pendingFailureAttention(state(), Date.now() + 60_000, { terminal: true })?.incidents).toHaveLength(1);
  });
});
