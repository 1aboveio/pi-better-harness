// @covers navigator.sticky-host
// @level e2e
//
// Real-terminal proof for the shared navigator host ("background-work-list")
// and the "Sticky navigator" control that `/harness-settings` contributes.
//
// The journey never invokes a model and never touches private navigator state:
// it seeds the Todo through documented session entries, drives the real
// settings hub, and reads the documented `piBetterHarness.navigator`
// preference. Position on screen is what distinguishes the two modes: Sticky
// On keeps the host between the transcript and the input frame; Sticky Off
// renders it as a TUI-only custom entry that scrolls with the conversation.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const piCli = process.env.PI_NAVIGATOR_STICKY_CLI ?? process.env.PI_NAVIGATOR_CLI ?? join(root, "node_modules", ".bin", "pi");
const extensions = [
  join(root, "packages/pi-better-goal/src/index.ts"),
  join(root, "packages/pi-better-background-tasks/src/index.ts"),
  join(root, "packages/pi-better-subagents/index.ts"),
  join(root, "packages/pi-better-harness/extensions/task-context/index.ts"),
  join(root, "packages/pi-better-harness/extensions/settings/index.ts"),
];
const missingExtension = extensions.find((path) => !existsSync(path));
const skip = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0
  ? "requires tmux for a real terminal session"
  : !existsSync(piCli)
    ? `workspace Pi binary is missing: ${piCli}`
    : missingExtension
      ? `extension is missing: ${missingExtension}`
      : false;
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

// Distinctive, markdown-safe tokens: the Todo text is the one content anchor
// that has to survive both renderings (pinned widget and transcript entry).
const todoStep = "STICKY-SEED-STEP-ALPHA";
const seedSteps = [
  { id: "step_1", step: todoStep, status: "in_progress" },
  { id: "step_2", step: "STICKY-SEED-STEP-BETA", status: "pending" },
  { id: "step_3", step: "STICKY-SEED-STEP-GAMMA", status: "pending" },
];
// Rows are numbered by the command, so the typed command line never contains a
// marker and a pending editor line can never satisfy a transcript assertion.
const chatRow = (index) => `STICKY-CHAT-ROW-${String(index).padStart(2, "0")}`;
const firstChatRow = chatRow(1);
const secondChatRow = chatRow(2);
const afterReloadRow = chatRow(3);
const lastScrollRow = chatRow(27); // rows 4..27 scroll the navigator away
const reloadStatusLine = "Reloaded keybindings";

test("real TUI: Sticky navigator pins the shared host, moves it into chat when Off, and restores the saved choice", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-navigator-sticky-"));
  const socket = `navigator-sticky-${process.pid}`;
  const log = join(dir, "calls.jsonl");
  const ready = join(dir, "ready");
  const fixture = join(dir, "fixture.mjs");
  const agent = join(dir, "agent");
  const preferences = join(agent, "settings.json");
  mkdirSync(agent);
  // Fullscreen keeps the transcript and the pinned widget in one stable viewport.
  writeFileSync(preferences, JSON.stringify({ tuiMode: "fullscreen", packages: [], quietStartup: true }));
  writeFileSync(fixture, fixtureExtension({ log, ready, steps: seedSteps }));

  const tmux = (...args) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
  const screen = () => tmux("capture-pane", "-t", "test", "-p").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  const send = (text) => tmux("send-keys", "-t", "test", "-l", text);
  const key = (name) => tmux("send-keys", "-t", "test", name);
  const wait = (predicate, what, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    let pane = "";
    while (Date.now() < deadline) {
      pane = screen();
      if (predicate(pane)) return pane;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
    }
    throw new Error(`Timed out waiting for ${what}. Current screen:\n${pane}\nModel calls: ${existsSync(log) ? readFileSync(log, "utf8") : "none"}`);
  };
  const settlesWithin = (predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate(screen())) return true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    }
    return false;
  };
  /** Type a command, then submit it once the editor owns the text (a reload can swallow the first Enter). */
  const command = (text) => {
    send(text);
    wait((pane) => editorText(pane).includes(text), `the command line "${text}" to be typed`);
    for (let attempt = 0; attempt < 3; attempt++) {
      key("Enter");
      if (settlesWithin((pane) => !editorText(pane).includes(text), 1_500)) return;
    }
    assert.fail(`the command "${text}" was typed but never ran:\n${screen()}`);
  };
  const calls = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const storedNavigator = () => JSON.parse(readFileSync(preferences, "utf8")).piBetterHarness?.navigator;
  const selectedRow = (pane) => pane.split("\n").find((line) => /^\s*>/u.test(line)) ?? "";
  /** The hub's own settings rows are not searchable, so walk the selection instead of assuming an offset. */
  const selectStickyRow = () => {
    let current = selectedRow(screen());
    for (let step = 0; step < 12; step++) {
      if (current.includes("Sticky navigator")) return;
      const previous = current;
      key("Down");
      current = selectedRow(wait((pane) => selectedRow(pane) !== previous, "the settings selection to move", 5_000));
    }
    assert.fail(`the harness settings hub never showed Sticky navigator:\n${screen()}`);
  };
  const openHub = () => {
    command("/harness-settings");
    wait((pane) => pane.includes("Harness settings") && pane.includes("Completions while busy"), "the harness settings hub");
  };
  const closeHub = () => {
    key("Escape");
    wait((pane) => !pane.includes("Harness settings"), "the harness settings hub to close");
  };
  const reload = (trigger = "/reload", below) => {
    rmSync(ready, { force: true });
    command(trigger);
    wait(() => existsSync(ready), "the reloaded session");
    // session_start runs before Pi finishes restoring its editor. Starting the
    // next custom UI before that restoration can dismiss it during reload.
    wait((pane) => {
      const status = rowsContaining(pane, reloadStatusLine);
      if (status.length === 0) return false;
      if (below === undefined) return true;
      const anchor = rowsContaining(pane, below);
      return anchor.length > 0 && status.at(-1) > anchor.at(-1);
    }, `${trigger} and the reload tail to finish`);
  };

  try {
    const launch = [
      `cd ${quote(root)} && exec env`,
      `PI_CODING_AGENT_DIR=${quote(agent)}`,
      // Pi's registries follow the test's private TMPDIR from scripts/isolate-registry.mjs.
      `TMPDIR=${quote(tmpdir())}`,
      "PI_OFFLINE=1",
      quote(piCli),
      ...extensions.flatMap((path) => ["-e", quote(path)]),
      "-e", quote(fixture),
      "--approve --no-skills --no-context-files",
      `--session-dir ${quote(join(dir, "sessions"))}`,
      "--name navigator-sticky-tui-e2e",
    ].join(" ");
    tmux("new-session", "-d", "-s", "test", "-x", "120", "-y", "40", launch);
    tmux("set-option", "-w", "-t", "test", "remain-on-exit", "on");
    wait(() => existsSync(ready), "Pi to start the session");

    // 1. Sticky is On by default and the host is pinned between transcript and input.
    reload("/seed-todo");
    command("/chat-rows 1 1");
    const pinned = wait((pane) => pane.includes(todoStep) && pane.includes(firstChatRow), "the pinned navigator");
    assertPinned(pinned, "Sticky On (default)", firstChatRow);
    assert.equal(storedNavigator(), undefined, "On is the default; nothing is stored until the user changes it");

    // 2. The hub reports the default and saves Off under piBetterHarness.navigator.
    openHub();
    selectStickyRow();
    wait((pane) => /Sticky navigator\s+On/u.test(pane), "Sticky navigator to read On");
    key("Space");
    wait((pane) => /Sticky navigator\s+Off/u.test(pane) && pane.includes("Setting saved."), "Sticky navigator to switch Off");
    assert.deepEqual(storedNavigator(), { version: 1, sticky: false }, "Off must persist as version 1 with sticky: false");
    closeHub();

    // 3. Off removes the pinned widget and re-renders the host inside the conversation:
    //    a chat row appended afterwards must sit below the navigator content.
    const inChatOnly = wait((pane) => pane.includes(todoStep) && !pane.includes(secondChatRow), "the navigator entry to replace the pinned widget");
    assert.equal(inChatOnly.includes("Harness settings"), false, `the settings hub must be closed before the entry is checked:\n${inChatOnly}`);
    command("/chat-rows 2 1");
    const inChat = wait((pane) => pane.includes(todoStep) && pane.includes(secondChatRow), "the navigator entry in the transcript");
    assertInTranscript(inChat, "Sticky Off", secondChatRow, firstChatRow);

    // 4. Reload rebuilds the transcript from session entries: the saved Off choice
    //    survives and the host is reconstructed inside the conversation again.
    reload("/reload", secondChatRow);
    const restored = wait((pane) => pane.includes(todoStep) && pane.includes(secondChatRow) && !pane.includes("Harness settings"),
      "the reloaded transcript navigator");
    assert.ok(restored.includes(todoStep), `the navigator entry must be rebuilt in the transcript after reload:\n${restored}`);
    command("/chat-rows 3 1");
    const restoredAfterChat = wait((pane) => pane.includes(todoStep) && pane.includes(afterReloadRow), "a chat row below the rebuilt navigator");
    assertInTranscript(restoredAfterChat, "Sticky Off after reload", afterReloadRow);
    openHub();
    selectStickyRow();
    wait((pane) => /Sticky navigator\s+Off/u.test(pane), "the saved Off choice to survive reload");
    closeHub();

    // 5. With Sticky Off the navigator scrolls away instead of staying on screen.
    command("/chat-rows 4 24");
    const scrolled = wait((pane) => pane.includes(lastScrollRow) && !pane.includes(todoStep), "the navigator to scroll out of view");
    assert.ok(scrolled.includes("Harness settings") === false, `no settings page may be mounted while scrolling:\n${scrolled}`);

    // 6. Turning Sticky back On pins the host above the input again, exactly once.
    openHub();
    selectStickyRow();
    wait((pane) => /Sticky navigator\s+Off/u.test(pane), "Sticky navigator to still read Off");
    key("Space");
    wait((pane) => /Sticky navigator\s+On/u.test(pane) && pane.includes("Setting saved."), "Sticky navigator to switch On");
    assert.deepEqual(storedNavigator(), { version: 1, sticky: true }, "On must persist as version 1 with sticky: true");
    closeHub();
    const repinned = wait((pane) => pane.includes(todoStep) && pane.includes(lastScrollRow), "the navigator to pin again");
    assertPinned(repinned, "Sticky On after the scroll", lastScrollRow);

    assert.deepEqual(calls(), [], "the whole journey must not invoke the model");
  } finally {
    spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Assert the navigator is pinned: one copy, below the newest transcript row and
 * above the input frame.
 */
function assertPinned(pane, label, newestChatRow) {
  const rows = pane.split("\n");
  const newest = rows.findLastIndex((line) => line.includes(newestChatRow));
  const editorTop = rows.findIndex((line) => /^─{20,}$/u.test(line));
  const matches = rowsContaining(pane, todoStep);
  assert.ok(newest >= 0, `${label}: ${newestChatRow} must be in the transcript:\n${pane}`);
  assert.ok(editorTop > newest, `${label}: the input frame must be below the transcript:\n${pane}`);
  assert.equal(matches.length, 1, `${label}: the pinned navigator must render exactly one Todo copy:\n${pane}`);
  assert.ok(matches[0] > newest, `${label}: the pinned navigator belongs below the transcript:\n${pane}`);
  assert.ok(matches[0] < editorTop, `${label}: the pinned navigator belongs above the input frame:\n${pane}`);
}

/**
 * Assert the navigator is part of the conversation: at least one copy, and no
 * copy anywhere below the chat row appended after it.
 */
function assertInTranscript(pane, label, newestChatRow, earlierChatRow) {
  const rows = pane.split("\n");
  const newest = rows.findLastIndex((line) => line.includes(newestChatRow));
  const earlier = earlierChatRow === undefined ? -1 : rows.findLastIndex((line) => line.includes(earlierChatRow));
  const matches = rowsContaining(pane, todoStep);
  assert.ok(newest >= 0, `${label}: ${newestChatRow} must be in the transcript:\n${pane}`);
  assert.ok(matches.length >= 1, `${label}: the navigator entry must render the Todo in the transcript:\n${pane}`);
  assert.ok(matches.every((row) => row < newest), `${label}: nothing may stay pinned below the newest chat row:\n${pane}`);
  if (earlier >= 0) {
    assert.ok(matches.every((row) => row > earlier),
      `${label}: the restored entry must keep its own place in the conversation:\n${pane}`);
  }
}

function rowsContaining(pane, needle) {
  return pane.split("\n").flatMap((line, index) => (line.includes(needle) ? [index] : []));
}

/** The text currently sitting in the input frame, between its two border rows. */
function editorText(pane) {
  const rows = pane.split("\n");
  const borders = rows.flatMap((line, index) => (/^─{20,}$/u.test(line) ? [index] : []));
  if (borders.length < 2) return "";
  return rows.slice(borders[0] + 1, borders[1]).join("\n");
}

function fixtureExtension({ log, ready, steps }) {
  return `import { appendFileSync, writeFileSync } from 'node:fs';

function streamSimple() {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ unexpectedModelRequest: true }) + '\\n');
  throw new Error('The Sticky navigator journey must not invoke the model');
}

export default function (pi) {
  pi.registerProvider('navigator-sticky-test', {
    api: 'navigator-sticky-test-api',
    apiKey: 'fake',
    baseUrl: 'http://localhost:0',
    streamSimple,
    models: [{ id: 'local', name: 'Local test', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
  });

  pi.on('session_start', async (_event, ctx) => {
    await pi.setModel(ctx.modelRegistry.find('navigator-sticky-test', 'local'));
    writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ sessionFile: ctx.sessionManager.getSessionFile() }));
  });

  // Seed the Todo in the documented session-entry shape, then reload so the
  // Todo panel restores from the session instead of from live extension state.
  pi.registerCommand('seed-todo', {
    description: 'Seed a Todo through session entries without a model turn',
    handler: async (_args, ctx) => {
      const branch = ctx.sessionManager.getBranch();
      if (!branch.some((entry) => entry.type === 'custom' && entry.customType === 'pi-better-plan')) {
        const at = Math.floor(Date.now() / 1000);
        pi.appendEntry('pi-better-plan', {
          version: 1, kind: 'set', at,
          plan: { version: 1, planId: 'plan_sticky_e2e', revision: 1, steps: ${JSON.stringify(steps)}, createdAt: at, updatedAt: at },
        });
      }
      await ctx.reload();
    },
  });

  // Harmless transcript rows: display-only custom messages, never a turn.
  pi.registerCommand('chat-rows', {
    description: 'Append display-only chat rows without starting a model turn',
    handler: async (args) => {
      const [startText, countText] = args.trim().split(/\\s+/);
      const start = Math.max(1, Number.parseInt(startText, 10) || 1);
      const count = Math.max(1, Number.parseInt(countText, 10) || 1);
      for (let offset = 0; offset < count; offset += 1) {
        const index = String(start + offset).padStart(2, '0');
        await pi.sendMessage({ customType: 'sticky-chat', content: 'STICKY-CHAT-ROW-' + index, display: true }, { triggerTurn: false });
      }
    },
  });
}
`;
}
