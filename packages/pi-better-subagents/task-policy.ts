/** Immutable launch contract. This file contains policy, never credentials. */
import { realpathSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import { canonicalizePath, compileWritePolicy, describeSandboxSupport, type SandboxPermissions } from "./shared-sandbox-core.ts";
import { createTaskScratch, ensureHarnessRuntimeDirectories, runtimeCodeRoot, writableRuntimeAlias } from "./shared-task-sandbox.ts";
import { isCommandTimeoutSeconds, type CommandSettings } from "./permission-policy.ts";

/**
 * Guarded builtin for a shell-free task: `{ executable, args, timeout? }` runs one
 * already-installed program directly, with no shell interpretation. Its executor
 * is the shared task sandbox (packages/task-sandbox).
 */
export const RUN_APPLICATION = "run_application";

/**
 * Built-in tool names the SDK itself provides. `--tools` and extension resolution
 * take only these; run_application and process_list are task builtins the guard
 * installs and activates itself.
 */
export const SDK_BUILTIN_TOOLS = Object.freeze(["read", "write", "edit", "bash"] as const);

export type DirectApplicationLoadout = Readonly<{
    tools: readonly string[];
    /** A requested bash was replaced by the direct-application capability. */
    substituted: boolean;
    /** bash was dropped without substitution because the caller excluded run_application. */
    excluded: boolean;
}>;

/**
 * Direct-only loadouts: when the Subagents shell switch is Off, a requested bash
 * cannot run, so the parent offers the guarded run_application builtin instead.
 *
 * This is a substitution, never a restoration: a caller that excluded bash or
 * run_application keeps that exclusion (an excluded bash is simply dropped, and
 * when run_application is excluded a requested bash is dropped rather than
 * restored or replaced by a different command capability). A loadout with no
 * bash, such as a read-only one, is untouched. Shell On is untouched as well.
 */
export function applyDirectApplicationLoadout(
    tools: readonly string[],
    options: { shell: boolean; excluded?: ReadonlySet<string> },
): DirectApplicationLoadout {
    if (options.shell) return Object.freeze({ tools: Object.freeze([...tools]), substituted: false, excluded: false });
    const result: string[] = [];
    let substituted = false;
    let excluded = false;
    for (const name of tools) {
        if (name !== "bash") {
            if (!result.includes(name)) result.push(name);
            continue;
        }
        // An explicitly excluded bash stays excluded: no capability is substituted for it.
        if (options.excluded?.has("bash")) continue;
        if (options.excluded?.has(RUN_APPLICATION)) { excluded = true; continue; }
        if (!result.includes(RUN_APPLICATION)) result.push(RUN_APPLICATION);
        substituted = true;
    }
    return Object.freeze({ tools: Object.freeze(result), substituted, excluded });
}

/** The commands master plus the optional shell switch and per-command cap, always resolved. */
export type TaskPermissions = Readonly<SandboxPermissions> & CommandSettings;

export type TaskPolicy = Readonly<{
    version: 1;
    root: string;
    home: string;
    agentDir: string;
    profilePath: string;
    scratch: string;
    permissions: TaskPermissions;
    denyWrite: readonly string[];
    tools: readonly string[];
    /** The guarded apply_patch adapter is a task builtin for this run. */
    applyPatch: boolean;
    /** Trusted extension tools admitted by name AND canonical package root (ADR 0009). */
    extensionTools: readonly TaskExtensionTool[];
}>;

export type TaskExtensionTool = Readonly<{
    name: string;
    /** Owning package as the parent resolved it (for messages). */
    package: string;
    /** Canonical package root; the registered tool's source must lie inside it. */
    root: string;
    /** Refused while the profile's Network access is Off. */
    network: boolean;
}>;

/**
 * The task tools a child activates: only requested builtins that this policy
 * permits. The commands master withholds both command tools, the shell switch
 * withholds bash (the direct-application adapter remains), and Process access
 * Off withholds the fixed inventory adapter.
 */
export function selectTaskTools(
    policy: Pick<TaskPolicy, "tools" | "permissions">,
    builtins: readonly string[],
): string[] {
    const known = new Set(builtins);
    const commandsOn = policy.permissions.commands !== false;
    const shellOn = policy.permissions.shell !== false;
    return policy.tools.filter((name) => known.has(name) &&
        (commandsOn || (name !== "bash" && name !== RUN_APPLICATION)) &&
        (name !== "bash" || shellOn) &&
        (name !== "process_list" || policy.permissions.processAccess === "read"));
}

/**
 * The Subagents default: Project files = Write & delete, Outside project = Write
 * (broad writes across home and temp, removal only where it is disposable, and
 * the fixed deny list). Matches `pi-better-sandbox`'s default Subagents column.
 */
export const DEFAULT_TASK_PERMISSIONS: TaskPermissions = Object.freeze({
    projectFiles: "read-write", outsideProject: "write", storedCredentials: "read-write", commands: true, network: true,
    processAccess: "off", shell: true, commandTimeoutSeconds: null,
});

export function parseTaskPolicy(value: unknown): TaskPolicy {    if (!value || typeof value !== "object") throw new Error("Task sandbox policy is missing.");
    const v = value as Record<string, unknown>;
    const absolute = (key: string) => {
        const path = v[key];
        if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`Task sandbox ${key} must be absolute.`);
        return path;
    };
    if (v.version !== 1 || !v.permissions || typeof v.permissions !== "object") throw new Error("Unsupported task sandbox policy.");
    const p = v.permissions as Record<string, unknown>;
    for (const key of ["projectFiles", "outsideProject"]) {
        if (!["off", "read", "write", "read-write"].includes(String(p[key]))) throw new Error(`Invalid task sandbox ${key}.`);
    }
    if (!["off", "read", "read-write"].includes(String(p.storedCredentials))) throw new Error("Invalid task sandbox storedCredentials.");
    if (typeof p.commands !== "boolean" || typeof p.network !== "boolean") throw new Error("Invalid task sandbox capabilities.");
    if (p.processAccess !== undefined && p.processAccess !== "off" && p.processAccess !== "read") throw new Error("Invalid task sandbox processAccess.");
    if (p.shell !== undefined && typeof p.shell !== "boolean") throw new Error("Invalid task sandbox shell setting.");
    if (p.commandTimeoutSeconds !== undefined && p.commandTimeoutSeconds !== null && !isCommandTimeoutSeconds(p.commandTimeoutSeconds)) {
        throw new Error("Invalid task sandbox command timeout; it must be a positive, finite number of seconds up to 2147483.");
    }
    if (!Array.isArray(v.denyWrite) || !v.denyWrite.every((path) => typeof path === "string" && isAbsolute(path))) throw new Error("Invalid task sandbox protected paths.");
    if (!Array.isArray(v.tools) || !v.tools.every((name) => typeof name === "string" && name.length > 0)) throw new Error("Invalid task sandbox tool selection.");
    if (v.applyPatch !== undefined && typeof v.applyPatch !== "boolean") throw new Error("Invalid task sandbox apply_patch setting.");
    const extensionTools = v.extensionTools ?? [];
    if (!Array.isArray(extensionTools) || !extensionTools.every((entry) => {
        const e = entry as Record<string, unknown> | null;
        return !!e && typeof e.name === "string" && e.name.length > 0 && typeof e.package === "string" &&
            typeof e.root === "string" && isAbsolute(e.root) && typeof e.network === "boolean";
    })) throw new Error("Invalid task sandbox extension tools.");
    return Object.freeze({
        version: 1, root: absolute("root"), home: absolute("home"), agentDir: absolute("agentDir"), profilePath: absolute("profilePath"), scratch: absolute("scratch"),
        permissions: Object.freeze({
            projectFiles: p.projectFiles, outsideProject: p.outsideProject, storedCredentials: p.storedCredentials,
            commands: p.commands, network: p.network,
            processAccess: p.processAccess ?? "off",
            // Older policies predate the shell switch and the cap: absent keeps the historical behavior.
            shell: p.shell !== false,
            commandTimeoutSeconds: isCommandTimeoutSeconds(p.commandTimeoutSeconds) ? p.commandTimeoutSeconds : null,
        } as TaskPermissions),
        denyWrite: Object.freeze([...v.denyWrite]), tools: Object.freeze([...v.tools]),
        applyPatch: v.applyPatch === true,
        extensionTools: Object.freeze((extensionTools as TaskExtensionTool[]).map((e) => Object.freeze({
            name: e.name, package: e.package, root: e.root, network: e.network,
        }))),
    });
}

export function prepareTaskRuntime(options: {
    root: string; controlDir: string; tools: readonly string[]; piBin: string;
    permissions?: SandboxPermissions & Partial<CommandSettings>; extensionPaths?: readonly string[]; runtimeRoots?: readonly string[];
    applyPatch?: boolean; extensionTools?: readonly TaskExtensionTool[];
}): { file: string; fileArgs: string[]; policy: TaskPolicy; policyPath: string } {
    if (typeof PiCodingAgent.getAgentDir !== "function" || typeof PiCodingAgent.getPackageDir !== "function") {
        throw new Error("Task sandbox requires a supported active Pi SDK; refusing an unguarded child.");
    }
    const support = describeSandboxSupport();
    if (!support.supported) throw new Error(`Task sandbox unavailable: ${support.reason}`);
    const root = realpathSync.native(options.root);
    const home = homedir();
    if (root === dirname(root) || root === canonicalizePath(home)) throw new Error("Task sandbox requires a project directory, not the filesystem or home root.");
    const permissions = options.permissions ?? DEFAULT_TASK_PERMISSIONS;
    const alias = [PiCodingAgent.getAgentDir(), PiCodingAgent.getPackageDir(), tmpdir()]
        .map((path) => writableRuntimeAlias(path, root, permissions, true)).find(Boolean);
    if (alias) throw new Error(`Task sandbox runtime path uses a task-writable symlink (${alias}); restart Pi with canonical runtime paths.`);
    const runtimeDirectories = ensureHarnessRuntimeDirectories();
    const agentDir = canonicalizePath(PiCodingAgent.getAgentDir());
    const controlDir = canonicalizePath(options.controlDir);
    mkdirSync(controlDir, { recursive: true });
    const sdkEntry = canonicalizePath(join(PiCodingAgent.getPackageDir(), "dist", "index.js"));
    const cliPaths = ["cli.js", join("bundle", "cli.js")].map((entry) => canonicalizePath(join(PiCodingAgent.getPackageDir(), "dist", entry)));
    if (!cliPaths.includes(canonicalizePath(options.piBin))) {
        throw new Error("Task sandbox requires the active Pi SDK CLI; a different pi executable is on PATH.");
    }
    const ownEntry = fileURLToPath(import.meta.url);
    const scratch = createTaskScratch();
    const policy = parseTaskPolicy({
        version: 1, root, home, agentDir, profilePath: join(controlDir, "task.sb"), scratch: scratch.path,
        permissions,
        denyWrite: [...new Set([
            controlDir, scratch.anchor, agentDir, ...runtimeDirectories, ...(options.runtimeRoots ?? []), join(root, ".pi"),
            // Outside project = Write does not protect git hooks or config anywhere
            // (ADR 0008): guarding the workspace's hooks would break `git init` there.
            ...(permissions.outsideProject === "write" ? [] : [join(root, ".git", "hooks")]), join(root, ".env"), join(root, ".env.local"),
            runtimeCodeRoot(sdkEntry), runtimeCodeRoot(ownEntry), ...(options.extensionPaths ?? []).map(runtimeCodeRoot),
        ])],
        tools: options.tools,
        applyPatch: options.applyPatch === true,
        extensionTools: (options.extensionTools ?? []).map((tool) => ({ ...tool, root: canonicalizePath(tool.root) })),
    });
    compileWritePolicy({ writableRoot: root, home, permissions: policy.permissions, denyWrite: policy.denyWrite, runtimeCompatibility: true });
    const policyPath = join(controlDir, "task-policy.json");
    writeFileSync(policyPath, JSON.stringify(policy), { mode: 0o600 });
    return {
        file: process.execPath,
        fileArgs: [canonicalizePath(fileURLToPath(new URL("./task-runtime.mjs", import.meta.url))), sdkEntry, policyPath],
        policy, policyPath,
    };
}

export function readTaskPolicy(path: string): TaskPolicy {
    return parseTaskPolicy(JSON.parse(readFileSync(path, "utf8")));
}
