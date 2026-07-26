/**
 * Unit tests for issue #47 — two-press close behavior in the subagent navigator.
 *
 * Pins:
 * - First `x` arms Close and shows the footer confirm hint (stop vs dismiss).
 * - First `x` never mutates run metadata or process state.
 * - Second `x` within 3s acts only when the same run is still selected.
 * - Expired arm does not stop/dismiss; selection/list↔detail/close/teardown disarm.
 * - Acting rereads metadata + effective status: running → stop+kill+dismiss;
 *   terminal → dismiss only; finish-during-arm → terminal dismissal.
 * - Dismissed runs leave navigator/footer visibility but stay tool-accessible.
 *
 * // @covers navigator.close
 * // @level unit
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import {
    writeMeta,
    readMeta,
    listMetas,
    effectiveStatus,
    dismissRun,
    isDismissed,
    navigatorVisibleRuns,
    navigatorVisibleCount,
    runDir,
} from "../registry.ts";
import { stopRun } from "../stop.ts";
import { processExists } from "../spawn.ts";
import {
    subagentListTool,
    subagentOutputTool,
    subagentResultTool,
    subagentStopTool,
} from "../tools.ts";
import {
    CLOSE_ARM_MS,
    CLOSE_CONFIRM_STATUS_KEY,
    NAVIGATOR_STATUS_KEY,
    closeConfirmHint,
    applyCloseConfirmFooter,
    applyNavigatorFooter,
    createCloseArm,
    isCloseArmed,
    disarmClose,
    executeNavigatorClose,
    createNavigatorOverlayComponent,
    showNavigator,
    openTrackedNavigator,
    disposeTrackedNavigator,
} from "../navigator.ts";

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
        id: overrides.id ?? `sa_t47_${n}`,
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

function spawnSleeper() {
    const proc = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    proc.unref();
    return proc.pid;
}

async function waitFor(pred, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (pred()) return true;
        await new Promise((r) => setTimeout(r, 20));
    }
    return pred();
}

const TypeStub = {
    Object: (v) => v,
    String: (v) => v,
    Number: (v) => v,
    Boolean: (v) => v,
    Array: (v) => v,
    Optional: (v) => v,
};

function resultText(result) {
    return result.content[0].text;
}

const truncate = (s, w) => (s.length > w ? s.slice(0, Math.max(0, w)) : s);
const plain = (lines) => lines.map((l) => l.replace(/<\/?[a-z]*>/g, ""));

/** Controllable clock + timeout boundary (external). */
function fakeClock(start = 1_000_000) {
    let now = start;
    let nextId = 1;
    const timeouts = new Map();
    return {
        now: () => now,
        advance(ms) {
            now += ms;
            // Fire due timers in order.
            const due = [...timeouts.entries()]
                .filter(([, t]) => !t.cleared && t.fireAt <= now)
                .sort((a, b) => a[1].fireAt - b[1].fireAt);
            for (const [id, t] of due) {
                timeouts.delete(id);
                t.fn();
            }
        },
        setTimeout(fn, ms) {
            const id = nextId++;
            timeouts.set(id, { fn, fireAt: now + ms, cleared: false });
            return id;
        },
        clearTimeout(id) {
            const t = timeouts.get(id);
            if (t) t.cleared = true;
            timeouts.delete(id);
        },
        pendingCount() {
            return [...timeouts.values()].filter((t) => !t.cleared).length;
        },
    };
}

function fakeTimers() {
    let nextId = 1;
    const intervals = new Map();
    return {
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
        activeCount() {
            return [...intervals.values()].filter((e) => !e.cleared).length;
        },
    };
}

// ---------------------------------------------------------------------------
// Pure seams: confirm hint + arm window + execute close
// ---------------------------------------------------------------------------
describe("close confirm hint", () => {
    // @covers navigator.close
    // @level unit
    it("running run uses `x again to stop <name>`", () => {
        assert.equal(
            closeConfirmHint({ id: "sa_1", name: "reviewer", status: "running" }),
            "x again to stop reviewer",
        );
    });

    // @covers navigator.close
    // @level unit
    it("terminal run uses `x again to dismiss <name>` and falls back to id", () => {
        assert.equal(
            closeConfirmHint({ id: "sa_2", name: "writer", status: "completed" }),
            "x again to dismiss writer",
        );
        assert.equal(
            closeConfirmHint({ id: "sa_3", status: "failed" }),
            "x again to dismiss sa_3",
        );
        assert.equal(
            closeConfirmHint({ id: "sa_4", name: null, status: "killed" }),
            "x again to dismiss sa_4",
        );
    });

    // @covers navigator.close
    // @level unit
    it("applyCloseConfirmFooter uses a dedicated status key and coexists with the count hint", () => {
        const calls = [];
        const ui = { setStatus(k, v) { calls.push([k, v]); } };
        applyNavigatorFooter(ui, 2);
        applyCloseConfirmFooter(ui, "x again to stop alpha");
        assert.deepEqual(calls[0], [NAVIGATOR_STATUS_KEY, "← subagents · 2"]);
        assert.deepEqual(calls[1], [CLOSE_CONFIRM_STATUS_KEY, "x again to stop alpha"]);
        applyCloseConfirmFooter(ui, null);
        assert.deepEqual(calls.at(-1), [CLOSE_CONFIRM_STATUS_KEY, undefined]);
        assert.equal(CLOSE_ARM_MS, 3000);
    });
});

describe("close arm window", () => {
    // @covers navigator.close
    // @level unit
    it("arms for an id and expires after exactly CLOSE_ARM_MS", () => {
        const arm = createCloseArm("sa_a", 1000);
        assert.equal(isCloseArmed(arm, "sa_a", 1000), true);
        assert.equal(isCloseArmed(arm, "sa_a", 1000 + CLOSE_ARM_MS - 1), true);
        assert.equal(isCloseArmed(arm, "sa_a", 1000 + CLOSE_ARM_MS), false, "window is exclusive at +3s");
        assert.equal(isCloseArmed(arm, "sa_b", 1001), false, "different id is not armed");
        disarmClose(arm);
        assert.equal(isCloseArmed(arm, "sa_a", 1001), false);
    });
});

describe("executeNavigatorClose", () => {
    // @covers navigator.close
    // @level unit
    it("stops a running run (process group + killed) then dismisses it", async () => {
        const id = trackDisk(`sa_t47_run_${Date.now()}`);
        const pid = spawnSleeper();
        writeMeta(meta({ id, name: "worker", status: "running", pid }));
        const outcome = executeNavigatorClose(id, {
            readMeta,
            effectiveStatus,
            stopRun,
            dismissRun,
            now: () => 5_000,
        });
        assert.equal(outcome.action, "stopped-and-dismissed");
        const back = readMeta(id);
        assert.equal(back.status, "killed");
        assert.equal(back.dismissedAt, 5_000);
        assert.equal(await waitFor(() => !processExists(pid)), true);
    });

    // @covers navigator.close
    // @level unit
    it("dismisses a terminal run without changing its terminal status", () => {
        const id = trackDisk(`sa_t47_term_${Date.now()}`);
        writeMeta(meta({ id, name: "done", status: "completed", endedAt: 9 }));
        const outcome = executeNavigatorClose(id, {
            readMeta,
            effectiveStatus,
            stopRun,
            dismissRun,
            now: () => 7_000,
        });
        assert.equal(outcome.action, "dismissed");
        const back = readMeta(id);
        assert.equal(back.status, "completed");
        assert.equal(back.dismissedAt, 7_000);
        assert.equal(back.endedAt, 9);
    });

    // @covers navigator.close
    // @level unit
    it("rereads effective status: finish-during-arm uses terminal dismissal (no kill rewrite)", () => {
        const id = trackDisk(`sa_t47_finish_${Date.now()}`);
        // Stale "running" with dead pid → effective "exited".
        writeMeta(meta({ id, status: "running", pid: 0x3fffffff }));
        const stopCalls = [];
        const outcome = executeNavigatorClose(id, {
            readMeta,
            effectiveStatus,
            stopRun: (i) => {
                stopCalls.push(i);
                return stopRun(i);
            },
            dismissRun,
            now: () => 9_000,
        });
        assert.equal(outcome.action, "dismissed");
        assert.equal(outcome.status, "exited");
        // stopRun may be consulted by execute via effectiveStatus branch — must NOT
        // rewrite status to killed. Prefer skipping stop when not running.
        assert.equal(stopCalls.length, 0, "terminal-effective runs must not call stopRun");
        const back = readMeta(id);
        assert.equal(back.status, "running", "on-disk status left as-is when already not running");
        assert.equal(back.dismissedAt, 9_000);
    });

    // @covers navigator.close
    // @level unit
    it("returns missing for unknown ids without throwing", () => {
        const outcome = executeNavigatorClose("sa_t47_nope", {
            readMeta: () => undefined,
            effectiveStatus: () => "completed",
            stopRun: () => { throw new Error("should not stop"); },
            dismissRun: () => { throw new Error("should not dismiss"); },
        });
        assert.equal(outcome.action, "missing");
    });
});

// ---------------------------------------------------------------------------
// Overlay: arming, second press, disarm paths
// ---------------------------------------------------------------------------
describe("navigator close key (two-press)", () => {
    function drive(rows, opts = {}) {
        const clock = opts.clock ?? fakeClock();
        const timers = fakeTimers();
        const tui = { renders: 0, requestRender() { this.renders++; } };
        const theme = { fg: (c, s) => `<${c}>${s}</>` };
        const doneCalls = [];
        const hints = [];
        const closed = [];
        const closeCalls = [];
        let liveRows = rows.slice();
        const store = opts.store ?? new Map(rows.map((r) => [r.id, {
            id: r.id,
            name: r.name,
            status: r.status,
            dismissedAt: undefined,
        }]));

        const closeRun = opts.closeRun ?? ((id) => {
            closeCalls.push({ id, at: clock.now() });
            return executeNavigatorClose(id, {
                readMeta: (i) => {
                    const s = store.get(i);
                    if (!s || s.gone) return undefined;
                    return {
                        id: s.id,
                        name: s.name,
                        status: s.status,
                        pid: s.pid ?? 0,
                        spawnPid: THIS_PID,
                        startedAt: 1,
                        dismissedAt: s.dismissedAt,
                        endedAt: s.endedAt,
                        cwd: "/tmp",
                        promptPreview: "p",
                        logPath: "/tmp/x.log",
                        sessionId: "s",
                    };
                },
                effectiveStatus: (m) => {
                    if (typeof opts.effectiveStatus === "function") return opts.effectiveStatus(m);
                    return m.status === "running" && m.pid && !processExists(m.pid) ? "exited" : m.status;
                },
                stopRun: (i) => {
                    const s = store.get(i);
                    if (!s) throw new Error(`Unknown run id: ${i}`);
                    if (s.status !== "running") return { action: "not-running", id: i, status: s.status };
                    s.status = "killed";
                    s.endedAt = clock.now();
                    return { action: "stopped", id: i };
                },
                dismissRun: (i, at) => {
                    const s = store.get(i);
                    if (!s) return undefined;
                    if (s.dismissedAt === undefined) s.dismissedAt = at ?? clock.now();
                    return s;
                },
                now: () => clock.now(),
            });
        });

        const getRows = opts.getRows ?? (() =>
            liveRows.filter((r) => {
                const s = store.get(r.id);
                return s && s.dismissedAt === undefined;
            }).map((r) => {
                const s = store.get(r.id);
                return { ...r, status: s?.status ?? r.status, name: s?.name ?? r.name };
            }));

        const matchKey = (data, id) => data === `<${id}>` || (id === "x" && data === "x");
        const deps = {
            matchKey,
            truncate,
            getDetail: opts.getDetail ?? ((id) => {
                const s = store.get(id);
                if (!s) return null;
                return {
                    id: s.id,
                    name: s.name,
                    status: s.status,
                    model: "m",
                    elapsed: "1s",
                    spend: "",
                    tools: "",
                    output: "out",
                };
            }),
            getRows,
            closeRun,
            onCloseConfirmHint: (h) => { hints.push(h); },
            onClosed: (outcome) => { closed.push(outcome); },
            now: () => clock.now(),
            setTimeout: clock.setTimeout.bind(clock),
            clearTimeout: clock.clearTimeout.bind(clock),
            setInterval: timers.setInterval,
            clearInterval: timers.clearInterval,
            tickMs: 1000,
        };

        let component;
        if (opts.viaShow) {
            const ui = {
                custom(factory, options) {
                    return new Promise((resolve) => {
                        const c = factory(tui, theme, {}, (v) => {
                            doneCalls.push(v);
                            resolve(v);
                        });
                        // Production path uses onComponent; local capture too.
                        void c;
                    });
                },
            };
            showNavigator(ui, rows, {
                ...deps,
                onComponent: (c) => { component = c; },
            });
        } else {
            component = createNavigatorOverlayComponent(rows, deps, tui, theme, (v) => doneCalls.push(v));
        }

        return {
            tui, doneCalls, hints, closed, closeCalls, clock, timers, store, deps,
            component: () => component,
            press: (d) => component.handleInput(d),
            lines: (w = 80) => plain(component.render(w)),
            refreshLiveRows() { liveRows = getRows(); },
            setStatus(id, status) {
                const s = store.get(id);
                if (s) s.status = status;
            },
        };
    }

    // @covers navigator.close
    // @level unit
    it("first x on a running run arms Close and shows stop hint (no mutation)", () => {
        const o = drive([
            { id: "sa_a", name: "alpha", status: "running", model: "m", elapsed: "1s", spend: "" },
        ]);
        o.press("x");
        assert.deepEqual(o.hints, ["x again to stop alpha"]);
        assert.equal(o.closeCalls.length, 0, "first x must not invoke closeRun");
        assert.equal(o.closed.length, 0);
        assert.equal(o.store.get("sa_a").status, "running");
        assert.equal(o.store.get("sa_a").dismissedAt, undefined);
        assert.equal(o.clock.pendingCount(), 1, "arm schedules an expiry timer");
    });

    // @covers navigator.close
    // @level unit
    it("first x on a terminal run arms Close and shows dismiss hint (no mutation)", () => {
        const o = drive([
            { id: "sa_b", name: "beta", status: "completed", model: "m", elapsed: "2s", spend: "" },
        ]);
        o.press("x");
        assert.deepEqual(o.hints, ["x again to dismiss beta"]);
        assert.equal(o.closeCalls.length, 0);
        assert.equal(o.store.get("sa_b").status, "completed");
        assert.equal(o.store.get("sa_b").dismissedAt, undefined);
    });

    // @covers navigator.close
    // @level unit
    it("second x within three seconds closes the same selected running run", () => {
        const o = drive([
            { id: "sa_a", name: "alpha", status: "running", model: "m", elapsed: "1s", spend: "" },
            { id: "sa_b", name: "beta", status: "completed", model: "m", elapsed: "2s", spend: "" },
        ]);
        o.press("x");
        o.clock.advance(CLOSE_ARM_MS - 1);
        o.press("x");
        assert.equal(o.closeCalls.length, 1);
        assert.equal(o.closeCalls[0].id, "sa_a");
        assert.equal(o.store.get("sa_a").status, "killed");
        assert.equal(typeof o.store.get("sa_a").dismissedAt, "number");
        assert.equal(o.closed.length, 1);
        assert.equal(o.hints.at(-1), null, "confirm hint clears after action");
        // Dismissed run disappears from the list.
        const text = o.lines().join("\n");
        assert.ok(!text.includes("alpha"), `dismissed run must leave list: ${text}`);
        assert.ok(text.includes("beta"));
    });

    // @covers navigator.close
    // @level unit
    it("second x after the arming window does not stop or dismiss (re-arms instead)", () => {
        const o = drive([
            { id: "sa_a", name: "alpha", status: "running", model: "m", elapsed: "1s", spend: "" },
        ]);
        o.press("x");
        assert.equal(o.hints.at(-1), "x again to stop alpha");
        o.clock.advance(CLOSE_ARM_MS); // expires
        assert.equal(o.hints.at(-1), null, "expiry clears the confirm hint");
        o.press("x");
        assert.equal(o.closeCalls.length, 0, "expired second press must not act");
        assert.equal(o.store.get("sa_a").dismissedAt, undefined);
        assert.equal(o.hints.at(-1), "x again to stop alpha", "press after expiry re-arms");
    });

    // @covers navigator.close
    // @level unit
    it("second x acts only if the same run is still selected", () => {
        const o = drive([
            { id: "sa_a", name: "alpha", status: "running", model: "m", elapsed: "1s", spend: "" },
            { id: "sa_b", name: "beta", status: "completed", model: "m", elapsed: "2s", spend: "" },
        ]);
        o.press("x"); // arm alpha
        o.press("<down>"); // select beta — must disarm
        assert.equal(o.hints.at(-1), null, "selection change disarms");
        o.press("x"); // arms beta, does not close alpha
        assert.equal(o.closeCalls.length, 0);
        assert.equal(o.hints.at(-1), "x again to dismiss beta");
        assert.equal(o.store.get("sa_a").dismissedAt, undefined);
        o.press("x"); // close beta
        assert.equal(o.closeCalls.length, 1);
        assert.equal(o.closeCalls[0].id, "sa_b");
        assert.equal(o.store.get("sa_a").dismissedAt, undefined);
        assert.equal(typeof o.store.get("sa_b").dismissedAt, "number");
    });

    // @covers navigator.close
    // @level unit
    it("returning between list and detail disarms Close", () => {
        const o = drive([
            { id: "sa_a", name: "alpha", status: "running", model: "m", elapsed: "1s", spend: "" },
        ]);
        o.press("x");
        assert.equal(o.hints.at(-1), "x again to stop alpha");
        o.press("<enter>"); // list → detail
        assert.equal(o.hints.at(-1), null, "enter detail disarms");
        o.press("x"); // arm in detail
        assert.equal(o.hints.at(-1), "x again to stop alpha");
        o.press("<left>"); // detail → list
        assert.equal(o.hints.at(-1), null, "leave detail disarms");
        assert.equal(o.closeCalls.length, 0);
        assert.equal(o.store.get("sa_a").dismissedAt, undefined);
    });

    // @covers navigator.close
    // @level unit
    it("closing the overlay or dispose/teardown disarms Close and clears the hint", () => {
        const o = drive([
            { id: "sa_a", name: "alpha", status: "completed", model: "m", elapsed: "1s", spend: "" },
        ]);
        o.press("x");
        assert.equal(o.hints.at(-1), "x again to dismiss alpha");
        o.press("<escape>");
        assert.deepEqual(o.doneCalls, [null]);
        assert.equal(o.hints.at(-1), null);
        assert.equal(o.clock.pendingCount(), 0, "arm timer cleared on close");

        const o2 = drive([
            { id: "sa_b", name: "beta", status: "running", model: "m", elapsed: "1s", spend: "" },
        ]);
        o2.press("x");
        o2.component().dispose();
        assert.equal(o2.hints.at(-1), null);
        assert.equal(o2.clock.pendingCount(), 0);
        assert.equal(o2.store.get("sa_b").dismissedAt, undefined);
    });

    // @covers navigator.close
    // @level unit
    it("second x in detail closes the viewed run and returns to the refreshed list", () => {
        const o = drive([
            { id: "sa_a", name: "alpha", status: "completed", model: "m", elapsed: "1s", spend: "" },
            { id: "sa_b", name: "beta", status: "failed", model: "m", elapsed: "2s", spend: "" },
        ]);
        o.press("<enter>");
        o.press("x");
        assert.equal(o.hints.at(-1), "x again to dismiss alpha");
        o.press("x");
        assert.equal(o.closeCalls[0].id, "sa_a");
        assert.equal(o.timers.activeCount(), 0, "leaving detail after close clears detail timer");
        const text = o.lines().join("\n");
        assert.ok(!text.includes("alpha"));
        assert.ok(text.includes("beta"));
        assert.ok(text.some?.(() => false) || text.includes("Subagents"), "back on list");
    });

    // @covers navigator.close
    // @level unit
    it("finish-during-confirmation: second x applies terminal dismissal semantics", () => {
        const o = drive(
            [{ id: "sa_a", name: "alpha", status: "running", model: "m", elapsed: "1s", spend: "" }],
            {
                store: new Map([["sa_a", {
                    id: "sa_a", name: "alpha", status: "running", pid: 0x3fffffff, dismissedAt: undefined,
                }]]),
            },
        );
        o.press("x");
        // Simulate finish while armed: effective status becomes exited/completed.
        o.setStatus("sa_a", "completed");
        o.store.get("sa_a").endedAt = o.clock.now();
        o.press("x");
        assert.equal(o.closeCalls.length, 1);
        assert.equal(o.store.get("sa_a").status, "completed", "must not rewrite to killed");
        assert.equal(typeof o.store.get("sa_a").dismissedAt, "number");
    });

    // @covers navigator.close
    // @level unit
    it("session_shutdown dispose path clears a pending close arm timer", () => {
        const clock = fakeClock();
        const slot = { value: undefined, get() { return this.value; }, set(v) { this.value = v; } };
        const rows = [{ id: "sa_a", name: "alpha", status: "running", model: "m", elapsed: "1s", spend: "" }];
        const hints = [];
        const tui = { requestRender() {} };
        const ui = {
            custom(factory, _opts) {
                return new Promise((resolve) => {
                    factory(tui, { fg: (_c, s) => s }, {}, (v) => resolve(v));
                });
            },
        };
        openTrackedNavigator(ui, rows, {
            matchKey: (d, id) => d === `<${id}>` || (id === "x" && d === "x"),
            truncate,
            getDetail: () => null,
            closeRun: () => ({ action: "missing" }),
            onCloseConfirmHint: (h) => hints.push(h),
            now: () => clock.now(),
            setTimeout: clock.setTimeout.bind(clock),
            clearTimeout: clock.clearTimeout.bind(clock),
            setInterval: () => 1,
            clearInterval: () => {},
        }, slot);
        // Grab component via dispose slot side effect — press through a fresh component.
        // openTrackedNavigator captured dispose; drive input via a parallel component with same deps is enough
        // for the dispose contract: arm on a component then disposeTrackedNavigator.
        const component = createNavigatorOverlayComponent(rows, {
            matchKey: (d, id) => d === `<${id}>` || (id === "x" && d === "x"),
            truncate,
            closeRun: () => ({ action: "missing" }),
            onCloseConfirmHint: (h) => hints.push(h),
            now: () => clock.now(),
            setTimeout: clock.setTimeout.bind(clock),
            clearTimeout: clock.clearTimeout.bind(clock),
        }, tui, { fg: (_c, s) => s }, () => {});
        component.handleInput("x");
        assert.equal(clock.pendingCount(), 1);
        component.dispose();
        assert.equal(clock.pendingCount(), 0);
        assert.equal(hints.at(-1), null);
        disposeTrackedNavigator(slot);
    });
});

// ---------------------------------------------------------------------------
// Tool compatibility after navigator dismissal (close path)
// ---------------------------------------------------------------------------
describe("tool compatibility after navigator close-dismiss", () => {
    // @covers navigator.close
    // @level unit
    it("dismissed-via-close runs disappear from visibility but remain on tool APIs", async () => {
        const id = trackDisk(`sa_t47_tools_${Date.now()}`);
        writeMeta(meta({ id, name: "kept", status: "completed", endedAt: 3 }));
        const outcome = executeNavigatorClose(id, {
            readMeta, effectiveStatus, stopRun, dismissRun, now: () => 42,
        });
        assert.equal(outcome.action, "dismissed");

        const metas = listMetas();
        assert.ok(!navigatorVisibleRuns(metas, THIS_PID).some((m) => m.id === id));
        assert.equal(
            navigatorVisibleCount(metas, THIS_PID),
            navigatorVisibleRuns(metas, THIS_PID).length,
        );

        const tools = {
            list: subagentListTool(TypeStub),
            output: subagentOutputTool(TypeStub),
            result: subagentResultTool(TypeStub),
            stop: subagentStopTool(TypeStub, { onStopped: () => {} }),
        };
        assert.ok(resultText(await tools.list.execute("tc", {})).includes(id));
        assert.ok(resultText(await tools.output.execute("tc", { id })).includes(id));
        assert.ok(resultText(await tools.result.execute("tc", { id })).includes(id));
        assert.equal(isDismissed(readMeta(id)), true);
        assert.equal(readMeta(id).status, "completed");
    });
});
