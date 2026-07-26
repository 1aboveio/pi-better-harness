/**
 * Unit tests for issue #45 — minimal subagent navigator from empty-editor Left.
 *
 * Pins:
 * - Footer hint: `← subagents · N` while ≥1 non-dismissed current-parent run
 *   is running, cleared when none, delivered via the default footer status mechanism
 *   (setStatus) — the full footer is never replaced (no setFooter anywhere).
 * - Editor interception: bare `←` on an EMPTY editor with running runs opens
 *   the navigator; `←` with text delegates to normal cursor-left; any other
 *   key delegates. The wrapper composes with any existing editor component and
 *   repeated installs never stack duplicate wrappers.
 * - Overlay: visible current-parent runs newest first (running AND terminal),
 *   rows show name-or-ID · model · elapsed · spend · status (+ health), Up/Down
 *   move the selection (clamped), Escape closes, overlay requested with
 *   { overlay: true } (pi focuses overlays on show).
 * - Non-TUI: the navigator wiring is unavailable without a UI (print/RPC).
 * - Widget non-regression: widget code paths untouched (existing
 *   widget_flicker suite is the pin; asserted here by file hash stability of
 *   behavior via the untouched suite, not re-tested).
 *
 * // @covers navigator.footer-hint
 * // @level unit
 * // @covers navigator.editor-wrapper
 * // @level unit
 * // @covers navigator.overlay
 * // @level unit
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync, rmSync } from "node:fs";
import {
    writeMeta,
    readMeta,
    listMetas,
    effectiveStatus,
    navigatorVisibleRuns,
    navigatorVisibleCount,
    dismissRun,
    runDir,
} from "../registry.ts";
import {
    NAVIGATOR_STATUS_KEY,
    navigatorFooterHint,
    applyNavigatorFooter,
    isNavigatorUiAvailable,
    buildNavigatorRows,
    createNavigatorState,
    moveSelection,
    clampSelection,
    buildNavigatorLines,
    createNavigatorOverlayFactory,
    showNavigator,
    wrapEditor,
    installNavigatorEditor,
} from "../navigator.ts";
import { fmtElapsed, shortModel } from "../widget.ts";

const THIS_PID = process.pid;
const FOREIGN_PID = THIS_PID + 1;

/** Unique on-disk test ids; cleaned up in `after` so the real tmpdir registry
 *  is left as we found it. */
const diskIds = [];
function trackDisk(id) {
    diskIds.push(id);
    return id;
}
after(() => {
    for (const id of diskIds) {
        try { rmSync(runDir(id), { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

let n = 0;
function meta(overrides = {}) {
    n += 1;
    return {
        id: overrides.id ?? `sa_t45_${n}`,
        status: "completed",
        pid: 0,
        spawnPid: THIS_PID,
        cwd: "/tmp",
        promptPreview: "p",
        startedAt: 1,
        logPath: "/tmp/x.log",
        sessionId: "s",
        ...overrides,
    };
}

/** Recording fake for pi's UI status surface (the external boundary). */
function fakeStatusUi() {
    const calls = [];
    return {
        calls,
        setStatus(key, text) { calls.push([key, text]); },
    };
}

// ---------------------------------------------------------------------------
// Footer hint (AC: hint while visible runs exist, clears at zero, default
// footer status mechanism, never replaces the footer)
// ---------------------------------------------------------------------------
describe("navigator footer hint", () => {
    // @covers navigator.footer-hint
    // @level unit
    it("hint text is `← subagents · N` for N ≥ 1 and null at zero", () => {
        assert.equal(navigatorFooterHint(1), "← subagents · 1");
        assert.equal(navigatorFooterHint(3), "← subagents · 3");
        assert.equal(navigatorFooterHint(0), null);
    });

    // @covers navigator.footer-hint
    // @level unit
    it("applyNavigatorFooter sets the status while visible runs exist and clears it at zero", () => {
        const ui = fakeStatusUi();
        applyNavigatorFooter(ui, 2);
        assert.deepEqual(ui.calls, [[NAVIGATOR_STATUS_KEY, "← subagents · 2"]]);
        applyNavigatorFooter(ui, 0);
        assert.deepEqual(ui.calls.at(-1), [NAVIGATOR_STATUS_KEY, undefined]);
    });

    // @covers navigator.footer-hint
    // @covers navigator.overlay
    // @level unit
    it("overlay list uses the #44 visibility seam (dismissed + foreign excluded)", () => {
        const ownId = trackDisk(`sa_t45_vis_${Date.now()}`);
        const termId = trackDisk(`sa_t45_vist_${Date.now()}`);
        const dismissedId = trackDisk(`sa_t45_visd_${Date.now()}`);
        writeMeta(meta({ id: ownId, status: "running", pid: THIS_PID, startedAt: 100 }));
        writeMeta(meta({ id: termId, startedAt: 50 }));
        writeMeta(meta({ id: dismissedId, startedAt: 10 }));
        dismissRun(dismissedId);
        const metas = listMetas();
        const visible = navigatorVisibleRuns(metas, THIS_PID);
        assert.equal(navigatorVisibleCount(metas, THIS_PID), visible.length);
        const ids = visible.map((m) => m.id);
        assert.ok(ids.includes(ownId) && ids.includes(termId), "running AND terminal runs are visible");
        assert.ok(!ids.includes(dismissedId), "dismissed runs are excluded from the count/list");
    });

    // @covers navigator.footer-hint
    // @covers navigator.editor-wrapper
    // @level unit
    it("extension wiring bases the left-arrow affordance on running runs", () => {
        const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
        assert.ok(src.includes("function navigatorRunningCount"), "index.ts must expose a running-only affordance seam");
        assert.ok(src.includes("canOpen: () => navigatorRunningCount() > 0"), "empty-editor left must require a running run");
        assert.ok(src.includes("navigatorFooterHint(navigatorRunningCount())"), "footer hint must count running runs only");
    });

    // @covers navigator.footer-hint
    // @level unit
    it("the extension never replaces the full footer (no setFooter in the wiring)", () => {
        const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
        assert.ok(!src.includes("setFooter"), "index.ts must not call setFooter — the hint uses setStatus only");
    });
});

// ---------------------------------------------------------------------------
// Non-TUI guard (AC: navigator inactive in non-TUI modes)
// ---------------------------------------------------------------------------
describe("non-TUI guard", () => {
    // Real context shapes per pi's extensions.md: hasUI is true in BOTH TUI
    // and RPC modes; mode is "tui" | "rpc" | "json" | "print". The navigator
    // uses terminal-only features (custom() overlay, editor component
    // factory), so the guard must require ctx.mode === "tui" — hasUI alone
    // leaks setStatus/editor/overlay wiring into RPC sessions.
    // @covers navigator.footer-hint
    // @covers navigator.editor-wrapper
    // @level unit
    it("navigator UI is available only in TUI mode with a UI", () => {
        // The real TUI shape passes.
        assert.equal(isNavigatorUiAvailable({ mode: "tui", hasUI: true, ui: {} }), true);
        // The real RPC shape (hasUI:true AND a ui object, per pi docs) must
        // NOT enable navigator wiring.
        assert.equal(
            isNavigatorUiAvailable({ mode: "rpc", hasUI: true, ui: { setStatus() {}, custom() {}, setEditorComponent() {} } }),
            false,
        );
        // Print/JSON modes have no UI at all.
        assert.equal(isNavigatorUiAvailable({ mode: "print" }), false);
        assert.equal(isNavigatorUiAvailable({ mode: "json", hasUI: false }), false);
        // Fail closed on a missing mode: UI availability without an explicit
        // TUI mode is not enough.
        assert.equal(isNavigatorUiAvailable({ hasUI: true, ui: {} }), false);
        // TUI mode still requires the UI to actually be present.
        assert.equal(isNavigatorUiAvailable({ mode: "tui", hasUI: true }), false);
        assert.equal(isNavigatorUiAvailable({ mode: "tui", hasUI: false, ui: {} }), false);
        assert.equal(isNavigatorUiAvailable(undefined), false);
    });

    // @covers navigator.footer-hint
    // @covers navigator.editor-wrapper
    // @covers navigator.overlay
    // @level unit
    it("a real RPC-shaped context (mode:rpc, hasUI:true, ui) reaches no footer/editor/overlay wiring", () => {
        const calls = [];
        const ui = {
            setStatus: (...a) => calls.push(["setStatus", ...a]),
            getEditorComponent: () => undefined,
            setEditorComponent: (...a) => calls.push(["setEditorComponent", ...a]),
            custom: (...a) => calls.push(["custom", ...a]),
        };
        const rpcCtx = { mode: "rpc", hasUI: true, ui };
        // The three index.ts entry points (updateNavigatorFooter /
        // installNavigator / openNavigator) all begin with this exact guard;
        // behind it sit the only calls into ui.setStatus / ui.setEditorComponent
        // / ui.custom the navigator makes.
        if (isNavigatorUiAvailable(rpcCtx)) {
            applyNavigatorFooter(ui, 1);
            installNavigatorEditor(ui, wrapperDeps({ createDefaultEditor: () => ({}) }));
            showNavigator(ui, [{ id: "sa_x" }], { matchKey: () => false, truncate: (s) => s });
        }
        assert.deepEqual(calls, [], "RPC contexts must never reach setStatus / setEditorComponent / custom");
    });

    // @covers navigator.footer-hint
    // @covers navigator.editor-wrapper
    // @level unit
    it("every navigator entry point in index.ts is behind the TUI-mode guard", () => {
        const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
        // The guard seam is the single gate used by footer install/update, the
        // editor install, overlay open, AND session_shutdown status cleanup —
        // print/RPC contexts fail it.
        assert.ok(src.includes("isNavigatorUiAvailable"), "index.ts must gate navigator wiring on isNavigatorUiAvailable");
        const navSrc = readFileSync(new URL("../navigator.mjs", import.meta.url), "utf8");
        assert.ok(
            navSrc.includes('ctx.mode === "tui"'),
            "isNavigatorUiAvailable must require explicit TUI mode (pi docs: hasUI is true in TUI AND RPC)",
        );
        // Shutdown cleanup is part of the same invariant class: a bare
        // ctx.ui.setStatus(NAVIGATOR_STATUS_KEY, ...) in session_shutdown would
        // leak into RPC even when every other entry point is guarded.
        const shutdownIdx = src.indexOf('pi.on("session_shutdown"');
        assert.ok(shutdownIdx >= 0, "session_shutdown handler must exist");
        const shutdownBody = src.slice(shutdownIdx, src.indexOf("});", shutdownIdx) + 3);
        assert.ok(
            shutdownBody.includes("isNavigatorUiAvailable"),
            "session_shutdown must guard navigator setStatus cleanup with isNavigatorUiAvailable",
        );
        assert.ok(
            /isNavigatorUiAvailable\s*\(\s*ctx\s*\)[\s\S]*setStatus\s*\(\s*NAVIGATOR_STATUS_KEY/.test(shutdownBody),
            "navigator setStatus cleanup must sit behind isNavigatorUiAvailable(ctx)",
        );
    });

    // @covers navigator.footer-hint
    // @covers navigator.editor-wrapper
    // @covers navigator.overlay
    // @level unit
    it("registered extension RPC startup-through-shutdown emits no navigator UI calls", async () => {
        // Invariant class: non-TUI navigator isolation.
        // Adjacent members (all must stay silent on the registered RPC path):
        //   - footer status          (NAVIGATOR_STATUS_KEY / 'subagents-nav')
        //   - close-confirm status   ('subagents-close'; #47+ key)
        //   - editor wrapper install (setEditorComponent)
        //   - overlay custom()       (showNavigator / detail)
        // Widget setWidget remains legitimate in RPC (pi docs) and is NOT
        // part of this class.
        //
        // Live driveable proof (not source-scan-only): load the REAL production
        // registration path in-process (index.ts factory → registered
        // session_start / session_shutdown) under an RPC-shaped ctx. Host
        // packages are stubbed at the EXTERNAL boundary only
        // (pi_host_stub_hooks); no global `pi` binary is required, so this
        // stays green on CI runners without pi on PATH.
        //
        // At bc0d0f, session_shutdown called setStatus('subagents-nav',
        // undefined) unconditionally. Filtering statusCalls for only
        // NAVIGATOR_STATUS_KEY would still green-pass an unguarded
        // setStatus('subagents-close', undefined) — so the class proof asserts
        // the full setStatus log is empty, and names both navigator keys.
        register(new URL("./pi_host_stub_hooks.mjs", import.meta.url));
        const { default: betterSubagents } = await import("../index.ts");

        const statusCalls = [];
        const editorCalls = [];
        const customCalls = [];
        const widgetCalls = [];
        const handlers = {};

        // Known navigator status keys in the isolation class. The close-confirm
        // key is owned by #47 but is an adjacent member of THIS invariant — an
        // unguarded clear of it on session_start/session_shutdown is the same
        // non-TUI leak class as the footer key, whether or not this unit
        // exports the constant yet.
        const CLOSE_CONFIRM_STATUS_KEY = "subagents-close";

        const ui = {
            setStatus(key, text) { statusCalls.push([key, text]); },
            getEditorComponent() { return undefined; },
            setEditorComponent(...a) { editorCalls.push(a); },
            custom(...a) { customCalls.push(a); return Promise.resolve(undefined); },
            setWidget(...a) { widgetCalls.push(a); },
        };
        const rpcCtx = {
            mode: "rpc",
            hasUI: true,
            ui,
            cwd: "/tmp",
            model: { provider: "test", id: "model" },
        };
        const pi = {
            registerTool() {},
            on(event, fn) { handlers[event] = fn; },
            sendMessage() {},
        };

        betterSubagents(pi);
        assert.equal(typeof handlers.session_start, "function", "extension must register session_start");
        assert.equal(typeof handlers.session_shutdown, "function", "extension must register session_shutdown");

        await handlers.session_start({}, rpcCtx);
        await handlers.session_shutdown({}, rpcCtx);

        // Class-complete: the registered RPC path has no legitimate setStatus
        // writes at all. Prefer the full log over a single-key filter so an
        // unguarded close-confirm (or any future navigator status key) cannot
        // slip past.
        assert.deepEqual(
            statusCalls,
            [],
            `RPC startup-through-shutdown must emit zero setStatus calls ` +
                `(non-TUI navigator isolation: footer '${NAVIGATOR_STATUS_KEY}' + ` +
                `close-confirm '${CLOSE_CONFIRM_STATUS_KEY}'); got ${JSON.stringify(statusCalls)}`,
        );
        // Named adjacent status members — keeps the class members greppable
        // even if a later edit reintroduces a filtered assertion shape.
        assert.equal(
            statusCalls.filter(([key]) => key === NAVIGATOR_STATUS_KEY).length,
            0,
            "RPC must not setStatus footer key (subagents-nav)",
        );
        assert.equal(
            statusCalls.filter(([key]) => key === CLOSE_CONFIRM_STATUS_KEY).length,
            0,
            "RPC must not setStatus close-confirm key (subagents-close)",
        );
        assert.deepEqual(editorCalls, [], "RPC must not install navigator editor factory");
        assert.deepEqual(customCalls, [], "RPC must not open navigator overlay via custom()");
        // setWidget clear on shutdown is allowed in RPC (pi docs) — not asserted away.
        assert.ok(Array.isArray(widgetCalls), "widget seam remains callable under RPC");
    });
});

// ---------------------------------------------------------------------------
// Editor wrapper (AC: empty-editor interception, non-empty delegation,
// composition with any existing editor, no stacked wrappers on reload)
// ---------------------------------------------------------------------------

/** Fake standing in for pi's Editor (external boundary). */
function fakeEditor(text = "") {
    return {
        text,
        inputs: [],
        renders: 0,
        onSubmit: undefined,
        getText() { return this.text; },
        setText(t) { this.text = t; },
        handleInput(d) { this.inputs.push(d); },
        render(w) { this.renders++; return [`ed:${this.text}`.slice(0, w)]; },
        invalidate() {},
    };
}

const LEFT = "\x1b[D";
const isLeft = (d) => d === LEFT;

function wrapperDeps(overrides = {}) {
    return {
        isOpenTrigger: isLeft,
        canOpen: () => true,
        onOpen: () => {},
        ...overrides,
    };
}

describe("editor wrapper interception", () => {
    // @covers navigator.editor-wrapper
    // @level unit
    it("bare ← on an EMPTY editor with visible runs opens the navigator and is not delegated", () => {
        const inner = fakeEditor("");
        let opened = 0;
        const w = wrapEditor(inner, wrapperDeps({ onOpen: () => opened++ }));
        w.handleInput(LEFT);
        assert.equal(opened, 1, "open callback must fire");
        assert.deepEqual(inner.inputs, [], "the triggering key must not reach the inner editor");
    });

    // @covers navigator.editor-wrapper
    // @level unit
    it("bare ← while the editor contains text delegates to normal cursor-left behavior", () => {
        const inner = fakeEditor("hello");
        let opened = 0;
        const w = wrapEditor(inner, wrapperDeps({ onOpen: () => opened++ }));
        w.handleInput(LEFT);
        assert.equal(opened, 0, "navigator must not open while editing");
        assert.deepEqual(inner.inputs, [LEFT], "← must reach the inner editor unchanged");
    });

    // @covers navigator.editor-wrapper
    // @level unit
    it("bare ← on an empty editor with NO visible runs delegates (no navigator affordance)", () => {
        const inner = fakeEditor("");
        let opened = 0;
        const w = wrapEditor(inner, wrapperDeps({ canOpen: () => false, onOpen: () => opened++ }));
        w.handleInput(LEFT);
        assert.equal(opened, 0);
        assert.deepEqual(inner.inputs, [LEFT]);
    });

    // @covers navigator.editor-wrapper
    // @level unit
    it("any other key delegates unchanged, even on an empty editor with visible runs", () => {
        const inner = fakeEditor("");
        let opened = 0;
        const w = wrapEditor(inner, wrapperDeps({ onOpen: () => opened++ }));
        w.handleInput("a");
        w.handleInput("\x1b[A"); // up
        w.handleInput("\x1b[1;5D"); // ctrl+left is NOT bare left
        assert.equal(opened, 0);
        assert.deepEqual(inner.inputs, ["a", "\x1b[A", "\x1b[1;5D"]);
    });

    // @covers navigator.editor-wrapper
    // @level unit
    it("the wrapper composes with the wrapped editor: property sets/gets and methods pass through", () => {
        const inner = fakeEditor("draft");
        const w = wrapEditor(inner, wrapperDeps());
        // pi assigns these on the component it receives (see setCustomEditorComponent).
        w.onSubmit = () => "submitted";
        assert.equal(typeof inner.onSubmit, "function", "onSubmit must land on the inner editor");
        assert.equal(inner.onSubmit(), "submitted");
        w.setText("changed");
        assert.equal(inner.getText(), "changed");
        assert.deepEqual(w.render(40), ["ed:changed"]);
        assert.equal(inner.renders, 1);
        // Duck-typing used by pi to wire app-level handlers must survive wrapping.
        assert.equal("handleInput" in w, true);
        assert.equal("onSubmit" in w, true);
    });
});

describe("editor wrapper installation", () => {
    /** Fake for pi's ctx.ui editor-factory surface. */
    function fakeEditorUi(prevFactory) {
        const calls = { set: 0 };
        return {
            calls,
            factory: prevFactory,
            getEditorComponent() { return this.factory; },
            setEditorComponent(f) { this.factory = f; calls.set++; },
        };
    }

    // @covers navigator.editor-wrapper
    // @level unit
    it("installs a factory that wraps a default editor when none was configured", () => {
        const ui = fakeEditorUi(undefined);
        const inner = fakeEditor("");
        let opened = 0;
        installNavigatorEditor(ui, wrapperDeps({
            createDefaultEditor: () => inner,
            onOpen: () => opened++,
        }));
        assert.equal(ui.calls.set, 1);
        const editor = ui.factory("tui", "theme", "kb");
        editor.handleInput(LEFT);
        assert.equal(opened, 1, "installed wrapper must intercept empty-editor ←");
    });

    // @covers navigator.editor-wrapper
    // @level unit
    it("composes with a previously installed editor component rather than replacing it", () => {
        const inner = fakeEditor("x");
        let prevBuilt = 0;
        const prevFactory = () => { prevBuilt++; return inner; };
        const ui = fakeEditorUi(prevFactory);
        installNavigatorEditor(ui, wrapperDeps({ createDefaultEditor: () => { throw new Error("must not build default"); } }));
        const editor = ui.factory("tui", "theme", "kb");
        assert.equal(prevBuilt, 1, "the previous factory must be used as the inner editor");
        editor.handleInput("a");
        assert.deepEqual(inner.inputs, ["a"], "input must reach the previously installed editor");
    });

    // @covers navigator.editor-wrapper
    // @level unit
    it("repeated installs (reload / session restart) do not stack duplicate wrappers", () => {
        const ui = fakeEditorUi(undefined);
        const inner1 = fakeEditor("");
        const inner2 = fakeEditor("");
        let built1 = 0;
        installNavigatorEditor(ui, wrapperDeps({ createDefaultEditor: () => { built1++; return inner1; } }));
        const first = ui.factory;
        // pi builds an editor from the installed factory (pre-refresh).
        const editor1 = ui.factory("tui", "theme", "kb");
        assert.equal(built1, 1);
        let opened2 = 0;
        installNavigatorEditor(ui, wrapperDeps({
            createDefaultEditor: () => inner2,
            onOpen: () => opened2++,
        }));
        assert.equal(ui.calls.set, 1, "second install must NOT call setEditorComponent again");
        assert.equal(ui.factory, first, "the same factory must be kept");
        // The already-built editor keeps working through the ORIGINAL wrapper
        // with REFRESHED deps — one interception layer, no stacked wrappers.
        editor1.handleInput(LEFT);
        assert.equal(opened2, 1, "refreshed deps must drive the existing wrapper");
        assert.deepEqual(inner1.inputs, [], "the key was intercepted exactly once");
        // A new editor built after the refresh is likewise wrapped exactly once.
        const editor2 = ui.factory("tui", "theme", "kb");
        editor2.handleInput(LEFT);
        assert.equal(opened2, 2);
        assert.deepEqual(inner2.inputs, []);
    });
});

// ---------------------------------------------------------------------------
// Overlay (AC: newest-first visible runs incl. running+terminal, row fields,
// Up/Down selection, Escape close, focused overlay)
// ---------------------------------------------------------------------------

function rowDeps(overrides = {}) {
    return {
        effectiveStatus: (m) => m.status,
        shortModel,
        fmtElapsed,
        spendFor: () => "",
        now: 100_000,
        ...overrides,
    };
}

describe("navigator rows", () => {
    // @covers navigator.overlay
    // @level unit
    it("rows come newest first from the real registry and include running and terminal runs", () => {
        const older = trackDisk(`sa_t45_ord1_${Date.now()}`);
        const newer = trackDisk(`sa_t45_ord2_${Date.now()}`);
        writeMeta(meta({ id: older, startedAt: 1000, status: "completed" }));
        writeMeta(meta({ id: newer, startedAt: 2000, status: "running", pid: THIS_PID }));
        const rows = buildNavigatorRows(navigatorVisibleRuns(listMetas(), THIS_PID), {
            ...rowDeps(),
            effectiveStatus,
        }).filter((r) => [older, newer].includes(r.id));
        assert.deepEqual(rows.map((r) => r.id), [newer, older], "newest first");
        assert.equal(rows[0].status, "running");
        assert.equal(rows[1].status, "completed");
    });

    // @covers navigator.overlay
    // @level unit
    it("each row carries name-or-ID, model, elapsed, spend, and durable status", () => {
        const rows = buildNavigatorRows([
            meta({ id: "sa_t45_named", name: "reviewer", model: "xai/grok-4.5", startedAt: 90_000 }),
            meta({ id: "sa_t45_unnamed", startedAt: 0, endedAt: 61_000 }),
        ], rowDeps({ spendFor: (m) => (m.id === "sa_t45_named" ? "1.2k tok (↑800 ↓400) · $0.01" : "") }));
        assert.equal(rows[0].name, "reviewer");
        assert.equal(rows[0].status, "completed");
        assert.equal(rows[0].model, "grok-4.5");
        assert.equal(rows[0].elapsed, "10s");
        assert.equal(rows[0].spend, "1.2k tok (↑800 ↓400) · $0.01");
        assert.deepEqual(rows[0].healthFacts, [], "healthy/quiet default has no health facts");
        assert.equal(rows[1].name, undefined, "unnamed run falls back to id at render time");
        assert.equal(rows[1].elapsed, "1m 01s", "terminal runs freeze elapsed at endedAt");
    });
});

describe("navigator selection state", () => {
    // @covers navigator.overlay
    // @level unit
    it("starts on the first row and clamps movement at both ends", () => {
        const state = createNavigatorState([{ id: "a" }, { id: "b" }, { id: "c" }]);
        assert.equal(state.selected, 0);
        assert.equal(moveSelection(state, -1), false, "moving up at the top changes nothing");
        assert.equal(state.selected, 0);
        assert.equal(moveSelection(state, 1), true);
        assert.equal(state.selected, 1);
        assert.equal(moveSelection(state, 1), true);
        assert.equal(state.selected, 2);
        assert.equal(moveSelection(state, 1), false, "moving down at the bottom changes nothing");
        assert.equal(state.selected, 2);
    });

    // @covers navigator.overlay
    // @level unit
    it("clamps a selection that outlives its row list", () => {
        const state = createNavigatorState([{ id: "a" }, { id: "b" }]);
        state.selected = 1;
        state.rows = [{ id: "a" }];
        clampSelection(state);
        assert.equal(state.selected, 0);
        state.rows = [];
        clampSelection(state);
        assert.equal(state.selected, 0);
    });
});

describe("navigator overlay component", () => {
    const truncate = (s, w) => (s.length > w ? s.slice(0, Math.max(0, w)) : s);

    function driveOverlay(rows, keyIds = {}) {
        const tui = { renders: 0, requestRender() { this.renders++; } };
        const theme = { fg: (c, s) => `<${c}>${s}</>` };
        const doneCalls = [];
        const customCalls = [];
        // Pi-compatible custom(): resolves to done()'s value (null), not component.
        const ui = {
            custom(factory, options) {
                customCalls.push(options);
                return new Promise((resolve) => {
                    const component = factory(tui, theme, {}, (v) => {
                        doneCalls.push(v);
                        resolve(v);
                    });
                    ui._lastComponent = component;
                });
            },
            _lastComponent: undefined,
        };
        const matchKey = (data, id) => data === `<${id}>`;
        let component;
        showNavigator(ui, rows, {
            matchKey,
            truncate,
            onComponent: (c) => { component = c; },
        });
        return {
            ui, tui, doneCalls, customCalls,
            component: () => component,
            press: (d) => component.handleInput(d),
        };
    }

    // @covers navigator.overlay
    // @level unit
    it("opens as a focused overlay ({ overlay: true }) listing every visible run", async () => {
        const rows = [
            { id: "sa_1", name: "newest", status: "running", model: "grok-4.5", elapsed: "5s", spend: "" },
            { id: "sa_2", status: "completed", model: "?", elapsed: "1m 01s", spend: "1.2k tok (↑800 ↓400) · $0.01" },
        ];
        const o = driveOverlay(rows);
        await Promise.resolve();
        assert.deepEqual(o.customCalls, [{ overlay: true }], "must request overlay mode (pi focuses overlays on show)");
        const lines = o.component().render(80);
        assert.equal(lines.length, 7, "command sheet: title + actions + spacer + 2 rows + spacer + rail");
        const plain = lines.map((l) => l.replace(/<\/?[a-z]*>/g, ""));
        assert.ok(plain[0].includes("Subagents · 2"));
        assert.ok(plain[1].includes("Enter view"), "action bar sits under the title rail");
        assert.ok(plain[3].startsWith("›  "), "first row selected by default");
        // #69 scan order: name · model · elapsed · status (status last).
        assert.ok(plain[3].includes("newest · grok-4.5 · 5s · running"), plain[3]);
        assert.ok(plain[4].startsWith("   "));
        assert.ok(plain[4].includes("sa_2 · ? · 1m 01s · 1.2k tok") && plain[4].includes("completed"),
            `unnamed run shows its id, spend, status last: ${plain[4]}`);
        assert.ok(plain[1].includes("Esc"), "action bar advertises escape");
        assert.ok(plain[1].includes("x stop"), "running selection labels x as stop, not close");
        assert.ok(!plain[1].includes("x close"), "x action must not collide with Esc close wording");
    });

    // @covers navigator.overlay
    // @level unit
    it("list help labels terminal x action as dismiss", () => {
        const state = createNavigatorState([
            { id: "sa_done", status: "completed", model: "?", elapsed: "1s", spend: "" },
        ]);
        const lines = buildNavigatorLines(state, { width: 80 }).map((l) => l.replace(/<\/?[a-z]*>/g, ""));
        assert.ok(lines[1].includes("x dismiss"), lines[1]);
        assert.ok(lines[1].includes("Esc close"), lines[1]);
    });

    // @covers navigator.overlay
    // @level unit
    it("every rendered line fits the given width, even with long names", async () => {
        const longName = "n".repeat(200);
        const o = driveOverlay([{ id: "sa_1", name: longName, status: "running", model: "m", elapsed: "5s", spend: "x".repeat(100) }]);
        await Promise.resolve();
        for (const w of [20, 37, 80]) {
            for (const line of o.component().render(w)) {
                const plain = line.replace(/<\/?[a-z]*>/g, "");
                assert.ok(plain.length <= w, `line exceeds width ${w}: ${JSON.stringify(plain)}`);
            }
        }
    });

    // @covers navigator.overlay
    // @level unit
    it("an empty list renders an explicit placeholder (defensive; open normally refuses empty)", () => {
        const state = createNavigatorState([]);
        const lines = buildNavigatorLines(state, { width: 40 });
        assert.ok(lines[0].includes("Subagents · 0"));
        assert.ok(lines[0].startsWith("━━ "));
        assert.equal(lines[3], "   (no visible subagent runs)");
        assert.ok(lines[1].includes("Esc"), "action bar advertises escape");
        assert.ok(lines[1].includes("Enter") || lines[1].includes("↑↓"), "action bar lists navigation");
        // Keep the exact empty-list command sheet pinned.
        assert.equal(lines.length, 6);
    });

    // @covers navigator.overlay
    // @level unit
    it("Up and Down move the selected row (clamped) and request a render", async () => {
        const o = driveOverlay([
            { id: "a", status: "running", model: "m", elapsed: "1s", spend: "" },
            { id: "b", status: "failed", model: "m", elapsed: "2s", spend: "" },
        ]);
        await Promise.resolve();
        o.press("<up>");
        assert.equal(o.tui.renders, 0, "clamped move does not repaint");
        o.press("<down>");
        assert.equal(o.tui.renders, 1);
        let plain = o.component().render(80).map((l) => l.replace(/<\/?[a-z]*>/g, ""));
        assert.ok(plain[4].startsWith("›  "), "selection moved to the second row");
        o.press("<down>");
        assert.equal(o.tui.renders, 1, "clamped at the bottom");
        o.press("<up>");
        plain = o.component().render(80).map((l) => l.replace(/<\/?[a-z]*>/g, ""));
        assert.ok(plain[3].startsWith("›  "));
    });

    // @covers navigator.overlay
    // @level unit
    it("Escape closes the navigator", async () => {
        const o = driveOverlay([{ id: "a", status: "running", model: "m", elapsed: "1s", spend: "" }]);
        await Promise.resolve();
        o.press("<escape>");
        assert.deepEqual(o.doneCalls, [null], "escape resolves the overlay close");
    });

    // @covers navigator.overlay
    // @level unit
    it("unrelated keys are ignored by the overlay (no close, no repaint)", async () => {
        // Enter opens detail (#46) and `x` arms Close (#47); both are covered in
        // their own suites. List view still ignores keys that are neither
        // navigation, enter, close, nor escape.
        const o = driveOverlay([{ id: "a", status: "running", model: "m", elapsed: "1s", spend: "" }]);
        await Promise.resolve();
        o.press("z");
        o.press("q");
        assert.deepEqual(o.doneCalls, []);
        assert.equal(o.tui.renders, 0);
    });
});
