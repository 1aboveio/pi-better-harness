// Generated fixed launch domain from packages/pi-better-background-tasks/src/runtime-stall.test.ts. Do not edit directly.
import { readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { failurePath } from "./failures.domain.mjs";
import { currentProcessStartToken } from "./process-identity.domain.mjs";
import { readMeta, taskDir, writeMeta } from "./registry.domain.mjs";
import { resumeRunningTask, resumeScheduledWork, suspendScheduledWork } from "./runtime.domain.mjs";
import { actionableFailures, readFailureState } from "./shared-failure-observations.domain.mjs";
import { observeBackgroundTaskStall } from "./stall.domain.mjs";
let id;
let sequence = 0;
beforeEach(() => { id = `bg_runtime_stall_572_${++sequence}`; });
const startedAt = Date.parse("2026-10-25T00:00:00Z");
const pi = { on() { }, sendMessage() { } };
function restoredTask(overrides = {}) {
    const task = { id, kind: "process", status: "running", startedAt,
        lastProgressAt: startedAt, logPath: `${taskDir(id)}/output.log`, cwd: process.cwd(),
        spawnPid: process.pid, spawnPidStartTime: currentProcessStartToken(),
        pid: process.pid, pidStartTime: currentProcessStartToken(), callback: false, ...overrides };
    writeMeta(task);
    writeFileSync(task.logPath, "checkpoint\n");
    utimesSync(task.logPath, new Date(startedAt), new Date(startedAt));
    return task;
}
afterEach(() => {
    suspendScheduledWork();
    resumeScheduledWork();
    vi.useRealTimers();
    rmSync(taskDir(id), { recursive: true, force: true });
});
describe("runtime suspected-stall maintenance", () => {
    it("closes a stall observation when a restored task has completed, even with callbacks disabled", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(startedAt + 300_000);
        resumeScheduledWork();
        const task = restoredTask();
        resumeRunningTask(pi, task);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(actionableFailures(readFailureState(failurePath(id)))).toHaveLength(1);
        const terminal = { ...readMeta(id), status: "succeeded", endedAt: Date.now() };
        writeMeta(terminal);
        resumeRunningTask(pi, terminal);
        expect(actionableFailures(readFailureState(failurePath(id)))).toHaveLength(0);
        expect(readMeta(id)?.status).toBe("succeeded");
    });
    it("records one silent spell after resume, recovers on output, and stops observing on suspension", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(startedAt);
        resumeScheduledWork();
        const task = restoredTask();
        resumeRunningTask(pi, task);
        await vi.advanceTimersByTimeAsync(300_000);
        expect(actionableFailures(readFailureState(failurePath(id)))).toHaveLength(1);
        expect(readMeta(id)?.status).toBe("running");
        const journal = readFileSync(failurePath(id), "utf8");
        await vi.advanceTimersByTimeAsync(5_000);
        expect(readFileSync(failurePath(id), "utf8")).toBe(journal);
        writeFileSync(task.logPath, "new checkpoint\n");
        utimesSync(task.logPath, new Date(Date.now()), new Date(Date.now()));
        await vi.advanceTimersByTimeAsync(1_000);
        expect(actionableFailures(readFailureState(failurePath(id)))).toHaveLength(0);
        suspendScheduledWork();
        await vi.advanceTimersByTimeAsync(300_000);
        expect(actionableFailures(readFailureState(failurePath(id)))).toHaveLength(0);
    });
    it("does not count its log-retention writes as new task progress", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(startedAt + 300_000);
        resumeScheduledWork();
        const task = restoredTask({ maxLogBytes: 100 });
        writeFileSync(task.logPath, "output\n".repeat(20_000));
        utimesSync(task.logPath, new Date(startedAt), new Date(startedAt));
        resumeRunningTask(pi, task);
        await vi.advanceTimersByTimeAsync(2_000);
        const saved = readMeta(id);
        expect(saved.logGeneration).toBeGreaterThan(0);
        expect(saved.lastProgressAt).toBe(startedAt);
        expect(saved.logMaintenance?.size).toBe(statSync(saved.logPath).size);
        expect(observeBackgroundTaskStall(saved).state).toBe("stalled");
    });
});
