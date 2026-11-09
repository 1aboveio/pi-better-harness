import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsRegistry } from "../pi-better-harness/extensions/settings/registry.ts";
import { initializeNavigatorPanels, setNavigatorPanel, NAVIGATOR_ENTRY_TYPE, __resetNavigatorPanelsForTests } from "./panels.ts";

function fixture(t: TestContext, sticky = true) {
  const dir = mkdtempSync(join(tmpdir(), "navigator-panels-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  __resetNavigatorPanelsForTests();
  t.after(() => {
    __resetNavigatorPanelsForTests();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, "settings.json");
  if (!sticky) writeFileSync(path, JSON.stringify({ piBetterHarness: { navigator: { version: 1, sticky: false } } }));
  const bus = new EventEmitter();
  const events = { on(name: string, fn: any) { bus.on(name, fn); return () => bus.off(name, fn); }, emit: (name: string, data: any) => bus.emit(name, data) };
  const hooks = new Map<string, any[]>();
  const entries: any[] = [];
  const renderers = new Map<string, any>();
  const pi: any = {
    events, registerEntryRenderer: (key: string, render: any) => renderers.set(key, render),
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    on(name: string, fn: any) { hooks.set(name, [...hooks.get(name) ?? [], fn]); },
  };
  const theme = { fg: (_color: string, text: string) => text };
  const widgets = new Map<string, any>();
  let paints = 0;
  const editor = {};
  const tui: any = { requestRender() { paints++; }, hasOverlay: () => false, getFocusedComponent: () => editor };
  const ctx: any = { mode: "tui", hasUI: true, sessionManager: { getBranch: () => entries }, ui: {
    setWidget(key: string, content: any) { widgets.get(key)?.dispose(); widgets.set(key, content?.(tui, theme)); },
  } };
  initializeNavigatorPanels(pi);
  const registry = createSettingsRegistry(pi);
  t.after(() => registry.dispose());
  const control = () => { registry.refresh(); return registry.controls().find(control => control.id === "navigator-sticky")!; };
  const widget = () => widgets.get("background-work-list");
  const transcript = () => renderers.get(NAVIGATOR_ENTRY_TYPE)(entries.filter(entry => entry.customType === NAVIGATOR_ENTRY_TYPE).at(-1), {}, theme);
  const fire = async (name: string) => { for (const fn of hooks.get(name) ?? []) await fn({}, ctx); };
  return { dir, path, pi, ctx, hooks, entries, widgets, renderers, widget, transcript, control, tui, editor, fire, paints: () => paints };
}

test("all packages share one host, preserve native TUI access, and route pointer offsets", t => {
  const f = fixture(t);
  const clicks: string[] = [];
  for (const [key, label] of [["background-work-list", "work"], ["pi-better-plan", "todo"], ["pi-better-goal", "goal"]]) {
    setNavigatorPanel(f.ctx, key!, (tui, theme) => {
      assert.equal(tui, f.tui);
      assert.equal((tui as typeof f.tui).getFocusedComponent(), f.editor);
      return { render: () => [label!], invalidate() {}, handleMouse(event) { clicks.push(`${label}:${event.y}`); return { handled: true, render: false }; } };
    });
  }
  assert.deepEqual([...f.widgets.keys()], ["background-work-list"]);
  assert.deepEqual(f.widget().render(80), ["goal", "todo", "work"]);
  f.widget().handleMouse({ type: "click", button: "left", x: 1, y: 2, width: 80 });
  assert.deepEqual(clicks, ["work:0"]);
  assert.equal(existsSync(f.path), false, "initialization must not save defaults");
});

test("Off scrolls one live entry, preserves clicks and idle repaint, and On pins it again", async t => {
  const f = fixture(t);
  let label = "first";
  let click = -1;
  setNavigatorPanel(f.ctx, "pi-better-plan", () => ({ render: () => [label], invalidate() {}, handleMouse(event) { click = event.y; return { handled: true, render: false }; } }));
  await f.control().change("Off", f.ctx);
  assert.deepEqual(f.widget().render(80), [], "the shared UI hook takes no pinned rows in scrolling mode");
  await Promise.resolve();
  assert.equal(f.entries.length, 1);
  const transcript = f.transcript();
  assert.deepEqual(transcript.render(80), ["first"]);
  transcript.handleMouse({ type: "click", button: "left", x: 1, y: 0, width: 80 });
  assert.equal(click, 0);
  const paints = f.paints();
  label = "updated";
  setNavigatorPanel(f.ctx, "pi-better-plan", () => ({ render: () => [label], invalidate() {} }));
  assert.ok(f.paints() > paints, "idle state changes request a real TUI redraw");
  assert.deepEqual(transcript.render(80), ["updated"]);
  for (let i = 0; i < 3; i++) { f.widget().render(80); await f.fire("turn_start"); }
  assert.equal(f.entries.length, 1, "updates and turns must not flood chat with panel copies");
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")).piBetterHarness.navigator, { version: 1, sticky: false });
  await f.control().change("On", f.ctx);
  assert.deepEqual(f.widget().render(80), ["updated"]);
  assert.deepEqual(transcript.render(80), [], "the old chat anchor cannot duplicate the pinned navigator");
  await f.control().change("Off", f.ctx);
  f.widget().render(80);
  await Promise.resolve();
  assert.equal(f.entries.length, 2, "reopening scrolling mode needs a fresh rendered anchor");
  assert.deepEqual(transcript.render(80), []);
  assert.deepEqual(f.transcript().render(80), ["updated"]);
});

test("failed saves leave the active mode intact and empty sessions never append anchors", async t => {
  const f = fixture(t);
  setNavigatorPanel(f.ctx, "pi-better-plan", () => ({ render: () => [], invalidate() {} }));
  writeFileSync(f.path, "{broken");
  await assert.rejects(async () => f.control().change("Off", f.ctx));
  assert.equal(f.control().get(), "On");
  assert.equal(readFileSync(f.path, "utf8"), "{broken");
  assert.equal(f.entries.length, 0);
  writeFileSync(f.path, "{}");
  await f.control().change("Off", f.ctx);
  f.widget().render(80);
  await Promise.resolve();
  assert.equal(f.entries.length, 0, "empty panels must not write transcript state");
});

test("reload and branch changes restore only the active branch anchor", async t => {
  const f = fixture(t, false);
  f.entries.push({ type: "custom", customType: NAVIGATOR_ENTRY_TYPE, data: { version: 1, anchor: "visible-branch" } });
  const restoredBeforeSessionStart = f.transcript();
  assert.ok(restoredBeforeSessionStart, "Pi admits custom entries before session_start restores their anchor");
  await f.fire("session_start");
  setNavigatorPanel(f.ctx, "pi-better-plan", () => ({ render: () => ["restored"], invalidate() {} }));
  assert.deepEqual(f.widget().render(80), []);
  await Promise.resolve();
  assert.equal(f.entries.length, 1, "reload reuses the visible anchor");
  assert.deepEqual(restoredBeforeSessionStart.render(80), ["restored"]);
  f.entries.length = 0;
  await f.fire("session_tree");
  f.widget().render(80);
  await Promise.resolve();
  assert.equal(f.entries.length, 1, "a branch without an anchor receives its own");
  assert.notEqual(f.entries[0].data.anchor, "visible-branch");
  assert.deepEqual(f.transcript().render(80), ["restored"]);
});

test("multiple owners deduplicate the setting and dispose the shared host after shutdown", async t => {
  const f = fixture(t);
  const peer = { ...f.pi };
  initializeNavigatorPanels(peer);
  assert.equal(f.control().get(), "On", "identical shared contributions must not conflict");
  let disposed = 0;
  setNavigatorPanel(f.ctx, "pi-better-goal", () => ({ render: () => ["goal"], invalidate() {}, dispose() { disposed++; } }));
  await f.fire("session_shutdown");
  assert.equal(disposed, 1);
  assert.equal(f.widget(), undefined);
  assert.equal(f.entries.length, 0);
});