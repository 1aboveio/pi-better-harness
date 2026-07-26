import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readMeta } from "./registry.js";
import { spawnTask, startWatchTask, stopTask } from "./runtime.js";

const fakePi = {
  sendUserMessage: async () => undefined,
} as unknown as ExtensionAPI;

describe("runtime", () => {
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