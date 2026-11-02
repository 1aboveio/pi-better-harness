import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseStepGateFailure, runCommandOnce, stepGateScript } from "./process.js";

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

  it("counts capture overflow above 1 MiB instead of silently dropping the tail", async () => {
    const result = await runCommandOnce({
      argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(1_200_012) + 'END_MARKER')"],
      shell: false,
    });
    expect(result.captureTruncated).toBe(true);
    expect(result.stdoutDiscardedBytes).toBeGreaterThan(1_200_012 - 1024 * 1024);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024 * 1024);
    expect(result.stdout).not.toContain("END_MARKER");
    expect(result.stdout.startsWith("x")).toBe(true);
  });

  it("discards a code point split across chunks at the cap instead of decoding U+FFFD", async () => {
    const script = [
      "process.stdout.write(Buffer.from([0x61, 0xf0, 0x9f]));",
      "setTimeout(() => process.stdout.write(Buffer.from([0x98, 0x80, 0x62])), 60);",
    ].join("");
    const result = await runCommandOnce({ argv: [process.execPath, "-e", script], shell: false }, 4);
    expect(result.stdout).toBe("a");
    expect(result.stdout).not.toContain("\uFFFD");
    expect(result.stdoutDiscardedBytes).toBe(5);
    expect(result.captureTruncated).toBe(true);
  });

  it("generates a gate script that ends the command at its first unhandled failing step", async () => {
    const script = stepGateScript("bg_script_1");
    // Bash errexit is the rule; errtrace lets the trap name the step inside functions.
    expect(script).toMatch(/^set -e$/m);
    expect(script).toMatch(/^set -E$/m);
    expect(script).toContain("trap '__pi_step_gate_record' ERR");
    expect(script).toContain("trap '__pi_step_gate_finish' EXIT");
    // Only main-shell failures are recorded, so a status bash discards is never claimed.
    expect(script).toContain('[ "${BASH_SUBSHELL:-0}" -eq 0 ]');
    // The operator's command travels in its own variable and is eval'd, never concatenated.
    expect(script).toContain('eval "${PI_BG_STEP_GATE_COMMAND}"');
    expect(script).toContain("__pi_step_gate_id='bg_script_1'");

    // The review's masked function: a failing step inside an ordinary function followed by
    // a summary command that would otherwise make the shell (and the task) exit 0.
    const result = await runCommandOnce({
      command: script,
      env: { PI_BG_STEP_GATE_COMMAND: "validate() { bash -c 'exit 8'; echo summary; }; validate; echo done" },
    });
    expect(result.exitCode).toBe(8);
    expect(result.stdout).not.toContain("summary");
    expect(result.stdout).not.toContain("done");
    expect(result.stderr).toContain("--- step gate [bg_script_1]: first failing step exit=8; shell exit=8: bash -c 'exit 8' ---");
    expect(parseStepGateFailure(result.stderr, "bg_script_1")).toEqual({
      stepExitCode: 8,
      shellExitCode: 8,
      command: "bash -c 'exit 8'",
    });
  });

  it("fails closed when a gate script is launched without its command", async () => {
    const result = await runCommandOnce({ command: stepGateScript("bg_script_2"), env: { PI_BG_STEP_GATE_COMMAND: "" } });
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toContain("the gated command was not provided; nothing ran");
  });

  it("reads a step gate verdict only for the task that wrote it", () => {
    const log = [
      "ordinary output",
      "--- step gate [bg_other]: first failing step exit=4; shell exit=0: make test ---",
      "--- step gate [bg_mine]: first failing step exit=8; shell exit=0: ctest --output-on-failure ---",
      "--- exit 2026-01-01T00:00:00.000Z code=8 signal=null ---",
    ].join("\r\n");

    expect(parseStepGateFailure(log, "bg_mine")).toEqual({
      stepExitCode: 8,
      shellExitCode: 0,
      command: "ctest --output-on-failure",
    });
    expect(parseStepGateFailure(log, "bg_absent")).toBeUndefined();
  });

  it("bounds the failing step recorded in task metadata without losing the exit code", () => {
    const longCommand = `grep -q ${"x".repeat(500)} ./huge-file`;
    const verdict = parseStepGateFailure(`--- step gate [bg_long]: first failing step exit=2; shell exit=0: ${longCommand} ---`, "bg_long");
    expect(verdict?.stepExitCode).toBe(2);
    expect(verdict?.command.length).toBe(160);
    expect(verdict?.command.endsWith("…")).toBe(true);
    expect(verdict?.command.startsWith("grep -q xxx")).toBe(true);
  });

  it("does not split a multibyte UTF-8 character at the capture cap", async () => {
    const { utf8PrefixLength } = await import("./process.js");
    const buffer = Buffer.from("é");
    expect(utf8PrefixLength(buffer, 1)).toBe(0);
    expect(utf8PrefixLength(buffer, 2)).toBe(2);
  });
});
