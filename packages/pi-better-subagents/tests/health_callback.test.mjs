/**
 * Unit tests for orphaned/lost health attention callbacks (issue #65).
 *
 * Contract: lightweight, non-interrupting follow-ups with distinct ATTENTION
 * wording; never embed full artifacts; name the inspection tools; tell the
 * coordinator it may wait, stop, or retry.
 *
 * // @covers subagent.health-callback
 * // @level unit
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    formatHealthCallbackTrigger,
    buildHealthCallbackDelivery,
} from "../completion.mjs";

describe("formatHealthCallbackTrigger — orphaned", () => {
    // @covers subagent.health-callback
    // @level unit
    it("says supervision was lost and related work may still be alive", () => {
        const out = formatHealthCallbackTrigger({
            id: "sa_orph",
            label: "worker (sa_orph)",
            status: "orphaned",
        });
        assert.match(out, /ATTENTION/i);
        assert.match(out, /supervision/i);
        assert.match(out, /orphaned/i);
        assert.match(out, /may still be alive/i);
        assert.doesNotMatch(out, /has returned|✓ completed/i);
    });

    it("names inspection tools and wait/stop/retry decision", () => {
        const out = formatHealthCallbackTrigger({
            id: "sa_orph",
            label: "worker (sa_orph)",
            status: "orphaned",
        });
        assert.match(out, /subagent_result id="sa_orph"/);
        assert.match(out, /subagent_output id="sa_orph"/);
        assert.match(out, /subagent_stop id="sa_orph"/);
        assert.match(out, /wait/i);
        assert.match(out, /stop/i);
        assert.match(out, /retry/i);
    });

    it("does not embed a result payload or --- result --- marker", () => {
        const sentinel = "UNIQUE_ORPHAN_RESULT_BODY_xyz";
        const out = formatHealthCallbackTrigger(
            Object.assign(
                { id: "sa_orph", label: "w", status: "orphaned" },
                { result: sentinel, resultText: sentinel },
            ),
        );
        assert.doesNotMatch(out, /--- result ---/);
        assert.ok(!out.includes(sentinel));
    });
});

describe("formatHealthCallbackTrigger — lost", () => {
    // @covers subagent.health-callback
    // @level unit
    it("says no related process remains and no coherent terminal completion was observed", () => {
        const out = formatHealthCallbackTrigger({
            id: "sa_lost",
            label: "worker (sa_lost)",
            status: "lost",
        });
        assert.match(out, /ATTENTION/i);
        assert.match(out, /lost/i);
        assert.match(out, /no related process remains/i);
        assert.match(out, /no coherent terminal/i);
        assert.doesNotMatch(out, /has returned|✓ completed|may still be alive/i);
    });

    it("names inspection tools and wait/stop/retry decision", () => {
        const out = formatHealthCallbackTrigger({
            id: "sa_lost",
            label: "worker (sa_lost)",
            status: "lost",
        });
        assert.match(out, /subagent_result id="sa_lost"/);
        assert.match(out, /subagent_output id="sa_lost"/);
        assert.match(out, /wait|stop|retry/i);
        assert.match(out, /retry/i);
    });
});

describe("buildHealthCallbackDelivery", () => {
    // @covers subagent.health-callback
    // @level unit
    it("callback:true uses non-interrupting followUp + triggerTurn", () => {
        const d = buildHealthCallbackDelivery({
            id: "sa_h",
            label: "h",
            status: "orphaned",
            callback: true,
        });
        assert.ok(d, "must produce a delivery");
        assert.equal(d.options.deliverAs, "followUp");
        assert.equal(d.options.triggerTurn, true);
        assert.match(d.content, /ATTENTION/i);
        assert.match(d.content, /orphaned/i);
    });

    it("callback:false suppresses model delivery (returns null)", () => {
        const d = buildHealthCallbackDelivery({
            id: "sa_h",
            label: "h",
            status: "lost",
            callback: false,
        });
        assert.equal(d, null);
    });

    it("lost callback:true keeps distinct lost attention wording", () => {
        const d = buildHealthCallbackDelivery({
            id: "sa_h",
            label: "h",
            status: "lost",
            callback: true,
        });
        assert.ok(d);
        assert.match(d.content, /no related process remains/i);
        assert.equal(d.options.deliverAs, "followUp");
        assert.equal(d.options.triggerTurn, true);
    });
});
