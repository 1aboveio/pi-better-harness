import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  CLOSE_CONFIRM_STATUS_KEY,
  MAIN_LIST_WIDGET_KEY,
  NAVIGATOR_STATUS_KEY,
  disposeBackgroundWorkNavigator,
  ensureBackgroundWorkNavigator,
  isNavigatorUiAvailable,
  refreshBackgroundWorkNavigator,
  registerBackgroundWorkProvider,
  wrapLogText,
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

function renderWidget(value: unknown, width: number, theme: unknown = { fg: (_color: string, value: string) => value }): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "function") return [];
  return value({ requestRender() {} }, theme).render(width);
}

describe("shared background work navigator", () => {
  it("uses one footer/editor host for multiple providers and dispatches close by provider", () => {
    const closed: string[] = [];
    const unregisterSubagents = registerBackgroundWorkProvider(provider("subagents", "Subagents", 10, 200, (id) => closed.push(`subagents:${id}`)));
    const unregisterTasks = registerBackgroundWorkProvider(provider("background-tasks", "Background Tasks", 20, 100, (id) => closed.push(`tasks:${id}`)));

    const statuses: Array<[string, string | undefined]> = [];
    const widgets: Array<[string, unknown]> = [];
    let component: any;
    const ui = {
      factory: undefined as any,
      theme: { fg: (_color: string, value: string) => value },
      setStatus(key: string, value: string | undefined) { statuses.push([key, value]); },
      setWidget(key: string, value: unknown) { widgets.push([key, value]); },
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
      assert.equal(statuses.at(-1)?.[1], "← work · 2");

      let list = renderWidget(widgets.at(-1)?.[1], 120, ui.theme).join("\n");
      assert.doesNotMatch(list, /background work/);
      assert.match(list, /Subagents row/);
      assert.match(list, /Background Tasks row/);
      assert.match(list, /← work navigator/);
      assert.doesNotMatch(list, /→ plan/);
      assert.doesNotMatch(list, /shortcuts/);
      assert.match(list, /^background tasks$/m);

      const editor = ui.factory({}, {}, {});
      editor.handleInput("left");
      assert.equal(widgets.at(-1)?.[0], MAIN_LIST_WIDGET_KEY);
      list = renderWidget(widgets.at(-1)?.[1], 120, ui.theme).join("\n");
      assert.match(list, /↑↓ switch · Enter detail · x stop · Esc unfocus/);

      editor.handleInput("enter");
      const detail = component.render(100).join("\n");
      assert.match(detail, /Subagents detail/);

      component.handleInput("x");
      assert.equal(statuses.at(-1)?.[0], CLOSE_CONFIRM_STATUS_KEY);
      assert.equal(statuses.at(-1)?.[1], "x again to stop Subagents row");
      assert.deepEqual(closed, []);

      component.handleInput("x");
      assert.deepEqual(closed, ["subagents:subagents-1"]);
      // Reopen, select the other provider, and verify routing independently.
      editor.handleInput("down");
      assert.match(component.render(100).join("\n"), /Background Tasks detail/);
      component.handleInput("x");
      assert.deepEqual(closed, ["subagents:subagents-1"]);
      component.handleInput("x");
      assert.deepEqual(closed, ["subagents:subagents-1", "tasks:background-tasks-1"]);
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
      setWidget() {},
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

      assert.deepEqual(statuses.at(-1), [NAVIGATOR_STATUS_KEY, "← work · 1"]);
    } finally {
      disposeBackgroundWorkNavigator(tuiCtx);
      unregister();
    }
  });

  it("survives a retained stale context and releases it during disposal", () => {
    const ui = {
      factory: undefined as any,
      setStatus() {},
      setWidget() {},
      getEditorComponent() { return this.factory; },
      setEditorComponent(factory: any) { this.factory = factory; },
    };
    const staleCtx = { mode: "tui", hasUI: true, ui } as any;
    ensureBackgroundWorkNavigator(staleCtx, {
      createDefaultEditor: () => ({ getText: () => "", handleInput() {} }),
      isOpenTrigger: () => false,
      matchKey: () => false,
      truncate: (value) => value,
    });

    let staleReads = 0;
    for (const key of ["mode", "ui"] as const) {
      Object.defineProperty(staleCtx, key, {
        configurable: true,
        get() {
          staleReads += 1;
          throw new Error(`stale ${key}`);
        },
      });
    }

    assert.equal(isNavigatorUiAvailable(staleCtx), false);
    let unregister: (() => void) | undefined;
    assert.doesNotThrow(() => {
      unregister = registerBackgroundWorkProvider(provider("stale-test", "Stale Test", 30, 300, () => undefined));
    });
    assert.doesNotThrow(() => disposeBackgroundWorkNavigator());

    const readsAfterDispose = staleReads;
    unregister?.();
    assert.equal(staleReads, readsAfterDispose, "provider refresh must not consult the released stale context");
  });

  it("keeps the main list timer-free and renders only material provider changes", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let notifyVisibleChanged: (() => void) | undefined;
    let elapsed = "1s";
    let facts = ["14m 30s left"];
    let status = "running";
    let statusTone: "running" | "success" = "running";
    const unregister = registerBackgroundWorkProvider({
      ...provider("background-tasks", "Background Tasks", 20, 100, () => undefined),
      visibleCount: () => status === "running" ? 1 : 0,
      listRows: () => [{
        providerId: "background-tasks",
        id: "background-tasks-1",
        name: "Background Tasks row",
        status,
        statusTone,
        kind: "background-tasks",
        elapsed,
        primary: "Background Tasks primary",
        facts,
        sortStartedAt: 100,
      }],
      onVisibleChanged(notify) {
        notifyVisibleChanged = notify;
        return () => { notifyVisibleChanged = undefined; };
      },
    });
    let widgetFactory: any;
    const ui = {
      factory: undefined as any,
      setStatus() {},
      setWidget(_key: string, value: unknown) { if (typeof value === "function") widgetFactory = value; },
      getEditorComponent() { return this.factory; },
      setEditorComponent(factory: any) { this.factory = factory; },
    };
    const ctx = { mode: "tui", hasUI: true, ui } as any;

    try {
      ensureBackgroundWorkNavigator(ctx, {
        createDefaultEditor: () => ({ getText: () => "", handleInput() {} }),
        isOpenTrigger: (data) => data === "left",
        matchKey: (data, key) => data === key,
        truncate: (value, width) => value.slice(0, width),
      });
      let renders = 0;
      const component = widgetFactory({ requestRender: () => { renders += 1; } }, {});
      component.render(100);

      t.mock.timers.tick(60_000);
      assert.equal(renders, 0, "running rows do not drive periodic full-screen renders");

      elapsed = "1m 01s";
      facts = ["13m 29s left"];
      notifyVisibleChanged?.();
      assert.equal(renders, 0, "volatile elapsed/deadline churn does not repaint the terminal");

      status = "succeeded";
      statusTone = "success";
      facts = ["result"];
      notifyVisibleChanged?.();
      assert.equal(renders, 1, "material provider state changes render immediately");
      component.dispose?.();
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
  });

  it("renders failed rows with Pi-supported theme colors", () => {
    const seenColors: string[] = [];
    const widgets: unknown[] = [];
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
      detail: (id) => ({
        providerId: "background-tasks", id, title: "Failed task detail",
        status: "failed", statusTone: "failed", metadata: [],
        evidence: { label: "log", text: "command exited 1" },
      }),
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
      setWidget(_key: string, value: unknown) { widgets.push(value); },
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

      const renderedWidget = renderWidget(widgets.at(-1), 100, ui.theme).join("\n");
      assert.doesNotMatch(renderedWidget, /background work/);
      assert.match(renderedWidget, /failed/);
      assert.match(renderedWidget, /lost/);
      assert.match(renderedWidget, /<dim>\s+failed, inspect log<\/>/);
      assert.match(renderedWidget, /^<warning>background tasks<\/>$/m, "compact rail should keep the provider lane title visible");
      assert.doesNotMatch(renderedWidget, /^main$/m, "background work is not grouped under a confusing main lane");

      const editor = ui.factory({}, {}, {});
      editor.handleInput("left");
      editor.handleInput("enter");

      seenColors.length = 0;
      const detail = component.render(100).join("\n");
      assert.match(detail, /status\s+<error>failed<\/>/);
      assert.match(detail, /command exited 1/);
      assert.ok(seenColors.includes("error"), "failed statuses use Pi's error color");
      assert.equal(seenColors.includes("danger"), false, "danger is not a Pi theme color");
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
  });

  it("renders running rows as a stable solid dot", () => {
    const unregister = registerBackgroundWorkProvider({
      ...provider("subagents", "Subagents", 10, 300, () => undefined),
      listRows: () => [{
        providerId: "subagents",
        id: "subagent-1",
        name: "reviewer",
        status: "running",
        statusTone: "running",
        kind: "subagent",
        elapsed: "1s",
        primary: "gpt-5.5 · 1.0k tok",
        sortStartedAt: 300,
      }],
    });

    const widgets: unknown[] = [];
    const ui = {
      factory: undefined as any,
      theme: { fg: (color: string, value: string) => `<${color}>${value}</>` },
      setStatus() {},
      setWidget(_key: string, value: unknown) { widgets.push(value); },
      getEditorComponent() { return this.factory; },
      setEditorComponent(factory: any) { this.factory = factory; },
      custom() { return Promise.resolve(null); },
    };
    const ctx = { mode: "tui", hasUI: true, ui } as any;

    try {
      ensureBackgroundWorkNavigator(ctx, {
        createDefaultEditor: () => ({ getText: () => "", handleInput() {} }),
        isOpenTrigger: (data) => data === "left",
        matchKey: (data, key) => data === key,
        truncate: (value, width) => value.slice(0, width),
      });

      const first = renderWidget(widgets.at(-1), 100, ui.theme).join("\n");
      const second = renderWidget(widgets.at(-1), 100, ui.theme).join("\n");
      const third = renderWidget(widgets.at(-1), 100, ui.theme).join("\n");

      assert.match(first, /<accent>●<\/>\s+reviewer/);
      assert.match(second, /<accent>●<\/>\s+reviewer/);
      assert.match(third, /<accent>●<\/>\s+reviewer/);
      assert.equal(first, second);
      assert.equal(second, third);
      assert.doesNotMatch(`${first}\n${second}\n${third}`, /<[a-z]+>[•·◌]<\/>\s+reviewer|◌/);
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
  });

  it("renders the main list as a provider-grouped work rail at the TUI render width", () => {
    const stdoutColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: 100 });
    const unregisterSubagents = registerBackgroundWorkProvider({
      ...provider("subagents", "Subagents", 10, 200, () => undefined),
      listRows: () => [{
        providerId: "subagents",
        id: "sa-1",
        name: "reviewer",
        model: "grok-4.5",
        effort: "high",
        tool: "bash",
        tokens: "18.2k tok · $0.08",
        status: "running",
        statusTone: "running",
        kind: "subagent",
        elapsed: "1m 04s",
        primary: "18.2k tok · $0.08",
        sortStartedAt: 100,
      }],
    });
    const unregisterTasks = registerBackgroundWorkProvider({
      ...provider("background-tasks", "Background Tasks", 20, 300, () => undefined),
      listRows: () => [{
        providerId: "background-tasks",
        id: "bg-1",
        name: "watch-pr-14-merge",
        command: "#!/usr/bin/env bash\nset -uo pipefail\ngh pr view 14 --repo 1aboveio/pi-better-harness --json state,mergedAt,mergeCommit,statusCheckRollup",
        status: "failed",
        statusTone: "failed",
        kind: "watch",
        elapsed: "2m 18s",
        primary: "gh pr view",
        sortStartedAt: 300,
      }],
    });

    const widgets: unknown[] = [];
    const ui = {
      factory: undefined as any,
      theme: { fg: (_color: string, value: string) => value },
      setStatus() {},
      setWidget(_key: string, value: unknown) { widgets.push(value); },
      getEditorComponent() { return this.factory; },
      setEditorComponent(factory: any) { this.factory = factory; },
      custom() { return Promise.resolve(null); },
    };
    const ctx = { mode: "tui", hasUI: true, ui } as any;

    try {
      ensureBackgroundWorkNavigator(ctx, {
        createDefaultEditor: () => ({ getText: () => "", handleInput() {} }),
        isOpenTrigger: (data) => data === "left",
        matchKey: (data, key) => data === key,
        truncate: (value, width) => value.slice(0, width),
      });
      const lines = renderWidget(widgets.at(-1), 132, ui.theme);
      const text = lines.join("\n");
      assert.equal(lines[0], "", "background work is separated from the preceding widget");
      for (const line of lines) assert.doesNotMatch(line, /[\r\n]/, "widget rows must not contain embedded newlines");
      assert.ok(text.indexOf("reviewer") < text.indexOf("watch-pr-14-merge"), text);
      assert.doesNotMatch(text, /name\s+model\s+tool\s+tokens\s+status\s+elapsed/, "main list should not render table headers");
      assert.doesNotMatch(text, /command\/tool/, "main list should keep command evidence out of the primary row");
      assert.doesNotMatch(text, /background work/);
      assert.match(text, /^subagents$/m);
      assert.match(text, /^background tasks$/m);
      assert.match(text, /← work navigator/);
      assert.doesNotMatch(text, /shortcuts/);
      assert.match(text, /●\s+reviewer\s+grok-4\.5 high · tool bash · 18\.2k tok/);

      const subagentRow = lines.find((line) => /●\s+reviewer\s+grok-4\.5 high · tool bash · 18\.2k tok/.test(line));
      assert.ok(subagentRow, text);
      assert.ok(subagentRow.startsWith("  ●"), "unselected subagent rows reserve the selection-arrow gutter");
      assert.ok(subagentRow.indexOf("●") < subagentRow.indexOf("reviewer"));
      assert.ok(subagentRow.indexOf("reviewer") < subagentRow.indexOf("grok-4.5 high"));
      assert.ok(subagentRow.indexOf("grok-4.5 high") < subagentRow.indexOf("tool bash"));
      assert.ok(subagentRow.indexOf("tool bash") < subagentRow.indexOf("18.2k tok"));
      assert.ok(subagentRow.indexOf("18.2k tok") < subagentRow.indexOf("1m 04s"));
      assert.match(subagentRow, /reviewer\s{10,}grok-4\.5 high · tool bash · 18\.2k tok/);

      const bgRow = lines.find((line) => /✕\s+watch-pr-14-merge\s+failed, inspect log/.test(line));
      assert.ok(bgRow, text);
      assert.ok(bgRow.startsWith("  ✕"), "unselected background-task rows reserve the selection-arrow gutter");
      assert.doesNotMatch(bgRow, /#!\/usr\/bin\/env bash|pipefail/, "raw command should not dominate the rail row");
      assert.ok(bgRow.indexOf("✕") < bgRow.indexOf("watch-pr-14-merge"));
      assert.ok(bgRow.indexOf("watch-pr-14-merge") < bgRow.indexOf("failed, inspect log"));
      assert.ok(bgRow.indexOf("failed, inspect log") < bgRow.indexOf("2m 18s"));

      const editor = ui.factory({}, {}, {});
      editor.handleInput("left");
      const focusedLines = renderWidget(widgets.at(-1), 132, ui.theme);
      assert.match(focusedLines.join("\n"), /↑↓ switch · Enter detail · x stop · Esc unfocus/);
    } finally {
      if (stdoutColumnsDescriptor) Object.defineProperty(process.stdout, "columns", stdoutColumnsDescriptor);
      else Reflect.deleteProperty(process.stdout, "columns");
      disposeBackgroundWorkNavigator(ctx);
      unregisterSubagents();
      unregisterTasks();
    }
  });

  it("puts unhealthy subagent evidence ahead of model and spend in the work rail", () => {
    const unregister = registerBackgroundWorkProvider({
      ...provider("subagents", "Subagents", 10, 100, () => undefined),
      listRows: () => [{
        providerId: "subagents", id: "sa-failed", name: "reviewer", model: "grok-4.5",
        tokens: "$0.08", status: "failed", statusTone: "failed", kind: "subagent",
        elapsed: "2m", primary: "grok-4.5 · $0.08", facts: ["tool bash exited 1"], sortStartedAt: 100,
      }],
    });
    const widgets: unknown[] = [];
    const ui = {
      theme: { fg: (_color: string, text: string) => text },
      setStatus() {}, setWidget(_key: string, value: unknown) { widgets.push(value); },
      getEditorComponent() { return undefined; }, setEditorComponent() {},
    };
    const ctx = { mode: "tui", hasUI: true, ui } as any;
    try {
      ensureBackgroundWorkNavigator(ctx, {
        createDefaultEditor: () => ({ getText: () => "", handleInput() {} }),
        isOpenTrigger: () => false, matchKey: (data, key) => data === key,
        truncate: (text, width) => text.slice(0, width),
      });
      const text = renderWidget(widgets.at(-1), 100, ui.theme).join("\n");
      assert.match(text, /reviewer\s+failed · tool bash exited 1/);
      assert.doesNotMatch(text, /reviewer\s+grok-4\.5 · \$0\.08/);
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
  });

  it("moves focus in the same order as the rendered provider sections", () => {
    const unregisterSubagents = registerBackgroundWorkProvider({
      ...provider("subagents", "Subagents", 10, 100, () => undefined),
      listRows: () => [{
        providerId: "subagents",
        id: "sa-older",
        name: "reviewer",
        model: "grok-4.5",
        status: "running",
        statusTone: "running",
        kind: "subagent",
        elapsed: "1m 04s",
        primary: "grok-4.5",
        sortStartedAt: 100,
      }],
    });
    const unregisterTasks = registerBackgroundWorkProvider({
      ...provider("background-tasks", "Background Tasks", 20, 300, () => undefined),
      listRows: () => [{
        providerId: "background-tasks",
        id: "bg-newer",
        name: "watch-pr-merge",
        status: "running",
        statusTone: "running",
        kind: "watch",
        elapsed: "22s",
        primary: "gh pr view",
        sortStartedAt: 300,
      }],
    });

    const widgets: unknown[] = [];
    let component: any;
    const ui = {
      factory: undefined as any,
      theme: { fg: (_color: string, value: string) => value },
      setStatus() {},
      setWidget(_key: string, value: unknown) { widgets.push(value); },
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

      const visual = renderWidget(widgets.at(-1), 120, ui.theme).join("\n");
      assert.ok(visual.indexOf("reviewer") < visual.indexOf("watch-pr-merge"), visual);

      const editor = ui.factory({}, {}, {});
      editor.handleInput("left");
      let focused = renderWidget(widgets.at(-1), 120, ui.theme).join("\n");
      assert.match(focused, /^› ●\s+reviewer/m, "initial focus should land on the first visible provider section");
      assert.doesNotMatch(focused, /^› ●\s+watch-pr-merge/m);

      editor.handleInput("down");
      focused = renderWidget(widgets.at(-1), 120, ui.theme).join("\n");
      assert.match(focused, /^› ●\s+watch-pr-merge/m, "down should move to the next visual section");

      editor.handleInput("up");
      editor.handleInput("enter");
      assert.match(component.render(100).join("\n"), /Subagents detail/);
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregisterSubagents();
      unregisterTasks();
    }
  });

  it("selects the main parent row first and Enter returns to the foreground", () => {
    const unregister = registerBackgroundWorkProvider({
      ...provider("subagents", "Subagents", 10, 100, () => undefined),
      parentRow: () => ({
        providerId: "subagents",
        id: "main",
        name: "main",
        model: "gpt-5.6",
        effort: "high",
        tool: "read",
        tokens: "109.3k tok",
        status: "running",
        statusTone: "running",
        kind: "main agent",
        elapsed: "11m 07s",
        primary: "gpt-5.6 high · tool read · 109.3k tok",
        sortStartedAt: 0,
      }),
    });
    const widgets: unknown[] = [];
    let component: any;
    const ui = {
      factory: undefined as any,
      theme: { fg: (_color: string, value: string) => value },
      setStatus() {},
      setWidget(_key: string, value: unknown) { widgets.push(value); },
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

      const list = renderWidget(widgets.at(-1), 120, ui.theme).join("\n");
      assert.match(list, /●\s+main\s+gpt-5\.6 high · tool read · 109\.3k tok/);
      assert.ok(list.indexOf("main") < list.indexOf("Subagents row"), list);

      const editor = ui.factory({}, {}, {});
      editor.handleInput("left");
      const focused = renderWidget(widgets.at(-1), 120, ui.theme).join("\n");
      assert.match(focused, /^› ●\s+main/m, "navigation should start on main");
      editor.handleInput("enter");
      const unfocused = renderWidget(widgets.at(-1), 120, ui.theme).join("\n");
      assert.doesNotMatch(unfocused, /^› /m, "Enter on main returns focus to the foreground");
      assert.equal(component, undefined, "main must not open a detail overlay");

      editor.handleInput("left");
      editor.handleInput("down");
      const subagentFocused = renderWidget(widgets.at(-1), 120, ui.theme).join("\n");
      assert.match(subagentFocused, /^› ●\s+Subagents row/m);
      editor.handleInput("enter");
      const openedComponent: any = component;
      assert.ok(openedComponent, "subagent selection opens its detail overlay");
      assert.match(openedComponent.render(100).join("\n"), /Subagents detail/);
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
  });

  it("keeps the navigator mounted while arrow selection replaces only the content region", () => {
    const unregister = registerBackgroundWorkProvider({
      ...provider("subagents", "Subagents", 10, 100, () => undefined),
      parentRow: () => ({
        providerId: "subagents", id: "main", name: "main", status: "running", statusTone: "running",
        kind: "main agent", elapsed: "1m", primary: "foreground", sortStartedAt: 0,
      }),
      listRows: () => [
        { providerId: "subagents", id: "alpha", name: "alpha", status: "running", statusTone: "running", kind: "subagent", elapsed: "2s", primary: "alpha work", sortStartedAt: 200 },
        { providerId: "subagents", id: "beta", name: "beta", status: "running", statusTone: "running", kind: "subagent", elapsed: "1s", primary: "beta work", sortStartedAt: 100 },
      ],
      detail: (id) => ({
        providerId: "subagents", id, title: `${id} detail`, status: "running", statusTone: "running",
        metadata: [], evidence: { label: "output", text: `${id} content` },
      }),
    });
    const widgets: unknown[] = [];
    let component: any;
    let overlayCloses = 0;
    const ui = {
      factory: undefined as any,
      theme: { fg: (_color: string, value: string) => value },
      setStatus() {},
      setWidget(_key: string, value: unknown) { widgets.push(value); },
      getEditorComponent() { return this.factory; },
      setEditorComponent(factory: any) { this.factory = factory; },
      custom(factory: any) {
        component = factory({ requestRender() {} }, this.theme, {}, () => { overlayCloses += 1; });
        return new Promise(() => undefined);
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
      const installedWidget = widgets.at(-1);
      const widgetCalls = widgets.length;
      const editor = ui.factory({}, {}, {});

      editor.handleInput("left");
      assert.match(renderWidget(installedWidget, 100, ui.theme).join("\n"), /^› ●\s+main/m);

      editor.handleInput("down");
      let detailScreen = component.render(100).join("\n");
      assert.match(detailScreen, /alpha content/);
      assert.match(detailScreen, /subagents/);
      assert.match(detailScreen, /^› ●\s+alpha/m, "the active detail visibly retains the navigation rail");
      assert.match(renderWidget(installedWidget, 100, ui.theme).join("\n"), /^› ●\s+alpha/m);

      component.handleInput("down");
      detailScreen = component.render(100).join("\n");
      assert.match(detailScreen, /beta content/);
      assert.doesNotMatch(detailScreen, /alpha content/);
      assert.match(detailScreen, /^› ●\s+beta/m, "the visible rail follows detail selection");
      assert.match(renderWidget(installedWidget, 100, ui.theme).join("\n"), /^› ●\s+beta/m);

      component.handleInput("up");
      component.handleInput("up");
      assert.equal(overlayCloses, 1, "selecting main closes only the replaceable content overlay");
      assert.match(renderWidget(installedWidget, 100, ui.theme).join("\n"), /^› ●\s+main/m);
      assert.equal(widgets.length, widgetCalls, "the navigator widget remains the same mounted component");
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
  });

  it("hides a provider section when its active-work policy rejects retained rows", () => {
    const unregister = registerBackgroundWorkProvider({
      ...provider("subagents", "Subagents", 10, 100, () => undefined),
      visibleCount: () => 0,
      listRows: () => [{
        providerId: "subagents", id: "finished", name: "finished", status: "completed", statusTone: "success",
        kind: "subagent", elapsed: "1m", primary: "done", sortStartedAt: 100,
      }],
      showSection: (rows) => rows.some((row) => row.status === "running"),
      parentRow: () => ({
        providerId: "subagents", id: "main", name: "main", status: "running", statusTone: "running",
        kind: "main agent", elapsed: "1m", primary: "foreground", sortStartedAt: 0,
      }),
    });
    const widgets: unknown[] = [];
    const ui = {
      factory: undefined as any,
      theme: { fg: (_color: string, value: string) => value },
      setStatus() {},
      setWidget(_key: string, value: unknown) { widgets.push(value); },
      getEditorComponent() { return this.factory; },
      setEditorComponent(factory: any) { this.factory = factory; },
    };
    const ctx = { mode: "tui", hasUI: true, ui } as any;

    try {
      ensureBackgroundWorkNavigator(ctx, {
        createDefaultEditor: () => ({ getText: () => "", handleInput() {} }),
        isOpenTrigger: (data) => data === "left",
        matchKey: (data, key) => data === key,
        truncate: (value, width) => value.slice(0, width),
      });
      assert.equal(widgets.at(-1), undefined, "the section and its main row are hidden without active subagents");
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
  });

  it("renders a single watcher as a compact row until focused", () => {
    const unregister = registerBackgroundWorkProvider({
      ...provider("background-tasks", "Background Tasks", 20, 300, () => undefined),
      listRows: () => [{
        providerId: "background-tasks",
        id: "bg-1",
        name: "watch-ci-1396",
        command: "gh run watch 1396 --exit-status",
        status: "running",
        statusTone: "running",
        kind: "watch",
        elapsed: "23s",
        facts: ["every 1m 00s"],
        primary: "every 1m 00s",
        sortStartedAt: 300,
      }],
    });

    const widgets: unknown[] = [];
    const ui = {
      factory: undefined as any,
      theme: { fg: (_color: string, value: string) => value },
      setStatus() {},
      setWidget(_key: string, value: unknown) { widgets.push(value); },
      getEditorComponent() { return this.factory; },
      setEditorComponent(factory: any) { this.factory = factory; },
      custom() { return Promise.resolve(null); },
    };
    const ctx = { mode: "tui", hasUI: true, ui } as any;

    try {
      ensureBackgroundWorkNavigator(ctx, {
        createDefaultEditor: () => ({ getText: () => "", handleInput() {} }),
        isOpenTrigger: (data) => data === "left",
        matchKey: (data, key) => data === key,
        truncate: (value, width) => value.slice(0, width),
      });

      const lines = renderWidget(widgets.at(-1), 118, ui.theme);
      const text = lines.join("\n");
      assert.doesNotMatch(text, /background work/);
      assert.match(text, /●\s+watch-ci-1396\s+every 1m 00s\s+23s/);
      assert.doesNotMatch(text, /evidence\s+gh run watch 1396/);
      assert.match(text, /^background tasks$/m, "compact rail should keep the provider lane title visible");
      assert.doesNotMatch(text, /^main$/m, "background work is not grouped under a confusing main lane");

      const editor = ui.factory({}, {}, {});
      editor.handleInput("left");
      const focusedText = renderWidget(widgets.at(-1), 118, ui.theme).join("\n");
      assert.match(focusedText, /↑↓ switch · Enter detail · x stop · Esc unfocus/);
      assert.doesNotMatch(focusedText, /evidence\s+gh run watch 1396/);
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
  });

  it("does not render duplicated evidence for a single subagent row", () => {
    const unregister = registerBackgroundWorkProvider({
      ...provider("subagents", "Subagents", 10, 300, () => undefined),
      listRows: () => [{
        providerId: "subagents",
        id: "subagent-1",
        name: "review-545-lifecycle-state-expan",
        model: "gpt-5.5",
        tokens: "8.3k tok (↑6.0k ↓2.3k)",
        status: "completed",
        statusTone: "success",
        kind: "subagent",
        elapsed: "5m 50s",
        primary: "gpt-5.5 · 8.3k tok (↑6.0k ↓2.3k) · $0.1836",
        sortStartedAt: 300,
      }],
    });

    const widgets: unknown[] = [];
    const ui = {
      factory: undefined as any,
      theme: { fg: (_color: string, value: string) => value },
      setStatus() {},
      setWidget(_key: string, value: unknown) { widgets.push(value); },
      getEditorComponent() { return this.factory; },
      setEditorComponent(factory: any) { this.factory = factory; },
      custom() { return Promise.resolve(null); },
    };
    const ctx = { mode: "tui", hasUI: true, ui } as any;

    try {
      ensureBackgroundWorkNavigator(ctx, {
        createDefaultEditor: () => ({ getText: () => "", handleInput() {} }),
        isOpenTrigger: (data) => data === "left",
        matchKey: (data, key) => data === key,
        truncate: (value, width) => value.slice(0, width),
      });

      const text = renderWidget(widgets.at(-1), 132, ui.theme).join("\n");
      assert.match(text, /✓\s+review-545-lifecycle-state-expan/);
      assert.doesNotMatch(text, /evidence\s+gpt-5\.5/);
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
  });

  it("keeps distinct subagent tool evidence out of the compact rail", () => {
    const unregister = registerBackgroundWorkProvider({
      ...provider("subagents", "Subagents", 10, 300, () => undefined),
      listRows: () => [{
        providerId: "subagents",
        id: "subagent-1",
        name: "review-545-lifecycle-state-expan",
        model: "gpt-5.5",
        tokens: "8.3k tok (↑6.0k ↓2.3k)",
        status: "running",
        statusTone: "running",
        kind: "subagent",
        elapsed: "5m 50s",
        primary: "gpt-5.5 · 8.3k tok (↑6.0k ↓2.3k) · $0.1836",
        secondary: "tools bash",
        sortStartedAt: 300,
      }],
    });

    const widgets: unknown[] = [];
    const ui = {
      factory: undefined as any,
      theme: { fg: (_color: string, value: string) => value },
      setStatus() {},
      setWidget(_key: string, value: unknown) { widgets.push(value); },
      getEditorComponent() { return this.factory; },
      setEditorComponent(factory: any) { this.factory = factory; },
      custom() { return Promise.resolve(null); },
    };
    const ctx = { mode: "tui", hasUI: true, ui } as any;

    try {
      ensureBackgroundWorkNavigator(ctx, {
        createDefaultEditor: () => ({ getText: () => "", handleInput() {} }),
        isOpenTrigger: (data) => data === "left",
        matchKey: (data, key) => data === key,
        truncate: (value, width) => value.slice(0, width),
      });

      const text = renderWidget(widgets.at(-1), 132, ui.theme).join("\n");
      assert.match(text, /●\s+review-545-lifecycle-state-expan/);
      assert.doesNotMatch(text, /evidence\s+tools bash/);

      const editor = ui.factory({}, {}, {});
      editor.handleInput("left");
      const focusedText = renderWidget(widgets.at(-1), 132, ui.theme).join("\n");
      assert.match(focusedText, /↑↓ switch · Enter detail · x stop · Esc unfocus/);
      assert.doesNotMatch(focusedText, /evidence\s+tools bash/);
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
  });

  it("opens detail only as an overlay with a 25/10 rolling tail and default-expanded command", () => {
    const detailCalls: Array<number | undefined> = [];
    const unregister = registerBackgroundWorkProvider({
      id: "background-tasks",
      label: "Background Tasks",
      priority: 20,
      visibleCount: () => 1,
      listRows: () => [{
        providerId: "background-tasks",
        id: "bg-1",
        name: "watch-pr-14-merge",
        command: "gh pr view 14 --repo 1aboveio/pi-better-harness --json state,mergedAt,mergeCommit,statusCheckRollup",
        status: "running",
        statusTone: "running",
        kind: "watch",
        elapsed: "2m 18s",
        primary: "gh pr view",
        sortStartedAt: 300,
      }],
      detail: (_id, _now, options) => {
        detailCalls.push(options?.logTailLines);
        return {
          providerId: "background-tasks",
          id: "bg-1",
          title: "watch-pr-14-merge",
          status: "running",
          statusTone: "running",
          metadata: [{ label: "provider", value: "Background Tasks" }],
          foldedSections: [{
            id: "command",
            label: "command",
            text: "gh pr view 14 --repo 1aboveio/pi-better-harness --json state,mergedAt,mergeCommit,statusCheckRollup",
            collapsedText: "#!/usr/bin/env bash\nset -uo pipefail\ngh pr view 14 --repo 1aboveio/pi-better-harness --json state,mergedAt,mergeCommit,statusCheckRollup",
            expandedByDefault: true,
          }],
          evidence: { label: "log tail", text: `latest ${options?.logTailLines ?? 0}` },
          footerActions: ["x stop"],
        };
      },
      armCloseLabel: () => "x again to stop",
      close: (id) => ({ action: "stopped", providerId: "background-tasks", id }),
    });

    let component: any;
    let customOptions: any;
    const widgets: Array<[string, unknown]> = [];
    const ui = {
      factory: undefined as any,
      theme: { fg: (_color: string, value: string) => value },
      setStatus() {},
      setWidget(key: string, value: unknown) { widgets.push([key, value]); },
      getEditorComponent() { return this.factory; },
      setEditorComponent(factory: any) { this.factory = factory; },
      custom(factory: any, options: any) {
        customOptions = options;
        component = factory({ requestRender() {} }, this.theme, {}, () => undefined);
        return Promise.resolve(null);
      },
    };
    const ctx = { mode: "tui", hasUI: true, ui } as any;

    try {
      const nativeEditorLines = ["─".repeat(72), "", "─".repeat(72)];
      ensureBackgroundWorkNavigator(ctx, {
        createDefaultEditor: () => ({ getText: () => "", handleInput() {}, render: () => nativeEditorLines }),
        isOpenTrigger: (data) => data === "left",
        matchKey: (data, key) => data === key,
        truncate: (value, width) => value.slice(0, width),
      });
      const editor = ui.factory({}, {}, {});
      editor.handleInput("left");
      editor.handleInput("enter");

      const overlayOptions = customOptions?.overlayOptions?.();
      const { visible, ...layoutOptions } = overlayOptions;
      const navigatorRows = renderWidget(widgets.at(-1)?.[1], 72, ui.theme).length;
      const bottomMargin = 0;
      assert.equal(customOptions?.overlay, true);
      assert.equal(typeof visible, "function");
      const topMargin = 0;
      assert.equal(visible(120, 40), true);
      assert.deepEqual(layoutOptions, {
        anchor: "top-left",
        width: "100%",
        maxHeight: "100%",
        margin: { top: topMargin, right: 0, bottom: bottomMargin, left: 0 },
      });

      let renderedLines = component.render(72);
      assert.equal(renderedLines.length, 40 - bottomMargin, "detail overlay should own the full terminal height");
      const railStart = renderedLines.length - navigatorRows - nativeEditorLines.length;
      assert.match(renderedLines.slice(railStart, -nativeEditorLines.length).join("\n"), /↑↓ switch/, "the persistent navigator remains above the input");
      assert.doesNotMatch(
        renderedLines.slice(Math.max(0, railStart - 3), railStart).join("\n"),
        /← back|^─+$/m,
        "detail overlay must not add a second bottom footer above the persistent navigator",
      );
      assert.equal(
        renderedLines.filter((line: string) => line === "─".repeat(72)).length,
        2,
        "the full-height overlay must paint exactly one input box",
      );
      assert.deepEqual(renderedLines.slice(-nativeEditorLines.length), nativeEditorLines, "the input box is flush with the bottom of the detail overlay");
      for (const line of renderedLines) assert.doesNotMatch(line, /[\r\n]/, "detail rows must not contain embedded newlines");
      let rendered = renderedLines.join("\n");
      assert.equal(detailCalls.at(-1), 25);
      assert.match(rendered, /log tail · latest 25 rows/);
      assert.match(rendered, /command/);
      assert.match(rendered, /statusCheckRollup/);
      assert.doesNotMatch(rendered, /command.*folded/);

      component.handleInput("l");
      renderedLines = component.render(72);
      rendered = renderedLines.join("\n");
      assert.equal(detailCalls.at(-1), 10);
      assert.match(rendered, /log tail · latest 10 rows/);
      assert.match(rendered, /latest 10/);

      component.handleInput("enter");
      rendered = component.render(120).join("\n");
      assert.match(rendered, /command.*folded/);

      component.handleInput("l");
      assert.equal(detailCalls.at(-1), 25);
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
  });

  it("keeps every metadata line and the newest log rows that fit when the 25-row tail exceeds the terminal height", () => {
    const log = Array.from({ length: 40 }, (_, i) => `log-row-${String(i + 1).padStart(2, "0")}`).join("\n");
    const unregister = registerBackgroundWorkProvider({
      id: "background-tasks",
      label: "Background Tasks",
      priority: 20,
      visibleCount: () => 1,
      listRows: () => [{
        providerId: "background-tasks",
        id: "bg-tall",
        name: "tall-log",
        status: "running",
        statusTone: "running",
        kind: "process",
        elapsed: "1m",
        primary: "npm test",
        sortStartedAt: 300,
      }],
      detail: (_id, _now, options) => ({
        providerId: "background-tasks",
        id: "bg-tall",
        title: "tall-log",
        status: "running",
        statusTone: "running",
        metadata: ["provider", "kind", "elapsed", "cwd", "pid", "pgid"].map((label) => ({ label, value: label })),
        foldedSections: [{ id: "command", label: "command", text: "npm test", expandedByDefault: true }],
        evidence: { label: "log tail", text: log.split("\n").slice(-(options?.logTailLines ?? 10)).join("\n") },
        footerActions: ["x stop"],
      }),
      armCloseLabel: () => "x again to stop",
      close: (id) => ({ action: "stopped", providerId: "background-tasks", id }),
    });

    let component: any;
    let customOptions: any;
    const ui = {
      factory: undefined as any,
      theme: { fg: (_color: string, value: string) => value },
      setStatus() {},
      setWidget() {},
      getEditorComponent() { return this.factory; },
      setEditorComponent(factory: any) { this.factory = factory; },
      custom(factory: any, options: any) {
        customOptions = options;
        component = factory({ requestRender() {} }, this.theme, {}, () => undefined);
        return Promise.resolve(null);
      },
    };
    const ctx = { mode: "tui", hasUI: true, ui } as any;

    try {
      ensureBackgroundWorkNavigator(ctx, {
        createDefaultEditor: () => ({ getText: () => "", handleInput() {}, render: () => ["─".repeat(72), "", "─".repeat(72)] }),
        isOpenTrigger: (data) => data === "left",
        matchKey: (data, key) => data === key,
        truncate: (value, width) => value.slice(0, width),
      });
      const editor = ui.factory({}, {}, {});
      editor.handleInput("left");
      editor.handleInput("enter");
      const assertTail = (height: number, header: RegExp, expectedRows: number) => {
        assert.equal(customOptions?.overlayOptions?.().visible(72, height), true);
        const renderedLines: string[] = component.render(72);
        const rendered = renderedLines.join("\n");
        assert.equal(renderedLines.length, height);
        assert.match(rendered, header);
        for (const label of ["provider", "kind", "elapsed", "cwd", "pid", "pgid"]) {
          assert.match(rendered, new RegExp(`^   ${label}\\s`, "m"), `${label} metadata must stay visible at ${height} rows`);
        }
        const rows = [...rendered.matchAll(/log-row-(\d{2})/g)].map((match) => Number(match[1]));
        const newest = Array.from({ length: expectedRows }, (_, i) => 41 - expectedRows + i);
        assert.deepEqual(rows, newest, `${height}-row terminal shows the newest ${expectedRows} log rows`);
      };

      // Rows left for the tail = height - 16 fixed detail rows (title, actions, status, 6 metadata,
      // command section, blanks, log header) - 7 rail/input rows. The tail size is a cap, not a guarantee.
      assertTail(24, /log tail · latest 25 rows/, 1);
      assertTail(40, /log tail · latest 25 rows/, 17);
      assertTail(60, /log tail · latest 25 rows/, 25);

      component.handleInput("l");
      assertTail(60, /log tail · latest 10 rows/, 10);
      assertTail(24, /log tail · latest 10 rows/, 1);
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
  });

  it("folds output evidence by default and expands it into wrapped rows", () => {
    const output = [
      "The live/current technical partition is `2026-07-26`, so July can only be safely evaluated with production data that has already landed and been reconciled.",
      "row-02 context",
      "row-03 context",
      "row-04 context",
      "row-05 context",
      "row-06 context",
      "row-07 context",
      "row-08 context",
      "row-09 context",
      "row-10 context",
      "row-11 visible after more",
      "row-12 visible after more",
    ].join("\n");
    const unregister = registerBackgroundWorkProvider({
      id: "subagents",
      label: "Subagents",
      priority: 10,
      visibleCount: () => 1,
      listRows: () => [{
        providerId: "subagents",
        id: "sa-1",
        name: "backfill-2025-2026-act",
        model: "gpt-5.5",
        tool: "bash",
        tokens: "27.7k tok",
        status: "running",
        statusTone: "running",
        kind: "subagent",
        elapsed: "52m 29s",
        primary: "bash · 27.7k tok",
        sortStartedAt: 300,
      }],
      detail: () => ({
        providerId: "subagents",
        id: "sa-1",
        title: "backfill-2025-2026-act",
        status: "running",
        statusTone: "running",
        subtitle: "current tool bash",
        metadata: [{ label: "provider", value: "Subagents" }],
        evidence: { label: "output", text: output },
        footerActions: ["x stop"],
      }),
      armCloseLabel: () => "x again to stop",
      close: (id) => ({ action: "stopped", providerId: "subagents", id }),
    });

    let component: any;
    const ui = {
      factory: undefined as any,
      theme: { fg: (_color: string, value: string) => value },
      setStatus() {},
      setWidget() {},
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
      editor.handleInput("enter");

      let renderedLines = component.render(54);
      let rendered = renderedLines.join("\n");
      assert.match(rendered, /Enter expand/);
      assert.match(rendered, /output · folded/);
      assert.match(rendered, /folded/);
      assert.doesNotMatch(rendered, /row-11 visible after more/);

      component.handleInput("enter");
      renderedLines = component.render(54);
      rendered = renderedLines.join("\n");
      assert.match(rendered, /Enter collapse/);
      assert.match(rendered, /output · showing (\d+)\/\1 rows/);
      assert.match(rendered, /July can only be safely\n\s+evaluated/);
      assert.match(rendered, /row-12 visible after more/);
      for (const line of renderedLines) assert.ok(visibleWidth(line) <= 54, `line exceeds width: ${line}`);

      component.handleInput("l");
      rendered = component.render(54).join("\n");
      assert.match(rendered, /output · showing 10\/\d+ rows/);
      assert.doesNotMatch(rendered, /row-11 visible after more/);
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
  });

  it("renders transcript evidence as a latest-25 tail by default", () => {
    const transcript = Array.from({ length: 12 }, (_, i) => `line-${String(i + 1).padStart(2, "0")}`).join("\n");
    const unregister = registerBackgroundWorkProvider({
      id: "subagents",
      label: "Subagents",
      priority: 10,
      visibleCount: () => 1,
      listRows: () => [{
        providerId: "subagents",
        id: "sa-transcript",
        name: "tail-reader",
        status: "running",
        statusTone: "running",
        kind: "subagent",
        elapsed: "10s",
        primary: "subagent run",
        sortStartedAt: 300,
      }],
      detail: () => ({
        providerId: "subagents",
        id: "sa-transcript",
        title: "tail-reader",
        status: "running",
        statusTone: "running",
        metadata: [{ label: "provider", value: "Subagents" }],
        evidence: { label: "transcript", text: transcript },
        footerActions: ["x stop"],
      }),
      armCloseLabel: () => "x again to stop",
      close: (id) => ({ action: "stopped", providerId: "subagents", id }),
    });

    let component: any;
    const ui = {
      factory: undefined as any,
      theme: { fg: (_color: string, value: string) => value },
      setStatus() {},
      setWidget() {},
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
      editor.handleInput("enter");

      let rendered = component.render(80).join("\n");
      assert.doesNotMatch(rendered, /Enter expand|transcript · folded/);
      assert.match(rendered, /transcript · latest 25 rows/);
      assert.match(rendered, /line-01/);
      assert.match(rendered, /line-12/);

      component.handleInput("l");
      rendered = component.render(80).join("\n");
      assert.match(rendered, /transcript · latest 10 rows/);
      assert.doesNotMatch(rendered, /line-01|line-02/);
      assert.match(rendered, /line-03/);
      assert.match(rendered, /line-12/);
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
  });

  it("keeps every metadata line and the newest transcript rows that fit in constrained detail viewports", () => {
    const transcriptRows = Array.from({ length: 30 }, (_, i) => ` transcript-${String(i + 1).padStart(2, "0")}`);
    const unregister = registerBackgroundWorkProvider({
      id: "subagents",
      label: "Subagents",
      priority: 10,
      visibleCount: () => 1,
      listRows: () => [{
        providerId: "subagents",
        id: "sa-structured-transcript",
        name: "structured-tail-reader",
        status: "running",
        statusTone: "running",
        kind: "subagent",
        elapsed: "10s",
        primary: "subagent run",
        sortStartedAt: 300,
      }],
      detail: () => ({
        providerId: "subagents",
        id: "sa-structured-transcript",
        title: "structured-tail-reader",
        status: "running",
        statusTone: "running",
        metadata: [
          { label: "provider", value: "Subagents" },
          { label: "model", value: "gpt-5.5 · effort high" },
          { label: "elapsed", value: "10s" },
          { label: "tools", value: "current read" },
          { label: "spend", value: "1.2k tok" },
          { label: "pid", value: "123" },
          { label: "pgid", value: "123" },
        ],
        evidence: { label: "transcript", text: "fallback should not render" },
        transcript: [],
        footerActions: ["x stop"],
      }),
      armCloseLabel: () => "x again to stop",
      close: (id) => ({ action: "stopped", providerId: "subagents", id }),
    });

    let component: any;
    let customOptions: any;
    const ui = {
      factory: undefined as any,
      theme: { fg: (_color: string, value: string) => value },
      setStatus() {},
      setWidget() {},
      getEditorComponent() { return this.factory; },
      setEditorComponent(factory: any) { this.factory = factory; },
      custom(factory: any, options: any) {
        customOptions = options;
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
        createTranscriptComponent: () => ({ render: () => transcriptRows, invalidate() {} }),
      });
      ensureBackgroundWorkNavigator(ctx, {
        createDefaultEditor: () => ({ getText: () => "", handleInput() {} }),
        isOpenTrigger: (data) => data === "left",
        matchKey: (data, key) => data === key,
        truncate: (value, width) => value.slice(0, width),
      });
      const editor = ui.factory({}, {}, {});
      editor.handleInput("left");
      editor.handleInput("enter");
      const visible = customOptions?.overlayOptions?.().visible;
      assert.equal(typeof visible, "function");
      assert.equal(visible(80, 24), true);

      const metadataLabels = ["provider", "model", "elapsed", "tools", "spend", "pid", "pgid"];
      const assertTail = (height: number, header: RegExp, expectedRows: number) => {
        assert.equal(visible(80, height), true);
        const renderedLines: string[] = component.render(80);
        const rendered = renderedLines.join("\n");
        assert.equal(renderedLines.length, height);
        assert.match(rendered, header);
        assert.doesNotMatch(rendered, /fallback should not render/);
        for (const label of metadataLabels) {
          assert.match(rendered, new RegExp(`^   ${label}\\s`, "m"), `${label} metadata must stay visible at ${height} rows`);
        }
        const rows = [...rendered.matchAll(/transcript-(\d{2})/g)].map((match) => Number(match[1]));
        const newest = Array.from({ length: expectedRows }, (_, i) => 31 - expectedRows + i);
        assert.deepEqual(rows, newest, `${height}-row terminal shows the newest ${expectedRows} transcript rows`);
      };

      // Rows left for the tail = height - 14 fixed detail rows (title, actions, status, 7 metadata,
      // blanks, section header) - 7 rail/input rows. The tail size is a cap, not a guarantee.
      assertTail(24, /transcript · latest 25 rows/, 3);
      assertTail(40, /transcript · latest 25 rows/, 19);
      assertTail(60, /transcript · latest 25 rows/, 25);

      component.handleInput("l");
      assertTail(60, /transcript · latest 10 rows/, 10);
      assertTail(24, /transcript · latest 10 rows/, 3);
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
  });

  it("keeps CJK task titles within the terminal column limit", () => {
    const taskProvider = provider("background-tasks", "Background Tasks", 20, 300, () => undefined);
    const unregister = registerBackgroundWorkProvider({
      ...taskProvider,
      listRows: () => taskProvider.listRows(0).map((row) => ({
        ...row,
        name: "检查后台任务的运行状态和日志输出".repeat(3),
      })),
    });
    const widgets: unknown[] = [];
    const ui = {
      factory: undefined as any,
      theme: { fg: (_color: string, value: string) => value },
      setStatus() {},
      setWidget(_key: string, value: unknown) { widgets.push(value); },
      getEditorComponent() { return this.factory; },
      setEditorComponent(factory: any) { this.factory = factory; },
      custom() { return Promise.resolve(null); },
    };
    const ctx = { mode: "tui", hasUI: true, ui } as any;
    try {
      ensureBackgroundWorkNavigator(ctx, {
        createDefaultEditor: () => ({ getText: () => "", handleInput() {} }),
        isOpenTrigger: (data) => data === "left",
        matchKey: (data, key) => data === key,
        truncate: truncateToWidth,
      });
      for (const width of [40, 80, 132]) {
        const lines = renderWidget(widgets.at(-1), width, ui.theme);
        assert.match(lines.join("\n"), /检查/);
        for (const line of lines) {
          assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} columns exceed ${width}: ${line}`);
        }
      }
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
  });

  it("wraps Unicode log rows without losing text or splitting graphemes", () => {
    for (const source of [
      "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳",
      "abc中文👩‍💻e\u0301🇨🇳".repeat(4),
      "\u001b[31m甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳\u001b[0m",
    ]) {
      for (const width of [8, 9, 14, 20]) {
        const rows = wrapLogText(source, width);
        assert.equal(rows.join(""), source);
        for (const row of rows) assert.ok(visibleWidth(row) <= width, JSON.stringify({ row, width }));
        const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
        assert.deepEqual(
          rows.flatMap((row) => [...segmenter.segment(row)].map(({ segment }) => segment)),
          [...segmenter.segment(source)].map(({ segment }) => segment),
        );
      }
    }
  });

  it("wraps deeply indented CJK logs with room for a full character", () => {
    const content = "甲乙丙丁戊己庚辛壬癸";
    const rows = wrapLogText(" ".repeat(12) + content, 8);
    assert.equal(rows.map((row) => row.trimStart()).join(""), content);
    assert.ok(rows.every((row) => visibleWidth(row) <= 8), rows.join("\n"));
  });

  it("wraps tool-call log rows without truncating long paths", () => {
    const path = "/Users/exoulster/projects/pi-better-harness/packages/pi-better-subagents/shared-navigator.ts";
    const source = `tool read {\"path\":\"${path}\",\"offset\":880}`;
    const rows = wrapLogText(source, 32);

    assert.ok(rows.length > 2, rows.join("\n"));
    assert.ok(rows.every((row) => row.length <= 32), rows.join("\n"));
    assert.equal(rows.join("").replace(/\s+/g, ""), source.replace(/\s+/g, ""));
    assert.match(rows.join(""), /shared-navigator\.ts/);
  });

  it("keeps a closed detail's keyboard out of a hidden list: opens the next row's detail, then hands focus back", () => {
    const live = new Set(["alpha", "beta", "gamma"]);
    const closed: string[] = [];
    const unregister = registerBackgroundWorkProvider({
      ...provider("subagents", "Subagents", 10, 100, () => undefined),
      parentRow: () => ({
        providerId: "subagents", id: "main", name: "main", status: "running", statusTone: "running",
        kind: "main agent", elapsed: "1m", primary: "foreground", sortStartedAt: 0,
      }),
      listRows: () => ["alpha", "beta", "gamma"].filter((id) => live.has(id)).map((id, i) => ({
        providerId: "subagents", id, name: id, status: "running", statusTone: "running" as const,
        kind: "subagent", elapsed: "1s", primary: `${id} work`, sortStartedAt: 300 - i,
      })),
      detail: (id) => ({
        providerId: "subagents", id, title: `${id} detail`, status: "running", statusTone: "running",
        metadata: [], evidence: { label: "output", text: `${id} content` },
      }),
      close: (id) => {
        closed.push(id);
        live.delete(id);
        return { action: "stopped", providerId: "subagents", id, status: "cancelled" };
      },
    });
    const widgets: unknown[] = [];
    let component: any;
    let overlayCloses = 0;
    const typed: string[] = [];
    const ui = {
      factory: undefined as any,
      theme: { fg: (_color: string, value: string) => value },
      setStatus() {},
      setWidget(_key: string, value: unknown) { widgets.push(value); },
      getEditorComponent() { return this.factory; },
      setEditorComponent(factory: any) { this.factory = factory; },
      custom(factory: any) {
        component = factory({ requestRender() {} }, this.theme, {}, () => { overlayCloses += 1; });
        return new Promise(() => undefined);
      },
    };
    const ctx = { mode: "tui", hasUI: true, ui } as any;

    try {
      ensureBackgroundWorkNavigator(ctx, {
        createDefaultEditor: () => ({ getText: () => "", handleInput(data: string) { typed.push(data); } }),
        isOpenTrigger: (data) => data === "left",
        matchKey: (data, key) => data === key,
        truncate: (value, width) => value.slice(0, width),
      });
      const editor = ui.factory({}, {}, {});
      editor.handleInput("left");
      editor.handleInput("down");
      editor.handleInput("down");
      assert.match(component.render(100).join("\n"), /beta content/);

      // Closing the middle row opens the next row below it.
      component.handleInput("x");
      component.handleInput("x");
      assert.deepEqual(closed, ["beta"]);
      let screen = component.render(100).join("\n");
      assert.match(screen, /gamma content/, "the next row's detail replaces the closed one");
      assert.doesNotMatch(screen, /Work · |↑↓ select/, "no list-mode overlay remains after a confirmed close");
      assert.match(renderWidget(widgets.at(-1), 100, ui.theme).join("\n"), /^› ●\s+gamma/m);
      assert.equal(overlayCloses, 0);

      // Closing the last row falls back to the previous one.
      component.handleInput("x");
      component.handleInput("x");
      assert.deepEqual(closed, ["beta", "gamma"]);
      screen = component.render(100).join("\n");
      assert.match(screen, /alpha content/, "with nothing below, the previous row's detail opens");
      assert.doesNotMatch(screen, /Work · |↑↓ select/);

      // Closing the only remaining row closes the overlay and returns keys to the editor.
      component.handleInput("x");
      component.handleInput("x");
      assert.deepEqual(closed, ["beta", "gamma", "alpha"]);
      assert.equal(overlayCloses, 1, "no closable row remains, so the overlay closes");
      assert.doesNotMatch(renderWidget(widgets.at(-1), 100, ui.theme).join("\n"), /^› /m, "the rail is unfocused");
      for (const key of ["h", "x", "i"]) editor.handleInput(key);
      assert.deepEqual(typed, ["h", "x", "i"], "typed text reaches the editor after the close");
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
  });

  it("keeps expanded output within the detail viewport and counts only the rows it shows", () => {
    const output = Array.from({ length: 40 }, (_, i) => `out-row-${String(i + 1).padStart(2, "0")}`).join("\n");
    const unregister = registerBackgroundWorkProvider({
      ...provider("subagents", "Subagents", 10, 100, () => undefined),
      detail: (id) => ({
        providerId: "subagents", id, title: "expanded output", status: "running", statusTone: "running",
        metadata: [{ label: "provider", value: "Subagents" }],
        evidence: { label: "output", text: output },
      }),
    });
    let component: any;
    let customOptions: any;
    const ui = {
      factory: undefined as any,
      theme: { fg: (_color: string, value: string) => value },
      setStatus() {},
      setWidget() {},
      getEditorComponent() { return this.factory; },
      setEditorComponent(factory: any) { this.factory = factory; },
      custom(factory: any, options: any) {
        customOptions = options;
        component = factory({ requestRender() {} }, this.theme, {}, () => undefined);
        return Promise.resolve(null);
      },
    };
    const ctx = { mode: "tui", hasUI: true, ui } as any;

    try {
      ensureBackgroundWorkNavigator(ctx, {
        createDefaultEditor: () => ({ getText: () => "", handleInput() {}, render: () => ["─".repeat(72), "", "─".repeat(72)] }),
        isOpenTrigger: (data) => data === "left",
        matchKey: (data, key) => data === key,
        truncate: (value, width) => value.slice(0, width),
      });
      const editor = ui.factory({}, {}, {});
      editor.handleInput("left");
      editor.handleInput("enter");
      component.handleInput("enter");
      for (const height of [20, 24, 60]) {
        assert.equal(customOptions.overlayOptions().visible(72, height), true);
        const lines: string[] = component.render(72);
        const rendered = lines.join("\n");
        assert.equal(lines.length, height, `${height}-row terminal`);
        const header = rendered.match(/output · showing (\d+)\/40 rows/);
        assert.ok(header, rendered);
        const rows = [...rendered.matchAll(/out-row-(\d{2})/g)].map((match) => Number(match[1]));
        assert.equal(rows.length, Number(header[1]), `${height}-row terminal: the header counts only visible rows`);
        assert.deepEqual(rows, Array.from({ length: rows.length }, (_, i) => i + 1), "rows start from the head");
        assert.ok(rows.length <= 25);
      }
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
  });

  it("never renders more lines than a terminal shorter than the rail and editor", () => {
    const unregister = registerBackgroundWorkProvider(provider("subagents", "Subagents", 10, 100, () => undefined));
    let component: any;
    let customOptions: any;
    const ui = {
      factory: undefined as any,
      theme: { fg: (_color: string, value: string) => value },
      setStatus() {},
      setWidget() {},
      getEditorComponent() { return this.factory; },
      setEditorComponent(factory: any) { this.factory = factory; },
      custom(factory: any, options: any) {
        customOptions = options;
        component = factory({ requestRender() {} }, this.theme, {}, () => undefined);
        return Promise.resolve(null);
      },
    };
    const ctx = { mode: "tui", hasUI: true, ui } as any;

    try {
      ensureBackgroundWorkNavigator(ctx, {
        createDefaultEditor: () => ({ getText: () => "", handleInput() {}, render: () => ["─".repeat(60), "", "─".repeat(60)] }),
        isOpenTrigger: (data) => data === "left",
        matchKey: (data, key) => data === key,
        truncate: (value, width) => value.slice(0, width),
      });
      const editor = ui.factory({}, {}, {});
      editor.handleInput("left");
      editor.handleInput("enter");
      for (let height = 3; height <= 12; height += 1) {
        customOptions.overlayOptions().visible(60, height);
        const lines: string[] = component.render(60);
        assert.ok(lines.length <= height, `${height}-row terminal rendered ${lines.length} lines`);
        assert.match(lines.at(-1) ?? "", /^─+$/, `${height}-row terminal keeps the input frame at the bottom`);
      }
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
  });

  it("reuses the mounted detail overlay when the main list moves while it is unfocused", () => {
    const unregister = registerBackgroundWorkProvider({
      ...provider("subagents", "Subagents", 10, 100, () => undefined),
      parentRow: () => ({
        providerId: "subagents", id: "main", name: "main", status: "running", statusTone: "running",
        kind: "main agent", elapsed: "1m", primary: "foreground", sortStartedAt: 0,
      }),
      listRows: () => ["alpha", "beta", "gamma"].map((id, i) => ({
        providerId: "subagents", id, name: id, status: "running", statusTone: "running" as const,
        kind: "subagent", elapsed: "1s", primary: `${id} work`, sortStartedAt: 300 - i,
      })),
      detail: (id) => ({
        providerId: "subagents", id, title: `${id} detail`, status: "running", statusTone: "running",
        metadata: [], evidence: { label: "output", text: `${id} content` },
      }),
    });
    const mounted: any[] = [];
    let focusCalls = 0;
    const unfocusTargets: unknown[] = [];
    const typed: string[] = [];
    const ui = {
      factory: undefined as any,
      theme: { fg: (_color: string, value: string) => value },
      setStatus() {},
      setWidget() {},
      getEditorComponent() { return this.factory; },
      setEditorComponent(factory: any) { this.factory = factory; },
      custom(factory: any, options: any) {
        let component: any;
        component = factory({ requestRender() {} }, this.theme, {}, () => {
          mounted.splice(mounted.indexOf(component), 1);
        });
        mounted.push(component);
        options?.onHandle?.({
          focus() { focusCalls += 1; },
          unfocus(unfocusOptions?: { target: unknown }) { unfocusTargets.push(unfocusOptions?.target); },
        });
        return new Promise(() => undefined);
      },
    };
    const ctx = { mode: "tui", hasUI: true, ui } as any;

    try {
      ensureBackgroundWorkNavigator(ctx, {
        createDefaultEditor: () => ({ getText: () => "", handleInput(data: string) { typed.push(data); } }),
        isOpenTrigger: (data) => data === "left",
        matchKey: (data, key) => data === key,
        truncate: (value, width) => value.slice(0, width),
      });
      const editor = ui.factory({}, {}, {});
      editor.handleInput("left");
      editor.handleInput("down");
      assert.equal(mounted.length, 1);
      assert.match(mounted[0].render(100).join("\n"), /alpha content/);

      // Another extension re-installed the editor: Pi mounts a new instance with focus
      // while the overlay stays mounted.
      const swapped = ui.factory({}, {}, {});
      assert.notEqual(swapped, editor);
      swapped.handleInput("down");
      swapped.handleInput("down");
      assert.equal(mounted.length, 1, "exactly one overlay stays mounted");
      assert.equal(focusCalls, 2, "the mounted overlay takes focus back");
      const screen = mounted[0].render(100).join("\n");
      assert.match(screen, /gamma content/);
      assert.equal(screen.match(/━━ \w+ detail/g)?.length, 1, `no stale detail header remains:\n${screen}`);

      mounted[0].handleInput("escape");
      assert.equal(mounted.length, 0, "Esc closes the navigator");
      assert.deepEqual(unfocusTargets, [swapped], "focus goes to the live editor, not the unmounted one Pi remembered");
      swapped.handleInput("h");
      assert.deepEqual(typed, ["h"], "keys reach the editor again");

      // A stale overlay also goes away when the editor-side main list is left with Esc.
      swapped.handleInput("left");
      swapped.handleInput("down");
      assert.equal(mounted.length, 1);
      swapped.handleInput("escape");
      assert.equal(mounted.length, 0);
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
  });

  it("lets Esc close a mounted overlay that lost focus after every row disappeared", () => {
    let rows = ["alpha"];
    const unregister = registerBackgroundWorkProvider({
      ...provider("subagents", "Subagents", 10, 100, () => undefined),
      visibleCount: () => rows.length,
      listRows: () => rows.map((id) => ({
        providerId: "subagents", id, name: id, status: "running", statusTone: "running" as const,
        kind: "subagent", elapsed: "1s", primary: `${id} work`, sortStartedAt: 300,
      })),
    });
    let mounted = 0;
    const typed: string[] = [];
    const ui = {
      factory: undefined as any,
      theme: { fg: (_color: string, value: string) => value },
      setStatus() {},
      setWidget() {},
      getEditorComponent() { return this.factory; },
      setEditorComponent(factory: any) { this.factory = factory; },
      custom(factory: any) {
        mounted += 1;
        factory({ requestRender() {} }, this.theme, {}, () => { mounted -= 1; });
        return new Promise(() => undefined);
      },
    };
    const ctx = { mode: "tui", hasUI: true, ui } as any;
    try {
      ensureBackgroundWorkNavigator(ctx, {
        createDefaultEditor: () => ({ getText: () => "", handleInput(data: string) { typed.push(data); } }),
        isOpenTrigger: (data) => data === "left",
        matchKey: (data, key) => data === key,
        truncate: (value, width) => value.slice(0, width),
      });
      const editor = ui.factory({}, {}, {});
      editor.handleInput("left");
      editor.handleInput("enter");
      assert.equal(mounted, 1);
      rows = [];
      editor.handleInput("escape");
      assert.equal(mounted, 0, "Esc closes the stale overlay even with no rows left");
      editor.handleInput("escape");
      assert.deepEqual(typed, ["escape"], "with no overlay, Esc goes to the editor as before");
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
  });

  it("closes the detail overlay when another extension replaces the editor, and never hands focus to the unmounted wrapper", async () => {
    const unregister = registerBackgroundWorkProvider({
      ...provider("subagents", "Subagents", 10, 100, () => undefined),
      listRows: () => ["alpha", "beta"].map((id, i) => ({
        providerId: "subagents", id, name: id, status: "running", statusTone: "running" as const,
        kind: "subagent", elapsed: "1s", primary: `${id} work`, sortStartedAt: 300 - i,
      })),
    });
    const mounted: any[] = [];
    const unfocusTargets: unknown[] = [];
    const widgets: unknown[] = [];
    // pi-tui's view: what the editor container holds, and whether a component is in the tree.
    let editorSlot: any;
    const tui = {
      requestRender() {},
      isComponentMounted(component: unknown) { return component === editorSlot; },
    };
    const ui = {
      factory: undefined as any,
      theme: { fg: (_color: string, value: string) => value },
      setStatus() {},
      setWidget(_key: string, widget: unknown) { widgets.push(widget); },
      getEditorComponent() { return this.factory; },
      // Pi's setCustomEditorComponent: build the new editor and mount it in place of the old one.
      setEditorComponent(factory: any) {
        this.factory = factory;
        editorSlot = factory ? factory(tui, {}, {}) : { render: () => ["default editor"], handleInput() {} };
      },
      custom(factory: any, options: any) {
        let component: any;
        component = factory(tui, this.theme, {}, () => { mounted.splice(mounted.indexOf(component), 1); });
        mounted.push(component);
        options?.onHandle?.({ focus() {}, unfocus(unfocusOptions?: { target: unknown }) { unfocusTargets.push(unfocusOptions?.target); } });
        return new Promise(() => undefined);
      },
    };
    const ctx = { mode: "tui", hasUI: true, ui } as any;
    /** One pi-tui frame: the base (editor included) renders first, then the overlays. */
    const frame = () => { editorSlot?.render?.(100); for (const overlay of [...mounted]) overlay.render(100); };
    const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));
    try {
      ensureBackgroundWorkNavigator(ctx, {
        createDefaultEditor: () => ({ getText: () => "", render: () => ["our editor"], handleInput() {} }),
        isOpenTrigger: (data) => data === "left",
        matchKey: (data, key) => data === key,
        truncate: (value, width) => value.slice(0, width),
      });
      editorSlot = ui.factory(tui, {}, {});
      const ours = editorSlot;
      ours.handleInput("left");
      ours.handleInput("down");
      assert.equal(mounted.length, 1);
      frame(); frame(); await settle();
      assert.equal(mounted.length, 1, "the overlay stays while our editor is on screen");

      // An extension that composes the editor inside its own (non-container) component keeps ours
      // rendering and receiving keys: the overlay stays.
      const inner = ui.factory;
      ui.setEditorComponent((t: any, th: any, kb: any) => {
        const wrapped = inner(t, th, kb);
        return { render: (width: number) => wrapped.render(width), handleInput: (data: string) => wrapped.handleInput(data) };
      });
      frame(); frame(); await settle();
      assert.equal(mounted.length, 1, "a composed editor still shows ours");
      editorSlot.handleInput("escape");
      assert.equal(mounted.length, 0);

      // Reopen, then an extension replaces the editor outright (Pi's default here).
      editorSlot.handleInput("left");
      editorSlot.handleInput("down");
      assert.equal(mounted.length, 1);
      frame();
      ui.setEditorComponent(undefined);
      frame(); frame(); await settle();
      assert.equal(mounted.length, 0, "the overlay closes instead of covering the replacement editor");
      assert.deepEqual(unfocusTargets, [], "focus is never handed to an unmounted wrapper");
      assert.doesNotMatch(renderWidget(widgets.at(-1), 100, ui.theme).join("\n"), /^› /m, "the rail is unfocused");
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
  });
});
