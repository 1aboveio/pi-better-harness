import assert from "node:assert/strict";
import test, { after } from "node:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsRegistry } from "../packages/pi-better-harness/extensions/settings/registry.ts";
import { chooseHarnessSetting } from "../packages/pi-better-harness/extensions/settings/page.ts";
import harnessSettings from "../packages/pi-better-harness/extensions/settings/index.ts";
import { getKeybindings, setKeybindings, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

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
  const link = { id: "goal", label: "Goal", command: "/goal settings", open: async () => { opened++; } };
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

test("native settings list selects package links without opening or changing them itself", async () => {
  let page;
  let opened = false;
  const ctx = { ui: { custom(build) { return new Promise(resolve => { page = build({}, theme, {}, resolve); }); } } };
  const selected = chooseHarnessSetting(ctx, [{ id: "goal", label: "Goal", command: "/goal settings", open() { opened = true; } }], "link:goal");
  assert.match(page.render(80).join("\n"), /Goal.*\/goal settings/);
  page.handleInput("\r");
  assert.equal(await selected, "link:goal");
  assert.equal(opened, false);
});

test("selection restoration preserves ordering and rebound native navigation", async () => {
  const original = getKeybindings();
  const rebound = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "j", "tui.select.up": "k" });
  setKeybindings(rebound);
  try {
    let page;
    const ctx = { ui: { custom(build) { return new Promise(resolve => { page = build({}, theme, {}, resolve); }); } } };
    const links = ["goal", "sandbox", "subagents"].map(id => ({ id, label: id, command: `/${id} settings`, open() {} }));
    const chosen = chooseHarnessSetting(ctx, links, "link:subagents");
    assert.equal(getKeybindings(), rebound, "restore never replaces the user's active bindings");
    const lines = page.render(80).join("\n");
    assert.match(lines, /> subagents/);
    assert.ok(lines.indexOf("goal") < lines.indexOf("sandbox") && lines.indexOf("sandbox") < lines.indexOf("subagents"));
    page.handleInput("k");
    assert.match(page.render(80).join("\n"), /> sandbox/);
    page.handleInput("j");
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
      if (++pages === 1) { page.handleInput("\x1b[B"); page.handleInput("\r"); }
      else page.handleInput("\x1b");
    });
  } } };
  const link = { id: "goal", label: "Goal", command: "/goal settings", open(current) { assert.equal(current, ctx); opened++; throw new Error("Synthetic opener failure"); } };
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
      assert.match(page.render(80).join("\n"), /Completions while busy/);
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
    assert.match(page.render(80).join("\n"), /Wait until idle/);
    page.handleInput("\r");
    assert.match(page.render(80).join("\n"), /Steer active run/);
    assert.equal(pi.entries.length, 1);
    assert.equal(existsSync(path), false, "session autosave must not alter future defaults");
    page.handleInput("\x13");
    assert.match(page.render(80).join("\n"), /Callback default saved/);
    assert.equal(existsSync(path), true);
    page.handleInput("\x1b");
    await opening;
    const reopening = command("", ctx);
    assert.match(page.render(80).join("\n"), /Steer active run/);
    page.handleInput("\r");
    assert.match(page.render(80).join("\n"), /Wait until idle/);
    const savedDefault = readFileSync(path, "utf8");
    assert.equal(pi.entries.length, 2);
    page.handleInput("\x1b");
    await reopening;
    assert.equal(readFileSync(path, "utf8"), savedDefault, "later session edits leave the saved default alone");
    const newSession = command("", { ...ctx, sessionManager: { getBranch: () => [] } });
    assert.match(page.render(80).join("\n"), /Steer active run/);
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
  assert.match(page.render(80).join("\n"), /Wait until idle/);
  assert.doesNotMatch(page.render(80).join("\n"), /Steer active run/);
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
    const link = { id: "goal", label: "Goal", command: "/goal settings", open() { opened++; } };
    pi.bus.on("harness-settings:request", () => pi.bus.emit("harness-settings:register", link));
    harnessSettings(pi);
    const notifications = [];
    const ctx = { mode: "tui", isIdle: () => true, sessionManager: { getBranch: () => pi.entries },
      ui: { notify: (...args) => notifications.push(args), custom(build) {
        return new Promise(resolve => {
          const page = build({}, theme, {}, resolve);
          assert.match(page.render(80).join("\n"), /Wait until idle/);
          if (++pages === 1) { page.handleInput("\x1b[B"); page.handleInput("\r"); }
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
