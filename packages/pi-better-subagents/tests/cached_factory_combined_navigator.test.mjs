/**
 * Cached-factory navigator ownership across two extensions (#460).
 *
 * A headless child Pi process loads the SAME cached extension modules as its
 * parent TUI process. Both Subagents and Background Tasks publish rows into one
 * shared background-work navigator, and both used to call
 * `disposeBackgroundWorkNavigator()` with no owner. A headless child's
 * `session_before_switch` then cleared the parent's navigator, widget and
 * editor wrapper, and the parent silently lost `← background work`.
 *
 * This suite drives the real Subagents and Background Tasks extension factories
 * twice each — once as the parent TUI session, once as a headless child session
 * — and proves the child's lifecycle events leave the parent's navigator, its
 * providers, and its live tool watch untouched.
 *
 * // @covers navigator.factory-ownership
 * // @level integration
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register(new URL("./pi_host_stub_hooks.mjs", import.meta.url));

const tempDir = mkdtempSync(join(tmpdir(), "cached-factory-combined-"));
process.env.TMPDIR = tempDir;

const { default: betterSubagents } = await import("../index.ts");
const { default: backgroundTasksExtension } = await import("../../pi-better-background-tasks/src/index.ts");
const { setConfigPathForTests, setConfigForTests } = await import("../config.ts");
const { logPathFor, runDir, writeMeta } = await import("../registry.ts");

after(() => {
    setConfigPathForTests(undefined);
    setConfigForTests(undefined);
    rmSync(tempDir, { recursive: true, force: true });
});

const NAVIGATOR_STATE = Symbol.for("pi-better-harness.navigator.state");
const navigatorState = () => globalThis[NAVIGATOR_STATE];

/** One Pi host: a cached extension factory instance, its events, and its session. */
function host() {
    const handlers = new Map();
    const tools = new Map();
    const listeners = new Map();
    const events = {
        on(name, listener) {
            listeners.set(name, [...(listeners.get(name) ?? []), listener]);
            return () => {
                listeners.set(name, (listeners.get(name) ?? []).filter((entry) => entry !== listener));
            };
        },
        emit(name, payload) {
            for (const listener of listeners.get(name) ?? []) listener(payload);
        },
    };
    const pi = {
        events,
        on(event, handler) {
            handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        },
        registerTool(tool) { tools.set(tool.name, tool); },
        registerCommand() {},
        appendEntry() {},
        sendMessage() { return Promise.resolve(); },
        sendUserMessage() { return Promise.resolve(); },
    };
    return {
        pi,
        tools,
        listeners,
        async emit(name, payload, ctx) {
            for (const handler of handlers.get(name) ?? []) await handler(payload, ctx);
        },
    };
}

/** A TUI session and a headless child session never share a UI object. */
function tuiContext() {
    const widget = { installed: undefined };
    const ui = {
        factory: undefined,
        theme: { fg: (_color, value) => value },
        statuses: [],
        setStatus(key, value) { this.statuses.push([key, value]); },
        setWidget(key, value) { if (key === "background-work-list" && typeof value === "function") widget.installed = value; },
        getEditorComponent() { return this.factory; },
        setEditorComponent(factory) { this.factory = factory; },
        custom() { return Promise.resolve(null); },
        notify() {},
    };
    return {
        ui,
        widget,
        ctx: {
            cwd: tempDir,
            mode: "tui",
            hasUI: true,
            ui,
            isIdle: () => true,
            model: { provider: "test", id: "test" },
            thinkingLevel: "high",
            getContextUsage: () => ({ tokens: 1_000, contextWindow: 200_000, percent: 0.5 }),
            sessionManager: { getSessionId: () => "cached-parent", getBranch: () => [{ id: "branch-parent" }] },
        },
    };
}

function headlessChildContext() {
    return {
        cwd: tempDir,
        mode: "rpc",
        hasUI: false,
        ui: { setStatus() {}, setWidget() {}, notify() {} },
        isIdle: () => true,
        sessionManager: { getSessionId: () => "cached-child", getBranch: () => [{ id: "branch-child" }] },
    };
}

function registerCombined(pi) {
    betterSubagents(pi);
    backgroundTasksExtension(pi);
}

test("a headless child sharing cached Subagents and Background Tasks factories cannot dispose the parent's navigator", async () => {
    const parent = host();
    const child = host();
    registerCombined(parent.pi);
    registerCombined(child.pi);

    const parentSession = tuiContext();
    const childSession = headlessChildContext();
    assert.equal(navigatorState()?.uiCtx, undefined, "no TUI session owns the shared navigator yet");

    try {
        await parent.emit("session_start", { type: "session_start" }, parentSession.ctx);
        const parentState = navigatorState();
        assert.equal(parentState?.uiCtx, parentSession.ctx, "the parent TUI session owns the navigator");
        assert.equal(typeof parentSession.ui.factory, "function", "the parent installs the ← editor wrapper");
        assert.deepEqual(
            [...parentState.providers.keys()].sort(),
            ["background-tasks", "subagents"],
            "both extensions publish rows into the one shared navigator",
        );

        // The headless child runs the same cached modules and the same lifecycle.
        await child.emit("session_start", { type: "session_start" }, childSession);
        await child.emit("session_before_switch", {}, childSession);
        await child.emit("session_shutdown", { reason: "switch" }, childSession);

        assert.equal(navigatorState().uiCtx, parentSession.ctx, "the headless child must not clear the parent's navigator");
        assert.equal(typeof parentSession.ui.factory, "function", "the parent's editor wrapper survives the child");
        assert.deepEqual(
            [...navigatorState().providers.keys()].sort(),
            ["background-tasks", "subagents"],
            "the child's shutdown must not unregister the parent's providers",
        );

        // The parent's editor wrapper is still mounted and still owns the keys.
        const editor = parentSession.ui.factory({}, parentSession.ui.theme, {});
        assert.equal(typeof editor.handleInput, "function", "the parent's editor wrapper survives the child");

        // The parent's tools still work: a child teardown must not starve the parent.
        const spawn = await parent.tools.get("bg_task_spawn").execute("spawn", {
            name: "parent-still-running",
            shell: false,
            argv: [process.execPath, "-e", "setTimeout(() => {}, 5_000)"],
            callback: false,
        }, undefined, undefined, parentSession.ctx);
        const id = spawn.content[0].text.match(/bgs_[0-9a-f]{20}/)?.[0];
        assert.ok(id, spawn.content[0].text);

        const listed = await parent.tools.get("bg_task_list").execute("list", {}, undefined, undefined, parentSession.ctx);
        assert.match(listed.content[0].text, /parent-still-running/, "the parent's own list still reports its task");

        // A launch by the parent installs its main-list widget through the same
        // factory-owned navigator the child left alone.
        assert.equal(typeof parentSession.widget.installed, "function", "the parent's main-list widget is installed for its live row");
        const rail = parentSession.widget.installed({ requestRender() {} }, parentSession.ui.theme).render(160).join("\n");
        assert.match(rail, /parent-still-running/);
        assert.match(rail, /← work navigator/);

        const stop = await parent.tools.get("bg_task_stop").execute("stop", { id }, undefined, undefined, parentSession.ctx);
        assert.match(stop.content[0].text, /cancelled/);
    } finally {
        await parent.emit("session_shutdown", { reason: "quit" }, parentSession.ctx);
    }

    assert.equal(navigatorState()?.uiCtx, undefined, "the owning factory still releases its own navigator");
    // Background Tasks unregisters with its session; Subagents keeps its provider
    // across reloads by design, so a replacement session reuses the same row source.
    assert.equal(navigatorState()?.providers.has("background-tasks"), false);
});