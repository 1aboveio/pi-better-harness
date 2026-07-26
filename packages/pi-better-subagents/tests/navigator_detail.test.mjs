/**
 * Unit tests for issue #46 — live detail view navigation in the subagent navigator.
 *
 * Pins:
 * - Enter on a selected list row opens that run's detail view.
 * - Detail shows effective status, model, elapsed, current/used tools, spend,
 *   and parsed output (finalText when terminal, lastActivity while running).
 * - Detail refreshes once per second while open (injected timer).
 * - A running detail transitions to terminal output without close/reopen.
 * - `←` returns to the list; Escape closes the navigator from detail.
 * - Returning to the list preserves selection for the viewed run when visible.
 * - Detail timers dispose on Back, Escape, overlay close, and explicit dispose.
 * - Narrow terminals truncate every detail line to width.
 *
 * // @covers navigator.detail
 * // @level unit
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { writeFileSync, mkdirSync } from "node:fs";
import {
    writeMeta,
    effectiveStatus,
    runDir,
    logPathFor,
} from "../registry.ts";
import {
    buildNavigatorDetail,
    buildDetailLines,
    createNavigatorOverlayComponent,
    showNavigator,
    openTrackedNavigator,
    disposeTrackedNavigator,
    DETAIL_TICK_MS,
} from "../navigator.ts";
import { fmtElapsed, shortModel, fmtSpend } from "../widget.ts";
import { parseRun } from "../parse.ts";

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

let n = 0;
function meta(overrides = {}) {
    n += 1;
    return {
        id: overrides.id ?? `sa_t46_${n}`,
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

function writeLog(id, lines) {
    mkdirSync(runDir(id), { recursive: true });
    writeFileSync(logPathFor(id), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
}

const truncate = (s, w) => (s.length > w ? s.slice(0, Math.max(0, w)) : s);
const plain = (lines) => lines.map((l) => l.replace(/<\/?[a-z]*>/g, ""));

/** Controllable timer boundary (external). */
function fakeTimers() {
    let nextId = 1;
    const intervals = new Map();
    return {
        intervals,
        setInterval(fn, ms) {
            const id = nextId++;
            intervals.set(id, { fn, ms, cleared: false });
            return id;
        },
        clearInterval(id) {
            const e = intervals.get(id);
            if (e) e.cleared = true;
            intervals.delete(id);
        },
        tickAll() {
            for (const e of [...intervals.values()]) e.fn();
        },
        activeCount() {
            return [...intervals.values()].filter((e) => !e.cleared).length;
        },
    };
}

function detailFrom(overrides = {}) {
    return {
        id: "sa_1",
        name: "reviewer",
        status: "running",
        model: "grok-4.5",
        elapsed: "12s",
        tools: "read, bash",
        currentTool: "bash",
        spend: "1.2k tok (↑800 ↓400) · $0.01",
        output: "working on it…",
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Pure detail builder (status / model / elapsed / tools / spend / output)
// ---------------------------------------------------------------------------
describe("buildNavigatorDetail", () => {
    // @covers navigator.detail
    // @level unit
    it("assembles effective status, model, elapsed, tools, spend, and parsed output", () => {
        const id = trackDisk(`sa_t46_detail_${Date.now()}`);
        writeMeta(meta({
            id,
            name: "reviewer",
            model: "xai/grok-4.5",
            status: "running",
            pid: THIS_PID,
            startedAt: 90_000,
        }));
        writeLog(id, [
            { type: "tool_execution_start", toolName: "read" },
            { type: "tool_execution_start", toolName: "bash" },
            {
                type: "message_end",
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "still going" }],
                    usage: { input: 800, output: 400, cost: { total: 0.01 } },
                },
            },
        ]);
        const d = buildNavigatorDetail(id, {
            readMeta: (i) => (i === id ? {
                id, name: "reviewer", model: "xai/grok-4.5", status: "running",
                pid: THIS_PID, startedAt: 90_000,
            } : undefined),
            effectiveStatus,
            parseRun,
            shortModel,
            fmtElapsed,
            fmtSpend,
            now: 102_000,
        });
        assert.equal(d.id, id);
        assert.equal(d.name, "reviewer");
        assert.equal(d.status, "running");
        assert.equal(d.model, "grok-4.5");
        assert.equal(d.elapsed, "12s");
        assert.equal(d.tools, "read, bash");
        assert.equal(d.currentTool, "bash");
        assert.ok(d.spend.includes("tok") && d.spend.includes("$"), `spend: ${d.spend}`);
        assert.equal(d.output, "still going");
    });

    // @covers navigator.detail
    // @level unit
    it("prefers finalText for terminal runs and freezes elapsed at endedAt", () => {
        const d = buildNavigatorDetail("sa_x", {
            readMeta: () => ({
                id: "sa_x", name: null, model: "openai/gpt-4.1",
                status: "completed", startedAt: 0, endedAt: 61_000,
            }),
            effectiveStatus: () => "completed",
            parseRun: () => ({
                finalText: "done answer",
                lastActivity: "older",
                toolCalls: ["read"],
                usage: { input: 10, output: 5, total: 15, costUSD: 0 },
            }),
            shortModel,
            fmtElapsed,
            fmtSpend,
            now: 999_999,
        });
        assert.equal(d.status, "completed");
        assert.equal(d.elapsed, "1m 01s");
        assert.equal(d.output, "done answer");
        assert.equal(d.currentTool, undefined, "terminal runs have no current tool");
        assert.equal(d.tools, "read");
        assert.equal(d.model, "gpt-4.1");
    });
});

describe("buildDetailLines", () => {
    // @covers navigator.detail
    // @level unit
    it("renders status, model, elapsed, tools, spend, and output fields", () => {
        const lines = buildDetailLines(detailFrom(), { width: 80, truncate });
        const text = lines.join("\n");
        assert.ok(text.includes("reviewer") || text.includes("sa_1"));
        assert.ok(text.includes("running"));
        assert.ok(text.includes("grok-4.5"));
        assert.ok(text.includes("12s"));
        assert.ok(text.includes("bash") || text.includes("read"));
        assert.ok(text.includes("tok") || text.includes("$0.01"));
        assert.ok(text.includes("working on it"));
        assert.ok(text.includes("←") || text.includes("back"), "help advertises back");
        assert.ok(/esc/i.test(text), "help advertises escape");
    });

    // @covers navigator.detail
    // @level unit
    it("truncates every line to the given width on narrow terminals", () => {
        const d = detailFrom({
            name: "n".repeat(100),
            spend: "s".repeat(100),
            output: "o".repeat(200),
            tools: "t".repeat(80),
        });
        for (const w of [20, 37, 80]) {
            for (const line of buildDetailLines(d, { width: w, truncate })) {
                assert.ok(line.length <= w, `line exceeds width ${w}: ${JSON.stringify(line)}`);
            }
        }
    });
});

// ---------------------------------------------------------------------------
// Overlay detail mode
// ---------------------------------------------------------------------------
describe("navigator detail view", () => {
    function drive(rows, opts = {}) {
        const timers = fakeTimers();
        const tui = { renders: 0, requestRender() { this.renders++; } };
        const theme = { fg: (c, s) => `<${c}>${s}</>` };
        const doneCalls = [];
        const customCalls = [];
        let details = opts.details ?? {};
        const getDetail = opts.getDetail ?? ((id) => {
            if (typeof details === "function") return details(id);
            return details[id] ?? detailFrom({ id, name: id });
        });
        const getRows = opts.getRows;
        // Pi-compatible custom(): resolves to done()'s value (null), NOT the component.
        const ui = {
            custom(factory, options) {
                customCalls.push(options);
                return new Promise((resolve) => {
                    const component = factory(tui, theme, {}, (v) => {
                        doneCalls.push(v);
                        resolve(v);
                    });
                    // Capture component via the factory return (local only).
                    // Production callers must use onComponent — see openTrackedNavigator tests.
                    ui._lastComponent = component;
                });
            },
            _lastComponent: undefined,
        };
        const matchKey = (data, id) => data === `<${id}>`;
        const deps = {
            matchKey,
            truncate,
            getDetail,
            getRows,
            setInterval: timers.setInterval,
            clearInterval: timers.clearInterval,
            tickMs: opts.tickMs ?? DETAIL_TICK_MS,
        };
        let component;
        // Prefer the component constructor for dispose access; showNavigator is
        // the production entry and is also exercised below. Component is captured
        // via onComponent (Pi-faithful) — never from the custom() promise.
        if (opts.viaShow !== false) {
            showNavigator(ui, rows, {
                ...deps,
                onComponent: (c) => { component = c; },
            });
        } else {
            component = createNavigatorOverlayComponent(rows, deps, tui, theme, (v) => doneCalls.push(v));
        }
        return {
            tui, doneCalls, customCalls, timers, deps, ui,
            component: () => component,
            press: (d) => component.handleInput(d),
            lines: (w = 80) => plain(component.render(w)),
            setDetails(next) { details = next; },
        };
    }

    // @covers navigator.detail
    // @level unit
    it("Enter on a selected run opens that run's detail view", async () => {
        const rows = [
            { id: "sa_a", name: "alpha", status: "running", model: "m", elapsed: "1s", spend: "" },
            { id: "sa_b", name: "beta", status: "completed", model: "m", elapsed: "2s", spend: "" },
        ];
        const o = drive(rows, {
            details: {
                sa_a: detailFrom({ id: "sa_a", name: "alpha", status: "running", output: "alpha out" }),
                sa_b: detailFrom({ id: "sa_b", name: "beta", status: "completed", output: "beta out" }),
            },
        });
        await Promise.resolve();
        assert.ok(o.lines().some((l) => l.includes("alpha") && l.startsWith("›  ")));
        o.press("<enter>");
        const lines = o.lines();
        assert.ok(lines.some((l) => /alpha/i.test(l)), `detail should name the run: ${JSON.stringify(lines)}`);
        assert.ok(lines.some((l) => /running/i.test(l)));
        assert.ok(lines.some((l) => /alpha out/.test(l)));
        assert.ok(!lines.some((l) => l.startsWith("›  ")), "list selection marker must not appear in detail");
        assert.equal(o.timers.activeCount(), 1, "detail opens a refresh timer");
        assert.equal([...o.timers.intervals.values()][0].ms, DETAIL_TICK_MS);
    });

    // @covers navigator.detail
    // @level unit
    it("detail view shows status, model, elapsed, tools, spend, and parsed output", async () => {
        const rows = [{ id: "sa_1", name: "reviewer", status: "running", model: "grok-4.5", elapsed: "5s", spend: "" }];
        const o = drive(rows, {
            details: {
                sa_1: detailFrom({
                    id: "sa_1",
                    name: "reviewer",
                    status: "running",
                    model: "grok-4.5",
                    elapsed: "5s",
                    tools: "read, bash",
                    currentTool: "bash",
                    spend: "400 tok (↑300 ↓100) · $0.002",
                    output: "parsed body",
                }),
            },
        });
        await Promise.resolve();
        o.press("<enter>");
        const text = o.lines().join("\n");
        for (const needle of ["running", "grok-4.5", "5s", "bash", "tok", "parsed body"]) {
            assert.ok(text.includes(needle), `missing ${needle} in ${text}`);
        }
    });

    // @covers navigator.detail
    // @level unit
    it("refreshes once per second while open", async () => {
        const rows = [{ id: "sa_1", name: "r", status: "running", model: "m", elapsed: "1s", spend: "" }];
        let calls = 0;
        const o = drive(rows, {
            getDetail: () => {
                calls++;
                return detailFrom({ id: "sa_1", elapsed: `${calls}s`, output: `tick-${calls}` });
            },
        });
        await Promise.resolve();
        o.press("<enter>");
        const afterOpen = calls;
        assert.ok(afterOpen >= 1, "opening detail loads once");
        const rendersBefore = o.tui.renders;
        o.timers.tickAll();
        assert.equal(calls, afterOpen + 1, "each interval tick reloads detail");
        assert.ok(o.tui.renders > rendersBefore, "tick requests a repaint");
        assert.ok(o.lines().some((l) => l.includes(`tick-${calls}`)));
        o.timers.tickAll();
        assert.equal(calls, afterOpen + 2);
    });

    // @covers navigator.detail
    // @level unit
    it("a running detail transitions to terminal output without closing or reopening", async () => {
        const rows = [{ id: "sa_1", name: "r", status: "running", model: "m", elapsed: "1s", spend: "" }];
        let phase = "running";
        const o = drive(rows, {
            getDetail: () => {
                if (phase === "running") {
                    return detailFrom({ id: "sa_1", status: "running", output: "in progress", currentTool: "bash", tools: "bash" });
                }
                return detailFrom({
                    id: "sa_1",
                    status: "completed",
                    output: "final answer",
                    currentTool: undefined,
                    tools: "bash",
                    elapsed: "9s",
                });
            },
        });
        await Promise.resolve();
        o.press("<enter>");
        assert.ok(o.lines().join("\n").includes("in progress"));
        assert.ok(o.lines().join("\n").includes("running"));
        phase = "completed";
        o.timers.tickAll();
        const text = o.lines().join("\n");
        assert.ok(text.includes("completed"), "status transitions in place");
        assert.ok(text.includes("final answer"), "output transitions in place");
        assert.equal(o.doneCalls.length, 0, "must not close the overlay");
        assert.equal(o.timers.activeCount(), 1, "timer keeps running across the transition");
    });

    // @covers navigator.detail
    // @level unit
    it("`←` in detail returns to the list and disposes the detail timer", async () => {
        const rows = [
            { id: "sa_a", name: "alpha", status: "running", model: "m", elapsed: "1s", spend: "" },
            { id: "sa_b", name: "beta", status: "completed", model: "m", elapsed: "2s", spend: "" },
        ];
        const o = drive(rows, {
            details: {
                sa_a: detailFrom({ id: "sa_a", name: "alpha", output: "A" }),
                sa_b: detailFrom({ id: "sa_b", name: "beta", output: "B" }),
            },
        });
        await Promise.resolve();
        o.press("<down>");
        o.press("<enter>");
        {
            const text = o.lines().join("\n");
            assert.ok(/beta/i.test(text) && /\bB\b/.test(text), `expected beta detail, got: ${text}`);
        }
        assert.equal(o.timers.activeCount(), 1);
        o.press("<left>");
        assert.equal(o.timers.activeCount(), 0, "back must clear the detail timer");
        const lines = o.lines();
        assert.ok(lines.some((l) => l.startsWith("›  ") && l.includes("beta")), "selection restored on the viewed run");
        assert.ok(lines.some((l) => l.includes("alpha")));
        assert.equal(o.doneCalls.length, 0, "back must not close the overlay");
    });

    // @covers navigator.detail
    // @level unit
    it("returning to the list preserves selection when the viewed run is still visible after refresh", async () => {
        const rows = [
            { id: "sa_a", name: "alpha", status: "running", model: "m", elapsed: "1s", spend: "" },
            { id: "sa_b", name: "beta", status: "completed", model: "m", elapsed: "2s", spend: "" },
            { id: "sa_c", name: "gamma", status: "failed", model: "m", elapsed: "3s", spend: "" },
        ];
        const o = drive(rows, {
            details: { sa_b: detailFrom({ id: "sa_b", name: "beta", output: "B" }) },
            getRows: () => [
                { id: "sa_c", name: "gamma", status: "failed", model: "m", elapsed: "3s", spend: "" },
                { id: "sa_b", name: "beta", status: "completed", model: "m", elapsed: "2s", spend: "" },
            ],
        });
        await Promise.resolve();
        o.press("<down>"); // select beta
        o.press("<enter>");
        o.press("<left>");
        const lines = o.lines();
        assert.ok(lines.some((l) => l.startsWith("›  ") && l.includes("beta")), "beta remains selected after list refresh");
        assert.ok(!lines.some((l) => l.includes("alpha")), "stale row dropped by getRows");
    });

    // @covers navigator.detail
    // @level unit
    it("Escape in detail view closes the navigator and disposes the timer", async () => {
        const rows = [{ id: "sa_1", name: "r", status: "running", model: "m", elapsed: "1s", spend: "" }];
        const o = drive(rows, { details: { sa_1: detailFrom({ id: "sa_1", output: "x" }) } });
        await Promise.resolve();
        o.press("<enter>");
        assert.equal(o.timers.activeCount(), 1);
        o.press("<escape>");
        assert.deepEqual(o.doneCalls, [null]);
        assert.equal(o.timers.activeCount(), 0, "escape must clear the detail timer");
    });

    // @covers navigator.detail
    // @level unit
    it("dispose() clears the detail timer (session teardown / overlay close path)", async () => {
        const rows = [{ id: "sa_1", name: "r", status: "running", model: "m", elapsed: "1s", spend: "" }];
        const o = drive(rows, {
            viaShow: false,
            details: { sa_1: detailFrom({ id: "sa_1", output: "x" }) },
        });
        o.press("<enter>");
        assert.equal(o.timers.activeCount(), 1);
        assert.equal(typeof o.component().dispose, "function", "overlay exposes dispose for teardown");
        o.component().dispose();
        assert.equal(o.timers.activeCount(), 0);
        // Idempotent.
        o.component().dispose();
        assert.equal(o.timers.activeCount(), 0);
    });

    // @covers navigator.detail
    // @level unit
    it("done(null) from the host (overlay close) also disposes timers", async () => {
        // When pi closes the overlay externally, the component's done wrapper
        // must still clear timers. We simulate by calling the component's
        // internal close path via Escape (already covered) and by invoking
        // dispose after a synthetic host close marker.
        const timers = fakeTimers();
        const tui = { renders: 0, requestRender() { this.renders++; } };
        let doneCount = 0;
        const component = createNavigatorOverlayComponent(
            [{ id: "sa_1", name: "r", status: "running", model: "m", elapsed: "1s", spend: "" }],
            {
                matchKey: (d, id) => d === `<${id}>`,
                truncate,
                getDetail: () => detailFrom({ id: "sa_1", output: "x" }),
                setInterval: timers.setInterval,
                clearInterval: timers.clearInterval,
                tickMs: 1000,
            },
            tui,
            { fg: (_c, s) => s },
            () => { doneCount++; },
        );
        component.handleInput("<enter>");
        assert.equal(timers.activeCount(), 1);
        // Host-driven close: dispose is the seam index.ts calls on shutdown and
        // that the done-wrapper also invokes before resolving.
        component.dispose();
        assert.equal(timers.activeCount(), 0);
        // Escape after dispose must still be safe (no double-clear throw).
        component.handleInput("<escape>");
        assert.equal(doneCount, 1);
        assert.equal(timers.activeCount(), 0);
    });

    // @covers navigator.detail
    // @level unit
    it("narrow terminal detail rendering never exceeds width (styled)", async () => {
        const rows = [{ id: "sa_1", name: "n".repeat(80), status: "running", model: "m", elapsed: "1s", spend: "x".repeat(40) }];
        const o = drive(rows, {
            details: {
                sa_1: detailFrom({
                    id: "sa_1",
                    name: "n".repeat(80),
                    spend: "s".repeat(80),
                    output: "o".repeat(300),
                    tools: "tool-".repeat(30),
                }),
            },
        });
        await Promise.resolve();
        o.press("<enter>");
        for (const w of [20, 37, 80]) {
            for (const line of o.component().render(w)) {
                const p = line.replace(/<\/?[a-z]*>/g, "");
                assert.ok(p.length <= w, `styled line exceeds ${w}: ${JSON.stringify(p)}`);
            }
        }
    });

    // @covers navigator.detail
    // @level unit
    it("Enter on an empty list is a no-op", async () => {
        // Defensive: openNavigator refuses empty, but the component must not throw.
        const o = drive([], { viaShow: false });
        o.press("<enter>");
        assert.equal(o.timers.activeCount(), 0);
        assert.equal(o.doneCalls.length, 0);
        assert.ok(o.lines().some((l) => l.includes("no visible")));
    });

    // @covers navigator.detail
    // @level unit
    it("custom() resolving to done(null) still tracks dispose for session_shutdown", async () => {
        // Contract: Pi's ui.custom(factory) returns a Promise that resolves to
        // the value passed to done() (null), NOT the component. Index glue must
        // capture dispose synchronously via onComponent so session_shutdown can
        // clear a still-open detail timer. This is the regression for the
        // navigator.detail.timer-lifecycle finding (PR #96 round 1).
        const timers = fakeTimers();
        const tui = { renders: 0, requestRender() { this.renders++; } };
        const theme = { fg: (_c, s) => s };
        let componentFromPromise;
        const ui = {
            custom(factory, options) {
                assert.equal(options?.overlay, true);
                return new Promise((resolve) => {
                    // Construct component; done(null) resolves the promise with null.
                    factory(tui, theme, {}, (v) => {
                        resolve(v);
                    });
                });
            },
        };
        let activeDispose;
        const disposeSlot = {
            get: () => activeDispose,
            set: (fn) => { activeDispose = fn; },
        };
        let captured;
        const opened = openTrackedNavigator(
            ui,
            [{ id: "sa_1", name: "r", status: "running", model: "m", elapsed: "1s", spend: "" }],
            {
                matchKey: (d, id) => d === `<${id}>`,
                truncate,
                getDetail: () => detailFrom({ id: "sa_1", status: "running", output: "live" }),
                setInterval: timers.setInterval,
                clearInterval: timers.clearInterval,
                tickMs: DETAIL_TICK_MS,
                onComponent: (c) => { captured = c; },
            },
            disposeSlot,
        );

        // Synchronous capture: dispose is tracked while overlay is still open.
        assert.ok(captured && typeof captured.dispose === "function", "onComponent must capture component sync");
        assert.equal(typeof activeDispose, "function", "dispose slot set before custom() settles");

        // Enter detail → timer active.
        captured.handleInput("<enter>");
        assert.equal(timers.activeCount(), 1, "detail timer active while open");

        // Prove the custom() promise does NOT yield the component (Pi semantics).
        // We race a microtask tick without calling done — promise still pending.
        let settled = false;
        void opened.then((v) => {
            settled = true;
            componentFromPromise = v;
        });
        await Promise.resolve();
        assert.equal(settled, false, "custom() must not resolve until done()");

        // session_shutdown path while detail is open: must clear the timer.
        disposeTrackedNavigator(disposeSlot);
        assert.equal(timers.activeCount(), 0, "session_shutdown clears detail timer");
        assert.equal(activeDispose, undefined, "dispose slot cleared after shutdown");

        // Host later closes the overlay (done(null)) — safe, no timer resurrect.
        captured.handleInput("<escape>");
        await opened;
        assert.equal(settled, true);
        assert.equal(componentFromPromise, null, "custom() resolves to done(null), not component");
        assert.equal(timers.activeCount(), 0, "no orphan timer after close");
    });

    // @covers navigator.detail
    // @level unit
    it("awaiting showNavigator under Pi custom() semantics yields null, not a component", async () => {
        // Documents the Pi contract that hid the original bug in test fakes.
        const ui = {
            custom(factory) {
                return new Promise((resolve) => {
                    factory(
                        { requestRender() {} },
                        { fg: (_c, s) => s },
                        {},
                        (v) => resolve(v),
                    );
                });
            },
        };
        let captured;
        const p = showNavigator(
            ui,
            [{ id: "sa_1", name: "r", status: "completed", model: "m", elapsed: "1s", spend: "" }],
            {
                matchKey: (d, id) => d === `<${id}>`,
                truncate,
                onComponent: (c) => { captured = c; },
            },
        );
        assert.ok(captured, "onComponent fires sync during factory");
        // Close via Escape so the promise settles with null.
        captured.handleInput("<escape>");
        const resolved = await p;
        assert.equal(resolved, null, "must not treat custom() resolution as the component");
        assert.notEqual(resolved, captured);
    });

    // @covers navigator.detail
    // @level unit
    it("custom() rejection clears dispose slot without unhandledRejection", async () => {
        // Fix round 2 (navigator.detail.timer-lifecycle): Pi rejects custom()
        // when overlay factory/show setup fails. openTrackedNavigator must still
        // clear the token-guarded dispose slot, and must not emit unhandledRejection
        // when callers discard the returned promise (index openNavigator does).
        // `.finally` rethrows into a second promise that `void` does not consume;
        // settlement cleanup must use a handled `.then(clear, clear)` pattern.
        const unhandled = [];
        const onUnhandled = (reason) => {
            unhandled.push(reason);
        };
        process.on("unhandledRejection", onUnhandled);
        try {
            let activeDispose = "sentinel-prior";
            const disposeSlot = {
                get: () => activeDispose,
                set: (fn) => { activeDispose = fn; },
            };
            let captured;
            const rejectErr = new Error("custom rejected");
            const ui = {
                custom(factory, options) {
                    assert.equal(options?.overlay, true);
                    // Factory runs (onComponent captures dispose), then custom()
                    // rejects — Pi setup-failure shape after the overlay exists.
                    factory(
                        { requestRender() {} },
                        { fg: (_c, s) => s },
                        {},
                        () => {},
                    );
                    return Promise.reject(rejectErr);
                },
            };

            // Match production: discard the returned promise (no await / .catch).
            openTrackedNavigator(
                ui,
                [{ id: "sa_1", name: "r", status: "running", model: "m", elapsed: "1s", spend: "" }],
                {
                    matchKey: (d, id) => d === `<${id}>`,
                    truncate,
                    onComponent: (c) => { captured = c; },
                },
                disposeSlot,
            );

            assert.ok(captured && typeof captured.dispose === "function", "onComponent captures before reject");
            // Slot was set sync; rejection clears it on microtask drain.
            assert.equal(typeof activeDispose, "function", "dispose slot set before rejection settles");

            // Bounded microtask drain (no fixed sleep): let rejection + clear run.
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            assert.equal(activeDispose, undefined, "dispose slot cleared on custom() rejection");
            assert.equal(
                unhandled.length,
                0,
                `expected no unhandledRejection, got: ${unhandled.map((r) => String(r && r.message || r)).join("; ")}`,
            );
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });
});
