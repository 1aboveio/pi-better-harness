// The suite never shares a task registry with other runs on the machine (#324):
// vitest.config.ts preloads src/test-support/isolate-registry.ts.
import { basename, dirname } from "node:path";
import { describe, expect, inject, it } from "vitest";
import { baseDir } from "./registry.js";

describe("test registry isolation", () => {
  it("resolves the task registry inside this file's private TMPDIR", () => {
    expect(basename(dirname(baseDir()))).toMatch(/^pi-bg-tasks-test-/);
    expect(dirname(baseDir())).toBe(process.env.TMPDIR);
  });

  it("nests that TMPDIR in the per-run root that globalSetup removes, so fully skipped files leak nothing", () => {
    const root = inject("isolatedTmpRoot");
    expect(basename(root)).toMatch(/^pi-bg-tasks-test-run-/);
    expect(dirname(process.env.TMPDIR!)).toBe(root);
  });
});
