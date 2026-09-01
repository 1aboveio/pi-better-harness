import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, "docs/images/package-gallery/real-session");
const SESSION = `pi-gallery-${process.pid}`;
const WIDTH = 1200;
const HEIGHT = 675;
const SEEDED_SUBAGENTS = ["sa_gallery_review", "sa_gallery_tests"];
const SEEDED_TASKS = ["bg_gallery_server", "bg_gallery_ci"];

mkdirSync(OUT_DIR, { recursive: true });

try {
  requireBin("tmux");
  requireBin("pi");
  requireBin("sips");

  const work = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
  const probePath = join(work, "session-probe.mjs");
  const probeStatePath = join(work, "session-state.json");
  writeFileSync(probePath, probeExtension(probeStatePath));

  cleanupSeededState();
  startPiSession(work, probePath);
  try {
    const state = waitForProbe(probeStatePath);
    const piPid = Number(execFileSync("tmux", ["display-message", "-p", "-t", SESSION, "#{pane_pid}"], { encoding: "utf8" }).trim());
    seedExtensionState({ piPid, cwd: state.cwd, sessionId: state.sessionId });

    execFileSync("tmux", ["send-keys", "-t", SESSION, "Left"]);
    sleep(700);
    execFileSync("tmux", ["send-keys", "-t", SESSION, "-l", "/goal Capture package gallery screenshot"]);
    execFileSync("tmux", ["send-keys", "-t", SESSION, "Enter"]);
    sleep(1100);

    const pane = execFileSync("tmux", ["capture-pane", "-t", SESSION, "-p", "-S", "-140"], { encoding: "utf8" });
    if (/api key|incorrect api key|sk-[a-z0-9]/i.test(pane)) {
      throw new Error("Refusing to write gallery screenshot because captured pane contains provider/auth output.");
    }
    const lines = cropInterestingPane(pane);
    const txtPath = join(OUT_DIR, "pi-better-harness.txt");
    const svgPath = join(OUT_DIR, "pi-better-harness.svg");
    const pngPath = join(OUT_DIR, "pi-better-harness.png");
    writeFileSync(txtPath, `${lines.join("\n")}\n`);
    writeFileSync(svgPath, renderTerminalSvg(lines));
    execFileSync("sips", ["-s", "format", "png", svgPath, "--out", pngPath], { stdio: "ignore" });
    console.log(`real Pi session gallery: ${pngPath}`);
  } finally {
    stopTmux();
    cleanupSeededState();
    rmSync(work, { recursive: true, force: true });
  }
} catch (error) {
  stopTmux();
  cleanupSeededState();
  throw error;
}

function requireBin(name) {
  const result = spawnSync("command", ["-v", name], { shell: true, stdio: "ignore" });
  if (result.status !== 0) throw new Error(`Required command not found: ${name}`);
}

function probeExtension(path) {
  return `export default function(pi) {\n  pi.on("session_start", async (_event, ctx) => {\n    const fs = await import("node:fs");\n    let sessionId;\n    try { sessionId = ctx.sessionManager?.getSessionId(); } catch {}\n    fs.writeFileSync(${JSON.stringify(path)}, JSON.stringify({ cwd: ctx.cwd, sessionId, mode: ctx.mode, hasUI: ctx.hasUI }, null, 2));\n  });\n}\n`;
}

function startPiSession(work, probePath) {
  const command = [
    `cd ${shellQuote(ROOT)} &&`,
    `PI_CODING_AGENT_DIR=${shellQuote(join(work, "agent"))}`,
    "PI_OFFLINE=1",
    "OPENAI_API_KEY=sk-gallery-placeholder",
    "pi -e .",
    `-e ${shellQuote(probePath)}`,
    "--no-skills",
    "--no-context-files",
    `--session-dir ${shellQuote(join(work, "sessions"))}`,
    "--name gallery-capture",
    "--model openai/gpt-4o-mini",
  ].join(" ");
  execFileSync("tmux", ["new-session", "-d", "-s", SESSION, "-x", "120", "-y", "34", command]);
}

function waitForProbe(path) {
  for (let i = 0; i < 240; i += 1) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
    sleep(100);
  }
  let pane = "";
  try {
    pane = execFileSync("tmux", ["capture-pane", "-t", SESSION, "-p", "-S", "-80"], { encoding: "utf8" });
  } catch {
    pane = "(tmux pane unavailable)";
  }
  throw new Error(`Timed out waiting for Pi session_start probe. Current pane:\n${pane}`);
}

function seedExtensionState({ piPid, cwd, sessionId }) {
  const now = Date.now();
  const origin = { cwd, sessionId };
  for (const [id, name, offset, model] of [
    ["sa_gallery_review", "reviewer", 128_000, "xai/grok-4.5"],
    ["sa_gallery_tests", "test scout", 204_000, "openai/gpt-5"],
  ]) {
    const dir = join(tmpdir(), "pi-better-subagents", "runs", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "output.log"), "Reviewing package gallery screenshot\n");
    writeJson(join(dir, "meta.json"), {
      id,
      name,
      status: "running",
      pid: piPid,
      pgid: piPid,
      spawnPid: piPid,
      model,
      cwd,
      promptPreview: "Capture package gallery screenshot",
      startedAt: now - offset,
      logPath: join(dir, "output.log"),
      sessionId: id,
      callbackOrigin: origin,
      callback: false,
    });
  }

  for (const [id, name, kind, offset, command] of [
    ["bg_gallery_server", "dev server", "process", 372_000, "npm run dev"],
    ["bg_gallery_ci", "CI workflow", "command_watch", 210_000, "gh run watch --exit-status"],
  ]) {
    const dir = join(tmpdir(), "pi-better-background-tasks", "tasks", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "output.log"), "ready · running\n");
    writeJson(join(dir, "meta.json"), {
      id,
      name,
      kind,
      status: "running",
      startedAt: now - offset,
      logPath: join(dir, "output.log"),
      cwd,
      command,
      shell: true,
      pid: piPid,
      pgid: piPid,
      spawnPid: piPid,
      callbackOrigin: origin,
      callback: false,
      intervalMs: kind === "command_watch" ? 30_000 : undefined,
      deadlineAt: kind === "command_watch" ? now + 720_000 : undefined,
    });
  }
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function cleanupSeededState() {
  for (const id of SEEDED_SUBAGENTS) {
    rmSync(join(tmpdir(), "pi-better-subagents", "runs", id), { recursive: true, force: true });
  }
  for (const id of SEEDED_TASKS) {
    rmSync(join(tmpdir(), "pi-better-background-tasks", "tasks", id), { recursive: true, force: true });
  }
}

function stopTmux() {
  spawnSync("tmux", ["kill-session", "-t", SESSION], { stdio: "ignore" });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function cropInterestingPane(pane) {
  const raw = pane.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").split(/\r?\n/).map((line) => line.trimEnd());
  const start = raw.findIndex((line) => line.includes("Goal set:"));
  const end = raw.findIndex((line, idx) => idx > start && line.includes("bg "));
  const lines = raw.slice(Math.max(0, start), end >= 0 ? end + 1 : undefined).filter((line, idx, arr) => {
    if (idx === arr.length - 1) return true;
    return !(line.trim() === "" && arr[idx + 1]?.trim() === "");
  });
  return [
    "$ pi -e . --name gallery-capture",
    "real Pi TUI session · pi-better-harness extensions loaded",
    "",
    ...lines,
  ].slice(0, 24);
}

function renderTerminalSvg(lines) {
  const body = lines.map((line, index) => renderLine(line, 96, 148 + index * 24)).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#07111d"/><stop offset="1" stop-color="#172033"/></linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#000" flood-opacity="0.34"/></filter>
    <clipPath id="bodyClip"><rect x="82" y="108" width="1036" height="500" rx="8"/></clipPath>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <g opacity="0.08">${gridLines()}</g>
  <g filter="url(#shadow)"><rect x="58" y="48" width="1084" height="578" rx="16" fill="#090f1a" stroke="#334155" stroke-width="2"/></g>
  <rect x="58" y="48" width="1084" height="52" rx="16" fill="#111827"/>
  <path d="M58 100 H1142" stroke="#263244"/>
  <circle cx="92" cy="74" r="7" fill="#ef4444"/><circle cx="118" cy="74" r="7" fill="#f59e0b"/><circle cx="144" cy="74" r="7" fill="#22c55e"/>
  <text x="174" y="80" font-family="SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="15" font-weight="700" fill="#cbd5e1">real pi session</text>
  <text x="1070" y="80" text-anchor="end" font-family="SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="14" font-weight="700" fill="#93c5fd">goal + subagents + background tasks</text>
  <g clip-path="url(#bodyClip)">${body}</g>
</svg>
`;
}

function renderLine(line, x, y) {
  const trimmed = line.trimStart();
  const fill = trimmed.startsWith("▸ goal") ? "#bbf7d0"
    : trimmed.startsWith("▸") ? "#7dd3fc"
      : trimmed.startsWith("›") || trimmed.includes("●") ? "#dbeafe"
        : trimmed.startsWith("$") ? "#f8fafc"
          : trimmed.includes("bg ") ? "#93c5fd"
            : "#cbd5e1";
  const weight = trimmed.startsWith("▸") || trimmed.startsWith("$") ? 800 : 550;
  return `<text x="${x}" y="${y}" font-family="SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="17" font-weight="${weight}" fill="${fill}">${escapeXml(line)}</text>`;
}

function gridLines() {
  const parts = [];
  for (let x = 78; x < WIDTH; x += 96) parts.push(`<path d="M${x} 0 V${HEIGHT}" stroke="#94a3b8"/>`);
  for (let y = 86; y < HEIGHT; y += 78) parts.push(`<path d="M0 ${y} H${WIDTH}" stroke="#94a3b8"/>`);
  return parts.join("\n");
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
