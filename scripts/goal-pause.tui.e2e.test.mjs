import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

// Real Pi in tmux with a scripted model provider: escape pauses the goal, a
// question is answered without restarting the goal loop, and "go" makes the
// model call goal_resume, after which the continuation runs. Idle Escape also
// respects Pause on Esc, while menu/dialog cancellation and reload remain intact.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packagePiBin = join(repoRoot, "packages", "pi-better-goal", "node_modules", ".bin", "pi");
const piBin = process.env.PI_GOAL_PAUSE_HOST_CLI ||
  (existsSync(packagePiBin) ? packagePiBin : join(repoRoot, "node_modules", ".bin", "pi"));
const extensionPath = join(repoRoot, "packages", "pi-better-goal", "src", "index.ts");
const piAiPath = process.env.PI_GOAL_PAUSE_AI_ENTRY ||
  join(repoRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js");
const fixtures = mkdtempSync(join(tmpdir(), "pi-goal-pause-"));
const probePath = join(fixtures, "scripted-model.mjs");
const readyPath = join(fixtures, "ready");
const logPath = join(fixtures, "model-calls.jsonl");
// A private tmux server (-L) keeps the test off the user's default server.
const session = `pi-goal-pause-${process.pid}`;

after(() => {
  spawnSync("tmux", ["-L", session, "kill-server"], { stdio: "ignore" });
  // kill-server can leave the private socket file behind.
  rmSync(join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`, session), { force: true });
  rmSync(fixtures, { recursive: true, force: true });
});

// @covers goal.pause-discussion
// @level e2e
test("golden path: escape pauses the goal, a question does not resume it, go does", () => {
  assert.equal(spawnSync("tmux", ["-V"], { stdio: "ignore" }).status, 0, "real TUI goal checks require tmux");
  writeFileSync(probePath, scriptedModelExtension());
  startPiSession();
  waitForFile(readyPath);

  sendLiteral("/goal settings");
  waitForScreen((screen) => screen.includes("/goal settings"));
  sendKey("Tab");
  sendKey("Enter");
  waitForScreen((screen) => screen.includes("Goal settings") && screen.includes("Conversational resume"));
  sendKey("Space");
  waitForScreen((screen) => screen.includes("Saved.") && /Automatic continuation\s+Off/.test(screen));
  sendKey("Down");
  sendKey("Enter");
  waitForScreen((screen) => /Conversational resume\s+Off/.test(screen));
  sendKey("Down");
  sendKey("Space");
  waitForScreen((screen) => /Pause on Esc\s+Off/.test(screen));
  const preferencesFile = join(fixtures, "agent", "extensions", "pi-better-goal-preferences.json");
  assert.deepEqual(JSON.parse(readFileSync(preferencesFile, "utf8")), {
    version: 1, autoContinue: false, conversationalResume: false, pauseOnEscape: false,
  });
  sendKey("Space");
  waitForScreen((screen) => /Pause on Esc\s+On/.test(screen));
  sendKey("Up");
  sendKey("Enter");
  waitForScreen((screen) => /Conversational resume\s+On/.test(screen));
  sendKey("Up");
  sendKey("Space");
  waitForScreen((screen) => /Automatic continuation\s+On/.test(screen));
  sendKey("Escape");
  waitForScreen((screen) => !screen.includes("Goal settings"));
  assert.equal(modelCalls().length, 0, "settings changes must not start a model turn");

  sendLiteral("/goal ship the pause widget");
  sendKey("Enter");
  waitForScreen((screen) => screen.includes("goal active") && screen.includes("working through step"), 15_000);
  sendKey("Escape");
  waitForScreen((screen) => screen.includes('goal paused · say "go" or /goal resume'));
  assert.equal(modelCalls().length, 1, "only the first continuation reached the model");
  assert.equal(modelCalls()[0].tools.includes("goal_resume"), false, "a running goal hides goal_resume");

  sendLiteral("why is that step needed?");
  sendKey("Enter");
  waitForScreen((screen) => screen.includes("Because the widget needs it."));
  assertScreenStays((screen) => screen.includes("goal paused"), 2_000);
  const afterQuestion = modelCalls();
  assert.equal(afterQuestion.length, 2, "the question is answered and the goal loop does not restart");
  assert.equal(afterQuestion[1].kind, "question");
  assert.ok(afterQuestion[1].tools.includes("goal_resume"), "a paused goal offers goal_resume");
  assert.match(afterQuestion[1].system, /Call goal_resume only when/);

  sendLiteral("go");
  sendKey("Enter");
  waitForScreen((screen) => screen.includes("goal complete"), 15_000);
  const kinds = modelCalls().map((call) => call.kind);
  assert.deepEqual(kinds, ["slow-continuation", "question", "go", "after-resume", "continuation", "after-complete"]);

  sendLiteral("/goal idle pause fixture");
  sendKey("Enter");
  waitForScreen((screen) => screen.includes("Waiting between turns."));
  waitForFile(join(fixtures, "idle-settled"));

  sendLiteral("/goal ");
  waitForScreen((screen) => screen.includes("Pause the active goal"));
  sendKey("Escape");
  waitForScreen((screen) => !screen.includes("Pause the active goal") && screen.includes("goal active"));
  sendKey("C-u");

  sendLiteral("/settings");
  sendKey("Enter");
  waitForScreen((screen) => screen.includes("Auto-compact"));
  sendKey("Escape");
  waitForScreen((screen) => !screen.includes("Auto-compact") && screen.includes("goal active"));

  sendLiteral("/goal settings");
  sendKey("Tab");
  sendKey("Enter");
  waitForScreen((screen) => screen.includes("Goal settings"));
  sendKey("Escape");
  waitForScreen((screen) => !screen.includes("Goal settings") && screen.includes("goal active"));

  sendLiteral("/goal-dialog");
  sendKey("Tab");
  sendKey("Enter");
  waitForScreen((screen) => screen.includes("Escape dialog probe?"));
  sendKey("Escape");
  waitForScreen((screen) => screen.includes("Dialog cancelled.") && screen.includes("goal active"));

  sendLiteral("/reload");
  sendKey("Tab");
  sendKey("Enter");
  waitForScreen((screen) => screen.includes("Reloaded") && screen.includes("goal active"));
  sendLiteral("/goal settings");
  sendKey("Tab");
  sendKey("Enter");
  waitForScreen((screen) => screen.includes("Goal settings"));
  sendKey("Down");
  sendKey("Down");
  sendKey("Space");
  waitForScreen((screen) => /Pause on Esc\s+Off/.test(screen));
  sendKey("Escape");
  waitForScreen((screen) => !screen.includes("Goal settings") && screen.includes("goal active"));
  sendKey("Escape");
  assertScreenStays((screen) => screen.includes("goal active") && !screen.includes("goal paused"), 1_000);
  assert.equal(JSON.parse(readFileSync(preferencesFile, "utf8")).pauseOnEscape, false);

  sendLiteral("/goal settings");
  sendKey("Tab");
  sendKey("Enter");
  waitForScreen((screen) => screen.includes("Goal settings"));
  sendKey("Down");
  sendKey("Down");
  sendKey("Space");
  waitForScreen((screen) => /Pause on Esc\s+On/.test(screen));
  sendKey("Escape");
  waitForScreen((screen) => !screen.includes("Goal settings") && screen.includes("goal active"));
  const beforeIdlePause = modelCalls().length;
  sendKey("Escape");
  waitForScreen((screen) => screen.includes('goal paused · say "go" or /goal resume'));
  sendLiteral("why is that step needed?");
  sendKey("Enter");
  waitForScreen((screen) => modelCalls().length === beforeIdlePause + 1 && screen.includes("Because the widget needs it."));
  assertScreenStays((screen) => screen.includes("goal paused"), 2_000);
  assert.equal(modelCalls().length, beforeIdlePause + 1, "idle Escape survives reload and ordinary questions cannot restart it");

  sendLiteral("/goal clear");
  sendKey("Tab");
  sendKey("Enter");
  waitForScreen((screen) => !screen.includes("goal paused"));
  sendLiteral("/goal settings pause-on-escape off");
  sendKey("Tab");
  sendKey("Enter");
  waitForScreen((screen) => screen.includes("Pause on Esc setting: off"));
  sendLiteral("/goal streaming off fixture");
  sendKey("Enter");
  waitForScreen((screen) => screen.includes("goal active") && screen.includes("native interrupt probe"), 15_000);
  sendKey("Escape");
  waitForFile(join(fixtures, "off-stream-settled"));
  assert.equal(readFileSync(join(fixtures, "off-stream-end"), "utf8"), "aborted", "Off preserves Pi's native streaming interruption");
  assertScreenStays((screen) => screen.includes("goal active") && !screen.includes("goal paused"), 1_000);
});

function modelCalls() {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function startPiSession() {
  const command = [
    `cd ${shellQuote(fixtures)}`,
    "&& exec env",
    `PI_CODING_AGENT_DIR=${shellQuote(join(fixtures, "agent"))}`,
    "PI_OFFLINE=1",
    "PI_BETTER_GOAL_IDLE_CONTINUATION_DELAY_MS=60000",
    "OPENAI_API_KEY=sk-goal-e2e-placeholder",
    shellQuote(piBin),
    `-e ${shellQuote(extensionPath)}`,
    `-e ${shellQuote(probePath)}`,
    "--approve",
    "--no-skills",
    "--no-context-files",
    `--session-dir ${shellQuote(join(fixtures, "sessions"))}`,
    "--name goal-pause-e2e",
    "--model openai/gpt-4o-mini",
  ].join(" ");
  execFileSync("tmux", ["-L", session, "new-session", "-d", "-s", session, "-x", "110", "-y", "32", command]);
}

function scriptedModelExtension() {
  return `import { appendFileSync, writeFileSync } from "node:fs";
import * as ai from ${JSON.stringify(piAiPath)};
const { createFauxCore, fauxAssistantMessage, fauxToolCall } = ai;

const LOG = ${JSON.stringify(logPath)};
let continuations = 0;
let lastKind;

function textOf(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return (message.content ?? []).map((block) => block.text ?? "").join("\\n");
}

function respond(context) {
  const last = context.messages.at(-1);
  const tools = (context.tools ?? ai.getCurrentTools?.(context.messages) ?? []).map((tool) => tool.name);
  const system = context.systemPrompt ?? ai.getCurrentSystemPrompt?.(context.messages) ?? "";
  let kind;
  let reply;
  if (last?.role === "toolResult" && last.toolName === "goal_resume") {
    kind = "after-resume";
    reply = fauxAssistantMessage("Resuming the goal.");
  } else if (last?.role === "toolResult" && last.toolName === "update_goal") {
    kind = "after-complete";
    reply = fauxAssistantMessage("Goal finished.");
  } else if (textOf(last).includes("Continue working toward the active thread goal")) {
    continuations += 1;
    if (textOf(last).includes("streaming off fixture")) {
      kind = "off-slow-continuation";
      reply = fauxAssistantMessage("native interrupt probe " + "one two three four five six seven eight ".repeat(200));
    } else if (textOf(last).includes("idle pause fixture")) {
      kind = "idle-continuation";
      reply = fauxAssistantMessage("Waiting between turns.");
    } else if (continuations === 1) {
      kind = "slow-continuation";
      reply = fauxAssistantMessage("working through step " + "one two three four five six seven eight ".repeat(200));
    } else {
      kind = "continuation";
      reply = fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" })], { stopReason: "toolUse" });
    }
  } else if (textOf(last).trim() === "go") {
    kind = "go";
    reply = fauxAssistantMessage([fauxToolCall("goal_resume", { reason: "user said go" })], { stopReason: "toolUse" });
  } else {
    kind = "question";
    reply = fauxAssistantMessage("Because the widget needs it.");
  }
  appendFileSync(LOG, JSON.stringify({ kind, tools, system }) + "\\n");
  lastKind = kind;
  return reply;
}

const core = createFauxCore({ api: "scripted-api", provider: "scripted", models: [{ id: "scripted-1" }], tokensPerSecond: 40 });
core.setResponses(Array.from({ length: 50 }, () => respond));

export default function (pi) {
  pi.registerCommand("goal-dialog", {
    description: "Probe Escape dialog cancellation",
    handler: async (_args, ctx) => {
      const accepted = await ctx.ui.confirm("Escape dialog probe?", "Continue?");
      ctx.ui.notify(accepted ? "Dialog accepted." : "Dialog cancelled.", "info");
    },
  });
  pi.on("agent_end", (event) => {
    if (lastKind === "off-slow-continuation") {
      const final = event.messages.filter((message) => message.role === "assistant").at(-1);
      writeFileSync(${JSON.stringify(join(fixtures, "off-stream-end"))}, final?.stopReason ?? "missing");
    }
  });
  pi.on("agent_settled", () => {
    if (lastKind === "idle-continuation") writeFileSync(${JSON.stringify(join(fixtures, "idle-settled"))}, "settled");
    if (lastKind === "off-slow-continuation") writeFileSync(${JSON.stringify(join(fixtures, "off-stream-settled"))}, "settled");
  });
  pi.registerProvider("scripted", {
    baseUrl: "http://localhost:0",
    apiKey: "scripted-key",
    api: "scripted-api",
    streamSimple: core.streamSimple,
    models: [{ id: "scripted-1", name: "Scripted", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
  });
  pi.on("session_start", async (_event, ctx) => {
    const model = ctx.modelRegistry.find("scripted", "scripted-1");
    if (!model || !(await pi.setModel(model))) throw new Error("scripted model unavailable");
    writeFileSync(${JSON.stringify(readyPath)}, "ready");
  });
}
`;
}

function waitForFile(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  throw new Error(`Timed out waiting for Pi session readiness. Current screen:\n${captureScreen()}`);
}

function sendKey(key) {
  execFileSync("tmux", ["-L", session, "send-keys", "-t", session, key]);
}

function sendLiteral(value) {
  execFileSync("tmux", ["-L", session, "send-keys", "-t", session, "-l", value]);
}

function captureScreen() {
  return execFileSync("tmux", ["-L", session, "capture-pane", "-t", session, "-p"], { encoding: "utf8" })
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function waitForScreen(matches, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let screen = "";
  while (Date.now() < deadline) {
    screen = captureScreen();
    if (matches(screen)) return screen;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  throw new Error(`Timed out waiting for the goal screen. Model calls: ${JSON.stringify(modelCalls().map((call) => call.kind))}\nCurrent screen:\n${screen}`);
}

function assertScreenStays(matches, durationMs) {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    const screen = captureScreen();
    assert.ok(matches(screen), `screen changed unexpectedly:\n${screen}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
