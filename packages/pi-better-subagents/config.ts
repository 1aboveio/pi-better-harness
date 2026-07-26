/**
 * Extension config — a single `config.json` next to this file sets defaults for
 * every subagent, each overridable per `subagent_spawn` call.
 *
 *   { "defaultModel": "xai/grok-4.5", "defaultTools": "read, bash, web_fetch" }
 *
 * `defaultModel: null` / absent → inherit the foreground model.
 * `defaultTools` absent → the built-in SAFE_DEFAULT_TOOLS.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { SELF_SPEC } from "./extensions.ts";

export interface SubagentConfig {
    defaultModel?: string | null;
    defaultTools?: string | null;
    /** Max subagents allowed to run at once. */
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
}

/** Concurrency cap when config.json sets none. */
export const DEFAULT_MAX_CONCURRENT = 4;

/** Built-in default tool set when config.json sets nothing. */
export const SAFE_DEFAULT_TOOLS = "read, bash, edit, write, web_search, web_fetch";
/** Safe default for a hermetic (clean) child where extension tools don't exist. */
export const SAFE_CLEAN_TOOLS = "read, bash";

let cached: SubagentConfig | undefined;

/** Load config.json from the extension directory. Missing/invalid → {}. */
export function loadConfig(): SubagentConfig {
    if (cached) return cached;
    try {
        const dir = dirname(fileURLToPath(import.meta.url));
        cached = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8")) as SubagentConfig;
    } catch {
        cached = {};
    }
    return cached;
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
