/**
 * Incomplete child exits must remain diagnostics, not synthesized final answers.
 *
 * // @covers subagent.result
 * // @level unit
 * // @fails-without-fix subagent.result
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    formatIncompleteResult,
    formatSubagentResult,
    resolveLifecycle,
} from "../lifecycle.ts";

const incompleteRun = {
    finalText: "progress before exit",
    lastActivity: "progress before exit",
    toolCalls: ["bash"],
    unmatchedToolCalls: [{ id: "call_bash", toolName: "bash" }],
    sawEnd: false,
    usage: { input: 0, output: 0, cacheRead: 0, costUSD: 0, total: 0 },
};

const coherentRun = {
    finalText: "Final answer",
    lastActivity: "Final answer",
    toolCalls: ["read"],
    unmatchedToolCalls: [],
    sawEnd: true,
    usage: { input: 0, output: 0, cacheRead: 0, costUSD: 0, total: 0 },
};

describe("subagent_result for incomplete child exits", () => {
    // @covers subagent.result
    // @level unit
    // @fails-without-fix subagent.result
    it("returns best parsed output and a raw log tail instead of a normal result", () => {
        const rawTail = "RAW_INCOMPLETE_LOG_TAIL";
        const content = formatIncompleteResult(incompleteRun, rawTail);

        assert.match(content, /ended unexpectedly/i);
        assert.match(content, /progress before exit/);
        assert.match(content, /--- raw log tail ---/);
        assert.match(content, new RegExp(rawTail));
        assert.doesNotMatch(content, /completed/i);
    });

    // @covers subagent.result
    // @level unit
    // @fails-without-fix subagent.result
    it("includes lifecycle diagnostics and does not present progress as a clean final answer", () => {
        const lifecycle = resolveLifecycle(
            { status: "failed", exitCode: 0, lifecycleClassification: "incomplete_no_terminal_event", failureReason: "incomplete-stream" },
            incompleteRun,
        );
        const content = formatSubagentResult({
            id: "sa_incomplete",
            status: "failed",
            exitCode: 0,
            statSeg: " · 14s",
            toolsSeg: " · tools: bash",
            run: incompleteRun,
            rawLogTail: "RAW_TAIL",
            lifecycle,
        });

        assert.match(content, /lifecycle incomplete_no_terminal_event/);
        assert.match(content, /Lifecycle diagnostics/i);
        assert.match(content, /terminal event: no/i);
        assert.match(content, /unmatched tools: bash \(call_bash\)/);
        assert.match(content, /ended unexpectedly/i);
        assert.match(content, /--- best available parsed output ---/);
        assert.match(content, /progress before exit/);
        assert.doesNotMatch(content, /^\[sa_incomplete · failed · exit 0[^\]]*\]\nprogress before exit$/m);
    });

    // @covers subagent.result
    // @level unit
    it("formats normal completion with lifecycle complete diagnostics", () => {
        const lifecycle = resolveLifecycle(
            { status: "completed", exitCode: 0, lifecycleClassification: "complete" },
            coherentRun,
        );
        const content = formatSubagentResult({
            id: "sa_ok",
            status: "completed",
            exitCode: 0,
            statSeg: " · 5s",
            toolsSeg: " · tools: read",
            run: coherentRun,
            rawLogTail: "unused",
            lifecycle,
        });

        assert.match(content, /lifecycle complete/);
        assert.match(content, /terminal event: yes/i);
        assert.match(content, /Final answer/);
        assert.doesNotMatch(content, /ended unexpectedly/i);
    });

    // @covers subagent.result
    // @level unit
    // @characterizes subagent.result
    it("keeps killed runs compatible and distinct from incomplete-stream failures", () => {
        const lifecycle = resolveLifecycle(
            { status: "killed", exitCode: null },
            { ...incompleteRun, finalText: "", lastActivity: "stopped mid work" },
        );
        const content = formatSubagentResult({
            id: "sa_killed",
            status: "killed",
            exitCode: "?",
            statSeg: " · 3s",
            toolsSeg: "",
            run: { ...incompleteRun, finalText: "", lastActivity: "stopped mid work" },
            rawLogTail: "KILL_TAIL",
            lifecycle,
        });

        assert.equal(lifecycle.classification, "killed");
        assert.equal(lifecycle.incomplete, false);
        assert.match(content, /lifecycle killed/);
        assert.doesNotMatch(content, /ended unexpectedly/i);
        assert.doesNotMatch(content, /incomplete-stream/i);
    });

    // @covers subagent.result
    // @level unit
    // @characterizes subagent.result
    it("keeps nonzero failed exits compatible and distinct from incomplete classifications", () => {
        const lifecycle = resolveLifecycle(
            { status: "failed", exitCode: 1, lifecycleClassification: "failed_exit" },
            coherentRun,
        );
        const content = formatSubagentResult({
            id: "sa_fail",
            status: "failed",
            exitCode: 1,
            statSeg: " · 2s",
            toolsSeg: "",
            run: coherentRun,
            rawLogTail: "FAIL_TAIL",
            lifecycle,
        });

        assert.equal(lifecycle.classification, "failed_exit");
        assert.equal(lifecycle.incomplete, false);
        assert.match(content, /lifecycle failed_exit/);
        assert.doesNotMatch(content, /ended unexpectedly/i);
        assert.match(content, /Final answer/);
    });

    // @covers subagent.result
    // @level unit
    // @fails-without-fix subagent.result
    it("does not treat legacy completed metadata as clean without stream evidence", () => {
        // Observed issue #75 legacy shape: status completed + exit 0, no lifecycleClassification.
        const lifecycle = resolveLifecycle(
            { status: "completed", exitCode: 0 },
            incompleteRun,
        );
        const content = formatSubagentResult({
            id: "sa_legacy_completed",
            status: "completed",
            exitCode: 0,
            statSeg: " · 14s",
            toolsSeg: " · tools: bash",
            run: incompleteRun,
            rawLogTail: "LEGACY_TAIL",
            lifecycle,
        });

        assert.equal(lifecycle.classification, "incomplete_no_terminal_event");
        assert.equal(lifecycle.incomplete, true);
        assert.match(content, /lifecycle incomplete_no_terminal_event/);
        assert.match(content, /terminal event: no/i);
        assert.match(content, /unmatched tools: bash \(call_bash\)/);
        assert.match(content, /ended unexpectedly/i);
        assert.doesNotMatch(content, /lifecycle complete/);
        assert.doesNotMatch(content, /^\[sa_legacy_completed · completed · exit 0[^\]]*\]\nprogress before exit$/m);
    });

    // @covers subagent.result
    // @level unit
    it("is wired into the registered subagent_result tool", () => {
        // Handlers live in tools.ts; index.ts registers the factory result so the
        // model reaches the same execute path tests drive (no drift-prone copy).
        const toolsSource = readFileSync(new URL("../tools.ts", import.meta.url), "utf8");
        const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
        const finalizationSource = readFileSync(new URL("../finalization.ts", import.meta.url), "utf8");

        assert.match(toolsSource, /buildSubagentResultText/);
        assert.match(indexSource, /subagentResultTool\(Type\)/);
        assert.match(finalizationSource, /formatSubagentResult/);
        assert.match(finalizationSource, /resolveLifecycle/);
        assert.match(finalizationSource, /lifecycleClassification/);
    });
});
