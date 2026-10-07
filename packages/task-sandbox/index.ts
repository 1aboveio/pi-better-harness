/** The task boundary: trusted Pi owns the runtime; every admitted task tool uses this executor. */
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import type { BashOperations, ExtensionAPI } from "@earendil-works/pi-coding-agent";
const { createBashToolDefinition, createReadToolDefinition, createWriteToolDefinition,
    createEditToolDefinition, createLocalBashOperations, getShellConfig } = PiCodingAgent;
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { accessSync, constants, lstatSync, mkdirSync, mkdtempSync, readlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { canonicalizePath, compileWritePolicy, isRemovableUnderWrite, maybeBuildSandboxCommand, type SandboxPermissions } from "../sandbox-core/index.ts";
import { createTaskFileOperations, type TaskFileController } from "./files.ts";
import { APPLY_PATCH_TOOL, createApplyPatchToolDefinition } from "./apply-patch.ts";
import { createProcessListToolDefinition, PROCESS_LIST_TOOL } from "./process-list.ts";
import type { SandboxDiagnostics, DiagnosticResource } from "../sandbox-diagnostics/index.ts";

export const TASK_BUILTINS = Object.freeze(["read", "write", "edit", "bash", PROCESS_LIST_TOOL] as const);
/** Harness adapters that follow the file rules; each is a task builtin only when the profile enables it. */
export const GUARDED_TASK_TOOLS = Object.freeze([APPLY_PATCH_TOOL] as const);

/** Loaded code and its installed dependencies must remain task-read-only. */
export function runtimeCodeRoot(path: string): string {
    const canonical = canonicalizePath(path);
    let current = dirname(canonical);
    while (dirname(current) !== current) {
        if (basename(current) === "node_modules") return current;
        current = dirname(current);
    }
    return dirname(canonical);
}

export function writableRuntimeAlias(path: string, root: string, permissions: {
    projectFiles: string; outsideProject: string; storedCredentials: string;
}, runtimeCompatibility = false): string | undefined {
    const compiled = compileWritePolicy({ writableRoot: root, home: homedir(),
        permissions: { ...permissions, commands: true, network: true } as SandboxPermissions,
        runtimeCompatibility,
    });
    const compatibility = runtimeCompatibility ? compiled.compatibilityWrite ?? [] : [];
    const absolute = resolve(path);
    let current = parse(absolute).root;
    let pending = absolute.slice(current.length).split(sep);
    let links = 0;
    while (pending.length) {
        const component = pending.shift()!;
        if (!component || component === ".") continue;
        if (component === "..") { current = dirname(current); continue; }
        const entry = join(current, component);
        let stat;
        try { stat = lstatSync(entry); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
        }
        if (!stat.isSymbolicLink()) { current = entry; continue; }
        if (++links > 40) throw new Error("Too many symlinks in Pi runtime path");
        let replaceable = false;
        try { accessSync(current, constants.W_OK); replaceable = true; }
        catch { /* An OS-protected entry is immutable; its target still needs inspection. */ }
        const inProject = entry === root || entry.startsWith(root + sep);
        const access = inProject ? permissions.projectFiles
            : compatibility.some((directory) => entry === directory || entry.startsWith(directory + sep)) ? "read-write"
            : permissions.outsideProject;
        // Replacing a directory entry needs removal: Write levels only allow that
        // in their disposable places (temp, hidden home entries, worktree folders).
        const removable = access === "read-write" || compiled.permissions?.storedCredentials === "read-write" ||
            (access === "write" && isRemovableUnderWrite(entry, compiled));
        if (replaceable && removable) return entry;
        // Resolve targets component-by-component: realpath would erase the
        // intermediate links whose directory entries need protection.
        const target = readlinkSync(entry);
        if (isAbsolute(target)) {
            current = parse(target).root;
            pending = [...target.slice(current.length).split(sep), ...pending];
        } else pending = [...target.split(sep), ...pending];
    }
    return undefined;
}

export function harnessRuntimeDirectories(): string[] {
    const names = ["pi-better-subagents", "pi-better-background-tasks"];
    const pool = process.env.VITEST_POOL_ID;
    if (pool && /^\d+$/.test(pool)) names.push(`pi-better-background-tasks-vitest-${pool}`);
    return names.map((name) => canonicalizePath(join(tmpdir(), name)));
}

export function ensureHarnessRuntimeDirectories(): string[] {
    const directories = harnessRuntimeDirectories();
    for (const path of directories) mkdirSync(path, { recursive: true, mode: 0o700 });
    return directories;
}

export function createTaskScratch(): { path: string; anchor: string } {
    const path = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-task-scratch-")));
    const anchor = join(path, ".sandbox-anchor");
    writeFileSync(anchor, "", { flag: "wx", mode: 0o400 });
    // Denying the anchor also prevents renaming/replacing its parent directory.
    return { path, anchor };
}

export function createTaskBashOperations(
    controller: TaskFileController,
    shellPath: () => string | undefined = () => undefined,
    diagnostics?: Pick<SandboxDiagnostics, "observe">,
): BashOperations {
    return {
        async exec(command, cwd, options) {
            const observed = (basis: "policy-refusal" | "os-permission-error", outcome: "denied" | "succeeded") => {
                try { diagnostics?.observe({ tool: "bash", operation: { command, cwd }, resource: "command-execution", basis, outcome }); }
                catch { /* Observation is nonfatal. */ }
            };
            const configuredShell = shellPath();
            const local = createLocalBashOperations(configuredShell ? { shellPath: configuredShell } : {});
            const plan = controller.requireLaunchPlan();
            if (!plan.confined) {
                const result = await local.exec(command, cwd, options);
                if (result.exitCode === 0) observed("os-permission-error", "succeeded");
                return result;
            }
            if (plan.policy.permissions?.commands === false) {
                observed("policy-refusal", "denied");
                throw new Error("Sandbox: Run commands & applications is Off.");
            }
            // An explicit path avoids SDK fallback spawning PATH-resolved `which`.
            const shell = getShellConfig(configuredShell ?? "/bin/bash");
            const sdkUtils = join(PiCodingAgent.getPackageDir(), "dist", "utils");
            const { waitForChildProcess } = await import(pathToFileURL(join(sdkUtils, "child-process.js")).href);
            const { trackDetachedChildPid, untrackDetachedChildPid } = await import(pathToFileURL(join(sdkUtils, "shell.js")).href);
            if (shell.commandTransport === "stdin") throw new Error("Sandbox: this shell cannot be confined by the available backend.");
            const scratch = plan.policy.runtimeWrite?.[0];
            // Git inventory otherwise creates optional locks in an outside gitdir it cannot unlink (#419).
            const taskEnv = { GIT_OPTIONAL_LOCKS: "0", ...process.env, ...options.env,
                ...(scratch ? { TMPDIR: scratch, TMP: scratch, TEMP: scratch } : {}) };
            if (options.signal?.aborted) throw new Error("aborted");
            if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout * 1000 > 2147483647)) {
                throw new Error("Invalid timeout: must be a positive, supported number of seconds");
            }
            // A sibling launch must never rewrite a profile another process is reading.
            const profilePath = `${plan.profilePath}.${randomUUID()}.bash.sb`;
            try {
                const wrapped = maybeBuildSandboxCommand({
                    policy: plan.policy, profilePath,
                    execPath: "/usr/bin/env", execArgs: ["-i", "--", ...Object.entries(taskEnv)
                        .filter((entry): entry is [string, string] => entry[1] !== undefined)
                        .map(([key, value]) => `${key}=${value}`), shell.shell, ...shell.args, command],
                }, { sandboxEnabled: true, explicitSandbox: true });
                if (!wrapped) throw new Error("Sandbox: no task execution backend is available.");
                for (const line of wrapped.notices ?? []) options.onData(Buffer.from(`${line}\n`));
                if (options.signal?.aborted) throw new Error("aborted");
                // No shell or caller-controlled loader environment runs before the boundary.
                return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
                    const child = spawn(wrapped.file, wrapped.fileArgs, { cwd, detached: true,
                        env: { PATH: "/usr/bin:/bin", HOME: plan.policy.home }, stdio: ["ignore", "pipe", "pipe"] });
                    let timedOut = false;
                    const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } } };
                    const timer = options.timeout === undefined ? undefined : setTimeout(() => { timedOut = true; kill(); }, options.timeout * 1000);
                    if (child.pid) trackDetachedChildPid(child.pid);
                    const cleanup = () => {
                        if (child.pid) untrackDetachedChildPid(child.pid);
                        if (timer) clearTimeout(timer);
                        options.signal?.removeEventListener("abort", kill);
                    };
                    child.stdout.on("data", options.onData);
                    child.stderr.on("data", options.onData);
                    options.signal?.addEventListener("abort", kill, { once: true });
                    if (options.signal?.aborted) kill();
                    void waitForChildProcess(child).then((exitCode: number | null) => {
                        cleanup();
                        if (options.signal?.aborted) reject(new Error("aborted"));
                        else if (timedOut) reject(new Error(`timeout:${options.timeout}`));
                        else {
                            if (exitCode === 0) observed("os-permission-error", "succeeded");
                            resolve({ exitCode });
                        }
                    }, (error: unknown) => {
                        cleanup();
                        reject(error);
                    });
                });
            } catch (error) {
                if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException)?.code ?? "")) observed("os-permission-error", "denied");
                throw error;
            } finally {
                await unlink(profilePath).catch((error: NodeJS.ErrnoException) => {
                    if (error.code !== "ENOENT") throw error;
                });
            }
        },
    };
}

/**
 * Only definitions installed here are admitted as builtins. A distinct schema
 * identity detects later replacement, including overrides using SDK factories.
 * Other tool implementations need an explicit, host-owned admission function;
 * knowing a tool's name or enabling network access never makes it confined.
 */
export function installTaskTools(pi: ExtensionAPI, options: {
    controller: TaskFileController;
    cwd: string;
    shellPath?: () => string | undefined;
    trustedSources: readonly string[];
    admitExtensionTool?: (name: string, input: unknown, sourcePath: string | undefined) => boolean;
    /** Register the guarded apply_patch adapter as a task builtin. */
    applyPatch?: boolean;
    /** Human-controlled access to the fixed read-only inventory adapter. */
    processAccess?: () => "off" | "read";
    /** Build the admitted bash definition from the confined operations (default: the SDK bash tool). */
    bashDefinition?: (cwd: string, operations: BashOperations) => ReturnType<typeof createBashToolDefinition>;
    diagnostics?: Pick<SandboxDiagnostics, "observe">;
}) {
    const { controller } = options;
    const sourceKey = (path: string) => path.startsWith("<") ? path : canonicalizePath(path);
    const trustedSources = new Set(options.trustedSources.map(sourceKey));
    const trustedSource = (path: string | undefined) => path !== undefined && trustedSources.has(sourceKey(path));
    const files = createTaskFileOperations(controller, options.diagnostics);
    const bash = createTaskBashOperations(controller, options.shellPath, options.diagnostics);
    const schemas = new Map<string, unknown>();
    let currentCwd: string | undefined;
    const register = (cwd: string) => {
        if (cwd === currentCwd) return;
        currentCwd = cwd;
        const own = <T extends { name: string; parameters: object }>(definition: T): T => {
            const parameters = { ...definition.parameters };
            schemas.set(definition.name, parameters);
            return { ...definition, parameters };
        };
        pi.registerTool(own(createReadToolDefinition(cwd, { operations: files.read })));
        pi.registerTool(own(createWriteToolDefinition(cwd, { operations: files.write })));
        pi.registerTool(own(createEditToolDefinition(cwd, { operations: files.edit })));
        pi.registerTool(own(options.bashDefinition ? options.bashDefinition(cwd, bash) : createBashToolDefinition(cwd, { operations: bash })));
        pi.registerTool(own(createProcessListToolDefinition(cwd, controller, options.processAccess ?? (() => "off"))) as any);
        if (options.applyPatch) {
            const patchFiles = createTaskFileOperations(controller, options.diagnostics, "apply_patch");
            pi.registerTool(own(createApplyPatchToolDefinition(cwd, {
                readFile: patchFiles.read.readFile, writeFile: patchFiles.write.writeFile, mkdir: patchFiles.write.mkdir,
                remove: patchFiles.remove.remove, checkWrite: patchFiles.check.write, checkRemove: patchFiles.check.remove,
            }, PiCodingAgent.withFileMutationQueue)) as any);
        }
    };
    register(options.cwd);
    pi.on("user_bash", () => ({ operations: bash }));
    pi.on("tool_call", (event, ctx) => {
        const blocked = (reason: string, resource: DiagnosticResource) => {
            try { options.diagnostics?.observe({ tool: event.toolName, operation: { input: event.input, cwd: ctx?.cwd ?? currentCwd }, resource,
                basis: "policy-refusal", outcome: "denied" }); } catch { /* Observation is nonfatal. */ }
            return { block: true, reason };
        };
        try {
            const plan = controller.requireLaunchPlan();
            if (!plan.confined) return;
            const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
            if (schemas.has(event.toolName)) {
                if (!tool || tool.parameters !== schemas.get(event.toolName) || !trustedSource(tool.sourceInfo?.path)) {
                    return blocked(`Sandbox: ${event.toolName} was replaced by an unverified implementation.`, "tool-admission");
                }
                if (event.toolName === "bash" && plan.policy.permissions?.commands === false) {
                    return blocked("Sandbox: Run commands & applications is Off.", "command-execution");
                }
                if (event.toolName === PROCESS_LIST_TOOL && options.processAccess?.() !== "read") {
                    return blocked("Sandbox: Process access is Off. Enable Read in /sandbox.", "process-inspection");
                }
                return;
            }
            if (options.admitExtensionTool?.(event.toolName, event.input, tool?.sourceInfo?.path)) return;
            return blocked(`Sandbox: ${event.toolName} has no verified task execution adapter. Use a guarded file tool or confined bash command.`, "tool-admission");
        } catch (error) {
            return blocked(error instanceof Error ? error.message : String(error), "sandbox-backend");
        }
    });
    if (options.diagnostics) pi.on("tool_result", (event, ctx) => {
        if (event.isError) return;
        try { options.diagnostics?.observe({ tool: event.toolName, operation: { input: event.input, cwd: ctx?.cwd ?? currentCwd }, resource: "unknown",
            basis: "policy-refusal", outcome: "succeeded" }); } catch { /* Observation is nonfatal. */ }
    });
    return { register, bash, assertInstalled(names: readonly string[]) {
        const inventory = pi.getAllTools();
        for (const name of names) {
            const tool = inventory.find((candidate) => candidate.name === name);
            if (!schemas.has(name) || tool?.parameters !== schemas.get(name) || !trustedSource(tool?.sourceInfo?.path)) {
                throw new Error(`Sandbox: ${name} is missing or was replaced by an unverified implementation.`);
            }
        }
    } };
}
