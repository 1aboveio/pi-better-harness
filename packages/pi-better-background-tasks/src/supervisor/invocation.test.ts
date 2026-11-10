import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { supervisorNodeExecPath, supervisorRunnerInvocation } from "./invocation.js";

const realExecPath = process.execPath;
let scratch: string;

function fakePiExecPath(): void {
  // A standalone pi >= 1.5 binary embeds a runtime but is not Node.js.
  Object.defineProperty(process, "execPath", {
    value: join(scratch, "pi"),
    configurable: true,
  });
}

function restoreExecPath(): void {
  Object.defineProperty(process, "execPath", {
    value: realExecPath,
    configurable: true,
  });
}

function writeNodeOnPath(directory: string): string {
  const executable = join(directory, process.platform === "win32" ? "node.exe" : "node");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o755);
  return executable;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "bg-invocation-"));
});

afterEach(() => {
  restoreExecPath();
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

describe("supervisorNodeExecPath", () => {
  it("keeps using the current executable when it is a real Node.js binary", () => {
    // Under vitest, process.execPath is the test runner's Node.js.
    expect(supervisorNodeExecPath()).toBe(process.execPath);
  });

  it("prefers the explicit nodePath argument over every other source", () => {
    fakePiExecPath();
    vi.stubEnv("PI_BETTER_BACKGROUND_TASKS_NODE", "/opt/other/node");
    expect(supervisorNodeExecPath("/explicit/node")).toBe("/explicit/node");
  });

  it("honors PI_BETTER_BACKGROUND_TASKS_NODE under a non-Node host", () => {
    fakePiExecPath();
    vi.stubEnv("PI_BETTER_BACKGROUND_TASKS_NODE", "/opt/env/node");
    expect(supervisorNodeExecPath()).toBe("/opt/env/node");
  });

  it("ignores an empty PI_BETTER_BACKGROUND_TASKS_NODE override", () => {
    fakePiExecPath();
    vi.stubEnv("PI_BETTER_BACKGROUND_TASKS_NODE", "");
    const binDir = join(scratch, "bin");
    mkdirSync(binDir);
    const node = writeNodeOnPath(binDir);
    vi.stubEnv("PATH", binDir);
    expect(supervisorNodeExecPath()).toBe(node);
  });

  it.skipIf(process.platform === "win32")(
    "resolves a real Node.js executable from PATH under a standalone pi binary",
    () => {
      fakePiExecPath();
      const binDir = join(scratch, "bin");
      mkdirSync(binDir);
      const node = writeNodeOnPath(binDir);
      vi.stubEnv("PATH", [join(scratch, "empty"), binDir].join(":"));
      expect(supervisorNodeExecPath()).toBe(node);
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails with a actionable message when no Node.js is reachable",
    () => {
      fakePiExecPath();
      vi.stubEnv("PATH", join(scratch, "empty"));
      expect(() => supervisorNodeExecPath()).toThrow(/needs a real Node.js executable/);
    },
  );
});

describe("supervisorRunnerInvocation", () => {
  it("launches the emitted runner under the resolved Node.js executable", () => {
    const invocation = supervisorRunnerInvocation(scratch, "bg_task");
    expect(invocation.args).toEqual([invocation.entry, scratch, "bg_task"]);
    expect(invocation.entry).toContain("generated");
    // The test process runs under a real Node.js, so it stays the exec path.
    expect(invocation.execPath).toBe(process.execPath);
  });
});
