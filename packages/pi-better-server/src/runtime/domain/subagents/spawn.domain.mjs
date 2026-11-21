// Generated fixed launch domain from packages/pi-better-subagents/spawn.ts. Do not edit directly.
/**
 * Detached child-process spawn with file-backed output.
 *
 * Self-contained (adapted from the pi-patty-bg-tasks process model): the kernel
 * writes the child's stdout+stderr straight to a log file with zero JS in the
 * data path, and the child is `detached` + `unref`'d so it is fully isolated
 * from the foreground pi turn. Progress is read back later by tailing the file.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
/** Spawn `file fileArgs`, streaming stdout+stderr to `logPath`. Detached. */
export function spawnDetached(args) {
    mkdirSync(dirname(args.logPath), { recursive: true });
    const outFd = openSync(args.logPath, "w");
    let proc;
    try {
        proc = spawn(args.file, args.fileArgs, {
            stdio: ["ignore", outFd, outFd],
            cwd: args.cwd,
            detached: true,
            env: { ...process.env, ...(args.env ?? {}) },
        });
    }
    finally {
        closeSync(outFd);
    }
    // Build the exit promise and attach the 'error' listener BEFORE any throw,
    // so an async spawn failure (ENOENT / EMFILE / EAGAIN) can never surface as
    // an uncaught exception that takes the foreground pi down.
    const exit = new Promise((resolve) => {
        proc.on("close", (code) => resolve(code));
        proc.on("error", () => resolve(1));
    });
    if (!proc.pid) {
        try {
            unlinkSync(args.logPath);
        }
        catch { /* best-effort */ }
        throw new Error("Failed to spawn subagent process");
    }
    const pid = proc.pid;
    proc.unref();
    return { pid, exit };
}
/** Kill an entire process group via negative-PID signal; fall back to the PID. */
export function killProcessTree(pid, signal = "SIGTERM") {
    if (typeof pid !== "number" || pid <= 0)
        return;
    try {
        process.kill(-pid, signal);
    }
    catch {
        try {
            process.kill(pid, signal);
        }
        catch { /* already dead */ }
    }
}
/** Cheap liveness probe via signal 0. */
export function processExists(pid) {
    if (typeof pid !== "number" || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === "EPERM";
    }
}
