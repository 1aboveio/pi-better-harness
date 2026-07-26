/**
 * Unit tests for the live subagent status widget helpers.
 *
 * Pins the flicker contracts from issue #13:
 * - dirty-check before setWidget (skip identical frames)
 * - fixed-width elapsed/tokens so geometry stays stable
 * - idle/shutdown clear uses undefined, not []
 * - spend cache avoids forcing a full log re-parse every 1s tick
 * - spinner (or live affordance) still advances across frames
 *
 * // @covers widget.render
 * // @level unit
 * // @covers widget.clear
 * // @level unit
 * // @covers widget.dirty-check
 * // @level unit
 * // @covers widget.geometry
 * // @level unit
 * // @covers widget.spend-cache
 * // @level unit
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    SPINNER,
    SPEND_REFRESH_MS,
    WIDGET_CLEAR,
    ELAPSED_WIDTH,
    buildWidgetLines,
    fmtElapsed,
    fmtElapsedFixed,
    fmtSpendFixed,
    fmtTokensFixed,
    isSpendCacheFresh,
    linesEqual,
    nextWidgetAction,
} from "../widget.mjs";

// ---------------------------------------------------------------------------
// AC4 — clear API is undefined, not []
// ---------------------------------------------------------------------------
describe("widget clear API", () => {
    // @covers widget.clear
    // @level unit
    it("WIDGET_CLEAR is undefined (pi clears only on undefined, not [])", () => {
        assert.equal(WIDGET_CLEAR, undefined);
        assert.notDeepEqual(WIDGET_CLEAR, []);
    });

    // @covers widget.clear
    // @level unit
    it("nextWidgetAction idle → clear when previous frame had content", () => {
        const prev = ["Subagents · 1 running", "  ⠋ watch  12s     "];
        const action = nextWidgetAction(prev, null);
        assert.equal(action.op, "clear");
        // Apply semantics: caller must pass WIDGET_CLEAR to setWidget
        assert.equal(WIDGET_CLEAR, undefined);
    });

    // @covers widget.clear
    // @level unit
    it("nextWidgetAction idle → skip when already cleared", () => {
        const action = nextWidgetAction(undefined, null);
        assert.equal(action.op, "skip");
    });

    // @covers widget.clear
    // @level unit
    it("clearing from a mistaken [] previous value still emits clear", () => {
        // Regression: old code used setWidget("subagents", []) which is NOT a
        // clear. Moving to undefined must still fire when prev was [].
        const action = nextWidgetAction([], null);
        assert.equal(action.op, "clear");
    });
});

// ---------------------------------------------------------------------------
// AC1 — dirty-check: skip setWidget when lines unchanged
// ---------------------------------------------------------------------------
describe("widget dirty-check", () => {
    // @covers widget.dirty-check
    // @level unit
    it("linesEqual is true for identical arrays", () => {
        const a = ["Subagents · 1 running", "  ⠋ x  1s      "];
        const b = ["Subagents · 1 running", "  ⠋ x  1s      "];
        assert.equal(linesEqual(a, b), true);
    });

    // @covers widget.dirty-check
    // @level unit
    it("linesEqual is false when spinner glyph differs", () => {
        const a = ["Subagents · 1 running", "  ⠋ x  1s      "];
        const b = ["Subagents · 1 running", "  ⠙ x  1s      "];
        assert.equal(linesEqual(a, b), false);
    });

    // @covers widget.dirty-check
    // @level unit
    it("nextWidgetAction skips when next lines match prev (no setWidget)", () => {
        const lines = buildWidgetLines({
            running: [{ id: "a1", name: "watch", startedAt: 0 }],
            frame: 0,
            now: 28_000,
            spendById: {},
        });
        const action = nextWidgetAction(lines, lines);
        assert.equal(action.op, "skip");
    });

    // @covers widget.dirty-check
    // @level unit
    it("nextWidgetAction sets when content actually changes", () => {
        const prev = buildWidgetLines({
            running: [{ id: "a1", name: "watch", startedAt: 0 }],
            frame: 0,
            now: 28_000,
            spendById: {},
        });
        const next = buildWidgetLines({
            running: [{ id: "a1", name: "watch", startedAt: 0 }],
            frame: 1, // spinner advanced
            now: 28_000,
            spendById: {},
        });
        const action = nextWidgetAction(prev, next);
        assert.equal(action.op, "set");
        assert.deepEqual(action.lines, next);
    });

    // @covers widget.dirty-check
    // @level unit
    it("stable inputs across a tick produce identical lines (skip path usable)", () => {
        // Same second, same frame, same spend → byte-identical lines.
        // A ticker that re-enters mid-second without spinner advance must not
        // thrash setWidget.
        const input = {
            running: [{ id: "a1", name: "watch", startedAt: 0 }],
            frame: 3,
            now: 28_400,
            spendById: {
                a1: {
                    usage: { total: 20100, input: 19600, output: 442, costUSD: 0.0557 },
                    tool: "bash",
                },
            },
        };
        const a = buildWidgetLines(input);
        const b = buildWidgetLines({ ...input, now: 28_900 }); // still 29s rounded? 28.4s vs 28.9s → both 28s or 29s
        // 28400ms → 28s, 28900ms → 29s — pick same whole second:
        const c = buildWidgetLines({ ...input, now: 28_100 });
        assert.deepEqual(a, c);
        assert.equal(nextWidgetAction(a, c).op, "skip");
    });
});

// ---------------------------------------------------------------------------
// AC2 — spinner / live affordance still advances
// ---------------------------------------------------------------------------
describe("widget liveness (spinner)", () => {
    // @covers widget.render
    // @level unit
    it("spinner glyphs rotate across successive frames", () => {
        const base = {
            running: [{ id: "a1", name: "watch", startedAt: 0 }],
            now: 10_000,
            spendById: {},
        };
        const line0 = buildWidgetLines({ ...base, frame: 0 })[1];
        const line1 = buildWidgetLines({ ...base, frame: 1 })[1];
        const line2 = buildWidgetLines({ ...base, frame: 2 })[1];
        assert.ok(line0.includes(SPINNER[0]), `frame0 should include ${SPINNER[0]}: ${line0}`);
        assert.ok(line1.includes(SPINNER[1]), `frame1 should include ${SPINNER[1]}: ${line1}`);
        assert.ok(line2.includes(SPINNER[2]), `frame2 should include ${SPINNER[2]}: ${line2}`);
        assert.notEqual(line0, line1);
        assert.notEqual(line1, line2);
    });

    // @covers widget.render
    // @level unit
    it("header reports running count", () => {
        const lines = buildWidgetLines({
            running: [
                { id: "a", name: "one", startedAt: 0 },
                { id: "b", name: "two", startedAt: 0 },
            ],
            frame: 0,
            now: 1000,
            spendById: {},
        });
        assert.equal(lines[0], "Subagents · 2 running");
        assert.equal(lines.length, 3);
    });

    // @covers widget.render
    // @level unit
    it("left-arrow navigate hint stays on the title row", () => {
        const lines = buildWidgetLines({
            running: [{ id: "a", name: "one", startedAt: 0 }],
            frame: 0,
            now: 1000,
            spendById: {},
            affordanceHint: "← to navigate",
        });
        assert.equal(lines[0], "Subagents · 1 running  ← to navigate");
        assert.equal(lines.length, 2, "hint must not consume a separate widget row");
    });

    // @covers widget.render
    // @level unit
    it("selected main-window row uses the navigation marker", () => {
        const lines = buildWidgetLines({
            running: [
                { id: "a", name: "one", startedAt: 0 },
                { id: "b", name: "two", startedAt: 0 },
            ],
            frame: 0,
            now: 1000,
            spendById: {},
            selectedId: "b",
        });
        assert.ok(lines[1].startsWith("  "), lines[1]);
        assert.ok(lines[2].startsWith("› "), lines[2]);
    });
});

// ---------------------------------------------------------------------------
// AC1/AC3 — fixed-width geometry; elapsed/spend eventually accurate
// ---------------------------------------------------------------------------
describe("widget fixed-width geometry", () => {
    // @covers widget.geometry
    // @level unit
    it("fmtElapsedFixed always has width ELAPSED_WIDTH", () => {
        const samples = [0, 5_000, 45_000, 125_000, 3_700_000, 36_000_000];
        for (const ms of samples) {
            const fixed = fmtElapsedFixed(ms);
            assert.equal(
                fixed.length,
                ELAPSED_WIDTH,
                `elapsed fixed width for ${ms}ms: got "${fixed}" (len ${fixed.length})`
            );
            // Variable form is the trimmed prefix
            assert.ok(fixed.startsWith(fmtElapsed(ms)) || fixed.trim() === fmtElapsed(ms));
        }
    });

    // @covers widget.geometry
    // @level unit
    it("run line length is stable as elapsed ticks from 9s → 10s → 60s", () => {
        const spend = {
            a1: {
                usage: { total: 20100, input: 19600, output: 442, costUSD: 0.0557 },
                tool: "bash",
            },
        };
        const mk = (now) =>
            buildWidgetLines({
                running: [{ id: "a1", name: "watch-pr11-merge", startedAt: 0 }],
                frame: 0, // hold spinner so only elapsed moves
                now,
                spendById: spend,
            })[1];

        const at9 = mk(9_000);
        const at10 = mk(10_000);
        const at59 = mk(59_000);
        const at60 = mk(60_000);

        assert.equal(at9.length, at10.length, `9s vs 10s length: "${at9}" vs "${at10}"`);
        assert.equal(at59.length, at60.length, `59s vs 60s length: "${at59}" vs "${at60}"`);
        // Across the s→m boundary, fixed elapsed keeps the line length stable.
        assert.equal(at9.length, at60.length, `9s vs 60s length: "${at9}" vs "${at60}"`);
    });

    // @covers widget.geometry
    // @level unit
    it("fmtSpendFixed keeps constant width as token totals grow within band", () => {
        const small = fmtSpendFixed({ total: 999, input: 500, output: 499, costUSD: 0.0012 });
        const mid = fmtSpendFixed({ total: 20100, input: 19600, output: 442, costUSD: 0.0557 });
        const big = fmtSpendFixed({ total: 999900, input: 500000, output: 499900, costUSD: 0.9999 });
        assert.equal(small.length, mid.length, `"${small}" vs "${mid}"`);
        assert.equal(mid.length, big.length, `"${mid}" vs "${big}"`);
        // Token field itself is fixed
        assert.equal(fmtTokensFixed(12).length, fmtTokensFixed(999900).length);
    });

    // @covers widget.geometry
    // @level unit
    it("elapsed reflects current now (eventually accurate within a tick)", () => {
        const line = buildWidgetLines({
            running: [{ id: "a1", name: "watch", startedAt: 0 }],
            frame: 0,
            now: 28_000,
            spendById: {},
        })[1];
        assert.match(line, /28s/);
    });
});

// ---------------------------------------------------------------------------
// AC3 — spend cache freshness (avoid full parseRun every 1s tick)
// ---------------------------------------------------------------------------
describe("widget spend cache", () => {
    // @covers widget.spend-cache
    // @level unit
    it("isSpendCacheFresh is true inside TTL with same log size", () => {
        const now = 100_000;
        const cached = { refreshedAt: now - 1_000, logSize: 4096 };
        assert.equal(isSpendCacheFresh(cached, now, 4096, SPEND_REFRESH_MS), true);
    });

    // @covers widget.spend-cache
    // @level unit
    it("isSpendCacheFresh is false after TTL", () => {
        const now = 100_000;
        const cached = { refreshedAt: now - SPEND_REFRESH_MS - 1, logSize: 4096 };
        assert.equal(isSpendCacheFresh(cached, now, 4096, SPEND_REFRESH_MS), false);
    });

    // @covers widget.spend-cache
    // @level unit
    it("isSpendCacheFresh is false when log size changes (new output)", () => {
        const now = 100_000;
        const cached = { refreshedAt: now - 100, logSize: 4096 };
        assert.equal(isSpendCacheFresh(cached, now, 8192, SPEND_REFRESH_MS), false);
    });

    // @covers widget.spend-cache
    // @level unit
    it("isSpendCacheFresh is false for missing cache", () => {
        assert.equal(isSpendCacheFresh(null, 1000, 0), false);
        assert.equal(isSpendCacheFresh(undefined, 1000, 0), false);
    });

    // @covers widget.spend-cache
    // @level unit
    it("buildWidgetLines uses cached spend without requiring a parser", () => {
        // Pure path: caller supplies spendById; no parseRun involved.
        const lines = buildWidgetLines({
            running: [{ id: "a1", name: "watch", startedAt: 0 }],
            frame: 0,
            now: 5_000,
            spendById: {
                a1: {
                    usage: { total: 1200, input: 1000, output: 200, costUSD: 0.01 },
                    tool: "bash",
                },
            },
        });
        assert.ok(lines[1].includes("bash"), lines[1]);
        assert.ok(lines[1].includes("tok"), lines[1]);
        assert.ok(lines[1].includes("$"), lines[1]);
    });
});

// ---------------------------------------------------------------------------
// nextWidgetAction apply helper contract (what index.ts must do)
// ---------------------------------------------------------------------------
describe("widget action → setWidget contract", () => {
    // @covers widget.render
    // @level unit
    it("set op carries the exact lines to paint", () => {
        const next = ["Subagents · 1 running", "  ⠋ x  1s      "];
        const action = nextWidgetAction(undefined, next);
        assert.equal(action.op, "set");
        assert.equal(action.lines, next);
    });

    // @covers widget.clear
    // @level unit
    it("clear op means setWidget(key, WIDGET_CLEAR) i.e. undefined", () => {
        const action = nextWidgetAction(["x"], null);
        assert.equal(action.op, "clear");
        // Document the only correct clear payload:
        const payload = action.op === "clear" ? WIDGET_CLEAR : action.lines;
        assert.equal(payload, undefined);
        assert.ok(payload !== []);
    });
});

// ---------------------------------------------------------------------------
// index.ts wiring — must use helpers + undefined clear + dirty-check + cache
// These fail against the pre-fix 1 Hz thrash path (RED → GREEN for #13).
// ---------------------------------------------------------------------------
describe("index.ts widget wiring (issue #13)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const indexSource = readFileSync(path.resolve(__dirname, "..", "index.ts"), "utf8");

    // @covers widget.clear
    // @level unit
    it("never clears the widget with setWidget(\"subagents\", [])", () => {
        // AC4: pi clears only on undefined. Empty array leaves a residual widget.
        assert.ok(
            !indexSource.includes('setWidget("subagents", [])') &&
                !indexSource.includes("setWidget('subagents', [])"),
            "index.ts must not call setWidget(\"subagents\", []) — use undefined"
        );
    });

    // @covers widget.clear
    // @level unit
    it("clears the widget with setWidget(\"subagents\", undefined) on idle/shutdown", () => {
        assert.ok(
            indexSource.includes('setWidget("subagents", undefined)') ||
                indexSource.includes("setWidget('subagents', undefined)") ||
                indexSource.includes("setWidget(\"subagents\", WIDGET_CLEAR)") ||
                indexSource.includes("setWidget('subagents', WIDGET_CLEAR)"),
            "index.ts must clear via undefined / WIDGET_CLEAR"
        );
    });

    // @covers widget.dirty-check
    // @level unit
    it("imports and uses nextWidgetAction (dirty-check before setWidget)", () => {
        assert.ok(
            indexSource.includes("nextWidgetAction"),
            "index.ts must dirty-check via nextWidgetAction before setWidget"
        );
    });

    // @covers widget.render
    // @level unit
    it("imports and uses buildWidgetLines for the live widget", () => {
        assert.ok(
            indexSource.includes("buildWidgetLines"),
            "index.ts must build live widget lines via buildWidgetLines"
        );
    });

    // @covers widget.spend-cache
    // @level unit
    it("uses isSpendCacheFresh so parseRun is not forced every tick", () => {
        assert.ok(
            indexSource.includes("isSpendCacheFresh"),
            "index.ts must gate parseRun behind isSpendCacheFresh on the UI hot path"
        );
    });

    // @covers widget.render
    // @level unit
    it("does not call parseRun unconditionally inside the live widget redraw body", () => {
        // Extract renderWidget / applyWidgetFrame body and ensure parseRun is
        // not a naked call without a cache gate nearby. We require the spend
        // cache helper to appear before any parseRun in the widget path.
        const widgetSection = indexSource.match(
            /\/\/ ---- live status widget[\s\S]*?\/\/ ----(?! live)/
        )?.[0] ?? indexSource;
        // If parseRun appears in the live-widget section, isSpendCacheFresh must too.
        if (widgetSection.includes("parseRun")) {
            assert.ok(
                widgetSection.includes("isSpendCacheFresh"),
                "live widget section calls parseRun but does not gate on isSpendCacheFresh"
            );
        }
    });
});

// ---------------------------------------------------------------------------
// Coexistence with #14 list-show-model — model short label still on widget line
// ---------------------------------------------------------------------------
describe("widget model label (#14 coexistence)", () => {
    // @covers widget.render
    // @level unit
    it("includes short model id after name (provider prefix stripped)", async () => {
        const { shortModel } = await import("../widget.mjs");
        assert.equal(shortModel("xai/grok-4.5"), "grok-4.5");
        assert.equal(shortModel(undefined), "?");
        const line = buildWidgetLines({
            running: [{ id: "a1", name: "watch", model: "xai/grok-4.5", startedAt: 0 }],
            frame: 0,
            now: 5_000,
            spendById: {},
        })[1];
        assert.ok(line.includes("watch · grok-4.5"), line);
        assert.ok(!line.includes("xai/"), line);
    });
});
