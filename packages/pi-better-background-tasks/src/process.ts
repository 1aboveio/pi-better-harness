import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { CommandResult, CommandSpec } from "./types.js";

/** Known Git for Windows locations; `bash -lc` needs a real bash, not the WSL shim. */
const WINDOWS_BASH_CANDIDATES = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
];

/**
 * Resolve the shell used for `command` specs.
 *
 * POSIX keeps `/bin/bash`. Windows has no `/bin/bash`, and the `bash.exe` found
 * on PATH is usually the WSL launcher in System32 or the WindowsApps alias,
 * either of which would run the command inside WSL instead of Windows. Prefer
 * an explicit override, then Git for Windows, then a non-WSL `bash.exe` on PATH.
 *
 * Resolved lazily at spawn time, not module load: env-injection extensions
 * (e.g. pi-env) may apply settings.json `env` values after this module is
 * evaluated, and those overrides must still take effect.
 */
function resolveDefaultShell(): string {
  const fromEnv = process.env.PI_BETTER_BACKGROUND_TASKS_SHELL;
  if (fromEnv) return fromEnv;
  if (process.platform !== "win32") return "/bin/bash";
  for (const candidate of WINDOWS_BASH_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  for (const dir of (process.env.PATH ?? "").split(";")) {
    const trimmed = dir.trim();
    if (!trimmed || /system32|windowsapps/i.test(trimmed)) continue;
    const candidate = join(trimmed, "bash.exe");
    if (existsSync(candidate)) return candidate;
  }
  // Nothing usable found: keep the POSIX default so the failure surfaces as a
  // logged spawn error for the task instead of crashing the whole host process.
  return "/bin/bash";
}

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
  const marker = `\n--- spawn ${new Date().toISOString()} pid=${child.pid ?? "unknown"} ---\n`;
  writeSync(fd, marker);
  closeSync(fd);
  // Spawn failures (ENOENT, bad cwd, permission denied) surface as an 'error'
  // event. With no listener Node turns it into an uncaughtException that takes
  // down the whole host process; log it here and let the runtime's 'close'
  // handler finalize the task as failed.
  child.on("error", (error) => {
    try {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown";
      appendFileSync(logPath, `\n--- spawn error ${new Date().toISOString()} code=${code} message=${error.message} ---\n`);
    } catch {
      // Log unavailable; the runtime close handler still records the failure.
    }
  });
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
  return { execPath: resolveDefaultShell(), execArgs: ["-lc", spec.command!] };
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
