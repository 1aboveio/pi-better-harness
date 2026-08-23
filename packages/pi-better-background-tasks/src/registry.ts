import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackgroundTaskMeta } from "./types.js";
import { isTerminalStatus } from "./types.js";

let seq = 0;
const metaCache = new Map<string, BackgroundTaskMeta>();
const metaChangedListeners = new Set<() => void>();

export function baseDir(): string {
  const vitestPoolId = process.env.VITEST_POOL_ID;
  const directory = vitestPoolId && /^\d+$/.test(vitestPoolId)
    ? `pi-better-background-tasks-vitest-${vitestPoolId}`
    : "pi-better-background-tasks";
  return join(tmpdir(), directory);
}

export function tasksDir(): string {
  return join(baseDir(), "tasks");
}

export function taskDir(id: string): string {
  return join(tasksDir(), id);
}

export function metaPathFor(id: string): string {
  return join(taskDir(id), "meta.json");
}

export function logPathFor(id: string): string {
  return join(taskDir(id), "output.log");
}

/**
 * Where a task keeps the generated sandbox profile it launched under.
 *
 * It lives beside the task's own log and metadata so it survives exactly as long
 * as the task does: a watch resumed in a later Pi session re-reads the profile it
 * started with instead of a profile some other session has since rewritten.
 */
export function sandboxProfilePathFor(id: string): string {
  return join(taskDir(id), "sandbox.sb");
}

export function nextTaskId(): string {
  seq += 1;
  return `bg_${process.pid.toString(36)}_${Date.now().toString(36)}_${seq}`;
}

export function ensureTaskDir(id: string): void {
  mkdirSync(taskDir(id), { recursive: true });
}

export function writeMeta(meta: BackgroundTaskMeta): void {
  ensureTaskDir(meta.id);
  writeFileSync(metaPathFor(meta.id), JSON.stringify(meta, null, 2));
  metaCache.set(meta.id, meta);
  for (const listener of metaChangedListeners) {
    try { listener(); } catch { /* best effort */ }
  }
}

export function onMetaChanged(listener: () => void): () => void {
  metaChangedListeners.add(listener);
  return () => metaChangedListeners.delete(listener);
}

export function readMeta(id: string): BackgroundTaskMeta | undefined {
  try {
    const meta = JSON.parse(readFileSync(metaPathFor(id), "utf8")) as BackgroundTaskMeta;
    metaCache.set(id, meta);
    return meta;
  } catch {
    metaCache.delete(id);
    return undefined;
  }
}

export function listMetas(): BackgroundTaskMeta[] {
  let ids: string[];
  try {
    ids = readdirSync(tasksDir());
  } catch {
    return [];
  }
  const liveIds = new Set(ids);
  for (const cachedId of metaCache.keys()) {
    if (!liveIds.has(cachedId)) metaCache.delete(cachedId);
  }
  return ids
    .map(readMetaForSweep)
    .filter((meta): meta is BackgroundTaskMeta => meta !== undefined)
    .sort((a, b) => b.startedAt - a.startedAt);
}

function readMetaForSweep(id: string): BackgroundTaskMeta | undefined {
  const cached = metaCache.get(id);
  if (cached && isTerminalStatus(cached.status)) return cached;
  return readMeta(id);
}
