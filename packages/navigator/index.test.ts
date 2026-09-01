import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLOSE_CONFIRM_STATUS_KEY,
  MAIN_LIST_WIDGET_KEY,
  NAVIGATOR_STATUS_KEY,
  disposeBackgroundWorkNavigator,
  ensureBackgroundWorkNavigator,
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
      assert.equal(statuses.at(-1)?.[1], "← navigate · 2");
      assert.equal(ui.factory.__piBetterHarnessNavigatorFactory, true);

      let list = renderWidget(widgets.at(-1)?.[1], 120, ui.theme).join("\n");
      assert.doesNotMatch(list, /background work/);
      assert.match(list, /Subagents row/);
      assert.match(list, /Background Tasks row/);
      assert.match(list, /← to navigate/);
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

      assert.deepEqual(statuses.at(-1), [NAVIGATOR_STATUS_KEY, "← navigate · 1"]);
    } finally {
      disposeBackgroundWorkNavigator(tuiCtx);
      unregister();
    }
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

      assert.doesNotThrow(() => component.render(100));
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
      for (const line of lines) assert.doesNotMatch(line, /[\r\n]/, "widget rows must not contain embedded newlines");
      assert.ok(text.indexOf("reviewer") < text.indexOf("watch-pr-14-merge"), text);
      assert.doesNotMatch(text, /name\s+model\s+tool\s+tokens\s+status\s+elapsed/, "main list should not render table headers");
      assert.doesNotMatch(text, /command\/tool/, "main list should keep command evidence out of the primary row");
      assert.doesNotMatch(text, /background work/);
      assert.match(text, /^subagents$/m);
      assert.match(text, /^background tasks$/m);
      assert.match(text, /← to navigate/);
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

  it("opens detail only as an overlay with a 10/25 rolling tail and default-expanded command", () => {
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
      ensureBackgroundWorkNavigator(ctx, {
        createDefaultEditor: () => ({ getText: () => "", handleInput() {} }),
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
      const bottomMargin = 3;
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
      assert.equal(renderedLines.length, 40 - bottomMargin, "detail overlay should own the full terminal height above the native footer");
      const railStart = renderedLines.length - navigatorRows - 3;
      assert.match(renderedLines.slice(railStart, -3).join("\n"), /↑↓ switch/, "the persistent navigator remains above the input");
      assert.doesNotMatch(
        renderedLines.slice(Math.max(0, railStart - 3), railStart).join("\n"),
        /← back|^─+$/m,
        "detail overlay must not add a second bottom footer above the persistent navigator",
      );
      assert.deepEqual(renderedLines.slice(-3), ["─".repeat(72), "", "─".repeat(72)], "the detail screen retains the three-row input box");
      for (const line of renderedLines) assert.doesNotMatch(line, /[\r\n]/, "detail rows must not contain embedded newlines");
      let rendered = renderedLines.join("\n");
      assert.equal(detailCalls.at(-1), 10);
      assert.match(rendered, /log tail · latest 10 rows/);
      assert.match(rendered, /command/);
      assert.match(rendered, /statusCheckRollup/);
      assert.doesNotMatch(rendered, /command.*folded/);

      component.handleInput("l");
      renderedLines = component.render(72);
      rendered = renderedLines.join("\n");
      assert.equal(detailCalls.at(-1), 25);
      assert.match(rendered, /log tail · latest 25 rows/);
      assert.match(rendered, /latest 25/);

      component.handleInput("enter");
      rendered = component.render(120).join("\n");
      assert.match(rendered, /command.*folded/);

      component.handleInput("l");
      assert.equal(detailCalls.at(-1), 10);
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
      assert.match(rendered, /output · showing 10\/\d+ rows/);
      assert.match(rendered, /July can only be safely\n\s+evaluated/);
      assert.doesNotMatch(rendered, /row-11 visible after more/);
      for (const line of renderedLines) assert.ok(line.length <= 54, `line exceeds width: ${line}`);

      component.handleInput("l");
      rendered = component.render(54).join("\n");
      assert.match(rendered, /output · showing \d+\/\d+ rows/);
      assert.match(rendered, /row-11 visible after more/);
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
  });

  it("renders transcript evidence as a latest-10 tail by default", () => {
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
      assert.match(rendered, /transcript · latest 10 rows/);
      assert.doesNotMatch(rendered, /line-01|line-02/);
      assert.match(rendered, /line-03/);
      assert.match(rendered, /line-12/);

      component.handleInput("l");
      rendered = component.render(80).join("\n");
      assert.match(rendered, /transcript · latest 25 rows/);
      assert.match(rendered, /line-01/);
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
  });

  it("tails structured transcript component rows with the same 10/25 control", () => {
    const transcriptRows = Array.from({ length: 12 }, (_, i) => ` transcript-${String(i + 1).padStart(2, "0")}`);
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
        metadata: [{ label: "provider", value: "Subagents" }],
        evidence: { label: "transcript", text: "fallback should not render" },
        transcript: [],
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
        createTranscriptComponent: () => ({ render: () => transcriptRows, invalidate() {} }),
      });
      const editor = ui.factory({}, {}, {});
      editor.handleInput("left");
      editor.handleInput("enter");

      let rendered = component.render(80).join("\n");
      assert.match(rendered, /transcript · latest 10 rows/);
      assert.doesNotMatch(rendered, /transcript-01|transcript-02|fallback should not render/);
      assert.match(rendered, /transcript-03/);
      assert.match(rendered, /transcript-12/);

      component.handleInput("l");
      rendered = component.render(80).join("\n");
      assert.match(rendered, /transcript · latest 25 rows/);
      assert.match(rendered, /transcript-01/);
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
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
});
