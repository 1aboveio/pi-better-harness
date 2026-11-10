import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { supervisorNodeExecPath } from "./invocation.ts";

const EXE = process.platform === "win32" ? "node.exe" : "node";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("supervisorNodeExecPath", () => {
  it("returns an explicit nodePath option unchanged", () => {
    expect(supervisorNodeExecPath("/opt/explicit/node")).toBe("/opt/explicit/node");
  });

  it("honors PI_BETTER_BACKGROUND_TASKS_NODE over the PATH fallback", () => {
    vi.stubEnv("PI_BETTER_BACKGROUND_TASKS_NODE", "/opt/from-env/node");
    vi.stubEnv("PATH", "/nonexistent");
    expect(supervisorNodeExecPath()).toBe("/opt/from-env/node");
  });

  it("resolves the first real node on PATH when the current executable is not Node.js", () => {
    const dir = mkdtempSync(join(tmpdir(), "bgt-invocation-"));
    try {
      const node = join(dir, EXE);
      writeFileSync(node, process.platform === "win32" ? "" : "#!/bin/sh\n");
      vi.stubEnv("PI_BETTER_BACKGROUND_TASKS_NODE", "");
      vi.stubEnv("PATH", `/nonexistent${process.platform === "win32" ? ";" : ":"}${dir}`);
      vi.spyOn(process, "execPath", "get").mockReturnValue("/opt/pi-coding-agent/pi");
      expect(supervisorNodeExecPath()).toBe(node);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a non-Node executable when no node exists anywhere", () => {
    vi.stubEnv("PI_BETTER_BACKGROUND_TASKS_NODE", "");
    vi.stubEnv("PATH", "/nonexistent");
    vi.spyOn(process, "execPath", "get").mockReturnValue("/opt/pi-coding-agent/pi");
    expect(() => supervisorNodeExecPath()).toThrow(/needs a real Node\.js executable/);
  });
});
