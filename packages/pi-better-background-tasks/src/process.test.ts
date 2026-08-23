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
  // @covers background-task.remote-runner-timeout
  // @level integration
  it("terminates a command that exceeds its run-once timeout", async () => {
    const startedAt = Date.now();

    const result = await runCommandOnce({
      shell: false,
      argv: [process.execPath, "-e", "setInterval(() => {}, 10_000)"],
    }, undefined, 25);

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGTERM");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  // @covers background-task.remote-runner-timeout
  // @level integration
  it("times a command out when its real work outlives the process that was spawned", async () => {
    // The shape the Linux write sandbox produces: `bwrap` forks the command
    // rather than exec'ing it, so the spawned pid is a wrapper and the work —
    // along with the output pipes `close` waits on — belongs to a process a
    // signal to that pid never reaches. Reproduced here with a plain shell,
    // because the defect is in how the timeout terminates, not in bubblewrap.
    const startedAt = Date.now();

    const result = await runCommandOnce({ command: "sleep 30 & wait" }, undefined, 25);

    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

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