// Same-process handoff after session shutdown (#324). A reloaded or switched-away
// extension instance may still own a task's child; the resuming instance must
// deliver what it records, and must still mark a truly lost process as lost.
import { rmSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentProcessStartToken } from "./process-identity.js";
import { readMeta, taskDir, writeMeta } from "./registry.js";
import { resumeRunningTask, resumeScheduledWork, spawnTask, suspendScheduledWork } from "./runtime.js";
import type { BackgroundTaskMeta } from "./types.js";

const origin = { cwd: process.cwd(), sessionId: "reload-handoff" };
const ids: string[] = [];
afterEach(() => {
  resumeScheduledWork();
  for (const id of ids.splice(0)) rmSync(taskDir(id), { recursive: true, force: true });
});

function host() {
  const messages: string[] = [];
  const pi = { sendMessage: (message: { content: string }) => { messages.push(message.content); } } as unknown as ExtensionAPI;
  return { pi, messages };
}

async function until<T>(fn: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
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
    const fresh = await import("./runtime.js");
    const freshBatcher = await import("./shared-callback-batcher.js");
    const after = host();
    fresh.resumeScheduledWork();
    fresh.resumeRunningTask(after.pi, readMeta(meta.id)!, () => origin);
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
    const meta: BackgroundTaskMeta = {
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
});
