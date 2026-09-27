/**
 * Test preload for the root `scripts/*.test.mjs` suites (#332, same approach as
 * #324's `packages/pi-better-subagents/tests/isolate-registry.mjs`).
 *
 * The subagent and background-task registries live under `os.tmpdir()`. The
 * navigator TUI e2e seeds runs there and launches a real Pi that indexes them
 * (`by-parent-active/<pid>/…`), so without this preload every run left markers
 * in the machine's real registry. Loading this module with `--import` points
 * TMPDIR (and TMP/TEMP) at a fresh private directory for the test process and
 * everything it launches, and removes it when the process exits.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.PI_SANDBOX_RECOVERY_SNAPSHOT ??= "off"; // never create real APFS snapshots from tests

// `node --test` re-runs this preload in each test-file child, which inherits the
// runner's TMPDIR; keep pointing at the real machine TMPDIR, not the runner's copy.
const machineTmp = process.env.PI_SCRIPTS_TEST_MACHINE_TMPDIR ?? realpathSync(tmpdir());
const isolated = realpathSync(mkdtempSync(join(machineTmp, "pi-scripts-test-")));

process.env.PI_SCRIPTS_TEST_MACHINE_TMPDIR = machineTmp;
process.env.PI_SCRIPTS_TEST_ISOLATED_TMPDIR = isolated;
process.env.TMPDIR = isolated;
process.env.TMP = isolated;
process.env.TEMP = isolated;

function cleanUp() {
  // Only the process that created the directory removes it.
  try { rmSync(isolated, { recursive: true, force: true }); } catch { /* best-effort */ }
}

process.on("exit", cleanUp);
// A signal skips "exit" handlers: clean up, then re-raise so the process still
// dies of the signal (and node --test reports it as such).
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    cleanUp();
    process.kill(process.pid, signal);
  });
}
