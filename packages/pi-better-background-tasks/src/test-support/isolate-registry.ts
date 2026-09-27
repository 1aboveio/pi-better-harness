/**
 * Vitest setup: each test file gets a private TMPDIR, so the task registry
 * (`join(os.tmpdir(), "pi-better-background-tasks-vitest-<pool>")`) is never
 * shared with another run on the machine (#324). The pool-id directories used to
 * live in the machine's real TMPDIR, where concurrent runs from other checkouts
 * collided and list tests saw foreign or half-written task records.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, inject } from "vitest";
process.env.PI_SANDBOX_RECOVERY_SNAPSHOT ??= "off"; // never create real APFS snapshots from tests

// The per-run root from isolate-registry-root.ts is removed at the end of the run,
// which also covers files whose tests are all skipped (their afterAll never runs).
const root = inject("isolatedTmpRoot") ?? realpathSync(tmpdir());
const isolated = realpathSync(mkdtempSync(join(root, "pi-bg-tasks-test-")));
process.env.TMPDIR = isolated;
process.env.TMP = isolated;
process.env.TEMP = isolated;

afterAll(() => {
  try { rmSync(isolated, { recursive: true, force: true }); } catch { /* best-effort: a child may still hold a file */ }
});
