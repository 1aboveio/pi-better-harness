/**
 * Canonical paths for one coordinator identity (operation store + supervisor
 * directory). The lock and log live under the user/state directory; the local
 * socket uses a short, fixed Unix root so environment-specific temporary paths
 * cannot split either election or discovery.
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface CoordinatorPaths {
    stateDirectory: string;
    /** Separate election DB; its writer lock is held for the leader lifetime. */
    leaderDb: string;
    /** Diagnostic leader record; not used to decide ownership. */
    lock: string;
    socket: string;
    log: string;
}

function canonicalPath(path: string): string {
    const absolute = resolve(path);
    try {
        return realpathSync.native(absolute);
    } catch {
        const parent = dirname(absolute);
        return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute));
    }
}

export function coordinatorIdentityKey(storePath: string, supervisorDirectory: string): string {
    return createHash("sha256")
        .update(canonicalPath(storePath))
        .update("\0")
        .update(canonicalPath(supervisorDirectory))
        .digest("hex")
        .slice(0, 20);
}

export function coordinatorPaths(
    storePath: string,
    supervisorDirectory: string,
    stateDirectoryOverride?: string,
): CoordinatorPaths {
    const key = coordinatorIdentityKey(storePath, supervisorDirectory);
    const stateRoot = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    const stateDirectory = stateDirectoryOverride && stateDirectoryOverride.trim().length > 0
        ? resolve(stateDirectoryOverride)
        : join(resolve(stateRoot), "background-tasks-coordinator", key);
    const user = process.getuid?.() ?? createHash("sha256").update(homedir()).digest("hex").slice(0, 8);
    // Neither TMPDIR/TMP/TEMP nor the agent/diagnostic directory may partition
    // authority for the same physical store and supervisor.
    const electionDirectory = join(dirname(canonicalPath(storePath)), `.pi-bg-${user}-${key}`);
    const socketDirectory = join("/tmp", `pi-bg-${user}`);
    const socket = process.platform === "win32"
        ? `\\\\.\\pipe\\pi-bg-coordinator-${key}`
        : join(socketDirectory, `${key}.sock`);
    return {
        stateDirectory,
        leaderDb: join(electionDirectory, "leader.sqlite"),
        lock: join(stateDirectory, "leader.lock"),
        socket,
        log: join(stateDirectory, "coordinator.log"),
    };
}

export function coordinatorSocketPath(storePath: string, supervisorDirectory: string): string {
    return coordinatorPaths(storePath, supervisorDirectory).socket;
}
