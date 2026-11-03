/**
 * Detached local supervision, exercised with real subprocesses.
 *
 * The tests here own the slice-2 acceptance evidence from
 * [the observed-waits design](../../../../docs/plans/observed-waits-design.md):
 * a command and its terminal evidence outlive the caller process, a duplicate
 * token never executes twice, stop and timeout really terminate the process
 * group, watch cadence and conditions behave like a Background tasks watch, and
 * missing runner evidence is `lost` rather than invented success.
 *
 * Every task runs through the real runner executable; nothing here stubs the
 * process layer.
 */

import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { stopProcessGroup } from "../process.ts";
import { readProcessStartToken } from "../process-identity.ts";
import { SupervisorFenceBusyError, withStateFence } from "./store.ts";
import {
  createLocalSupervisor,
  supervisorPaths,
  supervisorRunnerEntry,
  supervisorRunnerInvocation,
  supervisorTaskIdForToken,
} from "./index.ts";
import type { LocalSupervisor, SupervisorInspection } from "./index.ts";

const directories: string[] = [];
/** The TypeScript loader the repo itself uses for spawned fixtures. */
const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

function supervisorDirectory(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `pi-supervisor-${name}-`));
  directories.push(directory);
  return directory;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(label: string, probe: () => T | undefined | false, timeoutMs = 20_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < until) {
    const value = probe();
    if (value) return value;
    last = value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label} (last observation: ${JSON.stringify(last)})`);
}

async function waitForTerminal(
  supervisor: LocalSupervisor,
  taskId: string,
  timeoutMs = 20_000,
): Promise<SupervisorInspection> {
  return waitFor(`terminal ${taskId}`, () => {
    const inspection = supervisor.inspect(taskId);
    return inspection?.terminal ? inspection : undefined;
  }, timeoutMs);
}

async function runNodeScript(scriptPath: string, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string; exitedAt: number }> {
  const child = spawn(process.execPath, ["--import", tsxImport, scriptPath], {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode));
  });
  return { code, stdout, stderr, exitedAt: Date.now() };
}

async function runRunnerOnce(directory: string, taskId: string): Promise<number | null> {
  const invocation = supervisorRunnerInvocation(directory, taskId);
  const child = spawn(invocation.execPath, invocation.args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode));
  });
  // Node may print an experimental type-stripping warning on older 22.x releases.
  expect(stderr).not.toMatch(/Error:|Cannot find module/);
  return code;
}

const PLANTED_START_TOKEN = "fixture-start-token";

/**
 * Build an identity reader for a command recorded by a real runner.
 *
 * This must behave identically on a host where `ps` is readable and on one where
 * it is not, and it must use the real OS identity whenever that is possible:
 *
 * - readable OS token and a recorded token: assert they agree and keep the real
 *   OS reader, so the identity boundary is exercised rather than bypassed;
 * - otherwise: plant a token in the command record and return a reader for it,
 *   so the branch stays deterministic without depending on ambient `ps` access.
 */
function identityFixture(
  directory: string,
  taskId: string,
  pid: number,
): { readStartToken: (candidate: number) => string | undefined; token: string; usesRealToken: boolean } {
  const commandPath = supervisorPaths(directory, taskId).command;
  const record = JSON.parse(readFileSync(commandPath, "utf8")) as Record<string, unknown>;
  const recorded = typeof record.pidStartTime === "string" ? record.pidStartTime : undefined;
  const live = readProcessStartToken(pid);
  if (recorded !== undefined && live !== undefined) {
    expect(live).toBe(recorded);
    return {
      readStartToken: (candidate) => (candidate === pid ? readProcessStartToken(candidate) : undefined),
      token: recorded,
      usesRealToken: true,
    };
  }
  writeFileSync(commandPath, JSON.stringify({ ...record, pidStartTime: PLANTED_START_TOKEN }));
  return {
    readStartToken: (candidate) => (candidate === pid ? PLANTED_START_TOKEN : undefined),
    token: PLANTED_START_TOKEN,
    usesRealToken: false,
  };
}

function taskIds(directory: string): string[] {
  try {
    return readdirSync(join(directory, "tasks"));
  } catch {
    return [];
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    for (const taskId of taskIds(directory)) {
      // Best effort: never let a test leak a runner or a command process.
      try {
        const claim = JSON.parse(readFileSync(supervisorPaths(directory, taskId).claim, "utf8")) as { pid?: number };
        if (claim.pid) process.kill(claim.pid, "SIGKILL");
      } catch { /* no claim, or already gone */ }
      try {
        const command = JSON.parse(readFileSync(supervisorPaths(directory, taskId).command, "utf8")) as { pid?: number; pgid?: number };
        if (command.pid) {
          try { stopProcessGroup(command.pid, command.pgid, "SIGKILL"); } catch { /* already gone */ }
        }
      } catch { /* no command record */ }
    }
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* a child may still hold a file */ }
  }
});

describe("supervised local process", () => {
  // @covers observed-waits.runner-outlives-caller
  // @level integration
  it("keeps executing and records terminal evidence after the launching process exits", async () => {
    const directory = supervisorDirectory("survive");
    const markerPath = join(directory, "marker.json");
    const callerPath = join(directory, "caller.mjs");
    const token = "parent-exit-token-0001";
    const command = [
      process.execPath,
      "-e",
      [
        'const { writeFileSync } = require("node:fs");',
        'console.log("survivor-stdout");',
        'console.error("survivor-stderr");',
        "setTimeout(() => {",
        `  writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ at: Date.now(), pid: process.pid }));`,
        "  process.exit(0);",
        "}, 1200);",
      ].join("\n"),
    ];
    writeFileSync(callerPath, [
      `import { createLocalSupervisor } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};`,
      `const supervisor = createLocalSupervisor({ directory: ${JSON.stringify(directory)} });`,
      "const started = await supervisor.start({",
      `  token: ${JSON.stringify(token)},`,
      `  argv: ${JSON.stringify(command)},`,
      "  commandTimeoutSeconds: 30,",
      "});",
      'process.stdout.write(JSON.stringify({ taskId: started.taskId, claimed: started.claimed, callerPid: process.pid }) + "\\n");',
      "process.exit(0);",
    ].join("\n"));

    const caller = await runNodeScript(callerPath, process.cwd());
    expect(caller.stderr).not.toMatch(/Error:|Cannot find module/);
    expect(caller.code).toBe(0);
    const launched = JSON.parse(caller.stdout.trim()) as { taskId: string; claimed: boolean; callerPid: number };
    expect(launched.claimed).toBe(true);
    expect(launched.taskId).toBe(supervisorTaskIdForToken(token));
    await waitFor("caller process gone", () => !pidAlive(launched.callerPid));

    const supervisor = createLocalSupervisor({ directory });
    const early = supervisor.inspect(launched.taskId);
    expect(early).toBeDefined();
    // The runner is a separate process, in its own group, and it is not the caller.
    expect(early!.status).toBe("running");
    expect(early!.claim?.alive).toBe(true);
    expect(early!.claim!.pid).not.toBe(launched.callerPid);

    const terminal = await waitForTerminal(supervisor, launched.taskId);
    expect(terminal.status).toBe("succeeded");
    expect(terminal.result?.attestedBy).toBe("runner");
    expect(terminal.result?.exitCode).toBe(0);
    expect(terminal.result?.runner?.pid).not.toBe(launched.callerPid);

    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { at: number; pid: number };
    // Proof the command itself outlived the caller: it finished its own delay long after the caller exited.
    expect(marker.at - caller.exitedAt).toBeGreaterThan(500);

    // Streams stay apart in the durable evidence and in the per-stream logs.
    expect(terminal.result?.lastOutput?.stdout).toContain("survivor-stdout");
    expect(terminal.result?.lastOutput?.stderr).toContain("survivor-stderr");
    const stdoutLog = readFileSync(terminal.logs.stdout, "utf8");
    const stderrLog = readFileSync(terminal.logs.stderr, "utf8");
    expect(stdoutLog).toContain("survivor-stdout");
    expect(stdoutLog).not.toContain("survivor-stderr");
    expect(stderrLog).toContain("survivor-stderr");
    expect(stderrLog).not.toContain("survivor-stdout");
    expect(readFileSync(terminal.logs.events, "utf8")).toContain("terminal status=succeeded");

    // A second launch of the same token reports the recorded execution and never runs it again.
    const replay = await supervisor.start({ token, argv: command, commandTimeoutSeconds: 30 });
    expect(replay.started).toBe(false);
    expect(replay.taskId).toBe(launched.taskId);
    expect(replay.status).toBe("succeeded");
  }, 30_000);

  // @covers observed-waits.launch-token-single-execution
  // @level integration
  it("executes once per token, including concurrent launches and duplicate runners", async () => {
    const directory = supervisorDirectory("duplicate");
    const counterPath = join(directory, "runs.txt");
    const token = "duplicate-token-0001";
    const argv = [
      process.execPath,
      "-e",
      `require("node:fs").appendFileSync(${JSON.stringify(counterPath)}, "run\\n"); console.log("ran");`,
    ];
    const supervisor = createLocalSupervisor({ directory });
    const runs = (): number => (existsSync(counterPath) ? readFileSync(counterPath, "utf8").trim().split("\n").filter(Boolean).length : 0);

    const [first, second] = await Promise.all([
      supervisor.start({ token, argv }),
      supervisor.start({ token, argv }),
    ]);
    expect(first.taskId).toBe(second.taskId);
    expect([first.started, second.started].filter(Boolean)).toHaveLength(1);

    const terminal = await waitForTerminal(supervisor, first.taskId);
    expect(terminal.status).toBe("succeeded");
    expect(runs()).toBe(1);

    const replay = await supervisor.start({ token, argv });
    expect(replay.started).toBe(false);
    expect(replay.status).toBe("succeeded");
    expect(runs()).toBe(1);

    // A runner spawned for an already-finished token exits without executing.
    expect(await runRunnerOnce(directory, first.taskId)).toBe(0);
    expect(runs()).toBe(1);

    await expect(supervisor.start({
      token,
      argv: [process.execPath, "-e", "console.log('a different command')"],
    })).rejects.toThrow(/already used for a different request/);
    expect(runs()).toBe(1);

    // Two live runners racing for one fresh token: the loser must not execute.
    const raceToken = "duplicate-race-token-0001";
    const raceCounter = join(directory, "race.txt");
    const raceArgv = [
      process.execPath,
      "-e",
      `const fs=require("node:fs"); fs.appendFileSync(${JSON.stringify(raceCounter)}, "run\\n"); setTimeout(() => process.exit(0), 300);`,
    ];
    const race = await supervisor.start({ token: raceToken, argv: raceArgv });
    expect(await runRunnerOnce(directory, race.taskId)).toBe(0);
    const raceTerminal = await waitForTerminal(supervisor, race.taskId);
    expect(raceTerminal.status).toBe("succeeded");
    expect(readFileSync(raceCounter, "utf8").trim().split("\n")).toHaveLength(1);
  }, 30_000);

  // @covers observed-waits.stop-cancels-owned-process
  // @level integration
  it("stops a running process group and records runner-attested cancellation", async () => {
    const directory = supervisorDirectory("stop");
    const supervisor = createLocalSupervisor({ directory });
    const started = await supervisor.start({
      token: "stop-token-0001",
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    });
    const running = await waitFor("live command identity", () => {
      const inspection = supervisor.inspect(started.taskId);
      return inspection?.command?.alive ? inspection : undefined;
    });
    const commandPid = running.command!.pid;
    expect(pidAlive(commandPid)).toBe(true);

    const stopped = await supervisor.stop(started.taskId);
    expect(stopped?.status).toBe("cancelled");
    expect(stopped?.terminal).toBe(true);
    expect(stopped?.stopRequested).toBe(true);
    expect(stopped?.inspection.result?.attestedBy).toBe("runner");
    expect(stopped?.inspection.result?.reason).toMatch(/stopped by request/);
    await waitFor("process group gone", () => !pidAlive(commandPid));

    const again = await supervisor.stop(started.taskId);
    expect(again?.status).toBe("cancelled");
    expect(again?.stopRequested).toBe(false);

    const other = await supervisor.start({
      token: "stop-token-0002",
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    });
    await expect(supervisor.stop(other.taskId, { token: "not-the-token" })).rejects.toThrow(/does not match the launch token/);
    await supervisor.stop(other.taskId);
  }, 30_000);

  // @covers observed-waits.launch-environment-not-persisted
  // @level integration
  it("inherits the launch environment without persisting its values", async () => {
    const directory = supervisorDirectory("env");
    const secret = "super-secret-value-7f3a0123456789ab";
    expect(process.env.PI_SUPERVISOR_TEST_SECRET).toBeUndefined();
    const supervisor = createLocalSupervisor({ directory });
    const started = await supervisor.start({
      token: "env-token-0001",
      // The command reports that the value arrived without echoing it, so the
      // only place the value could appear is a record that stored it.
      argv: [
        process.execPath,
        "-e",
        'const v = process.env.PI_SUPERVISOR_TEST_SECRET; console.log(v && v.length > 0 ? "inherited" : "missing");',
      ],
      env: { PI_SUPERVISOR_TEST_SECRET: secret },
    });
    const terminal = await waitForTerminal(supervisor, started.taskId);
    expect(terminal.status).toBe("succeeded");
    // The runner inherited the launch environment and passed it on.
    expect(terminal.result?.lastOutput?.stdout.trim()).toBe("inherited");
    // No durable record holds the value, including the immutable launch record.
    const taskDir = supervisorPaths(directory, started.taskId).dir;
    const records = readdirSync(taskDir).filter((name) => name.endsWith(".json"));
    expect(records).toContain("launch.json");
    for (const name of records) {
      expect(readFileSync(join(taskDir, name), "utf8")).not.toContain(secret);
    }
    expect(readFileSync(supervisorPaths(directory, started.taskId).launch, "utf8")).toContain('"environment": "inherited"');
  }, 30_000);

  // @covers observed-waits.command-time-limit
  // @level integration
  it("enforces the per-command limit and the whole-task deadline with real termination", async () => {
    const directory = supervisorDirectory("timeout");
    const supervisor = createLocalSupervisor({ directory });
    const capped = await supervisor.start({
      token: "timeout-token-0001",
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      commandTimeoutSeconds: 0.4,
    });
    const capTerminal = await waitForTerminal(supervisor, capped.taskId);
    expect(capTerminal.status).toBe("timed_out");
    expect(capTerminal.result?.timedOut).toBe(true);
    expect(capTerminal.result?.reason).toMatch(/command time limit of 0\.4s/);
    await waitFor("capped process group gone", () => !pidAlive(capTerminal.command?.pid ?? 0));

    const deadline = await supervisor.start({
      token: "timeout-token-0002",
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      timeoutSeconds: 0.4,
    });
    const taskTerminal = await waitForTerminal(supervisor, deadline.taskId);
    expect(taskTerminal.status).toBe("timed_out");
    expect(taskTerminal.result?.reason).toBe("timeout");
    await waitFor("deadline process group gone", () => !pidAlive(taskTerminal.command?.pid ?? 0));
  }, 30_000);
});

describe("supervised local command watch", () => {
  // @covers observed-waits.watch-cadence-and-success
  // @level integration
  it("polls on its own cadence and ends on the production success condition", async () => {
    const directory = supervisorDirectory("watch-success");
    const counterPath = join(directory, "checks.txt");
    const supervisor = createLocalSupervisor({ directory });
    const started = await supervisor.start({
      token: "watch-success-token-0001",
      kind: "watch",
      argv: [
        process.execPath,
        "-e",
        [
          'const fs = require("node:fs");',
          `const path = ${JSON.stringify(counterPath)};`,
          'const n = fs.existsSync(path) ? Number(fs.readFileSync(path, "utf8")) + 1 : 1;',
          "fs.writeFileSync(path, String(n));",
          'console.error("pending " + n);',
          'console.log(n >= 3 ? "ready " + n : "waiting " + n);',
          "process.exit(0);",
        ].join("\n"),
      ],
      intervalSeconds: 0.05,
      commandTimeoutSeconds: 10,
      successWhen: { type: "stdout_contains", value: "ready" },
      failureWhen: { type: "stdout_contains", value: "explode" },
    });

    const terminal = await waitForTerminal(supervisor, started.taskId);
    expect(terminal.status).toBe("succeeded");
    expect(terminal.result?.reason).toBe("success condition matched");
    expect(terminal.result?.matchedCondition).toEqual({ type: "stdout_contains", value: "ready" });
    // Exactly one check per cadence tick: no busy looping, no skipped condition.
    expect(terminal.result?.checks).toBe(3);
    expect(terminal.result?.lastCheck?.stdout).toContain("ready 3");
    expect(terminal.result?.lastCheck?.stderr).toContain("pending 3");

    // Per-stream logs keep stdout and stderr apart across checks.
    const stdoutLog = readFileSync(terminal.logs.stdout, "utf8");
    const stderrLog = readFileSync(terminal.logs.stderr, "utf8");
    expect(stdoutLog).toContain("waiting 1");
    expect(stdoutLog).toContain("ready 3");
    expect(stdoutLog).not.toContain("pending");
    expect(stderrLog).toContain("pending 1");
    expect(stderrLog).toContain("pending 3");
    expect(stderrLog).not.toContain("ready");

    // Cadence is observable: three checks, spaced by at least the interval.
    const events = readFileSync(terminal.logs.events, "utf8").split("\n");
    const checkTimes = events
      .filter((line) => line.includes("check #"))
      .map((line) => Date.parse(line.slice(0, line.indexOf(" "))));
    expect(checkTimes).toHaveLength(3);
    expect(checkTimes[1]! - checkTimes[0]!).toBeGreaterThanOrEqual(40);
    expect(checkTimes[2]! - checkTimes[1]!).toBeGreaterThanOrEqual(40);
    expect(events.some((line) => line.includes("terminal status=succeeded"))).toBe(true);
  }, 30_000);

  // @covers observed-waits.watch-failure-condition
  // @level integration
  it("ends a watch on its failure condition and keeps the evidence", async () => {
    const directory = supervisorDirectory("watch-failure");
    const counterPath = join(directory, "checks.txt");
    const supervisor = createLocalSupervisor({ directory });
    const started = await supervisor.start({
      token: "watch-failure-token-0001",
      kind: "watch",
      argv: [
        process.execPath,
        "-e",
        [
          'const fs = require("node:fs");',
          `const path = ${JSON.stringify(counterPath)};`,
          'const n = fs.existsSync(path) ? Number(fs.readFileSync(path, "utf8")) + 1 : 1;',
          "fs.writeFileSync(path, String(n));",
          'console.error("checking " + n);',
          'console.log(n >= 2 ? "boom " + n : "ok " + n);',
          "process.exit(0);",
        ].join("\n"),
      ],
      intervalSeconds: 0.05,
      commandTimeoutSeconds: 10,
      successWhen: { type: "stdout_contains", value: "green" },
      failureWhen: { type: "stdout_contains", value: "boom" },
    });

    const terminal = await waitForTerminal(supervisor, started.taskId);
    expect(terminal.status).toBe("failed");
    expect(terminal.result?.reason).toBe("failure condition matched");
    expect(terminal.result?.matchedCondition).toEqual({ type: "stdout_contains", value: "boom" });
    expect(terminal.result?.checks).toBe(2);
    expect(terminal.result?.lastCheck?.stdout).toContain("boom 2");
    expect(readFileSync(terminal.logs.stderr, "utf8")).toContain("checking 2");
  }, 30_000);

  // @covers observed-waits.watch-check-spawn-error
  // @level integration
  it("fails the watch when a check cannot start instead of polling forever", async () => {
    const directory = supervisorDirectory("watch-spawn-error");
    const supervisor = createLocalSupervisor({ directory });
    const started = await supervisor.start({
      token: "watch-spawn-error-token-0001",
      kind: "watch",
      argv: [join(directory, "no-such-executable")],
      intervalSeconds: 0.05,
      commandTimeoutSeconds: 5,
      successWhen: { type: "exit_code", equals: 0 },
    });
    const terminal = await waitForTerminal(supervisor, started.taskId);
    expect(terminal.status).toBe("failed");
    expect(terminal.result?.reason).toMatch(/the watch check could not run: .*ENOENT/);
    expect(terminal.result?.checks).toBe(1);
  }, 30_000);

  // @covers observed-waits.watch-condition-validation
  // @level integration
  it("refuses invalid launches before creating any record or process", async () => {
    const directory = supervisorDirectory("refuse");
    const supervisor = createLocalSupervisor({ directory });
    const argv = [process.execPath, "-e", "console.log('never runs')"];
    const created = (token: string): SupervisorInspection | undefined => supervisor.inspect(supervisorTaskIdForToken(token));

    await expect(supervisor.start({ token: "refuse-watch-no-success", kind: "watch", argv }))
      .rejects.toThrow(/requires successWhen/);
    await expect(supervisor.start({
      token: "refuse-watch-bad-json",
      kind: "watch",
      argv,
      successWhen: { type: "json_path_equals", path: "status", value: "done" },
    })).rejects.toThrow(/unsupported JSON path/);
    await expect(supervisor.start({ token: "refuse-empty-argv", argv: [] })).rejects.toThrow(/argv must be a non-empty array/);
    await expect(supervisor.start({ token: "refuse-nul-argv", argv: [process.execPath, "-e", "a\0b"] }))
      .rejects.toThrow(/NUL byte/);
    await expect(supervisor.start({ token: "refuse-cwd", argv, cwd: join(directory, "does-not-exist") }))
      .rejects.toThrow(/cwd does not exist/);
    await expect(supervisor.start({ token: "refuse-process-watch", argv, successWhen: { type: "exit_code", equals: 0 } }))
      .rejects.toThrow(/belong to a watch/);
    await expect(supervisor.start({ token: "refuse-process-interval", argv, intervalSeconds: 1 }))
      .rejects.toThrow(/watch cadence/);
    await expect(supervisor.start({ token: "refuse-zero-cap", argv, commandTimeoutSeconds: 0 }))
      .rejects.toThrow(/greater than 0/);
    await expect(supervisor.start({ token: "", argv })).rejects.toThrow(/token must be a non-empty string/);

    expect(created("refuse-watch-no-success")).toBeUndefined();
    expect(created("refuse-watch-bad-json")).toBeUndefined();
    expect(taskIds(directory)).toEqual([]);
  }, 30_000);
});

describe("supervisor-attested cancellation", () => {
  // @covers observed-waits.supervisor-stop-attestation
  // @level integration
  it("records a cancellation when no runner can attest the stop", async () => {
    const directory = supervisorDirectory("attested-stop");
    const fakeRunner = join(directory, "fake-runner.mjs");
    // A runner that exits without claiming leaves a `starting` launch behind.
    writeFileSync(fakeRunner, "process.exit(0);\n");
    const supervisor = createLocalSupervisor({ directory, runnerPath: fakeRunner });
    const started = await supervisor.start({
      token: "attested-stop-token-0001",
      argv: [process.execPath, "-e", "console.log('never runs')"],
    });
    expect(started.status).toBe("starting");

    const stopped = await supervisor.stop(started.taskId, { waitMs: 100, reason: "operator cancelled" });
    expect(stopped?.status).toBe("cancelled");
    expect(stopped?.terminal).toBe(true);
    expect(stopped?.inspection.result?.attestedBy).toBe("supervisor");
    expect(stopped?.inspection.result?.reason).toBe("operator cancelled");
    expect(stopped?.inspection.result?.exitCode).toBeNull();
  }, 30_000);
});

describe("lost execution evidence", () => {
  // @covers observed-waits.lost-runner-no-relaunch
  // @level integration
  it("reports a killed runner as lost and never relaunches the command", async () => {
    const directory = supervisorDirectory("lost");
    const counterPath = join(directory, "runs.txt");
    const supervisor = createLocalSupervisor({ directory });
    const argv = [
      process.execPath,
      "-e",
      `require("node:fs").appendFileSync(${JSON.stringify(counterPath)}, "run\\n"); setInterval(() => {}, 1000);`,
    ];
    const started = await supervisor.start({ token: "lost-token-0001", argv });
    const running = await waitFor("live runner and command", () => {
      const inspection = supervisor.inspect(started.taskId);
      return inspection?.claim?.alive && inspection.command?.alive ? inspection : undefined;
    });
    const runnerPid = running.claim!.pid;
    const commandPid = running.command!.pid;

    process.kill(runnerPid, "SIGKILL");
    const lost = await waitForTerminal(supervisor, started.taskId);
    expect(lost.status).toBe("lost");
    expect(lost.lost?.reason).toMatch(/exited without recording a terminal result/);
    expect(lost.result).toBeUndefined();

    // The command is genuinely orphaned — and the supervisor does not invent an exit code for it.
    expect(pidAlive(commandPid)).toBe(true);
    expect(readFileSync(counterPath, "utf8").trim()).toBe("run");

    // Re-launching the same token reports the lost execution; it never starts a second command.
    const replay = await supervisor.start({ token: "lost-token-0001", argv });
    expect(replay.started).toBe(false);
    expect(replay.status).toBe("lost");
    // Nor may a fresh runner process pick the token up again.
    expect(await runRunnerOnce(directory, started.taskId)).toBe(0);
    expect(readFileSync(counterPath, "utf8").trim()).toBe("run");
    expect(pidAlive(commandPid)).toBe(true);

    // Cleanup of the orphaned command is explicit, outside supervision.
    try { stopProcessGroup(commandPid, commandPid, "SIGKILL"); } catch { /* already gone */ }
  }, 30_000);

  // @covers observed-waits.unclaimed-launch-lost
  // @level integration
  it("reports an unclaimed launch as lost after the claim grace and refuses to retry it", async () => {
    const directory = supervisorDirectory("unclaimed");
    const fakeRunner = join(directory, "fake-runner.mjs");
    // Exits without claiming: the launch record stays, and no execution may follow.
    writeFileSync(fakeRunner, "process.exit(0);\n");
    const supervisor = createLocalSupervisor({ directory, runnerPath: fakeRunner });
    const token = "unclaimed-token-0001";
    const started = await supervisor.start({ token, argv: [process.execPath, "-e", "console.log('never runs')"] });
    expect(started.started).toBe(true);
    expect(started.claimed).toBe(false);
    expect(started.status).toBe("starting");

    const lost = supervisor.inspect(started.taskId, { claimGraceMs: 0 });
    expect(lost?.status).toBe("lost");
    expect(lost?.lost?.reason).toMatch(/no runner claimed the launch token/);
    expect(existsSync(supervisorPaths(directory, started.taskId).claim)).toBe(false);
    expect(existsSync(supervisorPaths(directory, started.taskId).result)).toBe(false);

    const replay = await supervisor.start({ token, argv: [process.execPath, "-e", "console.log('never runs')"] });
    expect(replay.started).toBe(false);
    expect(replay.status).toBe("lost");

    const brokenSupervisor = createLocalSupervisor({ directory, runnerPath: join(directory, "missing-runner.mjs") });
    await expect(brokenSupervisor.start({
      token: "unclaimed-token-0002",
      argv: [process.execPath, "-e", "console.log('never runs')"],
    })).rejects.toThrow(/before claiming the launch token/);
  }, 30_000);
});

describe("shipped runner artifact", () => {
  // @covers observed-waits.runner-installed-path
  // @level integration
  it("runs from an installed node_modules tree, where Node refuses to strip types", async () => {
    const directory = supervisorDirectory("installed");
    const installRoot = join(directory, "install");
    const packageRoot = join(installRoot, "node_modules", "pi-better-background-tasks");
    const supervisorSource = dirname(fileURLToPath(import.meta.url));
    mkdirSync(join(packageRoot, "src", "supervisor"), { recursive: true });
    cpSync(join(supervisorSource, "generated"), join(packageRoot, "src", "supervisor", "generated"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-better-background-tasks", type: "module" }));

    // The old entrypoint, under node_modules, is exactly what Node refuses.
    cpSync(join(supervisorSource, "runner.ts"), join(packageRoot, "src", "supervisor", "runner.ts"));
    const refused = spawn(process.execPath, [join(packageRoot, "src", "supervisor", "runner.ts"), directory, "bgs_00000000000000000000"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let refusalStderr = "";
    refused.stderr?.on("data", (chunk: Buffer) => { refusalStderr += chunk.toString("utf8"); });
    const refusalCode = await new Promise<number | null>((resolve) => refused.once("exit", resolve));
    expect(refusalCode).not.toBe(0);
    expect(refusalStderr).toMatch(/ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);

    // The default entrypoint is the emitted JavaScript closure, never the .ts source.
    expect(supervisorRunnerEntry()).toMatch(/generated[\\/]runner\.mjs$/);

    // The emitted JS closure is the supported entrypoint at the same install path.
    const installedRunner = join(packageRoot, "src", "supervisor", "generated", "runner.mjs");
    const supervisor = createLocalSupervisor({ directory, runnerPath: installedRunner });
    const started = await supervisor.start({
      token: "installed-token-0001",
      argv: [process.execPath, "-e", "console.log('installed-runner-ok')"],
    });
    const terminal = await waitForTerminal(supervisor, started.taskId);
    expect(terminal.status).toBe("succeeded");
    expect(terminal.result?.lastOutput?.stdout).toContain("installed-runner-ok");
  }, 30_000);

  // @covers observed-waits.runner-emitted-closure-current
  // @level unit
  it("keeps the checked-in runner closure in step with the TypeScript sources", () => {
    const supervisorSource = dirname(fileURLToPath(import.meta.url));
    const generated = join(supervisorSource, "generated");
    const reassembled = mkdtempSync(join(tmpdir(), "pi-supervisor-codegen-"));
    const output = execFileSync(process.execPath, [join(supervisorSource, "emit-runner.mjs"), reassembled], { encoding: "utf8" });
    expect(output).toContain("emitted");

    const names = readdirSync(generated).filter((name) => name.endsWith(".mjs")).sort();
    expect(names.length).toBeGreaterThanOrEqual(7);
    expect(readdirSync(reassembled).filter((name) => name.endsWith(".mjs")).sort()).toEqual(names);
    for (const name of names) {
      expect(readFileSync(join(reassembled, name), "utf8")).toBe(readFileSync(join(generated, name), "utf8"));
      // A shipped closure may only reach Node builtins; a relative .ts import under
      // node_modules would be the unsupported type-stripping path again.
      const code = readFileSync(join(generated, name), "utf8");
      expect(code).not.toMatch(/from\s*"\.\.?\/[^"]*\.ts"/);
      const bare = [...code.matchAll(/(?:from|import)\s*\(?\s*"([^".][^"]*)"/g)].map((match) => match[1]!);
      for (const specifier of bare) expect(specifier.startsWith("node:")).toBe(true);
    }
  }, 30_000);
});

describe("record publication", () => {
  // @covers observed-waits.exclusive-record-atomic-publication
  // @level integration
  it("never publishes a partial exclusive record to another process", async () => {
    const directory = supervisorDirectory("atomic-publish");
    const storeEntry = join(dirname(fileURLToPath(import.meta.url)), "generated", "store.mjs");
    const writer = join(directory, "writer.mjs");
    writeFileSync(writer, [
      `import { writeTextExclusive } from ${JSON.stringify(pathToFileURL(storeEntry).href)};`,
      "const [target, count] = process.argv.slice(2);",
      'const pad = "x".repeat(120_000);',
      "for (let i = 0; i < Number(count); i += 1) {",
      '  writeTextExclusive(`${target}/rec-${i}.json`, JSON.stringify({ i, pad }));',
      "}",
      "",
    ].join("\n"));
    const count = 40;
    const child = spawn(process.execPath, [writer, directory, String(count)], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

    const seen = new Set<string>();
    const partial: string[] = [];
    const code = await new Promise<number | null>((resolve) => {
      const timer = setInterval(() => {
        for (const name of readdirSync(directory)) {
          if (!/^rec-\d+\.json$/.test(name)) continue;
          seen.add(name);
          try {
            const parsed = JSON.parse(readFileSync(join(directory, name), "utf8")) as { pad?: string };
            if (parsed.pad?.length !== 120_000) partial.push(`${name}: short payload`);
          } catch (error) {
            partial.push(`${name}: ${(error as Error).message}`);
          }
        }
      }, 1);
      child.once("exit", (exitCode) => { clearInterval(timer); resolve(exitCode); });
    });

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(partial).toEqual([]);
    expect(seen.size).toBe(count);
    expect(readdirSync(directory).filter((name) => name.startsWith(".rec-"))).toEqual([]);
  }, 40_000);
});

describe("termination cleans the whole process group", () => {
  /**
   * Build a launch whose direct child exits shortly after SIGTERM while a
   * descendant ignores SIGTERM. The descendant writes its own ready file only
   * after installing its handler, so the test stops it deterministically (no
   * startup race) and can prove it received the group's TERM and survived it.
   */
  function resistantCommand(options: {
    directory: string;
    directChild: "exits-after-term" | "ignores-term";
  }): { argv: string[]; descendantPidPath: string; descendantReadyPath: string; descendantTermMarker: string } {
    const descendantPidPath = join(options.directory, "descendant.pid");
    const descendantReadyPath = join(options.directory, "descendant.ready");
    const descendantTermMarker = join(options.directory, "descendant.term");
    const descendantScript = join(options.directory, "descendant.mjs");
    writeFileSync(descendantScript, [
      'import { writeFileSync } from "node:fs";',
      `process.on("SIGTERM", () => { try { writeFileSync(${JSON.stringify(descendantTermMarker)}, "term"); } catch {} });`,
      'process.on("SIGINT", () => {});',
      `writeFileSync(${JSON.stringify(descendantReadyPath)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"));
    const childBehaviour = options.directChild === "exits-after-term"
      ? 'process.on("SIGTERM", () => { setTimeout(() => process.exit(0), 60); });'
      : 'process.on("SIGTERM", () => {});';
    const argv = [
      process.execPath,
      "-e",
      [
        'const { spawn } = require("node:child_process");',
        'const fs = require("node:fs");',
        `const descendant = spawn(process.execPath, [${JSON.stringify(descendantScript)}], { stdio: "ignore" });`,
        `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
        childBehaviour,
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    ];
    return { argv, descendantPidPath, descendantReadyPath, descendantTermMarker };
  }

  // @covers observed-waits.group-signal-requires-owned-leader
  // @level integration
  it("stops signalling the group once the leader exits and reports it unproven", async () => {
    const directory = supervisorDirectory("resistant-stop");
    const plan = resistantCommand({ directory, directChild: "exits-after-term" });
    const supervisor = createLocalSupervisor({ directory });
    const started = await supervisor.start({ token: "resistant-stop-token-0001", argv: plan.argv });
    await waitFor("descendant ready", () => existsSync(plan.descendantReadyPath));
    const descendantPid = Number(readFileSync(plan.descendantPidPath, "utf8"));

    const stopped = await supervisor.stop(started.taskId);
    expect(stopped?.status).toBe("cancelled");
    expect(stopped?.inspection.result?.reason).toMatch(/stopped by request/);
    // The first group TERM reached the descendant while the leader was owned; the
    // leader then exited, so the escalation refused to address the pgid again.
    expect(readFileSync(plan.descendantTermMarker, "utf8")).toBe("term");
    expect(stopped?.inspection.result?.groupCleanup).toBe("unproven");
    // Refusing is the point: the pgid can no longer be proven to name our group.
    expect(pidAlive(descendantPid)).toBe(true);

    // The leftover is cleaned by its actual owner (the test captured the pid),
    // never by a signal to a group whose identity could not be proven.
    try { stopProcessGroup(descendantPid, descendantPid, "SIGKILL"); } catch { /* already gone */ }
  }, 40_000);

  // @covers observed-waits.group-kill-with-owned-leader
  // @level integration
  it("kills a TERM-resistant group while its leader is still owned and verified", async () => {
    const directory = supervisorDirectory("resistant-timeout");
    const plan = resistantCommand({ directory, directChild: "ignores-term" });
    const supervisor = createLocalSupervisor({ directory });
    const started = await supervisor.start({
      token: "resistant-timeout-token-0001",
      argv: plan.argv,
      commandTimeoutSeconds: 1,
    });
    await waitFor("descendant ready", () => existsSync(plan.descendantReadyPath));
    const descendantPid = Number(readFileSync(plan.descendantPidPath, "utf8"));

    const terminal = await waitForTerminal(supervisor, started.taskId);
    expect(terminal.status).toBe("timed_out");
    expect(readFileSync(plan.descendantTermMarker, "utf8")).toBe("term");
    // The leader survived TERM, so the escalation still owned a verified group
    // member and could kill the whole group.
    expect(terminal.result?.groupCleanup).toBe("empty");
    try {
      await waitFor("resistant descendant dead", () => !pidAlive(descendantPid), 10_000);
    } catch (error) {
      throw new Error(`${(error as Error).message}\nterminal=${JSON.stringify(terminal.result)}\nevents:\n${readFileSync(terminal.logs.events, "utf8")}`);
    }
  }, 40_000);
});

describe("lost evidence is a fence, not a guess", () => {
  // @covers observed-waits.lost-fences-late-claim
  // @level integration
  it("refuses a delayed runner that arrives after the launch was recorded lost", async () => {
    const directory = supervisorDirectory("late-claim");
    const counterPath = join(directory, "runs.txt");
    const delayedRunner = join(directory, "delayed-runner.mjs");
    const realRunner = supervisorRunnerEntry();
    // A runner that starts late: exactly the window the fence must close.
    writeFileSync(delayedRunner, [
      'import { spawn } from "node:child_process";',
      "const [directory, taskId] = process.argv.slice(2);",
      "await new Promise((resolve) => setTimeout(resolve, 2600));",
      `spawn(process.execPath, [${JSON.stringify(realRunner)}, directory, taskId], { stdio: "ignore" });`,
      "process.exit(0);",
      "",
    ].join("\n"));
    const supervisor = createLocalSupervisor({ directory, runnerPath: delayedRunner });
    const argv = [
      process.execPath,
      "-e",
      `require("node:fs").appendFileSync(${JSON.stringify(counterPath)}, "run\\n");`,
    ];
    const started = await supervisor.start({ token: "late-claim-token-0001", argv });
    expect(started.claimed).toBe(false);
    expect(started.status).toBe("starting");

    const lost = supervisor.inspect(started.taskId, { claimGraceMs: 0 });
    expect(lost?.status).toBe("lost");
    expect(existsSync(supervisorPaths(directory, started.taskId).lost)).toBe(true);

    // The delayed runner attempts its claim after the loss is durable.
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    const after = supervisor.inspect(started.taskId);
    expect(after?.status).toBe("lost");
    expect(after?.result).toBeUndefined();
    expect(existsSync(supervisorPaths(directory, started.taskId).claim)).toBe(false);
    expect(existsSync(counterPath)).toBe(false);
  }, 40_000);

  // @covers observed-waits.lost-fences-late-claim
  // @level integration
  it("refuses a runner that claims a launch already recorded lost", async () => {
    const directory = supervisorDirectory("lost-fence-direct");
    const counterPath = join(directory, "runs.txt");
    const fakeRunner = join(directory, "no-claim-runner.mjs");
    writeFileSync(fakeRunner, "process.exit(0);\n");
    const supervisor = createLocalSupervisor({ directory, runnerPath: fakeRunner });
    const argv = [process.execPath, "-e", `require("node:fs").appendFileSync(${JSON.stringify(counterPath)}, "run\\n");`];
    const started = await supervisor.start({ token: "lost-fence-direct-token-0001", argv });
    expect(started.status).toBe("starting");
    expect(supervisor.inspect(started.taskId, { claimGraceMs: 0 })?.status).toBe("lost");

    // The real shipped runner arrives after the loss is durable.
    expect(await runRunnerOnce(directory, started.taskId)).toBe(0);
    expect(existsSync(supervisorPaths(directory, started.taskId).claim)).toBe(false);
    expect(existsSync(counterPath)).toBe(false);
    expect(supervisor.inspect(started.taskId)?.status).toBe("lost");
  }, 30_000);

  // @covers observed-waits.single-identity-source
  // @level integration
  it("uses one identity source for liveness and for signalling", async () => {
    const directory = supervisorDirectory("identity-seam");
    const supervisor = createLocalSupervisor({ directory });
    const started = await supervisor.start({
      token: "identity-seam-token-0001",
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    });
    const running = await waitFor("live command", () => {
      const inspection = supervisor.inspect(started.taskId);
      return inspection?.command?.alive ? inspection : undefined;
    });
    const commandPid = running.command!.pid;
    const commandPath = supervisorPaths(directory, started.taskId).command;
    const record = JSON.parse(readFileSync(commandPath, "utf8")) as Record<string, unknown>;
    writeFileSync(commandPath, JSON.stringify({ ...record, pidStartTime: PLANTED_START_TOKEN }));

    // The instance reader, not the ambient OS token, decides liveness: this is
    // the same source that authorizes a signal.
    const matching = createLocalSupervisor({
      directory,
      readStartToken: (pid) => (pid === commandPid ? PLANTED_START_TOKEN : undefined),
    });
    expect(matching.inspect(started.taskId)?.command?.alive).toBe(true);
    // A different identity is a mismatch, never liveness.
    const mismatching = createLocalSupervisor({ directory, readStartToken: () => "another-token" });
    expect(mismatching.inspect(started.taskId)?.command?.alive).toBe(false);

    await supervisor.stop(started.taskId);
    try { stopProcessGroup(commandPid, commandPid, "SIGKILL"); } catch { /* already gone */ }
  }, 40_000);

  // @covers observed-waits.external-cleanup-requires-verified-leader
  // @level integration
  it("refuses the external group escalation after the leader dies", async () => {
    const directory = supervisorDirectory("external-escalation");
    const descendantPidPath = join(directory, "descendant.pid");
    const descendantReadyPath = join(directory, "descendant.ready");
    const descendantTermMarker = join(directory, "descendant.term");
    const descendantScript = join(directory, "descendant.mjs");
    writeFileSync(descendantScript, [
      'import { writeFileSync } from "node:fs";',
      `process.on("SIGTERM", () => { try { writeFileSync(${JSON.stringify(descendantTermMarker)}, "term"); } catch {} });`,
      'process.on("SIGINT", () => {});',
      `writeFileSync(${JSON.stringify(descendantReadyPath)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"));
    // The leader exits shortly after TERM; only the descendant survives it.
    const argv = [
      process.execPath,
      "-e",
      [
        'const { spawn } = require("node:child_process");',
        'const fs = require("node:fs");',
        'process.on("SIGTERM", () => { setTimeout(() => process.exit(0), 60); });',
        `const descendant = spawn(process.execPath, [${JSON.stringify(descendantScript)}], { stdio: "ignore" });`,
        `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    ];
    const supervisor = createLocalSupervisor({ directory });
    const started = await supervisor.start({ token: "external-escalation-token-0001", argv });
    await waitFor("descendant ready", () => existsSync(descendantReadyPath));
    const descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
    const live = await waitFor("live command", () => {
      const inspection = supervisor.inspect(started.taskId);
      return inspection?.command?.alive && inspection.claim?.alive ? inspection : undefined;
    });
    const leaderPid = live.command!.pid;
    process.kill(live.claim!.pid, "SIGKILL");
    const lost = await waitForTerminal(supervisor, started.taskId);
    expect(lost.status).toBe("lost");
    expect(pidAlive(leaderPid)).toBe(true);

    const identity = identityFixture(directory, started.taskId, leaderPid);
    const verifying = createLocalSupervisor({ directory, readStartToken: identity.readStartToken });
    const cleaned = await verifying.stop(started.taskId);
    // SIGTERM was sent while the leader verified; the leader then died, so the
    // SIGKILL escalation refused and the cleanup is unproven, never "killed".
    expect(cleaned?.cleanup?.signals).toEqual(["SIGTERM"]);
    expect(cleaned?.cleanup?.outcome).toBe("unproven");
    expect(cleaned?.cleanup?.groupEmpty).toBe(false);
    expect(cleaned?.inspection.status).toBe("lost");
    expect(readFileSync(descendantTermMarker, "utf8")).toBe("term");
    expect(pidAlive(descendantPid)).toBe(true);
    try { stopProcessGroup(descendantPid, descendantPid, "SIGKILL"); } catch { /* already gone */ }
  }, 60_000);

  // @covers observed-waits.stop-cleans-orphan-without-replacing-lost
  // @level integration
  it("cleans a surviving command only with proven identity and keeps the lost verdict", async () => {
    const directory = supervisorDirectory("orphan-cleanup");
    const supervisor = createLocalSupervisor({ directory });
    const started = await supervisor.start({
      token: "orphan-cleanup-token-0001",
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    });
    const running = await waitFor("live runner and command", () => {
      const inspection = supervisor.inspect(started.taskId);
      return inspection?.claim?.alive && inspection.command?.alive ? inspection : undefined;
    });
    const commandPid = running.command!.pid;
    process.kill(running.claim!.pid, "SIGKILL");
    const lost = await waitForTerminal(supervisor, started.taskId);
    expect(lost.status).toBe("lost");
    expect(pidAlive(commandPid)).toBe(true);

    // Unknown identity: the pid is alive but the identity reader cannot prove it,
    // on any host. Injected so a readable OS token does not turn this into "killed".
    const unknown = createLocalSupervisor({ directory, readStartToken: () => undefined });
    const refused = await unknown.stop(started.taskId);
    expect(refused?.status).toBe("lost");
    expect(refused?.cleanup?.outcome).toBe("refused-unknown-identity");
    expect(pidAlive(commandPid)).toBe(true);
    expect(refused?.inspection.result).toBeUndefined();
    expect(refused?.inspection.lost).toBeDefined();

    // Verified identity: the same stop may signal, and it never rewrites the verdict.
    const identity = identityFixture(directory, started.taskId, commandPid);
    const verifying = createLocalSupervisor({ directory, readStartToken: identity.readStartToken });
    const cleaned = await verifying.stop(started.taskId);
    expect(cleaned?.status).toBe("lost");
    expect(cleaned?.cleanup?.outcome).toBe("killed");
    expect(cleaned?.cleanup?.identity).toBe("verified");
    expect(cleaned?.cleanup?.groupEmpty).toBe(true);
    expect(cleaned?.inspection.result).toBeUndefined();
    expect(cleaned?.inspection.lost).toBeDefined();
    await waitFor("orphaned command dead", () => !pidAlive(commandPid));

    // The lost verdict still fences a replay.
    const replay = await verifying.start({
      token: "orphan-cleanup-token-0001",
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    });
    expect(replay.started).toBe(false);
    expect(replay.status).toBe("lost");
  }, 40_000);
});

describe("state fence", () => {
  const storeEntryUrl = (): string =>
    pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "generated", "store.mjs")).href;

  function writeHolderScript(directory: string): string {
    const holder = join(directory, "holder.mjs");
    writeFileSync(holder, [
      `import { withStateFence } from ${JSON.stringify(storeEntryUrl())};`,
      "const [directory, taskId, holdMs] = process.argv.slice(2);",
      "withStateFence(directory, taskId, () => {",
      '  process.stdout.write("held\\n");',
      "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));",
      '  process.stdout.write("released\\n");',
      "});",
      "",
    ].join("\n"));
    return holder;
  }

  // @covers observed-waits.fence-live-holder-not-taken-over
  // @level integration
  it("waits on a live holder instead of taking the fence over", async () => {
    const directory = supervisorDirectory("fence-live");
    const taskId = supervisorTaskIdForToken("fence-live-token-0001");
    const holder = writeHolderScript(directory);
    // The holder outlives the old 2s "stale" window on purpose.
    const child = spawn(process.execPath, [holder, directory, taskId, "3200"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    await waitFor("holder acquired", () => output.includes("held"));

    let entered = false;
    const attemptStarted = Date.now();
    try {
      withStateFence(directory, taskId, () => { entered = true; }, { waitMs: 2_600 });
      throw new Error("the fence was taken from a live holder");
    } catch (error) {
      expect(error).toBeInstanceOf(SupervisorFenceBusyError);
      expect((error as SupervisorFenceBusyError).verdict).toBe("busy");
    }
    const waited = Date.now() - attemptStarted;
    expect(entered).toBe(false);
    // The waiter held for the full bounded wait and never reclaimed the live
    // holder, even though the holder outlived the previous 2s stale window.
    expect(waited).toBeGreaterThanOrEqual(2_500);

    await waitFor("holder released", () => output.includes("released"));
    let second = false;
    withStateFence(directory, taskId, () => { second = true; });
    expect(second).toBe(true);
  }, 40_000);

  // @covers observed-waits.fence-releases-with-dead-owner
  // @level integration
  it("acquires immediately when the holder process died mid-transaction", async () => {
    const directory = supervisorDirectory("fence-dead");
    const taskId = supervisorTaskIdForToken("fence-dead-token-0001");
    const holder = writeHolderScript(directory);
    const child = spawn(process.execPath, [holder, directory, taskId, "8000"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    await waitFor("holder acquired", () => output.includes("held"));
    process.kill(child.pid!, "SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));

    let entered = false;
    const started = Date.now();
    withStateFence(directory, taskId, () => { entered = true; }, { waitMs: 2_000 });
    expect(entered).toBe(true);
    // The OS released the dead holder's lock; nothing waited on a timeout.
    expect(Date.now() - started).toBeLessThan(1_000);
  }, 40_000);

  // @covers observed-waits.fence-excludes-concurrent-contenders
  // @level integration
  it("serializes many contenders so only one is ever inside", async () => {
    const directory = supervisorDirectory("fence-contenders");
    const taskId = supervisorTaskIdForToken("fence-contenders-token-0001");
    const logPath = join(directory, "critical.log");
    const contender = join(directory, "contender.mjs");
    writeFileSync(contender, [
      'import { appendFileSync } from "node:fs";',
      `import { withStateFence } from ${JSON.stringify(storeEntryUrl())};`,
      "const [directory, taskId, log] = process.argv.slice(2);",
      "withStateFence(directory, taskId, () => {",
      '  appendFileSync(log, "start\\n");',
      "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);",
      '  appendFileSync(log, "end\\n");',
      "});",
      "",
    ].join("\n"));
    const count = 5;
    const children = Array.from({ length: count }, () =>
      spawn(process.execPath, [contender, directory, taskId, logPath], { stdio: ["ignore", "pipe", "pipe"] }));
    const codes = await Promise.all(children.map((child) =>
      new Promise<number | null>((resolve) => child.once("exit", resolve))));
    expect(codes).toEqual(Array<number | null>(count).fill(0));

    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(count * 2);
    // Strict alternation: no second contender can be inside while one is.
    for (let index = 0; index < lines.length; index += 2) {
      expect(lines[index]).toBe("start");
      expect(lines[index + 1]).toBe("end");
    }
  }, 60_000);

  // @covers observed-waits.fence-unavailable-fails-closed
  // @level integration
  it("fails closed when node:sqlite is unavailable", async () => {
    const directory = supervisorDirectory("fence-unavailable");
    const taskId = supervisorTaskIdForToken("fence-unavailable-token-0001");
    const probe = join(directory, "probe.mjs");
    writeFileSync(probe, [
      `import { withStateFence } from ${JSON.stringify(storeEntryUrl())};`,
      "try {",
      '  withStateFence(process.argv[2], process.argv[3], () => { process.stdout.write("entered\\n"); });',
      "} catch (error) {",
      '  process.stdout.write(`error:${error.name}:${error.verdict ?? "none"}\\n`);',
      "}",
      "",
    ].join("\n"));
    const child = spawn(process.execPath, ["--no-experimental-sqlite", probe, directory, taskId], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect(code).toBe(0);
    expect(output).toContain("error:SupervisorFenceBusyError:unavailable");
    expect(output).not.toContain("entered");
    // No fallback lock or half-open database was created.
    expect(existsSync(supervisorPaths(directory, taskId).fenceDb)).toBe(false);
  }, 40_000);
});
