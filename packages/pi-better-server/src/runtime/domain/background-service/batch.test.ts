import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { spawnTaskBatch } from "./batch.js";
import { listMetas, readMeta, taskDir } from "./registry.js";
import { stopTask } from "./runtime.js";
import { FOREGROUND_SANDBOX_POLICY_CHANNEL, FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL } from "./sandbox.js";
import { getCallbackBatcher } from "./shared-callback-batcher.js";
import { FakeRemoteRunner, successfulResult } from "./test-support/fake-remote-runner.js";
import { registerTools } from "./tools.js";
import type { BackgroundTaskMeta } from "./types.js";

const directories: string[] = [];
const launchedIds: string[] = [];
const origin = { cwd: process.cwd(), sessionId: "batch-behavior-test" };

function fixtureDir() {
  const directory = mkdtempSync(join(tmpdir(), "bg-batch-"));
  directories.push(directory);
  return directory;
}

function host(events = new EventEmitter()) {
  const messages: string[] = [];
  const pi = {
    events,
    on() {},
    sendMessage(message: { content: string }) { messages.push(message.content); },
  } as unknown as ExtensionAPI;
  return { pi, messages };
}

function track<T extends { launched: Array<{ id: string }> }>(result: T): T {
  launchedIds.push(...result.launched.map(({ id }) => id));
  return result;
}

async function waitFor(id: string, predicate: (meta: BackgroundTaskMeta) => boolean): Promise<BackgroundTaskMeta> {
  await expect.poll(() => {
    const meta = readMeta(id);
    return meta && predicate(meta) ? meta : undefined;
  }, { timeout: 8_000, interval: 20 }).toBeDefined();
  return readMeta(id)!;
}

afterEach(async () => {
  const cleanupHost = host();
  for (const id of launchedIds.splice(0)) {
    if (readMeta(id)?.status === "running") await stopTask(cleanupHost.pi, id, () => origin);
    rmSync(taskDir(id), { recursive: true, force: true });
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("bg_task_spawn_batch", () => {
  it("merges defined overrides, preserves false/zero/null and runs local jobs with independent logs", async () => {
    const { pi } = host();
    const cwd = fixtureDir();
    const result = track(spawnTaskBatch(pi, {
      batchName: "local builds",
      shared: {
        cwd,
        env: { BATCH_COLOR: "shared", SHARED_ONLY: "present" },
        callback: false,
        timeout_seconds: 30,
        operation_id: "shared-operation",
      },
      jobs: [
        { name: "inherited", shell: false, argv: [process.execPath, "-e", "console.log(process.env.BATCH_COLOR, process.env.SHARED_ONLY, process.cwd())"], callback: undefined },
        { name: "overridden", shell: false, argv: [process.execPath, "-e", "console.log(process.env.BATCH_COLOR, process.env.SHARED_ONLY ?? 'absent')"], env: { BATCH_COLOR: "job" }, callback: true, timeout_seconds: 0, operation_id: null, expected_exit_codes: null },
      ],
    }, origin.cwd, origin, () => origin));

    expect(result.failed).toEqual([]);
    expect(result.launched.map(({ job, name }) => ({ job, name }))).toEqual([
      { job: 1, name: "inherited" }, { job: 2, name: "overridden" },
    ]);
    expect(result.launched[0]!.id).not.toBe(result.launched[1]!.id);
    const inherited = await waitFor(result.launched[0]!.id, (m) => m.status === "succeeded");
    const overridden = await waitFor(result.launched[1]!.id, (m) => m.status === "succeeded");
    expect(inherited).toMatchObject({ batchId: result.batchId, batchName: "local builds", callback: false, callbackOrigin: origin, cwd, operationId: "shared-operation", env: { BATCH_COLOR: "shared", SHARED_ONLY: "present" } });
    expect(overridden).toMatchObject({ batchId: result.batchId, batchName: "local builds", callback: true, callbackOrigin: origin, cwd, env: { BATCH_COLOR: "job" } });
    expect(overridden.deadlineAt).toBeUndefined();
    expect(overridden.operationId).toBeUndefined();
    expect(overridden.expectedExitCodes).toBeUndefined();
    expect(readFileSync(inherited.logPath, "utf8")).toContain(`shared present ${realpathSync(cwd)}`);
    expect(readFileSync(overridden.logPath, "utf8")).toContain("job absent");
    expect(inherited.logPath).not.toBe(overridden.logPath);
    expect(await getCallbackBatcher(pi).flush()).toBe(true);
    expect(readMeta(inherited.id)?.callbackSentAt).toBeUndefined();
    expect(readMeta(overridden.id)?.callbackSentAt).toBeTypeOf("number");
  });

  it("preflights the entire batch and bounds before any local process or task record exists", () => {
    const { pi } = host();
    const cwd = fixtureDir();
    const marker = join(cwd, "should-not-exist");
    const before = listMetas().map((meta) => meta.id);
    const good = { command: `${JSON.stringify(process.execPath)} -e 'require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")'` };
    for (const [jobs, error] of [
      [[good, { shell: false }], /Invalid batch job 2: argv with at least one element/],
      [[good, { command: "echo no", expected_exit_codes: [1, 1] }], /Invalid batch job 2: Invalid command intent/],
      [[good, { command: "echo no", ssh: { host: "bad host" } }], /Invalid batch job 2: ssh.host/],
      [[], /between 1 and 100/],
      [Array.from({ length: 101 }, () => good), /between 1 and 100/],
    ] as const) {
      expect(() => spawnTaskBatch(pi, { jobs: jobs as never }, cwd, origin)).toThrow(error);
      expect(listMetas().map((meta) => meta.id)).toEqual(before);
    }
    expect(() => readFileSync(marker)).toThrow();
  });

  it("reports a launch-time sandbox refusal for one job while keeping earlier and later launches", async () => {
    const events = new EventEmitter();
    let requests = 0;
    events.on(FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL, () => {
      requests += 1;
      events.emit(FOREGROUND_SANDBOX_POLICY_CHANNEL, {
        state: requests === 3 ? "unavailable" : "inactive",
        reason: "test backend unavailable",
      });
    });
    const { pi } = host(events);
    const before = new Set(listMetas().map((meta) => meta.id));
    const result = track(spawnTaskBatch(pi, {
      jobs: ["first", "blocked", "third"].map((name) => ({ name, shell: false, argv: [process.execPath, "-e", "console.log('ran')"], callback: false })),
    }, origin.cwd, origin, () => origin));
    expect(result.launched.map(({ job, name }) => ({ job, name }))).toEqual([{ job: 1, name: "first" }, { job: 3, name: "third" }]);
    expect(result.failed).toEqual([{ job: 2, name: "blocked", error: expect.stringContaining("blocked rather than launched") }]);
    for (const { id } of result.launched) {
      const meta = await waitFor(id, (m) => m.status === "succeeded");
      expect(meta.batchId).toBe(result.batchId);
      expect(readFileSync(meta.logPath, "utf8")).toContain("ran");
    }
    expect(listMetas().filter((meta) => !before.has(meta.id)).map((meta) => meta.id).sort()).toEqual(result.launched.map(({ id }) => id).sort());
  });

  it("stops one of two running jobs without stopping the other, and delivers only its surviving completion callback", async () => {
    const { pi, messages } = host();
    const cwd = fixtureDir();
    const release = join(cwd, "release");
    const code = `const fs = require('node:fs'); setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(0); }, 20);`;
    const result = track(spawnTaskBatch(pi, { jobs: [
      { name: "stop me", shell: false, argv: [process.execPath, "-e", code] },
      { name: "finish me", shell: false, argv: [process.execPath, "-e", code] },
    ] }, cwd, origin, () => origin));
    expect(result.failed).toEqual([]);
    const [stoppedId, survivorId] = result.launched.map(({ id }) => id);
    expect(readMeta(stoppedId!)?.status).toBe("running");
    expect(readMeta(survivorId!)?.status).toBe("running");
    expect((await stopTask(pi, stoppedId!, () => origin))?.status).toBe("cancelled");
    expect(readMeta(survivorId!)?.status).toBe("running");
    writeFileSync(release, "go");
    await waitFor(survivorId!, (m) => m.status === "succeeded" && m.callbackSentAt !== undefined);
    const cancelled = await waitFor(stoppedId!, (m) => m.callbackSuppressedAt !== undefined);
    expect(cancelled.callbackSentAt).toBeUndefined();
    expect(cancelled.callbackSuppressedReason).toMatch(/cancelled/);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(survivorId);
    expect(messages[0]).not.toContain(stoppedId);
  });

  it("replaces shared SSH identity and remote options per job while using tmux lifecycle", async () => {
    const runner = new FakeRemoteRunner([
      successfulResult("__PI_BG_TMUX_PATH__=/usr/bin/tmux\n__PI_BG_TMUX_VERSION__=tmux 3.4\n"),
      successfulResult("__PI_BG_TMUX_PATH__=/usr/bin/tmux\n__PI_BG_TMUX_VERSION__=tmux 3.4\n"),
      successfulResult(""), successfulResult(""),
      successfulResult("__PI_BG_STATUS__=0\n__PI_BG_SIZE__=0\n"),
      successfulResult("__PI_BG_STATUS__=0\n__PI_BG_SIZE__=0\n"),
    ]);
    const { pi } = host();
    const result = track(spawnTaskBatch(pi, {
      shared: { ssh: { host: "shared.example", user: "builder" }, remote: { install_tmux: false, workdir: "/srv/shared" }, callback: false },
      jobs: [
        { name: "shared host", command: "printf first" },
        { name: "override host", command: "printf second", ssh: { host: "other.example" }, remote: { workdir: "/srv/other" } },
      ],
    }, origin.cwd, origin, () => origin, { remoteRunner: runner }));
    expect(result.failed).toEqual([]);
    const [first, second] = await Promise.all(result.launched.map(({ id }) => waitFor(id, (m) => m.status === "succeeded")));
    expect(first).toMatchObject({ batchId: result.batchId, ssh: { target: "builder@shared.example" }, remote: { session: "tmux", workdir: "/srv/shared", installTmux: false, sessionStarted: true } });
    expect(second).toMatchObject({ batchId: result.batchId, ssh: { target: "other.example" }, remote: { session: "tmux", workdir: "/srv/other", installTmux: true, sessionStarted: true } });
    expect(second!.ssh?.user).toBeUndefined();
    expect(runner.spawnCalls).toHaveLength(0);
    expect(runner.runCalls.filter((call) => call.command?.includes("new-session"))).toEqual([
      expect.objectContaining({ argv: expect.arrayContaining(["builder@shared.example", expect.stringContaining("/srv/shared")]) }),
      expect.objectContaining({ argv: expect.arrayContaining(["other.example", expect.stringContaining("/srv/other")]) }),
    ]);
  });

  it("registers a Pi-valid batch tool and returns launch details", async () => {
    const { pi } = host();
    const tools = new Map<string, any>();
    (pi as any).registerTool = (tool: any) => tools.set(tool.name, tool);
    registerTools(pi);
    const tool = tools.get("bg_task_spawn_batch");
    const raw = { batchName: "tool batch", shared: { callback: false, operation_id: null, expected_exit_codes: null }, jobs: [
      { name: "one", shell: false, argv: [process.execPath, "-e", "console.log('from tool')"] },
    ] };
    const args = validateToolArguments({ name: tool.name, parameters: tool.parameters } as any,
      { type: "toolCall", id: "batch-tool", name: tool.name, arguments: structuredClone(raw) } as any);
    expect(args).toEqual(raw);
    expect(() => validateToolArguments({ name: tool.name, parameters: tool.parameters } as any,
      { type: "toolCall", id: "bad-batch", name: tool.name, arguments: { jobs: [] } } as any)).toThrow(/jobs/);
    const result = await tool.execute("batch-tool", args, new AbortController().signal, undefined, {
      cwd: origin.cwd, hasUI: false, sessionManager: { getSessionId: () => origin.sessionId },
    } as ExtensionContext);
    const structured = result.details as ReturnType<typeof spawnTaskBatch>;
    track(structured);
    expect(structured).toMatchObject({ batchName: "tool batch", failed: [], launched: [{ job: 1, name: "one", id: expect.any(String) }] });
    expect(result.content[0].text).toContain("1 launched, 0 failed to launch");
    expect(result.content[0].text).toContain(structured.launched[0]!.id);
    const meta = await waitFor(structured.launched[0]!.id, (m) => m.status === "succeeded");
    expect(meta).toMatchObject({ batchId: structured.batchId, batchName: "tool batch", callbackOrigin: origin });
    expect(readFileSync(meta.logPath, "utf8")).toContain("from tool");
  });
});
