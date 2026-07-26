import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLOSE_CONFIRM_STATUS_KEY,
  NAVIGATOR_STATUS_KEY,
  disposeBackgroundWorkNavigator,
  ensureBackgroundWorkNavigator,
  refreshBackgroundWorkNavigator,
  registerBackgroundWorkProvider,
  type BackgroundWorkProvider,
} from "./index.ts";

function provider(id: string, label: string, priority: number, startedAt: number, onClose: (id: string) => void): BackgroundWorkProvider {
  return {
    id,
    label,
    priority,
    visibleCount: () => 1,
    listRows: () => [{
      providerId: id,
      id: `${id}-1`,
      name: `${label} row`,
      status: "running",
      statusTone: "running",
      kind: id,
      elapsed: "1s",
      primary: `${label} primary`,
      sortStartedAt: startedAt,
    }],
    detail: (rowId) => ({
      providerId: id,
      id: rowId,
      title: `${label} detail`,
      status: "running",
      statusTone: "running",
      metadata: [{ label: "provider", value: label }],
      evidence: { label: "output", text: `${label} output` },
    }),
    armCloseLabel: () => "x again to stop",
    close: (rowId) => {
      onClose(rowId);
      return { action: "stopped", providerId: id, id: rowId, status: "cancelled" };
    },
  };
}

describe("shared background work navigator", () => {
  it("uses one footer/editor host for multiple providers and dispatches close by provider", () => {
    const closed: string[] = [];
    const unregisterSubagents = registerBackgroundWorkProvider(provider("subagents", "Subagents", 10, 200, (id) => closed.push(`subagents:${id}`)));
    const unregisterTasks = registerBackgroundWorkProvider(provider("background-tasks", "Background Tasks", 20, 100, (id) => closed.push(`tasks:${id}`)));

    const statuses: Array<[string, string | undefined]> = [];
    let component: any;
    const ui = {
      factory: undefined as any,
      theme: { fg: (_color: string, value: string) => value },
      setStatus(key: string, value: string | undefined) { statuses.push([key, value]); },
      getEditorComponent() { return this.factory; },
      setEditorComponent(factory: any) { this.factory = factory; },
      custom(factory: any) {
        component = factory({ requestRender() {} }, this.theme, {}, () => undefined);
        return Promise.resolve(null);
      },
    };
    const ctx = { mode: "tui", hasUI: true, ui } as any;

    try {
      ensureBackgroundWorkNavigator(ctx, {
        createDefaultEditor: () => ({ getText: () => "", handleInput() {} }),
        isOpenTrigger: (data) => data === "left",
        matchKey: (data, key) => data === key,
        truncate: (value, width) => value.slice(0, width),
      });

      assert.equal(statuses.at(-1)?.[0], NAVIGATOR_STATUS_KEY);
      assert.equal(statuses.at(-1)?.[1], "← background work · 2");
      assert.equal(ui.factory.__piBetterHarnessNavigatorFactory, true);

      const editor = ui.factory({}, {}, {});
      editor.handleInput("left");
      const list = component.render(100).join("\n");
      assert.match(list, /Background work/);
      assert.match(list, /Subagents/);
      assert.match(list, /Background Tasks/);

      component.handleInput("x");
      assert.equal(statuses.at(-1)?.[0], CLOSE_CONFIRM_STATUS_KEY);
      assert.equal(statuses.at(-1)?.[1], "x again to stop Subagents row");
      assert.deepEqual(closed, []);

      component.handleInput("x");
      assert.deepEqual(closed, ["subagents:subagents-1"]);
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregisterSubagents();
      unregisterTasks();
    }
  });

  it("refreshes the stored TUI navigator when a tool call has a non-TUI context", () => {
    let count = 0;
    const unregister = registerBackgroundWorkProvider({
      ...provider("background-tasks", "Background Tasks", 20, 100, () => undefined),
      visibleCount: () => count,
      listRows: () => [],
    });

    const statuses: Array<[string, string | undefined]> = [];
    const ui = {
      factory: undefined as any,
      setStatus(key: string, value: string | undefined) { statuses.push([key, value]); },
      getEditorComponent() { return this.factory; },
      setEditorComponent(factory: any) { this.factory = factory; },
    };
    const tuiCtx = { mode: "tui", hasUI: true, ui } as any;
    const toolCtx = { mode: "rpc", hasUI: false, ui: {} } as any;

    try {
      ensureBackgroundWorkNavigator(tuiCtx, {
        createDefaultEditor: () => ({ getText: () => "", handleInput() {} }),
        isOpenTrigger: (data) => data === "left",
        matchKey: (data, key) => data === key,
        truncate: (value, width) => value.slice(0, width),
      });
      assert.equal(statuses.at(-1)?.[1], undefined);

      count = 1;
      refreshBackgroundWorkNavigator(toolCtx);

      assert.deepEqual(statuses.at(-1), [NAVIGATOR_STATUS_KEY, "← background work · 1"]);
    } finally {
      disposeBackgroundWorkNavigator(tuiCtx);
      unregister();
    }
  });

  it("renders failed rows with Pi-supported theme colors", () => {
    const seenColors: string[] = [];
    const allowed = new Set(["accent", "success", "error", "warning", "dim"]);
    const unregister = registerBackgroundWorkProvider({
      id: "background-tasks",
      label: "Background Tasks",
      priority: 20,
      visibleCount: () => 2,
      listRows: () => [
        {
          providerId: "background-tasks",
          id: "failed-task",
          name: "failed task",
          status: "failed",
          statusTone: "failed",
          kind: "watch",
          elapsed: "1s",
          primary: "gh pr checks",
          sortStartedAt: 200,
        },
        {
          providerId: "background-tasks",
          id: "lost-task",
          name: "lost task",
          status: "lost",
          statusTone: "failed",
          kind: "subagent",
          elapsed: "2s",
          primary: "subagent run",
          sortStartedAt: 100,
        },
      ],
      detail: () => null,
      armCloseLabel: () => "x again to dismiss",
      close: (id) => ({ action: "dismissed", providerId: "background-tasks", id }),
    });

    let component: any;
    const ui = {
      factory: undefined as any,
      theme: {
        fg(color: string, value: string) {
          seenColors.push(color);
          if (!allowed.has(color)) throw new Error(`Unknown theme color: ${color}`);
          return `<${color}>${value}</>`;
        },
      },
      setStatus() {},
      getEditorComponent() { return this.factory; },
      setEditorComponent(factory: any) { this.factory = factory; },
      custom(factory: any) {
        component = factory({ requestRender() {} }, this.theme, {}, () => undefined);
        return Promise.resolve(null);
      },
    };
    const ctx = { mode: "tui", hasUI: true, ui } as any;

    try {
      ensureBackgroundWorkNavigator(ctx, {
        createDefaultEditor: () => ({ getText: () => "", handleInput() {} }),
        isOpenTrigger: (data) => data === "left",
        matchKey: (data, key) => data === key,
        truncate: (value, width) => value.slice(0, width),
      });

      const editor = ui.factory({}, {}, {});
      editor.handleInput("left");

      assert.doesNotThrow(() => component.render(100));
      assert.ok(seenColors.includes("error"), "failed statuses use Pi's error color");
      assert.equal(seenColors.includes("danger"), false, "danger is not a Pi theme color");
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
  });
});
