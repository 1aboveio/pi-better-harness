import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "./index.js";
import { createBackgroundTaskRuntime } from "./runtime.js";
import { createFailureAttention } from "./failures.js";
import { getCallbackBatcher } from "./shared-callback-batcher.js";
import { readMeta, taskDir } from "./registry.js";
import { registerBackgroundWorkProvider, disposeBackgroundWorkNavigator, type BackgroundWorkProvider } from "./shared-navigator.ts";

// Deliberately import once: SDK extension factories share this cached module.
function host() {
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  const tools = new Map<string, any>();
  const pi = {
    on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    events: { on() {}, emit() {} },
    sendMessage: vi.fn(), sendUserMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  return { pi, tools, async emit(name: string, ctx: ExtensionContext) {
    for (const fn of handlers.get(name) ?? []) await fn({}, ctx);
  } };
}
const ids: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const id of ids.splice(0)) rmSync(taskDir(id), { recursive: true, force: true });
});
function ctx(id: string, ui?: any): ExtensionContext {
  return { cwd: process.cwd(), mode: ui ? "tui" : "rpc", hasUI: Boolean(ui), ui,
    sessionManager: { getSessionId: () => id }, isIdle: () => true } as unknown as ExtensionContext;
}
function ui() { return { setStatus: vi.fn(), setWidget: vi.fn(), setEditorComponent: vi.fn() }; }
const globalState = () => (globalThis as any)[Symbol.for("pi-better-harness.navigator.state")];

describe("cached extension factory lifecycle", () => {
  it("child shutdown leaves the parent's tool watch and navigator owner intact", async () => {
    const parent = host(), child = host();
    extension(parent.pi);
    extension(child.pi);
    const parentCtx = ctx("cached-parent", ui()), childCtx = ctx("cached-child");
    await parent.emit("session_start", parentCtx);
    const state = globalState();
    const provider = state.providers.get("background-tasks");
    expect(provider).toBeDefined();
    await child.emit("session_start", childCtx);
    await child.emit("session_before_switch", childCtx);
    await child.emit("session_shutdown", childCtx);
    expect(state.providers.get("background-tasks")).toBe(provider);
    expect(state.uiCtx).toBe(parentCtx);
    const result = await parent.tools.get("bg_task_watch").execute("watch", {
      command: "printf ready", callback: false, success_when: { type: "exit_code", equals: 0 },
    }, undefined, undefined, parentCtx);
    expect(result.content[0].text).toContain("succeeded");
    const rows = provider.listRows(Date.now());
    expect(rows).toHaveLength(1);
    ids.push(rows[0].id);
    await parent.emit("session_shutdown", parentCtx);
    expect(state.providers.has("background-tasks")).toBe(false);
    expect(state.uiCtx).toBeUndefined();
  });

  it("child shutdown does not starve a parent's terminal callback", async () => {
    const parent = host(), child = host();
    extension(parent.pi);
    extension(child.pi);
    const parentCtx = ctx("callback-parent"), childCtx = ctx("callback-child");
    await parent.emit("session_start", parentCtx);
    await child.emit("session_start", childCtx);
    const result = await parent.tools.get("bg_task_spawn").execute("spawn", {
      command: "sleep 0.1; printf complete", callback: true,
    }, undefined, undefined, parentCtx);
    const id = result.content[0].text.match(/bg_[A-Za-z0-9_]+/)?.[0];
    expect(id).toBeDefined();
    ids.push(id!);
    await child.emit("session_shutdown", childCtx);
    await vi.waitFor(() => expect(readMeta(id!)?.status).toBe("succeeded"));
    await getCallbackBatcher(parent.pi).flush();
    expect(parent.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(readMeta(id!)?.callbackSentAt).toBeTypeOf("number");
    expect(readMeta(id!)?.callbackSuppressedAt).toBeUndefined();
    await parent.emit("session_shutdown", parentCtx);
  });

  it("stale TUI factory shutdown cannot dispose its replacement sharing the same UI", async () => {
    const stale = host(), current = host();
    extension(stale.pi);
    extension(current.pi);
    const sharedUi = ui();
    const staleCtx = ctx("old-factory", sharedUi), currentCtx = ctx("new-factory", sharedUi);
    await stale.emit("session_start", staleCtx);
    await current.emit("session_start", currentCtx);
    const provider = globalState().providers.get("background-tasks");
    await stale.emit("session_shutdown", staleCtx);
    expect(globalState().uiCtx).toBe(currentCtx);
    expect(globalState().providers.get("background-tasks")).toBe(provider);
    await current.emit("session_shutdown", currentCtx);
    expect(globalState().uiCtx).toBeUndefined();
  });

  it("one runtime suspension does not settle another runtime's first-check waiters", async () => {
    const parent = createBackgroundTaskRuntime(), child = createBackgroundTaskRuntime();
    const pi = host().pi;
    const task = parent.startWatchTask(pi, { command: "printf ready", callback: false,
      success_when: { type: "exit_code", equals: 0 } }, process.cwd());
    ids.push(task.id);
    child.suspendScheduledWork();
    const first = await parent.awaitFirstWatchCheck(task.id, 3000);
    expect(first).toMatchObject({ exitCode: 0 });
    expect(readMeta(task.id)?.status).toBe("succeeded");
    parent.suspendScheduledWork();
  });

  it("failure attention retry timers are scoped and suspension clears only its own timers", () => {
    vi.useFakeTimers();
    const parent = createFailureAttention(), child = createFailureAttention();
    const pi = host().pi;
    parent.scheduleFailureAttention(pi, "nonexistent-parent");
    child.scheduleFailureAttention(pi, "nonexistent-child");
    expect(vi.getTimerCount()).toBe(2);
    child.suspendFailureAttention();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(vi.getTimerCount()).toBe(1);
    parent.suspendFailureAttention();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stale unregister tokens cannot remove a newer registration of the same object", () => {
    const provider = { id: "cached-token-test", label: "test", priority: 0, visibleCount: () => 0,
      listRows: () => [], detail: () => null, armCloseLabel: () => "close",
      close: (id: string) => ({ action: "missing", providerId: "cached-token-test", id }),
      onVisibleChanged: () => vi.fn() } satisfies BackgroundWorkProvider;
    const stale = registerBackgroundWorkProvider(provider);
    const current = registerBackgroundWorkProvider(provider);
    stale();
    expect(globalState().providers.get(provider.id)).toBe(provider);
    current();
    expect(globalState().providers.has(provider.id)).toBe(false);
  });

  it("headless and stale UI contexts cannot dispose the active navigator", async () => {
    const parent = host();
    extension(parent.pi);
    const active = ctx("navigator-active", ui());
    await parent.emit("session_start", active);
    disposeBackgroundWorkNavigator(ctx("headless"));
    disposeBackgroundWorkNavigator(ctx("old-ui", ui()));
    expect(globalState().uiCtx).toBe(active);
    await parent.emit("session_shutdown", active);
    expect(globalState().uiCtx).toBeUndefined();
  });
});
