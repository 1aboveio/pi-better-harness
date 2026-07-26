import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import backgroundTasksExtension from "./index.js";

type ToolResult = { content: Array<{ type: string; text: string }>; details?: unknown };
type RegisteredTool = {
  name: string;
  execute: (...args: any[]) => Promise<ToolResult>;
};

describe("golden path: background process journey", () => {
  it("launches a task, observes it running, then verifies final result and logs", async () => {
    const harness = createHarness();

    const launchText = await harness.execute("bg_task_spawn", {
      name: "golden path process",
      command: "node -e 'console.log(\"golden:start\"); setTimeout(() => { console.log(\"golden:done\"); }, 1500)'",
      callback: false,
      timeout_seconds: 5,
    });
    const id = extractTaskId(launchText);

    const initialStatus = JSON.parse(await harness.execute("bg_task_status", { id }));
    expect(initialStatus).toMatchObject({ id, kind: "process", status: "running" });

    await sleep(750);
    const midStatus = JSON.parse(await harness.execute("bg_task_status", { id }));
    expect(midStatus.status).toBe("running");

    const finalStatus = await waitForPublicStatus(harness, id, (status) => status.status === "succeeded");
    expect(finalStatus).toMatchObject({ id, kind: "process", status: "succeeded", lastExitCode: 0 });
    expect(finalStatus.result).toMatchObject({ exitCode: 0, signal: null });

    const logText = await harness.execute("bg_task_log", { id, tail_lines: 40 });
    expect(logText).toContain("golden:start");
    expect(logText).toContain("golden:done");

    const listText = await harness.execute("bg_task_list", { status: ["succeeded"], limit: 20 });
    expect(listText).toContain(id);
  }, 10_000);
});

function createHarness() {
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    on() {
      // The golden path drives a fresh task and does not need session recovery.
    },
    async sendUserMessage() {
      // callback:false keeps this path quiet; this exists for API completeness.
    },
  } as unknown as ExtensionAPI;

  backgroundTasksExtension(pi);

  return {
    async execute(name: string, params: Record<string, unknown>) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`tool not registered: ${name}`);
      const result = await tool.execute(
        "golden-path-call",
        params,
        new AbortController().signal,
        undefined,
        { cwd: process.cwd(), hasUI: false },
      );
      return result.content.map((part) => part.text).join("\n");
    },
  };
}

async function waitForPublicStatus(
  harness: ReturnType<typeof createHarness>,
  id: string,
  done: (status: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = JSON.parse(await harness.execute("bg_task_status", { id })) as Record<string, unknown>;
    if (done(status)) return status;
    await sleep(50);
  }
  const status = JSON.parse(await harness.execute("bg_task_status", { id })) as Record<string, unknown>;
  throw new Error(`task ${id} did not reach expected golden-path state: ${JSON.stringify(status)}`);
}

function extractTaskId(text: string): string {
  const match = text.match(/bg_[a-z0-9_]+/);
  if (!match) throw new Error(`no task id in text: ${text}`);
  return match[0]!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}