import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { truncateToWidth } from "@earendil-works/pi-tui";

import { renderGoalClockLine } from "../packages/pi-better-goal/src/goal-clock.ts";
import { summarizeActiveBackground } from "../packages/pi-better-goal/src/activity.ts";
import { buildWidgetLines, fmtElapsed, fmtSpend, shortModel } from "../packages/pi-better-subagents/widget.mjs";
import {
  buildDetailLines as buildSubagentDetailLines,
  buildNavigatorLines as buildSubagentNavigatorLines,
  buildNavigatorRows,
  createNavigatorState,
} from "../packages/pi-better-subagents/navigator.mjs";
import {
  disposeBackgroundWorkNavigator,
  ensureBackgroundWorkNavigator,
  registerBackgroundWorkProvider,
} from "../packages/pi-better-background-tasks/src/shared-navigator.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, "docs/images/package-gallery");
const WIDTH = 1200;
const HEIGHT = 675;
const TERMINAL_COLUMNS = 76;
const NOW = 1_800_000;
const NOW_SECONDS = 1_800;

mkdirSync(OUT_DIR, { recursive: true });

const packages = [
  {
    id: "pi-better-harness",
    command: "pi -e npm:pi-better-harness",
    title: "full bundle",
    status: "subagents + tasks + goal",
    blocks: [
      { label: "goal rail", lines: goalLines(TERMINAL_COLUMNS) },
      { label: "background-work navigator", lines: backgroundWorkLines("harness", TERMINAL_COLUMNS) },
      { label: "activity summary", lines: activityLines() },
    ],
    footer: "← navigate · 4     /goal active     background activity keeps the turn open",
  },
  {
    id: "pi-better-subagents",
    command: "pi -e npm:pi-better-subagents",
    title: "detached subagents",
    status: "live widget + navigator",
    blocks: [
      { label: "subagent widget", lines: subagentWidgetLines() },
      { label: "subagent navigator", lines: subagentNavigatorLines(TERMINAL_COLUMNS) },
      { label: "detail view", lines: subagentDetailLines(TERMINAL_COLUMNS) },
    ],
    footer: "← subagents · 3     ↑↓ select · Enter view · x stop · Esc close",
  },
  {
    id: "pi-better-background-tasks",
    command: "pi -e npm:pi-better-background-tasks",
    title: "durable shell tasks",
    status: "processes + watchers",
    blocks: [
      { label: "background-work navigator", lines: backgroundWorkLines("background", TERMINAL_COLUMNS) },
      { label: "task detail", lines: backgroundTaskDetailLines() },
      { label: "tool result", lines: bgStatusLines() },
    ],
    footer: "← navigate · 3     ↑↓ select · Enter detail · x stop · Esc unfocus",
  },
  {
    id: "pi-better-goal",
    command: "pi -e npm:pi-better-goal",
    title: "goal tracking",
    status: "background-aware continuation",
    blocks: [
      { label: "goal rail", lines: goalLines(TERMINAL_COLUMNS) },
      { label: "get_goal", lines: getGoalLines() },
      { label: "background activity", lines: activityLines() },
    ],
    footer: "background drains to zero → follow-up wakes the completion audit",
  },
];

for (const pkg of packages) {
  const svg = renderScreenshot(pkg);
  const svgPath = join(OUT_DIR, `${pkg.id}.svg`);
  const pngPath = join(OUT_DIR, `${pkg.id}.png`);
  writeFileSync(svgPath, svg);
  execFileSync("sips", ["-s", "format", "png", svgPath, "--out", pngPath], { stdio: "ignore" });
  console.log(`${pkg.id}: ${svgPath} -> ${pngPath}`);
}

function subagentWidgetLines() {
  return buildWidgetLines({
    running: [
      { id: "sa_review", name: "reviewer", model: "xai/grok-4.5", startedAt: NOW - 128_000 },
      { id: "sa_tests", name: "test scout", model: "openai/gpt-5", startedAt: NOW - 47_000 },
    ],
    frame: 2,
    now: NOW,
    affordanceHint: "← subagents · 3",
    selectedId: "sa_review",
    spendById: {
      sa_review: { tool: "bash", usage: { total: 12400, input: 9100, output: 3300, costUSD: 0.042 } },
      sa_tests: { tool: "read", usage: { total: 2800, input: 2200, output: 600, costUSD: 0.0087 } },
    },
  });
}

function subagentNavigatorLines(width) {
  const rows = buildNavigatorRows(subagentMetas(), {
    effectiveStatus: (meta) => meta.status,
    shortModel,
    fmtElapsed,
    spendFor: (meta) => fmtSpend(meta.usage),
    toolFor: (meta) => meta.tool,
    effortFor: (meta) => meta.effort,
    now: NOW,
  });
  const state = createNavigatorState(rows);
  state.selected = 0;
  return buildSubagentNavigatorLines(state, { width, truncate: truncatePlain });
}

function subagentDetailLines(width) {
  return buildSubagentDetailLines({
    id: "sa_review",
    name: "reviewer",
    status: "running",
    model: "grok-4.5",
    elapsed: "2m 08s",
    currentTool: "bash",
    tools: "read, bash",
    spend: "12.4k tok (↑9.1k ↓3.3k) · $0.04",
    output: "Reviewing README claims against package metadata\nChecking npm tarball contents\nWaiting for CI result",
  }, { width, truncate: truncatePlain }).slice(0, 8);
}

function subagentMetas() {
  return [
    {
      id: "sa_review",
      name: "reviewer",
      status: "running",
      model: "xai/grok-4.5",
      effort: "high",
      startedAt: NOW - 128_000,
      tool: "bash",
      usage: { total: 12400, input: 9100, output: 3300, costUSD: 0.042 },
    },
    {
      id: "sa_tests",
      name: "test scout",
      status: "completed",
      model: "openai/gpt-5",
      startedAt: NOW - 204_000,
      endedAt: NOW - 31_000,
      tool: "read",
      usage: { total: 2800, input: 2200, output: 600, costUSD: 0.0087 },
    },
    {
      id: "sa_docs",
      name: "docs pass",
      status: "completed",
      model: "openai/gpt-5-mini",
      startedAt: NOW - 330_000,
      endedAt: NOW - 118_000,
      usage: { total: 4100, input: 3000, output: 1100, costUSD: 0.011 },
    },
  ];
}

function backgroundWorkLines(kind, width) {
  const providers = kind === "background" ? [backgroundProvider()] : [subagentProvider(), backgroundProvider()];
  const ui = createFakeUi();
  const unregister = providers.map((provider) => registerBackgroundWorkProvider(provider));
  try {
    ensureBackgroundWorkNavigator(fakeCtx(ui), {
      createDefaultEditor: () => ({ getText: () => "", handleInput: () => undefined }),
      isOpenTrigger: (data) => data === "left",
      matchKey: (data, keyId) => data === keyId,
      truncate: truncatePlain,
    });
    const component = ui.widgetFactory?.({ requestRender() {} }, { fg: (_color, value) => value }, {});
    return component?.render(width)?.map(stripStyle) ?? [];
  } finally {
    disposeBackgroundWorkNavigator(fakeCtx(ui));
    for (const unreg of unregister.reverse()) unreg();
  }
}

function subagentProvider() {
  return {
    id: "subagents",
    label: "Subagents",
    priority: 10,
    visibleCount: () => 2,
    listRows: () => [
      {
        providerId: "subagents",
        id: "sa_review",
        name: "reviewer",
        status: "running",
        statusTone: "running",
        kind: "subagent",
        model: "grok-4.5",
        effort: "high",
        tool: "bash",
        tokens: "12.4k tok",
        elapsed: "2m 08s",
        primary: "review README polish",
        sortStartedAt: NOW - 128_000,
      },
      {
        providerId: "subagents",
        id: "sa_tests",
        name: "test scout",
        status: "completed",
        statusTone: "success",
        kind: "subagent",
        model: "gpt-5",
        tokens: "2.8k tok",
        elapsed: "2m 53s",
        primary: "focused regression suite",
        sortStartedAt: NOW - 204_000,
      },
    ],
    detail: () => null,
    armCloseLabel: (row) => row.status === "running" ? "x again to stop" : "x again to dismiss",
    close: (id) => ({ action: "dismissed", providerId: "subagents", id }),
  };
}

function backgroundProvider() {
  return {
    id: "background-tasks",
    label: "Background Tasks",
    priority: 20,
    visibleCount: () => 3,
    listRows: () => [
      {
        providerId: "background-tasks",
        id: "bg_server",
        name: "dev server",
        status: "running",
        statusTone: "running",
        kind: "process",
        elapsed: "6m 12s",
        primary: "npm run dev",
        command: "npm run dev",
        facts: ["process running"],
        sortStartedAt: NOW - 372_000,
      },
      {
        providerId: "background-tasks",
        id: "bg_ci",
        name: "CI workflow",
        status: "running",
        statusTone: "running",
        kind: "watch",
        elapsed: "3m 30s",
        primary: "gh run watch 30521635578",
        command: "gh run watch 30521635578 --exit-status",
        facts: ["every 30s", "12m left"],
        sortStartedAt: NOW - 210_000,
      },
      {
        providerId: "background-tasks",
        id: "bg_pack",
        name: "pack dry run",
        status: "succeeded",
        statusTone: "success",
        kind: "process",
        elapsed: "22s",
        primary: "npm pack --dry-run",
        command: "npm pack --dry-run -w packages/pi-better-harness",
        facts: ["exit 0"],
        sortStartedAt: NOW - 88_000,
      },
    ],
    detail: () => null,
    armCloseLabel: (row) => row.status === "running" ? "x again to stop" : "x again to dismiss",
    close: (id) => ({ action: "dismissed", providerId: "background-tasks", id }),
  };
}

function backgroundTaskDetailLines() {
  return [
    "Background Tasks / dev server",
    "status     running",
    "kind       process",
    "elapsed    6m 12s",
    "cwd        /Users/exoulster/projects/pi-better-harness",
    "command    npm run dev",
    "log tail   ready in 842ms · http://localhost:5173",
  ];
}

function bgStatusLines() {
  return [
    "bg_task_status bg_server",
    "status: running",
    "kind: process",
    "elapsed: 6m 12s",
    "log: .../tasks/bg_server/output.log",
  ];
}

function goalLines(width) {
  return [renderGoalClockLine(goalSnapshot(), width, NOW_SECONDS, (_color, value) => value)];
}

function getGoalLines() {
  const goal = goalSnapshot();
  return [
    "Goal: Publish cleaner package README previews",
    `Status: ${goal.status}`,
    "Token budget: none",
    "Tokens used: 18420",
    "Active time: 12m 34s",
    "Elapsed time: 18m 20s",
  ];
}

function goalSnapshot() {
  return {
    goalId: "goal_gallery",
    objective: "Publish cleaner package README previews",
    status: "active",
    tokenBudget: null,
    usage: { tokensUsed: 18420, activeSeconds: 514 },
    createdAt: NOW_SECONDS - 1100,
    updatedAt: NOW_SECONDS - 10,
    activeStartedAt: NOW_SECONDS - 240,
    completedAt: null,
  };
}

function activityLines() {
  const snapshot = {
    version: 1,
    category: "background-running",
    foregroundRunning: false,
    backgroundRunning: true,
    activeBackgroundCount: 3,
    unhealthyBackgroundCount: 0,
    terminalAttentionCount: 1,
    generatedAt: NOW,
    providers: [
      {
        providerId: "subagents",
        label: "Subagents",
        items: [
          { id: "sa_review", label: "reviewer", status: "running", active: true },
          { id: "sa_tests", label: "test scout", status: "completed", active: false, terminal: true, attention: true },
        ],
      },
      {
        providerId: "background-tasks",
        label: "Background Tasks",
        items: [
          { id: "bg_server", label: "dev server", status: "running", active: true },
          { id: "bg_ci", label: "CI workflow", status: "running", active: true },
        ],
      },
    ],
  };
  return [
    `Activity: ${snapshot.category}`,
    `Background active: ${snapshot.activeBackgroundCount}`,
    `Terminal attention: ${snapshot.terminalAttentionCount}`,
    summarizeActiveBackground(snapshot),
  ];
}

function createFakeUi() {
  return {
    widgetFactory: undefined,
    setStatus() {},
    setWidget(_key, value) {
      if (typeof value === "function") this.widgetFactory = value;
    },
    getEditorComponent() { return undefined; },
    setEditorComponent() {},
    theme: { fg: (_color, value) => value },
  };
}

function fakeCtx(ui) {
  return {
    mode: "tui",
    hasUI: true,
    ui,
    cwd: ROOT,
    sessionManager: { getSessionId: () => "gallery" },
  };
}

function truncatePlain(value, width) {
  return truncateToWidth(stripStyle(value), width);
}

function stripStyle(value) {
  return String(value ?? "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/<\/?[a-z][^>]*>/gi, "");
}

function renderScreenshot(pkg) {
  const lines = [];
  lines.push(`$ ${pkg.command}`);
  lines.push("pi session ready · package preview uses rendered extension state");
  lines.push("");
  for (const block of pkg.blocks) {
    lines.push(`[${block.label}]`);
    for (const line of block.lines) lines.push(stripStyle(line));
    lines.push("");
  }
  const clipped = fitToRows(lines, 18);
  const text = clipped.map((line, i) => renderTextLine(line, 98, 162 + i * 24, i)).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#07111d"/>
      <stop offset="0.55" stop-color="#101827"/>
      <stop offset="1" stop-color="#172033"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#000" flood-opacity="0.34"/>
    </filter>
    <clipPath id="bodyClip"><rect x="82" y="108" width="1036" height="468" rx="8"/></clipPath>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <g opacity="0.08">
    ${gridLines()}
  </g>
  <g filter="url(#shadow)">
    <rect x="58" y="48" width="1084" height="578" rx="16" fill="#090f1a" stroke="#334155" stroke-width="2"/>
  </g>
  <rect x="58" y="48" width="1084" height="52" rx="16" fill="#111827"/>
  <path d="M58 100 H1142" stroke="#263244"/>
  <circle cx="92" cy="74" r="7" fill="#ef4444"/>
  <circle cx="118" cy="74" r="7" fill="#f59e0b"/>
  <circle cx="144" cy="74" r="7" fill="#22c55e"/>
  <text x="174" y="80" font-family="SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="15" font-weight="700" fill="#cbd5e1">${escapeXml(pkg.id)}</text>
  <text x="990" y="80" text-anchor="end" font-family="SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="14" font-weight="600" fill="#94a3b8">${escapeXml(pkg.title)}</text>
  <rect x="1002" y="59" width="110" height="30" rx="15" fill="#172554" stroke="#60a5fa"/>
  <text x="1057" y="79" text-anchor="middle" font-family="SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="13" font-weight="700" fill="#bfdbfe">actual UI</text>
  <text x="94" y="132" font-family="SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="18" font-weight="700" fill="#e5e7eb">${escapeXml(pkg.status)}</text>
  <g clip-path="url(#bodyClip)">
  ${text}
  </g>
  <rect x="82" y="584" width="1036" height="34" rx="8" fill="#0f172a" stroke="#243044"/>
  <text x="98" y="606" font-family="SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="16" fill="#93c5fd">${escapeXml(pkg.footer)}</text>
</svg>
`;
}

function fitToRows(lines, maxRows) {
  const out = [];
  for (const line of lines) {
    if (out.length >= maxRows) break;
    out.push(line.length > 86 ? `${line.slice(0, 85)}…` : line);
  }
  return out;
}

function renderTextLine(line, x, y, index) {
  const fill = line.startsWith("[") ? "#7dd3fc"
    : line.startsWith("$") ? "#f8fafc"
      : line.trim() === "" ? "#94a3b8"
        : line.includes("running") || line.includes("active") ? "#d1fae5"
          : line.includes("completed") || line.includes("succeeded") ? "#bbf7d0"
            : "#dbeafe";
  const weight = line.startsWith("[") || line.startsWith("$") ? 800 : 500;
  const bg = line.startsWith("[") ? `<rect x="82" y="${y - 19}" width="1036" height="27" rx="7" fill="#0f172a" opacity="0.9"/>` : "";
  return `${bg}<text x="${x}" y="${y}" font-family="SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="17" font-weight="${weight}" fill="${fill}">${escapeXml(line)}</text>`;
}

function gridLines() {
  const parts = [];
  for (let x = 78; x < WIDTH; x += 96) parts.push(`<path d="M${x} 0 V${HEIGHT}" stroke="#94a3b8"/>`);
  for (let y = 86; y < HEIGHT; y += 78) parts.push(`<path d="M0 ${y} H${WIDTH}" stroke="#94a3b8"/>`);
  return parts.join("\n    ");
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}