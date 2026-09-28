/**
 * Vitest globalSetup: one parent directory for every test file's private
 * TMPDIR (#324, #332). `isolate-registry.ts` creates each file's directory
 * inside it and removes it in `afterAll`, but vitest runs no hooks for a file
 * whose tests are all skipped, so that file's directory used to leak. The
 * teardown here removes the whole parent once the run ends, skipped files
 * included.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    isolatedTmpRoot: string;
  }
}

export default function setup(project: TestProject): () => void {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "pi-bg-tasks-test-run-")));
  project.provide("isolatedTmpRoot", root);
  return () => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort: a child may still hold a file */ }
  };
}
