import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackgroundTaskCallbackOrigin, BackgroundTaskMeta } from "./types.js";
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
  indexMeta(meta);
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

export function removeMeta(meta: BackgroundTaskMeta): boolean {
  try {
    rmSync(taskDir(meta.id), { recursive: true, force: true });
    metaCache.delete(meta.id);
    try { unlinkSync(join(originIndexDir(originOf(meta)), meta.id)); } catch { /* stale index entries are harmless */ }
    for (const listener of metaChangedListeners) {
      try { listener(); } catch { /* best effort */ }
    }
    return true;
  } catch {
    return false;
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

export function listMetasForOrigin(origin: BackgroundTaskCallbackOrigin): BackgroundTaskMeta[] {
  const directory = originIndexDir(origin);
  ensureOriginIndex(origin, directory);
  let ids: string[];
  try {
    ids = readdirSync(directory).filter((id) => id !== ".initialized");
  } catch {
    return [];
  }
  return ids
    .map(readMetaForSweep)
    .filter((meta): meta is BackgroundTaskMeta => meta !== undefined && belongsToOrigin(meta, origin))
    .sort((a, b) => b.startedAt - a.startedAt);
}

function readMetaForSweep(id: string): BackgroundTaskMeta | undefined {
  const cached = metaCache.get(id);
  if (cached && isTerminalStatus(cached.status)) return cached;
  return readMeta(id);
}

function originOf(meta: BackgroundTaskMeta): BackgroundTaskCallbackOrigin {
  return meta.callbackOrigin ?? { cwd: meta.cwd };
}

function belongsToOrigin(meta: BackgroundTaskMeta, origin: BackgroundTaskCallbackOrigin): boolean {
  const candidate = originOf(meta);
  if (candidate.cwd !== origin.cwd) return false;
  if (candidate.sessionId || origin.sessionId) return candidate.sessionId === origin.sessionId;
  return true;
}

function originIndexDir(origin: BackgroundTaskCallbackOrigin): string {
  const key = createHash("sha256")
    .update(origin.cwd)
    .update("\0")
    .update(origin.sessionId ?? "")
    .digest("hex")
    .slice(0, 24);
  return join(baseDir(), "by-origin", key);
}

function indexMeta(meta: BackgroundTaskMeta): void {
  try {
    const directory = originIndexDir(originOf(meta));
    mkdirSync(directory, { recursive: true });
    writeIndexEntry(join(directory, meta.id));
  } catch {
    // Indexes are accelerators; meta.json remains authoritative.
  }
}

function ensureOriginIndex(origin: BackgroundTaskCallbackOrigin, directory: string): void {
  try {
    readFileSync(join(directory, ".initialized"));
    return;
  } catch {
    // Existing registries are backfilled once for each session origin.
  }
  const owned = listMetas().filter((meta) => belongsToOrigin(meta, origin));
  mkdirSync(directory, { recursive: true });
  for (const meta of owned) writeIndexEntry(join(directory, meta.id));
  writeFileSync(join(directory, ".initialized"), "1");
}

function writeIndexEntry(path: string): void {
  try {
    writeFileSync(path, "", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
