import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWorkRuntime } from "./test-support/work-runtime.js";

let stopRuntime: () => Promise<void>;
beforeAll(async () => { stopRuntime = await startWorkRuntime(); });
afterAll(async () => { await stopRuntime(); });
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { nativeBackground } from "./test-support/native-background.js";

type ToolResult = { content: Array<{ type: string; text: string }>; details?: unknown };
type RegisteredTool = {
  name: string;
  execute: (...args: any[]) => Promise<ToolResult>;
};

describe("golden path: background process journey", () => {
  it("launches a task, observes it running, then verifies final result and logs", async () => {
    const harness = await nativeBackground();
    const directory = mkdtempSync(join(tmpdir(), "bg-golden-"));
    const release = join(directory, "release");
    let id: string | undefined;
    try {
      const launchText = await harness.execute("bg_task_spawn", {
        name: `golden path process ${"x".repeat(2000)} final-name-marker`,
        env: { BACKGROUND_PRIVATE_TOKEN: "never-render-this-value" },
        shell: false,
        argv: [process.execPath, "-e", `
          const fs = require('node:fs');
          console.log('golden:start');
          const timer = setInterval(() => {
            if (fs.existsSync(${JSON.stringify(release)})) {
              clearInterval(timer);
              console.log('golden:done');
            }
          }, 20);
        `],
        callback: false,
        timeout_seconds: 10,
      });
      id = extractTaskId(launchText);

      const initialStatus = JSON.parse(await harness.execute("bg_task_status", { id, verbose: true }));
      expect(initialStatus).toMatchObject({ id, kind: "process", status: "running" });

      await expect.poll(() => harness.execute("bg_task_log", { id }), { timeout: 5000 }).toContain("golden:start");
      const midStatus = JSON.parse(await harness.execute("bg_task_status", { id, verbose: true }));
      expect(midStatus.status).toBe("running");

      writeFileSync(release, "finish");
      const finalStatus = await waitForPublicStatus(harness, id, (status) => status.status === "succeeded");
      expect(finalStatus).toMatchObject({ id, kind: "process", status: "succeeded", lastExitCode: 0 });
      expect(finalStatus.result).toMatchObject({ exitCode: 0, signal: null });

      let page = await harness.execute("bg_task_status", { id, verbose: true, max_bytes: 1024 });
      expect(Buffer.byteLength(page)).toBeLessThanOrEqual(1024);
      let cursor = page.match(/nextCursor=(\S+)/)?.[1];
      expect(cursor).toBeDefined();
      let metadataPages = page;
      for (let count = 0; cursor && count < 20; count++) {
        page = await harness.execute("bg_task_status", { id, cursor, max_bytes: 1024 });
        expect(Buffer.byteLength(page)).toBeLessThanOrEqual(1024);
        expect(page).not.toContain("reset=source-replaced");
        metadataPages += page;
        cursor = page.match(/nextCursor=(\S+)/)?.[1];
      }
      expect(cursor).toBeUndefined();
      expect(metadataPages).toContain("final-name-marker");
      expect(metadataPages).not.toContain("never-render-this-value");

      const logText = await harness.execute("bg_task_log", { id, tail_lines: 40 });
      expect(logText).toContain("golden:start");
      expect(logText).toContain("golden:done");

      const listText = await harness.execute("bg_task_list", { status: ["succeeded"], limit: 20 });
      expect(listText).toContain(id);
    } finally {
      if (id) await harness.execute("bg_task_stop", { id });
      await harness.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);
});

async function waitForPublicStatus(
  harness: Awaited<ReturnType<typeof nativeBackground>>,
  id: string,
  done: (status: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = JSON.parse(await harness.execute("bg_task_status", { id, verbose: true })) as Record<string, unknown>;
    if (done(status)) return status;
    await sleep(50);
  }
  const status = JSON.parse(await harness.execute("bg_task_status", { id, verbose: true })) as Record<string, unknown>;
  throw new Error(`task ${id} did not reach expected golden-path state: ${JSON.stringify(status)}`);
}

function extractTaskId(text: string): string {
  const match = text.match(/bgs_[0-9a-f]{20}|bg_[a-z0-9_]+/);
  if (!match) throw new Error(`no task id in text: ${text}`);
  return match[0]!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}