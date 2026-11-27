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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startWorkRuntimeFixture } from "./work-runtime-fixture.mjs";

const { nativeBackground } = await import("../../pi-better-background-tasks/src/test-support/native-background.ts");
const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme("dark", false);

const tempDir = mkdtempSync(join(tmpdir(), "cached-factory-combined-"));
process.env.TMPDIR = tempDir;
const stopRuntime = await startWorkRuntimeFixture();

const { default: betterSubagents } = await import("../index.ts");
const { default: backgroundTasksExtension } = await import("../../pi-better-background-tasks/src/index.ts");
const { setConfigPathForTests, setConfigForTests } = await import("../config.ts");
const { logPathFor, runDir, writeMeta } = await import("../registry.ts");

after(async () => {
    await stopRuntime();
    setConfigPathForTests(undefined);
    setConfigForTests(undefined);
    rmSync(tempDir, { recursive: true, force: true });
});

const NAVIGATOR_STATE = Symbol.for("pi-better-harness.navigator.state");
const navigatorState = () => globalThis[NAVIGATOR_STATE];

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

    };
}

function registerCombined(pi) {
    betterSubagents(pi);
    backgroundTasksExtension(pi);
}

test("a headless child sharing cached Subagents and Background Tasks factories cannot dispose the parent's navigator", async () => {
    const parent = await nativeBackground({ cwd: tempDir, sessionId: "cached-parent", factory: registerCombined });
    let child;

    const parentSession = tuiContext();
    assert.equal(navigatorState()?.uiCtx, undefined, "no TUI session owns the shared navigator yet");

    try {
        await parent.session.bindExtensions({ mode: "tui", uiContext: { ...parent.session.extensionRunner.getUIContext(), ...Object.fromEntries(Object.entries(parentSession.ui).map(([key, value]) => [key, typeof value === "function" ? value.bind(parentSession.ui) : value])) } });
        parentSession.ctx = navigatorState().uiCtx;
        const parentState = navigatorState();
        assert.equal(parentState?.uiCtx, parentSession.ctx, "the parent TUI session owns the navigator");
        assert.equal(typeof parentSession.ui.factory, "function", "the parent installs the ← editor wrapper");
        assert.deepEqual(
            [...parentState.providers.keys()].sort(),
            ["background-tasks", "subagents"],
            "both extensions publish rows into the one shared navigator",
        );

        // The headless child runs the same cached modules and the same lifecycle.
        child = await nativeBackground({ cwd: tempDir, sessionId: "cached-child", factory: registerCombined });
        await child.session.extensionRunner.emit({ type: "session_before_switch" });
        await child.close(); child = undefined;

        assert.equal(navigatorState().uiCtx, parentSession.ctx, "the headless child must not clear the parent's navigator");
        assert.equal(typeof parentSession.ui.factory, "function", "the parent's editor wrapper survives the child");
        assert.deepEqual(
            [...navigatorState().providers.keys()].sort(),
            ["background-tasks", "subagents"],
            "the child's shutdown must not unregister the parent's providers",
        );

        // The parent's editor wrapper is still mounted and still owns the keys.
        const editor = parentSession.ui.factory({ requestRender() {} }, parentSession.ui.theme, { getHotkeys: () => [] });
        assert.equal(typeof editor.handleInput, "function", "the parent's editor wrapper survives the child");

        // The parent's tools still work: a child teardown must not starve the parent.
        const spawn = await parent.execute("bg_task_spawn", {
            name: "parent-still-running",
            shell: false,
            argv: [process.execPath, "-e", "setTimeout(() => {}, 5_000)"],
            callback: false,
        });
        const id = spawn.match(/bgs_[0-9a-f]{20}/)?.[0];
        assert.ok(id, spawn);

        const listed = await parent.execute("bg_task_list", {});
        assert.match(listed, /parent-still-running/, "the parent's own list still reports its task");

        // A launch by the parent installs its main-list widget through the same
        // factory-owned navigator the child left alone.
        assert.equal(typeof parentSession.widget.installed, "function", "the parent's main-list widget is installed for its live row");
        let rail = "";
        for (let attempt = 0; attempt < 100 && !rail.includes("parent-still-running"); attempt++) {
            rail = parentSession.widget.installed({ requestRender() {} }, parentSession.ui.theme).render(160).join("\n");
            if (!rail.includes("parent-still-running")) await delay(20);
        }
        assert.match(rail, /parent-still-running/);
        assert.match(rail, /← work navigator/);

        const stop = await parent.execute("bg_task_stop", { id });
        assert.match(stop, /cancelled/);
    } finally {
        await child?.close();
        await parent.close();
    }

    assert.equal(navigatorState()?.uiCtx, undefined, "the owning factory still releases its own navigator");
    // Background Tasks unregisters with its session; Subagents keeps its provider
    // across reloads by design, so a replacement session reuses the same row source.
    assert.equal(navigatorState()?.providers.has("background-tasks"), false);
});
