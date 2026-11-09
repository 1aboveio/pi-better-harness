/**
 * Standalone coordinator entrypoint.
 *
 * This TS module is the source of the emitted JavaScript closure under
 * `generated/` (see `emit-runner.mjs`). It is spawned detached by a Pi client on
 * first need; concurrent starters race on one verified lock, and every loser
 * exits quietly so the winner serves all clients.
 */
import { runCoordinatorProcess } from "./server.ts";

function argument(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

const storePath = argument("store");
const supervisorDirectory = argument("supervisor");
const stateDirectory = argument("state");
if (!storePath || !supervisorDirectory || !stateDirectory) {
    process.stderr.write("usage: coordinator.mjs --store <path> --supervisor <dir> --state <dir>\n");
    process.exit(2);
}

runCoordinatorProcess({
    storePath,
    supervisorDirectory,
    stateDirectory,
    logger: (line) => {
        try { process.stderr.write(`${new Date().toISOString()} ${line}\n`); } catch { /* diagnostics only */ }
    },
}).then((code) => {
    if (code !== 0) process.exit(code);
}).catch((error) => {
    process.stderr.write(`coordinator failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
});
