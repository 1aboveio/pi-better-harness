// Generated fixed launch domain from packages/pi-better-sandbox/shared-task-process-identity.ts. Do not edit directly.
// Generated from packages/task-sandbox/process-identity.ts. Do not edit directly.
/** Darwin-only, fixed ps identity compatibility for confined task descendants. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compileWritePolicy } from "./shared-sandbox-core.domain.mjs";
// This is trusted implementation source, never interpolated with task input.
const SOURCE = String.raw `
#include <libproc.h>
#include <sys/proc_info.h>
#include <unistd.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
static int refuse(const char *reason) {
    fprintf(stderr, "Sandbox process identity: %s (errno=%d). Supported: ps -p PID -o lstart= -o comm=\n", reason, errno);
    return 1;
}
int main(int argc, char **argv) {
    if (argc != 7 || strcmp(argv[1], "-p") || strcmp(argv[3], "-o") ||
        strcmp(argv[4], "lstart=") || strcmp(argv[5], "-o") || strcmp(argv[6], "comm=")) return refuse("unsupported arguments");
    for (const char *p = argv[2]; *p; p++) if (*p < '0' || *p > '9') return refuse("invalid PID");
    char *end; errno = 0;
    long pid = strtol(argv[2], &end, 10);
    if (errno || end == argv[2] || *end || pid <= 0 || pid > INT_MAX) return refuse("invalid PID");
    struct proc_bsdinfo a = {0}, b = {0};
    if (proc_pidinfo((int)pid, PROC_PIDTBSDINFO, 0, &a, sizeof a) != sizeof a) return refuse("identity unavailable");
    if (a.pbi_uid != getuid() || a.pbi_ruid != getuid()) return refuse("different user");
    if (a.pbi_pid != (unsigned int)pid || !a.pbi_start_tvsec || a.pbi_start_tvusec >= 1000000) return refuse("invalid identity");
    char path[PROC_PIDPATHINFO_MAXSIZE] = {0}, confirmed[PROC_PIDPATHINFO_MAXSIZE] = {0};
    if (proc_pidpath((int)pid, path, sizeof path) <= 0 || path[0] != '/') return refuse("path unavailable");
    for (const unsigned char *p = (unsigned char *)path; *p; p++) if (*p < 32 || *p == 127) return refuse("invalid path");
    if (proc_pidinfo((int)pid, PROC_PIDTBSDINFO, 0, &b, sizeof b) != sizeof b) return refuse("identity unavailable");
    if (a.pbi_pid != b.pbi_pid || a.pbi_uid != b.pbi_uid || a.pbi_ruid != b.pbi_ruid || a.pbi_ppid != b.pbi_ppid ||
        a.pbi_start_tvsec != b.pbi_start_tvsec || a.pbi_start_tvusec != b.pbi_start_tvusec) return refuse("identity changed");
    if (proc_pidpath((int)pid, confirmed, sizeof confirmed) <= 0 || strcmp(path, confirmed)) return refuse("executable changed");
    time_t seconds = (time_t)a.pbi_start_tvsec;
    struct tm started; char timestamp[64];
    if (!localtime_r(&seconds, &started) || !strftime(timestamp, sizeof timestamp, "%a %b %e %H:%M:%S %Y", &started)) return refuse("invalid start time");
    printf("%-28s %s\n", timestamp, path);
    return 0;
}
`;
const UNAVAILABLE = '#!/bin/sh\nprintf "%s\\n" "Sandbox process identity unavailable: trusted helper build failed; check Xcode Command Line Tools and restart the session. No unconfined ps fallback was used." >&2\nexit 126\n';
const helpers = new Map();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
// The trusted host compiles fixed source, with fixed argv and a minimal env.
// The resulting helper, not the compiler, runs as the task under Seatbelt.
async function compile(source, output) {
    return new Promise((resolve, reject) => {
        const child = spawn("/usr/bin/clang", ["-Wall", "-Wextra", "-Werror", "-O2", source, "-o", output], {
            detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
            env: { PATH: "/usr/bin:/bin", HOME: "/var/empty", LC_ALL: "C" },
        });
        let failure;
        let size = 0;
        const stop = (error) => {
            if (failure)
                return;
            failure = error;
            if (child.pid)
                try {
                    process.kill(-child.pid, "SIGKILL");
                }
                catch {
                    child.kill("SIGKILL");
                }
        };
        const timer = setTimeout(() => stop(new Error("Process identity compiler timed out")), 15000);
        for (const pipe of [child.stdout, child.stderr])
            pipe.on("data", (chunk) => {
                size += chunk.length;
                if (size > 65536)
                    stop(new Error("Process identity compiler output exceeded limit"));
            });
        child.on("error", error => { failure ??= error; });
        child.on("close", code => {
            clearTimeout(timer);
            if (failure || code !== 0)
                reject(failure ?? new Error("Process identity compiler failed"));
            else
                resolve();
        });
    });
}
async function build(parent) {
    const directory = await mkdtemp(join(parent, "process-identity-"));
    const source = join(directory, "identity.c"), binary = join(directory, "ps");
    try {
        await writeFile(source, SOURCE, { mode: 0o600, flag: "wx" });
        try {
            await compile(source, binary);
        }
        catch {
            // Preserve all other commands when the optional compiler is absent.
            // Identity requests still fail explicitly, never via a broader ps.
            await rm(binary, { force: true });
            await writeFile(binary, UNAVAILABLE, { mode: 0o700, flag: "wx" });
        }
        await chmod(binary, 0o700);
        return { directory, digest: digest(await readFile(binary)) };
    }
    catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
    }
    finally {
        await rm(source, { force: true });
    }
}
export async function processIdentityDirectory(plan) {
    if (process.platform !== "darwin" || plan.policy.permissions?.processAccess !== "read")
        return undefined;
    const parent = await realpath(dirname(plan.profilePath));
    // The controller's control directory must be protected even with broad writes.
    const policy = compileWritePolicy(plan.policy);
    if (!policy.denyWrite.some(root => parent === root || parent.startsWith(`${root}/`))) {
        throw new Error("Sandbox process identity requires a task-write-protected control directory.");
    }
    let pending = helpers.get(parent);
    if (!pending) {
        pending = build(parent);
        helpers.set(parent, pending);
        void pending.catch(() => { if (helpers.get(parent) === pending)
            helpers.delete(parent); });
    }
    const helper = await pending;
    const binary = join(helper.directory, "ps");
    const info = await lstat(binary);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o7777) !== 0o700 ||
        await realpath(helper.directory) !== helper.directory || digest(await readFile(binary)) !== helper.digest) {
        throw new Error("Sandbox process identity helper changed; restart the session.");
    }
    return helper.directory;
}
