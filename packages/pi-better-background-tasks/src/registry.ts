import { taskDeadline } from "./shared-operation-coordinator/src/task-lifetime.ts";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
const metaChangedListeners = new Set<(meta?: BackgroundTaskMeta) => void>();
const registryIo = { fullDirectoryReads: 0, indexDirectoryReads: 0, metadataFileReads: 0, terminalMetadataFileReads: 0, indexRevisionChecks: 0 };

export interface RegistryIoMetrics {
  fullDirectoryReads: number;
  indexDirectoryReads: number;
  metadataFileReads: number;
  terminalMetadataFileReads: number;
  indexRevisionChecks: number;
}

export function getRegistryIoMetrics(): RegistryIoMetrics {
  return { ...registryIo };
}

export function resetRegistryIoMetrics(): void {
  registryIo.fullDirectoryReads = 0;
  registryIo.indexDirectoryReads = 0;
  registryIo.metadataFileReads = 0;
  registryIo.terminalMetadataFileReads = 0;
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
    try { listener(meta); } catch { /* best effort */ }
  }
}

export function onMetaChanged(listener: (meta?: BackgroundTaskMeta) => void): () => void {
  metaChangedListeners.add(listener);
  return () => metaChangedListeners.delete(listener);
}

export function readMeta(id: string): BackgroundTaskMeta | undefined {
  return inspectMeta(id).meta;
}

export interface MetaInspection {
  id: string;
  meta?: BackgroundTaskMeta;
  found: boolean;
  readable: boolean;
  error?: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Parsed JSON that lacks the identifying fields is corrupt, not a task. */
function metaShapeProblem(meta: unknown, id: string): string | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return "not an object";
  const value = meta as Partial<BackgroundTaskMeta>;
  if (value.id !== id) return `id ${JSON.stringify(value.id ?? null)} does not match ${JSON.stringify(id)}`;
  if (typeof value.status !== "string" || !value.status) return "missing status";
  if (typeof value.logPath !== "string" || !value.logPath) return "missing logPath";
  if (typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt)) return "missing startedAt";
  return undefined;
}

/**
 * Distinguish missing, unreadable, and healthy metadata. Callers must not treat
 * an unreadable file as proof that a task does not exist.
 */
export function inspectMeta(id: string): MetaInspection {
  const path = metaPathFor(id);
  try {
    registryIo.metadataFileReads += 1;
    const raw = readFileSync(path, "utf8");
    try {
      const meta = JSON.parse(raw) as BackgroundTaskMeta;
      if(isTerminalStatus(meta.status))registryIo.terminalMetadataFileReads++;
      const invalid = metaShapeProblem(meta, id);
      if (invalid) {
        metaCache.delete(id);
        return { id, found: true, readable: false, error: `invalid metadata: ${invalid}` };
      }
      if (meta.status === "running") meta.deadlineAt = taskDeadline(meta.startedAt, meta.deadlineAt);
      metaCache.set(id, meta);
      return { id, meta, found: true, readable: true };
    } catch (error) {
      metaCache.delete(id);
      return { id, found: true, readable: false, error: `invalid JSON: ${errorText(error)}` };
    }
  } catch (error) {
    metaCache.delete(id);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      try {
        statSync(taskDir(id));
        return { id, found: true, readable: false, error: "metadata file is missing" };
      } catch {
        return { id, found: false, readable: false };
      }
    }
    return { id, found: true, readable: false, error: errorText(error) };
  }
}

export interface TaskIndex {
  records: MetaInspection[];
  indexError?: string;
  page?: { total: number; before: number; contentRevision: string; failureRevision: string; unreadable: number; unknown: number };
}

/** List every task directory, including unreadable metadata. */
export function listTaskRecords(): TaskIndex {
  let ids: string[];
  try {
    registryIo.fullDirectoryReads += 1;
    ids = readdirSync(tasksDir());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { records: [] };
    return { records: [], indexError: errorText(error) };
  }
  return {
    records: ids.map((id) => inspectMeta(id)).sort((a, b) => {
      const aTime = a.meta?.startedAt ?? 0;
      const bTime = b.meta?.startedAt ?? 0;
      return bTime - aTime;
    }),
  };
}

export function removeMeta(meta: BackgroundTaskMeta): boolean {
  try {
    rmSync(taskDir(meta.id), { recursive: true, force: true });
    metaCache.delete(meta.id);
    removeIndexEntry(originIndexDir(originOf(meta)), meta.id);
    removeIndexEntry(originActiveIndexDir(originOf(meta)), meta.id);
    removeIndexEntry(recentPath(originOf(meta)), meta.id);
    for (const listener of metaChangedListeners) {
      try { listener(meta); } catch { /* best effort */ }
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

/** Durable pending callbacks are independent of the Navigator's terminal retention. */
export function listPendingCallbackMetasForOrigin(origin: BackgroundTaskCallbackOrigin): BackgroundTaskMeta[] {
  const directory=join(baseDir(),'by-origin-callback',originKey(origin));
  if(!initializedIndexes.has(directory)){
    try {readFileSync(join(directory,'.initialized'));}
    catch {for(const meta of listMetasForOrigin(origin))if(pendingCallback(meta))writeIndexEntry(directory,meta.id);mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'.initialized'),'1');}
    initializedIndexes.add(directory);
  }
  return readIndexIds(directory).map(readOwnedMeta).filter((meta):meta is BackgroundTaskMeta=>!!meta&&belongsToOrigin(meta,origin)&&pendingCallback(meta));
}
function pendingCallback(meta:BackgroundTaskMeta):boolean {return isTerminalStatus(meta.status)&&meta.status!=='cancelled'&&meta.callback!==false&&!meta.callbackSentAt&&!meta.callbackSuppressedAt;}

export function listActiveMetasForOrigin(origin: BackgroundTaskCallbackOrigin): BackgroundTaskMeta[] {
  const directory = originActiveIndexDir(origin);
  ensureOriginActiveIndex(origin, directory);
  return readIndexIds(directory)
    .map(readOwnedMeta)
    .filter((meta): meta is BackgroundTaskMeta => meta !== undefined && meta.status === "running" && belongsToOrigin(meta, origin))
    .sort((a, b) => b.startedAt - a.startedAt);
}

/** Passive shared-runtime query: no backfill, cache repair, or completed-history scan. */
export function observeMetasForOrigin(origin: BackgroundTaskCallbackOrigin, activeOnly = true): BackgroundTaskMeta[] {
  const directory = activeOnly ? originActiveIndexDir(origin) : originIndexDir(origin);
  let ids: string[];
  registryIo.indexDirectoryReads++;
  try { ids = readdirSync(directory).filter(id => id !== ".initialized"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return ids.map(id => {
    const record = inspectMeta(id);
    if (record.found && !record.meta) throw new Error(`Unverified background task ${id}: ${record.error}`);
    return record.meta;
  }).filter((meta): meta is BackgroundTaskMeta => !!meta && !!meta.callbackOrigin && belongsToOrigin(meta, origin)
    && (!activeOnly || meta.status === "running")).sort((a, b) => b.startedAt - a.startedAt);
}

const RECENT_LIMIT = 256;
const RECENT_MS = 30000;
function recentPath(origin: BackgroundTaskCallbackOrigin): string {
  return join(baseDir(), "by-origin-recent", originKey(origin));
}
function recentEntries(origin: BackgroundTaskCallbackOrigin): Array<{ id: string; observedAt: number }> {
  const directory = recentPath(origin);
  try {
    registryIo.indexDirectoryReads++;
    const entries = readdirSync(directory).filter(id => !id.startsWith(".")).flatMap(id => {
      try { registryIo.indexRevisionChecks++; return [{ id, observedAt: statSync(join(directory, id)).mtimeMs }]; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    }).sort((a, b) => b.observedAt - a.observedAt || b.id.localeCompare(a.id));
    return entries.filter(entry => Date.now() - entry.observedAt < RECENT_MS).slice(0, RECENT_LIMIT);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

export function recentMetaDeadline(origin: BackgroundTaskCallbackOrigin): number[] {
  return recentEntries(origin).map(entry => entry.observedAt + RECENT_MS);
}

/** Exact cooperative source identity; no metadata or historical enumeration. */
export function observationRevisionForOrigin(origin: BackgroundTaskCallbackOrigin): string {
  return [originActiveIndexDir(origin), recentPath(origin)].map(indexDirectorySignature).join(";");
}

/** Bounded cooperative writes, including results written before the first reader. */
export function observeRecentMetasForOrigin(origin: BackgroundTaskCallbackOrigin): BackgroundTaskMeta[] {
  return recentEntries(origin).map(entry => {
    const record = inspectMeta(entry.id);
    if (record.found && !record.meta) throw new Error(`Unverified background task ${entry.id}: ${record.error}`);
    return record.meta;
  }).filter((meta): meta is BackgroundTaskMeta =>
    !!meta && belongsToOrigin(meta, origin) && meta.dismissedAt === undefined);
}

function readMetaForSweep(id: string): BackgroundTaskMeta | undefined {
  const cached = metaCache.get(id);
  if (cached && isTerminalStatus(cached.status)) return cached;
  return readMeta(id);
}

function readOwnedMeta(id: string): BackgroundTaskMeta | undefined {
  return metaCache.get(id) ?? readMeta(id);
}

export function originOf(meta: BackgroundTaskMeta): BackgroundTaskCallbackOrigin {
  return meta.callbackOrigin ?? { cwd: meta.cwd };
}

export function belongsToOrigin(meta: BackgroundTaskMeta, origin: BackgroundTaskCallbackOrigin): boolean {
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
    const callbackDirectory=join(baseDir(),'by-origin-callback',originKey(originOf(meta)));
    if(pendingCallback(meta))writeIndexEntry(callbackDirectory,meta.id);else removeIndexEntry(callbackDirectory,meta.id);
    const activeDirectory = originActiveIndexDir(originOf(meta));
    if (meta.status === "running") writeIndexEntry(activeDirectory, meta.id);
    else removeIndexEntry(activeDirectory, meta.id);
    const origin = originOf(meta), recentDirectory = recentPath(origin);
    mkdirSync(recentDirectory, { recursive: true });
    // Independent pointers preserve concurrent writers; prune only this bounded
    // recent-write accelerator, never the authoritative metadata or history.
    const candidates = readdirSync(recentDirectory).filter(id => !id.startsWith("."));
    const retained = new Set(recentEntries(origin).filter(entry => entry.id !== meta.id).slice(0, RECENT_LIMIT - 1).map(entry => entry.id));
    for (const id of candidates) if (id !== meta.id && !retained.has(id)) removeIndexEntry(recentDirectory, id);
    const temporary = join(recentDirectory, `.${meta.id}.${process.pid}.next`);
    writeFileSync(temporary, "");
    renameSync(temporary, join(recentDirectory, meta.id));
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
