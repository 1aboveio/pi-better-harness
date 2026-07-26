/**
 * Unit tests for issue #48 — harden navigator rendering, reload, lifecycle, docs.
 *
 * Characterization + regression pins for the completed navigator stack (#45–#47):
 * - List and detail lines never exceed width after style stripping.
 * - Selection stays on the same run id across status refreshes / reorder.
 * - Selection clamps when the selected run is dismissed or disappears.
 * - Footer count + close-confirm clear/restore across close, dismiss, stop,
 *   reload (session_start), and session teardown paths.
 * - Editor wrappers do not stack across reloads (marked factory refresh).
 * - Overlay detail + close-arm timers clear on every close/teardown path.
 * - Non-TUI modes stay tool/API only (no navigator UI leakage).
 * - Passive live widget flicker protections remain intact (existing suite).
 *
 * // @covers navigator.hardening
 * // @level unit
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
    writeMeta,
    listMetas,
    effectiveStatus,
    navigatorVisibleRuns,
    navigatorVisibleCount,
    dismissRun,
    runDir,
} from "../registry.ts";
import {
    NAVIGATOR_STATUS_KEY,
    CLOSE_CONFIRM_STATUS_KEY,
    CLOSE_ARM_MS,
    navigatorFooterHint,
    applyNavigatorFooter,
    applyCloseConfirmFooter,
    closeConfirmHint,
    isNavigatorUiAvailable,
    buildNavigatorRows,
    buildNavigatorLines,
    buildDetailLines,
    createNavigatorState,
    selectById,
    applyNavigatorRows,
    createNavigatorOverlayComponent,
    showNavigator,
    openTrackedNavigator,
    disposeTrackedNavigator,
    wrapEditor,
    installNavigatorEditor,
    NAVIGATOR_FACTORY_MARK,
} from "../navigator.ts";
import { fmtElapsed, shortModel } from "../widget.ts";

const THIS_PID = process.pid;
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

const truncate = (s, w) => (s.length > w ? s.slice(0, Math.max(0, w)) : s);
const stripStyle = (s) => String(s).replace(/<\/?[a-z]*>/g, "");

function fakeClock(start = 1_000) {
    let now = start;
    /** @type {Map<number, { at: number, fn: Function }>} */
    const pending = new Map();
    let nextId = 1;
    return {
        now: () => now,
        advance(ms) {
            now += ms;
            for (const [id, t] of [...pending.entries()]) {
                if (t.at <= now) {
                    pending.delete(id);
                    try { t.fn(); } catch { /* ignore */ }
                }
            }
        },
        setTimeout(fn, ms) {
            const id = nextId++;
            pending.set(id, { at: now + ms, fn });
            return id;
        },
        clearTimeout(id) { pending.delete(id); },
        pendingCount: () => pending.size,
    };
}

function fakeTimers() {
    /** @type {Map<number, { fn: Function, ms: number }>} */
    const intervals = new Map();
    let nextId = 1;
    return {
        setInterval(fn, ms) {
            const id = nextId++;
            intervals.set(id, { fn, ms });
            return id;
        },
        clearInterval(id) { intervals.delete(id); },
        activeCount: () => intervals.size,
        tickAll() {
            for (const t of intervals.values()) t.fn();
        },
    };
}

function row(id, overrides = {}) {
    return {
        id,
        name: overrides.name ?? id,
        status: overrides.status ?? "running",
        model: overrides.model ?? "m",
        elapsed: overrides.elapsed ?? "1s",
        spend: overrides.spend ?? "",
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// S1 — narrow terminal truncation (list + detail, post style-strip)
// ---------------------------------------------------------------------------
describe("navigator hardening: narrow rendering", () => {
    // @covers navigator.hardening
    // @level unit
    it("list lines never exceed width after style stripping", () => {
        const state = createNavigatorState([
            row("sa_1", { name: "n".repeat(200), status: "running", model: "grok-4.5-very-long", elapsed: "12m 34s", spend: "tok ".repeat(40) }),
            row("sa_2", { name: "short", status: "completed", spend: "1.2k tok · $0.01" }),
        ]);
        state.selected = 1;
        for (const w of [1, 10, 20, 37, 40, 80]) {
            const lines = buildNavigatorLines(state, { width: w, truncate });
            for (const line of lines) {
                assert.ok(line.length <= w, `plain list line exceeds ${w}: ${JSON.stringify(line)}`);
            }
            // Styled overlay path: theme applied AFTER truncate.
            const tui = { requestRender() {} };
            const component = createNavigatorOverlayComponent(
                state.rows,
                { matchKey: () => false, truncate },
                tui,
                { fg: (c, s) => `<${c}>${s}</>` },
                () => {},
            );
            // move selection to match state
            if (state.selected === 1) component.handleInput; // no-op; default is 0
            for (const line of component.render(w)) {
                const plain = stripStyle(line);
                assert.ok(plain.length <= w, `styled list line exceeds ${w}: ${JSON.stringify(plain)}`);
            }
        }
    });

    // @covers navigator.hardening
    // @level unit
    it("detail lines never exceed width after style stripping (long name/output/tools)", () => {
        const detail = {
            id: "sa_1",
            name: "n".repeat(180),
            status: "running",
            model: "provider/model-with-a-very-long-identifier",
            elapsed: "1h 02m 03s",
            currentTool: "bash-with-a-very-long-tool-name-and-args",
            tools: "a,b,c,".repeat(40),
            spend: "s".repeat(120),
            output: ("line of output that is extremely long ".repeat(10) + "\n").repeat(5),
        };
        for (const w of [1, 10, 20, 37, 80]) {
            const plain = buildDetailLines(detail, { width: w, truncate });
            for (const line of plain) {
                assert.ok(line.length <= w, `plain detail line exceeds ${w}: ${JSON.stringify(line)}`);
            }
            const timers = fakeTimers();
            const component = createNavigatorOverlayComponent(
                [row("sa_1", { name: detail.name, spend: detail.spend })],
                {
                    matchKey: (d, id) => d === `<${id}>`,
                    truncate,
                    getDetail: () => detail,
                    setInterval: timers.setInterval,
                    clearInterval: timers.clearInterval,
                    tickMs: 1000,
                },
                { requestRender() {} },
                { fg: (c, s) => `<${c}>${s}</>` },
                () => {},
            );
            component.handleInput("<enter>");
            for (const line of component.render(w)) {
                const p = stripStyle(line);
                assert.ok(p.length <= w, `styled detail line exceeds ${w}: ${JSON.stringify(p)}`);
            }
            component.dispose();
            assert.equal(timers.activeCount(), 0);
        }
    });
});

// ---------------------------------------------------------------------------
// S2 — selection stability across status refresh + clamp on disappear
// ---------------------------------------------------------------------------
describe("navigator hardening: selection stability", () => {
    // @covers navigator.hardening
    // @level unit
    it("selectById keeps the same run when still present and clamps when missing", () => {
        const state = createNavigatorState([row("a"), row("b"), row("c")]);
        state.selected = 2; // c
        assert.equal(selectById(state, "b"), 1);
        assert.equal(state.selected, 1);
        // Missing id leaves index then clamps (b still at 1).
        assert.equal(selectById(state, "gone"), 1);
        state.rows = [row("a")];
        assert.equal(selectById(state, "gone"), 0, "out-of-range selection clamps after shrink");
        state.rows = [];
        assert.equal(selectById(state, "a"), 0);
    });

    // @covers navigator.hardening
    // @level unit
    it("applyNavigatorRows keeps selection by id across reorder/status refresh", () => {
        const state = createNavigatorState([
            row("newest", { status: "running" }),
            row("mid", { status: "running" }),
            row("old", { status: "completed" }),
        ]);
        state.selected = 1; // mid
        // Status refresh: mid finishes, list reorders (newest-first still, but
        // mid moves and status text changes). Selection must stay on mid.
        applyNavigatorRows(state, [
            row("mid", { status: "completed", elapsed: "9s" }),
            row("newest", { status: "running", elapsed: "2s" }),
            row("old", { status: "completed" }),
        ]);
        assert.equal(state.rows[state.selected].id, "mid");
        assert.equal(state.rows[state.selected].status, "completed");
    });

    // @covers navigator.hardening
    // @level unit
    it("applyNavigatorRows clamps when the selected run disappears (dismiss)", () => {
        const state = createNavigatorState([row("a"), row("b"), row("c")]);
        state.selected = 1; // b
        applyNavigatorRows(state, [row("a"), row("c")]);
        assert.ok(state.selected === 0 || state.selected === 1);
        assert.ok(["a", "c"].includes(state.rows[state.selected].id));
        assert.ok(!state.rows.some((r) => r.id === "b"));
        // Last remaining row disappears → empty list, selected 0.
        state.selected = 0;
        applyNavigatorRows(state, []);
        assert.equal(state.selected, 0);
        assert.equal(state.rows.length, 0);
    });

    // @covers navigator.hardening
    // @level unit
    it("overlay refreshRows after close keeps selection stable / clamps without out-of-range index", () => {
        const live = [
            row("sa_a", { name: "alpha", status: "completed" }),
            row("sa_b", { name: "beta", status: "completed" }),
            row("sa_c", { name: "gamma", status: "completed" }),
        ];
        const closed = new Set();
        const getRows = () => live.filter((r) => !closed.has(r.id));
        const clock = fakeClock();
        const timers = fakeTimers();
        const tui = { renders: 0, requestRender() { this.renders++; } };
        const component = createNavigatorOverlayComponent(
            getRows(),
            {
                matchKey: (d, id) => d === `<${id}>` || ((id === "x" || id === "X") && (d === "x" || d === "X")),
                truncate,
                getRows,
                closeRun: (id) => {
                    closed.add(id);
                    return { action: "dismissed", id, status: "completed" };
                },
                onCloseConfirmHint: () => {},
                now: () => clock.now(),
                setTimeout: clock.setTimeout.bind(clock),
                clearTimeout: clock.clearTimeout.bind(clock),
                setInterval: timers.setInterval,
                clearInterval: timers.clearInterval,
            },
            tui,
            { fg: (_c, s) => s },
            () => {},
        );
        // Select beta (index 1), two-press close.
        component.handleInput("<down>");
        component.handleInput("x");
        component.handleInput("x");
        const lines = component.render(80).map(stripStyle);
        assert.ok(!lines.some((l) => l.includes("beta")), "dismissed run gone from list");
        const selected = lines.find((l) => l.startsWith("›  "));
        assert.ok(selected, "a row remains selected after dismiss");
        assert.ok(/alpha|gamma/.test(selected), `selection clamped to a remaining run, got: ${selected}`);
        // No throw / no empty selection marker on a missing row.
        assert.ok(lines[0].includes("Subagents · 2"));
    });

    // @covers navigator.hardening
    // @level unit
    it("status-refresh via getRows on leave-detail keeps the viewed run selected when still visible", () => {
        let rows = [
            row("sa_a", { name: "alpha" }),
            row("sa_b", { name: "beta" }),
            row("sa_c", { name: "gamma" }),
        ];
        const timers = fakeTimers();
        const component = createNavigatorOverlayComponent(
            rows,
            {
                matchKey: (d, id) => d === `<${id}>`,
                truncate,
                getDetail: (id) => ({ id, name: id, status: "running", model: "m", elapsed: "1s", spend: "", tools: "", output: "o" }),
                getRows: () => {
                    // Reorder while in detail: beta moves to top, status changes.
                    return [
                        row("sa_b", { name: "beta", status: "completed" }),
                        row("sa_c", { name: "gamma" }),
                        row("sa_a", { name: "alpha" }),
                    ];
                },
                setInterval: timers.setInterval,
                clearInterval: timers.clearInterval,
            },
            { requestRender() {} },
            { fg: (_c, s) => s },
            () => {},
        );
        component.handleInput("<down>"); // beta
        component.handleInput("<enter>");
        component.handleInput("<left>");
        assert.equal(timers.activeCount(), 0);
        const lines = component.render(80).map(stripStyle);
        assert.ok(lines.some((l) => l.startsWith("›  ") && l.includes("beta")), "beta still selected after refresh+reorder");
    });
});

// ---------------------------------------------------------------------------
// S3 — footer restore, editor reload dedupe, timer/confirm cleanup
// ---------------------------------------------------------------------------
describe("navigator hardening: footer / reload / timers", () => {
    // @covers navigator.hardening
    // @level unit
    it("footer count hint publishes and clears; close-confirm coexists then clears", () => {
        const calls = [];
        const ui = { setStatus(k, v) { calls.push([k, v]); } };
        assert.equal(navigatorFooterHint(0), null);
        assert.equal(navigatorFooterHint(2), "← subagents · 2");
        applyNavigatorFooter(ui, 2);
        applyCloseConfirmFooter(ui, closeConfirmHint(row("sa_1", { name: "alpha", status: "running" })));
        applyCloseConfirmFooter(ui, null);
        applyNavigatorFooter(ui, 0);
        assert.deepEqual(calls, [
            [NAVIGATOR_STATUS_KEY, "← subagents · 2"],
            [CLOSE_CONFIRM_STATUS_KEY, "x again to stop alpha"],
            [CLOSE_CONFIRM_STATUS_KEY, undefined],
            [NAVIGATOR_STATUS_KEY, undefined],
        ]);
    });

    // @covers navigator.hardening
    // @level unit
    it("normal close, dispose, and arm-expiry all clear the confirm footer and timers", () => {
        const clock = fakeClock();
        const timers = fakeTimers();
        const hints = [];
        const tui = { requestRender() {} };
        const component = createNavigatorOverlayComponent(
            [row("sa_a", { name: "alpha", status: "running" })],
            {
                matchKey: (d, id) => d === `<${id}>` || (id === "x" && d === "x"),
                truncate,
                getDetail: () => ({ id: "sa_a", name: "alpha", status: "running", model: "m", elapsed: "1s", spend: "", tools: "bash", output: "…" }),
                onCloseConfirmHint: (h) => hints.push(h),
                now: () => clock.now(),
                setTimeout: clock.setTimeout.bind(clock),
                clearTimeout: clock.clearTimeout.bind(clock),
                setInterval: timers.setInterval,
                clearInterval: timers.clearInterval,
                tickMs: 1000,
            },
            tui,
            { fg: (_c, s) => s },
            () => {},
        );

        // Arm in list, Escape closes → confirm cleared, arm timer gone.
        component.handleInput("x");
        assert.equal(hints.at(-1), "x again to stop alpha");
        assert.equal(clock.pendingCount(), 1);
        component.handleInput("<escape>");
        assert.equal(hints.at(-1), null);
        assert.equal(clock.pendingCount(), 0);

        // Fresh component: enter detail (detail timer), arm, dispose clears both.
        const c2 = createNavigatorOverlayComponent(
            [row("sa_a", { name: "alpha", status: "completed" })],
            {
                matchKey: (d, id) => d === `<${id}>` || (id === "x" && d === "x"),
                truncate,
                getDetail: () => ({ id: "sa_a", name: "alpha", status: "completed", model: "m", elapsed: "1s", spend: "", tools: "", output: "done" }),
                onCloseConfirmHint: (h) => hints.push(h),
                now: () => clock.now(),
                setTimeout: clock.setTimeout.bind(clock),
                clearTimeout: clock.clearTimeout.bind(clock),
                setInterval: timers.setInterval,
                clearInterval: timers.clearInterval,
                tickMs: 1000,
            },
            tui,
            { fg: (_c, s) => s },
            () => {},
        );
        c2.handleInput("<enter>");
        assert.equal(timers.activeCount(), 1);
        c2.handleInput("x");
        assert.equal(hints.at(-1), "x again to dismiss alpha");
        assert.equal(clock.pendingCount(), 1);
        c2.dispose();
        assert.equal(timers.activeCount(), 0);
        assert.equal(clock.pendingCount(), 0);
        assert.equal(hints.at(-1), null);

        // Arm-expiry path: auto-disarm at CLOSE_ARM_MS boundary.
        const c3 = createNavigatorOverlayComponent(
            [row("sa_a", { name: "alpha", status: "running" })],
            {
                matchKey: (d, id) => d === `<${id}>` || (id === "x" && d === "x"),
                truncate,
                onCloseConfirmHint: (h) => hints.push(h),
                now: () => clock.now(),
                setTimeout: clock.setTimeout.bind(clock),
                clearTimeout: clock.clearTimeout.bind(clock),
            },
            tui,
            { fg: (_c, s) => s },
            () => {},
        );
        c3.handleInput("x");
        clock.advance(CLOSE_ARM_MS);
        assert.equal(hints.at(-1), null, "expiry clears confirm hint");
        assert.equal(clock.pendingCount(), 0);
    });

    // @covers navigator.hardening
    // @level unit
    it("openTrackedNavigator + disposeTrackedNavigator clears overlay timers (session teardown)", () => {
        const clock = fakeClock();
        const timers = fakeTimers();
        const slot = { value: undefined, get() { return this.value; }, set(v) { this.value = v; } };
        const hints = [];
        let component;
        const ui = {
            custom(factory, opts) {
                assert.deepEqual(opts, { overlay: true });
                return new Promise((resolve) => {
                    component = factory({ requestRender() {} }, { fg: (_c, s) => s }, {}, (v) => resolve(v));
                });
            },
        };
        openTrackedNavigator(ui, [row("sa_a", { name: "alpha" })], {
            matchKey: (d, id) => d === `<${id}>` || (id === "x" && d === "x"),
            truncate,
            getDetail: () => ({ id: "sa_a", name: "alpha", status: "running", model: "m", elapsed: "1s", spend: "", tools: "", output: "x" }),
            onCloseConfirmHint: (h) => hints.push(h),
            now: () => clock.now(),
            setTimeout: clock.setTimeout.bind(clock),
            clearTimeout: clock.clearTimeout.bind(clock),
            setInterval: timers.setInterval,
            clearInterval: timers.clearInterval,
            tickMs: 1000,
        }, slot);
        assert.equal(typeof slot.get(), "function", "dispose captured synchronously");
        component.handleInput("<enter>");
        component.handleInput("x");
        assert.equal(timers.activeCount(), 1);
        assert.equal(clock.pendingCount(), 1);
        disposeTrackedNavigator(slot);
        assert.equal(timers.activeCount(), 0);
        assert.equal(clock.pendingCount(), 0);
        assert.equal(hints.at(-1), null);
        assert.equal(slot.get(), undefined);
    });

    // @covers navigator.hardening
    // @level unit
    it("editor wrappers do not stack across reloads; refreshed deps reach the live wrapper", () => {
        const calls = { set: 0 };
        const ui = {
            factory: undefined,
            getEditorComponent() { return this.factory; },
            setEditorComponent(f) { this.factory = f; calls.set++; },
        };
        const inner = {
            text: "",
            inputs: [],
            getText() { return this.text; },
            handleInput(d) { this.inputs.push(d); },
        };
        let opened = 0;
        const LEFT = "\x1b[D";
        installNavigatorEditor(ui, {
            createDefaultEditor: () => inner,
            isOpenTrigger: (d) => d === LEFT,
            canOpen: () => true,
            onOpen: () => { opened += 1; },
        });
        assert.equal(ui.factory[NAVIGATOR_FACTORY_MARK], true);
        const editor = ui.factory("tui", "theme", "kb");
        // Simulate /reload session_start: install again with fresh deps.
        let openedAfterReload = 0;
        installNavigatorEditor(ui, {
            createDefaultEditor: () => { throw new Error("must not rebuild default on refresh"); },
            isOpenTrigger: (d) => d === LEFT,
            canOpen: () => true,
            onOpen: () => { openedAfterReload += 1; },
        });
        assert.equal(calls.set, 1, "reload must not stack a second setEditorComponent");
        editor.handleInput(LEFT);
        assert.equal(opened, 0, "pre-reload onOpen must not fire after refresh");
        assert.equal(openedAfterReload, 1, "refreshed onOpen drives the existing wrapper");
        assert.deepEqual(inner.inputs, [], "single interception layer");
        // A third install (another reload) still does not stack.
        installNavigatorEditor(ui, {
            createDefaultEditor: () => inner,
            isOpenTrigger: (d) => d === LEFT,
            canOpen: () => true,
            onOpen: () => { openedAfterReload += 10; },
        });
        assert.equal(calls.set, 1);
        editor.handleInput(LEFT);
        assert.equal(openedAfterReload, 11);
    });

    // @covers navigator.hardening
    // @level unit
    it("session_shutdown still clears footer keys and dispose slot under the TUI guard", () => {
        // Behavior-driven reload proof lives in
        // tests/navigator_reload_extension_path.test.mjs (registered factory →
        // open → detail+arm → second session_start). This unit pin only keeps
        // the shutdown teardown contract visible next to the other S3 pins.
        const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.ts"), "utf8");
        const shut = src.slice(src.indexOf('pi.on("session_shutdown"'));
        assert.ok(shut.includes("isNavigatorUiAvailable(ctx)"));
        assert.ok(shut.includes("NAVIGATOR_STATUS_KEY"));
        assert.ok(shut.includes("CLOSE_CONFIRM_STATUS_KEY"));
        assert.ok(shut.includes("disposeTrackedNavigator(navigatorDisposeSlot)"));
    });
});

// ---------------------------------------------------------------------------
// S4 — non-TUI isolation + widget non-regression pin
// ---------------------------------------------------------------------------
describe("navigator hardening: non-TUI + widget isolation", () => {
    // @covers navigator.hardening
    // @level unit
    it("isNavigatorUiAvailable rejects print/RPC and requires mode:tui", () => {
        assert.equal(isNavigatorUiAvailable(undefined), false);
        assert.equal(isNavigatorUiAvailable({}), false);
        assert.equal(isNavigatorUiAvailable({ hasUI: true, ui: {} }), false, "hasUI alone is not enough");
        assert.equal(isNavigatorUiAvailable({ mode: "rpc", hasUI: true, ui: {} }), false);
        assert.equal(isNavigatorUiAvailable({ mode: "print", hasUI: false }), false);
        assert.equal(isNavigatorUiAvailable({ mode: "tui", hasUI: true, ui: {} }), true);
    });

    // @covers navigator.hardening
    // @level unit
    it("RPC-shaped context never reaches footer/editor/overlay seams when gated", () => {
        const ui = {
            statuses: [],
            setStatus(k, v) { this.statuses.push([k, v]); },
            setEditorComponent() { throw new Error("setEditorComponent must not run in RPC"); },
            getEditorComponent() { return undefined; },
            custom() { throw new Error("custom must not run in RPC"); },
        };
        const ctx = { mode: "rpc", hasUI: true, ui };
        assert.equal(isNavigatorUiAvailable(ctx), false);
        // Mimic index.ts entry guards: only call UI when available.
        if (isNavigatorUiAvailable(ctx)) {
            applyNavigatorFooter(ui, 1);
            installNavigatorEditor(ui, {
                createDefaultEditor: () => ({}),
                isOpenTrigger: () => false,
                canOpen: () => false,
                onOpen: () => {},
            });
            showNavigator(ui, [row("sa_x")], { matchKey: () => false, truncate });
        }
        assert.deepEqual(ui.statuses, []);
    });

    // @covers navigator.hardening
    // @level unit
    it("widget.mjs is untouched by the navigator module (passive widget separation)", () => {
        const widgetSrc = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "widget.mjs"), "utf8");
        const navSrc = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "navigator.mjs"), "utf8");
        assert.ok(!widgetSrc.includes("navigator"), "widget must not import or reference navigator");
        assert.ok(
            navSrc.includes("passive live widget is untouched") || navSrc.includes("passive"),
            "navigator documents passive-widget separation",
        );
        // index.ts must not route navigator input through setWidget.
        const indexSrc = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.ts"), "utf8");
        assert.ok(indexSrc.includes('setWidget("subagents"'), "widget path still present");
        // Navigator uses custom() overlay, not setWidget.
        assert.ok(indexSrc.includes("openTrackedNavigator") || indexSrc.includes("showNavigator"));
    });

    // @covers navigator.hardening
    // @level unit
    it("visible navigator set still excludes dismissed runs while tools list remains separate", () => {
        const id = trackDisk(`sa_t48_vis_${Date.now()}`);
        writeMeta({
            id,
            name: "keep",
            status: "completed",
            pid: 0,
            spawnPid: THIS_PID,
            cwd: "/tmp",
            promptPreview: "t48",
            startedAt: 1,
            endedAt: 2,
            logPath: "/tmp/t48.log",
            sessionId: id,
        });
        const before = navigatorVisibleCount(listMetas(), THIS_PID);
        assert.ok(navigatorVisibleRuns(listMetas(), THIS_PID).some((m) => m.id === id));
        dismissRun(id, 99);
        assert.ok(!navigatorVisibleRuns(listMetas(), THIS_PID).some((m) => m.id === id));
        assert.equal(navigatorVisibleCount(listMetas(), THIS_PID), before - 1);
        // buildNavigatorRows only sees what the caller passes (visibility seam).
        const rows = buildNavigatorRows(navigatorVisibleRuns(listMetas(), THIS_PID), {
            effectiveStatus,
            shortModel,
            fmtElapsed,
            spendFor: () => "",
            now: 100,
        });
        assert.ok(!rows.some((r) => r.id === id));
    });
});

// ---------------------------------------------------------------------------
// Docs pin — user-facing controls described in README
// ---------------------------------------------------------------------------
describe("navigator hardening: documentation", () => {
    // @covers navigator.hardening
    // @level unit
    it("README documents empty-editor ←, list/detail controls, two-press x, navigator-only dismiss, tools", () => {
        const readme = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "README.md"), "utf8");
        assert.ok(/subagent navigator|navigator/i.test(readme), "README mentions the navigator");
        assert.ok(/empty|←|left/i.test(readme), "README describes empty-editor ← open");
        assert.ok(/↑|up|down|enter|esc/i.test(readme), "README describes list/detail controls");
        assert.ok(/two-press|x again|press x/i.test(readme), "README describes two-press x stop\/dismiss");
        assert.ok(/x` arms Stop|x` arms Stop/i.test(readme), "README labels the x action as Stop instead of Close");
        assert.ok(/dismiss/i.test(readme), "README describes dismissal");
        assert.ok(/subagent_list|subagent_stop|tool/i.test(readme), "README notes tool access unchanged");
    });
});
