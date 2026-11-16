import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Container, TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { ensureBackgroundWorkNavigator, disposeBackgroundWorkNavigator, registerBackgroundWorkProvider, refreshBackgroundWorkNavigator } from "./index.ts";
import { __resetNavigatorPanelsForTests } from "./shared-navigator-panels.ts";

for (const providerId of ["subagents", "background-tasks"]) {
  test(`${providerId} updates stay differential with a tall editor and nested widget host`, async () => {
    let revision = 0;
    let editorHeight = 20;
    const writes: string[] = [];
    const terminal = new Proxy({ columns: 100, rows: 24, kittyProtocolActive: false, write: (s: string) => writes.push(s) }, {
      get: (target, key) => key in target ? Reflect.get(target, key) : () => undefined,
    });
    const tui = new TUI(terminal as any, false);
    const theme = { fg: (_: string, value: string) => value };
    const widgets = new Container();
    const editor = { render: () => Array.from({ length: editorHeight }, (_, i) => `editor ${i}`), invalidate() {}, getText: () => "", handleInput() {} };
    let factory: any;
    let host: any;
    const ui = {
      theme, setStatus() {}, getEditorComponent: () => factory, setEditorComponent: (value: any) => { factory = value; },
      setWidget(_key: string, value: any) {
        widgets.clear();
        host = typeof value === "function" ? value(tui, theme) : undefined;
        if (host) widgets.addChild(host);
        tui.requestRender();
      },
    };
    const ctx = { mode: "tui", hasUI: true, ui } as any;
    const unregister = registerBackgroundWorkProvider({
      id: providerId, label: providerId, priority: 10, visibleCount: () => 30,
      listRows: () => Array.from({ length: 30 }, (_, i) => ({
        providerId, id: `run-${i}`, name: `worker-${i}`, status: "running", statusTone: "running" as const,
        kind: "agent", elapsed: `${revision}s`, primary: `progress ${revision}`, facts: [`progress ${revision}`], sortStartedAt: 100 - i,
      })),
      detail: () => null, armCloseLabel: () => "stop", close: () => ({ action: "missing", providerId, id: "x" }),
    });
    try {
      tui.addChild({ render: () => Array.from({ length: 60 }, (_, i) => `history ${i}`), invalidate() {} });
      tui.addChild(widgets);
      tui.addChild(editor);
      tui.addChild({ render: () => ["footer"], invalidate() {} });
      ensureBackgroundWorkNavigator(ctx, { createDefaultEditor: () => editor, isOpenTrigger: x => x === "left", matchKey: (x, key) => x === key, truncate: truncateToWidth });
      const input = factory(tui, theme, {});
      await delay(80);
      assert.ok(host.render(100).length <= 3);
      assert.match(host.render(100).join("\n"), /\+\d+ tasks/);
      writes.length = 0;
      for (let i = 0; i < 3; i++) {
        revision++;
        refreshBackgroundWorkNavigator(ctx);
        await delay(80);
      }
      assert.ok(writes.join("").includes("progress 3"), "visible progress must still update");
      assert.doesNotMatch(writes.join(""), /\x1b\[(?:2|3)J/, "periodic updates must preserve screen and scrollback");
      input.handleInput("left");
      for (let i = 0; i < 29; i++) input.handleInput("down");
      assert.match(host.render(100).join("\n"), /worker-29/, "keyboard selection reaches hidden tasks");
      editorHeight = 2;
      assert.ok(host.render(100).length <= 21);
      editorHeight = 24;
      assert.deepEqual(host.render(100), [], "no available rows must not push live content into scrollback");
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
      __resetNavigatorPanelsForTests();
      tui.stop();
    }
  });
}
