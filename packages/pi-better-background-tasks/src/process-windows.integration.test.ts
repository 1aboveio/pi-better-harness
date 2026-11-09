import { readFileSync, rmSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDefaultShell } from "./process.js";
import { readMeta, taskDir } from "./registry.js";
import { spawnTask } from "./runtime.js";

const windowsDescribe = process.platform === "win32" ? describe : describe.skip;
const taskIds: string[] = [];
const originalShell = process.env.PI_BETTER_BACKGROUND_TASKS_SHELL;
const pi = {} as ExtensionAPI;

afterEach(() => {
  if (originalShell === undefined) delete process.env.PI_BETTER_BACKGROUND_TASKS_SHELL;
  else process.env.PI_BETTER_BACKGROUND_TASKS_SHELL = originalShell;
  for (const id of taskIds.splice(0)) rmSync(taskDir(id), { recursive: true, force: true });
});

windowsDescribe("Windows process integration", () => {
  it("logs a missing-shell spawn error and finalizes task metadata as failed", async () => {
    process.env.PI_BETTER_BACKGROUND_TASKS_SHELL = "Z:\\missing\\pi-background-bash.exe";
    const meta = spawnTask(pi, { command: "echo unreachable", callback: false }, process.cwd());
    taskIds.push(meta.id);

    const terminal = await waitForMeta(meta.id, (value) => value?.status === "failed");

    expect(terminal).toMatchObject({ status: "failed" });
    expect(readFileSync(meta.logPath, "utf8")).toMatch(/spawn error .*code=ENOENT/i);
  });

  it("runs the gated shell path through the Windows log redirect (#619)", async () => {
    delete process.env.PI_BETTER_BACKGROUND_TASKS_SHELL;
    // A semicolon chain is the reported shape: the summary command would make the shell
    // exit 0. The gate script, its command variable and its stderr marker all have to
    // survive the Windows redirect trampoline for the verdict to be truthful here.
    const meta = spawnTask(pi, {
      command: "false; echo summary ok",
      require_successful_steps: true,
      callback: false,
    }, process.cwd());
    taskIds.push(meta.id);

    const terminal = await waitForMeta(meta.id, (value) => value?.status !== "running", 30_000);

    expect(terminal).toMatchObject({ status: "failed", lastExitCode: 1 });
    expect(terminal?.stepGateFailure).toMatchObject({ stepExitCode: 1 });
    const log = readFileSync(meta.logPath, "utf8");
    expect(log).toContain("--- step gate [");
    expect(log).toContain("first failing step exit=1");
    // bash errexit stopped at the failing step; the masking summary never ran.
    expect(log).not.toContain("summary ok");
  }, 30_000);

  it("delivers POSIX-looking raw argv without MSYS2 rewriting", async () => {
    delete process.env.PI_BETTER_BACKGROUND_TASKS_SHELL;
    expect(resolveDefaultShell()).not.toBe("/bin/bash");
    const expected = ["/c", "/opt/x.sh"];
    const meta = spawnTask(pi, {
      shell: false,
      argv: [process.execPath, "-e", "console.log(JSON.stringify(process.argv.slice(1)))", ...expected],
      callback: false,
    }, process.cwd());
    taskIds.push(meta.id);

    const terminal = await waitForMeta(meta.id, (value) => value?.status !== "running");

    expect(terminal).toMatchObject({ status: "succeeded", lastExitCode: 0 });
    expect(readFileSync(meta.logPath, "utf8")).toContain(JSON.stringify(expected));
  });
});

async function waitForMeta(
  id: string,
  done: (meta: ReturnType<typeof readMeta>) => boolean,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const meta = readMeta(id);
    if (done(meta)) return meta;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`task ${id} did not reach the expected state: ${JSON.stringify(readMeta(id))}`);
}