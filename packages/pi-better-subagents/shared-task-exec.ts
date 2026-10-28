// Generated from packages/task-sandbox/exec.ts. Do not edit directly.
/**
 * One confined command executor for shell commands and direct application runs.
 *
 * Both shapes reach the same kernel wrapper with the same task environment,
 * scratch directory, output drain, cancellation, timeout and process-group
 * handling. Only the target differs: a shell command, or an exact executable
 * and literal argv. Direct application execution is an interface restriction,
 * not an OS exec deny: descendants of an application can still invoke a shell.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename, delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
const { createLocalBashOperations, getShellConfig } = PiCodingAgent;
import { directApplicationTarget, maybeBuildSandboxCommand, SHELL_EXECUTABLE_NAMES, type SandboxPermissions } from "./shared-sandbox-core.ts";
import type { SandboxDiagnostics } from "./shared-sandbox-diagnostics.ts";
import type { TaskFileController } from "./shared-task-files.ts";

export type TaskExecTarget =
    | { readonly kind: "shell"; readonly command: string }
    | { readonly kind: "argv"; readonly execPath: string; readonly execArgs: readonly string[] };

export type TaskExecOptions = {
    onData: (chunk: Buffer) => void;
    signal?: AbortSignal | undefined;
    timeout?: number | undefined;
    env?: NodeJS.ProcessEnv | undefined;
};

export type TaskExec = (
    target: TaskExecTarget,
    cwd: string,
    options: TaskExecOptions,
) => Promise<{ exitCode: number | null }>;

const MAX_TIMEOUT_MS = 2_147_483_647;
/** The profile's documented command-time-limit ceiling, in seconds. */
const MAX_COMMAND_TIMEOUT_SECONDS = 2_147_483;

export const SHELL_SCRIPTS_OFF = "Sandbox: Shell scripts are Off. Use run_application for a direct executable, or turn Shell scripts on in /sandbox.";

export function shellInterpreterOff(interpreter: string): string {
    return `Sandbox: Shell scripts are Off; run_application cannot launch the shell interpreter ${interpreter}. ` +
        "Run an application directly, or turn Shell scripts on in /sandbox.";
}

/** The SDK's timeout contract, kept verbatim so callers keep their error text. */
export function validateTimeout(timeout: number | undefined): void {
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > MAX_TIMEOUT_MS)) {
        throw new Error("Invalid timeout: must be a positive, supported number of seconds");
    }
}

/**
 * The timeout every command path actually runs with. The profile cap bounds an
 * explicit request and applies on its own when the request omits a timeout.
 */
export function effectiveCommandTimeout(
    requested: number | undefined,
    permissions: SandboxPermissions | undefined,
): number | undefined {
    const cap = permissions?.commandTimeoutSeconds;
    if (cap === undefined || cap === null) return requested;
    if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0 || cap > MAX_COMMAND_TIMEOUT_SECONDS) {
        throw new Error("Sandbox: the profile command time limit is invalid; no command was run.");
    }
    return requested === undefined ? cap : Math.min(requested, cap);
}

const SHELL_EXECUTABLES = SHELL_EXECUTABLE_NAMES;
const SHELL_NAMES = new Set<string>(SHELL_EXECUTABLES);

function executableName(path: string): string {
    const name = basename(path).toLowerCase();
    return process.platform === "win32" ? name.replace(/\.exe$/, "") : name;
}

function isShellName(path: string): boolean {
    return SHELL_NAMES.has(executableName(path));
}

function pathValue(env: NodeJS.ProcessEnv): string | undefined {
    return env.PATH ?? env.Path;
}

/**
 * Resolve the executable the way spawn will: a relative or absolute path is
 * taken against the launch cwd, a bare name through the task's PATH.
 */
function findExecutable(executable: string, env: NodeJS.ProcessEnv, cwd: string): string | undefined {
    if (executable.includes("/") || (process.platform === "win32" && executable.includes("\\"))) {
        return resolve(cwd, executable);
    }
    const path = pathValue(env);
    if (!path) return undefined;
    for (const directory of path.split(delimiter)) {
        const candidate = resolve(cwd, directory || ".", executable);
        try {
            if (statSync(candidate).isFile()) {
                accessSync(candidate, constants.X_OK);
                return candidate;
            }
        } catch { /* A PATH entry may vanish between lookup and use. */ }
    }
    return undefined;
}

let shellIdentities: { path: string | undefined; ids: Set<string> } | undefined;

/** Device/inode identities of the known shell binaries on this task's PATH. */
function knownShellIdentities(env: NodeJS.ProcessEnv): Set<string> {
    const path = pathValue(env);
    const cached = shellIdentities;
    if (cached && cached.path === path) return cached.ids;
    const ids = new Set<string>();
    for (const directory of (path ?? "").split(delimiter)) {
        for (const name of SHELL_EXECUTABLES) {
            try {
                const info = statSync(join(directory || ".", name), { bigint: true });
                if (info.isFile()) ids.add(`${info.dev}:${info.ino}`);
            } catch { /* Not present in this directory. */ }
        }
    }
    shellIdentities = { path, ids };
    return ids;
}

/**
 * The shell interpreter a direct application launch would start, if any.
 *
 * Requested identity (the model's executable token) is checked first, then the
 * resolved canonical executable: a symlink or alternate name that resolves to
 * a shell is still a shell, and a link to a shell's inode is caught too.
 */
export function directShellInterpreter(
    executable: string,
    env: NodeJS.ProcessEnv = process.env,
    cwd: string = process.cwd(),
): string | undefined {
    if (isShellName(executable)) return executable;
    const requested = findExecutable(executable, env, cwd);
    if (!requested) return undefined;
    let canonical: string;
    try {
        canonical = realpathSync.native(requested);
    } catch {
        return undefined;
    }
    if (isShellName(canonical)) return canonical;
    try {
        const info = statSync(canonical, { bigint: true });
        if (knownShellIdentities(env).has(`${info.dev}:${info.ino}`)) return canonical;
    } catch { /* A missing file fails when spawn runs it. */ }
    return undefined;
}

/** Spawn one process group, drain both pipes, and stop the group on cancel or timeout. */
async function spawnTracked(file: string, fileArgs: readonly string[], options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    onData: (chunk: Buffer) => void;
    signal?: AbortSignal | undefined;
    timeout?: number | undefined;
    reportSignal?: boolean;
}): Promise<{ exitCode: number | null }> {
    const sdkUtils = join(PiCodingAgent.getPackageDir(), "dist", "utils");
    const { waitForChildProcess } = await import(pathToFileURL(join(sdkUtils, "child-process.js")).href);
    const { trackDetachedChildPid, untrackDetachedChildPid } = await import(pathToFileURL(join(sdkUtils, "shell.js")).href);
    if (options.signal?.aborted) throw new Error("aborted");
    return await new Promise<{ exitCode: number | null }>((resolvePromise, reject) => {
        const child = spawn(file, [...fileArgs], { cwd: options.cwd, detached: true, shell: false,
            env: options.env, stdio: ["ignore", "pipe", "pipe"] });
        let timedOut = false;
        const kill = () => {
            if (child.pid) {
                try { process.kill(-child.pid, "SIGKILL"); }
                catch { child.kill("SIGKILL"); }
            }
        };
        const timer = options.timeout === undefined ? undefined : setTimeout(() => { timedOut = true; kill(); }, options.timeout * 1000);
        if (child.pid) trackDetachedChildPid(child.pid);
        const cleanup = () => {
            if (child.pid) untrackDetachedChildPid(child.pid);
            if (timer) clearTimeout(timer);
            options.signal?.removeEventListener("abort", kill);
        };
        child.stdout?.on("data", options.onData);
        child.stderr?.on("data", options.onData);
        options.signal?.addEventListener("abort", kill, { once: true });
        if (options.signal?.aborted) kill();
        void waitForChildProcess(child).then((exitCode: number | null) => {
            cleanup();
            if (options.signal?.aborted) reject(new Error("aborted"));
            else if (timedOut) reject(new Error(`timeout:${options.timeout}`));
            else if (options.reportSignal && exitCode === null && child.signalCode) reject(new Error(`Command terminated by signal ${child.signalCode}`));
            else resolvePromise({ exitCode });
        }, (error: unknown) => {
            cleanup();
            reject(error);
        });
    });
}

export function createTaskExecutor(
    controller: TaskFileController,
    shellPath: () => string | undefined = () => undefined,
    diagnostics?: Pick<SandboxDiagnostics, "observe">,
): TaskExec {
    return async (target, cwd, options) => {
        const tool = target.kind === "argv" ? "run_application" : "bash";
        const observed = (basis: "policy-refusal" | "os-permission-error", outcome: "denied" | "succeeded") => {
            try {
                diagnostics?.observe({
                    tool,
                    operation: target.kind === "argv"
                        ? { executable: target.execPath, args: [...target.execArgs], cwd }
                        : { command: target.command, cwd },
                    resource: "command-execution", basis, outcome,
                });
            } catch { /* Observation is nonfatal. */ }
        };
        const configuredShell = shellPath();
        const local = createLocalBashOperations(configuredShell ? { shellPath: configuredShell } : {});
        const plan = controller.requireLaunchPlan();
        if (!plan.confined) {
            // A disabled profile restricts nothing: keep the platform's own behavior.
            if (target.kind === "shell") {
                const result = await local.exec(target.command, cwd, {
                    onData: options.onData,
                    ...(options.signal === undefined ? {} : { signal: options.signal }),
                    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
                    ...(options.env === undefined ? {} : { env: options.env }),
                });
                if (result.exitCode === 0) observed("os-permission-error", "succeeded");
                return result;
            }
            validateTimeout(options.timeout);
            const result = await spawnTracked(target.execPath, target.execArgs, {
                cwd, env: options.env ?? process.env, onData: options.onData,
                signal: options.signal, timeout: options.timeout, reportSignal: true,
            });
            if (result.exitCode === 0) observed("os-permission-error", "succeeded");
            return result;
        }
        const permissions = plan.policy.permissions;
        if (permissions?.commands === false) {
            observed("policy-refusal", "denied");
            throw new Error("Sandbox: Run commands & applications is Off.");
        }
        if (target.kind === "shell" && permissions?.shell === false) {
            observed("policy-refusal", "denied");
            throw new Error(SHELL_SCRIPTS_OFF);
        }
        // An explicit path avoids SDK fallback spawning PATH-resolved `which`.
        const shell = target.kind === "shell" ? getShellConfig(configuredShell ?? "/bin/bash") : undefined;
        if (shell?.commandTransport === "stdin") throw new Error("Sandbox: this shell cannot be confined by the available backend.");
        const scratch = plan.policy.runtimeWrite?.[0];
        // Git inventory otherwise creates optional locks in an outside gitdir it cannot unlink (#419).
        const taskEnv: NodeJS.ProcessEnv = { GIT_OPTIONAL_LOCKS: "0", ...process.env, ...options.env,
            ...(scratch ? { TMPDIR: scratch, TMP: scratch, TEMP: scratch } : {}) };
        // Resolve against the launch cwd, not the trusted Pi process cwd.
        const executable = target.kind === "argv" ? findExecutable(target.execPath, taskEnv, cwd) : undefined;
        if (target.kind === "argv" && !executable) {
            throw new Error(`Executable not found: ${target.execPath}`);
        }
        if (target.kind === "argv" && permissions?.shell === false) {
            const interpreter = directShellInterpreter(executable!, taskEnv, cwd);
            if (interpreter) {
                observed("policy-refusal", "denied");
                throw new Error(shellInterpreterOff(interpreter));
            }
        }
        if (options.signal?.aborted) throw new Error("aborted");
        validateTimeout(options.timeout);
        const timeout = effectiveCommandTimeout(options.timeout, permissions);
        // A sibling launch must never rewrite a profile another process is reading.
        const profilePath = `${plan.profilePath}.${randomUUID()}.${target.kind === "argv" ? "app" : "bash"}.sb`;
        try {
            const envArgs = Object.entries(taskEnv)
                .filter((entry): entry is [string, string] => entry[1] !== undefined)
                .map(([key, value]) => `${key}=${value}`);
            const targetArgs = target.kind === "shell"
                ? [shell!.shell, ...shell!.args, target.command]
                : [executable!, ...target.execArgs];
            const wrapped = maybeBuildSandboxCommand({
                policy: plan.policy, profilePath,
                ...(target.kind === "shell"
                    ? { execPath: "/usr/bin/env", execArgs: ["-i", "--", ...envArgs, ...targetArgs] }
                    : { ...directApplicationTarget(executable!, target.execArgs, taskEnv, permissions?.shell !== false),
                        internalHelperExecutable: true }),
            }, { sandboxEnabled: true, explicitSandbox: true });
            if (!wrapped) throw new Error("Sandbox: no task execution backend is available.");
            for (const line of wrapped.notices ?? []) options.onData(Buffer.from(`${line}\n`));
            if (options.signal?.aborted) throw new Error("aborted");
            // No shell or caller-controlled loader environment runs before the boundary.
            const result = await spawnTracked(wrapped.file, wrapped.fileArgs, {
                cwd, env: { PATH: "/usr/bin:/bin", HOME: plan.policy.home }, onData: options.onData,
                signal: options.signal, timeout, reportSignal: target.kind === "argv",
            });
            if (result.exitCode === 0) observed("os-permission-error", "succeeded");
            return result;
        } catch (error) {
            if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException)?.code ?? "")) observed("os-permission-error", "denied");
            throw error;
        } finally {
            await unlink(profilePath).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
            });
        }
    };
}
