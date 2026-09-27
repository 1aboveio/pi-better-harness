/**
 * Diagnostic bodies for orphaned/lost subagent_result (issue #65).
 *
 * // @covers subagent.result
 * // @level unit
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatOrphanedResult, formatLostResult } from "../lifecycle.ts";

const sampleRun = {
    finalText: "partial assistant progress",
    lastActivity: "partial assistant progress",
    toolCalls: ["bash"],
    unmatchedToolCalls: [],
    sawEnd: false,
    usage: { input: 0, output: 0, cacheRead: 0, costUSD: 0, total: 0 },
};

describe("formatOrphanedResult", () => {
    // @covers subagent.result
    // @level unit
    it("is a non-final diagnostic with best-current parsed output and log tail", () => {
        const raw = "RAW_ORPHAN_TAIL";
        const out = formatOrphanedResult(sampleRun, raw);
        assert.match(out, /orphaned/i);
        assert.match(out, /supervision/i);
        assert.match(out, /may still be alive/i);
        assert.match(out, /non-final|no final result/i);
        assert.match(out, /best-current parsed output/i);
        assert.match(out, /partial assistant progress/);
        assert.match(out, /--- raw log tail ---/);
        assert.match(out, new RegExp(raw));
        assert.doesNotMatch(out, /✓ completed|final answer/i);
    });
});

describe("formatLostResult", () => {
    // @covers subagent.result
    // @level unit
    it("is a lost diagnostic with best-available parsed output and log tail", () => {
        const raw = "RAW_LOST_TAIL";
        const out = formatLostResult(sampleRun, raw);
        assert.match(out, /lost/i);
        assert.match(out, /no related process remains/i);
        assert.match(out, /no coherent terminal/i);
        assert.match(out, /best-available/i);
        assert.match(out, /partial assistant progress/);
        assert.match(out, /--- raw log tail ---/);
        assert.match(out, new RegExp(raw));
    });
});
