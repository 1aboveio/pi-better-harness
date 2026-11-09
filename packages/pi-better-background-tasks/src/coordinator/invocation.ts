/**
 * How a client launches the standalone coordinator executable.
 *
 * The shipped entrypoint is emitted JavaScript under `generated/`, matching the
 * supervisor runner pattern: Node refuses type stripping under `node_modules`,
 * and the coordinator must work from a standalone package install.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CoordinatorSpawnOptions } from "./protocol.ts";

export interface CoordinatorInvocation {
    execPath: string;
    args: string[];
    entry: string;
}

export function coordinatorEntry(entryPath?: string): string {
    if (entryPath !== undefined) {
        if (!existsSync(entryPath)) throw new Error(`The coordinator executable is missing at ${entryPath}`);
        return entryPath;
    }
    const entry = fileURLToPath(new URL("./generated/coordinator.mjs", import.meta.url));
    if (!existsSync(entry)) {
        throw new Error(
            `The emitted coordinator executable is missing at ${entry}. `
            + "Run `node src/coordinator/emit-runner.mjs` in packages/pi-better-background-tasks and ship src/coordinator/generated/.",
        );
    }
    return entry;
}

export function coordinatorInvocation(
    options: CoordinatorSpawnOptions,
    execPath = process.execPath,
): CoordinatorInvocation {
    const entry = coordinatorEntry(options.entryPath);
    return {
        execPath,
        args: [
            entry,
            "--store", options.storePath,
            "--supervisor", options.supervisorDirectory,
            "--state", options.stateDirectory,
        ],
        entry,
    };
}
