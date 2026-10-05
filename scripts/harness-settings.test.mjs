import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createSettingsRegistry } from "../packages/pi-better-harness/extensions/settings/registry.ts";
import { chooseHarnessSetting } from "../packages/pi-better-harness/extensions/settings/page.ts";
import harnessSettings from "../packages/pi-better-harness/extensions/settings/index.ts";
import { getKeybindings, setKeybindings, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

function eventApi(bus = new EventEmitter()) {
  return { bus, events: { on(name, handler) { bus.on(name, handler); return () => bus.off(name, handler); }, emit: (name, data) => bus.emit(name, data) } };
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
    return new Promise(resolve => { const page = build({}, theme, {}, resolve); page.handleInput(++pages === 1 ? "\r" : "\x1b"); });
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

test("hub without contributions or outside TUI exits without requesting an agent turn", async () => {
  const pi = eventApi();
  let command;
  pi.on = () => {};
  pi.registerCommand = (_name, options) => { command = options.handler; };
  harnessSettings(pi);
  const notifications = [];
  const ui = { notify: (...args) => notifications.push(args), custom() { throw new Error("Must not open a selector"); } };
  await command("", { mode: "tui", ui });
  await command("", { mode: "rpc", ui });
  assert.deepEqual(notifications, [["No package settings are available.", "info"], ["Harness settings requires the interactive TUI.", "warning"]]);
});
