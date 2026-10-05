import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { createSettingsRegistry } from "../packages/pi-better-harness/extensions/settings/registry.ts";
import { chooseHarnessSetting } from "../packages/pi-better-harness/extensions/settings/page.ts";
import { installGhostEditor } from "../packages/pi-better-harness/extensions/prompt-suggestions/editor.ts";
import { ensureBackgroundWorkNavigator, disposeBackgroundWorkNavigator, registerBackgroundWorkProvider } from "../packages/navigator/index.ts";
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);

function editorFixture(previous, bindings = {}) {
  let factory = previous;
  let editor;
  let changed = 0;
  let accepted = 0;
  const submits = [];
  const host = { terminal: { rows: 40, columns: 80 }, requestRender() {} };
  const identity = text => text;
  const editorTheme = { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } };
  const ctx = { mode: "tui", hasUI: true, ui: { setStatus() {}, theme: { fg: (_key, text) => text }, getEditorComponent: () => factory, setEditorComponent(next) {
    const text = editor?.getText() ?? "";
    factory = next;
    editor = next ? next(host, editorTheme, new KeybindingsManager(bindings)) : new CustomEditor(host, editorTheme, new KeybindingsManager(bindings));
    editor.onChange = () => { changed++; };
    editor.onSubmit = text => { if (text.trim()) submits.push(text); };
    editor.setText(text);
    editor.focused = true;
  } } };
  const ghost = installGhostEditor(ctx, { changed() {}, accepted() { accepted++; }, unused() {} });
  return { ghost, get editor() { return editor; }, ctx, submits, changed: () => changed, accepted: () => accepted };
}

test("ghost text is rendered at the native cursor but never submitted until accepted", () => {
  const f = editorFixture();
  assert.equal(f.ghost.show("Run the focused tests"), true);
  assert.equal(f.editor.getText(), "");
  assert.match(f.editor.render(80).join("\n"), /Run the focused tests/);
  assert.ok(f.editor.render(80).some(line => line.includes(CURSOR_MARKER)));
  assert.ok(f.editor.render(80).some(line => line.includes("\x1b[7m")), "the native software cursor remains visible");
  f.editor.handleInput("\r");
  assert.deepEqual(f.submits, []);
  f.ghost.show("Run the focused tests");
  f.editor.handleInput("\t");
  assert.equal(f.editor.getText(), "Run the focused tests");
  assert.equal(f.accepted(), 1);
  assert.deepEqual(f.submits, []);
  f.editor.handleInput("\x1f");
  // Pi uses ctrl+- for undo; send its legacy encoding.
  f.editor.handleInput("\x1b[45;5u");
  assert.equal(f.editor.getText(), "");
  f.ghost.show("Try again");
  f.editor.handleInput("\x1b[C");
  assert.equal(f.editor.getText(), "Try again");
  f.editor.handleInput("\r");
  assert.deepEqual(f.submits, ["Try again"]);
  f.ghost.dispose();
});

test("native callback rewiring, edits and focus preserve the user's draft", () => {
  const f = editorFixture();
  f.ghost.show("Suggestion");
  f.editor.handleInput("mine");
  assert.equal(f.editor.getText(), "mine");
  assert.doesNotMatch(f.editor.render(60).join("\n"), /Suggestion/);
  assert.ok(f.changed() > 0);
  f.editor.setText("");
  assert.doesNotMatch(f.editor.render(60).join("\n"), /Suggestion/);
  f.ghost.show("Other");
  f.editor.setText("external draft");
  assert.equal(f.editor.getText(), "external draft");
  f.editor.setText("");
  f.editor.focused = false;
  assert.equal(f.ghost.show("Hidden"), false);
  f.editor.focused = true;
  f.editor[Symbol.for("pi-better-harness.editor-input-blocked")] = () => true;
  assert.equal(f.ghost.show("Navigator must win"), false);
  f.ghost.dispose();
});

test("ghost preview fits narrow columns with CJK without adding editor rows", () => {
  const f = editorFixture();
  const count = f.editor.render(80).length;
  assert.equal(f.ghost.show("\u8fd0\u884c\u6d4b\u8bd5".repeat(15)), true);
  for (const width of [1, 4, 20, 80]) {
    const lines = f.editor.render(width);
    assert.equal(lines.length, count);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
  f.ghost.dispose();
});

test("foreign modal editors are preserved and do not acquire suggestion keys", () => {
  class ModalEditor extends CustomEditor {}
  const f = editorFixture((tui, theme, kb) => new ModalEditor(tui, theme, kb));
  assert.equal(f.ghost.show("Do not install"), false);
  f.editor.handleInput("draft");
  assert.equal(f.editor.getText(), "draft");
  f.ghost.dispose();
});

test("navigator keys take priority in either native-editor wrapper load order", () => {
  for (const order of ["suggestions-first", "navigator-first"]) {
    const f = editorFixture();
    if (order === "navigator-first") f.ghost.dispose();
    const removeProvider = registerBackgroundWorkProvider({
      id: "test-work", label: "Work", priority: 1, visibleCount: () => 1,
      listRows: () => [{ providerId: "test-work", id: "job", name: "Job", status: "running", statusTone: "running", kind: "task", elapsed: "1s", primary: "working", sortStartedAt: 0 }],
      detail: () => null, armCloseLabel: () => "Stop", close: () => ({ action: "not-closable", providerId: "test-work", id: "job" }),
    });
    let ghost;
    try {
      ensureBackgroundWorkNavigator(f.ctx, { createDefaultEditor: (tui, theme, kb) => new CustomEditor(tui, theme, kb), isOpenTrigger: data => matchesKey(data, "left"), matchKey: matchesKey, truncate: text => text });
      ghost = order === "suggestions-first" ? f.ghost : installGhostEditor(f.ctx, { changed() {}, accepted() {}, unused() {} });
      assert.equal(ghost.show("Run tests"), true, order);
      f.editor.handleInput("\x1b[D");
      assert.equal(ghost.show("Must not accept"), false, order);
      f.editor.handleInput("\x1b[C");
      assert.equal(f.editor.getText(), "", order);
      f.editor.handleInput("\x1b");
      assert.equal(ghost.show("Run tests"), true, order);
      f.editor.handleInput("\t");
      assert.equal(f.editor.getText(), "Run tests", order);
    } finally {
      ghost?.dispose();
      removeProvider();
      disposeBackgroundWorkNavigator(f.ctx);
    }
  }
});

test("registered extension shortcuts and remapped application actions retain priority", () => {
  const f = editorFixture(undefined, { "app.model.select": "right" });
  let shortcuts = 0;
  let actions = 0;
  f.editor.onExtensionShortcut = data => { if (data !== "\t") return false; shortcuts++; return true; };
  f.editor.actionHandlers.set("app.model.select", () => { actions++; });
  f.ghost.show("Must not accept");
  f.editor.handleInput("\t");
  assert.equal(shortcuts, 1);
  assert.equal(f.editor.getText(), "");
  f.ghost.show("Must not accept");
  f.editor.handleInput("\x1b[C");
  assert.equal(actions, 1);
  assert.equal(f.editor.getText(), "");
  assert.equal(f.accepted(), 0);
  f.ghost.dispose();
});

test("native autocomplete owns empty-buffer selection rather than ghost text", async () => {
  const f = editorFixture();
  f.editor.setAutocompleteProvider({
    getSuggestions: async () => ({ items: [{ value: "first", label: "First" }, { value: "second", label: "Second" }], prefix: "" }),
    applyCompletion: (_lines, _row, _col, item) => ({ lines: [item.value], cursorLine: 0, cursorCol: item.value.length }),
  });
  f.editor.handleInput("\t");
  await new Promise(setImmediate);
  assert.equal(f.editor.isShowingAutocomplete(), true);
  assert.equal(f.ghost.show("Must not override autocomplete"), false);
  f.editor.handleInput("\r");
  assert.equal(f.editor.getText(), "first");
  assert.deepEqual(f.submits, []);
  f.ghost.dispose();
});

test("settings discovery supports both load orders, deduplicates and removes conflicts", async () => {
  const bus = new EventEmitter();
  const pi = { events: { on(name, handler) { bus.on(name, handler); return () => bus.off(name, handler); }, emit: (name, data) => bus.emit(name, data) } };
  let opened = 0;
  const link = { id: "goal", label: "Goal", command: "/goal settings", open: async () => { opened++; } };
  bus.emit("harness-settings:register", link);
  bus.on("harness-settings:request", () => bus.emit("harness-settings:register", link));
  const registry = createSettingsRegistry(pi);
  registry.refresh();
  bus.emit("harness-settings:register", link);
  assert.equal(registry.list().length, 1);
  await registry.list()[0].open({});
  assert.equal(opened, 1);
  bus.emit("harness-settings:register", { ...link, open() {} });
  assert.deepEqual(registry.list(), []);
  registry.refresh();
  assert.equal(registry.list().length, 1);
  registry.dispose();
  assert.equal(bus.listenerCount("harness-settings:register"), 0);
  assert.deepEqual(registry.list(), []);
});

test("native settings list selects package links without opening or changing them itself", async () => {
  let page;
  let opened = false;
  const ctx = { ui: { custom(build) { return new Promise(resolve => { page = build({}, { fg: (_key, text) => text, bold: text => text, inverse: text => text }, {}, resolve); }); } } };
  const selected = chooseHarnessSetting(ctx, false, [{ id: "goal", label: "Goal", command: "/goal settings", open() { opened = true; } }], "link:goal");
  assert.match(page.render(80).join("\n"), /Goal.*\/goal settings/);
  page.handleInput("\r");
  assert.equal(await selected, "link:goal");
  assert.equal(opened, false);
});