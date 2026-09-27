// The suite never shares a task registry with other runs on the machine (#324):
// vitest.config.ts preloads src/test-support/isolate-registry.ts.
import { basename, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { baseDir } from "./registry.js";

describe("test registry isolation", () => {
  it("resolves the task registry inside this file's private TMPDIR", () => {
    expect(basename(dirname(baseDir()))).toMatch(/^pi-bg-tasks-test-/);
    expect(dirname(baseDir())).toBe(process.env.TMPDIR);
  });
});
