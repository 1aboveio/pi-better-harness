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