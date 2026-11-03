/**
 * Public entry point for detached local process/watch supervision.
 *
 * Integration surface for Background Tasks (owned by the parent):
 *
 * ```ts
 * import { createLocalSupervisor, defaultSupervisorDirectory } from "./supervisor/index.ts";
 *
 * const supervisor = createLocalSupervisor({ directory: defaultSupervisorDirectory() });
 * const started = await supervisor.start({ token, argv: admittedArgv, cwd, kind: "process" });
 * const current = supervisor.inspect(started.taskId);
 * const stopped = await supervisor.stop(started.taskId);
 * ```
 *
 * Scope: local processes and local command watches. No SSH, no coordinator store,
 * no dependency waits, no permission decisions — the caller supplies an
 * already-admitted command and remains the owner of its interpretation.
 */

export {
  createLocalSupervisor,
  defaultSupervisorDirectory,
  supervisorPaths,
  supervisorTaskIdForToken,
} from "./supervisor.ts";
export { supervisorRunnerEntry, supervisorRunnerInvocation } from "./invocation.ts";
export {
  DEFAULT_MAX_LOG_BYTES,
  DEFAULT_TERMINAL_TAIL_BYTES,
  DEFAULT_WATCH_INTERVAL_MS,
  DEFAULT_WATCH_TIMEOUT_MS,
  SUPERVISOR_RECORD_VERSION,
  SUPERVISOR_RUNNER_VERSION,
  SUPERVISOR_TASK_ID_PATTERN,
  SUPERVISOR_TASK_ID_PREFIX,
} from "./types.ts";
export type * from "./types.ts";
