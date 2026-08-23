import { spawn } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { CommandResult, CommandSpec } from "./types.js";

const DEFAULT_SHELL = process.env.PI_BETTER_BACKGROUND_TASKS_SHELL || "/bin/bash";

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

export function runCommandOnce(
  spec: CommandSpec,
  maxBufferBytes = 1024 * 1024,
  timeoutMs?: number,
): Promise<CommandResult> {
  validateCommandSpec(spec);
  const startedAt = Date.now();
  const child = spawnArgs(spec, false, ["ignore", "pipe", "pipe"]);
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
    const timeout = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, Math.max(1, timeoutMs));
    timeout?.unref();
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      if (timeout) clearTimeout(timeout);
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

export function stopProcessGroup(pid: number, pgid?: number): void {
  const target = pgid ?? pid;
  try {
    process.kill(-target, "SIGTERM");
    return;
  } catch {
    process.kill(pid, "SIGTERM");
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