import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readTaskIntent } from "./failures.js";
import { validateCommandSpec } from "./process.js";
import { resolveSshCommand } from "./shared-ssh-core/index.js";
import { spawnTask, type ActiveSessionProvider, type SpawnTaskParams, type TaskRuntimeDependencies } from "./runtime.js";
import type { BackgroundTaskCallbackOrigin } from "./types.js";

export interface SpawnBatchParams {
  batchName?: string;
  jobs: SpawnTaskParams[];
  shared?: Omit<SpawnTaskParams, "name" | "command" | "argv" | "batchId" | "batchName">;
}

export interface SpawnBatchResult {
  batchId: string;
  batchName?: string;
  launched: Array<{ job: number; id: string; name?: string }>;
  failed: Array<{ job: number; name?: string; error: string }>;
}

/** Undefined inherits; false, zero, and explicit-null intent declarations override. */
function mergeJob(shared: SpawnBatchParams["shared"], job: SpawnTaskParams): SpawnTaskParams {
  return { ...shared, ...Object.fromEntries(Object.entries(job).filter(([, value]) => value !== undefined)) };
}

export function spawnTaskBatch(
  pi: ExtensionAPI,
  params: SpawnBatchParams,
  defaultCwd: string,
  callbackOrigin?: BackgroundTaskCallbackOrigin,
  getActiveSession?: ActiveSessionProvider,
  dependencies: TaskRuntimeDependencies = {},
): SpawnBatchResult {
  if (!Array.isArray(params.jobs) || params.jobs.length < 1 || params.jobs.length > 100) {
    throw new Error("jobs must contain between 1 and 100 background tasks.");
  }
  for (const field of ["name", "command", "argv", "batchId", "batchName"]) {
    if (params.shared && Object.hasOwn(params.shared, field)) {
      throw new Error(`Invalid batch shared field ${field}: each job must supply its own command, argv, and name; batch identity is assigned by the launcher.`);
    }
  }
  // Preflight the whole batch before any process, task directory, or SSH connection exists.
  const jobs = params.jobs.map((job, index) => {
    try {
      if (!job || typeof job !== "object" || Array.isArray(job)) throw new Error("job must be an object");
      const merged = mergeJob(params.shared, job);
      readTaskIntent(merged);
      validateLaunchStrings({
        command: merged.command,
        argv: merged.argv,
        cwd: merged.cwd ?? defaultCwd,
        env: merged.env,
        ssh: merged.ssh,
        remote: merged.remote,
      });
      if (merged.ssh) {
        resolveSshCommand({ command: merged.command, cwd: merged.cwd ?? defaultCwd, env: merged.env, ssh: merged.ssh });
      } else {
        validateCommandSpec(merged);
      }
      return merged;
    } catch (error) {
      throw new Error(`Invalid batch job ${index + 1}: ${errorMessage(error)}`);
    }
  });
  const result: SpawnBatchResult = {
    batchId: `bg_batch_${randomUUID()}`,
    ...(params.batchName !== undefined ? { batchName: params.batchName } : {}),
    launched: [],
    failed: [],
  };
  for (const [index, job] of jobs.entries()) {
    try {
      const meta = spawnTask(pi, { ...job, batchId: result.batchId, batchName: result.batchName }, defaultCwd, callbackOrigin, getActiveSession, dependencies);
      result.launched.push({ job: index + 1, id: meta.id, ...(meta.name !== undefined ? { name: meta.name } : {}) });
    } catch (error) {
      result.failed.push({ job: index + 1, ...(job.name !== undefined ? { name: job.name } : {}), error: errorMessage(error) });
    }
  }
  return result;
}

export function formatBatchLaunch(result: SpawnBatchResult): string {
  const label = result.batchName ? `${result.batchName} (${result.batchId})` : result.batchId;
  return [
    `Batch ${label}: ${result.launched.length} launched, ${result.failed.length} failed to launch.`,
    ...result.launched.map((job) => `Job ${job.job}${job.name ? ` (${job.name})` : ""}: ${job.id}`),
    ...result.failed.map((job) => `Job ${job.job}${job.name ? ` (${job.name})` : ""}: failed to launch: ${job.error}`),
    "Inspect, log, or stop each task by its id. Do not wait or poll in the foreground.",
  ].join("\n");
}

// Node rejects NULs synchronously, even when the rest of the command spec is valid.
function validateLaunchStrings(value: unknown, path = "launch"): void {
  if (typeof value === "string") {
    if (value.includes("\0")) throw new Error(`${path} must not contain NUL bytes`);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key.includes("\0")) throw new Error(`${path} keys must not contain NUL bytes`);
      validateLaunchStrings(child, `${path}.${key}`);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
