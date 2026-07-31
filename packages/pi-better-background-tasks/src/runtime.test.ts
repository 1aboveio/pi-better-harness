import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readMeta } from "./registry.js";
import { DEFAULT_WATCH_TIMEOUT_SECONDS, spawnTask, startWatchTask, stopTask } from "./runtime.js";

const fakePi = {
  sendUserMessage: async () => undefined,
} as unknown as ExtensionAPI;

describe("runtime", () => {
  it("defaults command watchers to a 15 minute timeout", () => {
    const before = Date.now();
    const meta = startWatchTask(fakePi, {
      name: "default timeout watcher",
      command: "node -e 'console.log(JSON.stringify({status:\"pending\"}))'",
      interval_seconds: 60,
      callback: false,
      success_when: { type: "json_path_equals", path: "$.status", value: "done" },
    }, process.cwd());
    const after = Date.now();

    expect(meta.deadlineAt).toBeGreaterThanOrEqual(before + DEFAULT_WATCH_TIMEOUT_SECONDS * 1000);
    expect(meta.deadlineAt).toBeLessThanOrEqual(after + DEFAULT_WATCH_TIMEOUT_SECONDS * 1000);
  });

  it("keeps explicit watcher timeouts and lets zero disable the default", () => {
    const explicit = startWatchTask(fakePi, {
      name: "explicit timeout watcher",
      command: "node -e 'console.log(JSON.stringify({status:\"pending\"}))'",
      interval_seconds: 60,
      timeout_seconds: 42,
      callback: false,
      success_when: { type: "json_path_equals", path: "$.status", value: "done" },
    }, process.cwd());
    const disabled = startWatchTask(fakePi, {
      name: "disabled timeout watcher",
      command: "node -e 'console.log(JSON.stringify({status:\"pending\"}))'",
      interval_seconds: 60,
      timeout_seconds: 0,
      callback: false,
      success_when: { type: "json_path_equals", path: "$.status", value: "done" },
    }, process.cwd());

    expect(explicit.deadlineAt).toBeDefined();
    expect(Math.round(((explicit.deadlineAt ?? 0) - explicit.startedAt) / 1000)).toBe(42);
    expect(disabled.deadlineAt).toBeUndefined();
  });

  it("runs a command watcher to success", async () => {
    const meta = startWatchTask(fakePi, {
      name: "test watcher",
      command: "node -e 'console.log(JSON.stringify({status:\"done\"}))'",
      interval_seconds: 1,
      timeout_seconds: 5,
      callback: false,
      success_when: { type: "json_path_equals", path: "$.status", value: "done" },
    }, process.cwd());

    const terminal = await waitForMeta(meta.id, (m) => m?.status === "succeeded");
    expect(terminal?.result).toMatchObject({ reason: "success condition matched", exitCode: 0 });
  });

  it("finalizes a command watcher when failure_when matches", async () => {
    const meta = startWatchTask(fakePi, {
      name: "test failing watcher",
      command: "node -e 'console.log(JSON.stringify({status:\"failed\"}))'",
      interval_seconds: 1,
      timeout_seconds: 5,
      callback: false,
      success_when: { type: "json_path_equals", path: "$.status", value: "done" },
      failure_when: { type: "json_path_equals", path: "$.status", value: "failed" },
    }, process.cwd());

    const terminal = await waitForMeta(meta.id, (m) => m?.status === "failed");
    expect(terminal?.result).toMatchObject({ reason: "failure condition matched", exitCode: 0 });
  });

  it("times out a command watcher", async () => {
    const meta = startWatchTask(fakePi, {
      name: "test timeout watcher",
      command: "node -e 'console.log(JSON.stringify({status:\"pending\"}))'",
      interval_seconds: 1,
      timeout_seconds: 0.1,
      callback: false,
      success_when: { type: "json_path_equals", path: "$.status", value: "done" },
    }, process.cwd());

    const terminal = await waitForMeta(meta.id, (m) => m?.status === "timed_out", 2500);
    expect(terminal?.result).toMatchObject({ reason: "timeout" });
  });

  it("finalizes a short spawned process", async () => {
    const meta = spawnTask(fakePi, {
      name: "test process",
      shell: false,
      argv: [process.execPath, "-e", "process.exit(0)"],
      callback: false,
    }, process.cwd());

    const terminal = await waitForMeta(meta.id, (m) => m?.status === "succeeded", 30_000);
    expect(terminal?.lastExitCode).toBe(0);
  }, 30_000);

  it("retains bounded output from a noisy spawned process", async () => {
    const meta = spawnTask(fakePi, {
      name: "bounded process log",
      shell: false,
      argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(200000))"],
      max_log_bytes: 64 * 1024,
      callback: false,
    }, process.cwd());

    const terminal = await waitForMeta(meta.id, (m) => m?.status === "succeeded" && Boolean(m.logDiscardedBytes), 30_000);

    expect(terminal?.maxLogBytes).toBe(64 * 1024);
    expect(terminal?.logDiscardedBytes).toBeGreaterThan(0);
    expect(terminal?.logRetentionEvents).toBe(1);
  }, 30_000);

  it("callback completion does not embed process output", async () => {
    const messages: Array<{ message: string; options: unknown }> = [];
    const pi = {
      sendUserMessage: async (message: string, options: unknown) => { messages.push({ message, options }); },
    } as unknown as ExtensionAPI;
    const origin = { cwd: process.cwd(), sessionId: "session-a" };
    const sentinel = "UNIQUE_BACKGROUND_LOG_PAYLOAD_SHOULD_NOT_DISPLAY";
    const meta = spawnTask(pi, {
      name: "callback process",
      shell: false,
      argv: [process.execPath, "-e", `console.log(${JSON.stringify(sentinel)})`],
      callback: true,
    }, process.cwd(), origin, () => origin);

    const terminal = await waitForMeta(meta.id, (m) => m?.status === "succeeded" && Boolean(m.callbackSentAt), 30_000);

    expect(terminal?.status).toBe("succeeded");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toContain("bg_task_status");
    expect(messages[0]?.message).toContain("only if the status summary is insufficient");
    expect(messages[0]?.message).not.toContain(sentinel);
    expect(messages[0]?.options).toMatchObject({ deliverAs: "followUp" });
  }, 30_000);

  it("cancels a spawned process", async () => {
    const meta = spawnTask(fakePi, {
      name: "test cancellable process",
      command: "node -e 'setTimeout(() => {}, 10000)'",
      callback: false,
    }, process.cwd());

    const stopped = stopTask(fakePi, meta.id);

    expect(stopped?.status).toBe("cancelled");
    expect(readMeta(meta.id)?.result).toMatchObject({ reason: "cancelled" });
  });
});

async function waitForMeta(
  id: string,
  done: (meta: ReturnType<typeof readMeta>) => boolean,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const meta = readMeta(id);
    if (done(meta)) return meta;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return readMeta(id);
}