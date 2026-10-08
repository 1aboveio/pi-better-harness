import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createPermissionsPage } from "../packages/pi-better-sandbox/permissions-page.ts";
import { defaultSandboxPermissions } from "../packages/pi-better-sandbox/permissions.ts";
import { formatSshProfileChip } from "../packages/pi-better-ssh/src/profile.ts";
import { renderCompactPlan } from "../packages/pi-better-plan/src/plan-render.ts";
import { createPlanWidget } from "../packages/pi-better-plan/src/plan-widget.ts";

import { renderGoalClockLine } from "../packages/pi-better-goal/src/goal-clock.ts";
import { buildWidgetLines, fmtElapsed, shortModel } from "../packages/pi-better-subagents/widget.mjs";
import {
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
const HEIGHT = 750;
const LOGO = readFileSync(join(ROOT, "docs/images/brand/logo.png")).toString("base64");
const TERMINAL_COLUMNS = 76;
const NOW = 1_800_000;
const NOW_SECONDS = 1_800;

const packages = [
  {
    id: "pi-better-harness",
    accent: "#67e8c3",

    title: "One session. Work in parallel.",
    status: "Sandbox / subagents / background tasks / SSH / goals / plans",
    blocks: [
      { label: "goal rail", lines: goalLines(TERMINAL_COLUMNS) },
      { label: "background-work navigator", lines: compactNavigator("harness") },
    ],
    footer: "← work · 5     /goal active",
  },
  {
    id: "pi-better-subagents",
    accent: "#c4b5fd",

    title: "Delegate. Keep moving.",
    status: "Detached agents / live progress / completion callbacks",
    blocks: [
      { label: "subagent navigator", lines: subagentNavigatorLines(TERMINAL_COLUMNS) },
      { label: "live widget", lines: subagentWidgetLines() },
    ],
    footer: "← subagents · 3     ↑↓ select · Enter view · x stop · Esc close",
  },
  {
    id: "pi-better-background-tasks",
    accent: "#fbbf24",

    title: "Long jobs. A responsive session.",
    status: "Durable processes / condition watchers / logs / callbacks",
    blocks: [
      { label: "background-work navigator", lines: compactNavigator("background") },
      { label: "task detail · example", lines: backgroundTaskDetailLines() },
    ],
    footer: "← work · 3     ↑↓ select · Enter detail · x stop · Esc unfocus",
  },
  {
    id: "pi-better-goal",
    accent: "#fb7185",

    title: "Keep the objective in view.",
    status: "Session goals / active time / background-aware continuation",
    blocks: [
      { label: "goal rail", lines: goalLines(TERMINAL_COLUMNS) },
      { label: "get_goal · example", lines: getGoalLines() },
    ],
    footer: "background drains to zero → follow-up wakes the completion audit",
  },
  {
    id: "pi-better-sandbox",
    accent: "#a3e635",

    title: "Permissions you control.",
    status: "Independent Main and Subagents profiles / OS-backed file rules",
    blocks: [{ label: "/sandbox · default profiles", lines: sandboxLines() }],
    footer: "Main starts off · Subagents start confined · trusted tools run outside file rules",
  },
  {
    id: "pi-better-ssh",
    accent: "#38bdf8",

    title: "Remote commands. Local clarity.",
    status: "Explicit remote tools / saved host profiles / reusable connections",
    blocks: [
      { label: "ssh_profile · example", lines: [
        '* staging', '- production', '',
        `Active SSH profile: ${formatSshProfileChip({ host: "staging", workdir: "/srv/app" }, "up")}`,
      ] },
      { label: "remote_bash · example", lines: [
        'host: staging', 'command: node --version', '',
        'v22.16.0', '', 'ssh_mux status',
        'staging: mux up - Master running',
      ] },
    ],
    footer: "Pi bash stays local · remote_bash is synchronous · no interactive shell",
  },
  {
    id: "pi-better-plan",
    accent: "#f0abfc",

    title: "A plan with explicit progress.",
    status: "Structured steps / dependencies / persistent session state",
    blocks: [
      { label: "plan widget", lines: planLines() },
      { label: "get_plan · example", lines: [
        'Checklist progress: 2/5 completed',
        'Current step: Run the regression suite',
        'Ready: none · release waits for verification',
      ] },
    ],
    footer: "/plan · inspect the complete checklist · progress changes only through updates",
  },
  {
    id: "pi-better-read-aloud",
    accent: "#fdba74",
    command: "pi -e ./packages/pi-better-read-aloud",
    title: "Listen to the response.",
    status: "OpenAI-compatible speech / local playback / unpublished extension",
    blocks: [
      { label: "/read-aloud · example", lines: [
        'The regression suite passed. Ready for review.', '',
        'Started read-aloud playback',
        '(model tts-1, voice alloy, player afplay).',
      ] },
      { label: "playback controls", lines: [
        'read_aloud       Speak explicit text',
        'read_aloud_last  Speak the latest response',
        'read_aloud_stop  Stop current playback',
      ] },
    ],
    footer: "Local extension preview · not published to npm or included in the harness",
  },
];

const planExamples = [
  { file: "start", title: "Just started", active: 0, expanded: false },
  { file: "middle", title: "In the middle", active: 3, expanded: false },
  { file: "near-end", title: "Near the end", active: 6, expanded: false },
  { file: "expanded", title: "Expanded", active: 6, expanded: true },
].map((example) => ({
  file: example.file,
  pkg: {
    id: "pi-better-plan",
    accent: "#f0abfc",
    title: example.title,
    status: "The same eight-step plan / actual widget renderer / demonstration state",
    blocks: [{ label: "plan widget", lines: planExampleLines(example.active, example.expanded) }],
    footer: "Click to fold or unfold in fullscreen Pi · /plan expand · /plan collapse",
  },
}));

if (!process.argv.includes("--check")) {
  if (!process.argv.includes("--plan-examples")) {
    mkdirSync(OUT_DIR, { recursive: true });
    for (const pkg of packages) {
      const svg = renderScreenshot(pkg);
      const svgPath = join(OUT_DIR, `${pkg.id}.svg`);
      const pngPath = join(OUT_DIR, `${pkg.id}.png`);
      writeFileSync(svgPath, svg);
      execFileSync("sips", ["-s", "format", "png", svgPath, "--out", pngPath], { stdio: "ignore" });
      console.log(`${pkg.id}: ${svgPath} -> ${pngPath}`);
    }
    renderContactSheet();
  }
  const examplesDir = join(OUT_DIR, "plan-examples");
  mkdirSync(examplesDir, { recursive: true });
  for (const { file, pkg } of planExamples) {
    const svgPath = join(examplesDir, `${file}.svg`);
    const pngPath = join(examplesDir, `${file}.png`);
    writeFileSync(svgPath, renderScreenshot(pkg));
    execFileSync("sips", ["-s", "format", "png", svgPath, "--out", pngPath], { stdio: "ignore" });
    console.log(`plan ${file}: ${pngPath}`);
  }
}
checkGallery();
for (const { file, pkg } of planExamples) {
  const base = join(OUT_DIR, "plan-examples", file);
  if (readFileSync(`${base}.svg`, "utf8") !== renderScreenshot(pkg)) {
    throw new Error(`plan ${file}: stale preview; regenerate with --plan-examples`);
  }
  const png = readFileSync(`${base}.png`);
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      png.toString("ascii", 12, 16) !== "IHDR" ||
      png.readUInt32BE(16) !== WIDTH || png.readUInt32BE(20) !== HEIGHT) {
    throw new Error(`plan ${file}: expected a ${WIDTH}x${HEIGHT} PNG`);
  }
  console.log(`plan ${file}: renderer output and PNG OK`);
}

function renderContactSheet() {
  const tiles = packages.map((pkg, index) => {
    const data = readFileSync(join(OUT_DIR, `${pkg.id}.png`)).toString("base64");
    return `<image x="${index % 2 * WIDTH / 2}" y="${Math.floor(index / 2) * HEIGHT / 2}" width="${WIDTH / 2}" height="${HEIGHT / 2}" href="data:image/png;base64,${data}"/>`;
  });
  const height = Math.ceil(packages.length / 2) * HEIGHT / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">${tiles.join("")}</svg>`;
  const temp = mkdtempSync(join(tmpdir(), "pi-gallery-"));
  try {
    const source = join(temp, "contact-sheet.svg");
    writeFileSync(source, svg);
    execFileSync("sips", ["-s", "format", "png", source, "--out", join(OUT_DIR, "contact-sheet.png")], { stdio: "ignore" });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function checkGallery() {
  for (const entry of readdirSync(join(ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = JSON.parse(readFileSync(join(ROOT, "packages", entry.name, "package.json"), "utf8"));
    if (manifest.private || !manifest.pi?.extensions) continue;
    const expected = `https://raw.githubusercontent.com/1aboveio/pi-better-harness/main/docs/images/package-gallery/${manifest.name}.png`;
    if (manifest.pi.image !== expected) throw new Error(`${manifest.name}: missing or unexpected pi.image URL`);
    if (!packages.some((pkg) => pkg.id === manifest.name)) throw new Error(`${manifest.name}: no reproducible preview`);
    const png = readFileSync(join(OUT_DIR, `${manifest.name}.png`));
    if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        png.toString("ascii", 12, 16) !== "IHDR" ||
        png.readUInt32BE(16) !== WIDTH || png.readUInt32BE(20) !== HEIGHT) {
      throw new Error(`${manifest.name}: expected a ${WIDTH}x${HEIGHT} PNG`);
    }
    console.log(`${manifest.name}: gallery metadata and PNG OK${manifest.keywords?.includes("pi-package") ? "" : " (not gallery-discoverable yet)"}`);
  }
}

function compactNavigator(kind) {
  return backgroundWorkLines(kind, TERMINAL_COLUMNS).filter((line) => line.trim() && !line.includes("to navigate"));
}

function sandboxLines() {
  const theme = { fg: (_color, value) => value, bg: (_color, value) => value, bold: (value) => value, inverse: (value) => value };
  const page = createPermissionsPage(theme, {
    getConfig: defaultSandboxPermissions,
    change() {}, save() {},
    discoverTools: () => [
      { name: "web_fetch", package: "npm:@juicesharp/rpiv-web-tools" },
      { name: "web_search", package: "npm:@juicesharp/rpiv-web-tools" },
    ],
  }, () => {}, () => {});
  return page.render(TERMINAL_COLUMNS).filter((line) => line.trim()).slice(0, 13);
}

function planLines() {
  return renderCompactPlan({ steps: [
    { step: "Inspect the release requirements", status: "completed" },
    { step: "Implement the scoped changes", status: "completed" },
    { step: "Run the regression suite", status: "in_progress" },
    { step: "Review the results", status: "pending" },
    { step: "Publish the release", status: "pending" },
  ] }, TERMINAL_COLUMNS, { fg: (_color, value) => value });
}

function planExampleLines(active, expanded) {
  const titles = [
    "Inspect session state", "Reproduce missing plan", "Retain read-only handoff",
    "Select five relevant steps", "Add fold controls", "Persist fold preference",
    "Test mouse dispatch", "Verify and commit",
  ];
  const plan = { steps: titles.map((step, index) => ({
    step, status: index < active ? "completed" : index === active ? "in_progress" : "pending",
  })) };
  return createPlanWidget(
    (width) => renderCompactPlan(plan, width, { fg: (_color, value) => value }, expanded),
    () => true, () => expanded, () => {},
  ).render(TERMINAL_COLUMNS).filter((line) => line.trim());
}

function subagentWidgetLines() {
  return buildWidgetLines({
    running: [
      { id: "sa_review", name: "reviewer", model: "xai/grok-4.5", startedAt: NOW - 128_000 },
    ],
    frame: 2,
    now: NOW,
    affordanceHint: "← subagents · 3",
    selectedId: "sa_review",
    spendById: {
      sa_review: { tool: "bash", usage: { total: 12400, input: 9100, output: 3300, costUSD: 0.042 } },

    },
  });
}

function subagentNavigatorLines(width) {
  const rows = buildNavigatorRows(subagentMetas(), {
    effectiveStatus: (meta) => meta.status,
    shortModel,
    fmtElapsed,
    spendFor: (meta) => `${(meta.usage.total / 1000).toFixed(1)}k tok`,
    toolFor: (meta) => meta.tool,
    effortFor: (meta) => meta.effort,
    now: NOW,
  });
  const state = createNavigatorState(rows);
  state.selected = 0;
  return buildSubagentNavigatorLines(state, { width, truncate: truncatePlain });
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
    "cwd        /workspace/app",
    "command    npm run dev",
    "log tail   ready in 842ms · http://localhost:5173",
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
  for (const block of pkg.blocks) {
    if (lines.length) lines.push("");
    lines.push(`[${block.label}]`, ...block.lines.map(stripStyle));
  }
  if (lines.length > 17) throw new Error(`${pkg.id}: ${lines.length} rows exceed the preview frame`);
  const text = lines.map((line, i) => renderTextLine(line, 60, 210 + i * 26, pkg.accent)).join("\n");
  const command = pkg.id === "pi-better-read-aloud"
    ? pkg.command : `pi install npm:${pkg.id}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <title>${escapeXml(pkg.id)} package preview</title>
  <desc>${escapeXml(pkg.status)}. Rendered with deterministic demonstration data.</desc>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#151718"/>
  <rect width="8" height="${HEIGHT}" fill="${pkg.accent}"/>
  <text x="48" y="46" font-family="Menlo" font-size="22" font-weight="700" fill="${pkg.accent}">${escapeXml(pkg.id)}</text>
  <image x="1056" y="24" width="96" height="96" href="data:image/png;base64,${LOGO}"/>
  <text x="48" y="94" font-family="Helvetica" font-size="34" font-weight="700" fill="#fafafa">${escapeXml(pkg.title)}</text>
  <text x="48" y="128" font-family="Helvetica" font-size="19" fill="#b4b4bc">${escapeXml(pkg.status)}</text>
  <path d="M48 150 H1152" stroke="#3f3f46"/>
  ${text}
  <path d="M48 675 H1152" stroke="#3f3f46"/>
  <text x="48" y="706" font-family="Menlo" font-size="20" fill="${pkg.accent}">$ ${escapeXml(command)}</text>
  <text x="48" y="733" font-family="Helvetica" font-size="16" fill="#b4b4bc">${escapeXml(pkg.footer)}</text>
</svg>
`;
}

function renderTextLine(line, x, y, accent) {
  const heading = line.startsWith("[");
  const cut = stripStyle(truncateToWidth(line, TERMINAL_COLUMNS));
  const fill = heading ? accent
    : /completed|succeeded|✓/.test(line) ? "#86efac"
      : /running|active|●/.test(line) ? "#fafafa" : "#c7c7cf";
  // Explicit advance keeps terminal columns aligned in SVG rasterizers as well as browsers.
  const length = visibleWidth(cut) * 12;
  const spacing = length ? ` textLength="${length}" lengthAdjust="spacingAndGlyphs"` : "";
  return `<text x="${x}" y="${y}" font-family="Menlo" font-size="20" font-weight="${heading ? 700 : 400}" fill="${fill}" xml:space="preserve"${spacing}>${escapeXml(cut)}</text>`;
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}