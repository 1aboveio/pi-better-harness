import { existsSync, lstatSync, realpathSync, readFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// Match Pi's settings lock without depending on a private SDK import.
const lockfile = createRequire(import.meta.url)("proper-lockfile") as {
  lockSync(path: string, options: { realpath: boolean }): () => void;
};
const NAMESPACE = "piBetterHarness";
export interface HarnessSettingsSeams { agentDir?: () => string }

export function harnessSettingsPath(seams: HarnessSettingsSeams = {}): string {
  return join((seams.agentDir ?? getAgentDir)(), "settings.json");
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
  return value as Record<string, unknown>;
}

function readSettings(path: string): Record<string, unknown> {
  try { return object(JSON.parse(readFileSync(path, "utf8")), `Settings at ${path}`); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function section(settings: Record<string, unknown>): Record<string, unknown> {
  return Object.hasOwn(settings, NAMESPACE) ? object(settings[NAMESPACE], NAMESPACE) : {};
}

function acquire(path: string): () => void {
  for (let attempt = 0; attempt < 10; attempt++) {
    try { return lockfile.lockSync(path, { realpath: false }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt === 9) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  throw new Error(`Cannot lock settings at ${path}`);
}

function lockedRead(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const release = acquire(path);
  try { return readSettings(path); } finally { release(); }
}

function writeDestination(path: string): string {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
    throw error;
  }
  // Keep managed dotfiles links intact. A dangling link fails rather than being replaced.
  return stat.isSymbolicLink() ? realpathSync(path) : path;
}

function mutate<T>(seams: HarnessSettingsSeams, change: (values: Record<string, unknown>) => T): T {
  const path = harnessSettingsPath(seams);
  mkdirSync((seams.agentDir ?? getAgentDir)(), { recursive: true });
  const release = acquire(path);
  let pending: string | undefined;
  try {
    // Read inside the lock so another session's settings are never replaced by a stale snapshot.
    const settings = readSettings(path);
    const values = section(settings);
    const result = change(values);
    settings[NAMESPACE] = values;
    const destination = writeDestination(path);
    pending = `${destination}.${randomUUID()}.tmp`;
    writeFileSync(pending, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(pending, destination);
    return result;
  } finally {
    try { if (pending) rmSync(pending, { force: true }); } finally { release(); }
  }
}

export function readHarnessSetting<T = unknown>(
  key: string,
  seams: HarnessSettingsSeams = {},
  legacy?: { path: string; parse: (value: unknown) => T },
): T | undefined {
  const values = section(lockedRead(harnessSettingsPath(seams)));
  if (Object.hasOwn(values, key)) return values[key] as T;
  if (!legacy) return undefined;
  let raw: string;
  try { raw = readFileSync(legacy.path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const migrated = legacy.parse(JSON.parse(raw));
  return mutate(seams, current => {
    if (!Object.hasOwn(current, key)) current[key] = migrated;
    return current[key] as T;
  });
}

export function updateHarnessSetting<T>(
  key: string, update: (current: unknown) => T, seams: HarnessSettingsSeams = {},
): T {
  return mutate(seams, values => {
    const next = update(values[key]);
    values[key] = next;
    return next;
  });
}
