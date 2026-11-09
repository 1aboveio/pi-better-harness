import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "./index.js";
import {
  failurePath, recordFailure, resumeFailureAttention, scheduleFailureAttention,
  stopFailureAttention, suspendFailureAttention,
} from "./failures.js";
import { currentProcessStartToken } from "./process-identity.js";
import { removeMeta, taskDir, writeMeta } from "./registry.js";
import { resumeRunningTask, resumeScheduledWork, suspendScheduledWork } from "./runtime.js";
import { readFailureState } from "./shared-failure-observations.js";
import type { BackgroundTaskCallbackOrigin, BackgroundTaskMeta } from "./types.js";

const tasks: BackgroundTaskMeta[] = [];
const shutdowns: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  resumeScheduledWork();
  resumeFailureAttention();
});
afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown();
  suspendScheduledWork();
  suspendFailureAttention();
  for (const task of tasks.splice(0)) removeMeta(task);
  vi.useRealTimers();
});

function host() {
  const pi = { sendMessage: vi.fn() } as unknown as ExtensionAPI;
  return pi;
}

function runningFailure(id: string, origin: BackgroundTaskCallbackOrigin = { cwd: process.cwd(), sessionId: "legacy-attention" }) {
  const meta: BackgroundTaskMeta = {
    id, kind: "process", status: "running", startedAt: Date.now(),
    logPath: `${taskDir(id)}/output.log`, cwd: origin.cwd, callbackOrigin: origin, callback: true,
    pid: process.pid, spawnPid: process.pid, spawnPidStartTime: currentProcessStartToken(),
  };
  tasks.push(meta);
  writeMeta(meta);
  recordFailure(meta, "execution", `failure in ${id}`, "first");
  return meta;
}

function extensionHost(sessionId: string) {
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const pi = {
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool() {},
    events: { on() {}, emit() {} },
    sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  const origin = { cwd: process.cwd(), sessionId };
  const ctx = {
    cwd: origin.cwd, mode: "rpc", hasUI: false, isIdle: () => true,
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as ExtensionContext;
  const emit = async (name: string) => {
    for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
  };
  extension(pi);
  shutdowns.push(() => emit("session_shutdown"));
  return { pi, origin, emit };
}

describe("failure attention lifecycle ownership", () => {
  it("legacy runtime suspension clears exported attention timers and resume allows delivery", async () => {
    const pi = host();
    const task = runningFailure("bg_legacy_suspend");
    scheduleFailureAttention(pi, task.id, () => task.callbackOrigin);
    expect(vi.getTimerCount()).toBe(1);

    suspendScheduledWork();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(readFailureState(failurePath(task.id)).delivered).toEqual({});

    scheduleFailureAttention(pi, task.id, () => task.callbackOrigin);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    resumeScheduledWork();
    scheduleFailureAttention(pi, task.id, () => task.callbackOrigin);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(Object.keys(readFailureState(failurePath(task.id)).delivered)).toHaveLength(1);
  });

  it("legacy runtime resume re-enables attention suspended by the exported failure helper", async () => {
    const pi = host();
    const task = runningFailure("bg_legacy_resume");
    suspendFailureAttention();
    resumeScheduledWork();
    scheduleFailureAttention(pi, task.id, () => task.callbackOrigin);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(Object.keys(readFailureState(failurePath(task.id)).delivered)).toHaveLength(1);
  });

  it("exported stop cancels attention scheduled by the legacy runtime without acknowledging the incident", async () => {
    const pi = host();
    const task = runningFailure("bg_legacy_stop");
    resumeRunningTask(pi, task, () => task.callbackOrigin);
    stopFailureAttention(task.id);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(readFailureState(failurePath(task.id)).delivered).toEqual({});

    scheduleFailureAttention(pi, task.id, () => task.callbackOrigin);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(Object.keys(readFailureState(failurePath(task.id)).delivered)).toHaveLength(1);
  });

  it("cached extension factories keep attention independent of each other and the legacy singleton", async () => {
    const parent = extensionHost("attention-parent");
    const child = extensionHost("attention-child");
    const parentTask = runningFailure("bg_factory_parent", parent.origin);
    const childTask = runningFailure("bg_factory_child", child.origin);
    await parent.emit("session_start");
    await child.emit("session_start");

    await child.emit("session_shutdown");
    suspendScheduledWork();
    stopFailureAttention(parentTask.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(parent.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(Object.keys(readFailureState(failurePath(parentTask.id)).delivered)).toHaveLength(1);
    expect(child.pi.sendMessage).not.toHaveBeenCalled();
    expect(readFailureState(failurePath(childTask.id)).delivered).toEqual({});

    await child.emit("session_start");
    expect(child.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(Object.keys(readFailureState(failurePath(childTask.id)).delivered)).toHaveLength(1);
    expect(parent.pi.sendMessage).toHaveBeenCalledTimes(1);
  });
});
