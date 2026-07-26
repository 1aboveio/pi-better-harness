/**
 * Unit tests for the log parser and bounded tail reader.
 *
 * Covers issue #73: large child logs must surface recent activity without
 * reading the whole file, parser/truncation diagnostics must be explicit, and
 * the raw-tail fallback must avoid whole-file reads. Completed/failed/killed
 * final-result parsing stays compatible.
 *
 * // @covers parse.run
 * // @level unit
 * // @covers tailLog
 * // @level unit
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, openSync, closeSync, writeSync, ftruncateSync, unlinkSync, rmSync, existsSync } from "node:fs";
import { constants as bufferConstants } from "node:buffer";
import { parseRun, tailLog, formatSubagentOutputBody, formatSubagentResultBody } from "../parse.ts";
import { logPathFor, runDir } from "../registry.ts";

// Per-process, per-invocation run IDs for the parseRun and tailLog suites.
// node:test runs top-level describe blocks concurrently by default, and
// separate focused `node --test` invocations run in independent processes, so
// fixed IDs collided on both cross-suite and cross-process runs. Each process
// now owns its fixture directories and cleans up only those it created.
function uniqueRunId(prefix) {
    return `${prefix}_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}
const PARSE_RUN_ID = uniqueRunId("sa_parse_test_parse");
const TAIL_RUN_ID = uniqueRunId("sa_parse_test_tail");

function writeLog(id, lines) {
    mkdirSync(runDir(id), { recursive: true });
    writeFileSync(logPathFor(id), lines.join("\n"), "utf-8");
}

function makeSparseLog(id, totalBytes, tailText) {
    mkdirSync(runDir(id), { recursive: true });
    const path = logPathFor(id);
    const fd = openSync(path, "w");
    try {
        ftruncateSync(fd, totalBytes);
        const buf = Buffer.from("\n" + tailText, "utf-8");
        writeSync(fd, buf, 0, buf.length, totalBytes - buf.length);
    } finally {
        closeSync(fd);
    }
}

function cleanup(id) {
    try { unlinkSync(logPathFor(id)); } catch {}
    try { rmSync(runDir(id), { recursive: true, force: true }); } catch {}
}

function event(type, extra = {}) {
    return JSON.stringify({ type, ...extra });
}

describe("parseRun", () => {
    before(() => cleanup(PARSE_RUN_ID));
    after(() => cleanup(PARSE_RUN_ID));

    it("uses process-unique run IDs to avoid cross-process fixture collisions", () => {
        assert.notEqual(PARSE_RUN_ID, TAIL_RUN_ID);
        assert.ok(PARSE_RUN_ID.includes(String(process.pid)), "parse run ID must include process pid");
        assert.ok(TAIL_RUN_ID.includes(String(process.pid)), "tail run ID must include process pid");
        assert.ok(!existsSync(runDir(PARSE_RUN_ID)), "parse run dir must not exist before setup");
        assert.ok(!existsSync(runDir(TAIL_RUN_ID)), "tail run dir must not exist before setup");
    });

    it("parses a completed run final answer from a small full log", () => {
        writeLog(PARSE_RUN_ID, [
            '[pi-warp] banner',
            event("message_end", { message: { role: "assistant", content: [{ type: "text", text: "first" }], usage: { input: 10, output: 5, cost: { total: 0.001 } } } }),
            event("tool_execution_start", { toolName: "bash" }),
            event("message_end", { message: { role: "assistant", content: [{ type: "text", text: "second" }], usage: { input: 20, output: 8, cost: { total: 0.002 } } } }),
            event("agent_end", { messages: [{ role: "user", content: "ok" }, { role: "assistant", content: [{ type: "text", text: "final" }] }] }),
        ]);
        const r = parseRun(PARSE_RUN_ID);
        assert.equal(r.finalText, "final");
        assert.equal(r.lastActivity, "second");
        assert.deepEqual(r.toolCalls, ["bash"]);
        assert.equal(r.sawEnd, true);
        assert.equal(r.usage.input, 30);
        assert.equal(r.usage.output, 13);
        assert.equal(r.usage.total, 43);
        assert.equal(r.diagnostics.length, 0);
    });

    it("falls back to the last assistant message for failed/killed logs without agent_end", () => {
        writeLog(PARSE_RUN_ID, [
            event("message_end", { message: { role: "assistant", content: [{ type: "text", text: "partial answer" }], usage: { input: 5, output: 3 } } }),
            event("tool_execution_start", { toolName: "bash" }),
            event("tool_execution_start", { toolName: "bash" }), // adjacent dedupe
        ]);
        const r = parseRun(PARSE_RUN_ID);
        assert.equal(r.finalText, "partial answer");
        assert.equal(r.lastActivity, "partial answer");
        assert.equal(r.sawEnd, false);
        assert.deepEqual(r.toolCalls, ["bash"]);
    });

    it("surfaces recent tool events from a huge log without whole-file reads", () => {
        process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES = "1024";
        const tail = [
            event("tool_execution_start", { toolName: "old" }),
            ...Array.from({ length: 20 }, (_, i) => event("tool_execution_start", { toolName: `tool-${i}` })),
            event("message_update", { message: { role: "assistant", content: [{ type: "text", text: "recent streaming" }] } }),
        ].join("\n");
        const noise = "x".repeat(5000) + "\n";
        writeLog(PARSE_RUN_ID, [noise, tail]);
        const r = parseRun(PARSE_RUN_ID);
        delete process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES;

        assert.ok(r.toolCalls.includes("tool-19"), "recent tool event must be present");
        assert.ok(!r.toolCalls.includes("old"), "old tool event outside the tail must be omitted");
        assert.equal(r.lastActivity, "recent streaming");
        assert.ok(r.diagnostics.some((d) => /truncated/i.test(d)), "truncation diagnostic must be explicit");
    });

    it("does not throw ERR_STRING_TOO_LONG on a sparse log larger than MAX_STRING_LENGTH", () => {
        const MAX = bufferConstants.MAX_STRING_LENGTH;
        const tail = event("message_end", { message: { role: "assistant", content: [{ type: "text", text: "tail answer" }], usage: { input: 1, output: 1 } } });
        makeSparseLog(PARSE_RUN_ID, MAX + 1024, tail);

        let r;
        assert.doesNotThrow(() => {
            r = parseRun(PARSE_RUN_ID);
        });
        assert.equal(r.finalText, "tail answer");
        assert.ok(r.diagnostics.some((d) => /truncated/i.test(d)), "must report truncation for oversized log");
    });

    it("reports explicit diagnostics when no parseable events are found", () => {
        writeLog(PARSE_RUN_ID, [
            "Warning: No project session",
            "some stderr noise",
            "not json",
        ]);
        const r = parseRun(PARSE_RUN_ID);
        assert.equal(r.finalText, "");
        assert.equal(r.lastActivity, "");
        assert.equal(r.toolCalls.length, 0);
        assert.ok(r.diagnostics.some((d) => /No parseable assistant\/tool events/i.test(d)), "must surface parse-empty diagnostic");
    });

    it("reports truncation diagnostics with correct byte units for a small parse window", () => {
        process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES = "1024";
        const bigLine = event("message_update", { message: { role: "assistant", content: [{ type: "text", text: "x".repeat(2000) }] } });
        writeLog(PARSE_RUN_ID, [bigLine]);
        const r = parseRun(PARSE_RUN_ID);
        delete process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES;

        const diag = r.diagnostics.find((d) => /truncated/i.test(d));
        assert.ok(diag, "truncation diagnostic must be present");
        assert.ok(diag.includes("1.0 KB"), `diagnostic must report parse window as 1.0 KB, got: ${diag}`);
        assert.ok(!diag.includes("1.0 MB"), `diagnostic must not misreport bytes as MB, got: ${diag}`);
        assert.ok(!diag.includes("GB"), `diagnostic must not misreport bytes as GB, got: ${diag}`);
    });

    it("pins the default 32.0 MB truncation diagnostic wording", () => {
        const original = process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES;
        delete process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES;
        try {
            const totalBytes = 32 * 1024 * 1024 + 1024;
            const tail = event("message_end", { message: { role: "assistant", content: [{ type: "text", text: "tail answer" }], usage: { input: 1, output: 1 } } });
            makeSparseLog(PARSE_RUN_ID, totalBytes, tail);

            const r = parseRun(PARSE_RUN_ID);
            assert.equal(r.finalText, "tail answer");
            assert.deepEqual(r.diagnostics, [
                "Log truncated: parsed last 32.0 MB of 32.0 MB. Only recent activity is reflected in tokens/tools.",
            ]);
        } finally {
            if (original !== undefined) process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES = original;
            else delete process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES;
        }
    });
});

describe("tailLog", () => {
    before(() => cleanup(TAIL_RUN_ID));
    after(() => cleanup(TAIL_RUN_ID));

    it("returns the last n lines of a log", () => {
        writeLog(TAIL_RUN_ID, ["line 1", "line 2", "line 3", "line 4"]);
        assert.equal(tailLog(TAIL_RUN_ID, 2), "line 3\nline 4");
        assert.equal(tailLog(TAIL_RUN_ID, 1), "line 4");
    });

    it("returns '(no output yet)' for an empty or missing log", () => {
        cleanup(TAIL_RUN_ID);
        assert.equal(tailLog(TAIL_RUN_ID, 10), "(no output yet)");
        writeLog(TAIL_RUN_ID, [""]);
        assert.equal(tailLog(TAIL_RUN_ID, 10), "(no output yet)");
    });

    it("avoids whole-file reads on logs larger than MAX_STRING_LENGTH", () => {
        const MAX = bufferConstants.MAX_STRING_LENGTH;
        const tail = ["recent 1", "recent 2", "recent 3"].join("\n");
        makeSparseLog(TAIL_RUN_ID, MAX + 1024, tail);
        assert.equal(tailLog(TAIL_RUN_ID, 2), "recent 2\nrecent 3");
    });

    it("preserves partial raw bytes when a single line exceeds the raw tail window", () => {
        // Reproduce issue #73: a 300,072-byte terminal event must still leave
        // visible bytes in the raw tail fallback, not be discarded as a
        // "partial first line".
        const marker = '"type":"tool_execution_end","toolName":"big_tool"';
        const suffix = ":::END_OF_BIG_EVENT:::";
        const payload = marker + "x".repeat(300072 - marker.length - suffix.length - 1) + suffix;
        const hugeLine = JSON.stringify({ type: "tool_execution_end", toolName: "big_tool", output: payload }) + "\n";
        mkdirSync(runDir(TAIL_RUN_ID), { recursive: true });
        writeFileSync(logPathFor(TAIL_RUN_ID), hugeLine, "utf-8");

        const raw = tailLog(TAIL_RUN_ID, 40);
        assert.notEqual(raw, "(no output yet)", "raw tail must not be empty when bytes exist");
        assert.ok(raw.includes(suffix), `raw tail must preserve the end of the huge line, got length ${raw.length}`);

        // Formatter must show the raw-tail fallback marker when parsed activity is unavailable.
        const body = formatSubagentOutputBody("[head]", "", undefined, raw, ["truncated"]);
        assert.ok(body.includes("(no parsed output yet)"), "formatter must show raw-tail fallback marker");
        assert.ok(body.includes("--- raw log tail ---"), "formatter must include raw log tail section");
        assert.ok(body.includes(suffix), "formatter body must include the preserved raw bytes");
    });
});


describe("formatSubagentOutputBody", () => {
    it("shows parsed body when available", () => {
        const out = formatSubagentOutputBody("[head]", "", "parsed", "raw", []);
        assert.equal(out, "[head]\nparsed");
    });

    it("falls back to raw tail when parsed body is missing", () => {
        const out = formatSubagentOutputBody("[head]", "", undefined, "line 1\nline 2", []);
        assert.ok(out.includes("(no parsed output yet)"));
        assert.ok(out.includes("--- raw log tail ---"));
        assert.ok(out.includes("line 2"));
    });

    it("shows (no output yet) when raw tail is empty", () => {
        const out = formatSubagentOutputBody("[head]", "", undefined, "(no output yet)", []);
        assert.equal(out, "[head]\n(no output yet)");
    });

    it("appends diagnostics when present", () => {
        const out = formatSubagentOutputBody("[head]", "", "parsed", "raw", ["truncated"]);
        assert.ok(out.includes("[parser: truncated]"));
    });
});

describe("formatSubagentResultBody", () => {
    it("shows final text when available", () => {
        const out = formatSubagentResultBody("[head]", "final", "raw", []);
        assert.equal(out, "[head]\nfinal");
    });

    it("falls back to raw tail when final text is missing", () => {
        const out = formatSubagentResultBody("[head]", undefined, "line 1\nline 2", []);
        assert.ok(out.includes("(no final answer parsed)"));
        assert.ok(out.includes("--- raw log tail ---"));
    });

    it("appends diagnostics when present", () => {
        const out = formatSubagentResultBody("[head]", "final", "raw", ["truncated"]);
        assert.ok(out.includes("[parser: truncated]"));
    });
});
