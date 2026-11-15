import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logPathFor, readMeta, taskDir, writeMeta } from "./registry.js";
import { stopTask } from "./runtime.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn() };
});

const realPlatform = process.platform;

const ids: string[] = [];
const pi = {} as ExtensionAPI;

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  vi.restoreAllMocks();
  for (const id of ids.splice(0)) rmSync(taskDir(id), { recursive: true, force: true });
});

describe("Windows process termination failures", () => {
  it("keeps a task running when its process tree could not be stopped", async () => {
    const id = `bg_windows_stop_${Date.now()}`;
    ids.push(id);
    writeMeta({
      id,
      kind: "process",
      status: "running",
      startedAt: Date.now(),
      lastProgressAt: Date.now(),
      logPath: logPathFor(id),
      cwd: process.cwd(),
      pid: 4242,
      pgid: 4242,
      spawnPid: process.pid,
    });
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    vi.mocked(spawnSync).mockReturnValue({ status: 5, stderr: "Access is denied." } as ReturnType<typeof spawnSync>);
    vi.spyOn(process, "kill").mockReturnValue(true);

    const stopped = await stopTask(pi, id);

    expect(stopped).toMatchObject({
      status: "running",
      error: "taskkill failed with exit 5 for PID 4242: Access is denied.",
    });
    expect(spawnSync).toHaveBeenCalledWith("taskkill", ["/T", "/F", "/PID", "4242"],
      expect.objectContaining({ windowsHide: true }));
    expect(stopped?.stopRequestedAt).toBeUndefined();
    expect(readMeta(id)).toMatchObject({ status: "running", error: stopped!.error });
    expect(readMeta(id)?.result).toBeUndefined();
  });
});