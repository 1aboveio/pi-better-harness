import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import backgroundTasksExtension from "./index.js";
import { readMeta } from "./registry.js";

type RegisteredTool = {
  name: string;
  execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
};

describe("extension e2e", () => {
  it("registers the public background task tools", () => {
    const harness = createHarness();

    expect(Array.from(harness.tools.keys()).sort()).toEqual([
      "bg_status",
      "bg_task",
      "bg_task_list",
      "bg_task_log",
      "bg_task_spawn",
      "bg_task_status",
      "bg_task_stop",
      "bg_task_watch",
    ].sort());
  });

  it("starts a watcher through bg_task_watch and inspects it through status/log tools", async () => {
    const harness = createHarness();

    const launch = await harness.execute("bg_task_watch", {
      name: "e2e watch",
      command: "node -e 'console.log(JSON.stringify({status:\"done\", source:\"e2e\"}))'",
      interval_seconds: 1,
      timeout_seconds: 5,
      callback: false,
      success_when: { type: "json_path_equals", path: "$.status", value: "done" },
    });
    const id = extractTaskId(launch);

    await waitForMeta(id, (meta) => meta?.status === "succeeded");

    const statusText = await harness.execute("bg_task_status", { id });
    expect(JSON.parse(statusText)).toMatchObject({ id, kind: "command_watch", status: "succeeded" });

    const logText = await harness.execute("bg_task_log", { id, tail_lines: 20 });
    expect(logText).toContain('"source":"e2e"');
  });

  it("supports the action-wrapper tools for watch, log, and stop", async () => {
    const harness = createHarness();

    const launch = await harness.execute("bg_task", {
      action: "watch",
      name: "e2e wrapper watch",
      command: "node -e 'console.log(\"ready from wrapper\")'",
      interval_seconds: 1,
      timeout_seconds: 5,
      callback: false,
      success_when: { type: "stdout_contains", value: "ready from wrapper" },
    });
    const watchId = extractTaskId(launch);
    await waitForMeta(watchId, (meta) => meta?.status === "succeeded");

    const logText = await harness.execute("bg_status", { action: "log", id: watchId, tail_lines: 20 });
    expect(logText).toContain("ready from wrapper");

    const spawn = await harness.execute("bg_task", {
      action: "spawn",
      name: "e2e wrapper process",
      command: "node -e 'setTimeout(() => {}, 10000)'",
      callback: false,
    });
    const processId = extractTaskId(spawn);

    const stopped = await harness.execute("bg_status", { action: "stop", id: processId });
    expect(stopped).toContain(`Background task ${processId} is cancelled.`);
  });

  it("queues exactly one terminal callback for callback-enabled tasks", async () => {
    const harness = createHarness();

    const launch = await harness.execute("bg_task_watch", {
      name: "e2e callback watch",
      command: "node -e 'console.log(\"done\")'",
      interval_seconds: 1,
      timeout_seconds: 5,
      success_when: { type: "stdout_contains", value: "done" },
    });
    const id = extractTaskId(launch);

    await waitForMeta(id, (meta) => meta?.status === "succeeded" && typeof meta.callbackSentAt === "number");

    expect(harness.messages).toHaveLength(1);
    expect(harness.messages[0]).toContain(id);

    await harness.fireSessionStart();
    expect(harness.messages).toHaveLength(1);
  });
});

function createHarness() {
  const tools = new Map<string, RegisteredTool>();
  const sessionStartHandlers: Array<() => unknown> = [];
  const messages: string[] = [];
  const pi = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    on(eventName: string, handler: () => unknown) {
      if (eventName === "session_start") sessionStartHandlers.push(handler);
    },
    async sendUserMessage(message: string) {
      messages.push(message);
    },
  } as unknown as ExtensionAPI;

  backgroundTasksExtension(pi);

  return {
    tools,
    messages,
    async execute(name: string, params: Record<string, unknown>) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`tool not registered: ${name}`);
      const result = await tool.execute(
        "test-call",
        params,
        new AbortController().signal,
        undefined,
        { cwd: process.cwd(), hasUI: false },
      );
      return result.content.map((part) => part.text).join("\n");
    },
    async fireSessionStart() {
      for (const handler of sessionStartHandlers) await handler();
    },
  };
}

function extractTaskId(text: string): string {
  const match = text.match(/bg_[a-z0-9_]+/);
  if (!match) throw new Error(`no task id in text: ${text}`);
  return match[0]!;
}

async function waitForMeta(
  id: string,
  done: (meta: ReturnType<typeof readMeta>) => boolean,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const meta = readMeta(id);
    if (done(meta)) return meta;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const meta = readMeta(id);
  if (!done(meta)) throw new Error(`task ${id} did not reach expected state: ${JSON.stringify(meta)}`);
  return meta;
}