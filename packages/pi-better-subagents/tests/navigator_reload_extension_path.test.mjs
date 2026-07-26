/**
 * Integration regression for issue #48 session_start reload wiring through the
 * real extension factory path (index.ts registration → session_start → empty
 * editor ← → detail + close-arm → session_start again).
 *
 * Pins the integrated-review finding: reload cleanup must not be source-scan-
 * only. A second registered session_start must dispose live overlay timers,
 * clear close-confirm status, avoid stacking the editor wrapper, and republish
 * the navigator count footer.
 *
 * // @covers navigator.hardening
 * // @level integration
 */
import {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    rmSync,
    existsSync,
    lstatSync,
    readdirSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(__dirname);
const RUNTIME = mkdtempSync(join(tmpdir(), "nav-reload-ext-"));
process.env.TMPDIR = RUNTIME;

const STUBS_DIR = mkdtempSync(join(RUNTIME, "stubs-"));
const CHECKOUT_NODE_MODULES = join(REPO_ROOT, "node_modules");
const THIS_PID = process.pid;
const diskIds = [];

function trackDisk(id) {
    diskIds.push(id);
    return id;
}

function writeStubPackage(name, files) {
    const pkgDir = join(STUBS_DIR, ...name.split("/"));
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({ name, type: "module", main: "index.js", exports: { ".": "./index.js" } }),
    );
    for (const [file, content] of Object.entries(files)) {
        writeFileSync(join(pkgDir, file), content);
    }
}

function setupStubs() {
    writeStubPackage("@earendil-works/pi-ai", {
        "index.js": `
const scalar = (type, opts = {}) => ({ type, ...opts });
export const Type = {
    String: (opts) => scalar("string", opts),
    Number: (opts) => scalar("number", opts),
    Boolean: (opts) => scalar("boolean", opts),
    Optional: (schema) => schema,
    Array: (schema, opts = {}) => ({ type: "array", items: schema, ...opts }),
    Object: (props, opts = {}) => ({ type: "object", properties: props, ...opts }),
};
`,
    });
    writeStubPackage("@earendil-works/pi-coding-agent", {
        "index.js": `
export class CustomEditor {
    constructor() { this._text = ""; }
    getText() { return this._text; }
    setText(t) { this._text = String(t ?? ""); }
    handleInput() {}
}
`,
    });
    writeStubPackage("@earendil-works/pi-tui", {
        "index.js": `
export const Key = { left: "left", x: "x", X: "X", up: "up", down: "down", enter: "enter", escape: "escape" };
export function matchesKey(data, key) {
    if (data == null || key == null) return false;
    if (data === key) return true;
    if (data === \`<\${key}>\`) return true;
    return false;
}
export function truncateToWidth(s, w) {
    const str = String(s ?? "");
    const width = Number(w) || 0;
    return str.length > width ? str.slice(0, Math.max(0, width)) : str;
}
`,
    });

    const loaderPath = join(RUNTIME, "stub-loader.mjs");
    writeFileSync(
        loaderPath,
        `import { pathToFileURL } from "node:url";
const stubs = {
  "@earendil-works/pi-ai": ${JSON.stringify(join(STUBS_DIR, "@earendil-works/pi-ai/index.js"))},
  "@earendil-works/pi-coding-agent": ${JSON.stringify(join(STUBS_DIR, "@earendil-works/pi-coding-agent/index.js"))},
  "@earendil-works/pi-tui": ${JSON.stringify(join(STUBS_DIR, "@earendil-works/pi-tui/index.js"))},
};
export async function resolve(specifier, context, nextResolve) {
  if (Object.prototype.hasOwnProperty.call(stubs, specifier)) {
    return { shortCircuit: true, url: pathToFileURL(stubs[specifier]).href };
  }
  return nextResolve(specifier, context);
}
`,
    );
    register(pathToFileURL(loaderPath).href);
}

function assertCheckoutNodeModulesUntouched() {
    if (!existsSync(CHECKOUT_NODE_MODULES)) return;
    const entries = [];
    const walk = (dir, rel = "") => {
        for (const name of readdirSync(dir)) {
            const full = join(dir, name);
            const childRel = rel ? `${rel}/${name}` : name;
            let st;
            try { st = lstatSync(full); } catch { continue; }
            if (st.isSymbolicLink()) entries.push(`symlink:${childRel}`);
            else if (st.isDirectory()) walk(full, childRel);
            else entries.push(`file:${childRel}`);
        }
    };
    walk(CHECKOUT_NODE_MODULES);
    assert.deepEqual(entries, [], `checkout node_modules must stay clean; found: ${entries.join(", ")}`);
}

/**
 * Track production overlay timers that index.ts does not inject (real
 * setTimeout/setInterval). Excludes the test harness's own waits.
 */
function installTimerSpies() {
    const liveTimeouts = new Set();
    const liveIntervals = new Set();
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
    const realSetInterval = globalThis.setInterval.bind(globalThis);
    const realClearInterval = globalThis.clearInterval.bind(globalThis);

    globalThis.setTimeout = (fn, ms, ...args) => {
        const id = realSetTimeout((...a) => {
            liveTimeouts.delete(id);
            fn(...a);
        }, ms, ...args);
        liveTimeouts.add(id);
        return id;
    };
    globalThis.clearTimeout = (id) => {
        liveTimeouts.delete(id);
        return realClearTimeout(id);
    };
    globalThis.setInterval = (fn, ms, ...args) => {
        const id = realSetInterval(fn, ms, ...args);
        liveIntervals.add(id);
        return id;
    };
    globalThis.clearInterval = (id) => {
        liveIntervals.delete(id);
        return realClearInterval(id);
    };

    return {
        pendingTimeouts: () => liveTimeouts.size,
        pendingIntervals: () => liveIntervals.size,
        restore() {
            globalThis.setTimeout = realSetTimeout;
            globalThis.clearTimeout = realClearTimeout;
            globalThis.setInterval = realSetInterval;
            globalThis.clearInterval = realClearInterval;
            for (const id of liveTimeouts) realClearTimeout(id);
            for (const id of liveIntervals) realClearInterval(id);
            liveTimeouts.clear();
            liveIntervals.clear();
        },
    };
}

/**
 * Boot the real extension factory on a TUI-like ctx and expose the registered
 * session_start handler so reload can be fired a second time.
 */
function bootRegisteredNavigator(mod, { writeMeta, metaBase }) {
    const handlers = {};
    const statusCalls = [];
    const widgetCalls = [];
    let overlayComponent;
    let editor;
    let resolveOverlay;
    let overlayReady = new Promise((r) => { resolveOverlay = r; });
    let setEditorCount = 0;

    const ui = {
        theme: { fg: (color, s) => `<${color}>${s}</>` },
        setStatus(k, v) { statusCalls.push([k, v]); },
        setWidget(k, v) { widgetCalls.push([k, v]); },
        notify() {},
        factory: undefined,
        getEditorComponent() { return this.factory; },
        setEditorComponent(f) {
            this.factory = f;
            setEditorCount += 1;
        },
        custom(factory) {
            return new Promise((resolve) => {
                const tui = { requestRender() {} };
                const theme = { fg: (_c, s) => s };
                const component = factory(tui, theme, {}, (v) => resolve(v));
                overlayComponent = component;
                resolveOverlay(component);
            });
        },
    };

    const ctx = {
        mode: "tui",
        hasUI: true,
        ui,
        cwd: RUNTIME,
        model: { provider: "test", id: "model" },
    };

    const pi = {
        registerTool() {},
        on(event, fn) { handlers[event] = fn; },
        sendMessage() {},
    };

    mod.default(pi);
    assert.equal(typeof handlers.session_start, "function", "extension must register session_start");

    return {
        handlers,
        statusCalls,
        widgetCalls,
        ui,
        ctx,
        get setEditorCount() { return setEditorCount; },
        get overlayComponent() { return overlayComponent; },
        async start() {
            await handlers.session_start({}, ctx);
            assert.ok(ui.factory, "session_start must install the navigator editor factory");
            editor = ui.factory("tui", "theme", "kb");
            assert.equal(typeof editor.handleInput, "function");
            assert.equal(editor.getText(), "");
            return editor;
        },
        async reload() {
            // Host reload / session switch without a guaranteed shutdown first.
            await handlers.session_start({}, ctx);
        },
        focusViaLeftKey() {
            editor.handleInput("left");
        },
        async openDetailViaEnter() {
            // Reset the ready gate so a later open (if any) can wait again.
            overlayReady = new Promise((r) => { resolveOverlay = r; });
            editor.handleInput("enter");
            const component = await Promise.race([
                overlayReady,
                new Promise((_, rej) => {
                    const t = setTimeout(() => rej(new Error("overlay did not open")), 1000);
                    // Ensure the wait timer is not counted as an overlay arm timer
                    // after the race settles — clear on either path.
                    overlayReady.then(() => clearTimeout(t), () => clearTimeout(t));
                }),
            ]);
            assert.ok(component, "enter on focused widget row must open navigator detail overlay");
            assert.equal(typeof component.handleInput, "function");
            return component;
        },
        pressEditor(key) {
            editor.handleInput(key);
        },
        press(key) {
            assert.ok(overlayComponent, "overlay must be open before key input");
            overlayComponent.handleInput(key);
        },
        lastStatus(key) {
            for (let i = statusCalls.length - 1; i >= 0; i--) {
                if (statusCalls[i][0] === key) return statusCalls[i][1];
            }
            return Symbol.for("missing");
        },
        lastWidget(key) {
            for (let i = widgetCalls.length - 1; i >= 0; i--) {
                if (widgetCalls[i][0] === key) return widgetCalls[i][1];
            }
            return Symbol.for("missing");
        },
        seedRun(overrides = {}) {
            const id = trackDisk(overrides.id ?? `sa_t48_reload_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
            writeMeta({
                ...metaBase,
                id,
                ...overrides,
            });
            return id;
        },
    };
}

describe("registered extension path: session_start reload cleanup", () => {
    let mod;
    let registry;
    let metaBase;
    let timerSpies;

    before(async () => {
        setupStubs();
        assertCheckoutNodeModulesUntouched();
        mod = await import("../index.ts");
        registry = await import("../registry.ts");
        metaBase = {
            status: "completed",
            pid: 0,
            spawnPid: THIS_PID,
            cwd: RUNTIME,
            promptPreview: "reload-ext",
            startedAt: 1,
            logPath: join(RUNTIME, "reload.log"),
            sessionId: "reload-ext",
        };
        assertCheckoutNodeModulesUntouched();
    });

    after(() => {
        try { timerSpies?.restore(); } catch { /* best-effort */ }
        for (const id of diskIds) {
            try { rmSync(registry.runDir(id), { recursive: true, force: true }); } catch { /* best-effort */ }
        }
        try { rmSync(RUNTIME, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    // @covers navigator.hardening
    // @level integration
    it("terminal-only session_start clears the left-arrow affordance", async () => {
        const nav = bootRegisteredNavigator(mod, { writeMeta: registry.writeMeta, metaBase });
        nav.seedRun({
            id: trackDisk(`sa_t48_terminal_${Date.now()}`),
            name: "done-job",
            status: "completed",
            pid: 0,
            endedAt: 42,
        });

        await nav.start();

        assert.equal(nav.lastStatus("subagents-nav"), undefined, "terminal-only runs clear the footer hint");
        assert.equal(
            nav.widgetCalls.some((c) => c[0] === "subagents" && Array.isArray(c[1]) && c[1].some((line) => line.includes("← subagents"))),
            false,
            "terminal-only runs do not paint a fallback left-arrow widget",
        );
    });

    // @covers navigator.hardening
    // @level integration
    it("second session_start disposes live detail/arm timers, clears confirm, does not stack editor, republishes running-only affordance", async () => {
        timerSpies = installTimerSpies();
        const nav = bootRegisteredNavigator(mod, { writeMeta: registry.writeMeta, metaBase });
        const runningId = nav.seedRun({
            id: trackDisk(`sa_t48_reload_${Date.now()}`),
            name: "reload-job",
            status: "running",
            pid: THIS_PID,
            startedAt: 100,
        });
        nav.seedRun({
            id: trackDisk(`sa_t48_reload_done_${Date.now()}`),
            name: "finished-job",
            status: "completed",
            pid: 0,
            startedAt: 50,
            endedAt: 90,
        });
        const runningHint = "← subagents · 1";

        // 1) First session_start installs the empty-editor wrapper + running-only footer.
        await nav.start();
        assert.equal(nav.setEditorCount, 1, "first session_start installs editor once");
        assert.equal(nav.ui.factory?.__piBetterSubagentsNavigatorFactory, true, "factory is marked");
        const footerAfterStart = nav.lastStatus("subagents-nav");
        const widgetAfterStart = nav.lastWidget("subagents");
        assert.equal(footerAfterStart, runningHint, "first session_start publishes running-only count footer");
        assert.ok(Array.isArray(widgetAfterStart), "running session_start paints the live widget");
        assert.ok(widgetAfterStart[0].startsWith("Subagents · 1 running"), "live widget keeps the original running-count title");
        assert.ok(widgetAfterStart[0].includes("<muted>← to navigate</>"), "live widget includes a muted navigate hint on the title row");
        assert.ok(!widgetAfterStart.slice(1).some((line) => String(line).includes("← to navigate")), "live widget does not add a standalone left-arrow hint row");

        // 2) Focus the main-window list via the registered empty-editor Left path.
        nav.focusViaLeftKey();
        let widgetFocused = nav.lastWidget("subagents");
        assert.ok(widgetFocused[0].includes("<muted>Enter to view · x to stop</>"), "focused widget shows the main-window actions");
        assert.ok(widgetFocused.some((line) => String(line).startsWith("› ")), "focused widget marks the selected row");

        // 3) Enter opens detail; x arms close confirmation → widget interval + health interval + live detail interval + arm timeout.
        const component = await nav.openDetailViaEnter();
        nav.press("x");
        assert.equal(timerSpies.pendingIntervals(), 3, "widget, health, and detail tick intervals are live");
        assert.equal(timerSpies.pendingTimeouts(), 1, "close-arm timeout is live");
        const confirmAfterArm = nav.lastStatus("subagents-close");
        assert.equal(
            typeof confirmAfterArm,
            "string",
            "arm publishes close-confirm status",
        );
        assert.match(String(confirmAfterArm), /reload-job|x again/i);

        const statusLenBeforeReload = nav.statusCalls.length;
        const widgetLenBeforeReload = nav.widgetCalls.length;
        const editorBefore = nav.ui.factory;

        // 4) Fire registered session_start again (reload / session switch).
        await nav.reload();

        // 5a) Prior overlay timers + confirmation cleared by the registered
        // session_start path (disposeTrackedNavigator + CLOSE_CONFIRM clear).
        assert.equal(timerSpies.pendingIntervals(), 2, "reload must clear detail interval while keeping widget and health tickers");
        assert.equal(timerSpies.pendingTimeouts(), 0, "reload must clear close-arm timeout");
        const confirmAfterReload = nav.lastStatus("subagents-close");
        assert.equal(confirmAfterReload, undefined, "reload clears CLOSE_CONFIRM_STATUS_KEY");
        assert.ok(
            nav.statusCalls.slice(statusLenBeforeReload).some((c) => c[0] === "subagents-close" && c[1] === undefined),
            "reload path must invoke setStatus(close-confirm, undefined)",
        );
        // Dispose clears arm/detail state; the host would drop the focused
        // overlay on session switch. We only assert the production cleanup
        // side effects above (timers + confirm), not host focus teardown.
        assert.equal(typeof component.handleInput, "function");

        // 5b) Editor wrapper does not stack.
        assert.equal(nav.setEditorCount, 1, "reload must not call setEditorComponent again");
        assert.equal(nav.ui.factory, editorBefore, "same marked factory remains installed");
        assert.equal(nav.ui.factory?.__piBetterSubagentsNavigatorFactory, true);

        // 5c) Footer count is republished after lastNavigatorHint reset.
        const footerAfterReload = nav.lastStatus("subagents-nav");
        const widgetAfterReload = nav.lastWidget("subagents");
        assert.equal(footerAfterReload, runningHint, "reload republishes running-only navigator count footer");
        assert.ok(Array.isArray(widgetAfterReload), "reload repaints the live widget");
        assert.ok(widgetAfterReload[0].startsWith("Subagents · 1 running"), "reload keeps the original widget title");
        assert.ok(widgetAfterReload[0].includes("<muted>← to navigate</>"), "reload republishes the muted widget navigate hint on the title row");
        assert.ok(!widgetAfterReload.slice(1).some((line) => String(line).includes("← to navigate")), "reload does not add a standalone widget left-arrow hint row");
        assert.ok(
            nav.statusCalls.slice(statusLenBeforeReload).some((c) => c[0] === "subagents-nav" && typeof c[1] === "string"),
            "reload path must re-invoke setStatus for the running count footer",
        );
        assert.ok(
            nav.widgetCalls.slice(widgetLenBeforeReload).some((c) => c[0] === "subagents" && Array.isArray(c[1]) && String(c[1][0] ?? "").includes("<muted>← to navigate</>")),
            "reload path must re-invoke setWidget for the title-row navigator hint",
        );

        // Seed still visible (reload is non-mutating for runs).
        assert.ok(
            registry.navigatorVisibleRuns(registry.listMetas(), THIS_PID).some((m) => m.id === runningId),
            "reload must not dismiss the open run",
        );

        timerSpies.restore();
        timerSpies = undefined;
    });
});
