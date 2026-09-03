import { rmSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopProcessGroup } from "./process.js";
import { logPathFor, readMeta, taskDir, writeMeta } from "./registry.js";
import { stopTask } from "./runtime.js";

vi.mock("./process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./process.js")>();
  return { ...actual, stopProcessGroup: vi.fn() };
});

const ids: string[] = [];
const pi = {} as ExtensionAPI;

afterEach(() => {
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
    vi.mocked(stopProcessGroup).mockImplementation(() => {
      throw new Error("taskkill failed with exit 5: Access is denied.");
    });

    const stopped = await stopTask(pi, id);

    expect(stopped).toMatchObject({
      status: "running",
      error: "taskkill failed with exit 5: Access is denied.",
    });
    expect(stopped?.stopRequestedAt).toBeUndefined();
    expect(readMeta(id)?.result).toBeUndefined();
  });
});