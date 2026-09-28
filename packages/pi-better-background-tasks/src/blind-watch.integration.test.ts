import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { failurePath } from "./failures.js";
import { readFailureState } from "./shared-failure-observations.js";
import { inspectMeta, readMeta, taskDir } from "./registry.js";
import { awaitFirstWatchCheck, startWatchTask, stopTask } from "./runtime.js";
import { formatStatus } from "./output.js";
import { launchWatch } from "./tools.js";
import { FakeRemoteRunner } from "./test-support/fake-remote-runner.js";
import type { CommandResult } from "./types.js";

// #359: two real watches ran 47 and 26 checks blind. Their gcloud --format expression was
// invalid, so every check wrote this error to stderr, echoed STILL_UNKNOWN, and ended `exit 0`.
const GCLOUD_ERROR = "ERROR: (gcloud.run.jobs.executions.describe) Transform function expected [execution value(status.conditions.filter(\"type:Completed\").status *HERE* )].";
const INCIDENT_COMMAND = "status=$(gcloud run jobs executions describe kyc-dev-mapping-once-jhzcr --project=cosmic-heaven-479306-v5 --region=asia-east1 --format='value(status.conditions.filter(\"type:Completed\").status)'); case \"$status\" in True) echo TERMINAL_SUCCESS ;; False) echo TERMINAL_FAILURE ;; *) echo STILL_${status:-UNKNOWN} ;; esac; exit 0";
const SUCCESS = { type: "stdout_contains" as const, value: "TERMINAL_SUCCESS" };
const FAILURE = { type: "stdout_contains" as const, value: "TERMINAL_FAILURE" };

const origin = { cwd: process.cwd(), sessionId: "blind-watch-tests" };
const ids: string[] = [];
const stubDir = mkdtempSync(join(tmpdir(), "pi-bg-359-"));
// The stub stands in for gcloud with the broken --format: error on stderr, empty stdout, exit 1.
writeFileSync(join(stubDir, "gcloud"), `#!/bin/sh\necho '${GCLOUD_ERROR.replace(/'/g, "'\\''")}' >&2\nexit 1\n`);
chmodSync(join(stubDir, "gcloud"), 0o755);
const stubEnv = { PATH: `${stubDir}:${process.env.PATH ?? ""}` };

afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  for (const id of ids) {
    if (readMeta(id)?.status === "running") await stopTask(host().pi, id, () => origin);
    rmSync(taskDir(id), { recursive: true, force: true });
  }
  rmSync(stubDir, { recursive: true, force: true });
});

function host() {
  const messages: string[] = [];
  const pi = { sendMessage: (message: { content: string }) => { messages.push(message.content); } } as unknown as ExtensionAPI;
  return { pi, messages };
}

function taskId(launch: string): string {
  const id = launch.match(/bg_[A-Za-z0-9_]+/)?.[0];
  if (!id) throw new Error(`no task id in: ${launch}`);
  ids.push(id);
  return id;
}

function observations(id: string) {
  return Object.values(readFailureState(failurePath(id)).observations);
}
const blindIncident = (id: string) => observations(id).find((x) => x.operation === "watch-blind");

let pollSequence = 0;
function scripted(stdout: string, stderr = "", exitCode = 0): CommandResult {
  const at = Date.now() + ++pollSequence;
  return { stdout, stderr, exitCode, signal: null, startedAt: at, endedAt: at };
}

function sshWatch(pi: ExtensionAPI, runner: FakeRemoteRunner, extra: { blind_checks?: number } = {}) {
  const meta = startWatchTask(pi, { command: "check", ssh: { host: "example.test" }, callback: false,
    interval_seconds: 1, timeout_seconds: 60, success_when: SUCCESS, failure_when: FAILURE, ...extra },
  process.cwd(), origin, () => origin, { remoteRunner: runner });
  ids.push(meta.id);
  return meta;
}

describe("#359 blind watch checks", () => {
  it("replays the gcloud incident: the first check is shown, and 3 blind checks raise one actionable incident and one wake", async () => {
    const { pi, messages } = host();
    const launch = await launchWatch(pi, {
      name: "dev-mapping-once", command: INCIDENT_COMMAND, env: stubEnv,
      interval_seconds: 1, timeout_seconds: 0, success_when: SUCCESS, failure_when: FAILURE,
    }, process.cwd(), origin, () => origin);
    const id = taskId(launch);

    // First check in the tool result: exit code, stdout tail, stderr tail.
    expect(launch).toContain("First check: exit 0");
    expect(launch).toContain("STILL_UNKNOWN");
    expect(launch).toContain("Transform function expected");
    expect(launch).toContain("exited 0 but wrote stderr");
    expect(Buffer.byteLength(launch)).toBeLessThanOrEqual(1024);

    await expect.poll(() => blindIncident(id)?.status, { timeout: 15_000, interval: 50 }).toBe("unresolved");
    const incident = blindIncident(id)!;
    expect(incident.summary).toContain("3 checks in a row exited 0 with stderr");
    expect(incident.evidence).toContain("Transform function expected");
    expect(readMeta(id)?.status).toBe("running");
    const status = formatStatus(inspectMeta(id), { origin });
    expect(status).toMatch(/^Action required/);
    expect(status).toContain("Transform function expected");

    // The existing attention path holds a 60 s grace before waking; step past it.
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 61_000);
    await expect.poll(() => messages.length, { timeout: 15_000, interval: 50 }).toBe(1);
    expect(messages[0]).toContain(id);
    expect(messages[0]).toContain("Transform function expected");

    // Blind checks keep coming; the watch keeps running and never wakes the parent again.
    const streak = readMeta(id)!.blindCheckStreak!;
    await expect.poll(() => readMeta(id)!.blindCheckStreak! >= streak + 2, { timeout: 15_000, interval: 50 }).toBe(true);
    expect(messages).toHaveLength(1);
    expect(observations(id).filter((x) => x.operation === "watch-blind")).toHaveLength(1);
    expect(readMeta(id)?.status).toBe("running");
    await stopTask(pi, id, () => origin);
  }, 30_000);

  it("with the rule off (the pre-#359 behavior) the same broken check records nothing", async () => {
    const { pi, messages } = host();
    const launch = await launchWatch(pi, {
      command: INCIDENT_COMMAND, env: stubEnv, blind_checks: 0,
      interval_seconds: 1, timeout_seconds: 0, success_when: SUCCESS, failure_when: FAILURE,
    }, process.cwd(), origin, () => origin);
    const id = taskId(launch);
    await expect.poll(() => (readMeta(id)?.lastCheckedAt ?? 0) > 0).toBe(true);
    const first = readMeta(id)!.lastCheckedAt!;
    // Wait for 3 more checks.
    await expect.poll(() => readMeta(id)!.lastCheckedAt! > first + 2_500, { timeout: 15_000, interval: 50 }).toBe(true);
    expect(observations(id)).toEqual([]);
    expect(messages).toEqual([]);
    await stopTask(pi, id, () => origin);
  }, 30_000);

  it("a pending-but-healthy check (clean STILL_RUNNING, no stderr) never triggers", async () => {
    const { pi } = host();
    const launch = await launchWatch(pi, {
      command: "echo STILL_RUNNING; exit 0",
      interval_seconds: 1, timeout_seconds: 0, success_when: SUCCESS, failure_when: FAILURE,
    }, process.cwd(), origin, () => origin);
    const id = taskId(launch);
    expect(launch).toContain("First check: exit 0");
    expect(launch).toContain("STILL_RUNNING");
    expect(launch).not.toContain("stderr");
    const first = readMeta(id)!.lastCheckedAt!;
    await expect.poll(() => readMeta(id)!.lastCheckedAt! > first + 3_500, { timeout: 15_000, interval: 50 }).toBe(true);
    expect(observations(id)).toEqual([]);
    expect(readMeta(id)?.blindCheckStreak).toBe(0);
    await stopTask(pi, id, () => origin);
  }, 30_000);

  it("recovers once a check comes back clean, and a later streak is a new incident (SSH watch)", async () => {
    const { pi } = host();
    const blind = () => scripted("STILL_UNKNOWN\n", `${GCLOUD_ERROR}\n`);
    const runner = new FakeRemoteRunner([
      blind(), blind(), blind(),
      scripted("STILL_RUNNING\n"),
      blind(), blind(), blind(),
      scripted("TERMINAL_SUCCESS\n"),
    ]);
    const meta = sshWatch(pi, runner);
    const first = await awaitFirstWatchCheck(meta.id, 5_000);
    expect(first).toMatchObject({ exitCode: 0, stdout: "STILL_UNKNOWN\n" });
    expect(first?.stderr).toContain("Transform function expected");

    await expect.poll(() => blindIncident(meta.id)?.status, { timeout: 15_000, interval: 50 }).toBe("unresolved");
    const firstIncident = blindIncident(meta.id)!.id;
    await expect.poll(() => blindIncident(meta.id)?.status, { timeout: 15_000, interval: 50 }).toBe("resolved");
    await expect.poll(() => blindIncident(meta.id)?.id !== firstIncident && blindIncident(meta.id)?.status === "unresolved",
      { timeout: 15_000, interval: 50 }).toBe(true);
    // A matched success condition recovers it too, so the terminal callback carries no stale incident.
    await expect.poll(() => readMeta(meta.id)?.status, { timeout: 15_000, interval: 50 }).toBe("succeeded");
    expect(blindIncident(meta.id)?.status).toBe("resolved");
  }, 30_000);

  it("a non-zero check with stderr is a poll failure, not a blind check, and does not recover a blind incident", async () => {
    const { pi } = host();
    const runner = new FakeRemoteRunner([
      scripted("", "boom\n"), scripted("", "boom\n"), scripted("", "boom\n"),
      scripted("", "auth expired\n", 1),
    ]);
    const meta = sshWatch(pi, runner);
    await expect.poll(() => observations(meta.id).some((x) => x.operation === "watch-poll"), { timeout: 15_000, interval: 50 }).toBe(true);
    expect(blindIncident(meta.id)?.status).toBe("unresolved");
    expect(readMeta(meta.id)?.blindCheckStreak).toBe(0);
    await stopTask(pi, meta.id, () => origin);
  }, 30_000);

  it("reports a first check that is still running when the wait ends", async () => {
    const { pi } = host();
    const launch = await launchWatch(pi, {
      command: "sleep 5; echo TERMINAL_SUCCESS",
      interval_seconds: 1, timeout_seconds: 0, success_when: SUCCESS,
    }, process.cwd(), origin, () => origin, 1_000);
    const id = taskId(launch);
    expect(launch).toContain("First check still running after 1s; the watch continues in the background.");
    expect(readMeta(id)?.status).toBe("running");
    await stopTask(pi, id, () => origin);
  }, 15_000);

  it("rejects a malformed blind_checks before launch", () => {
    const { pi } = host();
    expect(() => startWatchTask(pi, { command: "true", blind_checks: -1, success_when: SUCCESS }, process.cwd()))
      .toThrow(/blind_checks must be a non-negative integer/);
  });
});

