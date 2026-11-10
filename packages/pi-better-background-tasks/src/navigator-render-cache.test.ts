import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createBackgroundTasksNavigator } from "./navigator-provider.js";
import { createObservedWaitHost, getObservedWaitHost } from "./observed-waits.js";
import { openStore } from "./shared-operation-coordinator/index.js";
import type { BackgroundWorkRow } from "./shared-navigator.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const navigatorState = () => (globalThis as any)[Symbol.for("pi-better-harness.navigator.state")];

describe("background-work navigator projection cache", () => {
  it("reuses unchanged durable rows across panel redraws without reading unrelated history", async () => {
    const root = mkdtempSync(join(tmpdir(), "navigator-render-cache-"));
    const events = new EventEmitter();
    const pi = {
      events,
      on() { return () => {}; },
      registerTool() {},
    } as unknown as ExtensionAPI;
    const host = createObservedWaitHost(pi, {
      storePath: join(root, "operations.sqlite"),
      supervisorDirectory: join(root, "supervisor"),
      pollMs: 0,
    });
    const ui = {
      setStatus() {},
      setWidget() {},
      setEditorComponent() {},
      theme: { fg: (_color: string, text: string) => text },
    };
    const ctx = {
      cwd: root,
      mode: "tui",
      hasUI: true,
      ui,
      sessionManager: { getSessionId: () => "current-session", getBranch: () => [] },
      isIdle: () => true,
    } as unknown as ExtensionContext;
    const navigator = createBackgroundTasksNavigator({ stopTask: async () => undefined } as any);
    cleanups.push(() => {
      navigator.clearBackgroundTasksNavigatorSession();
      host.close();
      events.removeAllListeners();
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    host.start(ctx);
    const store = openStore({ path: join(root, "operations.sqlite") });
    try {
      for (let index = 0; index < 3_140; index += 1) {
        store.registerOperation({
          operationId: `op-history-${index}`,
          taskId: `bgs_${index.toString(16).padStart(20, "0")}`,
          launchToken: `launch_history_${index}`,
          owner: {
            kind: "parent-session",
            sessionId: `historical-session-${index % 37}`,
            workspace: root,
            branchId: `branch-${index % 5}`,
            goalId: null,
          },
          observer: { kind: "background-tasks", version: "1" },
        });
      }
      for (let index = 0; index < 3; index += 1) {
        store.registerOperation({
          operationId: `op-current-${index}`,
          taskId: `bgs_${(0x100000 + index).toString(16).padStart(20, "0")}`,
          launchToken: `launch_current_${index}`,
          owner: { kind: "parent-session", sessionId: "current-session", workspace: root, branchId: "main", goalId: null },
          observer: { kind: "background-tasks", version: "1" },
        });
      }
    } finally {
      store.close();
    }

    navigator.ensureBackgroundTasksNavigatorProvider(pi);
    navigator.ensureBackgroundTasksNavigator(ctx);
    const provider = navigatorState().providers.get("background-tasks");
    expect(provider).toBeDefined();
    expect(getObservedWaitHost(pi)).toBe(host);

    // Installing the navigator already warmed the projection. That one read saw
    // only the three current-session rows, never the 3,140 historical rows.
    const warm = host.getDurableProjectionMetrics();
    expect(warm.queries).toBe(1);
    expect(warm.rowsRead).toBe(3);
    expect(warm.projectionsBuilt).toBe(3);
    const now = Date.now();
    const first = provider.listRows(now) as BackgroundWorkRow[];
    expect(first).toHaveLength(3);

    host.resetDurableProjectionMetrics();
    for (let redraw = 0; redraw < 20; redraw += 1) {
      const rows = provider.listRows(now) as BackgroundWorkRow[];
      expect(rows).toHaveLength(3);
      // The navigator maps cached tasks to the same row objects inside the
      // one-second elapsed-text window instead of rebuilding every row.
      expect(rows[0]).toBe(first[0]);
    }
    expect(host.getDurableProjectionMetrics()).toEqual({
      listCalls: 20,
      queries: 0,
      rowsRead: 0,
      projectionsBuilt: 0,
      cacheHits: 20,
    });
  }, 120_000);
});
