import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import backgroundTasksExtension from "./index.js";
import { recordFailure } from "./failures.js";
import { CALLBACK_SETTINGS_ENTRY, getCallbackBatcher } from "./shared-callback-batcher.js";
import { metaPathFor, readMeta, taskDir, writeMeta } from "./registry.js";
import { defaultSupervisorDirectory } from "./supervisor/index.js";
import { currentProcessStartToken } from "./process-identity.js";
import { FOREGROUND_SANDBOX_POLICY_CHANNEL, FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL } from "./sandbox.js";

type JsonSchema = {
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
};

type RegisteredTool = {
  name: string;
  description?: string;
  promptGuidelines?: string[];
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

async function flushUntil(harness: ReturnType<typeof createHarness>, count: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await getCallbackBatcher(harness.pi).flush();
    if (harness.messages.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("extension e2e", () => {
  it("#572 exposes permission-gated process evidence on every status entry point", async () => {
    const harness = createHarness();
    const id = "bg_diagnostics_572";
    const logPath = join(taskDir(id), "output.log");
    writeMeta({ id, kind: "process", status: "running", startedAt: Date.now(), logPath,
      cwd: process.cwd(), spawnPid: process.pid, pid: process.pid, pidStartTime: currentProcessStartToken(),
      callbackOrigin: { cwd: process.cwd(), sessionId: "test-session" },
      sandbox: { confinement: "unconfined", policySource: "no-publisher", policySummary: "No policy at launch.", changesAffectTask: false } });
    writeFileSync(logPath, "checkpoint\n");
    const permissions = { enabled: false, commands: true, network: true, processAccess: "read",
      projectFiles: "read-write", outsideProject: "read", storedCredentials: "read" };
    let backgroundAccess = "off";
    harness.events.on(FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL, () => harness.events.emit(FOREGROUND_SANDBOX_POLICY_CHANNEL, {
      state: "disabled", permissions, background: { state: "disabled", permissions: { ...permissions, processAccess: backgroundAccess } },
    }));
    try {
      for (const tool of ["bg_task_status", "bg_task", "bg_status"]) {
        const result = JSON.parse(await harness.execute(tool, { action: "status", id, verbose: true, diagnostics: true }));
        expect(result.processDiagnostics).toMatchObject({ availability: "blocked" });
        expect(result.sandbox.confinement).toBe("unconfined");
      }
      backgroundAccess = "read";
      const result = JSON.parse(await harness.execute("bg_task_status", { id, verbose: true, diagnostics: true }));
      if (process.platform === "darwin" || process.platform === "linux") {
        expect(result.processDiagnostics).toMatchObject({ availability: "available", identity: "matches" });
      } else expect(result.processDiagnostics.availability).toBe("unavailable");
      const compact = await harness.execute("bg_task_status", { id, diagnostics: true });
      expect(compact).toContain("process diagnostics:");
      expect(Buffer.byteLength(compact)).toBeLessThanOrEqual(1024);
      writeMeta({ ...readMeta(id)!, argv: ["first-argument", "x".repeat(4_000), "last-argument"] });
      const firstPage = await harness.execute("bg_task_status", { id, verbose: true, diagnostics: true, max_bytes: 1024 });
      let cursor = firstPage.match(/nextCursor=(\S+)/)?.[1];
      expect(cursor).toBeDefined();
      let remaining = "";
      for (let page = 0; page < 20 && cursor; page++) {
        const text = await harness.execute("bg_task_status", { id, diagnostics: true, cursor, max_bytes: 1024 });
        expect(text).not.toContain("reset=source-replaced");
        expect(text).not.toContain(`"id": "${id}"`);
        remaining += text;
        cursor = text.match(/nextCursor=(\S+)/)?.[1];
      }
      expect(cursor).toBeUndefined();
      expect(remaining).toContain("last-argument");
      const foreign = { ...readMeta(id)!, callbackOrigin: { cwd: process.cwd(), sessionId: "another-session" } };
      writeMeta(foreign);
      const refused = await harness.execute("bg_task_status", { id, diagnostics: true, verbose: true });
      expect(refused).toContain("outside the current session scope");
      expect(refused).not.toContain("cpuTime");
    } finally { rmSync(taskDir(id), { recursive: true, force: true }); }
  });

  it("registers the public background task tools", () => {
    const harness = createHarness();

    expect(Array.from(harness.tools.keys()).sort()).toEqual([
      "acknowledge_operation_result",
      "bg_status",
      "bg_task",
      "bg_task_list",
      "bg_task_log",
      "bg_task_spawn",
      "bg_task_spawn_batch",
      "bg_task_status",
      "bg_task_stop",
      "bg_task_wait_cancel",
      "bg_task_wait_list",
      "bg_task_watch",
      "wait_for_operations",
      "watch_delivery",
    ].sort());
  });

  it("documents compact default payloads in the tool registry", () => {
    const harness = createHarness();

    expect(harness.tools.get("bg_task_status")?.description).toContain("compact model-facing summary");
    expect(harness.tools.get("bg_task_status")?.description).toContain("verbose:true only");
    expect(harness.tools.get("bg_task_log")?.description).toContain("compact 10-line terminal-aware tail");
    expect(harness.tools.get("bg_task_log")?.description).toContain("lines:0 pages the retained raw log");
    expect(harness.tools.get("bg_task")?.description).toContain("action:status");
    expect(harness.tools.get("bg_status")?.description).toContain("explicit full-data recovery");
  });

  it("coordinates long-running work with the parent plan", () => {
    const harness = createHarness();

    for (const name of ["bg_task_spawn", "bg_task_watch", "bg_task"]) {
      const guidelines = harness.tools.get(name)?.promptGuidelines ?? [];
      expect(guidelines.some((line) => line.includes("genuinely long-running"))).toBe(true);
      expect(guidelines.some((line) => line.includes("coordinator ledger"))).toBe(true);
      expect(guidelines.some((line) => line.includes("continue unblocked foreground work without polling"))).toBe(true);
      expect(guidelines.some((line) => line.includes("terminal, inspected, and integrated"))).toBe(true);
    }
  });

  it("#359 tells the model how to write a watch check and exposes blind_checks on both watch entry points", async () => {
    const harness = createHarness();
    for (const name of ["bg_task_watch", "bg_task"]) {
      const tool = harness.tools.get(name);
      expect(tool?.description).toContain("do not end it with `exit 0` or `|| true`");
      expect(tool?.description).toContain("Map an unknown or unparseable state to failure");
      expect(tool?.description).toContain("jq -er");
      expect(tool?.parameters?.properties?.blind_checks?.description).toContain("0 turns it off");
    }
    // The wrapper's watch action goes through the same first-check wait as bg_task_watch.
    const launch = await harness.execute("bg_task", {
      action: "watch",
      command: "echo STILL_UNKNOWN; echo 'ERROR: broken format' >&2; exit 0",
      interval_seconds: 60,
      timeout_seconds: 5,
      callback: false,
      success_when: { type: "stdout_contains", value: "TERMINAL_SUCCESS" },
    });
    expect(launch).toContain("First check: exit 0");
    expect(launch).toContain("ERROR: broken format");
    await harness.execute("bg_task", { action: "stop", id: extractTaskId(launch) });
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
      expect(properties?.ssh?.description).toContain("instead of wrapping command in a hand-written ssh command");
      expect(properties?.ssh?.description).toContain("command is the remote command");
      expect(properties?.ssh?.description).toContain("remote stop semantics");
      expect(properties?.remote?.description).toContain("durable tmux default");
      expect(properties?.remote?.description).toContain("SSH watch runs direct one-shot polls");
      expect(properties?.remote?.properties?.session?.description).toContain("tmux");
      expect(properties?.remote?.properties?.session?.description).toContain("direct");
      expect(tool?.description).toContain("structured ssh");
      expect(tool?.description).toContain("ssh:{host,user}");
    }
    expect(harness.tools.get("bg_task_spawn")?.description).toContain("defaults to a remote tmux session");
    expect(harness.tools.get("bg_task_spawn")?.description).toContain("direct mode has weaker stop semantics");
    expect(harness.tools.get("bg_task_stop")?.description).toContain("kills its remote tmux session");
  });

  it("advertises the step gate only where it can observe steps (#619)", () => {
    const harness = createHarness();

    for (const name of ["bg_task_spawn", "bg_task"]) {
      const gate = harness.tools.get(name)?.parameters?.properties?.require_successful_steps;
      expect(gate, name).toBeTruthy();
      expect(gate?.description, name).toContain("runs under bash errexit");
      expect(gate?.description, name).toContain("Not supported with shell:false or ssh");
      expect(gate?.description, name).toContain("Default false");
    }
    // A watch polls one command whose own exit code is the outcome; the field is not offered there.
    expect(harness.tools.get("bg_task_watch")?.parameters?.properties?.require_successful_steps).toBeUndefined();
  });

  it("reports a masked failing step of a chained command through both spawn entry points (#619)", async () => {
    const harness = createHarness();
    const command = "bash -c 'exit 8'\necho summary ok";

    for (const [tool, extra, name] of [["bg_task_spawn", {}, "gate-spawn-tool"], ["bg_task", { action: "spawn" }, "gate-wrapper-tool"]] as const) {
      const launch = await harness.execute(tool, { ...extra, name, command, callback: false, require_successful_steps: true });
      const id = extractTaskId(launch);
      const terminal = await waitForMeta(id, (meta) => meta?.status === "failed" && typeof meta.endedAt === "number", 15_000);
      expect(terminal?.lastExitCode, tool).toBe(8);
      expect(terminal?.stepGateFailure, tool).toMatchObject({ stepExitCode: 8, shellExitCode: 8 });

      // The operator's verdict surface: the red gate reads red, and it says why.
      const status = await harness.execute("bg_task_status", { id });
      expect(status, tool).toContain("exit=8 (step gate)");
      expect(status, tool).toContain("step gate: bash -c 'exit 8' exited 8; the shell stopped at that step");
    }
  }, 25_000);

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

  // @covers background-task.ssh-tool-contract
  // @level integration
  // @fails-without-fix background-task.ssh-tool-contract
  it("steers models through the complete structured SSH operator contract", () => {
    const harness = createHarness();
    const spawn = harness.tools.get("bg_task_spawn");
    const watch = harness.tools.get("bg_task_watch");
    const wrapper = harness.tools.get("bg_task");

    for (const tool of [spawn, watch, wrapper]) {
      expect(tool?.description).toContain("structured ssh");
      expect(tool?.description).toContain("remote_bash");
      expect(tool?.description).toContain("short synchronous remote");
      expect(tool?.parameters?.properties?.timeout_seconds?.description).toContain("900 seconds");
    }
    expect(spawn?.description).toContain("install tmux non-interactively");
    expect(spawn?.description).toContain("fails closed");
    expect(spawn?.description).toContain("remote.session=direct");
    expect(spawn?.description).toContain("weaker stop semantics");
    expect(watch?.description).toContain("direct one-shot SSH poll");
    expect(watch?.description).toContain("without tmux installation");
    expect(wrapper?.description).toContain("SSH spawn defaults to durable tmux");
    expect(wrapper?.description).toContain("SSH watches use direct one-shot polls");
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
    expect(statusText).toContain("Condition matched");
    expect(statusText).toContain("$.status");
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
      remote: {
        command: remoteCommand,
        session: "tmux",
        installTmux: true,
        sessionName: `pi-bg-${id}`,
        bootstrapStatus: "installed",
        bootstrapMessage: "Installed tmux with apt-get on builder@remote.example; tmux 3.4 is available at /usr/bin/tmux.",
        tmuxInstalled: true,
      },
    });

    try {
      const status = await harness.execute("bg_task_status", { id });
      const verboseStatus = JSON.parse(await harness.execute("bg_task_status", { id, verbose: true }));
      const list = await harness.execute("bg_task_list", { status: ["running"], limit: 100 });
      await harness.fireSessionStart();
      const navigator = renderWidget(harness.lastWidget("background-work-list"));

      expect(status).toContain("remote: builder@remote.example");
      expect(status).toContain("remote mode: tmux");
      expect(status).toContain(`remote session: pi-bg-${id}`);
      expect(status).toContain("remote setup: Installed tmux with apt-get on builder@remote.example");
      expect(verboseStatus).toMatchObject({
        ssh: { host: "remote.example", user: "builder", target: "builder@remote.example" },
        remote: {
          session: "tmux",
          sessionName: `pi-bg-${id}`,
          bootstrapStatus: "installed",
          tmuxInstalled: true,
        },
      });
      expect(list.split("\n").find((line) => line.startsWith(id))).toContain("builder@remote.example tmux");
      expect(navigator).toContain("builder@remote.example");
      expect(navigator).toContain("tmux");
      expect(navigator).not.toContain("a-very-long-remote-command");
    } finally {
      rmSync(taskDir(id), { recursive: true, force: true });
    }
  });

  it("replays an undelivered terminal failure through the real session-start handler", async () => {
    const sessionId = `failure-replay-${Date.now()}`;
    const harness = createHarness({ sessionId });
    const id = `bg_failure_replay_${Date.now()}`;
    const meta = {
      id, kind: "process" as const, status: "failed" as const,
      startedAt: Date.now() - 1000, endedAt: Date.now(),
      logPath: `${taskDir(id)}/output.log`, callback: true,
      callbackOrigin: { cwd: process.cwd(), sessionId },
      command: "build", cwd: process.cwd(), spawnPid: process.pid,
    };
    writeMeta(meta);
    recordFailure(meta, "execution", "build exited 9", "exit", { category: "exit" });
    try {
      await harness.fireSessionStart();
      writeFileSync(metaPathFor(id), "{broken");
      expect(await getCallbackBatcher(harness.pi).flush()).toBe(false);
      expect(harness.messages).toHaveLength(0);
      writeMeta(meta);
      await getCallbackBatcher(harness.pi).flush();
      expect(harness.messages).toHaveLength(1);
      expect(harness.messages[0]).toContain("build exited 9");
      expect(readMeta(id)?.callbackSentAt).toBeDefined();
      await harness.fireSessionStart();
      await getCallbackBatcher(harness.pi).flush();
      expect(harness.messages).toHaveLength(1);
    } finally { rmSync(taskDir(id), { recursive: true, force: true }); }
  });

  it("#409 holds time-separated completions while busy and drains once after agent_settled", async () => {
    vi.useFakeTimers();
    const sessionId = "availability-gated-completions";
    const harness = createHarness({ sessionId });
    const ids = ["bg_availability_first", "bg_availability_second"];
    try {
      await harness.fireSessionStart();
      await harness.fireAgentStart();
      for (const id of ids) {
        writeMeta({ id, kind: "process", status: "succeeded", startedAt: 1, endedAt: 2,
          logPath: `${taskDir(id)}/output.log`, callback: true,
          callbackOrigin: { cwd: process.cwd(), sessionId },
          command: "build", cwd: process.cwd(), spawnPid: process.pid });
        await harness.fireSessionStart();
        await vi.advanceTimersByTimeAsync(200);
        expect(harness.messages).toHaveLength(0);
        expect(readMeta(id)?.callbackSentAt).toBeUndefined();
      }
      expect(getCallbackBatcher(harness.pi).pendingCount()).toBe(2);
      await harness.fireAgentSettled();
      expect(harness.messages).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(harness.messages).toHaveLength(1);
      expect(harness.messages[0]).toContain("2 background completions are ready");
      for (const id of ids) {
        expect(harness.messages[0]).toContain(id);
        expect(readMeta(id)?.callbackSentAt).toBeDefined();
      }
      await harness.fireAgentSettled();
      await vi.advanceTimersByTimeAsync(200);
      expect(harness.messages).toHaveLength(1);
    } finally {
      getCallbackBatcher(harness.pi).cancel();
      for (const id of ids) rmSync(taskDir(id), { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("shows unresolved sidecar evidence ahead of task progress on every inspection surface", async () => {
    const sessionId = "failure-surface-session";
    const harness = createHarness({ sessionId, mode: "tui", hasUI: true });
    const id = `bg_failure_surface_${Date.now()}`;
    const meta = {
      id, kind: "process" as const, status: "failed" as const,
      startedAt: Date.now() - 1000, endedAt: Date.now(),
      logPath: `${taskDir(id)}/output.log`, callback: false,
      callbackOrigin: { cwd: process.cwd(), sessionId },
      command: "background-build", cwd: process.cwd(), spawnPid: process.pid,
    };
    writeMeta(meta);
    recordFailure(meta, "execution", "build failed with exit 9", "exit", { category: "exit" });
    try {
      const list = await harness.execute("bg_task_list", { status: ["failed"], limit: 100 });
      const status = await harness.execute("bg_task_status", { id });
      const verbose = await harness.execute("bg_task_status", { id, verbose: true });
      const log = await harness.execute("bg_task_log", { id });
      await harness.fireSessionStart();
      const navigator = renderWidget(harness.lastWidget("background-work-list"));
      for (const text of [list, status, log]) {
        expect(text).toMatch(/^Action required.*build failed with exit 9/);
        expect(text.indexOf("Action required")).toBeLessThan(text.indexOf(id));
      }
      expect(JSON.parse(verbose)).toMatchObject({
        failureSummary: expect.stringContaining("build failed with exit 9"), id,
        failureJournal: expect.stringContaining("failures.jsonl"),
        failureObservations: [expect.objectContaining({ status: "unresolved", summary: "build failed with exit 9" })],
      });
      expect(verbose.indexOf("failureSummary")).toBeLessThan(verbose.indexOf('"status"'));
      expect(navigator).toContain("build failed with exit 9");
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

  it("does not inspect or mutate terminal callbacks from a different session", async () => {
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

    expect(otherHarness.messages.join("\n")).not.toContain(id);
    expect(readMeta(id)?.callbackSuppressedAt).toBeUndefined();
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

    let sessionB: ReturnType<typeof createHarness> | undefined;
    try {
      expect(renderWidget(sessionA.lastWidget("background-work-list"))).toContain("session-a-task");

      sessionB = createHarness({ sessionId: "session-b", mode: "tui", hasUI: true });
      await sessionB.fireSessionStart();

      expect(renderWidget(sessionB.lastWidget("background-work-list"))).not.toContain("session-a-task");
      expect(renderWidget(sessionB.lastWidget("background-work-list"))).not.toContain(id);
    } finally {
      await sessionA.execute("bg_task_stop", { id });
      await sessionA.fireSessionShutdown();
      await sessionB?.fireSessionShutdown();
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

  it("stops another session's running task only with all:true (#322)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bg-stop-owner-"));
    const owner = createHarness({ cwd, sessionId: "owner-session" });
    const other = createHarness({ cwd, sessionId: "other-session" });
    const launch = await owner.execute("bg_task_spawn", {
      name: "owned-sleeper",
      shell: false,
      argv: [process.execPath, "-e", "setTimeout(() => {}, 30_000)"],
      callback: false,
    });
    const id = extractTaskId(launch);
    try {
      const refused = await other.execute("bg_task_stop", { id });
      expect(refused).toContain("not stopped");
      expect(readMeta(id)?.status).toBe("running");
      expect(readMeta(id)?.stopRequestedAt).toBeUndefined();
      const stopped = await other.execute("bg_task_stop", { id, all: true });
      expect(stopped).toContain("cancelled");
      await waitForMeta(id, (meta) => meta?.status === "cancelled");
    } finally {
      await owner.execute("bg_task_stop", { id });
    }
  });
  it("lists, scopes and dismisses supervised durable tasks without losing their evidence", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bg-durable-list-test-"));
    const harness = createHarness({ cwd, sessionId: "durable-a", mode: "tui", hasUI: true });
    const other = createHarness({ cwd, sessionId: "durable-b", mode: "tui", hasUI: true });
    let id = "";
    try {
      await harness.fireSessionStart();
      const launch = await harness.execute("bg_task_spawn", {
        name: "durable-list-task",
        shell: false,
        argv: [process.execPath, "-e", 'console.log("durable-visible")'],
        callback: false,
      });
      id = extractTaskId(launch);
      expect(id).toMatch(/^bgs_[0-9a-f]{20}$/);

      await waitForText(() => harness.execute("bg_task_status", { id }), /succeeded/);
      const list = await harness.execute("bg_task_list", { limit: 100 });
      expect(list).toContain(id);
      expect(list).toContain("durable-list-task");
      expect(list).toContain("durable background operations");

      await other.fireSessionStart();
      const foreignList = await other.execute("bg_task_list", { limit: 100 });
      expect(foreignList).not.toContain(id);
      const foreignStop = await other.execute("bg_task_stop", { id });
      expect(foreignStop).toMatch(/another execution owner|did not stop|not stopped/i);
      expect(await harness.execute("bg_task_status", { id })).toContain("succeeded");

      const log = await harness.execute("bg_task_log", { id });
      expect(log).toContain("durable-visible");

      const dismissed = await harness.execute("bg_status", { action: "clear", id });
      expect(dismissed).toContain("Dismissed durable operation");
      expect(await harness.execute("bg_task_list", { limit: 100 })).not.toContain(id);
      // Dismissal hides the row; it does not erase terminal evidence.
      expect(await harness.execute("bg_task_status", { id })).toContain("succeeded");
      expect(await harness.execute("bg_task_log", { id })).toContain("durable-visible");
    } finally {
      if (id) await harness.execute("bg_task_stop", { id });
      await harness.fireSessionShutdown();
      await other.fireSessionShutdown();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("delivers a durable completion callback to the owning session after reload, not the wrong one", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bg-durable-callback-reload-"));
    const sessionId = "durable-callback-owner";
    const first = createHarness({ cwd, sessionId, mode: "tui", hasUI: true });
    const second = createHarness({ cwd, sessionId, mode: "tui", hasUI: true });
    let id = "";
    try {
      await first.fireSessionStart();
      await first.fireAgentStart(); // busy: the batcher holds the completion
      const launch = await first.execute("bg_task_spawn", {
        name: "durable-callback-task",
        shell: false,
        argv: [process.execPath, "-e", 'console.log("durable callback")'],
        callback: true,
      });
      id = extractTaskId(launch);
      await waitForText(() => first.execute("bg_task_status", { id }), /succeeded/);
      expect(first.messages).toHaveLength(0);

      // Reload the extension/session while the batcher still holds the event.
      await first.fireSessionShutdown();
      expect(first.messages).toHaveLength(0);

      await second.fireSessionStart();
      await getCallbackBatcher(second.pi).flush();
      expect(second.messages).toHaveLength(1);
      expect(second.messages[0]).toContain(id);
      await second.fireSessionStart();
      await getCallbackBatcher(second.pi).flush();
      expect(second.messages).toHaveLength(1);
    } finally {
      if (id) await second.execute("bg_task_stop", { id });
      await second.fireSessionShutdown();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not release a queued completion onto an abandoned branch", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bg-durable-branch-tree-"));
    const harness = createHarness({
      cwd,
      sessionId: "branch-tree-owner",
      mode: "tui",
      hasUI: true,
      branchIds: ["anchor-1"],
    });
    let id = "";
    try {
      await harness.fireSessionStart();
      await harness.fireAgentStart(); // busy: the completion stays queued
      const launch = await harness.execute("bg_task_spawn", {
        name: "branch-queued-task",
        shell: false,
        argv: [process.execPath, "-e", 'console.log("branch-queued")'],
        callback: true,
      });
      id = extractTaskId(launch);
      await waitForText(() => harness.execute("bg_task_status", { id }), /succeeded/);
      expect(harness.messages).toHaveLength(0);

      // Fork away from the recorded anchor while the completion is queued.
      await harness.fireSessionTree(["other-fork"]);
      await harness.fireAgentSettled();
      await getCallbackBatcher(harness.pi).flush();
      expect(harness.messages).toHaveLength(0);

      // A descendant branch still contains the anchor and may receive it. The
      // batcher can settle a prior suppression on a microtask, so drain until the
      // single receipt rather than assuming one synchronous flush is enough.
      await harness.fireSessionTree(["anchor-1", "descendant"]);
      await flushUntil(harness, 1);
      if (harness.messages.length === 0) {
        const readJson = (path: string) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } };
        console.error("[branch-diagnostics]", JSON.stringify({
          id,
          sidecar: readJson(join(defaultSupervisorDirectory(), "observed", `${id}.json`)),
          host: readJson(join(defaultSupervisorDirectory(), "observed", "host.json")),
          branchIds: harness.ctx.sessionManager.getBranch().flatMap((entry) => "id" in entry ? [entry.id] : []),
          messages: harness.messages.length,
        }, null, 2));
      }
      expect(harness.messages).toHaveLength(1);
      expect(harness.messages[0]).toContain(id);
      await getCallbackBatcher(harness.pi).flush();
      expect(harness.messages).toHaveLength(1);
    } finally {
      if (id) await harness.execute("bg_task_stop", { id });
      await harness.fireSessionShutdown();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reports a running supervised operation as active Goal background work", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bg-durable-goal-test-"));
    const harness = createHarness({ cwd, sessionId: "goal-durable", mode: "tui", hasUI: true });
    let id = "";
    try {
      await harness.fireSessionStart();
      const launch = await harness.execute("bg_task_spawn", {
        name: "goal-durable-task",
        shell: false,
        argv: [process.execPath, "-e", "setTimeout(() => {}, 30_000)"],
        callback: false,
      });
      id = extractTaskId(launch);
      const provider = harness.goalProviders[0] as {
        getActivity(ctx: unknown): { items: Array<{ id: string; active: boolean; status: string }> };
      };
      const snapshot = provider.getActivity(harness.ctx);
      const item = snapshot.items.find((entry) => entry.id === id);
      expect(item).toMatchObject({ id, active: true, status: "running" });

      const foreign = provider.getActivity({
        cwd,
        sessionManager: { getSessionId: () => "goal-other" },
      });
      expect(foreign.items.find((entry) => entry.id === id)).toBeUndefined();
    } finally {
      if (id) await harness.execute("bg_task_stop", { id });
      await harness.fireSessionShutdown();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

function createHarness(options: { cwd?: string; sessionId?: string; failUserMessage?: boolean; mode?: string; hasUI?: boolean; branchIds?: readonly string[] } = {}) {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  let idle = true;
  const messages: string[] = [];
  const messageAttempts: string[] = [];
  const widgets: Array<[string, unknown]> = [];
  const events = new EventEmitter();
  // Pi's event bus returns an unsubscribe function; Node's EventEmitter returns
  // itself. Mirror Pi so session_shutdown cleanup is exercised faithfully.
  const rawOn = events.on.bind(events);
  events.on = ((name: string, listener: (...args: unknown[]) => void) => {
    rawOn(name, listener);
    return () => { events.off(name, listener); };
  }) as unknown as typeof events.on;
  const goalProviders: unknown[] = [];
  events.on("pi-better-goal:register-provider", (provider) => goalProviders.push(provider));
  const cwd = options.cwd ?? process.cwd();
  const sessionId = options.sessionId ?? "test-session";
  let branchIds = [...(options.branchIds ?? [])];
  const context = {
    cwd,
    isIdle: () => idle,
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
      // The callback preference entry pins delivery to "hold" so a busy foreground
      // never steers; the branch ids that follow are the durable owner's anchor.
      getBranch: () => [{
        type: "custom", customType: CALLBACK_SETTINGS_ENTRY,
        data: { version: 1, mode: "hold" },
      }, ...branchIds.map((id) => ({ id }))],
    },
  };
  const pi = {
    events,
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    on(eventName: string, handler: (event: unknown, ctx: unknown) => unknown) {
      const list = handlers.get(eventName) ?? [];
      list.push(handler);
      handlers.set(eventName, list);
    },
    sendMessage(message: { content: string }) {
      messageAttempts.push(message.content);
      if (options.failUserMessage) throw new Error("simulated send failure");
      messages.push(message.content);
    },
  } as unknown as ExtensionAPI;

  backgroundTasksExtension(pi);

  return {
    pi,
    ctx: context,
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
      for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, context);
    },
    async fireSessionShutdown() {
      for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, context);
    },
    async fireSessionTree(nextBranchIds?: readonly string[]) {
      if (nextBranchIds) branchIds = [...nextBranchIds];
      for (const handler of handlers.get("session_tree") ?? []) await handler({ type: "session_tree" }, context);
    },
    async fireAgentStart() {
      idle = false;
      for (const handler of handlers.get("agent_start") ?? []) await handler({ type: "agent_start" }, context);
    },
    async fireAgentSettled() {
      idle = true;
      for (const handler of handlers.get("agent_settled") ?? []) await handler({ type: "agent_settled" }, context);
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
  const match = text.match(/bgs_[0-9a-f]{20}|bg_[a-z0-9_]+/);
  if (!match) throw new Error(`no task id in text: ${text}`);
  return match[0]!;
}

async function waitForText(read: () => Promise<string>, pattern: RegExp, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    text = await read();
    if (pattern.test(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`text did not match ${pattern}: ${text}`);
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