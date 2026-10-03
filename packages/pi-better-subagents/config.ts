/**
 * Extension config — a single `config.json` next to this file sets defaults for
 * every subagent, each overridable per `subagent_spawn` call.
 *
 *   { "defaultModel": "xai/grok-4.5", "defaultTools": "read, bash, web_fetch" }
 *
 * `defaultModel: null` / absent → inherit the foreground model.
 * `defaultTools` absent → the built-in SAFE_DEFAULT_TOOLS.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { SELF_SPEC } from "./extensions.ts";
import { isDelegationMode, type DelegationMode } from "./delegation.ts";
import type { TimingSettings } from "./timing.ts";

export interface SubagentConfig extends TimingSettings {
    /** Foreground delegation policy; /subagents mode overrides this for the current session. */
    delegationMode?: DelegationMode | null;
    defaultModel?: string | null;
    defaultTools?: string | null;
    /** Default concurrency cap; /subagents cap overrides it for the current session. */
    maxConcurrent?: number | null;
    /**
     * Tool name → extension package(s) that provide it. Drives which extension
     * CODE loads in a child: only packages backing a requested tool are loaded.
     * Builtins (read/bash/edit/write) need no entry.
     */
    toolExtensions?: Record<string, string | string[]> | null;
    /**
     * Provider → extension package(s) that authenticate it. Model auth is not
     * tool-shaped: `xai/grok-4.5` needs pi-xai-oauth loaded whatever the tools.
     */
    providerExtensions?: Record<string, string | string[]> | null;
    /**
     * OPERATOR-ONLY escape hatch: load every globally-installed extension in
     * children (pre-#17 behavior). Never model-selectable. Re-exposes the
     * mid-turn exit-0 drain if any installed package breaks process lifetime.
     */
    inheritExtensions?: boolean | null;
    /**
     * Optional health-observation thresholds (issue #66). Milliseconds.
     * Override the defaults used by `resolveHealthThresholds` /
     * `loadHealthThresholdsFromConfig` without expanding the spawn tool API.
     */
    healthQuietMs?: number | null;
    healthStaleMs?: number | null;
    healthLongToolMs?: number | null;
    healthLongCompactionMs?: number | null;
    /** Retention for terminal run directories during once-daily cleanup. Default: 7 days. */
    cleanupTerminalRunRetentionMs?: number | null;
    /** Retention for child pi session files during once-daily cleanup. Default: 7 days. */
    cleanupSessionRetentionMs?: number | null;
    /**
     * Total registry byte budget. Enforced between daily sweeps, oldest terminal
     * run first — age alone cannot bound a directory that can grow by gigabytes
     * in an afternoon. Default: 2 GiB. See cleanup.ts.
     */
    maxRegistryBytes?: number | null;
    /**
     * Catalog tier membership and ordered fallback candidates. Omitted tiers
     * keep the built-in membership. Candidate lists stay empty until set here;
     * names are not inferred substitutes. Cross-provider candidates need
     * `{ model, crossProvider: true }` and must also be tier members.
     */
    tierPolicy?: Readonly<Record<string, {
        members?: readonly string[];
        candidates?: readonly (string | { model: string; crossProvider?: boolean })[];
    }>> | null;
}

/** Concurrency cap when config.json sets none. */
export const DEFAULT_MAX_CONCURRENT = 4;

export function isConcurrencyCap(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function normalizeConcurrencyCap(value: unknown): number {
    return isConcurrencyCap(value) ? value : DEFAULT_MAX_CONCURRENT;
}

/** Built-in default tool set when config.json sets nothing. */
export const SAFE_DEFAULT_TOOLS = "read, bash, edit, write, web_search, web_fetch";
/** Safe default for a hermetic (clean) child where extension tools don't exist. */
export const SAFE_CLEAN_TOOLS = "read, bash";

let cached: SubagentConfig | undefined;
let configPathForTests: string | undefined;

/** Test seam. Pass undefined to reload config.json on the next loadConfig call. */
export function setConfigForTests(next: SubagentConfig | undefined): void {
    cached = next;
}

/** Test seam. Save and load use this file instead of the package config.json. */
export function setConfigPathForTests(path: string | undefined): void {
    configPathForTests = path;
    cached = undefined;
}

export function configPath(): string {
    return configPathForTests ?? join(dirname(fileURLToPath(import.meta.url)), "config.json");
}

/** Load config.json from the extension directory. Missing/invalid → {}. */
export function loadConfig(): SubagentConfig {
    if (cached) return cached;
    try {
        cached = JSON.parse(readFileSync(configPath(), "utf-8")) as SubagentConfig;
    } catch {
        cached = {};
    }
    return cached;
}

/** Write delegationMode into config.json, preserving every other key. */
export function writeDelegationMode(mode: DelegationMode, path = configPath()): void {
    if (!isDelegationMode(mode)) throw new Error(`Invalid delegation mode: ${String(mode)}`);
    let current: SubagentConfig = {};
    try {
        const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as SubagentConfig;
    } catch { /* missing file starts as an empty config */ }
    current.delegationMode = mode;
    const pending = `${path}.${process.pid}.tmp`;
    writeFileSync(pending, `${JSON.stringify(current, null, 2)}\n`);
    renameSync(pending, path);
    if (path === configPath()) cached = current;
}

/** Save human-facing defaults together, preserving unrelated configuration. */
export function writeSubagentSettings(settings: { delegationMode: DelegationMode; maxConcurrent: number }, path = configPath()): void {
    if (!isDelegationMode(settings.delegationMode)) throw new Error("Invalid delegation mode.");
    if (!isConcurrencyCap(settings.maxConcurrent)) throw new Error("Concurrent subagents must be a positive whole number.");
    let current: Record<string, unknown> = {};
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Config must be a JSON object.");
        current = parsed as Record<string, unknown>;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    Object.assign(current, settings);
    const pending = `${path}.${process.pid}.tmp`;
    writeFileSync(pending, `${JSON.stringify(current, null, 2)}\n`);
    renameSync(pending, path);
    if (path === configPath()) cached = current as SubagentConfig;
}

/** Normalize a comma/space tool list to pi's bare comma form: "a, b" → "a,b". */
export function normalizeTools(list: string): string {
    return list.split(",").map((t) => t.trim()).filter(Boolean).join(",");
}

/** This package's own root — the extension dir, which is also `self`. */
export function selfDir(): string {
    return dirname(fileURLToPath(import.meta.url));
}

/** Where pi installs npm packages (honors PI_CODING_AGENT_DIR). */
function piAgentDir(): string {
    return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/**
 * Materialize an extension spec to an on-disk path pi's `-e` accepts.
 *
 *   "self"                 → this package's dir
 *   "npm:<pkg>"            → <agentDir>/npm/node_modules/<pkg>
 *   "/abs/path"            → as-is
 *
 * Returns undefined when the package is not installed, so the caller can report
 * a missing dependency instead of silently launching a child without it.
 * (`-e` accepts either a package directory or an entrypoint file — verified.)
 */
export function resolveExtensionPath(spec: string): string | undefined {
    if (spec === SELF_SPEC) return selfDir();
    const path = spec.startsWith("npm:")
        ? join(piAgentDir(), "npm", "node_modules", spec.slice(4))
        : spec;
    return existsSync(path) ? path : undefined;
}
