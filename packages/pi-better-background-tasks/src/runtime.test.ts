import { readFileSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCallbackBatcher } from "./shared-callback-batcher.js";
import { readMeta, taskDir, writeMeta } from "./registry.js";
import { DEFAULT_WATCH_TIMEOUT_SECONDS, resumeRunningTask, spawnTask, startWatchTask, stopTask } from "./runtime.js";
import { formatLaunch } from "./tools.js";
import { failedResult, FakeRemoteRunner, successfulResult } from "./test-support/fake-remote-runner.js";

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

  // @characterizes background-task.local-watch
  // @covers background-task.local-watch
  // @level integration
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

  // @covers background-task.ssh-watch
  // @level integration
  it.each([
    ["exit code", { type: "exit_code", equals: 7 } as const, remoteResult({ exitCode: 7 })],
    ["stdout contains", { type: "stdout_contains", value: "ready" } as const, remoteResult({ stdout: "remote ready\n" })],
    ["stderr contains", { type: "stderr_contains", value: "degraded" } as const, remoteResult({ exitCode: 1, stderr: "remote degraded\n" })],
    ["JSON path equals", { type: "json_path_equals", path: "$.deployment.state", value: "ready" } as const, remoteResult({ stdout: '{"deployment":{"state":"ready"}}\n' })],
    ["JSON path exists", { type: "json_path_exists", path: "$.deployment.id" } as const, remoteResult({ stdout: '{"deployment":{"id":"dep-187"}}\n' })],
  ])("evaluates remote poll %s conditions", async (_label, condition, result) => {
    const runner = new FakeRemoteRunner([result]);
    const meta = startWatchTask(fakePi, {
      name: "remote condition watcher",
      command: "check deployment",
      interval_seconds: 60,
      timeout_seconds: 5,
      callback: false,
      ssh: { host: "conditions.example" },
      success_when: condition,
    }, process.cwd(), undefined, undefined, { remoteRunner: runner });

    const terminal = await waitForMeta(meta.id, (current) => current?.status === "succeeded");
    expect(terminal).toMatchObject({
      status: "succeeded",
      lastExitCode: result.exitCode,
      result: { reason: "success condition matched", matchedCondition: condition },
    });
    expect(runner.runCalls).toHaveLength(1);
  });

  // @covers background-task.ssh-watch
  // @level integration
  it("retains scripted remote poll evidence and gives failure conditions precedence", async () => {
    const runner = new FakeRemoteRunner([
      remoteResult({ stdout: "deployment pending\n" }),
      remoteResult({ stdout: "deployment ready\n", stderr: "remote fatal\n" }),
    ]);
    const meta = startWatchTask(fakePi, {
      name: "remote interval watcher",
      command: "check deployment",
      interval_seconds: 1,
      timeout_seconds: 5,
      callback: false,
      ssh: { host: "intervals.example" },
      success_when: { type: "stdout_contains", value: "ready" },
      failure_when: { type: "stderr_contains", value: "fatal" },
    }, process.cwd(), undefined, undefined, { remoteRunner: runner });

    const terminal = await waitForMeta(meta.id, (current) => current?.status === "failed");
    const log = readFileSync(meta.logPath, "utf8");

    expect(terminal?.result).toMatchObject({
      reason: "failure condition matched",
      matchedCondition: { type: "stderr_contains", value: "fatal" },
    });
    expect(runner.runCalls).toHaveLength(2);
    expect(log.match(/--- check /g)).toHaveLength(2);
    expect(log).toContain("deployment pending");
    expect(log).toContain("deployment ready");
    expect(log).toContain("[stderr]\nremote fatal");
  });

  // @covers background-task.ssh-watch
  // @level integration
  // @fails-without-fix background-task.ssh-watch
  it("fails SSH transport exits immediately with readable connection evidence", async () => {
    const runner = new FakeRemoteRunner([
      remoteResult({ exitCode: 255, stderr: "ssh: connect to host unavailable.example port 22: Connection timed out\n" }),
    ]);
    const meta = startWatchTask(fakePi, {
      name: "remote connection watcher",
      command: "check deployment",
      interval_seconds: 60,
      timeout_seconds: 5,
      callback: false,
      ssh: { host: "unavailable.example" },
      success_when: { type: "stdout_contains", value: "ready" },
    }, process.cwd(), undefined, undefined, { remoteRunner: runner });

    const terminal = await waitForMeta(meta.id, (current) => current?.status !== "running");
    const log = readFileSync(meta.logPath, "utf8");

    expect(terminal).toMatchObject({
      status: "failed",
      lastExitCode: 255,
      error: "SSH poll to unavailable.example failed with exit 255: ssh: connect to host unavailable.example port 22: Connection timed out",
      result: { reason: "SSH poll to unavailable.example failed with exit 255: ssh: connect to host unavailable.example port 22: Connection timed out" },
    });
    expect(log).toContain("exit=255");
    expect(log).toContain("Connection timed out");
  });

  // @covers background-task.ssh-watch
  // @level integration
  // @fails-without-fix background-task.ssh-watch
  it("persists remote poll runner errors before failing the watch", async () => {
    const runner = new FakeRemoteRunner([new Error("spawn ssh ENOENT")]);
    const meta = startWatchTask(fakePi, {
      name: "remote runner error watcher",
      command: "check deployment",
      interval_seconds: 60,
      timeout_seconds: 5,
      callback: false,
      ssh: { host: "runner-error.example" },
      success_when: { type: "stdout_contains", value: "ready" },
    }, process.cwd(), undefined, undefined, { remoteRunner: runner });

    const terminal = await waitForMeta(meta.id, (current) => current?.status === "failed");
    const log = readFileSync(meta.logPath, "utf8");

    expect(terminal).toMatchObject({
      status: "failed",
      error: "SSH poll to runner-error.example failed: spawn ssh ENOENT",
      result: { reason: "SSH poll to runner-error.example failed: spawn ssh ENOENT" },
    });
    expect(log).toContain("--- poll error");
    expect(log).toContain("spawn ssh ENOENT");
  });

  // @characterizes background-task.local-watch
  // @covers background-task.local-watch
  // @level integration
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

  // @characterizes background-task.local-watch
  // @covers background-task.local-watch
  // @level integration
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

  // @covers background-task.ssh-watch
  // @level integration
  it("delivers callbacks for succeeded, failed, and timed-out remote watches", async () => {
    const start = (name: string, runner: FakeRemoteRunner, timeoutSeconds = 5) => {
      const messages: string[] = [];
      const pi = {
        sendMessage: (message: { content: string }) => { messages.push(message.content); },
      } as unknown as ExtensionAPI;
      const origin = { cwd: process.cwd() };
      const meta = startWatchTask(pi, {
        name,
        command: "check deployment",
        interval_seconds: 1,
        timeout_seconds: timeoutSeconds,
        ssh: { host: `${name}.example` },
        success_when: { type: "stdout_contains", value: "ready" },
      }, process.cwd(), origin, () => origin, { remoteRunner: runner });
      return { messages, pi, origin, meta };
    };

    const watches = [
      start("remote-success", new FakeRemoteRunner([remoteResult({ stdout: "ready\n" })])),
      start("remote-failure", new FakeRemoteRunner([remoteResult({ exitCode: 255, stderr: "Permission denied (publickey).\n" })])),
      start("remote-timeout", new FakeRemoteRunner([remoteResult({ stdout: "pending\n" })]), 0.1),
    ];
    const terminal = await Promise.all([
      waitForMeta(watches[0]!.meta.id, (meta) => meta?.status === "succeeded" && Boolean(meta.callbackSentAt), 8_000),
      waitForMeta(watches[1]!.meta.id, (meta) => meta?.status === "failed" && Boolean(meta.callbackSentAt), 8_000),
      waitForMeta(watches[2]!.meta.id, (meta) => meta?.status === "timed_out" && Boolean(meta.callbackSentAt), 8_000),
    ]);

    expect(terminal.map((meta) => meta?.status)).toEqual(["succeeded", "failed", "timed_out"]);
    for (const watch of watches) {
      const batcher = getCallbackBatcher(watch.pi);
      const deliveredAt = readMeta(watch.meta.id)?.callbackSentAt;
      expect(deliveredAt).toBeTypeOf("number");

      const deliveryCount = watch.messages.length;
      resumeRunningTask(watch.pi, readMeta(watch.meta.id)!, () => watch.origin);
      await batcher.flush();
      expect(readMeta(watch.meta.id)?.callbackSentAt).toBe(deliveredAt);
      expect(watch.messages).toHaveLength(deliveryCount);
    }
  }, 10_000);

  // @covers background-task.ssh-watch
  // @level integration
  it("keeps remote watch cancellation callback-silent after a completed poll", async () => {
    const messages: string[] = [];
    const pi = {
      sendMessage: (message: { content: string }) => { messages.push(message.content); },
    } as unknown as ExtensionAPI;
    const origin = { cwd: process.cwd(), sessionId: `ssh-watch-cancel-${Date.now()}` };
    const runner = new FakeRemoteRunner([remoteResult({ stdout: "pending\n" })]);
    const meta = startWatchTask(pi, {
      name: "remote cancelled watcher",
      command: "check deployment",
      interval_seconds: 1,
      timeout_seconds: 5,
      ssh: { host: "cancel.example" },
      success_when: { type: "stdout_contains", value: "ready" },
    }, process.cwd(), origin, () => origin, { remoteRunner: runner });

    await waitForMeta(meta.id, (current) => Boolean(current?.lastCheckedAt));
    const stopped = await stopTask(pi, meta.id, () => origin);
    const cancelled = await waitForMeta(meta.id, (current) => Boolean(current?.callbackSuppressedAt));

    expect(runner.runCalls).toHaveLength(1);
    expect(stopped).toMatchObject({ status: "cancelled" });
    expect(cancelled?.callbackSuppressedReason).toContain("cancelled");
    expect(messages).toHaveLength(0);
  });

  // @covers background-task.ssh-resume
  // @level integration
  // @fails-without-fix background-task.ssh-resume
  it("resumes a persisted tmux session without bootstrapping or creating it again", async () => {
    const id = `bg_tmux_resume_${Date.now()}`;
    const sessionName = `pi-bg-${id}`;
    const runner = new FakeRemoteRunner([
      successfulResult("__PI_BG_STATUS__=running\n__PI_BG_SIZE__=9\nmore\n"),
      successfulResult("__PI_BG_STATUS__=0\n__PI_BG_SIZE__=9\n"),
    ]);
    writeMeta({
      id,
      name: "resumed remote build",
      kind: "process",
      status: "running",
      startedAt: Date.now() - 1_000,
      lastProgressAt: Date.now() - 1_000,
      logPath: `${taskDir(id)}/output.log`,
      callback: false,
      command: "build release",
      argv: ["ssh", "-o", "BatchMode=yes", "-T", "--", "builder@resume.example", "build release"],
      shell: false,
      cwd: process.cwd(),
      spawnPid: 999_999,
      ssh: { host: "resume.example", user: "builder", target: "builder@resume.example" },
      remote: {
        command: "build release",
        session: "tmux",
        installTmux: true,
        sessionName,
        bootstrapStatus: "present",
        sessionStarted: true,
        logOffset: 4,
      },
    });

    try {
      resumeWithRemoteRunner(readMeta(id)!, runner);
      const terminal = await waitForMeta(id, (current) => current?.status === "succeeded", 1_000);

      expect(terminal).toMatchObject({ status: "succeeded", lastExitCode: 0 });
      expect(runner.runCalls).toHaveLength(2);
      expect(runner.runCalls[0]?.command).toContain("tail -c +5");
      expect(runner.runCalls.every((call) => call.argv?.includes("builder@resume.example"))).toBe(true);
      expect(runner.runCalls.some((call) => call.command?.includes("command -v tmux") || call.command?.includes("new-session"))).toBe(false);
      expect(readFileSync(`${taskDir(id)}/output.log`, "utf8")).toContain("more");
    } finally {
      rmSync(taskDir(id), { recursive: true, force: true });
    }
  });

  // @covers background-task.ssh-resume
  // @level integration
  // @fails-without-fix background-task.ssh-resume
  it("resumes a persisted direct SSH watch with its target and conditions", async () => {
    const id = `bg_watch_resume_${Date.now()}`;
    const runner = new FakeRemoteRunner([successfulResult("release ready\n")]);
    const successWhen = { type: "stdout_contains", value: "ready" } as const;
    writeMeta({
      id,
      name: "resumed remote watch",
      kind: "command_watch",
      status: "running",
      startedAt: Date.now() - 1_000,
      lastProgressAt: Date.now() - 1_000,
      deadlineAt: Date.now() + 5_000,
      intervalMs: 60_000,
      logPath: `${taskDir(id)}/output.log`,
      callback: false,
      command: "check release",
      argv: [process.execPath, "-e", "console.log('release ready')"],
      shell: false,
      cwd: process.cwd(),
      spawnPid: 999_999,
      successWhen,
      notifyOn: "terminal",
      ssh: { host: "watch-resume.example", user: "deploy", target: "deploy@watch-resume.example" },
      remote: { command: "check release", session: "direct", installTmux: false },
    });

    try {
      resumeWithRemoteRunner(readMeta(id)!, runner);
      const terminal = await waitForMeta(id, (current) => current?.status === "succeeded", 1_000);

      expect(terminal).toMatchObject({
        status: "succeeded",
        ssh: { target: "deploy@watch-resume.example" },
        result: { reason: "success condition matched", matchedCondition: successWhen },
      });
      expect(runner.runCalls).toEqual([expect.objectContaining({
        command: "check release",
        argv: expect.arrayContaining(["deploy@watch-resume.example", "check release"]),
        shell: false,
      })]);
    } finally {
      rmSync(taskDir(id), { recursive: true, force: true });
    }
  });

  // @covers background-task.ssh-timeout
  // @level integration
  // @fails-without-fix background-task.ssh-timeout
  it("kills a tmux-backed SSH spawn when its deadline expires", async () => {
    const runner = new FakeRemoteRunner([
      successfulResult("/usr/bin/tmux\ntmux 3.4\n"),
      successfulResult(""),
      successfulResult("__PI_BG_STATUS__=running\n__PI_BG_SIZE__=0\n"),
      successfulResult(""),
    ]);
    const meta = spawnTask(fakePi, {
      name: "remote timeout",
      command: "sleep 300",
      timeout_seconds: 0.05,
      callback: false,
      ssh: { host: "timeout.example", user: "deploy" },
    }, process.cwd(), undefined, undefined, { remoteRunner: runner });

    const terminal = await waitForMeta(meta.id, (current) => current?.status === "timed_out", 1_000);
    const sessionName = `pi-bg-${meta.id}`;

    expect(runner.runCalls.at(-1)?.command).toBe(`tmux kill-session -t '${sessionName}'`);
    expect(terminal).toMatchObject({
      status: "timed_out",
      remote: { stopMessage: `Killed remote tmux session ${sessionName} on deploy@timeout.example after timeout.` },
      result: { reason: `timeout; killed remote tmux session ${sessionName} on deploy@timeout.example` },
    });
  });

  // @covers background-task.ssh-timeout
  // @level integration
  // @fails-without-fix background-task.ssh-timeout
  it("times out and kills a tmux-backed SSH spawn when its bounded supervision poll times out", async () => {
    const runner = new FakeRemoteRunner([
      successfulResult("/usr/bin/tmux\ntmux 3.4\n"),
      successfulResult(""),
      { ...successfulResult(""), timedOut: true },
      successfulResult(""),
    ]);
    const meta = spawnTask(fakePi, {
      name: "remote poll timeout",
      command: "sleep 300",
      timeout_seconds: 1,
      callback: false,
      ssh: { host: "poll-timeout.example", user: "deploy" },
    }, process.cwd(), undefined, undefined, { remoteRunner: runner });

    const terminal = await waitForMeta(meta.id, (current) => current?.status !== "running", 1_000);
    const sessionName = `pi-bg-${meta.id}`;

    expect(runner.runTimeouts[2]).toBeGreaterThan(0);
    expect(runner.runCalls.at(-1)?.command).toBe(`tmux kill-session -t '${sessionName}'`);
    expect(terminal).toMatchObject({
      status: "timed_out",
      remote: { stopMessage: `Killed remote tmux session ${sessionName} on deploy@poll-timeout.example after timeout.` },
      result: { reason: `timeout; killed remote tmux session ${sessionName} on deploy@poll-timeout.example` },
    });
  });

  // @covers background-task.ssh-spawn
  // @level integration
  it("fails malformed tmux supervision protocol before the task deadline", async () => {
    const runner = new FakeRemoteRunner([
      successfulResult("/usr/bin/tmux\ntmux 3.4\n"),
      successfulResult(""),
      successfulResult("not tmux protocol\n"),
    ]);
    const meta = spawnTask(fakePi, {
      name: "malformed remote poll",
      command: "sleep 300",
      timeout_seconds: 5,
      callback: false,
      ssh: { host: "malformed-poll.example", user: "deploy" },
    }, process.cwd(), undefined, undefined, { remoteRunner: runner });

    const terminal = await waitForMeta(meta.id, (current) => current?.status !== "running", 1_000);

    expect(terminal).toMatchObject({
      status: "failed",
      error: "remote tmux supervision returned an invalid response",
      result: { reason: "remote tmux supervision returned an invalid response" },
    });
    expect(runner.runCalls.some((call) => call.command?.startsWith("tmux kill-session"))).toBe(false);
  });

  // @covers background-task.ssh-timeout
  // @level integration
  // @fails-without-fix background-task.ssh-timeout
  it("times out a direct SSH watch at its deadline and preserves the default timeout", async () => {
    const runner = new FakeRemoteRunner([successfulResult("pending\n")]);
    const explicit = startWatchTask(fakePi, {
      name: "remote watch timeout",
      command: "check release",
      interval_seconds: 60,
      timeout_seconds: 0.05,
      callback: false,
      ssh: { host: "watch-timeout.example" },
      success_when: { type: "stdout_contains", value: "ready" },
    }, process.cwd(), undefined, undefined, { remoteRunner: runner });
    const defaulted = startWatchTask(fakePi, {
      name: "remote default watch timeout",
      command: "check release",
      interval_seconds: 60,
      callback: false,
      ssh: { host: "watch-default.example" },
      success_when: { type: "stdout_contains", value: "ready" },
    }, process.cwd(), undefined, undefined, { remoteRunner: new FakeRemoteRunner([successfulResult("ready\n")]) });

    const terminal = await waitForMeta(explicit.id, (current) => current?.status === "timed_out", 1_000);

    expect(terminal).toMatchObject({
      status: "timed_out",
      result: { reason: "timeout waiting for SSH watch condition on watch-timeout.example" },
    });
    expect(Math.round(((defaulted.deadlineAt ?? 0) - defaulted.startedAt) / 1000)).toBe(DEFAULT_WATCH_TIMEOUT_SECONDS);
  });

  // @covers background-task.ssh-timeout
  // @level integration
  // @fails-without-fix background-task.ssh-timeout
  it("reports weak remote-stop semantics when a direct SSH spawn times out", async () => {
    const runner = new FakeRemoteRunner();
    const meta = spawnTask(fakePi, {
      name: "direct remote timeout",
      command: "sleep 300",
      timeout_seconds: 0.05,
      callback: false,
      ssh: { host: "direct-timeout.example" },
      remote: { session: "direct" },
    }, process.cwd(), undefined, undefined, { remoteRunner: runner });

    const terminal = await waitForMeta(meta.id, (current) => current?.status === "timed_out", 1_000);

    expect(terminal).toMatchObject({
      status: "timed_out",
      result: { reason: "timeout; terminated local SSH client, but the remote process may still be running" },
    });
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
    expect(formatLaunch(meta)).toContain(`Remote: builder@remote.example mode=tmux session=pi-bg-${meta.id}.`);
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
    expect(runner.runCalls[2]?.command).toContain("head -c");
    expect(readFileSync(meta.logPath, "utf8")).toContain(output.trim());
    expect(terminal).toMatchObject({
      status: "succeeded",
      lastExitCode: 0,
      remote: {
        session: "tmux",
        sessionName: `pi-bg-${meta.id}`,
        logOffset: Buffer.byteLength(output),
        bootstrapStatus: "present",
        sessionStarted: true,
      },
    });
  });

  // @covers background-task.ssh-spawn
  // @level integration
  it("runs explicit direct mode without bootstrap and warns that stop is local-only", async () => {
    const runner = new FakeRemoteRunner();
    const meta = spawnTask(fakePi, {
      command: "short remote job",
      callback: false,
      ssh: { host: "direct.example" },
      remote: { session: "direct", install_tmux: true },
    }, process.cwd(), undefined, undefined, { remoteRunner: runner });

    expect(runner.runCalls).toHaveLength(0);
    expect(runner.spawnCalls).toHaveLength(1);
    expect(meta.remote).toMatchObject({
      session: "direct",
      installTmux: false,
      warning: "Direct SSH mode has weak stop semantics: stopping the local SSH client may leave the remote process running.",
    });
    expect(meta.remote?.sessionName).toBeUndefined();
    expect(formatLaunch(meta)).toContain("Remote: direct.example mode=direct.");
    expect(formatLaunch(meta)).toContain("Warning: Direct SSH mode has weak stop semantics");

    const stopped = await stopTask(fakePi, meta.id);

    expect(runner.runCalls).toHaveLength(0);
    expect(stopped).toMatchObject({
      status: "cancelled",
      result: { reason: "cancelled local SSH client; the remote process may still be running" },
    });
    expect(stopped?.remote?.stopMessage).toBeUndefined();
  });

  // @covers background-task.ssh-spawn
  // @level integration
  it("persists and discloses a successful automatic tmux installation", async () => {
    const runner = new FakeRemoteRunner([
      failedResult(127, "tmux: not found\n"),
      successfulResult("user=root\nuid=0\npm=apt-get\nprivilege=root\n"),
      successfulResult(""),
      successfulResult("/usr/bin/tmux\ntmux 3.4\n"),
      successfulResult(""),
      successfulResult("__PI_BG_STATUS__=0\n__PI_BG_SIZE__=0\n"),
    ]);
    const meta = spawnTask(fakePi, {
      command: "deploy release",
      callback: false,
      ssh: { host: "fresh.example", user: "root" },
    }, process.cwd(), undefined, undefined, { remoteRunner: runner });

    const terminal = await waitForMeta(meta.id, (current) => current?.status === "succeeded");

    expect(runner.runCalls[2]?.command).toBe("apt-get update && apt-get install -y tmux");
    expect(terminal?.remote).toMatchObject({
      session: "tmux",
      bootstrapStatus: "installed",
      tmuxInstalled: true,
      bootstrapMessage: "Installed tmux with apt-get on root@fresh.example; tmux 3.4 is available at /usr/bin/tmux.",
    });
    expect(readFileSync(meta.logPath, "utf8")).toContain("Installed tmux with apt-get on root@fresh.example");
  });

  // @covers background-task.ssh-spawn
  // @level integration
  it("fails closed with bootstrap guidance instead of downgrading to direct SSH", async () => {
    const runner = new FakeRemoteRunner([
      failedResult(127, "tmux: not found\n"),
      successfulResult("user=deploy\nuid=1000\npm=apt-get\nprivilege=needs_user\n"),
    ]);
    const meta = spawnTask(fakePi, {
      command: "deploy release",
      callback: false,
      ssh: { host: "locked.example", user: "deploy" },
    }, process.cwd(), undefined, undefined, { remoteRunner: runner });

    const terminal = await waitForMeta(meta.id, (current) => current?.status === "failed");

    expect(runner.spawnCalls).toHaveLength(0);
    expect(runner.runCalls).toHaveLength(2);
    expect(terminal).toMatchObject({
      status: "failed",
      remote: {
        session: "tmux",
        bootstrapStatus: "needs_user",
        tmuxInstalled: false,
      },
    });
    expect(terminal?.error).toContain("automatic installation cannot use passwordless sudo");
    expect(terminal?.error).toContain("ssh -t 'deploy@locked.example' 'sudo apt-get update && sudo apt-get install -y tmux'");
    expect(terminal?.error).toContain("ssh 'deploy@locked.example' 'command -v tmux && tmux -V'");
  });

  // @covers background-task.ssh-spawn
  // @level integration
  it("kills the remote tmux session before cancelling without a completion callback", async () => {
    const messages: string[] = [];
    const pi = {
      sendMessage: (message: { content: string }) => { messages.push(message.content); },
    } as unknown as ExtensionAPI;
    const runner = new FakeRemoteRunner([
      successfulResult("/usr/bin/tmux\ntmux 3.4\n"),
      successfulResult(""),
      successfulResult("__PI_BG_STATUS__=running\n__PI_BG_SIZE__=0\n"),
      successfulResult(""),
    ]);
    const meta = spawnTask(pi, {
      command: "sleep 300",
      callback: true,
      ssh: { host: "stop.example", user: "deploy" },
    }, process.cwd(), undefined, undefined, { remoteRunner: runner });

    await waitForMeta(meta.id, (current) => current?.remote?.bootstrapStatus === "present" && current.lastCheckedAt !== undefined);
    const stopped = await stopTask(pi, meta.id);

    expect(runner.runCalls.at(-1)?.command).toBe(`tmux kill-session -t 'pi-bg-${meta.id}'`);
    expect(stopped).toMatchObject({
      status: "cancelled",
      result: { reason: "cancelled" },
      remote: {
        session: "tmux",
        sessionName: `pi-bg-${meta.id}`,
        stopMessage: `Killed remote tmux session pi-bg-${meta.id} on deploy@stop.example.`,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(messages).toHaveLength(0);
    expect(readMeta(meta.id)?.callbackSuppressedReason).toContain("cancelled");
  });

  // @covers background-task.ssh-spawn
  // @level integration
  // @fails-without-fix background-task.ssh-spawn
  it("kills a remote tmux session when stopped while session creation is in flight", async () => {
    const messages: string[] = [];
    const pi = {
      sendMessage: (message: { content: string }) => { messages.push(message.content); },
    } as unknown as ExtensionAPI;
    const delayedStart = deferred<ReturnType<typeof successfulResult>>();
    const runner = new FakeRemoteRunner([
      successfulResult("/usr/bin/tmux\ntmux 3.4\n"),
      delayedStart.promise,
      successfulResult(""),
    ]);
    const meta = spawnTask(pi, {
      command: "sleep 300",
      callback: true,
      ssh: { host: "race.example", user: "deploy" },
    }, process.cwd(), undefined, undefined, { remoteRunner: runner });

    await runner.waitForRunCalls(2);
    const stopping = stopTask(pi, meta.id);
    delayedStart.resolve(successfulResult(""));
    const stopped = await stopping;

    expect(runner.runCalls.map((call) => call.command)).toEqual([
      expect.stringContaining("command -v tmux"),
      expect.stringContaining(`new-session -d -s 'pi-bg-${meta.id}'`),
      `tmux kill-session -t 'pi-bg-${meta.id}'`,
    ]);
    expect(stopped).toMatchObject({
      status: "cancelled",
      result: { reason: "cancelled" },
      remote: {
        session: "tmux",
        sessionName: `pi-bg-${meta.id}`,
        stopMessage: `Killed remote tmux session pi-bg-${meta.id} on deploy@race.example.`,
      },
    });
    expect(messages).toHaveLength(0);
    expect(readMeta(meta.id)?.callbackSuppressedReason).toContain("cancelled");
  });

  // @covers background-task.ssh-spawn
  // @level integration
  it("queues normal terminal callbacks for succeeded and failed remote jobs", async () => {
    const messages: string[] = [];
    const pi = {
      sendMessage: (message: { content: string }) => { messages.push(message.content); },
    } as unknown as ExtensionAPI;
    const runnerForExit = (exitCode: number) => new FakeRemoteRunner([
      successfulResult("/usr/bin/tmux\ntmux 3.4\n"),
      successfulResult(""),
      successfulResult(`__PI_BG_STATUS__=${exitCode}\n__PI_BG_SIZE__=0\n`),
    ]);
    const succeeded = spawnTask(pi, {
      name: "remote success",
      command: "exit 0",
      ssh: { host: "callbacks.example" },
    }, process.cwd(), undefined, undefined, { remoteRunner: runnerForExit(0) });
    const failed = spawnTask(pi, {
      name: "remote failure",
      command: "exit 7",
      ssh: { host: "callbacks.example" },
    }, process.cwd(), undefined, undefined, { remoteRunner: runnerForExit(7) });

    const succeededTerminal = await waitForMeta(succeeded.id, (current) => current?.status === "succeeded" && current.callbackSentAt !== undefined);
    const failedTerminal = await waitForMeta(failed.id, (current) => current?.status === "failed" && current.callbackSentAt !== undefined);

    expect(succeededTerminal).toMatchObject({ status: "succeeded", lastExitCode: 0 });
    expect(failedTerminal).toMatchObject({ status: "failed", lastExitCode: 7 });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(succeeded.id);
    expect(messages[0]).toContain(failed.id);
    expect(messages[0]).toContain("status=succeeded");
    expect(messages[0]).toContain("status=failed");
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

function remoteResult(overrides: Partial<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> = {}) {
  const now = Date.now();
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    startedAt: now,
    endedAt: now,
    ...overrides,
  };
}

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

function resumeWithRemoteRunner(
  meta: NonNullable<ReturnType<typeof readMeta>>,
  runner: FakeRemoteRunner,
) {
  return resumeRunningTask(fakePi, meta, undefined, { remoteRunner: runner });
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}
