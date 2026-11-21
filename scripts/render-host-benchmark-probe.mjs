// Run-owned probe for scripts/render-host-benchmark.mjs.
//
// It loads the candidate extensions through PI_RENDER_BENCH_ROOT, seeds a small
// visible durable operation set alongside historical rows, instruments the real
// TUI instance Pi mounts, and records actual requestRender calls, doRender
// frames, frame time, process CPU and projection query/row work for one scripted
// streaming tool workload.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { StatementSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.PI_RENDER_BENCH_ROOT;
if (!root) throw new Error("PI_RENDER_BENCH_ROOT is required");
const readyPath = process.env.PI_RENDER_BENCH_READY;
const resultPath = process.env.PI_RENDER_BENCH_RESULT;
if (!readyPath || !resultPath) throw new Error("PI_RENDER_BENCH_READY and PI_RENDER_BENCH_RESULT are required");

const moduleUrl = (relative) => pathToFileURL(join(root, relative)).href;
const { openStore } = await import(moduleUrl("packages/pi-better-background-tasks/src/shared-operation-coordinator/index.ts"));
const { defaultSupervisorDirectory } = await import(moduleUrl("packages/pi-better-background-tasks/src/supervisor/index.ts"));
const { refreshBackgroundWorkNavigator } = await import(moduleUrl("packages/pi-better-background-tasks/src/shared-navigator.ts"));
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
const { Type } = await import("typebox");

const storePath = join(process.env.PI_CODING_AGENT_DIR, "operation-coordinator.sqlite");
const frame = {
  active: false,
  finishing: false,
  tui: undefined,
  metrics: undefined,
  sql: { projectionQueries: 0, projectionRows: 0, reconcileQueries: 0, otherQueries: 0 },
  navigator: { listRowsCalls: 0, rows: 0 },
  sessionId: null,
  startCpu: undefined,
  startedAt: 0,
};
const originalAll = StatementSync.prototype.all;
StatementSync.prototype.all = function countedAll(...args) {
  const rows = originalAll.apply(this, args);
  const sql = String(this.sourceSQL ?? "");
  if (frame.active && sql.includes("FROM operations")) {
    if (sql.includes("phase = ?")) frame.sql.reconcileQueries += 1;
    else if (sql.includes("task_id = ?")) frame.sql.otherQueries += 1;
    else {
      frame.sql.projectionQueries += 1;
      frame.sql.projectionRows += rows.length;
    }
  }
  return rows;
};
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const chunks = 12;

function snapshot(message) {
  return {
    ...message,
    content: message.content.map((block) => ({
      ...block,
      ...(block.arguments ? { arguments: { ...block.arguments } } : {}),
    })),
  };
}
function assistant(model, content, stopReason) {
  return { role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content, stopReason, timestamp: Date.now(), usage: { ...usage, cost: { ...usage.cost } } };
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function streamText(stream, message, text, onDone) {
  message.content = [{ type: "text", text: "" }];
  stream.push({ type: "start", partial: snapshot(message) });
  stream.push({ type: "text_start", contentIndex: 0, partial: snapshot(message) });
  let index = 0;
  const size = Math.max(1, Math.ceil(text.length / chunks));
  const next = () => {
    if (index >= text.length) {
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: snapshot(message) });
      onDone();
      return;
    }
    const delta = text.slice(index, index + size);
    index += delta.length;
    message.content[0].text += delta;
    stream.push({ type: "text_delta", contentIndex: 0, delta, partial: snapshot(message) });
    setTimeout(next, 20);
  };
  setTimeout(next, 20);
}
function streamTool(stream, message, toolCall) {
  const text = "STREAMED_TOOL_HEADER";
  message.content = [{ type: "text", text: "" }];
  stream.push({ type: "start", partial: snapshot(message) });
  stream.push({ type: "text_start", contentIndex: 0, partial: snapshot(message) });
  let textIndex = 0;
  const advanceText = () => {
    if (textIndex >= text.length) {
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: snapshot(message) });
      startTool();
      return;
    }
    const delta = text.slice(textIndex, textIndex + 4);
    textIndex += delta.length;
    message.content[0].text += delta;
    stream.push({ type: "text_delta", contentIndex: 0, delta, partial: snapshot(message) });
    setTimeout(advanceText, 20);
  };
  const startTool = () => {
    const command = `render benchmark command ${"x".repeat(180)}`;
    message.content.push({ type: "toolCall", id: toolCall.id, name: toolCall.name, arguments: {} });
    const toolIndex = message.content.length - 1;
    stream.push({ type: "toolcall_start", contentIndex: toolIndex, partial: snapshot(message) });
    let index = 0;
    const advanceArguments = () => {
      if (index >= command.length) {
        message.content[toolIndex].arguments = { command };
        stream.push({ type: "toolcall_end", contentIndex: toolIndex, toolCall: { id: toolCall.id, name: toolCall.name, arguments: { command } }, partial: snapshot(message) });
        message.stopReason = "toolUse";
        stream.push({ type: "done", reason: "toolUse", message: snapshot(message) });
        stream.end(snapshot(message));
        return;
      }
      const delta = command.slice(index, index + 12);
      index += delta.length;
      message.content[toolIndex].arguments = { command: command.slice(0, index) };
      stream.push({ type: "toolcall_delta", contentIndex: toolIndex, delta, partial: snapshot(message) });
      setTimeout(advanceArguments, 20);
    };
    setTimeout(advanceArguments, 20);
  };
  setTimeout(advanceText, 20);
}
function streamSimple(model, context) {
  const stream = createAssistantMessageEventStream();
  const finished = context.messages.at(-1)?.role === "toolResult";
  if (finished) {
    const message = assistant(model, [], "stop");
    streamText(stream, message, "HOST_STREAM_FINAL_FLUSH", () => {
      message.stopReason = "stop";
      stream.push({ type: "done", reason: "stop", message: snapshot(message) });
      stream.end(snapshot(message));
    });
    return stream;
  }
  const message = assistant(model, [], "toolUse");
  streamTool(stream, message, { id: `bench-tool-${Date.now()}`, name: "render_bench_probe" });
  return stream;
}

function installTui(tui) {
  if (frame.tui) return;
  frame.tui = tui;
  frame.metrics = { frames: 0, requests: 0, frameTimes: [] };
  const originalDoRender = tui.doRender.bind(tui);
  const originalRequestRender = tui.requestRender.bind(tui);
  tui.doRender = function guardedDoRender(...args) {
    const started = performance.now();
    try {
      return originalDoRender(...args);
    } finally {
      if (frame.active) {
        frame.metrics.frames += 1;
        frame.metrics.frameTimes.push(performance.now() - started);
      }
    }
  };
  tui.requestRender = function guardedRequestRender(...args) {
    if (frame.active) frame.metrics.requests += 1;
    return originalRequestRender(...args);
  };
}

function installNavigatorInstrumentation() {
  const state = globalThis[Symbol.for("pi-better-harness.navigator.state")];
  const provider = state?.providers?.get("background-tasks");
  if (!provider || provider.__renderBenchWrapped) return;
  const original = provider.listRows.bind(provider);
  provider.__renderBenchWrapped = true;
  provider.listRows = (now) => {
    const rows = original(now);
    if (frame.active) {
      frame.navigator.listRowsCalls += 1;
      frame.navigator.rows = rows.length;
    }
    return rows;
  };
}

function seed(ctx) {
  const store = openStore({ path: storePath });
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    const workspace = ctx.cwd;
    const supervisor = defaultSupervisorDirectory();
    mkdirSync(join(supervisor, "observed"), { recursive: true });
    for (let index = 0; index < 3_140; index += 1) {
      const operationId = `op-bench-history-${process.pid}-${index}`;
      const owner = {
        kind: "parent-session",
        sessionId: `bench-history-${index % 37}`,
        workspace,
        branchId: `branch-${index % 5}`,
        goalId: null,
      };
      store.registerOperation({
        operationId,
        taskId: `bgs_${(0x200000 + index).toString(16).padStart(20, "0")}`,
        launchToken: `launch-bench-history-${process.pid}-${index}`,
        owner,
        observer: { kind: "background-tasks", version: "1" },
      });
      store.recordTerminalOutcome({
        operationId,
        eventId: `terminal-bench-history-${process.pid}-${index}`,
        outcome: "succeeded",
        owner,
        evidence: [{ kind: "summary", ref: "benchmark-history.json", summary: "historical fixture" }],
      });
    }
    for (let index = 0; index < 3; index += 1) {
      const taskId = `bgs_${(0x300000 + index).toString(16).padStart(20, "0")}`;
      const operationId = `op-bench-current-${process.pid}-${index}`;
      store.registerOperation({
        operationId,
        taskId,
        launchToken: `launch-bench-current-${process.pid}-${index}`,
        owner: { kind: "parent-session", sessionId, workspace, branchId: "bench-main", goalId: null },
        observer: { kind: "background-tasks", version: "1" },
      });
      writeFileSync(join(supervisor, "observed", `${taskId}.json`), "{}");
    }
  } finally {
    store.close();
  }
}

function writeResult(value) {
  const temp = `${resultPath}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2));
  renameSync(temp, resultPath);
}

export default function renderHostBenchmarkProbe(pi) {
  pi.registerProvider("render-bench", {
    api: "render-bench-api",
    apiKey: "fake",
    baseUrl: "http://localhost:0",
    streamSimple,
    models: [{
      id: "local",
      name: "Render benchmark local",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4_096,
    }],
  });
  pi.registerTool({
    name: "render_bench_probe",
    label: "Render benchmark",
    description: "Local streaming render benchmark fixture",
    parameters: Type.Object({ command: Type.String() }),
    async execute() {
      await delay(150);
      return { content: [{ type: "text", text: "HOST_BENCH_TOOL_RESULT" }] };
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    await pi.setModel(ctx.modelRegistry.find("render-bench", "local"));
    frame.sessionId = ctx.sessionManager.getSessionId();
    seed(ctx);
    ctx.ui.setWidget("render-bench-probe", (tui) => {
      installTui(tui);
      return { render: () => [], invalidate() {} };
    });
    const deadline = Date.now() + 10_000;
    while (!frame.tui && Date.now() < deadline) await delay(20);
    if (!frame.tui) throw new Error("render benchmark could not capture the real TUI");
    // The host's 250 ms reconcile discovers the seeded sidecars. Refresh the
    // real navigator explicitly too, so baseline and candidate runs both render
    // the same visible rows even though the baseline has no discovery event.
    await delay(800);
    refreshBackgroundWorkNavigator(ctx);
    installNavigatorInstrumentation();
    await delay(700);
    writeFileSync(readyPath, "ready");
  });
  pi.on("agent_start", () => {
    if (frame.active || frame.finishing) return;
    frame.active = true;
    frame.metrics = { frames: 0, requests: 0, frameTimes: [] };
    frame.sql = { projectionQueries: 0, projectionRows: 0, reconcileQueries: 0, otherQueries: 0 };
    frame.navigator = { listRowsCalls: 0, rows: 0 };
    frame.startCpu = process.cpuUsage();
    frame.startedAt = performance.now();
  });
  pi.on("agent_settled", () => {
    if (!frame.active || frame.finishing) return;
    frame.finishing = true;
    setTimeout(() => {
      frame.active = false;
      const cpu = process.cpuUsage(frame.startCpu);
      const frameTimes = frame.metrics.frameTimes;
      const sorted = [...frameTimes].sort((a, b) => a - b);
      const result = {
        root,
        pid: process.pid,
        sessionId: frame.sessionId,
        animation: process.env.PI_RENDER_BENCH_ANIMATION === "1",
        frames: frame.metrics.frames,
        requests: frame.metrics.requests,
        navigatorListRowsCalls: frame.navigator.listRowsCalls,
        navigatorRows: frame.navigator.rows,
        frameTimeMsMean: frameTimes.length ? frameTimes.reduce((sum, value) => sum + value, 0) / frameTimes.length : 0,
        frameTimeMsP95: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0,
        frameTimeMsMax: sorted.at(-1) ?? 0,
        frameTimesMs: frameTimes,
        processCpuMs: (cpu.user + cpu.system) / 1000,
        durationMs: performance.now() - frame.startedAt,
        projectionQueries: frame.sql.projectionQueries,
        projectionRows: frame.sql.projectionRows,
        reconcileQueries: frame.sql.reconcileQueries,
        otherQueries: frame.sql.otherQueries,
      };
      writeResult(result);
    }, 250);
  });
}
