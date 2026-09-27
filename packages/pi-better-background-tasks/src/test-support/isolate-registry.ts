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
import { afterAll } from "vitest";

const isolated = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "pi-bg-tasks-test-")));
process.env.TMPDIR = isolated;
process.env.TMP = isolated;
process.env.TEMP = isolated;

afterAll(() => {
  try { rmSync(isolated, { recursive: true, force: true }); } catch { /* best-effort: a child may still hold a file */ }
});
