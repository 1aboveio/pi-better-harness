import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import backgroundTasksExtension from "./index.js";
import { readMeta, writeMeta } from "./registry.js";

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

  it("registers background tasks with pi-better-goal activity", () => {
    const harness = createHarness();

    expect(harness.goalProviders).toHaveLength(1);
    expect(harness.goalProviders[0]).toMatchObject({
      id: "background-tasks",
      label: "Background Tasks",
    });

    harness.events.emit("pi-better-goal:ready", { version: "test" });
    expect(harness.goalProviders).toHaveLength(2);
    expect(harness.goalProviders[1]).toMatchObject({ id: "background-tasks" });
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

  it("suppresses terminal callback replay in a different session", async () => {
    const originHarness = createHarness({ sessionId: "session-a", failUserMessage: true });

    const launch = await originHarness.execute("bg_task_watch", {
      name: "e2e callback isolation",
      command: "node -e 'console.log(\"done\")'",
      interval_seconds: 1,
      timeout_seconds: 5,
      success_when: { type: "stdout_contains", value: "done" },
    });
    const id = extractTaskId(launch);

    await waitForMeta(id, (meta) => meta?.status === "succeeded" && originHarness.messageAttempts.length === 1);
    expect(readMeta(id)?.callbackSentAt).toBeUndefined();

    const otherHarness = createHarness({ sessionId: "session-b" });
    await otherHarness.fireSessionStart();

    const terminal = await waitForMeta(id, (meta) => typeof meta?.callbackSuppressedAt === "number");
    expect(otherHarness.messages).toHaveLength(0);
    expect(terminal?.callbackSuppressedReason).toContain("origin session session-a does not match active session session-b");
  });

  it("keeps navigator rows scoped to the active session", async () => {
    const sessionA = createHarness({ sessionId: "session-a", mode: "tui", hasUI: true });
    await sessionA.fireSessionStart();
    const launch = await sessionA.execute("bg_task_spawn", {
      name: "session-a-task",
      shell: false,
      argv: [process.execPath, "-e", "setTimeout(() => {}, 30_000)"],
      callback: false,
    });
    const id = extractTaskId(launch);

    try {
      expect(sessionA.lastWidget("background-work-list")?.join("\n")).toContain("session-a-task");

      const sessionB = createHarness({ sessionId: "session-b", mode: "tui", hasUI: true });
      await sessionB.fireSessionStart();

      expect(sessionB.lastWidget("background-work-list")?.join("\n") ?? "").not.toContain("session-a-task");
      expect(sessionB.lastWidget("background-work-list")?.join("\n") ?? "").not.toContain(id);
    } finally {
      await sessionA.execute("bg_task_stop", { id });
    }
  });

  it("hides failed navigator rows after 30 seconds", async () => {
    const harness = createHarness({ sessionId: "session-a", mode: "tui", hasUI: true });
    const launch = await harness.execute("bg_task_spawn", {
      name: "recent-failure",
      shell: false,
      argv: [process.execPath, "-e", "process.exit(1)"],
      callback: false,
    });
    const id = extractTaskId(launch);

    const failed = await waitForMeta(id, (meta) => meta?.status === "failed" && typeof meta.endedAt === "number");
    await harness.fireSessionStart();
    expect(harness.lastWidget("background-work-list")?.join("\n") ?? "").toContain("recent-failure");

    writeMeta({ ...failed!, endedAt: Date.now() - 31_000 });
    await harness.fireSessionStart();

    expect(harness.lastWidget("background-work-list")?.join("\n") ?? "").not.toContain("recent-failure");
    expect(readMeta(id)?.status).toBe("failed");
  });
});

function createHarness(options: { cwd?: string; sessionId?: string; failUserMessage?: boolean; mode?: string; hasUI?: boolean } = {}) {
  const tools = new Map<string, RegisteredTool>();
  const sessionStartHandlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
  const messages: string[] = [];
  const messageAttempts: string[] = [];
  const widgets: Array<[string, string[] | undefined]> = [];
  const events = new EventEmitter();
  const goalProviders: unknown[] = [];
  events.on("pi-better-goal:register-provider", (provider) => goalProviders.push(provider));
  const cwd = options.cwd ?? process.cwd();
  const sessionId = options.sessionId ?? "test-session";
  const context = {
    cwd,
    mode: options.mode ?? "print",
    hasUI: options.hasUI ?? false,
    ui: {
      theme: { fg: (_color: string, value: string) => value },
      setStatus() {},
      setWidget(key: string, value: string[] | undefined) { widgets.push([key, value]); },
      getEditorComponent() { return undefined; },
      setEditorComponent() {},
      custom() { return Promise.resolve(null); },
    },
    sessionManager: {
      getSessionId: () => sessionId,
    },
  };
  const pi = {
    events,
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    on(eventName: string, handler: (event: unknown, ctx: unknown) => unknown) {
      if (eventName === "session_start") sessionStartHandlers.push(handler);
    },
    async sendUserMessage(message: string) {
      messageAttempts.push(message);
      if (options.failUserMessage) throw new Error("simulated send failure");
      messages.push(message);
    },
  } as unknown as ExtensionAPI;

  backgroundTasksExtension(pi);

  return {
    tools,
    messages,
    messageAttempts,
    widgets,
    events,
    goalProviders,
    async execute(name: string, params: Record<string, unknown>) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`tool not registered: ${name}`);
      const result = await tool.execute(
        "test-call",
        params,
        new AbortController().signal,
        undefined,
        context,
      );
      return result.content.map((part) => part.text).join("\n");
    },
    async fireSessionStart() {
      for (const handler of sessionStartHandlers) await handler({ type: "session_start" }, context);
    },
    lastWidget(key: string) {
      for (let i = widgets.length - 1; i >= 0; i -= 1) {
        if (widgets[i]![0] === key) return widgets[i]![1];
      }
      return undefined;
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