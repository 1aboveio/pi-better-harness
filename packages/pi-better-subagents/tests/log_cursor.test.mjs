/**
 * Unit tests for incremental NDJSON log reading (log-cursor.ts).
 *
 * The UI hot path reads run logs that reach gigabytes, so it must read only the
 * bytes appended since the previous frame. The cursor must never hand a caller a
 * half-written line, must notice a log that was rotated or rewritten behind its
 * back, and must never fall permanently behind a log that outran its budget.
 *
 * // @covers health.log-cursor
 * // @level unit
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_MAX_READ_BYTES, readAppendedLines } from "../log-cursor.ts";

const dirs = [];
after(() => {
    for (const dir of dirs) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    }
});

function logFile(body = "") {
    const dir = mkdtempSync(join(tmpdir(), "pi-log-cursor-"));
    dirs.push(dir);
    const path = join(dir, "output.log");
    writeFileSync(path, body, "utf-8");
    return path;
}

describe("readAppendedLines — append-only reading", () => {
    it("reads a whole small log cold, then only what was appended", () => {
        const path = logFile("one\ntwo\n");

        const first = readAppendedLines(path);
        assert.deepEqual(first.lines, ["one", "two"]);
        assert.equal(first.truncated, false);
        assert.equal(first.restarted, false);
        assert.equal(first.cursor.offset, 8);

        appendFileSync(path, "three\n", "utf-8");
        const second = readAppendedLines(path, first.cursor);
        assert.deepEqual(second.lines, ["three"], "only the appended line");
        assert.equal(second.restarted, false);
        assert.equal(second.cursor.offset, 14);
    });

    it("returns nothing when the log has not grown", () => {
        const path = logFile("one\n");
        const first = readAppendedLines(path);
        const second = readAppendedLines(path, first.cursor);
        assert.deepEqual(second.lines, []);
        assert.equal(second.cursor.offset, first.cursor.offset);
    });

    it("holds back a half-written trailing line until its newline arrives", () => {
        const path = logFile("done\n");
        const first = readAppendedLines(path);
        assert.deepEqual(first.lines, ["done"]);

        appendFileSync(path, '{"type":"tool_execu', "utf-8");
        const partial = readAppendedLines(path, first.cursor);
        assert.deepEqual(partial.lines, [], "no line is emitted mid-write");
        assert.equal(partial.cursor.offset, first.cursor.offset, "cursor waits at the line boundary");

        appendFileSync(path, 'tion_start"}\n', "utf-8");
        const complete = readAppendedLines(path, partial.cursor);
        assert.deepEqual(complete.lines, ['{"type":"tool_execution_start"}'], "line delivered once whole");
    });

    it("decodes multi-byte characters split across reads", () => {
        const path = logFile("");
        const first = readAppendedLines(path);
        const snowman = Buffer.from("☃", "utf-8");
        assert.equal(snowman.length, 3);

        appendFileSync(path, snowman.subarray(0, 2)); // half a character, no newline
        const mid = readAppendedLines(path, first.cursor);
        assert.deepEqual(mid.lines, []);

        appendFileSync(path, Buffer.concat([snowman.subarray(2), Buffer.from("\n")]));
        const done = readAppendedLines(path, mid.cursor);
        assert.deepEqual(done.lines, ["☃"], "character is whole once both halves landed");
    });
});

describe("readAppendedLines — rotation and rewrite", () => {
    it("re-reads from scratch when the log shrank", () => {
        const path = logFile("first\nsecond\n");
        const first = readAppendedLines(path);
        assert.equal(first.cursor.offset, 13);

        writeFileSync(path, "fresh\n", "utf-8");
        const second = readAppendedLines(path, first.cursor);
        assert.equal(second.restarted, true, "a shorter log is a different log");
        assert.deepEqual(second.lines, ["fresh"]);
        assert.equal(second.cursor.offset, 6);
    });

    it("re-reads from scratch when the head changed under the same length", () => {
        const path = logFile("aaaa\nbbbb\n");
        const first = readAppendedLines(path);
        assert.deepEqual(first.lines, ["aaaa", "bbbb"]);

        writeFileSync(path, "xxxx\nyyyy\n", "utf-8");
        const second = readAppendedLines(path, first.cursor);
        assert.equal(second.restarted, true);
        assert.deepEqual(second.lines, ["xxxx", "yyyy"]);
    });

    it("treats a log still shorter than the head sample as the same log as it grows", () => {
        const path = logFile("a\n");
        const first = readAppendedLines(path);
        const second = readAppendedLines(path, first.cursor);
        assert.equal(second.restarted, false);

        appendFileSync(path, "b\n", "utf-8");
        const third = readAppendedLines(path, second.cursor);
        assert.equal(third.restarted, false, "growth is not a rewrite");
        assert.deepEqual(third.lines, ["b"]);
    });
});

describe("readAppendedLines — bounded reads", () => {
    it("skips ahead instead of lagging when a log outran the budget", () => {
        const line = `${"x".repeat(99)}\n`; // 100 bytes
        const path = logFile(line.repeat(50)); // 5000 bytes

        const read = readAppendedLines(path, undefined, 250);
        assert.equal(read.truncated, true, "bytes were skipped");
        assert.equal(read.totalBytes, 5000);
        assert.equal(read.cursor.offset, 5000, "cursor caught up to the end of the log");
        // 250 bytes covers 2.5 lines; the leading partial line is dropped.
        assert.deepEqual(read.lines, ["x".repeat(99), "x".repeat(99)]);
    });

    it("does not re-read an oversized partial line forever", () => {
        const path = logFile("");
        const first = readAppendedLines(path, undefined, 64);
        appendFileSync(path, "y".repeat(500), "utf-8"); // no newline at all

        const second = readAppendedLines(path, first.cursor, 64);
        assert.deepEqual(second.lines, []);
        assert.equal(second.restarted, false, "first content in an empty log is not a rewrite");
        assert.equal(second.cursor.offset, 500, "cursor moves past a line it can never buffer");

        appendFileSync(path, "\nafter\n", "utf-8");
        const third = readAppendedLines(path, second.cursor, 64);
        assert.deepEqual(third.lines, ["", "after"], "reading resumes at the next boundary");
    });

    it("defaults to a 32 MiB budget", () => {
        assert.equal(DEFAULT_MAX_READ_BYTES, 32 * 1024 * 1024);
    });
});

describe("readAppendedLines — failure", () => {
    it("reports a missing log instead of throwing", () => {
        const read = readAppendedLines(join(mkdtempSync(join(tmpdir(), "pi-log-cursor-")), "absent.log"));
        assert.ok(read.error, "error is reported");
        assert.deepEqual(read.lines, []);
        assert.equal(read.totalBytes, 0);
    });

    it("keeps the caller's cursor when the log cannot be read", () => {
        const path = logFile("one\n");
        const first = readAppendedLines(path);
        rmSync(path, { force: true });
        const second = readAppendedLines(path, first.cursor);
        assert.ok(second.error);
        assert.equal(second.cursor.offset, first.cursor.offset);
        assert.equal(second.restarted, false, "an unreadable log is not a restart");
    });
});
