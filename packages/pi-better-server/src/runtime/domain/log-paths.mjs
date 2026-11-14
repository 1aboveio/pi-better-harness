import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/** Root of the VOLATILE runtime registry, deliberately OUTSIDE any repo. */
export function baseDir() {
    return join(realpathSync(tmpdir()), "pi-better-subagents");
}
export function runDir(id) {
    return join(baseDir(), "runs", id);
}
export function logPathFor(id) {
    return join(runDir(id), "output.log");
}
