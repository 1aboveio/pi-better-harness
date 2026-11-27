/**
 * Test preload: give every test process its own subagent registry (#324).
 *
 * The registry lives at `join(realpath(os.tmpdir()), "pi-better-subagents")`
 * (`registry.ts` `baseDir()`). Without this preload a test run reads the
 * machine's real registry — gigabytes of unrelated runs on a working laptop —
 * which made `subagent_list`/`subagent_output` tests slow and let them pick up
 * runs that belong to a live Pi session.
 *
 * `node --test` runs each test file in its own child process and forwards
 * `--import` flags, so loading this module with `--import` points TMPDIR (and
 * TMP/TEMP) at a fresh private directory per test file before any product module
 * computes a path. Production defaults are unchanged: only the test scripts in
 * package.json load this file. Tests that already set TMPDIR themselves keep
 * working; their fixtures now nest inside the private directory.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.PI_SANDBOX_RECOVERY_SNAPSHOT ??= "off"; // never create real APFS snapshots from tests

const machineTmp = realpathSync(tmpdir());
const isolated = realpathSync(mkdtempSync(join(machineTmp, "pi-subagents-test-")));

process.env.PI_SUBAGENTS_TEST_MACHINE_TMPDIR = machineTmp;
process.env.PI_SUBAGENTS_TEST_ISOLATED_TMPDIR = isolated;
process.env.TMPDIR = isolated;
process.env.TMP = isolated;
process.env.TEMP = isolated;
// Durable subagent state (native sessions and compact attempt records) lives in
// the Pi agent directory, not TMPDIR. Point both at this private root so no test
// reads or writes the machine's real `~/.pi/agent/subagents`. Tests that need
// their own layout override these after this preload runs.
process.env.PI_CODING_AGENT_DIR = join(isolated, "agent");
process.env.PI_SUBAGENT_DURABLE_DIR = join(isolated, "durable-subagents");

process.on("exit", () => {
    // Only the process that created the directory removes it; children that
    // inherit the environment do not re-run this preload unless they import it.
    try { rmSync(isolated, { recursive: true, force: true }); } catch { /* best-effort */ }
});
