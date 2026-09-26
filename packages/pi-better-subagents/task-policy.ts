/** Immutable launch contract. This file contains policy, never credentials. */
import { realpathSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import { canonicalizePath, compileWritePolicy, describeSandboxSupport, type SandboxPermissions } from "./shared-sandbox-core.ts";
import { createTaskScratch, ensureHarnessRuntimeDirectories, runtimeCodeRoot, writableRuntimeAlias } from "./shared-task-sandbox.ts";

export type TaskPolicy = Readonly<{
    version: 1;
    root: string;
    home: string;
    agentDir: string;
    profilePath: string;
    scratch: string;
    permissions: Readonly<SandboxPermissions>;
    denyWrite: readonly string[];
    tools: readonly string[];
}>;

export const DEFAULT_TASK_PERMISSIONS: Readonly<SandboxPermissions> = Object.freeze({
    projectFiles: "read-write", outsideProject: "read", storedCredentials: "read", commands: true, network: true,
});

export function parseTaskPolicy(value: unknown): TaskPolicy {
    if (!value || typeof value !== "object") throw new Error("Task sandbox policy is missing.");
    const v = value as Record<string, unknown>;
    const absolute = (key: string) => {
        const path = v[key];
        if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`Task sandbox ${key} must be absolute.`);
        return path;
    };
    if (v.version !== 1 || !v.permissions || typeof v.permissions !== "object") throw new Error("Unsupported task sandbox policy.");
    const p = v.permissions as Record<string, unknown>;
    for (const key of ["projectFiles", "outsideProject", "storedCredentials"]) {
        if (!["off", "read", "read-write"].includes(String(p[key]))) throw new Error(`Invalid task sandbox ${key}.`);
    }
    if (typeof p.commands !== "boolean" || typeof p.network !== "boolean") throw new Error("Invalid task sandbox capabilities.");
    if (!Array.isArray(v.denyWrite) || !v.denyWrite.every((path) => typeof path === "string" && isAbsolute(path))) throw new Error("Invalid task sandbox protected paths.");
    if (!Array.isArray(v.tools) || !v.tools.every((name) => typeof name === "string" && name.length > 0)) throw new Error("Invalid task sandbox tool selection.");
    return Object.freeze({
        version: 1, root: absolute("root"), home: absolute("home"), agentDir: absolute("agentDir"), profilePath: absolute("profilePath"), scratch: absolute("scratch"),
        permissions: Object.freeze({ ...p } as SandboxPermissions),
        denyWrite: Object.freeze([...v.denyWrite]), tools: Object.freeze([...v.tools]),
    });
}

export function prepareTaskRuntime(options: {
    root: string; controlDir: string; tools: readonly string[]; piBin: string;
    permissions?: SandboxPermissions; extensionPaths?: readonly string[]; runtimeRoots?: readonly string[];
}): { file: string; fileArgs: string[]; policy: TaskPolicy; policyPath: string } {
    if (typeof PiCodingAgent.getAgentDir !== "function" || typeof PiCodingAgent.getPackageDir !== "function") {
        throw new Error("Task sandbox requires a supported active Pi SDK; refusing an unguarded child.");
    }
    const support = describeSandboxSupport();
    if (!support.supported) throw new Error(`Task sandbox unavailable: ${support.reason}`);
    const root = realpathSync(options.root);
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
            controlDir, scratch.anchor, agentDir, ...runtimeDirectories, ...(options.runtimeRoots ?? []), join(root, ".pi"), join(root, ".git", "hooks"), join(root, ".env"), join(root, ".env.local"),
            runtimeCodeRoot(sdkEntry), runtimeCodeRoot(ownEntry), ...(options.extensionPaths ?? []).map(runtimeCodeRoot),
        ])],
        tools: options.tools,
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
