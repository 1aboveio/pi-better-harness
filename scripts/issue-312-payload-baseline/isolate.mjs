/**
 * Hermetic process env for issue #312 payload measurements.
 *
 * Registries resolve under os.tmpdir() (`pi-better-subagents`,
 * `pi-better-background-tasks`). Isolate TMPDIR before importing those
 * modules. Freeze Date.now so elapsed/status timestamps (and therefore
 * UTF-8 hashes) are deterministic across a single capture.
 */
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Frozen clock used by seeded metadata and live elapsed formatting. */
export const FROZEN_NOW = 1_700_000_000_000;

export function isolateHarnessEnv({ stable = false } = {}) {
    const tmp = realpathSync(tmpdir());
    const root = stable
        ? join(tmp, "issue-312-payload-baseline")
        : mkdtempSync(join(tmp, "issue-312-payload-baseline-"));
    if (stable) {
        rmSync(root, { recursive: true, force: true });
        mkdirSync(root, { recursive: true });
    }
    process.env.TMPDIR = root;
    process.env.TMP = root;
    process.env.TEMP = root;
    delete process.env.VITEST_POOL_ID;

    const originalNow = Date.now;
    Date.now = () => FROZEN_NOW;

    return {
        root,
        frozenNow: FROZEN_NOW,
        wallClockMs: () => originalNow.call(Date),
        restore() {
            Date.now = originalNow;
            rmSync(root, { recursive: true, force: true });
        },
    };
}
