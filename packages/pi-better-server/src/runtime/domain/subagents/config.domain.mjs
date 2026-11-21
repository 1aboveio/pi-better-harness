// Generated fixed launch domain from packages/pi-better-subagents/config.ts. Do not edit directly.
/**
 * User config overrides the shipped `config.json` defaults for every subagent,
 * each overridable per `subagent_spawn` call. Saves never edit installed files.
 *
 *   { "defaultModel": "xai/grok-4.5", "defaultTools": "read, bash, web_fetch" }
 *
 * `defaultModel: null` / absent → inherit the foreground model.
 * `defaultTools` absent → the built-in SAFE_DEFAULT_TOOLS.
 * `defaultSkills` absent → the child discovers the user-level skills catalog.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { toolPackage, supportsChildProvider } from "./shared-task-tools.domain.mjs";
import { SELF_SPEC } from "./extensions.domain.mjs";
import { installedPackage, packageRoot } from "./child-dependencies.mjs";
import { isDelegationMode } from "./delegation.domain.mjs";
import { normalizeSkillExposure } from "./skills.domain.mjs";
import { validatedTimingMinutes } from "./timing.domain.mjs";
import { harnessSettingsPath, readHarnessSetting, updateHarnessSetting } from "./shared-harness-settings.domain.mjs";
/** Concurrency cap when config.json sets none. */
export const DEFAULT_MAX_CONCURRENT = 6;
export function isConcurrencyCap(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
export function normalizeConcurrencyCap(value) {
    return isConcurrencyCap(value) ? value : DEFAULT_MAX_CONCURRENT;
}
/** Built-in default tool set when config.json sets nothing. */
export const SAFE_DEFAULT_TOOLS = "read, bash, edit, write, web_search, web_fetch, codemode";
/** Safe default for a hermetic (clean) child where extension tools don't exist. */
export const SAFE_CLEAN_TOOLS = "read, bash";
let cached;
let cachedIdentity;
let configOverrideForTests = false;
let configPathForTests;
let bundledConfigPathForTests;
/** Test seam. Pass undefined to reload config.json on the next loadConfig call. */
export function setConfigForTests(next) {
    cached = next;
    cachedIdentity = undefined;
    configOverrideForTests = next !== undefined;
}
/** Test seam. Isolate user config, optionally supplying a package fallback. */
export function setConfigPathForTests(path, bundledPath) {
    configPathForTests = path;
    bundledConfigPathForTests = bundledPath;
    setConfigForTests(undefined);
}
export function configPath() {
    return harnessSettingsPath(configSeams());
}
function configSeams() {
    return { agentDir: () => configPathForTests ? dirname(configPathForTests) : piAgentDir() };
}
function readConfig(path) {
    return parseConfig(JSON.parse(readFileSync(path, "utf-8")));
}
function parseConfig(parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Config must be a JSON object.");
    return parsed;
}
function savedConfig() {
    const user = readHarnessSetting("subagents", configSeams(), configPathForTests ? undefined : {
        path: join(piAgentDir(), "extensions", "pi-better-subagents-config.json"), parse: parseConfig,
    });
    return user === undefined ? {} : parseConfig(user);
}
function bundledConfigPath() {
    return bundledConfigPathForTests ?? (configPathForTests ? undefined : join(selfDir(), "config.json"));
}
function bundledConfig() {
    const path = bundledConfigPath();
    if (!path)
        return {};
    try {
        return readConfig(path);
    }
    catch {
        return {};
    }
}
function configIdentity() {
    const paths = [configPath(), bundledConfigPath(),
        configPathForTests ? undefined : join(piAgentDir(), "extensions", "pi-better-subagents-config.json")];
    return JSON.stringify(paths.map(path => {
        if (!path)
            return null;
        try {
            const stat = statSync(path, { bigint: true });
            return [path, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
        }
        catch (error) {
            return [path, error.code];
        }
    }));
}
/** Saved user choices take precedence; missing/invalid files contribute no keys. */
export function loadConfig() {
    if (configOverrideForTests)
        return cached;
    const identity = configIdentity();
    if (cached && cachedIdentity === identity)
        return cached;
    let user = {};
    try {
        user = savedConfig();
    }
    catch { /* retain package fallback */ }
    cached = { ...bundledConfig(), ...user };
    // Keep the pre-read identity: migration or a concurrent replacement must
    // trigger another read rather than label an older value with a newer stat.
    cachedIdentity = identity;
    return cached;
}
/** Save the navigator's mode-only default without replacing the saved cap. */
export function writeDelegationMode(mode, path = configPath()) {
    if (!isDelegationMode(mode))
        throw new Error(`Invalid delegation mode: ${String(mode)}`);
    writeConfigSettings({ delegationMode: mode }, path);
}
/** Save human-facing defaults together, preserving unrelated configuration. */
export function writeSubagentSettings(settings, path = configPath()) {
    if (!isDelegationMode(settings.delegationMode))
        throw new Error("Invalid delegation mode.");
    if (!isConcurrencyCap(settings.maxConcurrent))
        throw new Error("Concurrent subagents must be a positive whole number.");
    const next = {
        delegationMode: settings.delegationMode,
        maxConcurrent: settings.maxConcurrent,
    };
    if (settings.gitWorkspace !== undefined) {
        if (settings.gitWorkspace !== "clone" && settings.gitWorkspace !== "worktree")
            throw new Error("Unknown Git workspace mode.");
        next.gitWorkspace = settings.gitWorkspace;
    }
    if (settings.maxMinutes !== undefined) {
        next.maxMinutes = validatedTimingMinutes(settings.maxMinutes, "maxMinutes");
    }
    if (Object.hasOwn(settings, "defaultSkills")) {
        if (settings.defaultSkills === null) {
            next.defaultSkills = null;
        }
        else {
            const skills = normalizeSkillExposure(settings.defaultSkills, "defaultSkills");
            if (skills === undefined)
                throw new Error("defaultSkills must be an array of paths or null for discovery.");
            if (skills.some((entry) => !isAbsolute(entry))) {
                throw new Error("defaultSkills paths must be absolute so every child resolves the same files.");
            }
            next.defaultSkills = skills;
        }
    }
    if (settings.toolWaitMinutes !== undefined) {
        next.toolWaitMinutes = validatedTimingMinutes(settings.toolWaitMinutes, "toolWaitMinutes");
    }
    if (settings.stuckMinutes !== undefined) {
        next.stuckMinutes = validatedTimingMinutes(settings.stuckMinutes, "stuckMinutes");
    }
    writeConfigSettings(next, path);
}
function writeConfigSettings(settings, path) {
    if (path === configPath())
        savedConfig();
    updateHarnessSetting("subagents", previous => ({
        ...(previous === undefined ? {} : parseConfig(previous)), ...settings,
    }), { agentDir: () => dirname(path) });
    if (path === configPath())
        setConfigForTests(undefined);
}
/** Normalize a comma/space tool list to pi's bare comma form: "a, b" → "a,b". */
export function normalizeTools(list) {
    return list.split(",").map((t) => t.trim()).filter(Boolean).join(",");
}
export const ORDINARY_TOOL_PROVIDERS = {
    apply_patch: join(selfDir(), "child-apply-patch.ts"),
    process_list: join(selfDir(), "child-process-list.ts"),
};
/** Check the owning package even when a mapping points directly to one of its files. */
export function supportedChildEntrypoint(name, pkg, path) {
    return supportsChildProvider(name, pkg, packageRoot(path) ?? path);
}
/** Capture exact user-installed entrypoints already active in the foreground. */
export function activeChildProviders(pi) {
    const active = new Set(pi.getActiveTools?.() ?? []);
    const paths = new Map();
    const seen = new Set();
    for (const tool of pi.getAllTools?.() ?? []) {
        if (!active.has(tool.name))
            continue;
        // The SDK reports active names. Conflicting registrations have no unique owner.
        if (seen.has(tool.name)) {
            paths.delete(tool.name);
            continue;
        }
        seen.add(tool.name);
        if (tool.sourceInfo?.scope !== "user")
            continue;
        const owner = toolPackage(tool);
        if (!owner || !supportsChildProvider(tool.name, owner.package, owner.root))
            continue;
        try {
            const path = realpathSync(tool.sourceInfo.path);
            if (!statSync(path).isFile() || !supportedChildEntrypoint(tool.name, owner.package, path))
                continue;
            paths.set(tool.name, path);
        }
        catch { /* An unavailable entrypoint cannot supply a new worker. */ }
    }
    return Object.fromEntries(paths);
}
export function ordinaryChildConfig(config, activeProviders = {}) {
    const packaged = config.toolExtensions === null ? undefined : bundledConfig().toolExtensions;
    return { ...config, toolExtensions: { ...activeProviders, ...ORDINARY_TOOL_PROVIDERS, ...packaged, ...config.toolExtensions } };
}
export function addEditablePatch(names, excluded) {
    const editable = names.some(name => (name === "edit" || name === "write") && !excluded.has(name));
    if (editable && !excluded.has("apply_patch") && !names.includes("apply_patch"))
        names.push("apply_patch");
}
/** This package's own root — the extension dir, which is also `self`. */
export function selfDir() {
    return dirname(fileURLToPath(import.meta.url));
}
/** Where pi installs npm packages (honors PI_CODING_AGENT_DIR). */
function piAgentDir() {
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
export function resolveExtensionPath(spec, declaringRoot) {
    if (spec === SELF_SPEC)
        return selfDir();
    const path = spec.startsWith("npm:")
        ? (declaringRoot && installedPackage(spec.slice(4), [declaringRoot])) ?? (existsSync(join(piAgentDir(), "npm", "node_modules", spec.slice(4)))
            ? join(piAgentDir(), "npm", "node_modules", spec.slice(4))
            : installedPackage(spec.slice(4), [declaringRoot, join(piAgentDir(), "npm"), selfDir(),
                join(piAgentDir(), "npm", "node_modules", "pi-better-harness")]))
        : declaringRoot && !spec.startsWith("/") ? join(declaringRoot, spec) : spec;
    return path && existsSync(path) ? path : undefined;
}
