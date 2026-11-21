import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "./index.js";
import { createBackgroundTaskRuntime } from "./runtime.js";
import { createFailureAttention } from "./failures.js";
import { readMeta, taskDir } from "./registry.js";
import { registerBackgroundWorkProvider, disposeBackgroundWorkNavigator, type BackgroundWorkProvider } from "./shared-navigator.ts";
import { registerTools } from "./tools.js";
import type { BackgroundTaskMeta } from "./types.js";
import { startWorkRuntime } from "./test-support/work-runtime.js";
import { nativeBackground } from "./test-support/native-background.js";

// Exercise the canonical daemon, not a cold pinned-runtime installation, in
// the unchanged five-second factory lifecycle budget.
let stopRuntime: (() => Promise<void>) | undefined;
beforeAll(async () => { stopRuntime = await startWorkRuntime(); });
afterAll(async () => { await stopRuntime?.(); });

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
    const parent = await nativeBackground({ sessionId: "cached-parent" });
    let child: Awaited<ReturnType<typeof nativeBackground>> | undefined;
    let parentClosed = false;
    try {
      await parent.session.bindExtensions({ mode: "tui", uiContext: {
        ...parent.session.extensionRunner!.getUIContext(), ...ui(),
      } });
      const state = globalState(), parentCtx = state.uiCtx;
      const provider = state.providers.get("background-tasks");
      expect(provider).toBeDefined();
      child = await nativeBackground({ sessionId: "cached-child" });
      await child.session.extensionRunner!.emit({ type: "session_before_switch" } as any);
      await child.close(); child = undefined;
      expect(state.providers.get("background-tasks")).toBe(provider);
      expect(state.uiCtx).toBe(parentCtx);
      const result = await parent.execute("bg_task_watch", {
        command: "printf ready", callback: false, success_when: { type: "exit_code", equals: 0 },
      });
      const id = result.match(/bgs_[0-9a-f]{20}/)?.[0];
      expect(id).toBeDefined();
      await vi.waitFor(async () => {
        expect(await parent.execute("bg_task_status", { id })).toContain("succeeded");
        expect(provider.listRows(Date.now()).map((row: { id: string }) => row.id)).toContain(id);
      }, { timeout: 15_000, interval: 100 });
      await parent.close(); parentClosed = true;
      expect(state.providers.has("background-tasks")).toBe(false);
      expect(state.uiCtx).toBeUndefined();
    } finally { await child?.close(); if (!parentClosed) await parent.close(); }
  }, 20_000);

  it("child shutdown does not starve a parent's terminal callback", async () => {
    const deliveries: any[] = [];
    const parent = await nativeBackground({ sessionId: "callback-parent", decorate(api) {
      return new Proxy(api, { get(target, key) {
        if (key === "sendMessage") return (message: any, options: any) => {
          deliveries.push(message); return target.sendMessage(message, options);
        };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } });
    } });
    let child: Awaited<ReturnType<typeof nativeBackground>> | undefined;
    try {
      child = await nativeBackground({ sessionId: "callback-child" });
      const result = await parent.execute("bg_task_spawn", {
        name: "callback-parent-task", shell: false,
        argv: [process.execPath, "-e", "setTimeout(() => {}, 50)"], callback: true,
      });
      const id = result.match(/bgs_[0-9a-f]{20}/)?.[0]; expect(id).toBeDefined();
      await child.close(); child = undefined;
      await vi.waitFor(() => expect(deliveries.filter(message =>
        message.customType === "background-completion-batch" && String(message.content).includes(id!))).toHaveLength(1),
      { timeout: 15_000, interval: 100 });
      expect(parent.manager.getBranch().some((entry: any) =>
        entry.message?.customType === "background-completion-batch" || entry.customType === "background-completion-batch")).toBe(true);
    } finally { await child?.close(); await parent.close(); }
  }, 20_000);

  it("reopens an old owed callback beyond UI retention and receipts the actual native transcript once", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bg-old-recipient-"));
    const sessionFile = join(cwd, "recipient.jsonl");
    const original = await nativeBackground({ cwd, sessionId: "old-native-owner" });
    let originalClosed = false;
    let reopened: Awaited<ReturnType<typeof nativeBackground>> | undefined;
    let foreign: Awaited<ReturnType<typeof nativeBackground>> | undefined;
    const deliveries: any[] = [];
    const capture = (api: any) => new Proxy(api, { get(target, key) {
      if (key === "sendMessage") return (message: any, options: any) => { deliveries.push(message); return target.sendMessage(message, options); };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    const db = new DatabaseSync(join(process.env.PI_CODING_AGENT_DIR!, "operation-coordinator.sqlite"));
    try {
      original.manager.appendCustomEntry("saved-native-anchor", {});
      const launched = await original.execute("bg_task_spawn", { name: "old owed callback", shell: false,
        argv: [process.execPath, "-e", "setTimeout(() => {}, 1000)"], callback: true });
      const id = launched.match(/bgs_[0-9a-f]{20}/)?.[0]; expect(id).toBeDefined();
      writeFileSync(sessionFile, [original.manager.getHeader(), ...original.manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
      await original.close(); originalClosed = true;
      await vi.waitFor(() => expect(db.prepare("SELECT terminal_revision FROM operations WHERE task_id=?").get(id)?.terminal_revision).toBe(1), { timeout: 15000, interval: 50 });
      const operation = db.prepare("SELECT operation_id FROM operations WHERE task_id=?").get(id);
      const grant = JSON.parse(db.prepare("SELECT value FROM coordinator_state WHERE key=?").get(`result-supervision-v1:${operation.operation_id}`).value);
      const resultPath = join(grant.directory, "tasks", id!, "result.json");
      const result = JSON.parse(readFileSync(resultPath, "utf8"));
      // Move both canonical terminal timestamps beyond retention without waiting
      // a minute; runner completion, native disconnect and receipt remain real.
      const old = Date.now() - 60000;
      writeFileSync(resultPath, JSON.stringify({ ...result, endedAt: old }));
      db.prepare("UPDATE operations SET terminal_at=? WHERE task_id=?").run(old, id);
      foreign = await nativeBackground({ cwd, sessionId: "foreign-native-owner", decorate: capture });
      await foreign.execute("bg_task_list", {});
      expect(deliveries).toHaveLength(0);
      await foreign.close(); foreign = undefined;
      reopened = await nativeBackground({ cwd, sessionFile, decorate: capture });
      await vi.waitFor(() => expect(deliveries.filter(message => message.customType === "background-completion-batch" && String(message.content).includes(id!))).toHaveLength(1), { timeout: 15000, interval: 50 });
      expect(reopened.manager.getBranch().some((entry: any) => entry.message?.customType === "background-completion-batch" || entry.customType === "background-completion-batch")).toBe(true);
      await vi.waitFor(() => expect(db.prepare("SELECT 1 FROM background_parent_callbacks WHERE operation_id=?").get(operation.operation_id)).toBeUndefined());
      await reopened.close(); reopened = undefined;
      reopened = await nativeBackground({ cwd, sessionFile, decorate: capture });
      await reopened.execute("bg_task_list", {});
      expect(deliveries.filter(message => message.customType === "background-completion-batch")).toHaveLength(1);
    } finally { db.close(); await foreign?.close(); await reopened?.close(); if (!originalClosed) await original.close(); rmSync(cwd, { recursive: true, force: true }); }
  }, 20000);

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

  it("batch launches use the factory runtime instead of the default singleton", async () => {
    const { pi, tools } = host();
    const spawned: Array<{ id: string; name?: string; batchId?: string }> = [];
    const spawnTask = vi.fn((_pi: ExtensionAPI, params: { name?: string; batchId?: string }) => {
      const meta = {
        id: `bg_injected_${spawned.length + 1}`, kind: "process", status: "running",
        startedAt: Date.now(), logPath: "/dev/null", cwd: process.cwd(),
        name: params.name, batchId: params.batchId,
      } as unknown as BackgroundTaskMeta;
      spawned.push({ id: meta.id, name: meta.name, batchId: meta.batchId });
      return meta;
    });
    const runtime = {
      awaitFirstWatchCheck: vi.fn(), resumeRunningTask: vi.fn(), spawnTask,
      startWatchTask: vi.fn(), stopTask: vi.fn(),
    };
    registerTools(pi, runtime, vi.fn());

    const result = await tools.get("bg_task_spawn_batch").execute("batch", {
      batchName: "factory batch",
      shared: { shell: false },
      jobs: [
        { name: "one", argv: [process.execPath, "-e", "true"] },
        { name: "two", argv: [process.execPath, "-e", "true"] },
      ],
    }, undefined, undefined, ctx("batch-factory", ui()));

    expect(spawnTask).toHaveBeenCalledTimes(2);
    expect(spawned.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "bg_injected_1", name: "one" },
      { id: "bg_injected_2", name: "two" },
    ]);
    expect(new Set(spawned.map((job) => job.batchId)).size).toBe(1);
    expect(result.content[0].text).toContain("bg_injected_1");
    expect(result.content[0].text).toContain("bg_injected_2");
    // A real singleton launch would have written registry metadata or returned a
    // different id; the injected runtime owns both jobs instead.
    expect(readMeta("bg_injected_1")).toBeUndefined();
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
