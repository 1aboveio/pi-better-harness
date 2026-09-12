import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const piBin = join(repoRoot, "node_modules", ".bin", "pi");
const extensionPath = join(repoRoot, "packages", "pi-better-plan", "src", "index.ts");
const fixtures = mkdtempSync(join(tmpdir(), "pi-plan-navigation-"));
const probePath = join(fixtures, "seed-plan.mjs");
const readyPath = join(fixtures, "ready");
const session = `pi-plan-navigation-${process.pid}`;

after(() => {
  spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
  rmSync(fixtures, { recursive: true, force: true });
});

// @covers plan.passive-widget
// @level e2e
test("golden path: the plan stays passive and right arrow remains editor input", () => {
  assert.equal(spawnSync("tmux", ["-V"], { stdio: "ignore" }).status, 0, "real TUI plan rendering requires tmux");
  writeFileSync(probePath, seedPlanExtension(readyPath));
  startPiSession();
  waitForFile(readyPath);

  sendLiteral("/seed-plan");
  sendKey("Enter");
  const initial = waitForScreen((screen) => screen.includes("plan 1/3 steps"));
  assert.doesNotMatch(initial, /^› /m, "the plan starts visible but unfocused");
  assert.doesNotMatch(initial, /→ plan/, "the footer does not advertise plan navigation");

  sendKey("Right");
  const unchanged = assertScreenNeverMatches(/^› /m, 500);
  assert.doesNotMatch(unchanged, /→ plan/);
  sendLiteral("draft");
  waitForScreen((screen) => screen.includes("draft"));
  assert.doesNotMatch(captureScreen(), /^› /m, "typing does not focus the plan");
});

function startPiSession() {
  const command = [
    `cd ${shellQuote(repoRoot)}`,
    "&& exec env",
    `PI_CODING_AGENT_DIR=${shellQuote(join(fixtures, "agent"))}`,
    "PI_OFFLINE=1",
    "OPENAI_API_KEY=sk-plan-e2e-placeholder",
    shellQuote(piBin),
    `-e ${shellQuote(extensionPath)}`,
    `-e ${shellQuote(probePath)}`,
    "--approve",
    "--no-skills",
    "--no-context-files",
    `--session-dir ${shellQuote(join(fixtures, "sessions"))}`,
    "--name plan-navigation-e2e",
    "--model openai/gpt-4o-mini",
  ].join(" ");
  execFileSync("tmux", ["new-session", "-d", "-s", session, "-x", "100", "-y", "32", command]);
}

function seedPlanExtension(path) {
  return `export default function(pi) {
  pi.on("session_start", async () => {
    const fs = await import("node:fs");
    fs.writeFileSync(${JSON.stringify(path)}, "ready");
  });
  pi.registerCommand("seed-plan", {
    description: "Seed plan navigation fixture",
    handler: async (_args, ctx) => {
      const now = Math.floor(Date.now() / 1000);
      pi.appendEntry("pi-better-plan", {
        version: 1,
        kind: "set",
        at: now,
        plan: {
          version: 1,
          planId: "plan_e2e",
          revision: 1,
          steps: [
            { id: "step_1", step: "Inspect the navigator", status: "completed" },
            { id: "step_2", step: "Implement plan navigation", status: "in_progress" },
            { id: "step_3", step: "Verify the terminal journey", status: "pending" }
          ],
          createdAt: now,
          updatedAt: now
        }
      });
      await ctx.reload();
    }
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
  execFileSync("tmux", ["send-keys", "-t", session, key]);
}

function sendLiteral(value) {
  execFileSync("tmux", ["send-keys", "-t", session, "-l", value]);
}

function captureScreen() {
  return execFileSync("tmux", ["capture-pane", "-t", session, "-p"], { encoding: "utf8" })
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
  throw new Error(`Timed out waiting for plan navigation. Current screen:\n${screen}`);
}

function assertScreenNeverMatches(pattern, durationMs) {
  const deadline = Date.now() + durationMs;
  let screen = "";
  while (Date.now() < deadline) {
    screen = captureScreen();
    assert.doesNotMatch(screen, pattern);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return screen;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}