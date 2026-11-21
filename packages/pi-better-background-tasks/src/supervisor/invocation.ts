/**
 * How the caller launches the detached runner executable.
 *
 * The entrypoint is the emitted JavaScript closure under `generated/`, not the
 * TypeScript source. Node refuses to strip types for a file under `node_modules`
 * (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so an installed package must
 * ship plain ESM. `emit-runner.mjs` produces that closure and a drift test keeps
 * it in step with the sources.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SupervisorRunnerInvocation {
  execPath: string;
  args: string[];
  /** Absolute path of the runner entrypoint. */
  entry: string;
}

export function supervisorRunnerEntry(runnerPath?: string): string {
  if (runnerPath !== undefined) return runnerPath;
  const entry = fileURLToPath(new URL("./generated/runner.mjs", import.meta.url));
  if (!existsSync(entry)) {
    throw new Error(
      `The emitted supervisor runner is missing at ${entry}. `
        + "Run `node src/supervisor/emit-runner.mjs` in packages/pi-better-background-tasks and ship src/supervisor/generated/.",
    );
  }
  return entry;
}

/** True only for a real Node.js executable, not an agent that embeds one. */
function isNodeExecutable(path: string): boolean {
  return /(^|[/\\])node(\.exe)?$/.test(path);
}

/** First real Node.js executable found on PATH, or undefined. */
function nodeOnPath(): string | undefined {
  const separator = process.platform === "win32" ? ";" : ":";
  const executable = process.platform === "win32" ? "node.exe" : "node";
  for (const directory of (process.env.PATH ?? "").split(separator)) {
    if (!directory) continue;
    const candidate = join(directory, executable);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // An unreadable PATH entry is skipped, not fatal.
    }
  }
  return undefined;
}

/**
 * Resolve the Node.js executable that runs detached helpers. A standalone pi
 * binary (pi >= 1.5) is not Node.js: spawning it with a helper script starts
 * another agent session instead, which never claims its launch token.
 */
export function supervisorNodeExecPath(nodePath?: string): string {
  if (nodePath !== undefined) return nodePath;
  const fromEnv = process.env.PI_BETTER_BACKGROUND_TASKS_NODE;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  if (isNodeExecutable(process.execPath)) return process.execPath;
  const resolved = nodeOnPath();
  if (resolved !== undefined) return resolved;
  throw new Error(
    `The background-task runner needs a real Node.js executable, but this process runs as ${process.execPath}, `
      + "which is not Node.js. Install Node.js on PATH or set PI_BETTER_BACKGROUND_TASKS_NODE.",
  );
}

export function supervisorRunnerInvocation(
  directory: string,
  taskId: string,
  options: { runnerPath?: string; nodePath?: string } = {},
): SupervisorRunnerInvocation {
  const entry = supervisorRunnerEntry(options.runnerPath);
  return {
    execPath: supervisorNodeExecPath(options.nodePath),
    args: [entry, directory, taskId],
    entry,
  };
}
