import { appendFileSync, utimesSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { failurePath, recordFailure, resumeFailureAttention, scheduleFailureAttention, stopFailureAttention } from "./failures.js";
import { readMeta, taskDir, writeMeta } from "./registry.js";
import { actionableFailures, failureHistory, pendingFailureAttention, readFailureState } from "./shared-failure-observations.js";
import { observeTaskStallAttention } from "./stall-attention.js";
import type { BackgroundTaskMeta } from "./types.js";

const startedAt = Date.parse("2026-10-25T00:00:00Z");
const origin = { cwd: process.cwd(), sessionId: "stall-attention-tests" };
let task: BackgroundTaskMeta;
let sequence = 0;
let messages: Array<{ content: string }>;
let pi: ExtensionAPI;

function at(elapsed: number): void {
  vi.setSystemTime(startedAt + elapsed);
}

function outputAt(elapsed: number): void {
  appendFileSync(task.logPath, "progress\n");
  utimesSync(task.logPath, new Date(startedAt + elapsed), new Date(startedAt + elapsed));
}

function state() {
  return readFailureState(failurePath(task.id));
}

function observeAndSchedule(): boolean {
  const needed = observeTaskStallAttention(task);
  if (needed) scheduleFailureAttention(pi, task.id, () => origin);
  return needed;
}

beforeEach(() => {
  vi.useFakeTimers();
  at(0);
  vi.stubEnv("PI_BETTER_STALL_QUIET_MS", "60000");
  vi.stubEnv("PI_BETTER_STALL_MS", "300000");
  resumeFailureAttention();
  const id = `bg_stall_attention_${++sequence}`;
  task = { id, kind: "process", status: "running", startedAt, lastProgressAt: startedAt,
    logPath: `${taskDir(id)}/output.log`, cwd: origin.cwd, spawnPid: process.pid,
    callbackOrigin: origin, callback: true };
  writeMeta(task);
  writeFileSync(task.logPath, "");
  utimesSync(task.logPath, new Date(startedAt), new Date(startedAt));
  messages = [];
  pi = { sendMessage: (message: { content: string }) => { messages.push(message); } } as unknown as ExtensionAPI;
});

afterEach(() => {
  stopFailureAttention(task.id);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("suspected-stall attention", () => {
  it.each(["succeeded", "failed", "cancelled", "timed_out"] as const)("closes a suspected stall when execution becomes %s", (status) => {
    at(300_000);
    expect(observeTaskStallAttention(task)).toBe(true);
    task.status = status;
    expect(observeTaskStallAttention(task)).toBe(false);
    expect(actionableFailures(state())).toEqual([]);
    expect(failureHistory(state())).toEqual([expect.objectContaining({ category: "stall", status: "resolved" })]);
  });

  it("does not request attention before the stall boundary, including quiet work", () => {
    for (const elapsed of [0, 59_999, 60_000, 299_999]) {
      at(elapsed);
      expect(observeAndSchedule()).toBe(false);
    }
    expect(actionableFailures(state())).toEqual([]);
    expect(messages).toEqual([]);
  });

  it("delivers once per silent spell through the existing grace scheduler and journal receipts", async () => {
    at(300_000);
    const unchanged = structuredClone(task);
    expect(observeAndSchedule()).toBe(true);
    const first = actionableFailures(state());
    expect(first).toEqual([expect.objectContaining({ category: "stall", status: "unresolved", count: 1 })]);
    expect(first[0].summary).toContain("suspected stall");
    expect(messages).toEqual([]);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(messages).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("suspected stall");
    expect(state().delivered[first[0].id]).toBe(startedAt + 360_000);

    // Re-read persisted metadata, as a resumed runtime does; no module-local spell state is needed.
    task = readMeta(task.id)!;
    expect(observeAndSchedule()).toBe(false);
    scheduleFailureAttention(pi, task.id, () => origin);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(observeAndSchedule()).toBe(false);
    expect(messages).toHaveLength(1);
    expect(actionableFailures(state())[0]).toMatchObject({ id: first[0].id, count: 1 });
    expect(task).toEqual(unchanged);
    expect(readMeta(task.id)).toEqual(unchanged);

    outputAt(960_000);
    expect(observeAndSchedule()).toBe(false);
    at(1_260_000);
    expect(observeAndSchedule()).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(messages).toHaveLength(2);
    expect(Object.keys(state().delivered)).toHaveLength(2);
  });

  it("recovers on new process output, preserves unrelated incidents, and can notify after later silence", async () => {
    at(300_000);
    expect(observeAndSchedule()).toBe(true);
    const first = actionableFailures(state())[0];
    recordFailure(task, "other-operation", "unrelated failure", "attempt", { category: "watch" });
    at(310_000);
    outputAt(310_000);
    expect(observeAndSchedule()).toBe(false);
    expect(failureHistory(state()).find((incident) => incident.id === first.id)).toMatchObject({
      status: "resolved", resolvedAt: startedAt + 310_000,
    });
    expect(actionableFailures(state()).map((incident) => incident.operation)).toEqual(["other-operation"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(messages.every((message) => !message.content.includes("suspected stall"))).toBe(true);

    at(610_000);
    expect(observeAndSchedule()).toBe(true);
    const second = actionableFailures(state()).find((incident) => incident.category === "stall")!;
    expect(second.id).not.toBe(first.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(messages.filter((message) => message.content.includes("suspected stall"))).toHaveLength(1);
    expect(state().delivered[second.id]).toBe(startedAt + 670_000);
    expect(task.status).toBe("running");
  });

  it("opens a new incident when progress and later silence both happen between monitor ticks", () => {
    at(300_000);
    expect(observeTaskStallAttention(task)).toBe(true);
    const first = actionableFailures(state())[0];
    outputAt(310_000);
    at(700_000);
    expect(observeTaskStallAttention(readMeta(task.id)!)).toBe(true);
    const second = actionableFailures(state())[0];
    expect(second.id).not.toBe(first.id);
    expect(failureHistory(state()).find((incident) => incident.id === first.id)?.status).toBe("resolved");
    expect(observeTaskStallAttention(task)).toBe(false);
    expect(second.count).toBe(1);
  });

  it("replays undelivered attention from the journal after a failed callback handoff", async () => {
    let reject = true;
    pi = { sendMessage: (message: { content: string }) => {
      if (reject) throw new Error("handoff unavailable");
      messages.push(message);
    } } as unknown as ExtensionAPI;
    at(300_000);
    expect(observeAndSchedule()).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(messages).toEqual([]);
    expect(state().delivered).toEqual({});
    expect(pendingFailureAttention(state(), Date.now())?.incidents).toHaveLength(1);
    stopFailureAttention(task.id);
    reject = false;
    expect(observeTaskStallAttention(readMeta(task.id)!)).toBe(false);
    scheduleFailureAttention(pi, task.id, () => origin);
    await vi.advanceTimersByTimeAsync(0);
    expect(messages).toHaveLength(1);
    expect(pendingFailureAttention(state(), Date.now())).toBeUndefined();
  });

  it.each(["callback-disabled", "inactive-origin", "stop-requested"] as const)("honors existing %s delivery suppression", async (mode) => {
    if (mode === "callback-disabled") task.callback = false;
    if (mode === "stop-requested") task.stopRequestedAt = startedAt + 1;
    writeMeta(task);
    at(300_000);
    expect(observeTaskStallAttention(task)).toBe(true);
    const active = mode === "inactive-origin" ? { ...origin, sessionId: "other-session" } : origin;
    scheduleFailureAttention(pi, task.id, () => active);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(messages).toEqual([]);
    expect(state().delivered).toEqual({});
    expect(task.status).toBe("running");
  });

  it("recovers a watch only on a changed outcome, not on its polls or log writes", () => {
    task.kind = "command_watch";
    at(300_000);
    expect(observeTaskStallAttention(task)).toBe(true);
    const first = actionableFailures(state())[0];
    at(310_000);
    outputAt(310_000);
    expect(observeTaskStallAttention(task)).toBe(false);
    expect(actionableFailures(state())[0].id).toBe(first.id);
    // Poll activity is not progress: it neither recovers nor hides the spell.
    task.lastCheckedAt = startedAt + 310_000;
    expect(observeTaskStallAttention(task)).toBe(false);
    expect(actionableFailures(state())[0].id).toBe(first.id);
    // A changed observed outcome moves the state clock and closes the spell.
    task.lastProgressAt = startedAt + 310_000;
    expect(observeTaskStallAttention(task)).toBe(false);
    expect(actionableFailures(state())).toEqual([]);
    at(610_000);
    expect(observeTaskStallAttention(task)).toBe(true);
    expect(actionableFailures(state())[0].id).not.toBe(first.id);
  });

  it("does not mistake a threshold change for progress", () => {
    at(300_000);
    expect(observeTaskStallAttention(task)).toBe(true);
    const first = actionableFailures(state())[0];
    vi.stubEnv("PI_BETTER_STALL_MS", "600000");
    expect(observeTaskStallAttention(task)).toBe(false);
    expect(actionableFailures(state())[0].id).toBe(first.id);
  });

  it.each(["succeeded", "failed", "cancelled", "timed_out"] as const)("does not add a stall incident to %s tasks", (status) => {
    task.status = status;
    at(900_000);
    expect(observeTaskStallAttention(task)).toBe(false);
    expect(failureHistory(state())).toEqual([]);
    expect(task.status).toBe(status);
  });
});
