import { appendFileSync, rmSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";
import { failurePath, recordFailure, scheduleFailureAttention } from "./failures.js";
import { readFailureState, observeFailures } from "./shared-failure-observations.js";
import { getCallbackBatcher } from "./shared-callback-batcher.js";
import { readMeta, taskDir, writeMeta } from "./registry.js";
import { resumeRunningTask, spawnTask, startWatchTask, stopTask } from "./runtime.js";
import { formatLaunch } from "./tools.js";
import { FakeRemoteRunner } from "./test-support/fake-remote-runner.js";

const origin = { cwd: process.cwd(), sessionId: "failure-observation-tests" };
const result = (stdout: string, exitCode = 0) => ({
  stdout, stderr: "", exitCode, signal: null, startedAt: Date.now(), endedAt: Date.now(),
});
async function until(id: string, predicate: (meta: NonNullable<ReturnType<typeof readMeta>>) => boolean) {
  for (let i = 0; i < 200; i++) {
    const meta = readMeta(id);
    if (meta && predicate(meta)) return meta;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`task ${id} did not reach expected state`);
}

const ids: string[] = [];
let pollSequence = 0;
const scripted = (stdout: string, exitCode = 0) => ({ ...result(stdout, exitCode), startedAt: Date.now() + ++pollSequence });
afterAll(() => { for (const id of ids) rmSync(taskDir(id), { recursive: true, force: true }); });
function watch(pi: ExtensionAPI, runner: FakeRemoteRunner, success_when: Parameters<typeof startWatchTask>[1]["success_when"],
  failure_when?: Parameters<typeof startWatchTask>[1]["failure_when"]) {
  const meta = startWatchTask(pi, { command: "check", ssh: { host: "example.test" }, callback: false,
    interval_seconds: 1, timeout_seconds: 5, success_when, failure_when }, process.cwd(), origin, () => origin,
  { remoteRunner: runner });
  ids.push(meta.id);
  return meta;
}

describe("background failure observations", () => {
  const pi = { sendMessage: () => undefined } as unknown as ExtensionAPI;

  it("observes failure_when parse errors even when success_when matches, then resolves only on a valid evaluation", async () => {
    const runner = new FakeRemoteRunner([result("ready"), result('{"ready":true}')]);
    const meta = watch(pi, runner, { type: "stdout_contains", value: "ready" },
      { type: "json_path_equals", path: "$.ready", value: false });
    await until(meta.id, (m) => m.status === "running" && Boolean(m.error));
    expect(Object.values(readFailureState(failurePath(meta.id)).observations).some((x) => x.operation === "failure_when" && x.category === "observation-incomplete")).toBe(true);
    expect(formatLaunch(readMeta(meta.id)!)).toMatch(/^Observation incomplete/);
    const terminal = await until(meta.id, (m) => m.status === "succeeded");
    expect(terminal.error).toBeUndefined();
    expect(Object.values(readFailureState(failurePath(meta.id)).observations).every((x) => x.status === "resolved")).toBe(true);
  });

  it("a matched failure remains terminal even when the success evaluator is broken", async () => {
    const runner = new FakeRemoteRunner([result("failed"), result('{"status":"done"}')]);
    const meta = watch(pi, runner, { type: "json_path_equals", path: "$.status", value: "done" },
      { type: "stdout_contains", value: "failed" });
    const terminal = await until(meta.id, (m) => m.status === "failed");
    expect(terminal.error).toMatch(/success_when/);
    const observations = Object.values(readFailureState(failurePath(meta.id)).observations);
    expect(observations.some((x) => x.operation === "success_when" && x.status === "unresolved")).toBe(true);
    expect(observations.some((x) => x.operation === "failure_when" && x.status === "unresolved")).toBe(true);
  });

  it("keeps nonzero watch polls nonterminal, groups retries, and recovers on a successful poll", async () => {
    const runner = new FakeRemoteRunner([scripted("pending", 7), scripted("pending", 7), scripted("ready")]);
    const meta = watch(pi, runner, { type: "stdout_contains", value: "ready" });
    await until(meta.id, (m) => m.status === "succeeded");
    const poll = Object.values(readFailureState(failurePath(meta.id)).observations).find((x) => x.operation === "watch-poll");
    expect(poll).toMatchObject({ status: "resolved", count: 2 });
  });

  it("treats a configured nonzero success exit as expected and attention-quiet", async () => {
    const runner = new FakeRemoteRunner([scripted("not ready", 7)]);
    const meta = watch(pi, runner, { type: "exit_code", equals: 7 });
    await until(meta.id, (m) => m.status === "succeeded");
    expect(Object.values(readFailureState(failurePath(meta.id)).observations)).toEqual([
      expect.objectContaining({ status: "expected", operation: "watch-poll" }),
    ]);
  });

  it("an explicitly accepted nonzero exit recovers a prior unexpected poll failure", async () => {
    const runner = new FakeRemoteRunner([scripted("unexpected", 2), scripted("accepted", 7)]);
    const meta = watch(pi, runner, { type: "exit_code", equals: 7 });
    await until(meta.id, (m) => m.status === "succeeded");
    const observations = Object.values(readFailureState(failurePath(meta.id)).observations);
    expect(observations.some((x) => x.status === "unresolved")).toBe(false);
    expect(observations.some((x) => x.operation === "watch-poll" && x.status === "expected")).toBe(true);
  });

  it("records a nonzero process exit before terminal status and shows it on launch/status", async () => {
    const meta = spawnTask(pi, { command: "exit 9", callback: false }, process.cwd());
    ids.push(meta.id);
    const terminal = await until(meta.id, (m) => m.status === "failed");
    expect(formatLaunch(terminal)).toMatch(/^Unresolved failure.*Process exited with code 9/);
    expect(Object.values(readFailureState(failurePath(meta.id)).observations)).toEqual([
      expect.objectContaining({ status: "unresolved", category: "exit" }),
    ]);
  });

  it("does not acknowledge terminal incidents before callback handoff and replays after reload", async () => {
    let fail = true;
    const messages: string[] = [];
    const host = { sendMessage: (message: { content: string }) => {
      if (fail) { fail = false; throw new Error("handoff unavailable"); }
      messages.push(message.content);
    } } as unknown as ExtensionAPI;
    const id = `bg_observation_replay_${Date.now()}`;
    ids.push(id);
    const meta = { id, kind: "process" as const, status: "failed" as const, startedAt: Date.now(),
      endedAt: Date.now(), logPath: `${taskDir(id)}/output.log`, cwd: origin.cwd, spawnPid: process.pid,
      callbackOrigin: origin, callback: true };
    writeMeta(meta);
    recordFailure(meta, "execution", "exit 9", "close");
    resumeRunningTask(host, meta, () => origin);
    expect(await getCallbackBatcher(host).flush()).toBe(false);
    expect(readFailureState(failurePath(id)).delivered).toEqual({});
    expect(readMeta(id)?.callbackSentAt).toBeUndefined();
    resumeRunningTask(host, readMeta(id)!, () => origin);
    expect(await getCallbackBatcher(host).flush()).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("exit 9");
    expect(Object.keys(readFailureState(failurePath(id)).delivered)).toHaveLength(1);
    resumeRunningTask(host, readMeta(id)!, () => origin);
    await getCallbackBatcher(host).flush();
    expect(messages).toHaveLength(1);
  });

  it("grace-delivers a running incident once, but never wakes a callback:false task", async () => {
    const messages: string[] = [];
    const host = { sendMessage: (message: { content: string }) => { messages.push(message.content); } } as unknown as ExtensionAPI;
    const make = (callback: boolean) => {
      const id = `bg_observation_grace_${callback}_${Date.now()}`;
      ids.push(id);
      const meta = { id, kind: "command_watch" as const, status: "running" as const,
        startedAt: Date.now() - 100_000, logPath: `${taskDir(id)}/output.log`, cwd: origin.cwd,
        spawnPid: process.pid, callbackOrigin: origin, callback };
      writeMeta(meta);
      observeFailures(failurePath(id), [{ id: `${id}:failure`, operation: "poll", kind: "failure", summary: "poll failed" }], Date.now() - 61_000);
      return meta;
    };
    const loud = make(true);
    const quiet = make(false);
    scheduleFailureAttention(host, loud.id, () => origin);
    scheduleFailureAttention(host, quiet.id, () => origin);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(loud.id);
    expect(readFailureState(failurePath(loud.id)).delivered).toEqual({ [loud.id + ":failure"]: expect.any(Number) });
    scheduleFailureAttention(host, loud.id, () => origin);
    expect(messages).toHaveLength(1);
    await stopTask(host, loud.id, () => origin);
    await stopTask(host, quiet.id, () => origin);
  });

  it("replays a failed running-attention handoff after reload without a premature delivery marker", async () => {
    let fail = true;
    const messages: string[] = [];
    const host = { sendMessage: (message: { content: string }) => {
      if (fail) { fail = false; throw new Error("handoff unavailable"); }
      messages.push(message.content);
    } } as unknown as ExtensionAPI;
    const id = `bg_observation_running_retry_${Date.now()}`;
    ids.push(id);
    const meta = { id, kind: "command_watch" as const, status: "running" as const,
      startedAt: Date.now() - 100_000, logPath: `${taskDir(id)}/output.log`, cwd: origin.cwd,
      spawnPid: process.pid, callbackOrigin: origin, callback: true };
    writeMeta(meta);
    observeFailures(failurePath(id), [{ id: `${id}:failure`, operation: "poll", kind: "failure", summary: "poll failed" }], Date.now() - 61_000);
    scheduleFailureAttention(host, id, () => origin);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readFailureState(failurePath(id)).delivered).toEqual({});
    scheduleFailureAttention(host, id, () => origin);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(messages).toHaveLength(1);
    expect(readFailureState(failurePath(id)).delivered[`${id}:failure`]).toBeTypeOf("number");
    await stopTask(host, id, () => origin);
  });

  it("remains explicit when the journal has unreadable data", () => {
    const id = `bg_observation_bad_journal_${Date.now()}`;
    ids.push(id);
    const meta = { id, kind: "process" as const, status: "running" as const,
      startedAt: Date.now(), logPath: `${taskDir(id)}/output.log`, cwd: origin.cwd, spawnPid: process.pid };
    writeMeta(meta);
    observeFailures(failurePath(id), [{ id: "valid", operation: "run", kind: "incomplete", summary: "missing observation" }]);
    appendFileSync(failurePath(id), "this is not json\n");
    expect(formatLaunch(meta)).toMatch(/^Observation incomplete/);
    expect(Object.values(readFailureState(failurePath(id)).observations).some((x) => x.summary.includes("unreadable records"))).toBe(true);
  });
});
