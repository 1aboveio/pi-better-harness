import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { writeMeta as writeTaskMeta } from "../packages/pi-better-background-tasks/src/registry.ts";
import { writeMeta as writeSubagentMeta } from "../packages/pi-better-subagents/registry.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionRoot = resolve(process.env.PI_HARNESS_E2E_PACKAGE_ROOT ?? repoRoot);
const piBin = process.env.PI_NAVIGATOR_CLI ?? join(repoRoot, "node_modules", ".bin", "pi");
const mouseRouting = existsSync(join(dirname(createRequire(realpathSync(piBin)).resolve("@earendil-works/pi-tui")), "tui-alt-screen.js"));
const goldenSession = `pi-navigator-e2e-${process.pid}`;
const closeSession = `pi-navigator-close-e2e-${process.pid}`;
const refocusSession = `pi-navigator-refocus-e2e-${process.pid}`;
const replaceSession = `pi-navigator-replace-e2e-${process.pid}`;
const wrapSession = `pi-navigator-wrap-e2e-${process.pid}`;
const diagnosticSession = `pi-navigator-diagnostic-e2e-${process.pid}`;
const clickSession = `pi-navigator-click-e2e-${process.pid}`;
// Each test drives its own private tmux server; these point at the active one.
let session = goldenSession;
let tmuxArgs = ["-L", session];
const evidenceDir = resolve(process.env.PI_NAVIGATOR_EVIDENCE_DIR ?? join(tmpdir(), `${goldenSession}-evidence`));
const unicodeLog = `GOLDEN_LOG_BEGIN${"甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳".repeat(4)}GOLDEN_LOG_END`;
const taskTitle = `background golden path ${"中文任务标题".repeat(8)}`;
const fixtures = mkdtempSync(join(tmpdir(), "pi-navigator-e2e-"));
const probePath = join(fixtures, "session-probe.mjs");
const defaultSubagentId = `sa_navigator_e2e_${process.pid}`;
const defaultTaskId = `bg_navigator_e2e_${process.pid}`;
const dummyWorkers = [];
const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const skip = hasTmux || process.env.CI || process.env.PI_NAVIGATOR_REQUIRE_TMUX
  ? false
  : "requires tmux for a real terminal session (test:golden requires it)";
// Fullscreen mouse exists only on newer Pi hosts. A keyboard-only SDK is not a
// passing mouse run, so the pointer journey skips unless one is supplied.
const mouseSkip = skip || (mouseRouting || process.env.PI_NAVIGATOR_MOUSE === "1"
  ? false
  : "requires a fullscreen mouse-capable Pi host; set PI_NAVIGATOR_MOUSE=1 and PI_NAVIGATOR_CLI to one");

after(() => {
  for (const name of [goldenSession, closeSession, refocusSession, replaceSession, wrapSession, diagnosticSession, clickSession]) spawnSync("tmux", ["-L", name, "kill-server"], { stdio: "ignore" });
  for (const worker of dummyWorkers) {
    try { process.kill(-worker.pid, "SIGKILL"); } catch { /* already stopped */ }
  }
  // The registries live under the private TMPDIR from scripts/isolate-registry.mjs,
  // which removes it at exit. Never touch registries in any other TMPDIR (the tests
  // refuse to seed without the preload, so there is nothing of ours there).
  if (isPrivateRegistry()) {
    rmSync(join(tmpdir(), "pi-better-subagents"), { recursive: true, force: true });
    rmSync(join(tmpdir(), "pi-better-background-tasks"), { recursive: true, force: true });
  }
  rmSync(fixtures, { recursive: true, force: true });
});

function isPrivateRegistry() {
  const isolated = process.env.PI_SCRIPTS_TEST_ISOLATED_TMPDIR;
  return Boolean(isolated) && tmpdir() === isolated;
}

function assertPrivateRegistry() {
  assert.ok(isPrivateRegistry(),
    "run with --import ./scripts/isolate-registry.mjs so the seeded runs stay out of the machine registry");
}

// @covers navigator.detail-overlay navigator.unicode-rendering
// @level e2e
test("golden path: navigate both providers and read complete Unicode logs without a TUI crash", { skip }, (t) => {
  mkdirSync(evidenceDir, { recursive: true });
  t.diagnostic(`terminal evidence: ${evidenceDir}`);
  try {
    assertPrivateRegistry();
    assert.ok(hasTmux, "navigator golden path requires tmux; skipping cannot satisfy this gate");
    assert.ok(existsSync(piBin), `workspace Pi binary is missing: ${piBin}`);
    assert.ok(existsSync(join(extensionRoot, "package.json")), `extension package is missing: ${extensionRoot}`);

    const { state, piPid } = launchPi(goldenSession);
    seedNavigatorState({ cwd: state.cwd, sessionId: state.sessionId, piPid });

    sendKey("Left");
    const overview = waitForScreen((screen) => screen.includes("subagent golden path")
      && screen.includes("background golden path") && screen.includes("中文")
      && !screen.includes("provider Background Tasks") && !screen.includes("provider Subagents"));
    saveScreen("overview", overview);
    assertNoPersistentFooterBadges(overview);
    assertBlankRowBefore(overview, "subagents", "navigator section");
    sendKey("Down");
    const subagentPage = waitForScreen((screen) => screen.includes("subagent golden path") && screen.includes("provider Subagents")
      && screen.includes("transcript · latest 25 rows") && hasSettledInputFrame(screen));
    saveScreen("subagent-detail", subagentPage);
    assertSingleInputFrame(subagentPage, "subagent detail");
    assert.match(subagentPage.split("\n")[0], /中文.*\.\.\.\s*$/, "long Unicode subagent title must fit with a visible truncation marker");
    assert.match(subagentPage, /transcript · latest 25 rows/, "subagent detail must default to a 25-row transcript tail");
    assert.match(subagentPage, /← main/, "subagent detail must use the structured transcript renderer");
    assertSubagentMetadata(subagentPage, "40-row subagent detail");
    assert.deepEqual(transcriptRows(subagentPage), rowRange(18, 30), "a 40-row terminal shows the newest transcript rows that fit below the metadata");

    execFileSync("tmux", [...tmuxArgs, "resize-window", "-t", session, "-y", "60"]);
    // A resize repaints the whole pane; wait for the input frame too so the capture is not mid-redraw.
    const expandedPage = waitForScreen((screen) => screen.includes("transcript · latest 25 rows") && screen.includes("transcript-row-07")
      && hasSettledInputFrame(screen));
    saveScreen("expanded-subagent-detail", expandedPage);
    assertSingleInputFrame(expandedPage, "expanded subagent detail");
    assertSubagentMetadata(expandedPage, "60-row subagent detail");
    // The 25-row cap includes the transcript's closing fence line, so rows 07-30 are the newest 24 content rows.
    assert.deepEqual(transcriptRows(expandedPage), rowRange(7, 30), "a 60-row terminal fits the whole 25-row cap");
    sendKey("l");
    const shortPage = waitForScreen((screen) => screen.includes("transcript · latest 10 rows") && hasSettledInputFrame(screen));
    assertSubagentMetadata(shortPage, "10-row subagent detail");
    assert.deepEqual(transcriptRows(shortPage), rowRange(22, 30), "l switches to the latest 10 rows");
    sendKey("l");
    waitForScreen((screen) => screen.includes("transcript · latest 25 rows") && screen.includes("transcript-row-07"));

    sendKey("Down");
    for (const width of [100, 80]) {
      execFileSync("tmux", [...tmuxArgs, "resize-window", "-t", session, "-x", String(width), "-y", "40"]);
      const taskPage = waitForScreen((screen) => screen.includes("provider Background Tasks")
        && screen.includes("中文") && screen.includes("GOLDEN_LOG_BEGIN")
        // On fullscreen hosts the pane border can resize one frame before the title.
        && /\.\.\.\s*$/.test(screen.split("\n")[0] ?? "") && hasSettledInputFrame(screen)
        && screen.split(/\r?\n/).some((line) => line.trimEnd() === "─".repeat(width)));
      saveScreen(`background-detail-${width}`, taskPage);
      assertSingleInputFrame(taskPage, `background-task detail at ${width} columns`);
      for (const field of ["provider", "kind", "elapsed", "cwd", "pid", "pgid"]) {
        assert.match(taskPage, new RegExp(`^\\s+${field}\\s+\\S`, "m"), `background-task detail at ${width} columns: ${field} metadata must stay visible`);
      }
      assert.match(taskPage.split("\n")[0], /\.\.\.\s*$/, "long Unicode title must show truncation rather than overflow the terminal");
      assert.match(taskPage, /log(?: tail)? · latest 25 rows/, "background-task detail must default to a 25-row log tail");
      assert.ok(taskPage.replace(/\s/g, "").includes(unicodeLog), `wrapped log lost content at ${width} columns:\n${taskPage}`);
    }

    sendKey("Escape");
    waitForScreen((screen) => !screen.includes("provider Background Tasks"));
    execFileSync("tmux", [...tmuxArgs, "send-keys", "-t", session, "-l", "golden-editor-alive"]);
    const returned = waitForScreen((screen) => screen.includes("golden-editor-alive") && !screen.includes("provider Background Tasks"));
    saveScreen("returned-to-editor", returned);
    assertNoPersistentFooterBadges(returned);
    writeResult("pass");
  } catch (error) {
    try { saveScreen("failure", captureScreen()); } catch { /* The TUI may have exited. */ }
    writeResult("fail", String(error));
    throw error;
  }
});

// @covers navigator.pointer-detail
// @level e2e
test("plain left clicks open each provider's own detail while headers, blanks and modifiers stay inert", { skip: mouseSkip }, () => {
  assertPrivateRegistry();
  assert.ok(hasTmux, "the pointer journey needs a real terminal");
  assert.ok(mouseRouting, "the pointer journey needs a fullscreen mouse-capable Pi host");
  mkdirSync(evidenceDir, { recursive: true });
  // Only the pointer journey opts into fullscreen; the keyboard journeys keep
  // the host's own TUI mode and its existing layout expectations.
  mkdirSync(join(fixtures, "agent"), { recursive: true });
  writeFileSync(join(fixtures, "agent", "settings.json"), JSON.stringify({ tuiMode: "fullscreen", packages: [], quietStartup: true }));
  const { state, piPid } = launchPi(clickSession);
  seedNavigatorState({
    cwd: state.cwd, sessionId: state.sessionId, piPid,
    subagentId: `sa_navigator_click_${process.pid}`, taskId: `bg_navigator_click_${process.pid}`,
  });
  const press = (y, button = 0) => sendLiteral(`\x1b[<${button};5;${y + 1}M`);
  const release = (y, button = 0) => sendLiteral(`\x1b[<${button};5;${y + 1}m`);
  const click = (y, button = 0) => { press(y, button); release(y, button); };
  const rowY = (needle) => {
    const y = captureScreen().split(/\r?\n/).findIndex((line) => line.includes(needle));
    assert.ok(y >= 0, `row ${needle} must be visible before clicking:\n${captureScreen()}`);
    return y;
  };
  const assertNoDetail = (durationMs = 400) => {
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
      assert.doesNotMatch(captureScreen(), /provider (?:Subagents|Background Tasks)/, "a rejected pointer gesture must not open detail");
      sleep(40);
    }
  };

  // The rail mounts its rows when first focused; unfocusing leaves the same
  // rows visible with no keyboard selection, so the next gesture is a plain
  // pointer click rather than the navigator's Left-key path.
  sendKey("Left");
  waitForScreen((screen) => screen.includes("subagent golden path") && screen.includes("background golden path") && /^› /m.test(screen));
  sendKey("Left");
  waitForScreen((screen) => screen.includes("subagent golden path") && screen.includes("background golden path") && screen.includes("← work navigator") && !/^› /m.test(screen));
  const subagentY = rowY("subagent golden path");
  const taskY = rowY("background golden path");
  const headerY = rowY("subagents");
  const shortcutY = rowY("work navigator");
  const blankY = captureScreen().split(/\r?\n/).findIndex((line, index) => index > 1 && line === "");
  assert.ok(blankY > 0, "the list has a blank separator row to reject");

  // A plain press claims the row without opening anything; Pi synthesizes the
  // click only from the release on that same row, the way a real terminal does.
  press(subagentY);
  assertNoDetail(500);
  release(subagentY);
  const subagentDetail = waitForScreen((screen) => screen.includes("provider Subagents") && screen.includes("subagent golden path"));
  assert.match(subagentDetail, /^━━ subagent golden path/m, "the clicked row's own detail is the one that opens");
  assert.match(subagentDetail, new RegExp(`id\\s+sa_navigator_click_${process.pid}`));
  assert.doesNotMatch(subagentDetail, /provider Background Tasks/, "the other provider's detail must not open");
  assertSingleInputFrame(subagentDetail, "clicked subagent detail");
  saveScreen("click-subagent-detail", subagentDetail);
  sendKey("Escape");
  waitForScreen((screen) => !screen.includes("provider ") && screen.includes("← work navigator"));

  // Headers, the separator blank row and the shortcut line have no click target.
  for (const y of [headerY, blankY, shortcutY]) {
    click(y);
    assertNoDetail(300);
  }
  // A modified left click is not a plain click and must not open detail either.
  click(subagentY, 4 /* SGR shift+left */);
  assertNoDetail(400);

  // Resize narrow, then click the other provider's row: the pointer resolves
  // the row by structure rather than by untruncated text.
  execFileSync("tmux", [...tmuxArgs, "resize-window", "-t", session, "-x", "80", "-y", "40"]);
  waitForScreen((screen) => { const max = Math.max(...screen.split(/\r?\n/).map((line) => line.trimEnd().length)); return max <= 80 && screen.includes("background golden path"); });
  const narrowTaskY = rowY("background golden path");
  click(narrowTaskY);
  const taskDetail = waitForScreen((screen) => screen.includes("provider Background Tasks") && hasSettledInputFrame(screen));
  assert.match(taskDetail, /^━━ background golden path/m, "the second provider opens its own detail");
  assert.doesNotMatch(taskDetail, /provider Subagents/, "the previous row's detail must not stay mounted");
  assertSingleInputFrame(taskDetail, "clicked background-task detail at 80 columns");
  saveScreen("click-background-detail-80", taskDetail);
  sendKey("Escape");
  waitForScreen((screen) => !screen.includes("provider ") && screen.includes("← work navigator"));

  // The pointer journey never takes over the editor: typing after Esc lands in
  // the live input and no list focus marker is left behind.
  execFileSync("tmux", [...tmuxArgs, "send-keys", "-t", session, "-l", "click-editor-alive"]);
  const typed = waitForScreen((screen) => screen.includes("click-editor-alive") && !screen.includes("provider "));
  assert.doesNotMatch(typed, /^› /m, "a click does not leave the list's keyboard focus");
  saveScreen("click-editor-alive", typed);
});

// @covers navigator.detail-overlay
// @level e2e
test("closing work from its detail opens the next row, then returns the keyboard to the editor", { skip }, () => {
  assertPrivateRegistry();
  assert.ok(hasTmux, "navigator golden path requires tmux; skipping cannot satisfy this gate");
  mkdirSync(evidenceDir, { recursive: true });
  const { state, piPid } = launchPi(closeSession);
  const origin = { cwd: state.cwd, sessionId: state.sessionId };
  const now = Date.now();
  const subagentWorker = startDummyWorker();
  const taskWorker = startDummyWorker();
  const closeSubagentId = `sa_navigator_close_${process.pid}`;
  const closeTaskId = `bg_navigator_close_${process.pid}`;
  const subagentDir = join(tmpdir(), "pi-better-subagents", "runs", closeSubagentId);
  mkdirSync(subagentDir, { recursive: true });
  writeFileSync(join(subagentDir, "output.log"), "");
  writeSubagentMeta({
    id: closeSubagentId, name: "subagent to close", status: "running",
    pid: subagentWorker, pgid: subagentWorker, spawnPid: piPid, model: "openai/gpt-5.5", cwd: state.cwd,
    promptPreview: "close me from the navigator", startedAt: now - 20_000, logPath: join(subagentDir, "output.log"),
    sessionId: closeSubagentId, callbackOrigin: origin, callback: false,
  });
  const taskDir = join(tmpdir(), "pi-better-background-tasks", "tasks", closeTaskId);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "output.log"), "task output\n");
  writeTaskMeta({
    id: closeTaskId, name: "task to close", kind: "command_watch", status: "running", startedAt: now - 10_000,
    logPath: join(taskDir, "output.log"), cwd: state.cwd, command: "sleep 300", shell: true,
    pid: taskWorker, pgid: taskWorker, spawnPid: piPid, callbackOrigin: origin, callback: false,
    intervalMs: 15_000, deadlineAt: now + 600_000,
  });

  const hiddenList = (screen) => /Work · \d|↑↓ select/.test(screen);
  sendKey("Left");
  waitForScreen((screen) => screen.includes("subagent to close") && screen.includes("task to close"));
  sendKey("Down");
  waitForScreen((screen) => screen.includes("provider Subagents") && hasSettledInputFrame(screen));
  sendKey("x");
  sendKey("x");
  const next = waitForScreen((screen) => screen.includes("provider Background Tasks") && hasSettledInputFrame(screen));
  assert.ok(!hiddenList(next), `a confirmed close must open the next row's detail, not a list overlay:\n${next}`);
  sendKey("x");
  sendKey("x");
  // Back to the normal layout: the unfocused rail and the editor with Pi's footer below it.
  const closed = waitForScreen((screen) => !screen.includes("provider Background Tasks") && screen.includes("← work navigator"));
  assert.ok(!hiddenList(closed), `no list overlay may remain after the last close:\n${closed}`);
  execFileSync("tmux", [...tmuxArgs, "send-keys", "-t", session, "-l", "typed-after-close"]);
  const typed = waitForScreen((screen) => screen.includes("typed-after-close"));
  assert.ok(!hiddenList(typed), typed);
  saveScreen("closed-then-typed", typed);
});

// @covers navigator.detail-overlay
// @level e2e
test("after an editor swap, the detail overlay is reused and Esc returns the keyboard to the live editor", { skip }, () => {
  assertPrivateRegistry();
  assert.ok(hasTmux, "navigator golden path requires tmux; skipping cannot satisfy this gate");
  mkdirSync(evidenceDir, { recursive: true });
  const { state, piPid, focusStealPath } = launchPi(refocusSession);
  seedNavigatorState({
    cwd: state.cwd, sessionId: state.sessionId, piPid,
    subagentId: `sa_navigator_refocus_${process.pid}`, taskId: `bg_navigator_refocus_${process.pid}`,
  });

  sendKey("Left");
  waitForScreen((screen) => screen.includes("subagent golden path") && screen.includes("background golden path"));
  sendKey("Down");
  waitForScreen((screen) => screen.includes("provider Subagents") && hasSettledInputFrame(screen));

  // Another extension re-installs the editor (setEditorComponent), which mounts a
  // new editor instance with focus while the navigator overlay stays mounted.
  writeFileSync(focusStealPath, "");
  waitFor(() => !existsSync(focusStealPath), "the probe to swap the editor");
  sleep(400);
  sendKey("Down");
  const moved = waitForScreen((screen) => screen.includes("provider Background Tasks") && hasSettledInputFrame(screen));
  saveScreen("refocused-detail", moved);
  const titleRules = moved.split(/\r?\n/).filter((line) => /^━━ /u.test(line));
  assert.equal(titleRules.length, 1, `exactly one detail header may be visible:\n${moved}`);

  sendKey("Escape");
  const closed = waitForScreen((screen) => !screen.includes("provider ") && screen.includes("← work navigator"));
  assert.doesNotMatch(closed, /^━━ /mu, `Esc must close the navigator, not reveal a stale overlay:\n${closed}`);
  execFileSync("tmux", [...tmuxArgs, "send-keys", "-t", session, "-l", "typed-after-refocus"]);
  waitForScreen((screen) => screen.includes("typed-after-refocus") && !screen.includes("provider "));
});

// @covers navigator.detail-overlay
// @level e2e
test("when another extension replaces the editor, the detail overlay closes and typing shows in the new editor", { skip }, () => {
  assertPrivateRegistry();
  assert.ok(hasTmux, "navigator golden path requires tmux; skipping cannot satisfy this gate");
  mkdirSync(evidenceDir, { recursive: true });
  const { state, piPid, replacePath } = launchPi(replaceSession);
  seedNavigatorState({
    cwd: state.cwd, sessionId: state.sessionId, piPid,
    subagentId: `sa_navigator_replace_${process.pid}`, taskId: `bg_navigator_replace_${process.pid}`,
  });

  sendKey("Left");
  waitForScreen((screen) => screen.includes("subagent golden path") && screen.includes("background golden path"));
  sendKey("Down");
  waitForScreen((screen) => screen.includes("provider Subagents") && hasSettledInputFrame(screen));

  // Another extension restores Pi's default editor (setEditorComponent(undefined)): ours is unmounted.
  writeFileSync(replacePath, "");
  waitFor(() => !existsSync(replacePath), "the probe to replace the editor");
  const closed = waitForScreen((screen) => !screen.includes("provider Subagents"));
  assert.doesNotMatch(closed, /^━━ /mu, `the detail overlay must not stay over the replacement editor:\n${closed}`);
  execFileSync("tmux", [...tmuxArgs, "send-keys", "-t", session, "-l", "typed-after-replace"]);
  const typed = waitForScreen((screen) => screen.includes("typed-after-replace"));
  saveScreen("replaced-editor-typed", typed);
});

// @covers navigator.detail-overlay
// @level e2e
test("when another extension wraps the editor, Esc from the reused overlay returns the keyboard to it", { skip }, () => {
  assertPrivateRegistry();
  assert.ok(hasTmux, "navigator golden path requires tmux; skipping cannot satisfy this gate");
  mkdirSync(evidenceDir, { recursive: true });
  const { state, piPid, focusStealPath } = launchPi(wrapSession);
  seedNavigatorState({
    cwd: state.cwd, sessionId: state.sessionId, piPid,
    subagentId: `sa_navigator_wrap_${process.pid}`, taskId: `bg_navigator_wrap_${process.pid}`,
  });

  sendKey("Left");
  waitForScreen((screen) => screen.includes("subagent golden path") && screen.includes("background golden path"));
  sendKey("Down");
  waitForScreen((screen) => screen.includes("provider Subagents") && hasSettledInputFrame(screen));

  // Another extension wraps our editor in its own component: pi-tui mounts the wrapper, not ours.
  writeFileSync(focusStealPath, "wrap");
  waitFor(() => !existsSync(focusStealPath), "the probe to wrap the editor");
  sleep(400);
  sendKey("Down");
  const moved = waitForScreen((screen) => screen.includes("provider Background Tasks") && hasSettledInputFrame(screen));
  assert.equal(moved.split(/\r?\n/).filter((line) => /^━━ /u.test(line)).length, 1, `the wrapped editor keeps one overlay:\n${moved}`);
  sendKey("Escape");
  const closed = waitForScreen((screen) => !screen.includes("provider ") && screen.includes("← work navigator"));
  assert.doesNotMatch(closed, /^━━ /mu, closed);
  execFileSync("tmux", [...tmuxArgs, "send-keys", "-t", session, "-l", "typed-after-wrap"]);
  const typed = waitForScreen((screen) => screen.includes("typed-after-wrap"));
  saveScreen("wrapped-editor-typed", typed);
});

// @covers navigator.detail-overlay
// @level e2e
test("switching full-page details with multiline diagnostics keeps exactly one title bar", { skip }, () => {
  assertPrivateRegistry();
  assert.ok(hasTmux, "navigator regression requires tmux");
  mkdirSync(evidenceDir, { recursive: true });
  const { state, piPid } = launchPi(diagnosticSession, { multilineDiagnostic: true });
  execFileSync("tmux", [...tmuxArgs, "resize-window", "-t", session, "-x", "132", "-y", "54"]);
  const ids = [`sa_diagnostic_alpha_${process.pid}`, `sa_diagnostic_beta_${process.pid}`];
  for (const id of ids) seedNavigatorState({ cwd: state.cwd, sessionId: state.sessionId, piPid, subagentId: id });

  sendKey("Left");
  waitForScreen((screen) => screen.includes("subagent golden path") && !screen.includes("provider Subagents"));
  sendKey("Down");
  let screen = waitForScreen((value) => value.includes("provider Subagents") && hasSettledInputFrame(value));
  const firstId = ids.find((id) => screen.includes(id));
  assert.ok(firstId, "initial detail must show one of the seeded runs");
  const secondId = ids.find((id) => id !== firstId);
  for (let index = 0; index < 6; index++) {
    sendKey(index % 2 ? "Up" : "Down");
    const id = index % 2 ? firstId : secondId;
    screen = waitForScreen((value) => value.includes(id) && hasSettledInputFrame(value));
    saveScreen(`multiline-diagnostic-${index}`, screen);
    assert.equal(screen.split(/\r?\n/).filter((line) => /^━━ /u.test(line)).length, 1,
      `switch ${index}: previous detail title must not remain visible:\n${screen}`);
    assert.match(screen, /^\s+No failures need action \(history\)$/m);
    assert.match(screen, /^\s+Showing the latest 2\.0 MB of the transcript\.$/m);
    assertSingleInputFrame(screen, `multiline diagnostic switch ${index}`);
  }
});

function launchPi(name, { multilineDiagnostic = false } = {}) {
  session = name;
  tmuxArgs = ["-L", name];
  const probeStatePath = join(fixtures, `${name}-session-state.json`);
  const focusStealPath = join(fixtures, `${name}-steal-focus`);
  const replacePath = join(fixtures, `${name}-replace-editor`);
  writeFileSync(probePath, probeExtension(probeStatePath, focusStealPath, replacePath, multilineDiagnostic));
  startPiSession();
  const state = waitForJson(probeStatePath);
  waitForJson(`${probeStatePath}.activity.json`);
  const piPid = Number(execFileSync("tmux", [...tmuxArgs, "display-message", "-p", "-t", session, "#{pane_pid}"], { encoding: "utf8" }).trim());
  return { state, piPid, focusStealPath, replacePath };
}

function waitFor(condition, what, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    sleep(50);
  }
  throw new Error(`Timed out waiting for ${what}. Current screen:\n${captureScreen()}`);
}

/** A stand-in process for a run the navigator can stop, in its own process group. */
function startDummyWorker() {
  const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  child.unref();
  dummyWorkers.push(child);
  return child.pid;
}

function saveScreen(name, screen) {
  writeFileSync(join(evidenceDir, `${name}.txt`), screen);
}

function writeResult(status, note) {
  writeFileSync(join(evidenceDir, "smoke-results.json"), JSON.stringify([
    { id: "navigator-unicode", status, evidence: evidenceDir, note },
  ], null, 2) + "\n");
}

function startPiSession() {
  const command = [
    `cd ${shellQuote(extensionRoot)}`,
    "&& exec env",
    `PI_CODING_AGENT_DIR=${shellQuote(join(fixtures, "agent"))}`,
    // Explicit, so Pi's registries follow the test's private TMPDIR whatever tmux's global env holds.
    `TMPDIR=${shellQuote(tmpdir())}`,
    "PI_OFFLINE=1",
    "OPENAI_API_KEY=sk-tui-e2e-placeholder",
    shellQuote(piBin),
    `-e ${shellQuote(extensionRoot)}`,
    `-e ${shellQuote(probePath)}`,
    "--approve",
    "--no-skills",
    "--no-context-files",
    `--session-dir ${shellQuote(join(fixtures, `${session}-sessions`))}`,
    "--name navigator-tui-e2e",
    "--model openai/gpt-4o-mini",
  ].join(" ");
  execFileSync("tmux", [...tmuxArgs, "new-session", "-d", "-s", session, "-x", "100", "-y", "40", command]);
}

function probeExtension(path, focusStealPath, replacePath, multilineDiagnostic) {
  // Besides reporting the session, the probe re-installs the current editor when the
  // test creates focusStealPath, the way any extension that wraps the editor does (with
  // "wrap" in the file, inside its own proxy component), and restores Pi's default
  // editor when it creates replacePath.
  return `import * as fs from "node:fs";
export default function(pi) {
  const activityPath = ${JSON.stringify(`${path}.activity.json`)};
  pi.events.on("pi-better-goal:activity", (snapshot) => {
    if (snapshot.activeBackgroundCount > 0 && !fs.existsSync(activityPath)) fs.writeFileSync(activityPath, JSON.stringify(snapshot));
  });
  pi.on("session_start", async (_event, ctx) => {
    const fs = await import("node:fs");
    pi.events.emit("pi-better-goal:register-provider", {
      id: "footer-fixture",
      getActivity: () => ({ providerId: "footer-fixture", items: [{ id: "footer-work", status: "running", active: true }] }),
    });
    fs.writeFileSync(${JSON.stringify(path)}, JSON.stringify({ cwd: ctx.cwd, sessionId: ctx.sessionManager?.getSessionId() }, null, 2));
    if (${JSON.stringify(multilineDiagnostic)}) {
      const provider = globalThis[Symbol.for("pi-better-harness.navigator.state")]?.providers.get("subagents");
      if (!provider) throw new Error("navigator diagnostic fixture: subagent provider missing");
      const detail = provider.detail.bind(provider);
      provider.detail = (...args) => {
        const value = detail(...args);
        return value ? { ...value, transcriptDiagnostic: "No failures need action (history)\\nShowing the latest 2.0 MB of the transcript." } : value;
      };
    }
    const timer = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(focusStealPath)})) return;
      const mode = fs.readFileSync(${JSON.stringify(focusStealPath)}, "utf8").trim();
      fs.rmSync(${JSON.stringify(focusStealPath)}, { force: true });
      const prev = ctx.ui.getEditorComponent();
      if (mode !== "wrap") ctx.ui.setEditorComponent(prev);
      // Wrap the current editor in this extension's own component, delegating everything to it.
      else ctx.ui.setEditorComponent((t, th, kb) => new Proxy(prev(t, th, kb), {
        get(target, prop) { const value = Reflect.get(target, prop); return typeof value === "function" ? value.bind(target) : value; },
      }));
    }, 100);
    const replacer = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(replacePath)})) return;
      fs.rmSync(${JSON.stringify(replacePath)}, { force: true });
      ctx.ui.setEditorComponent(undefined);
    }, 100);
    replacer.unref?.();
    timer.unref?.();
  });
}
`;
}

function seedNavigatorState({ cwd, sessionId, piPid, subagentId = defaultSubagentId, taskId = defaultTaskId }) {
  const now = Date.now();
  const callbackOrigin = { cwd, sessionId };
  const subagentDir = join(tmpdir(), "pi-better-subagents", "runs", subagentId);
  mkdirSync(subagentDir, { recursive: true });
  const subagentLog = join(subagentDir, "output.log");
  const transcript = Array.from({ length: 30 }, (_, i) => `transcript-row-${String(i + 1).padStart(2, "0")}`).join("\n");
  writeFileSync(subagentLog, `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `\`\`\`text\n${transcript}\n\`\`\`` }] } })}\n`);
  writeSubagentMeta({
    id: subagentId,
    name: `subagent golden path ${"中文任务标题".repeat(8)}`,
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
  writeFileSync(taskLog, `${unicodeLog}\n`);
  writeTaskMeta({
    id: taskId,
    name: taskTitle,
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

function hasSettledInputFrame(screen) {
  const terminalRows = screen.split(/\r?\n/).map((line) => line.trimEnd());
  if (terminalRows.at(-1) === "") terminalRows.pop();
  return terminalRows.filter((line) => /^─{20,}$/u.test(line)).length === 2 && /^─{20,}$/u.test(terminalRows.at(-1) ?? "");
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

function assertNoPersistentFooterBadges(screen) {
  assert.doesNotMatch(screen, /← work ·|\bbg \d+|tools: minimal|sandbox · available/u,
    `persistent operational badges must not appear:\n${screen}`);
}

function assertBlankRowBefore(screen, heading, sectionName) {
  const rows = screen.split(/\r?\n/).map((line) => line.trimEnd());
  const headingIndex = rows.findIndex((line) => line.trim() === heading);
  assert.ok(headingIndex > 0, `${sectionName} heading must be visible:\n${screen}`);
  assert.equal(rows[headingIndex - 1]?.trim(), "", `${sectionName} must have one blank row above its heading:\n${screen}`);
}

function sendKey(key) {
  execFileSync("tmux", [...tmuxArgs, "send-keys", "-t", session, key]);
}

function sendLiteral(value) {
  execFileSync("tmux", [...tmuxArgs, "send-keys", "-t", session, "-l", value]);
}

function captureScreen() {
  return execFileSync("tmux", [...tmuxArgs, "capture-pane", "-t", session, "-p"], { encoding: "utf8" })
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

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
function transcriptRows(screen) {
  return [...screen.matchAll(/transcript-row-(\d{2})/g)].map((match) => Number(match[1]));
}

function rowRange(first, last) {
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

function assertSubagentMetadata(screen, label) {
  for (const field of ["provider", "id", "model", "elapsed", "tools", "spend", "pid", "pgid"]) {
    assert.match(screen, new RegExp(`^\\s+${field}\\s+\\S`, "m"), `${label}: ${field} metadata must stay visible`);
  }
}
