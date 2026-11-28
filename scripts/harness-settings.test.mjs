import assert from "node:assert/strict";
import test, { after } from "node:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsRegistry } from "../packages/pi-better-harness/extensions/settings/registry.ts";
import { chooseHarnessSetting } from "../packages/pi-better-harness/extensions/settings/page.ts";
import harnessSettings from "../packages/pi-better-harness/extensions/settings/index.ts";
import backgroundTasks from "../packages/pi-better-background-tasks/src/index.ts";
import { getKeybindings, setKeybindings, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const isolatedAgentDir = mkdtempSync(join(tmpdir(), "harness-settings-tests-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
after(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(isolatedAgentDir, { recursive: true, force: true });
});

function eventApi(bus = new EventEmitter()) {
  const entries = [];
  return { bus, entries, appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
    events: { on(name, handler) { bus.on(name, handler); return () => bus.off(name, handler); }, emit: (name, data) => bus.emit(name, data) } };
}
const theme = { fg: (_key, text) => text, bold: text => text, inverse: text => text };

test("settings discovery supports both load orders, deduplicates and removes conflicts", async () => {
  const pi = eventApi();
  let opened = 0;
  const link = { id: "sandbox", label: "Sandbox", command: "/sandbox", open: async () => { opened++; } };
  pi.bus.emit("harness-settings:register", link);
  pi.bus.on("harness-settings:request", () => pi.bus.emit("harness-settings:register", link));
  const registry = createSettingsRegistry(pi);
  registry.refresh();
  pi.bus.emit("harness-settings:register", link);
  assert.equal(registry.list().length, 1);
  await registry.list()[0].open({});
  assert.equal(opened, 1);
  pi.bus.emit("harness-settings:register", { ...link, open() {} });
  assert.deepEqual(registry.list(), []);
  registry.refresh();
  assert.equal(registry.list().length, 1);
  registry.dispose();
  assert.equal(pi.bus.listenerCount("harness-settings:register"), 0);
  assert.deepEqual(registry.list(), []);
});

test("discovery rejects malformed links and sorts valid contributions", () => {
  const pi = eventApi();
  const registry = createSettingsRegistry(pi);
  for (const value of [null, {}, { id: "../file", label: "bad", command: "/bad", open() {} },
    { id: "bad", label: "bad", command: "!shell", open() {} }, { id: "bad", label: "bad", command: "/bad" }]) pi.bus.emit("harness-settings:register", value);
  assert.deepEqual(registry.list(), []);
  for (const id of ["subagents", "goal", "sandbox"]) pi.bus.emit("harness-settings:register", { id, label: id, command: `/${id}`, open() {} });
  assert.deepEqual(registry.list().map(link => link.id), ["goal", "sandbox", "subagents"]);
  registry.dispose();
});

test("grouped settings menu selects package links without opening or changing them itself", async () => {
  let page;
  let opened = false;
  const ctx = { ui: { custom(build) { return new Promise(resolve => { page = build({}, theme, {}, resolve); }); } } };
  const selected = chooseHarnessSetting(ctx, [{ id: "sandbox", label: "Sandbox", command: "/sandbox", open() { opened = true; } }], "link:sandbox");
  assert.match(page.render(80).join("\n"), /Sandbox settings\s+›/);
  const narrow = page.render(24);
  assert.ok(narrow.every(line => visibleWidth(line) <= 24));
  assert.match(narrow.join("\n"), /Agents & permissions\s+> Sandbox settings\s+›/);
  assert.match(narrow.join(" "), /to open/);
  assert.match(page.render(80).join("\n"), /You can also run \/sandbox/);
  page.handleInput("\r");
  assert.equal(await selected, "link:sandbox");
  assert.equal(opened, false);
});

test("Background contributes the review interval and the native selector saves it", async () => {
  const pi = { ...eventApi(), on() {}, registerTool() {} };
  const registry = createSettingsRegistry(pi);
  backgroundTasks(pi);
  registry.refresh();
  const control = registry.controls().find(item => item.id === "background-review-interval");
  assert.ok(control);
  let page;
  const ctx = { ui: { custom(build) {
    return new Promise(resolve => { page = build({}, theme, {}, resolve); });
  } } };
  const opened = chooseHarnessSetting(ctx, [], undefined, undefined, [control]);
  assert.match(page.render(100).join("\n"), /Background wait reviews\s+10 minutes/);
  page.handleInput("\r");
  await new Promise(resolve => setImmediate(resolve));
  assert.match(page.render(100).join("\n"), /Background wait reviews\s+15 minutes/);
  assert.equal(JSON.parse(readFileSync(join(isolatedAgentDir, "settings.json"), "utf8")).piBetterHarness.backgroundReviewIntervalMinutes, 15);
  page.handleInput("\x1b");
  await opened;
  registry.dispose();
});

test("the selected setting explains its effect at narrow and wide terminal widths", async () => {
  let page;
  const ctx = { ui: { custom(build) { return new Promise(resolve => { page = build({}, theme, {}, resolve); }); } } };
  const view = { id: "navigator-view", label: "View", values: ["tree", "flatten"], get: () => "flatten", change() {} };
  const links = [{ id: "subagents", label: "Subagents", command: "/subagents settings", open() {} }];
  const callbacks = { get: () => ({ mode: "hold", source: "default" }), change() {}, save() {} };
  const opening = chooseHarnessSetting(ctx, links, "callbacks:while-busy", callbacks, [], view);
  for (const width of [48, 100]) {
    const lines = page.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    const text = lines.join(" ");
    assert.match(text, /Completion delivery\s+When idle/);
    assert.match(text, /Ctrl\+S saves\s+your default/);
    assert.doesNotMatch(text, /Tree groups related work/);
  }
  page.handleInput("\x1b[B");
  const layout = page.render(48).join(" ");
  assert.match(layout, /Navigator layout\s+Flat list/);
  assert.match(layout, /Tree nests tasks under their\s+agent/);
  assert.doesNotMatch(layout, /Ctrl\+S/);
  page.handleInput("\x1b[B");
  assert.match(page.render(100).join("\n"), /Subagent settings\s+›/);
  assert.match(page.render(100).join("\n"), /You can also run \/subagents settings/);
  page.handleInput("\x1b");
  await opening;
});

test("keyboard order groups controls with their package pages and keeps third-party contributions reachable", async () => {
  const controls = ["tool-animation", "extra-control", "background-review-interval",
    "goal-auto-start", "tool-output", "navigator-sticky", "outcome-todo-ledger", "tool-call-guard", "navigator-view"]
    .map(id => ({ id, label: id, values: ["Off", "On"], get: () => "Off", change() {} }));
  const links = ["agents", "extra-page", "sandbox", "subagents"]
    .map(id => ({ id, label: id, command: `/${id}`, open() {} }));
  const callbacks = { get: () => ({ mode: "hold", source: "default" }), change() {}, save() {} };
  let page;
  const opening = chooseHarnessSetting({ ui: { custom: build => new Promise(resolve => {
    page = build({}, theme, {}, resolve);
  }) } }, links, undefined, callbacks, controls);
  const expected = [
    "Auto-start Goals", "Project work ledger",
    "Subagent settings", "Agent catalog", "Sandbox settings",
    "Foreground wait guard", "Background wait reviews", "Completion delivery",
    "Navigator layout", "Pin work panels", "tool-output", "Tool progress animation",
    "extra-control", "extra-page",
  ];
  assert.match(page.render(80).join("\n"), /Goals & workflows\n> Auto-start Goals/);
  for (const label of expected) {
    assert.ok(page.render(80).some(line => line.startsWith(`> ${label}  `)), label);
    page.handleInput("\x1b[B");
  }
  page.handleInput("\x1b");
  await opening;
});

test("selection restoration preserves ordering and rebound native navigation", async () => {
  const original = getKeybindings();
  const rebound = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "j", "tui.select.up": "k" });
  setKeybindings(rebound);
  try {
    let page;
    const ctx = { ui: { custom(build) { return new Promise(resolve => { page = build({}, theme, {}, resolve); }); } } };
    const links = ["sandbox", "subagents"].map(id => ({ id, label: id, command: `/${id} settings`, open() {} }));
    const chosen = chooseHarnessSetting(ctx, links, "link:subagents");
    assert.equal(getKeybindings(), rebound, "restore never replaces the user's active bindings");
    const lines = page.render(80).join("\n");
    assert.match(lines, /> Subagent settings/);
    assert.ok(lines.indexOf("Subagent settings") < lines.indexOf("Sandbox settings"));
    page.handleInput("j");
    assert.match(page.render(80).join("\n"), /> Sandbox settings/);
    page.handleInput("k");
    page.handleInput("\r");
    assert.equal(await chosen, "link:subagents");
  } finally { setKeybindings(original); }
});

test("hub opens package-owned settings, returns to selection and reports opener failure", async () => {
  const pi = eventApi();
  const handlers = new Map();
  let command;
  pi.on = (name, fn) => handlers.set(name, fn);
  pi.registerCommand = (name, options) => { assert.equal(name, "harness-settings"); command = options.handler; };
  let opened = 0;
  let pages = 0;
  const notifications = [];
  const ctx = { mode: "tui", ui: { notify: (...args) => notifications.push(args), custom(build) {
    return new Promise(resolve => {
      const page = build({}, theme, {}, resolve);
      if (++pages === 1) { assert.match(page.render(80).join("\n"), /> Sandbox settings/); page.handleInput("\r"); }
      else page.handleInput("\x1b");
    });
  } } };
  const link = { id: "sandbox", label: "Sandbox", command: "/sandbox", open(current) { assert.equal(current, ctx); opened++; throw new Error("Synthetic opener failure"); } };
  pi.bus.on("harness-settings:request", () => pi.bus.emit("harness-settings:register", link));
  harnessSettings(pi);
  handlers.get("session_start")({}, ctx);
  await command("", ctx);
  assert.equal(opened, 1);
  assert.equal(pages, 2);
  assert.deepEqual(notifications, [["Settings unavailable: Synthetic opener failure", "error"]]);
  handlers.get("session_shutdown")({}, ctx);
  assert.equal(pi.bus.listenerCount("harness-settings:register"), 0);
});

test("hub offers callback settings without package contributions and rejects non-TUI mode", async () => {
  const pi = eventApi();
  let command;
  pi.on = () => {};
  pi.registerCommand = (_name, options) => { command = options.handler; };
  harnessSettings(pi);
  const notifications = [];
  let pages = 0;
  const ui = { notify: (...args) => notifications.push(args), custom(build) {
    pages++;
    return new Promise(resolve => {
      const page = build({}, theme, {}, resolve);
      assert.match(page.render(80).join("\n"), /Completion delivery/);
      page.handleInput("\x1b");
    });
  } };
  await command("", { mode: "tui", ui });
  await command("", { mode: "rpc", ui });
  assert.equal(pages, 1);
  assert.deepEqual(notifications, [["Harness settings requires the interactive TUI.", "warning"]]);
});

test("hub autosaves callback changes in the session and saves the future default only on ctrl+s", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-callback-settings-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const pi = eventApi();
    let command;
    pi.on = () => {};
    pi.registerCommand = (_name, options) => { command = options.handler; };
    harnessSettings(pi);
    const path = join(dir, "settings.json");
    let page;
    const notifications = [];
    const ctx = { mode: "tui", isIdle: () => true, sessionManager: { getBranch: () => pi.entries },
      ui: { notify: (...args) => notifications.push(args), custom(build) {
        return new Promise(resolve => { page = build({}, theme, {}, resolve); });
      } } };
    const opening = command("", ctx);
    assert.match(page.render(80).join("\n"), /^> Completion delivery\s+When idle/m);
    page.handleInput("\r");
    assert.match(page.render(80).join("\n"), /^> Completion delivery\s+During run/m);
    assert.equal(pi.entries.length, 1);
    assert.equal(existsSync(path), false, "session autosave must not alter future defaults");
    page.handleInput("\x13");
    assert.match(page.render(80).join("\n"), /Callback default saved/);
    assert.equal(existsSync(path), true);
    page.handleInput("\x1b");
    await opening;
    const reopening = command("", ctx);
    assert.match(page.render(80).join("\n"), /^> Completion delivery\s+During run/m);
    page.handleInput("\r");
    assert.match(page.render(80).join("\n"), /^> Completion delivery\s+When idle/m);
    const savedDefault = readFileSync(path, "utf8");
    assert.equal(pi.entries.length, 2);
    page.handleInput("\x1b");
    await reopening;
    assert.equal(readFileSync(path, "utf8"), savedDefault, "later session edits leave the saved default alone");
    const newSession = command("", { ...ctx, sessionManager: { getBranch: () => [] } });
    assert.match(page.render(80).join("\n"), /^> Completion delivery\s+During run/m);
    page.handleInput("\x1b");
    await newSession;
    assert.deepEqual(notifications, []);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("callback control rolls back a failed session save and reports a failed default save without closing", async () => {
  let page;
  let mode = "hold";
  const ctx = { ui: { custom(build) { return new Promise(resolve => { page = build({}, theme, {}, resolve); }); } } };
  const opening = chooseHarnessSetting(ctx, [], undefined, {
    get: () => ({ mode, source: "default" }),
    change() { throw new Error("Session write unavailable"); },
    save() { throw new Error("Default write unavailable"); },
  });
  page.handleInput("\r");
  assert.match(page.render(80).join("\n"), /^> Completion delivery\s+When idle/m);
  assert.doesNotMatch(page.render(80).join("\n"), /^> Completion delivery\s+During run/m);
  assert.match(page.render(80).join("\n"), /Session write unavailable/);
  page.handleInput("\x13");
  assert.match(page.render(80).join("\n"), /Default write unavailable/);
  assert.equal(mode, "hold");
  page.handleInput("\x1b");
  assert.equal(await opening, undefined);
});

test("an invalid callback default reports once, leaves package settings usable, and can be repaired by ctrl+s", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-invalid-callback-default-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    mkdirSync(join(dir, "extensions"));
    writeFileSync(join(dir, "extensions", "pi-better-callback-preferences.json"), "malformed");
    const pi = eventApi();
    let command;
    let opened = 0;
    let pages = 0;
    pi.on = () => {};
    pi.registerCommand = (_name, options) => { command = options.handler; };
    const link = { id: "sandbox", label: "Sandbox", command: "/sandbox", open() { opened++; } };
    pi.bus.on("harness-settings:request", () => pi.bus.emit("harness-settings:register", link));
    harnessSettings(pi);
    const notifications = [];
    const ctx = { mode: "tui", isIdle: () => true, sessionManager: { getBranch: () => pi.entries },
      ui: { notify: (...args) => notifications.push(args), custom(build) {
        return new Promise(resolve => {
          const page = build({}, theme, {}, resolve);
          assert.match(page.render(80).join("\n"), /^[ >]+Completion delivery\s+When idle/m);
          if (++pages === 1) { assert.match(page.render(80).join("\n"), /> Sandbox settings/); page.handleInput("\r"); }
          else {
            if (pages === 2) {
              page.handleInput("\x13");
              assert.match(page.render(80).join("\n"), /Callback default saved/);
            }
            page.handleInput("\x1b");
          }
        });
      } } };
    await command("", ctx);
    assert.equal(opened, 1);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0][0], /Callback default unavailable/);
    await command("", ctx);
    assert.equal(notifications.length, 1, "the repaired default must load without another error");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

function selectRow(page, label) {
  for (let attempt = 0; attempt < 25; attempt++) {
    if (page.render(80).some(line => line.trimStart().startsWith(`> ${label} `))) {
      page.handleInput("\r");
      return;
    }
    page.handleInput("\x1b[B");
  }
  assert.fail(`Could not select ${label}`);
}

test("Harness instructions start Off, allow editing while On, and keep the draft across toggles", async () => {
  const path = join(isolatedAgentDir, "APPEND_SYSTEM.md");
  const original = "<!-- another plugin -->\nExisting instructions";
  writeFileSync(path, original);
  const pi = eventApi();
  let command;
  pi.on = () => {};
  pi.registerCommand = (_name, options) => { command = options.handler; };
  harnessSettings(pi);

  const customPrompt = "Use project conventions.\nCheck the tests.";
  const edits = [undefined, customPrompt];
  const pages = [
    page => {
      assert.match(page.render(80).join("\n"), /Harness instructions \(Beta\)\s+Off/);
      assert.doesNotMatch(page.render(80).join("\n"), /Instructions prompt/);
      selectRow(page, "Harness instructions (Beta)");
    },
    page => selectRow(page, "Instructions prompt"),
    page => {
      assert.ok(!readFileSync(path, "utf8").includes(customPrompt));
      selectRow(page, "Instructions prompt");
    },
    page => {
      assert.ok(readFileSync(path, "utf8").includes(customPrompt));
      selectRow(page, "Harness instructions (Beta)");
    },
    page => {
      assert.equal(readFileSync(path, "utf8"), original);
      selectRow(page, "Harness instructions (Beta)");
    },
    page => {
      assert.ok(readFileSync(path, "utf8").includes(customPrompt));
      assert.match(page.render(80).join("\n"), /Harness instructions \(Beta\)\s+On/);
      page.handleInput("\x1b");
    },
  ];
  const errors = [];
  await command("", { mode: "tui", isIdle: () => true, sessionManager: { getBranch: () => [] }, ui: {
    notify: message => errors.push(message),
    editor: async (_title, value) => {
      assert.match(value, /Harness defaults/);
      return edits.shift();
    },
    custom: build => new Promise(resolve => pages.shift()(build({}, theme, {}, resolve))),
  } });
  assert.deepEqual(errors, []);
  assert.equal(pages.length, 0);
  assert.equal(edits.length, 0);
});

test("the installed settings hub saves the OpenAI native compaction toggle in both directions", async () => {
  const pi = eventApi();
  let command;
  pi.on = () => {};
  pi.registerCommand = (_name, options) => { command = options.handler; };
  harnessSettings(pi);
  let page;
  const errors = [];
  const opening = command("", { mode: "tui", isIdle: () => true, sessionManager: { getBranch: () => [] },
    ui: { notify: message => errors.push(message), custom: build => new Promise(resolve => { page = build({}, theme, {}, resolve); }) } });
  for (const expected of [true, false]) {
    selectRow(page, "OpenAI native compaction");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.parse(readFileSync(join(isolatedAgentDir, "settings.json"), "utf8")).piBetterHarness.openaiNativeCompaction, expected);
    assert.match(page.render(80).join("\n"), expected ? /OpenAI native compaction\s+On/ : /OpenAI native compaction\s+Off/);
  }
  page.handleInput("\x1b");
  await opening;
  assert.deepEqual(errors, []);
});
