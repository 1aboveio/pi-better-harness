import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackgroundTaskCallbackOrigin, BackgroundTaskMeta } from "./types.js";
import { isTerminalStatus } from "./types.js";

let seq = 0;
const metaCache = new Map<string, BackgroundTaskMeta>();
// Owned snapshots are process-resident. A cheap directory signature catches
// cross-process index changes before any cached IDs are reused.
const indexIdsCache = new Map<string, { ids: Set<string>; signature: string }>();
const initializedIndexes = new Set<string>();
const metaChangedListeners = new Set<() => void>();
const registryIo = { fullDirectoryReads: 0, indexDirectoryReads: 0, metadataFileReads: 0, indexRevisionChecks: 0 };

export interface RegistryIoMetrics {
  fullDirectoryReads: number;
  indexDirectoryReads: number;
  metadataFileReads: number;
  indexRevisionChecks: number;
}

export function getRegistryIoMetrics(): RegistryIoMetrics {
  return { ...registryIo };
}

export function resetRegistryIoMetrics(): void {
  registryIo.fullDirectoryReads = 0;
  registryIo.indexDirectoryReads = 0;
  registryIo.metadataFileReads = 0;
  registryIo.indexRevisionChecks = 0;
}

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
    registryIo.metadataFileReads += 1;
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
    removeIndexEntry(originIndexDir(originOf(meta)), meta.id);
    removeIndexEntry(originActiveIndexDir(originOf(meta)), meta.id);
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
    registryIo.fullDirectoryReads += 1;
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
  return readIndexIds(directory)
    .map(readOwnedMeta)
    .filter((meta): meta is BackgroundTaskMeta => meta !== undefined && belongsToOrigin(meta, origin))
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function listActiveMetasForOrigin(origin: BackgroundTaskCallbackOrigin): BackgroundTaskMeta[] {
  const directory = originActiveIndexDir(origin);
  ensureOriginActiveIndex(origin, directory);
  return readIndexIds(directory)
    .map(readOwnedMeta)
    .filter((meta): meta is BackgroundTaskMeta => meta !== undefined && meta.status === "running" && belongsToOrigin(meta, origin))
    .sort((a, b) => b.startedAt - a.startedAt);
}

function readMetaForSweep(id: string): BackgroundTaskMeta | undefined {
  const cached = metaCache.get(id);
  if (cached && isTerminalStatus(cached.status)) return cached;
  return readMeta(id);
}

function readOwnedMeta(id: string): BackgroundTaskMeta | undefined {
  return metaCache.get(id) ?? readMeta(id);
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
  return join(baseDir(), "by-origin", originKey(origin));
}

function originActiveIndexDir(origin: BackgroundTaskCallbackOrigin): string {
  return join(baseDir(), "by-origin-active", originKey(origin));
}

function originKey(origin: BackgroundTaskCallbackOrigin): string {
  return createHash("sha256")
    .update(origin.cwd)
    .update("\0")
    .update(origin.sessionId ?? "")
    .digest("hex")
    .slice(0, 24);
}

function indexMeta(meta: BackgroundTaskMeta): void {
  try {
    const directory = originIndexDir(originOf(meta));
    writeIndexEntry(directory, meta.id);
    const activeDirectory = originActiveIndexDir(originOf(meta));
    if (meta.status === "running") writeIndexEntry(activeDirectory, meta.id);
    else removeIndexEntry(activeDirectory, meta.id);
  } catch {
    // Indexes are accelerators; meta.json remains authoritative.
  }
}

function ensureOriginIndex(origin: BackgroundTaskCallbackOrigin, directory: string): void {
  if (initializedIndexes.has(directory)) return;
  try {
    readFileSync(join(directory, ".initialized"));
    initializedIndexes.add(directory);
    return;
  } catch {
    // Existing registries are backfilled once for each session origin.
  }
  indexIdsCache.delete(directory);
  const owned = listMetas().filter((meta) => belongsToOrigin(meta, origin));
  mkdirSync(directory, { recursive: true });
  for (const meta of owned) writeIndexEntry(directory, meta.id);
  writeFileSync(join(directory, ".initialized"), "1");
  initializedIndexes.add(directory);
}

function ensureOriginActiveIndex(origin: BackgroundTaskCallbackOrigin, directory: string): void {
  if (initializedIndexes.has(directory)) return;
  try {
    readFileSync(join(directory, ".initialized"));
    initializedIndexes.add(directory);
    return;
  } catch {
    // Existing registries are backfilled once for this origin's active set.
  }
  indexIdsCache.delete(directory);
  const owned = listMetasForOrigin(origin).filter((meta) => meta.status === "running");
  mkdirSync(directory, { recursive: true });
  for (const meta of owned) writeIndexEntry(directory, meta.id);
  writeFileSync(join(directory, ".initialized"), "1");
  initializedIndexes.add(directory);
}

function readIndexIds(directory: string): string[] {
  const signature = indexDirectorySignature(directory);
  const cached = indexIdsCache.get(directory);
  if (cached && cached.signature === signature) return [...cached.ids];
  try {
    registryIo.indexDirectoryReads += 1;
    const ids = new Set(readdirSync(directory).filter((id) => id !== ".initialized"));
    indexIdsCache.set(directory, { ids, signature: indexDirectorySignature(directory) });
    return [...ids];
  } catch {
    indexIdsCache.delete(directory);
    return [];
  }
}

function writeIndexEntry(directory: string, id: string): void {
  mkdirSync(directory, { recursive: true });
  const cached = indexIdsCache.get(directory);
  const cacheWasCurrent = cached ? cached.signature === indexDirectorySignature(directory) : false;
  try {
    writeFileSync(join(directory, id), "", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (cached && cacheWasCurrent) {
    cached.ids.add(id);
    cached.signature = indexDirectorySignature(directory);
  } else if (cached) {
    indexIdsCache.delete(directory);
  }
}

function removeIndexEntry(directory: string, id: string): void {
  const cached = indexIdsCache.get(directory);
  const cacheWasCurrent = cached ? cached.signature === indexDirectorySignature(directory) : false;
  try { unlinkSync(join(directory, id)); } catch { /* stale index entries are harmless */ }
  if (cached && cacheWasCurrent) {
    cached.ids.delete(id);
    cached.signature = indexDirectorySignature(directory);
  } else if (cached) {
    indexIdsCache.delete(directory);
  }
}

function indexDirectorySignature(directory: string): string {
  registryIo.indexRevisionChecks += 1;
  try {
    const stat = statSync(directory);
    return `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return "missing";
  }
}
