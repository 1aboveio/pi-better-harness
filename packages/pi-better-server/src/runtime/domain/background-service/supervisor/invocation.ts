/**
 * How the caller launches the detached runner executable.
 *
 * The entrypoint is the emitted JavaScript closure under `generated/`, not the
 * TypeScript source. Node refuses to strip types for a file under `node_modules`
 * (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so an installed package must
 * ship plain ESM. `emit-runner.mjs` produces that closure and a drift test keeps
 * it in step with the sources.
 */

import { existsSync } from "node:fs";
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

export function supervisorRunnerInvocation(
  directory: string,
  taskId: string,
  options: { runnerPath?: string; nodePath?: string } = {},
): SupervisorRunnerInvocation {
  const entry = supervisorRunnerEntry(options.runnerPath);
  return {
    execPath: options.nodePath ?? process.execPath,
    args: [entry, directory, taskId],
    entry,
  };
}
