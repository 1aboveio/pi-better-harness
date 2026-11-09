import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { THINKING_LEVELS, type ThinkingLevel } from "./thinking.ts";

export type CatalogPreference = Readonly<{ bundled?: true; model?: string | null; effort?: ThinkingLevel | null }>;
export type CatalogPreferences = Readonly<Record<string, CatalogPreference>>;
const ID = /^(role|agent)\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const MODEL = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._+-]*$/;

function object(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
    return value as Record<string, unknown>;
}

function preferences(id: string, value: unknown): CatalogPreference {
    if (typeof id !== "string" || !ID.test(id)) throw new Error(`Invalid catalog id ${JSON.stringify(id)}.`);
    const record = object(value, `Preferences for ${id}`);
    for (const [key, item] of Object.entries(record)) {
        if (key !== "bundled" && key !== "model" && key !== "effort") throw new Error(`Unknown preference ${key} for ${id}.`);
        if (key === "bundled" ? item !== true : item !== null && (typeof item !== "string" || (key === "model" ? !MODEL.test(item)
            : !(THINKING_LEVELS as readonly string[]).includes(item)))) {
            throw new Error(`Invalid ${key} preference for ${id}: ${JSON.stringify(item)}.`);
        }
    }
    return Object.freeze({
        ...(Object.hasOwn(record, "bundled") ? { bundled: true as const } : {}),
        ...(Object.hasOwn(record, "model") ? { model: record.model as string | null } : {}),
        ...(Object.hasOwn(record, "effort") ? { effort: record.effort as ThinkingLevel | null } : {}),
    });
}

function snapshot(values: CatalogPreferences): { settings: CatalogPreferences; digest: string } {
    const settings = Object.freeze(Object.fromEntries(Object.keys(values).sort().map(id => [id, values[id]])));
    return { settings, digest: createHash("sha256").update(JSON.stringify(settings)).digest("hex") };
}

function stat(path: string) {
    try { return lstatSync(path); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

function checkRoot(root: string): boolean {
    const info = stat(root);
    if (!info) return false;
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink catalog directory ${root}.`);
    if (!info.isDirectory()) throw new Error(`Catalog root ${root} must be a directory.`);
    return true;
}

function checkFile(path: string): boolean {
    const info = stat(path);
    if (!info) return false;
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink catalog settings file ${path}.`);
    if (!info.isFile()) throw new Error(`Catalog settings ${path} must be a regular file.`);
    return true;
}

export function readCatalogPreferences(root: string): { settings: CatalogPreferences; digest: string } {
    root = resolve(root);
    const path = join(root, "settings.json");
    try {
        if (!checkRoot(root) || !checkFile(path)) return snapshot({});
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        let data: Record<string, unknown>;
        try {
            if (!fstatSync(fd).isFile()) throw new Error("Settings must be a regular file.");
            data = object(JSON.parse(readFileSync(fd, "utf8")), "Catalog settings");
        } finally { closeSync(fd); }
        if (data.version !== 1 || !Object.hasOwn(data, "defaults") ||
            Object.keys(data).some(key => key !== "version" && key !== "defaults")) {
            throw new Error("Expected only version: 1 and defaults in catalog settings.");
        }
        const settings = Object.fromEntries(Object.entries(object(data.defaults, "Catalog defaults"))
            .map(([id, value]) => [id, preferences(id, value)]));
        return snapshot(settings);
    } catch (error) {
        throw new Error(`Cannot read catalog preferences at ${path}: ${(error as Error).message}`, { cause: error });
    }
}

function acquire(path: string): () => void {
    // Read-only catalog consumers (including the portable CLI) need no lock adapter.
    const lockfile = createRequire(import.meta.url)("proper-lockfile") as {
        lockSync(path: string, options: { realpath: boolean }): () => void;
    };
    for (let attempt = 0; attempt < 100; attempt++) {
        try { return lockfile.lockSync(path, { realpath: false }); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt === 99) throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
    }
    throw new Error(`Cannot lock catalog settings at ${path}.`);
}

/** Replace only this id's own preferences; null explicitly clears a definition value. */
export function writeCatalogPreferences(root: string, id: string, value: CatalogPreference | ((current: CatalogPreference) => CatalogPreference)): { path: string; settings: CatalogPreferences; digest: string } {
    // Validate literal input before touching disk; updater callbacks run under the lock.
    const selected = typeof value === "function" ? (preferences(id, {}), undefined) : preferences(id, value);
    root = resolve(root);
    const path = join(root, "settings.json");
    let release: (() => void) | undefined;
    let pending: string | undefined;
    try {
        if (!checkRoot(root)) {
            // Do not create the caller's user/project configuration directories.
            try { mkdirSync(root, { mode: 0o700 }); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
            checkRoot(root);
        }
        checkFile(path);
        release = acquire(path);
        const settings = { ...readCatalogPreferences(root).settings };
        const next = selected ?? preferences(id, (value as (current: CatalogPreference) => CatalogPreference)(settings[id] ?? Object.freeze({})));
        if (Object.keys(next).length) settings[id] = next;
        else delete settings[id];
        const result = snapshot(settings);
        pending = join(root, `.settings.json.${randomUUID()}.tmp`);
        const fd = openSync(pending, "wx", 0o600);
        try {
            writeFileSync(fd, `${JSON.stringify({ version: 1, defaults: result.settings }, null, 2)}\n`);
            fsyncSync(fd);
        } finally { closeSync(fd); }
        checkRoot(root);
        checkFile(path);
        renameSync(pending, path);
        return { path, ...result };
    } catch (error) {
        throw new Error(`Cannot save catalog preferences at ${path}: ${(error as Error).message}`, { cause: error });
    } finally {
        try { if (pending) rmSync(pending, { force: true }); }
        finally { release?.(); }
    }
}
