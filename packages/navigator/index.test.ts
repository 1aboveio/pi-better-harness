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
      assert.equal(statuses.at(-1)?.[1], "← background work · 2");
      assert.equal(ui.factory.__piBetterHarnessNavigatorFactory, true);

      let list = renderWidget(widgets.at(-1)?.[1], 120, ui.theme).join("\n");
      assert.match(list, /background work/);
      assert.match(list, /Subagents row/);
      assert.match(list, /Background Tasks row/);
      assert.match(list, /<- to navigate/);
      assert.doesNotMatch(list, /── background tasks/);

      const editor = ui.factory({}, {}, {});
      editor.handleInput("left");
      assert.equal(widgets.at(-1)?.[0], MAIN_LIST_WIDGET_KEY);
      list = renderWidget(widgets.at(-1)?.[1], 120, ui.theme).join("\n");
      assert.match(list, /↑↓ select · Enter detail · x stop · Esc unfocus/);

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

      assert.deepEqual(statuses.at(-1), [NAVIGATOR_STATUS_KEY, "← background work · 1"]);
    } finally {
      disposeBackgroundWorkNavigator(tuiCtx);
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
      assert.match(renderedWidget, /failed/);
      assert.match(renderedWidget, /lost/);
      assert.doesNotMatch(renderedWidget, /^background tasks$/m, "single-provider rail should not render a redundant provider header");
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
      assert.match(text, /▸ background work\s+1 running · 1 failed/);
      assert.match(text, /subagents/);
      assert.match(text, /background tasks/);
      assert.match(text, /<- to navigate/);
      assert.match(text, /◌\s+reviewer\s+18\.2k tok/);

      const subagentRow = lines.find((line) => /◌\s+reviewer\s+18\.2k tok/.test(line));
      assert.ok(subagentRow, text);
      assert.ok(subagentRow.indexOf("◌") < subagentRow.indexOf("reviewer"));
      assert.ok(subagentRow.indexOf("reviewer") < subagentRow.indexOf("18.2k tok"));
      assert.ok(subagentRow.indexOf("18.2k tok") < subagentRow.indexOf("1m 04s"));

      const bgRow = lines.find((line) => /✕\s+watch-pr-14-merge\s+condition failed/.test(line));
      assert.ok(bgRow, text);
      assert.doesNotMatch(bgRow, /#!\/usr\/bin\/env bash|pipefail/, "raw command should not dominate the rail row");
      assert.ok(bgRow.indexOf("✕") < bgRow.indexOf("watch-pr-14-merge"));
      assert.ok(bgRow.indexOf("watch-pr-14-merge") < bgRow.indexOf("condition failed"));
      assert.ok(bgRow.indexOf("condition failed") < bgRow.indexOf("2m 18s"));

      const editor = ui.factory({}, {}, {});
      editor.handleInput("left");
      const focusedLines = renderWidget(widgets.at(-1), 132, ui.theme);
      assert.match(focusedLines.join("\n"), /↑↓ select · Enter detail · x stop · Esc unfocus/);
    } finally {
      if (stdoutColumnsDescriptor) Object.defineProperty(process.stdout, "columns", stdoutColumnsDescriptor);
      else Reflect.deleteProperty(process.stdout, "columns");
      disposeBackgroundWorkNavigator(ctx);
      unregisterSubagents();
      unregisterTasks();
    }
  });

  it("renders a single watcher with prototype-style strip, glyph row, and subordinate evidence", () => {
    const unregister = registerBackgroundWorkProvider({
      ...provider("background-tasks", "Background Tasks", 20, 300, () => undefined),
      listRows: () => [{
        providerId: "background-tasks",
        id: "bg-1",
        name: "watch-pr-1396",
        command: "node ~/.agents/skills/mergify/scripts/watch-pr-delivery.mjs --repo 1aboveio/skyee-ai-risk --pr 1396",
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
      assert.match(text, /▸ background work\s+1 running/);
      assert.match(text, /◌\s+watch-pr-1396\s+every 1m 00s\s+23s/);
      assert.match(text, /evidence\s+node ~\/\.agents\/skills\/mergify\/scripts\/watch-pr-delivery\.mjs/);
      assert.doesNotMatch(text, /^background tasks$/m, "single-provider rail should not render a redundant provider header");
      assert.doesNotMatch(text, /^main$/m, "background work is not grouped under a confusing main lane");
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
  });

  it("opens detail only as an overlay with a rolling tail size and folded command", () => {
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
      const bottomMargin = 3 + navigatorRows;
      assert.equal(customOptions?.overlay, true);
      assert.equal(typeof visible, "function");
      const topMargin = 5;
      assert.equal(visible(120, 40), true);
      assert.deepEqual(layoutOptions, {
        anchor: "top-left",
        width: "100%",
        maxHeight: "100%",
        margin: { top: topMargin, right: 0, bottom: bottomMargin, left: 0 },
      });

      let renderedLines = component.render(72);
      assert.equal(renderedLines.length, 40 - topMargin - bottomMargin, "detail overlay should fill the rows between header and navigator");
      for (const line of renderedLines) assert.doesNotMatch(line, /[\r\n]/, "detail rows must not contain embedded newlines");
      let rendered = renderedLines.join("\n");
      assert.equal(detailCalls.at(-1), 10);
      assert.match(rendered, /log tail · latest 10 rows/);
      assert.match(rendered, /command\s+#!\/usr\/bin\/env bash/);
      assert.match(rendered, /folded/);
      assert.doesNotMatch(rendered, /statusCheckRollup/);

      component.handleInput("]");
      renderedLines = component.render(72);
      rendered = renderedLines.join("\n");
      assert.equal(detailCalls.at(-1), 25);
      assert.match(rendered, /log tail · latest 25 rows/);
      assert.match(rendered, /latest 25/);

      component.handleInput("enter");
      rendered = component.render(120).join("\n");
      assert.match(rendered, /statusCheckRollup/);
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

      component.handleInput("]");
      rendered = component.render(54).join("\n");
      assert.match(rendered, /output · showing \d+\/\d+ rows/);
      assert.match(rendered, /row-11 visible after more/);
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregister();
    }
  });
});
