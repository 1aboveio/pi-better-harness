/**
 * #619: a chained shell command reports only its last command's exit status, so a
 * failing validation step followed by summary commands reads as success at the
 * status surface. `require_successful_steps` opts into a step gate: bash reports a
 * failing step and the task fails with it, while ordinary shell semantics stay
 * (no `set -e`, every step still runs, handled failures are not gate failures).
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatCallbackFacts, formatLaunch, formatStatus } from "./output.js";
import { readMeta, taskDir, tasksDir } from "./registry.js";
import { spawnTask, startWatchTask, type SpawnTaskParams } from "./runtime.js";
import type { BackgroundTaskMeta } from "./types.js";

const pi = { sendUserMessage: async () => undefined } as unknown as ExtensionAPI;
const origin = { cwd: mkdtempSync(join(tmpdir(), "bg-step-gate-")), sessionId: "step-gate" };
const launched: string[] = [];

/** Task ids in this file's isolated registry, without assuming the directory exists yet. */
function taskCount(): number {
  return existsSync(tasksDir()) ? readdirSync(tasksDir()).length : 0;
}

afterAll(() => rmSync(origin.cwd, { recursive: true, force: true }));

afterEach(() => {
  for (const id of launched.splice(0)) rmSync(taskDir(id), { recursive: true, force: true });
  if (!existsSync(tasksDir())) return;
  for (const entry of readdirSync(tasksDir()).filter((name) => name.startsWith("bg_"))) {
    if (readMeta(entry)?.callbackOrigin?.sessionId === origin.sessionId) rmSync(taskDir(entry), { recursive: true, force: true });
  }
});

async function waitTerminal(id: string, timeoutMs = 20_000): Promise<BackgroundTaskMeta> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const meta = readMeta(id);
    if (meta && meta.status !== "running") return meta;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`task ${id} never reached a terminal status: ${JSON.stringify(readMeta(id))}`);
}

async function run(command: string, extra: Record<string, unknown> = {}): Promise<BackgroundTaskMeta> {
  const meta = spawnTask(pi, { command, callback: false, cwd: origin.cwd, ...extra } as SpawnTaskParams, origin.cwd, origin);
  launched.push(meta.id);
  return waitTerminal(meta.id);
}

function statusText(meta: BackgroundTaskMeta): string {
  return formatStatus({ id: meta.id, meta, found: true, readable: true }, { maxBytes: 2000 });
}

describe("opt-in step gate (#619)", () => {
  it("fails a chained command whose earlier step failed even though the last command exits 0", async () => {
    const terminal = await run("bash -c 'exit 8'\necho summary ok\necho done", { require_successful_steps: true });

    expect(terminal.status).toBe("failed");
    // The real process exit is the failing step's code, not the trailing command's 0.
    expect(terminal.lastExitCode).toBe(8);
    expect(terminal.requireSuccessfulSteps).toBe(true);
    expect(terminal.stepGateFailure).toEqual({
      stepExitCode: 8,
      shellExitCode: 0,
      command: "bash -c 'exit 8'",
    });
    // Ordinary shell semantics: the steps after the failure still ran.
    const log = readFileSync(terminal.logPath, "utf8");
    expect(log).toContain("summary ok");
    expect(log).toContain("done");
    expect(log).toContain(`--- step gate [${terminal.id}]: first failing step exit=8; shell exit=0: bash -c 'exit 8' ---`);
  });

  it("surfaces the failing step at the status and callback surfaces", async () => {
    const terminal = await run("bash -c 'exit 8'\necho summary ok", { require_successful_steps: true });

    const status = statusText(terminal);
    expect(status).toContain(`Background task ${terminal.id} is failed`);
    expect(status).toContain("exit=8 (step gate)");
    expect(status).toContain("step gate: bash -c 'exit 8' exited 8; the shell's own exit was 0");
    expect(status).not.toContain("is succeeded");

    const callback = formatCallbackFacts(terminal);
    expect(callback.outcome).toBe("failed");
    expect(callback.decision).toContain("step gate: bash -c 'exit 8' exited 8");
    expect(callback.failureRows?.join("\n")).toContain("step gate");
  });

  it("keeps the shell's own exit when it already failed and still names the first failing step", async () => {
    const terminal = await run("bash -c 'exit 8'\nbash -c 'exit 3'", { require_successful_steps: true });

    expect(terminal.status).toBe("failed");
    expect(terminal.lastExitCode).toBe(3);
    expect(terminal.stepGateFailure).toMatchObject({ stepExitCode: 8, shellExitCode: 3 });
    expect(statusText(terminal)).toContain("exit=3 (step gate)");
    expect(statusText(terminal)).toContain("exited 8; the shell's own exit was 3");
  });

  it("does not turn an explicit exit 0 into a green verdict after a failed step", async () => {
    const terminal = await run("bash -c 'exit 8'\nexit 0", { require_successful_steps: true });

    expect(terminal.status).toBe("failed");
    expect(terminal.lastExitCode).toBe(8);
    expect(terminal.stepGateFailure).toMatchObject({ stepExitCode: 8, shellExitCode: 0 });
  });

  it("leaves an all-passing gated command succeeded", async () => {
    const terminal = await run("echo one\ntrue\necho two", { require_successful_steps: true });

    expect(terminal.status).toBe("succeeded");
    expect(terminal.lastExitCode).toBe(0);
    expect(terminal.stepGateFailure).toBeUndefined();
    const status = statusText(terminal);
    expect(status).toContain(`Background task ${terminal.id} is succeeded`);
    expect(status).not.toContain("step gate:");
  });

  it("does not flag a failure the command handles itself", async () => {
    const terminal = await run("bash -c 'exit 8' || echo handled\nif bash -c 'exit 9'; then :; fi\necho done", { require_successful_steps: true });

    expect(terminal.status).toBe("succeeded");
    expect(terminal.stepGateFailure).toBeUndefined();
    expect(readFileSync(terminal.logPath, "utf8")).toContain("handled");
  });

  it("does not treat a process substitution's discarded status as a failing step", async () => {
    const terminal = await run("cat < <(grep -q needle ./missing-file)\necho done", { require_successful_steps: true });

    expect(terminal.status).toBe("succeeded");
    expect(terminal.stepGateFailure).toBeUndefined();
  });

  it("keeps default shell semantics when the gate is not requested", async () => {
    const terminal = await run("bash -c 'exit 8'\necho summary ok", {});

    // Unchanged pre-#619 behavior: the shell's own exit status is the verdict.
    expect(terminal.status).toBe("succeeded");
    expect(terminal.lastExitCode).toBe(0);
    expect(terminal.requireSuccessfulSteps).toBeUndefined();
    expect(terminal.stepGateFailure).toBeUndefined();
    const status = statusText(terminal);
    expect(status).toContain("is succeeded");
    expect(status).not.toContain("step gate");
  });

  it("announces the gate at launch so the changed semantics are visible", async () => {
    const meta = spawnTask(pi, { command: "true", callback: false, cwd: origin.cwd, require_successful_steps: true }, origin.cwd, origin);
    launched.push(meta.id);
    expect(formatLaunch(meta)).toContain("step gate: on; a failing step is reported even when a later command exits 0");
    await waitTerminal(meta.id);
  });

  it("refuses the gate where it cannot observe steps, before any task state exists", () => {
    const before = taskCount();
    expect(() => spawnTask(pi, { command: "true", shell: false, argv: [process.execPath, "-e", ""], callback: false, cwd: origin.cwd, require_successful_steps: true }, origin.cwd))
      .toThrow(/Invalid step gate: require_successful_steps needs a shell command/);
    expect(() => spawnTask(pi, { command: "true", callback: false, cwd: origin.cwd, ssh: { host: "example.test" }, require_successful_steps: true }, origin.cwd))
      .toThrow(/Invalid step gate: require_successful_steps is local-only/);
    expect(() => startWatchTask(pi, {
      command: "true", callback: false, interval_seconds: 60, timeout_seconds: 5, cwd: origin.cwd,
      success_when: { type: "exit_code", equals: 0 }, require_successful_steps: true,
    }, origin.cwd)).toThrow(/Invalid step gate: require_successful_steps is for a spawned shell command/);
    expect(taskCount()).toBe(before);
  });
});
