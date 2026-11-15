// Generated fixed launch domain from packages/pi-better-background-tasks/src/reload-handoff.test.ts. Do not edit directly.
// Same-process handoff after session shutdown (#324). A reloaded or switched-away
// extension instance may still own a task's child; the resuming instance must
// deliver what it records, and must still mark a truly lost process as lost.
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentProcessStartToken } from "./process-identity.domain.mjs";
import { getRegistryIoMetrics, readMeta, resetRegistryIoMetrics, taskDir, writeMeta } from "./registry.domain.mjs";
import { resumeRunningTask, resumeScheduledWork, spawnTask, suspendScheduledWork } from "./runtime.domain.mjs";
import { FakeRemoteRunner, successfulResult } from "./test-support/fake-remote-runner.domain.mjs";
const origin = { cwd: process.cwd(), sessionId: "reload-handoff" };
const ids = [];
afterEach(() => {
    vi.useRealTimers();
    resumeScheduledWork();
    for (const id of ids.splice(0))
        rmSync(taskDir(id), { recursive: true, force: true });
});
function host() {
    const messages = [];
    const pi = { sendMessage: (message) => { messages.push(message.content); } };
    return { pi, messages };
}
async function until(fn, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = fn();
        if (value)
            return value;
        if (Date.now() > deadline)
            throw new Error("timed out");
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}
describe("reload handoff", () => {
    it("a suspended instance records a later exit but leaves the callback to the resuming instance", async () => {
        const before = host();
        const meta = spawnTask(before.pi, { command: "sleep 0.5; echo done" }, process.cwd(), origin, () => undefined);
        ids.push(meta.id);
        suspendScheduledWork();
        // A fresh module instance in the same process, as Pi's /reload loads one.
        vi.resetModules();
        const fresh = await import("./runtime.domain.mjs");
        const freshBatcher = await import("./shared-callback-batcher.domain.mjs");
        const after = host();
        fresh.resumeScheduledWork();
        fresh.resumeRunningTask(after.pi, readMeta(meta.id), () => origin);
        const terminal = await until(() => {
            const current = readMeta(meta.id);
            return current?.callbackSentAt || current?.callbackSuppressedAt ? current : undefined;
        });
        await freshBatcher.getCallbackBatcher(after.pi).flush();
        expect(terminal.status).toBe("succeeded");
        expect(terminal.callbackSuppressedAt).toBeUndefined();
        expect(before.messages).toEqual([]);
        expect(after.messages.filter((m) => m.includes(meta.id))).toHaveLength(1);
    });
    it("marks a same-process task lost only after the grace period when nobody records its exit", async () => {
        const { pi, messages } = host();
        const id = `bg_reload_handoff_lost_${Date.now()}`;
        ids.push(id);
        const meta = {
            id, kind: "process", status: "running", startedAt: Date.now(), logPath: `${taskDir(id)}/output.log`,
            cwd: origin.cwd, callbackOrigin: origin, callback: true, pid: 4_194_304,
            spawnPid: process.pid, spawnPidStartTime: currentProcessStartToken(),
        };
        writeMeta(meta);
        resumeRunningTask(pi, meta, () => origin);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(readMeta(id)?.status).toBe("running");
        const lost = await until(() => (readMeta(id)?.status === "failed" ? readMeta(id) : undefined), 10_000);
        expect(lost?.error).toMatch(/no longer alive/);
        await until(() => (messages.some((m) => m.includes(id)) ? true : undefined));
    }, 15_000);
    it("backs its checks off while a same-process task keeps running, and still delivers its exit (#332)", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
        const { pi, messages } = host();
        const id = `bg_reload_handoff_backoff_${Date.now()}`;
        ids.push(id);
        const meta = {
            id, kind: "process", status: "running", startedAt: Date.now(), logPath: `${taskDir(id)}/output.log`,
            cwd: origin.cwd, callbackOrigin: origin, callback: true, pid: process.pid,
            spawnPid: process.pid, spawnPidStartTime: currentProcessStartToken(),
        };
        writeMeta(meta);
        resumeRunningTask(pi, meta, () => origin);
        resetRegistryIoMetrics();
        await vi.advanceTimersByTimeAsync(60_000);
        // The 1 s log-retention check reads the metadata ~60 times a minute. A fixed 250 ms handoff
        // interval added 240 more (300 total); backing off to 4 s adds about 18.
        const reads = getRegistryIoMetrics().metadataFileReads;
        expect(reads).toBeGreaterThan(60);
        expect(reads).toBeLessThan(100);
        // The earlier instance records the exit; the handoff still delivers it within one backed-off check.
        writeMeta({ ...readMeta(id), status: "succeeded", endedAt: Date.now() });
        await vi.advanceTimersByTimeAsync(4_000);
        vi.useRealTimers();
        await until(() => (messages.some((m) => m.includes(id)) ? true : undefined));
    });
    it("#332 a stop from the reloaded instance while the old instance's tmux start is in flight does not orphan the remote session", async () => {
        let releaseStart;
        const start = new Promise((resolve) => { releaseStart = resolve; });
        const runner = new FakeRemoteRunner([
            successfulResult("__PI_BG_TMUX_PATH__=/usr/bin/tmux\n__PI_BG_TMUX_VERSION__=tmux 3.4\n"),
            start,
            successfulResult(""),
        ]);
        const before = host();
        const meta = spawnTask(before.pi, { command: "sleep 300", callback: false, ssh: { host: "reload.example", user: "deploy" } }, process.cwd(), origin, () => origin, { remoteRunner: runner });
        ids.push(meta.id);
        await runner.waitForRunCalls(2);
        // /reload while `tmux new-session` is in flight: the fresh instance resumes the task and stops it.
        suspendScheduledWork();
        vi.resetModules();
        const fresh = await import("./runtime.domain.mjs");
        const after = host();
        fresh.resumeScheduledWork();
        const freshRunner = new FakeRemoteRunner([]);
        fresh.resumeRunningTask(after.pi, readMeta(meta.id), () => origin, { remoteRunner: freshRunner });
        const stopped = await fresh.stopTask(after.pi, meta.id, () => origin);
        expect(stopped?.status).toBe("cancelled");
        // The old instance's start then succeeds; it is the only one that can still reach that session.
        releaseStart(successfulResult(""));
        await runner.waitForRunCalls(3);
        expect(runner.runCalls.map((call) => call.command)).toEqual([
            expect.stringContaining("command -v tmux"),
            expect.stringContaining(`new-session -d -s 'pi-bg-${meta.id}'`),
            `tmux kill-session -t 'pi-bg-${meta.id}'`,
        ]);
        expect(freshRunner.runCalls).toEqual([]);
        expect(readMeta(meta.id)?.status).toBe("cancelled");
    });
});
