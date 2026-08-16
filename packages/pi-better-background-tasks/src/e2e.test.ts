import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import backgroundTasksExtension from "./index.js";
import { readMeta, taskDir, writeMeta } from "./registry.js";

type JsonSchema = {
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
};

type RegisteredTool = {
  name: string;
  description?: string;
  parameters?: JsonSchema;
  execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
};

function renderWidget(value: unknown, width = 120): string {
  if (Array.isArray(value)) return value.join("\n");
  if (typeof value === "function") {
    return value({ requestRender() {} }, { fg: (_color: string, text: string) => text }).render(width).join("\n");
  }
  return "";
}

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

  it("documents compact default payloads in the tool registry", () => {
    const harness = createHarness();

    expect(harness.tools.get("bg_task_status")?.description).toContain("compact model-facing summary");
    expect(harness.tools.get("bg_task_status")?.description).toContain("verbose:true only");
    expect(harness.tools.get("bg_task_log")?.description).toContain("compact 20-line terminal-aware tail");
    expect(harness.tools.get("bg_task_log")?.description).toContain("tail_lines:0 returns the retained raw log");
    expect(harness.tools.get("bg_task")?.description).toContain("action:status");
    expect(harness.tools.get("bg_status")?.description).toContain("explicit full-data recovery");
  });

  // @covers background-task.ssh-tool-contract
  // @level integration
  it("registers structured SSH and remote fields on every spawn/watch entry point", () => {
    const harness = createHarness();

    for (const name of ["bg_task_spawn", "bg_task_watch", "bg_task"]) {
      const tool = harness.tools.get(name);
      const properties = tool?.parameters?.properties;
      expect(properties?.ssh).toMatchObject({ required: ["host"] });
      expect(Object.keys(properties?.ssh?.properties ?? {}).sort()).toEqual([
        "host",
        "identity_file",
        "jump",
        "options",
        "port",
        "user",
      ]);
      expect(Object.keys(properties?.remote?.properties ?? {}).sort()).toEqual([
        "install_tmux",
        "session",
        "workdir",
      ]);
      expect(properties?.command?.description).toContain("remote command when ssh is set");
      expect(tool?.description).toContain("structured ssh");
    }
  });

  // @covers background-task.ssh-tool-contract
  // @level integration
  // @fails-without-fix background-task.ssh-tool-contract
  it("documents SSH watches as direct one-shot polls without tmux installation", () => {
    const harness = createHarness();
    const watch = harness.tools.get("bg_task_watch");
    const wrapper = harness.tools.get("bg_task");

    expect(watch?.description).toContain("direct one-shot SSH poll");
    expect(wrapper?.description).toContain("SSH watches use direct one-shot polls");
    expect(watch?.parameters?.properties?.remote?.properties?.session?.description).toContain("Watch always uses direct");
    expect(watch?.parameters?.properties?.remote?.properties?.install_tmux?.description).toContain("ignored for watch");
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
    expect(statusText).toContain(`Background task ${id}`);
    expect(statusText).toContain("is succeeded");
    expect(statusText).toContain("For full metadata use bg_task_status");
    expect(statusText).not.toContain("success_when");

    const verboseStatusText = await harness.execute("bg_task_status", { id, verbose: true });
    expect(JSON.parse(verboseStatusText)).toMatchObject({ id, kind: "command_watch", status: "succeeded" });

    const logText = await harness.execute("bg_task_log", { id, tail_lines: 20 });
    expect(logText).toContain('"source":"e2e"');
  });

  // @covers background-task.ssh-status
  // @level integration
  it("shows SSH target identity in compact status, list, and navigator labels", async () => {
    const harness = createHarness({ sessionId: "remote-label-session", mode: "tui", hasUI: true });
    const id = `bg_remote_label_${Date.now()}`;
    const remoteCommand = "node /srv/a-very-long-remote-command.js --opaque model authored payload";
    writeMeta({
      id,
      kind: "process",
      status: "running",
      startedAt: Date.now(),
      lastProgressAt: Date.now(),
      logPath: `${taskDir(id)}/output.log`,
      callback: false,
      callbackOrigin: { cwd: process.cwd(), sessionId: "remote-label-session" },
      command: remoteCommand,
      argv: ["ssh", "-o", "BatchMode=yes", "-T", "--", "builder@remote.example", remoteCommand],
      shell: false,
      cwd: process.cwd(),
      spawnPid: process.pid,
      ssh: { host: "remote.example", user: "builder", target: "builder@remote.example" },
      remote: { command: remoteCommand, session: "tmux", installTmux: true },
    });

    try {
      const status = await harness.execute("bg_task_status", { id });
      const list = await harness.execute("bg_task_list", { status: ["running"], limit: 100 });
      await harness.fireSessionStart();
      const navigator = renderWidget(harness.lastWidget("background-work-list"));

      expect(status).toContain("remote: builder@remote.example");
      expect(list.split("\n").find((line) => line.startsWith(id))).toContain("builder@remote.example");
      expect(navigator).toContain("builder@remote.example");
      expect(navigator).not.toContain("a-very-long-remote-command");
    } finally {
      rmSync(taskDir(id), { recursive: true, force: true });
    }
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
    expect(harness.messages[0]).toContain("bg_task_status");
    expect(harness.messages[0]).toContain("Full results and logs are intentionally omitted");

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
      expect(renderWidget(sessionA.lastWidget("background-work-list"))).toContain("session-a-task");

      const sessionB = createHarness({ sessionId: "session-b", mode: "tui", hasUI: true });
      await sessionB.fireSessionStart();

      expect(renderWidget(sessionB.lastWidget("background-work-list"))).not.toContain("session-a-task");
      expect(renderWidget(sessionB.lastWidget("background-work-list"))).not.toContain(id);
    } finally {
      await sessionA.execute("bg_task_stop", { id });
    }
  });

  it("hides terminal navigator rows after 30 seconds", async () => {
    const harness = createHarness({ sessionId: "session-a", mode: "tui", hasUI: true });
    const failedLaunch = await harness.execute("bg_task_spawn", {
      name: "recent-failure",
      shell: false,
      argv: [process.execPath, "-e", "process.exit(1)"],
      callback: false,
    });
    const failedId = extractTaskId(failedLaunch);
    const succeededLaunch = await harness.execute("bg_task_spawn", {
      name: "recent-success",
      shell: false,
      argv: [process.execPath, "-e", "process.exit(0)"],
      callback: false,
    });
    const succeededId = extractTaskId(succeededLaunch);

    const failed = await waitForMeta(failedId, (meta) => meta?.status === "failed" && typeof meta.endedAt === "number");
    const succeeded = await waitForMeta(succeededId, (meta) => meta?.status === "succeeded" && typeof meta.endedAt === "number");
    await harness.fireSessionStart();
    let list = renderWidget(harness.lastWidget("background-work-list"));
    expect(list).toContain("recent-failure");
    expect(list).toContain("recent-success");

    writeMeta({ ...failed!, endedAt: Date.now() - 31_000 });
    writeMeta({ ...succeeded!, endedAt: Date.now() - 31_000 });
    await harness.fireSessionStart();

    list = renderWidget(harness.lastWidget("background-work-list"));
    expect(list).not.toContain("recent-failure");
    expect(list).not.toContain("recent-success");
    expect(readMeta(failedId)?.status).toBe("failed");
    expect(readMeta(succeededId)?.status).toBe("succeeded");
  });

  it("clears terminal tasks for the active session without touching running or other-session tasks", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bg-clear-test-"));
    const harness = createHarness({ cwd, sessionId: "session-a" });
    const failedLaunch = await harness.execute("bg_task_spawn", {
      name: "clearable-failure",
      shell: false,
      argv: [process.execPath, "-e", "process.exit(1)"],
      callback: false,
    });
    const failedId = extractTaskId(failedLaunch);
    const runningLaunch = await harness.execute("bg_task_spawn", {
      name: "keep-running",
      shell: false,
      argv: [process.execPath, "-e", "setTimeout(() => {}, 30_000)"],
      callback: false,
    });
    const runningId = extractTaskId(runningLaunch);
    const otherSessionLaunch = await createHarness({ cwd, sessionId: "session-b" }).execute("bg_task_spawn", {
      name: "other-session-failure",
      shell: false,
      argv: [process.execPath, "-e", "process.exit(1)"],
      callback: false,
    });
    const otherSessionId = extractTaskId(otherSessionLaunch);

    try {
      await waitForMeta(failedId, (meta) => meta?.status === "failed");
      await waitForMeta(otherSessionId, (meta) => meta?.status === "failed");

      const cleared = await harness.execute("bg_status", { action: "clear" });

      expect(cleared).toContain("Dismissed 1 terminal background task");
      expect(readMeta(failedId)?.dismissedAt).toBeTypeOf("number");
      expect(readMeta(runningId)?.dismissedAt).toBeUndefined();
      expect(readMeta(otherSessionId)?.dismissedAt).toBeUndefined();
    } finally {
      await harness.execute("bg_task_stop", { id: runningId });
    }
  });
});

function createHarness(options: { cwd?: string; sessionId?: string; failUserMessage?: boolean; mode?: string; hasUI?: boolean } = {}) {
  const tools = new Map<string, RegisteredTool>();
  const sessionStartHandlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
  const messages: string[] = [];
  const messageAttempts: string[] = [];
  const widgets: Array<[string, unknown]> = [];
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
      setWidget(key: string, value: unknown) { widgets.push([key, value]); },
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
    sendMessage(message: { content: string }) {
      messageAttempts.push(message.content);
      if (options.failUserMessage) throw new Error("simulated send failure");
      messages.push(message.content);
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