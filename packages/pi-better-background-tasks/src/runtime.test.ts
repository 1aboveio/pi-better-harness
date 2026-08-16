import { readFileSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCallbackBatcher } from "./shared-callback-batcher.js";
import { readMeta, taskDir, writeMeta } from "./registry.js";
import { DEFAULT_WATCH_TIMEOUT_SECONDS, resumeRunningTask, spawnTask, startWatchTask, stopTask } from "./runtime.js";
import { FakeRemoteRunner, successfulResult } from "./test-support/fake-remote-runner.js";

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

  // @covers background-task.ssh-watch
  // @level integration
  it("polls structured SSH intent through the remote preset runner", async () => {
    const runner = new FakeRemoteRunner();
    const meta = startWatchTask(fakePi, {
      name: "remote watcher",
      command: "printf 'done\\n'",
      interval_seconds: 60,
      timeout_seconds: 5,
      callback: false,
      ssh: { host: "watch.example" },
      remote: { session: "direct", install_tmux: false },
      success_when: { type: "stdout_contains", value: "done" },
    }, process.cwd(), undefined, undefined, { remoteRunner: runner });

    const terminal = await waitForMeta(meta.id, (current) => current?.status === "succeeded");
    expect(runner.runCalls).toEqual([expect.objectContaining({
      command: "printf 'done\\n'",
      argv: [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-T",
        "--",
        "watch.example",
        "printf 'done\\n'",
      ],
      shell: false,
    })]);
    expect(terminal).toMatchObject({
      shell: false,
      ssh: { host: "watch.example", target: "watch.example" },
      remote: { command: "printf 'done\\n'", session: "direct", installTmux: false },
      lastExitCode: 0,
      result: { reason: "success condition matched" },
    });
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

  // @covers background-task.ssh-spawn
  // @level integration
  it("defaults SSH spawn to a durable tmux session and captures remote output", async () => {
    const output = "remote spawn\n";
    const runner = new FakeRemoteRunner([
      successfulResult("/usr/bin/tmux\ntmux 3.4\n"),
      successfulResult(""),
      successfulResult(`__PI_BG_STATUS__=0\n__PI_BG_SIZE__=${Buffer.byteLength(output)}\n${output}`),
    ]);
    const meta = spawnTask(fakePi, {
      name: "remote process",
      command: "printf 'remote spawn'",
      argv: ["sh", "-c", "printf 'unsafe local wrapper'"],
      shell: true,
      callback: false,
      ssh: { host: "remote.example", user: "builder" },
      remote: { workdir: "/srv/build" },
    }, process.cwd(), undefined, undefined, { remoteRunner: runner });

    expect(runner.spawnCalls).toHaveLength(0);
    expect(meta).toMatchObject({
      command: "printf 'remote spawn'",
      shell: false,
      ssh: { host: "remote.example", user: "builder", target: "builder@remote.example" },
      remote: {
        command: "printf 'remote spawn'",
        session: "tmux",
        installTmux: true,
        sessionName: `pi-bg-${meta.id}`,
        workdir: "/srv/build",
      },
    });

    const terminal = await waitForMeta(meta.id, (current) => current?.status === "succeeded");
    expect(runner.runCalls).toHaveLength(3);
    expect(runner.runCalls[0]?.command).toContain("command -v tmux");
    expect(runner.runCalls[1]?.command).toContain(`new-session -d -s 'pi-bg-${meta.id}'`);
    expect(runner.runCalls[1]?.command).toContain("cd --");
    expect(runner.runCalls[1]?.command).toContain("/srv/build");
    expect(runner.runCalls[1]?.command).toContain("printf");
    expect(runner.runCalls[1]?.command).toContain("remote spawn");
    expect(runner.runCalls[2]?.command).toContain("tail -c +1");
    expect(readFileSync(meta.logPath, "utf8")).toContain(output.trim());
    expect(terminal).toMatchObject({
      status: "succeeded",
      lastExitCode: 0,
      remote: {
        session: "tmux",
        sessionName: `pi-bg-${meta.id}`,
        logOffset: Buffer.byteLength(output),
        bootstrapStatus: "present",
      },
    });
  });

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
      sendMessage: (message: { content: string }, options: unknown) => { messages.push({ message: message.content, options }); },
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
    expect(messages[0]?.message).toContain("Full results and logs are intentionally omitted");
    expect(messages[0]?.message).not.toContain(sentinel);
    expect(messages[0]?.options).toMatchObject({ deliverAs: "followUp" });
  }, 30_000);

  // @covers background-task.terminal-callback
  // @level integration
  // @fails-without-fix background-task.terminal-callback
  it("batches terminal metadata replay, excludes callback:false and raw payloads, then marks successful handoff", async () => {
    const messages: string[] = [];
    const pi = {
      sendMessage: (message: { content: string }) => { messages.push(message.content); },
    } as unknown as ExtensionAPI;
    const origin = { cwd: process.cwd(), sessionId: "batch-session" };
    const ids = [`bg_batch_a_${Date.now()}`, `bg_batch_b_${Date.now()}`, `bg_batch_quiet_${Date.now()}`];
    const metas = [
      terminalMeta(ids[0]!, origin, { name: "build", status: "succeeded", result: { raw: "RESULT_SENTINEL_A" } }),
      terminalMeta(ids[1]!, origin, { name: "test", status: "failed", result: { raw: "RAW_LOG_SENTINEL_B" } }),
      terminalMeta(ids[2]!, origin, { name: "quiet", status: "succeeded", callback: false }),
    ];

    try {
      for (const meta of metas) writeMeta(meta);
      for (const meta of metas) resumeRunningTask(pi, meta, () => origin);
      expect(await getCallbackBatcher(pi).flush()).toBe(true);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("2 background completions are ready");
      expect(messages[0]).toContain(ids[0]);
      expect(messages[0]).toContain(ids[1]);
      expect(messages[0]).not.toContain(ids[2]);
      expect(messages[0]).toContain("bg_task_status");
      expect(messages[0]).not.toMatch(/RESULT_SENTINEL_A|RAW_LOG_SENTINEL_B/);
      expect(readMeta(ids[0]!)?.callbackSentAt).toBeTypeOf("number");
      expect(readMeta(ids[1]!)?.callbackSentAt).toBeTypeOf("number");
      expect(readMeta(ids[2]!)?.callbackSentAt).toBeUndefined();
    } finally {
      for (const id of ids) rmSync(taskDir(id), { recursive: true, force: true });
    }
  });

  // @covers background-task.terminal-callback
  // @level integration
  // @fails-without-fix background-task.terminal-callback
  it("keeps a failed batch retryable, writes no early markers, and suppresses a foreign session", async () => {
    let failNext = true;
    const messages: string[] = [];
    const pi = {
      sendMessage: (message: { content: string }) => {
        if (failNext) {
          failNext = false;
          throw new Error("simulated batch handoff failure");
        }
        messages.push(message.content);
      },
    } as unknown as ExtensionAPI;
    const active = { cwd: process.cwd(), sessionId: "session-b" };
    const foreign = { cwd: process.cwd(), sessionId: "session-a" };
    const ids = [`bg_retry_a_${Date.now()}`, `bg_retry_b_${Date.now()}`, `bg_foreign_${Date.now()}`];
    const metas = [
      terminalMeta(ids[0]!, active, { name: "retry-a" }),
      terminalMeta(ids[1]!, active, { name: "retry-b" }),
      terminalMeta(ids[2]!, foreign, { name: "foreign" }),
    ];

    try {
      for (const meta of metas) writeMeta(meta);
      for (const meta of metas) resumeRunningTask(pi, meta, () => active);
      const batcher = getCallbackBatcher(pi);

      expect(await batcher.flush()).toBe(false);
      expect(readMeta(ids[0]!)?.callbackSentAt).toBeUndefined();
      expect(readMeta(ids[1]!)?.callbackSentAt).toBeUndefined();
      expect(readMeta(ids[2]!)?.callbackSentAt).toBeUndefined();
      expect(readMeta(ids[2]!)?.callbackSuppressedAt).toBeTypeOf("number");

      expect(await batcher.flush()).toBe(true);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(ids[0]);
      expect(messages[0]).toContain(ids[1]);
      expect(messages[0]).not.toContain(ids[2]);
      expect(readMeta(ids[0]!)?.callbackSentAt).toBeTypeOf("number");
      expect(readMeta(ids[1]!)?.callbackSentAt).toBeTypeOf("number");
    } finally {
      for (const id of ids) rmSync(taskDir(id), { recursive: true, force: true });
    }
  });

  it("cancels a spawned process", async () => {
    const meta = spawnTask(fakePi, {
      name: "test cancellable process",
      command: "node -e 'setTimeout(() => {}, 10000)'",
      callback: false,
    }, process.cwd());

    const stopped = await stopTask(fakePi, meta.id);

    expect(stopped?.status).toBe("cancelled");
    expect(readMeta(meta.id)?.result).toMatchObject({ reason: "cancelled" });
  });

  it("queues no terminal callback for a cancelled task", async () => {
    const messages: Array<{ message: string; options: unknown }> = [];
    const pi = {
      sendMessage: (message: { content: string }, options: unknown) => { messages.push({ message: message.content, options }); },
    } as unknown as ExtensionAPI;
    const meta = spawnTask(pi, {
      name: "cancelled callback task",
      command: "node -e 'setTimeout(() => {}, 10000)'",
      callback: true,
    }, process.cwd());

    const stopped = await stopTask(pi, meta.id);
    expect(stopped?.status).toBe("cancelled");

    // If a callback had been enqueued it would flush within the 100 ms batch window.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(messages).toHaveLength(0);

    const terminal = readMeta(meta.id);
    expect(terminal?.callbackSentAt).toBeUndefined();
    expect(terminal?.callbackSuppressedAt).toBeTypeOf("number");
    expect(terminal?.callbackSuppressedReason).toContain("cancelled");
  });
});

function terminalMeta(
  id: string,
  callbackOrigin: { cwd: string; sessionId?: string },
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    name: "terminal fixture",
    kind: "process" as const,
    status: "succeeded" as const,
    startedAt: Date.now() - 1_000,
    endedAt: Date.now(),
    lastProgressAt: Date.now(),
    logPath: `${taskDir(id)}/output.log`,
    callback: true,
    callbackOrigin,
    cwd: callbackOrigin.cwd,
    spawnPid: process.pid,
    result: { reason: "fixture" },
    ...overrides,
  };
}

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