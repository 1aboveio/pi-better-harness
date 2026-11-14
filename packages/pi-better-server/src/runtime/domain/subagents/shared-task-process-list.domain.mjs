// Generated fixed launch domain from packages/pi-better-subagents/shared-task-process-list.ts. Do not edit directly.
// Generated from packages/task-sandbox/process-list.ts. Do not edit directly.
/** Fixed, read-only current-user process inventory. Never accepts command arguments. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { maybeBuildSandboxCommand } from "./shared-sandbox-core.domain.mjs";
export const PROCESS_LIST_TOOL = "process_list";
const EXECUTABLE = "/usr/bin/pgrep";
const MAX_STDOUT = 1024 * 1024;
const MAX_STDERR = 2048;
const TIMEOUT_MS = 5000;
const parameters = {
    type: "object",
    additionalProperties: false,
    properties: {
        name: { type: "string", maxLength: 128, description: "Literal case-insensitive process-name substring." },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
    },
};
function validateParams(params) {
    if (!params || typeof params !== "object" || Array.isArray(params) ||
        Reflect.ownKeys(params).some((key) => key !== "name" && key !== "limit")) {
        throw new Error("process_list accepts only optional name and limit fields.");
    }
    const { name, limit } = params;
    if (name !== undefined && (typeof name !== "string" || [...name].length > 128)) {
        throw new Error("process_list name must be a string of at most 128 characters.");
    }
    if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200)) {
        throw new Error("process_list limit must be an integer from 1 to 200.");
    }
    return { name: name, limit: limit ?? 100 };
}
function executableIdentity() {
    try {
        if (realpathSync.native(EXECUTABLE) !== EXECUTABLE)
            throw new Error("non-canonical executable path");
        // Root-owned, non-replaceable ancestors prevent task users retargeting the
        // checked path. Normal Linux utilities need no filesystem immutable flag.
        for (const path of ["/", "/usr", "/usr/bin", EXECUTABLE]) {
            const info = lstatSync(path, { bigint: true });
            if (info.uid !== 0n || (info.mode & 18n) !== 0n ||
                (path === EXECUTABLE ? !info.isFile() : !info.isDirectory())) {
                throw new Error("path must be root-owned and not group/world writable, without symlinks");
            }
            if (path === EXECUTABLE) {
                if ((info.mode & 3072n) !== 0n)
                    throw new Error("setuid/setgid executable is forbidden");
                if ((info.mode & 73n) === 0n)
                    throw new Error("executable permission is missing");
                return [info.dev, info.ino, info.uid, info.gid, info.mode, info.size, info.mtimeNs, info.ctimeNs].join(":");
            }
        }
    }
    catch (error) {
        throw new Error(`process_list unsupported: fixed ${EXECUTABLE} is unavailable or unsafe (${error instanceof Error ? error.message : String(error)}).`);
    }
    throw new Error("process_list unsupported: fixed executable identity unavailable.");
}
function parseInventory(stdout, name, limit) {
    const processes = [];
    const seen = new Set();
    const needle = name?.toLowerCase();
    let matches = 0;
    for (const line of stdout.toString("utf8").split("\n")) {
        if (!line)
            continue;
        // pgrep -l (without -f/-a) emits PID, one separator, and the comm/name.
        // Keep spaces in names; never interpret the model's filter as a regex.
        const match = /^[ \t]*([0-9]+)[ \t](.+)$/.exec(line);
        const pid = match ? Number(match[1]) : NaN;
        if (!match || !Number.isSafeInteger(pid) || pid <= 0 || seen.has(pid) || /[\x00-\x1f\x7f]/.test(match[2])) {
            throw new Error("process_list received malformed pgrep process-name output.");
        }
        seen.add(pid);
        const processName = match[2];
        if (needle !== undefined && !processName.toLowerCase().includes(needle))
            continue;
        matches++;
        if (processes.length < limit)
            processes.push({ pid, name: processName });
    }
    return { processes, truncated: matches > limit, scope: "current-user" };
}
function aborted() {
    return Object.assign(new Error("process_list aborted."), { name: "AbortError" });
}
function run(file, argv, cwd, home, signal) {
    if (signal?.aborted)
        return Promise.reject(aborted());
    return new Promise((resolve, reject) => {
        const child = spawn(file, argv, {
            cwd, detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
            env: { LC_ALL: "C", HOME: home, PATH: "/usr/bin:/bin" },
        });
        const chunks = [];
        let size = 0;
        let stderr = Buffer.alloc(0);
        let failure;
        let closed = false;
        const stop = (error) => {
            if (closed || failure)
                return;
            failure = error;
            // Only the owned helper's detached group, never an inventory PID.
            if (child.pid !== undefined) {
                try {
                    process.kill(-child.pid, "SIGKILL");
                }
                catch {
                    child.kill("SIGKILL");
                }
            }
        };
        const onAbort = () => stop(aborted());
        const timer = setTimeout(() => stop(new Error("process_list timed out after 5 seconds.")), TIMEOUT_MS);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted)
            onAbort();
        child.stdout.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_STDOUT)
                stop(new Error("process_list stdout exceeds 1 MiB inventory limit."));
            else if (!failure)
                chunks.push(chunk);
        });
        child.stderr.on("data", (chunk) => {
            if (stderr.length < MAX_STDERR)
                stderr = Buffer.concat([stderr, chunk.subarray(0, MAX_STDERR - stderr.length)]);
        });
        child.on("error", (error) => { failure ??= error; });
        child.on("close", (code, exitSignal) => {
            closed = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            if (failure)
                return reject(failure);
            if (code === 1 && size === 0 && stderr.length === 0)
                return resolve(Buffer.alloc(0));
            if (code !== 0) {
                return reject(new Error(`process_list helper failed (${exitSignal ?? code}): ${stderr.toString("utf8") || "no diagnostic"}`));
            }
            resolve(Buffer.concat(chunks, size));
        });
    });
}
export function createProcessListToolDefinition(cwd, controller, access) {
    let identity;
    const checkAccess = () => {
        if (access() !== "read")
            throw new Error("Sandbox: Process access is Off. Enable Read in /sandbox.");
    };
    const checkExecutable = () => {
        const current = executableIdentity();
        if (identity !== undefined && current !== identity)
            throw new Error("process_list unsupported: fixed executable identity changed.");
        identity = current;
    };
    return {
        name: PROCESS_LIST_TOOL,
        label: "Process List",
        description: "Read current-user process IDs and process names only. Optional literal case-insensitive name filter; no arguments, environment, paths, or process control.",
        promptSnippet: "List current-user process IDs and names with an optional literal name filter.",
        parameters,
        async execute(_toolCallId, params, signal) {
            checkAccess();
            const { name, limit } = validateParams(params);
            if (signal?.aborted)
                throw aborted();
            const plan = controller.requireLaunchPlan();
            if ((process.platform !== "darwin" && process.platform !== "linux") || typeof process.getuid !== "function") {
                throw new Error(`process_list unsupported on ${process.platform}.`);
            }
            const uid = process.getuid();
            if (!Number.isSafeInteger(uid) || uid < 0)
                throw new Error("process_list unsupported: current user ID unavailable.");
            checkExecutable();
            const argv = ["-l", "-u", String(uid), "."];
            let profilePath;
            try {
                let file = EXECUTABLE;
                let fileArgs = argv;
                if (plan.confined) {
                    const helperPolicy = {
                        ...plan.policy,
                        permissions: {
                            projectFiles: "read-write", outsideProject: "read", storedCredentials: "read",
                            ...plan.policy.permissions, commands: true, network: false,
                        },
                    };
                    profilePath = `${plan.profilePath}.${randomUUID()}.process-list.sb`;
                    const command = maybeBuildSandboxCommand({
                        execPath: EXECUTABLE, execArgs: argv, internalHelperExecutable: true,
                        profilePath, policy: helperPolicy,
                    }, { sandboxEnabled: true, explicitSandbox: true });
                    if (!command)
                        throw new Error("process_list sandbox backend unavailable.");
                    file = command.file;
                    fileArgs = command.fileArgs;
                }
                checkExecutable();
                checkAccess();
                const stdout = await run(file, fileArgs, cwd, plan.confined ? plan.policy.home : homedir(), signal);
                const result = parseInventory(stdout, name, limit);
                return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
            }
            finally {
                if (profilePath)
                    await unlink(profilePath).catch((error) => {
                        if (error.code !== "ENOENT")
                            throw error;
                    });
            }
        },
    };
}
