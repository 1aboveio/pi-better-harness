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

describe("shared background work navigator", () => {
  it("uses one footer/editor host for multiple providers and dispatches close by provider", () => {
    const closed: string[] = [];
    const unregisterSubagents = registerBackgroundWorkProvider(provider("subagents", "Subagents", 10, 200, (id) => closed.push(`subagents:${id}`)));
    const unregisterTasks = registerBackgroundWorkProvider(provider("background-tasks", "Background Tasks", 20, 100, (id) => closed.push(`tasks:${id}`)));

    const statuses: Array<[string, string | undefined]> = [];
    const widgets: Array<[string, string[] | undefined]> = [];
    let component: any;
    const ui = {
      factory: undefined as any,
      theme: { fg: (_color: string, value: string) => value },
      setStatus(key: string, value: string | undefined) { statuses.push([key, value]); },
      setWidget(key: string, value: string[] | undefined) { widgets.push([key, value]); },
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
      assert.equal(widgets.at(-1)?.[0], MAIN_LIST_WIDGET_KEY);
      const list = widgets.at(-1)?.[1]?.join("\n") ?? "";
      assert.match(list, /background work/);
      assert.match(list, /subagents/);
      assert.match(list, /background tasks/);

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
    const widgets: Array<string[] | undefined> = [];
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
      setWidget(_key: string, value: string[] | undefined) { widgets.push(value); },
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

      const renderedWidget = widgets.at(-1)?.join("\n") ?? "";
      assert.match(renderedWidget, /failed/);
      assert.match(renderedWidget, /lost/);

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

  it("groups the main list by provider and hides model columns for background tasks", () => {
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

    const widgets: Array<string[] | undefined> = [];
    const ui = {
      factory: undefined as any,
      theme: { fg: (_color: string, value: string) => value },
      setStatus() {},
      setWidget(_key: string, value: string[] | undefined) { widgets.push(value); },
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
      const lines = widgets.at(-1) ?? [];
      const text = lines.join("\n");
      for (const line of lines) assert.doesNotMatch(line, /[\r\n]/, "widget rows must not contain embedded newlines");
      assert.ok(text.indexOf("subagents") < text.indexOf("background tasks"), text);
      assert.match(text, /name\s+model\s+tool\s+tokens\s+status\s+elapsed/);
      assert.match(text, /reviewer\s+grok-4\.5 high\s+bash\s+18\.2k tok/);

      const subagentHeader = lines.find((line) => /name\s+model\s+tool\s+tokens\s+status\s+elapsed/.test(line));
      const subagentRow = lines.find((line) => /reviewer\s+grok-4\.5 high/.test(line));
      assert.ok(subagentHeader, text);
      assert.ok(subagentRow, text);
      assert.equal(subagentHeader.indexOf("name"), subagentRow.indexOf("reviewer"));
      assert.equal(subagentHeader.indexOf("model"), subagentRow.indexOf("grok-4.5 high"));
      assert.equal(subagentHeader.indexOf("tool"), subagentRow.indexOf("bash"));
      assert.equal(subagentHeader.indexOf("tokens"), subagentRow.indexOf("18.2k tok"));
      assert.equal(subagentHeader.indexOf("status"), subagentRow.indexOf("running"));
      assert.equal(subagentHeader.indexOf("elapsed"), subagentRow.indexOf("1m 04s"));

      const bgHeaderIndex = lines.findIndex((line) => /command\/tool/.test(line));
      assert.ok(bgHeaderIndex >= 0, text);
      assert.doesNotMatch(lines[bgHeaderIndex]!, /model|tokens/);
      assert.match(text, /watch-pr-14-merge\s+#!\/usr\/bin\/env bash/);
      assert.doesNotMatch(text, /pipefail\s+failed\s+2m 18s/);
      const bgHeader = lines[bgHeaderIndex]!;
      const bgRow = lines.find((line) => /watch-pr-14-merge\s+#!\/usr\/bin\/env bash/.test(line));
      assert.ok(bgRow, text);
      assert.equal(bgHeader.indexOf("name"), bgRow.indexOf("watch-pr-14-merge"));
      assert.equal(bgHeader.indexOf("command/tool"), bgRow.indexOf("#!/usr/bin/env bash"));
      assert.equal(bgHeader.indexOf("status"), bgRow.indexOf("failed"));
      assert.equal(bgHeader.indexOf("elapsed"), bgRow.indexOf("2m 18s"));
    } finally {
      disposeBackgroundWorkNavigator(ctx);
      unregisterSubagents();
      unregisterTasks();
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
    const widgets: Array<[string, string[] | undefined]> = [];
    const ui = {
      factory: undefined as any,
      theme: { fg: (_color: string, value: string) => value },
      setStatus() {},
      setWidget(key: string, value: string[] | undefined) { widgets.push([key, value]); },
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
      assert.equal(customOptions?.overlay, true);
      assert.deepEqual(overlayOptions, {
        anchor: "top-left",
        width: "100%",
        maxHeight: "100%",
        margin: { top: 1, right: 0, bottom: 3 + (widgets.at(-1)?.[1]?.length ?? 0), left: 0 },
      });

      let renderedLines = component.render(72);
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
});
