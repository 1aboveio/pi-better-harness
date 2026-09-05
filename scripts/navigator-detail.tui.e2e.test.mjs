import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionRoot = resolve(process.env.PI_HARNESS_E2E_PACKAGE_ROOT ?? repoRoot);
const piBin = join(repoRoot, "node_modules", ".bin", "pi");
const session = `pi-navigator-e2e-${process.pid}`;
const fixtures = mkdtempSync(join(tmpdir(), "pi-navigator-e2e-"));
const probePath = join(fixtures, "session-probe.mjs");
const probeStatePath = join(fixtures, "session-state.json");
const subagentId = `sa_navigator_e2e_${process.pid}`;
const taskId = `bg_navigator_e2e_${process.pid}`;
const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const skip = hasTmux ? false : "requires tmux for a real terminal session";

after(() => {
  spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
  rmSync(join(tmpdir(), "pi-better-subagents", "runs", subagentId), { recursive: true, force: true });
  rmSync(join(tmpdir(), "pi-better-background-tasks", "tasks", taskId), { recursive: true, force: true });
  rmSync(fixtures, { recursive: true, force: true });
});

// @covers navigator.detail-overlay
// @level e2e
test("golden path: subagent and background-task detail pages retain one input bar", { skip }, () => {
  assert.ok(existsSync(piBin), `workspace Pi binary is missing: ${piBin}`);
  assert.ok(existsSync(join(extensionRoot, "package.json")), `extension package is missing: ${extensionRoot}`);

  writeFileSync(probePath, probeExtension(probeStatePath));
  startPiSession();
  const state = waitForJson(probeStatePath);
  const piPid = Number(execFileSync("tmux", ["display-message", "-p", "-t", session, "#{pane_pid}"], { encoding: "utf8" }).trim());
  seedNavigatorState({ cwd: state.cwd, sessionId: state.sessionId, piPid });

  sendKey("Left");
  sendKey("Down");
  const subagentPage = waitForScreen((screen) => screen.includes("subagent golden path") && screen.includes("provider Subagents"));
  assertSingleInputFrame(subagentPage, "subagent detail");
  assert.match(subagentPage, /transcript · latest 10 rows/, "subagent detail must render its transcript section");

  sendKey("Down");
  const taskPage = waitForScreen((screen) => screen.includes("background golden path") && screen.includes("provider Background Tasks"));
  assertSingleInputFrame(taskPage, "background-task detail");
  assert.match(taskPage, /log(?: tail)? · latest 10 rows/, "background-task detail must render its log tail");
});

function startPiSession() {
  const command = [
    `cd ${shellQuote(extensionRoot)}`,
    "&& exec env",
    `PI_CODING_AGENT_DIR=${shellQuote(join(fixtures, "agent"))}`,
    "PI_OFFLINE=1",
    "OPENAI_API_KEY=sk-tui-e2e-placeholder",
    shellQuote(piBin),
    `-e ${shellQuote(extensionRoot)}`,
    `-e ${shellQuote(probePath)}`,
    "--approve",
    "--no-skills",
    "--no-context-files",
    `--session-dir ${shellQuote(join(fixtures, "sessions"))}`,
    "--name navigator-tui-e2e",
    "--model openai/gpt-4o-mini",
  ].join(" ");
  execFileSync("tmux", ["new-session", "-d", "-s", session, "-x", "100", "-y", "32", command]);
}

function probeExtension(path) {
  return `export default function(pi) {\n  pi.on("session_start", async (_event, ctx) => {\n    const fs = await import("node:fs");\n    fs.writeFileSync(${JSON.stringify(path)}, JSON.stringify({ cwd: ctx.cwd, sessionId: ctx.sessionManager?.getSessionId() }, null, 2));\n  });\n}\n`;
}

function seedNavigatorState({ cwd, sessionId, piPid }) {
  const now = Date.now();
  const callbackOrigin = { cwd, sessionId };
  const subagentDir = join(tmpdir(), "pi-better-subagents", "runs", subagentId);
  mkdirSync(subagentDir, { recursive: true });
  const subagentLog = join(subagentDir, "output.log");
  writeFileSync(subagentLog, `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "subagent output" }] } })}\n`);
  writeJson(join(subagentDir, "meta.json"), {
    id: subagentId,
    name: "subagent golden path",
    status: "running",
    pid: piPid,
    pgid: piPid,
    spawnPid: piPid,
    model: "openai/gpt-5.5",
    cwd,
    promptPreview: "verify the subagent detail page",
    startedAt: now - 60_000,
    logPath: subagentLog,
    sessionId: subagentId,
    callbackOrigin,
    callback: false,
  });

  const taskDir = join(tmpdir(), "pi-better-background-tasks", "tasks", taskId);
  mkdirSync(taskDir, { recursive: true });
  const taskLog = join(taskDir, "output.log");
  writeFileSync(taskLog, "background task output\n");
  writeJson(join(taskDir, "meta.json"), {
    id: taskId,
    name: "background golden path",
    kind: "command_watch",
    status: "running",
    startedAt: now - 30_000,
    logPath: taskLog,
    cwd,
    command: "printf 'background task output\\n'",
    shell: true,
    pid: piPid,
    pgid: piPid,
    spawnPid: piPid,
    callbackOrigin,
    callback: false,
    intervalMs: 15_000,
    deadlineAt: now + 600_000,
  });
}

function assertSingleInputFrame(screen, pageName) {
  const terminalRows = screen.split(/\r?\n/).map((line) => line.trimEnd());
  if (terminalRows.at(-1) === "") terminalRows.pop();
  const borderRows = terminalRows
    .filter((line) => /^─{20,}$/u.test(line));
  assert.equal(
    borderRows.length,
    2,
    `${pageName} must contain exactly one input frame (two border rows), found ${borderRows.length}:\n${screen}`,
  );
  assert.match(
    terminalRows.at(-1) ?? "",
    /^─{20,}$/u,
    `${pageName} input frame must be flush with the bottom so no second editor can render below it:\n${screen}`,
  );
}

function sendKey(key) {
  execFileSync("tmux", ["send-keys", "-t", session, key]);
}

function captureScreen() {
  return execFileSync("tmux", ["capture-pane", "-t", session, "-p"], { encoding: "utf8" })
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function waitForScreen(matches, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let screen = "";
  while (Date.now() < deadline) {
    screen = captureScreen();
    if (matches(screen)) return screen;
    sleep(50);
  }
  throw new Error(`Timed out waiting for navigator page. Current screen:\n${screen}`);
}

function waitForJson(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
    sleep(50);
  }
  throw new Error(`Timed out waiting for Pi session probe. Current screen:\n${captureScreen()}`);
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}