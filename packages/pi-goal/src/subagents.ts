import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BackgroundProviderSnapshot, BackgroundWorkItem } from "./types.js";

export type SubagentRunStatus = "running" | "completed" | "failed" | "killed" | "orphaned" | "lost";
export type SubagentEffectiveStatus = SubagentRunStatus | "exited";

export interface SubagentRunMeta {
  id: string;
  name?: string;
  status: SubagentRunStatus;
  pid: number;
  spawnPid: number;
  model?: string;
  cwd: string;
  promptPreview: string;
  startedAt: number;
  endedAt?: number;
  callback?: boolean;
  batchId?: string;
  batchName?: string;
}

export interface CollectSubagentActivityOptions {
  baseDir?: string;
  parentPid?: number;
  processExists?: (pid: number) => boolean;
}

export function defaultSubagentBaseDir(): string {
  return join(tmpdir(), "pi-better-subagents");
}

export function defaultProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export function effectiveSubagentStatus(
  meta: Pick<SubagentRunMeta, "status" | "pid">,
  processExists: (pid: number) => boolean = defaultProcessExists,
): SubagentEffectiveStatus {
  if (meta.status !== "running") {
    return meta.status;
  }
  return processExists(meta.pid) ? "running" : "exited";
}

export function isCurrentParentSubagent(
  meta: Pick<SubagentRunMeta, "spawnPid">,
  parentPid = process.pid,
): boolean {
  return meta.spawnPid === parentPid;
}

export function readSubagentMetas(baseDir = defaultSubagentBaseDir()): SubagentRunMeta[] {
  const runsDir = join(baseDir, "runs");
  if (!existsSync(runsDir)) {
    return [];
  }

  const metas: SubagentRunMeta[] = [];
  for (const id of readdirSync(runsDir)) {
    try {
      const raw = readFileSync(join(runsDir, id, "meta.json"), "utf8");
      const meta = JSON.parse(raw) as SubagentRunMeta;
      if (typeof meta.id === "string" && typeof meta.status === "string") {
        metas.push(meta);
      }
    } catch {
      // Ignore partially-written or stale run directories.
    }
  }

  return metas.sort((left, right) => right.startedAt - left.startedAt);
}

export function subagentStatusToItem(
  meta: SubagentRunMeta,
  status: SubagentEffectiveStatus,
): BackgroundWorkItem {
  const active = status === "running" || status === "orphaned";
  const unhealthy = status === "orphaned";
  const terminal = !active;
  const attention = status === "orphaned" || status === "failed" || status === "killed" || status === "lost" || status === "exited";

  const item: BackgroundWorkItem = {
    id: meta.id,
    status,
    active,
    unhealthy,
    terminal,
    attention,
    startedAt: meta.startedAt,
    details: {
      callback: meta.callback !== false,
      batchId: meta.batchId,
      batchName: meta.batchName,
      model: meta.model,
      cwd: meta.cwd,
      promptPreview: meta.promptPreview,
    },
  };
  if (meta.name !== undefined) {
    item.label = meta.name;
  }
  if (meta.endedAt !== undefined) {
    item.endedAt = meta.endedAt;
  }
  return item;
}

export function collectSubagentActivity(
  options: CollectSubagentActivityOptions = {},
): BackgroundProviderSnapshot {
  const parentPid = options.parentPid ?? process.pid;
  const processExists = options.processExists ?? defaultProcessExists;
  const metas = readSubagentMetas(options.baseDir).filter((meta) =>
    isCurrentParentSubagent(meta, parentPid),
  );

  return {
    providerId: "subagents",
    label: "Subagents",
    items: metas.map((meta) => subagentStatusToItem(meta, effectiveSubagentStatus(meta, processExists))),
  };
}