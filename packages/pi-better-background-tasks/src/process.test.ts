import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommandOnce } from "./process.js";

const originalShell = process.env.SHELL;
const tempDirs: string[] = [];

afterEach(() => {
  if (originalShell === undefined) {
    Reflect.deleteProperty(process.env, "SHELL");
  } else {
    process.env.SHELL = originalShell;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("process shell execution", () => {
  it("uses a deterministic bash-compatible shell instead of the user's login shell", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-bg-shell-"));
    tempDirs.push(dir);
    const fakeShell = join(dir, "fake-shell");
    writeFileSync(fakeShell, "#!/bin/sh\necho unexpected login shell >&2\nexit 42\n");
    chmodSync(fakeShell, 0o755);
    process.env.SHELL = fakeShell;

    const result = await runCommandOnce({ command: "status=ok; printf '%s\\n' \"$status\"" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok\n");
    expect(result.stderr).not.toContain("unexpected login shell");
  });
});