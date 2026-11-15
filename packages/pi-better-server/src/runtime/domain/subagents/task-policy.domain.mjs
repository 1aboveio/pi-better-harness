// Generated fixed launch domain from packages/pi-better-subagents/task-policy.ts. Do not edit directly.
/** Immutable launch contract. This file contains policy, never credentials. */
import { realpathSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import { canonicalizePath, compileWritePolicy, describeSandboxSupport } from "./shared-sandbox-core.domain.mjs";
import { createTaskScratch, ensureHarnessRuntimeDirectories, runtimeCodeRoot, writableRuntimeAlias } from "./shared-task-sandbox.domain.mjs";
import { isCommandTimeoutSeconds } from "./permission-policy.domain.mjs";
import { OPERATION_BRIDGE_TOOL_NAMES } from "./operation-bridge-types.domain.mjs";
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
export const SDK_BUILTIN_TOOLS = Object.freeze(["read", "write", "edit", "bash"]);
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
export function applyDirectApplicationLoadout(tools, options) {
    if (options.shell)
        return Object.freeze({ tools: Object.freeze([...tools]), substituted: false, excluded: false });
    const result = [];
    let substituted = false;
    let excluded = false;
    for (const name of tools) {
        if (name !== "bash") {
            if (!result.includes(name))
                result.push(name);
            continue;
        }
        // An explicitly excluded bash stays excluded: no capability is substituted for it.
        if (options.excluded?.has("bash"))
            continue;
        if (options.excluded?.has(RUN_APPLICATION)) {
            excluded = true;
            continue;
        }
        if (!result.includes(RUN_APPLICATION))
            result.push(RUN_APPLICATION);
        substituted = true;
    }
    return Object.freeze({ tools: Object.freeze(result), substituted, excluded });
}
/**
 * The task tools a child activates: only requested builtins that this policy
 * permits. The commands master withholds both command tools, the shell switch
 * withholds bash (the direct-application adapter remains), and Process access
 * Off withholds the fixed inventory adapter.
 */
export function selectTaskTools(policy, builtins) {
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
export const DEFAULT_TASK_PERMISSIONS = Object.freeze({
    projectFiles: "read-write", outsideProject: "write", storedCredentials: "read-write", commands: true, network: true,
    processAccess: "off", shell: true, commandTimeoutSeconds: null,
});
export function parseTaskPolicy(value) {
    if (!value || typeof value !== "object")
        throw new Error("Task sandbox policy is missing.");
    const v = value;
    const absolute = (key) => {
        const path = v[key];
        if (typeof path !== "string" || !isAbsolute(path))
            throw new Error(`Task sandbox ${key} must be absolute.`);
        return path;
    };
    if (v.version !== 1 || !v.permissions || typeof v.permissions !== "object")
        throw new Error("Unsupported task sandbox policy.");
    const p = v.permissions;
    for (const key of ["projectFiles", "outsideProject"]) {
        if (!["off", "read", "write", "read-write"].includes(String(p[key])))
            throw new Error(`Invalid task sandbox ${key}.`);
    }
    if (!["off", "read", "read-write"].includes(String(p.storedCredentials)))
        throw new Error("Invalid task sandbox storedCredentials.");
    if (typeof p.commands !== "boolean" || typeof p.network !== "boolean")
        throw new Error("Invalid task sandbox capabilities.");
    if (p.processAccess !== undefined && p.processAccess !== "off" && p.processAccess !== "read")
        throw new Error("Invalid task sandbox processAccess.");
    if (p.shell !== undefined && typeof p.shell !== "boolean")
        throw new Error("Invalid task sandbox shell setting.");
    if (p.commandTimeoutSeconds !== undefined && p.commandTimeoutSeconds !== null && !isCommandTimeoutSeconds(p.commandTimeoutSeconds)) {
        throw new Error("Invalid task sandbox command timeout; it must be a positive, finite number of seconds up to 2147483.");
    }
    if (!Array.isArray(v.denyWrite) || !v.denyWrite.every((path) => typeof path === "string" && isAbsolute(path)))
        throw new Error("Invalid task sandbox protected paths.");
    if (!Array.isArray(v.tools) || !v.tools.every((name) => typeof name === "string" && name.length > 0))
        throw new Error("Invalid task sandbox tool selection.");
    if (v.applyPatch !== undefined && typeof v.applyPatch !== "boolean")
        throw new Error("Invalid task sandbox apply_patch setting.");
    if (v.operationBridge !== undefined && typeof v.operationBridge !== "boolean")
        throw new Error("Invalid task sandbox operation bridge setting.");
    const extensionTools = v.extensionTools ?? [];
    if (!Array.isArray(extensionTools) || !extensionTools.every((entry) => {
        const e = entry;
        return !!e && typeof e.name === "string" && e.name.length > 0 && typeof e.package === "string" &&
            typeof e.root === "string" && isAbsolute(e.root) && typeof e.network === "boolean";
    }))
        throw new Error("Invalid task sandbox extension tools.");
    return Object.freeze({
        version: 1, root: absolute("root"), home: absolute("home"), agentDir: absolute("agentDir"), profilePath: absolute("profilePath"), scratch: absolute("scratch"),
        permissions: Object.freeze({
            projectFiles: p.projectFiles, outsideProject: p.outsideProject, storedCredentials: p.storedCredentials,
            commands: p.commands, network: p.network,
            processAccess: p.processAccess ?? "off",
            // Older policies predate the shell switch and the cap: absent keeps the historical behavior.
            shell: p.shell !== false,
            commandTimeoutSeconds: isCommandTimeoutSeconds(p.commandTimeoutSeconds) ? p.commandTimeoutSeconds : null,
        }),
        denyWrite: Object.freeze([...v.denyWrite]), tools: Object.freeze([...v.tools]),
        applyPatch: v.applyPatch === true,
        operationBridge: v.operationBridge === true,
        extensionTools: Object.freeze(extensionTools.map((e) => Object.freeze({
            name: e.name, package: e.package, root: e.root, network: e.network,
        }))),
    });
}
export function prepareTaskRuntime(options) {
    if (typeof PiCodingAgent.getAgentDir !== "function" || typeof PiCodingAgent.getPackageDir !== "function") {
        throw new Error("Task sandbox requires a supported active Pi SDK; refusing an unguarded child.");
    }
    const support = describeSandboxSupport();
    if (!support.supported)
        throw new Error(`Task sandbox unavailable: ${support.reason}`);
    const root = realpathSync.native(options.root);
    const home = homedir();
    if (root === dirname(root) || root === canonicalizePath(home))
        throw new Error("Task sandbox requires a project directory, not the filesystem or home root.");
    const permissions = options.permissions ?? DEFAULT_TASK_PERMISSIONS;
    const alias = [PiCodingAgent.getAgentDir(), PiCodingAgent.getPackageDir(), tmpdir()]
        .map((path) => writableRuntimeAlias(path, root, permissions, true)).find(Boolean);
    if (alias)
        throw new Error(`Task sandbox runtime path uses a task-writable symlink (${alias}); restart Pi with canonical runtime paths.`);
    const runtimeDirectories = ensureHarnessRuntimeDirectories();
    const agentDir = canonicalizePath(PiCodingAgent.getAgentDir());
    const controlDir = canonicalizePath(options.controlDir);
    mkdirSync(controlDir, { recursive: true });
    const sdkEntry = canonicalizePath(join(PiCodingAgent.getPackageDir(), "dist", "index.js"));
    const cliPaths = ["cli.js", join("bundle", "cli.js")].map((entry) => canonicalizePath(join(PiCodingAgent.getPackageDir(), "dist", entry)));
    // The guarded runtime invokes this SDK directly. PATH may name a managed
    // shell launcher, so only validate a CLI when the caller explicitly pins one.
    if (options.piBin !== undefined && !cliPaths.includes(canonicalizePath(options.piBin))) {
        throw new Error("Task sandbox requires the active Pi SDK CLI; a different pi executable is on PATH.");
    }
    const ownEntry = fileURLToPath(import.meta.url);
    const scratch = createTaskScratch();
    const policy = parseTaskPolicy({
        version: 1, root, home, agentDir, profilePath: join(controlDir, "task.sb"), scratch: scratch.path,
        permissions,
        denyWrite: [...new Set([
                ...(options.capturedDenyWrite ?? []),
                controlDir, scratch.anchor, agentDir, ...runtimeDirectories, ...(options.runtimeRoots ?? []), join(root, ".pi"),
                // Outside project = Write does not protect git hooks or config anywhere
                // (ADR 0008): guarding the workspace's hooks would break `git init` there.
                ...(permissions.outsideProject === "write" ? [] : [join(root, ".git", "hooks")]), join(root, ".env"), join(root, ".env.local"),
                runtimeCodeRoot(sdkEntry), runtimeCodeRoot(ownEntry), ...(options.extensionPaths ?? []).map(runtimeCodeRoot),
            ])],
        tools: options.tools,
        applyPatch: options.applyPatch === true,
        operationBridge: options.tools.some(name => OPERATION_BRIDGE_TOOL_NAMES.includes(name)) &&
            (options.extensionPaths ?? []).some(path => canonicalizePath(path) === canonicalizePath(fileURLToPath(new URL("./child-operations.ts", import.meta.url)))),
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
export function readTaskPolicy(path) {
    return parseTaskPolicy(JSON.parse(readFileSync(path, "utf8")));
}
