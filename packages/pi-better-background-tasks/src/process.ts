import { spawn } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { CommandResult, CommandSpec } from "./types.js";

const DEFAULT_SHELL = process.env.PI_BETTER_BACKGROUND_TASKS_SHELL || "/bin/bash";

/** How long a timed-out process group has to exit on SIGTERM before SIGKILL. */
const TERMINATION_GRACE_MS = 2_000;

export interface SpawnedProcess {
  child: ChildProcess;
  pgid?: number;
}

export function validateCommandSpec(spec: CommandSpec): void {
  if (spec.shell === false) {
    if (!spec.argv || spec.argv.length === 0 || !spec.argv[0]) {
      throw new Error("argv with at least one element is required when shell:false");
    }
    return;
  }
  if (!spec.command || spec.command.trim().length === 0) {
    throw new Error("command is required unless shell:false with argv is provided");
  }
}

export function spawnCommand(spec: CommandSpec, logPath: string, detached: boolean): SpawnedProcess {
  validateCommandSpec(spec);
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "a");
  const child = spawnArgs(spec, detached, ["ignore", fd, fd]);
  writeSync(fd, `\n--- spawn ${new Date().toISOString()} pid=${child.pid ?? "unknown"} ---\n`);
  closeSync(fd);
  child.on("close", (code, signal) => {
    appendFileSync(logPath, `\n--- exit ${new Date().toISOString()} code=${code ?? "null"} signal=${signal ?? "null"} ---\n`);
  });
  return { child, pgid: detached && child.pid ? child.pid : undefined };
}

/**
 * Run one command to completion and collect its output.
 *
 * A timeout has to reach the whole process tree, not just the process spawned
 * here. Two things make that necessary rather than tidy:
 *
 * - The command may not be what runs. Under the Linux write sandbox the spawned
 *   process is `bwrap`, which forks the real command instead of exec'ing it, so
 *   a signal to the spawned pid never reaches the command at all. (macOS
 *   `sandbox-exec` execs its target, which is why the same signal works there.)
 * - `close` fires when the output pipes close, not when the child exits. A
 *   surviving grandchild keeps holding them, so signalling only the direct child
 *   leaves this promise pending indefinitely and the caller's deadline unenforced.
 *
 * So the child leads its own process group, and a timeout signals that group.
 */
export function runCommandOnce(
  spec: CommandSpec,
  maxBufferBytes = 1024 * 1024,
  timeoutMs?: number,
): Promise<CommandResult> {
  validateCommandSpec(spec);
  const startedAt = Date.now();
  const child = spawnArgs(spec, true, ["ignore", "pipe", "pipe"]);
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout?.on("data", (chunk: Buffer) => {
    if (Buffer.byteLength(stdout) < maxBufferBytes) stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (Buffer.byteLength(stderr) < maxBufferBytes) stderr += chunk.toString("utf8");
  });
  return new Promise((resolve, reject) => {
    // The group outlives the leader as long as any member is alive, so the
    // kernel keeps the id reserved and this stays addressable after the spawned
    // process itself has been reaped.
    const signalGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        stopProcessGroup(child.pid, undefined, signal);
      } catch {
        // Nothing left in the group: the tree is already gone.
      }
    };
    let escalation: NodeJS.Timeout | undefined;
    const timeout = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      signalGroup("SIGTERM");
      // SIGTERM is a request. Whatever still holds the output pipes after the
      // grace period is exactly what would keep this promise pending, so the
      // group is killed outright rather than waited on.
      escalation = setTimeout(() => signalGroup("SIGKILL"), TERMINATION_GRACE_MS);
      escalation.unref();
    }, Math.max(1, timeoutMs));
    timeout?.unref();
    const settle = (): void => {
      if (timeout) clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
    };
    child.on("error", (error) => {
      settle();
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      settle();
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        startedAt,
        endedAt: Date.now(),
        ...(timedOut ? { timedOut: true } : {}),
      });
    });
  });
}

export function stopProcessGroup(
  pid: number,
  pgid?: number,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  const target = pgid ?? pid;
  try {
    process.kill(-target, signal);
    return;
  } catch {
    process.kill(pid, signal);
  }
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The executable and argument vector a spec runs as.
 *
 * Shell specs become an explicit `bash -lc` invocation rather than a shell
 * string, so every caller — spawning directly, or wrapping the same launch in an
 * OS sandbox — starts from one definition of what actually executes.
 */
export function commandExecution(spec: CommandSpec): { execPath: string; execArgs: string[] } {
  if (spec.shell === false) {
    const [command, ...args] = spec.argv!;
    return { execPath: command!, execArgs: args };
  }
  return { execPath: DEFAULT_SHELL, execArgs: ["-lc", spec.command!] };
}

function spawnArgs(
  spec: CommandSpec,
  detached: boolean,
  stdio: ["ignore", "pipe" | number, "pipe" | number],
): ChildProcess {
  const env = { ...process.env, ...spec.env };
  const { execPath, execArgs } = commandExecution(spec);
  return spawn(execPath, execArgs, {
    cwd: spec.cwd,
    env,
    detached,
    stdio,
  });
}