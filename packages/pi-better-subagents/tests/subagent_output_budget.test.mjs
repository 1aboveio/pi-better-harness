/**
 * Registered subagent list/output/result payloads (#312).
 *
 * Exercises the factory tools the model actually calls: total UTF-8 budgets,
 * verbatim reconstruction, missing/unreadable evidence, cursors, and the
 * absence of ordinary tool-name sequences / usage boilerplate.
 *
 * // @covers subagent.result
 * // @covers subagent.output
 * // @covers subagent.list
 * // @level unit
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { observeFailures } from "../shared-failure-observations.ts";
import { failurePath } from "../failures.ts";
import { logPathFor, readMeta, runDir, writeMeta } from "../registry.ts";
import { subagentListTool, subagentOutputTool, subagentResultTool } from "../tools.ts";
import { listIncidentComputationCount } from "../output-payload.ts";
import {
    OUTPUT_BUDGET_BYTES,
    utf8ByteLength,
} from "../shared-log-utils.ts";

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

const TypeStub = {
    Object: (v) => v,
    String: (v) => v,
    Number: (v) => v,
    Boolean: (v) => v,
    Array: (v) => v,
    Optional: (v) => v,
};

const resultTool = subagentResultTool(TypeStub);
const outputTool = subagentOutputTool(TypeStub);
const listTool = subagentListTool(TypeStub);

function textOf(result) {
    return result.content.map((c) => c.text ?? "").join("\n");
}

function nextCursorOf(content) {
    const match = String(content).match(/\bnextCursor=(\S+)/);
    return match?.[1];
}

function statusCursorOf(content) {
    const match = String(content).match(/\bstatusCursor=(\S+)/);
    return match?.[1];
}

function stripEnvelope(content) {
    let body = String(content);
    const cont = body.indexOf("\n---\n");
    if (cont !== -1) body = body.slice(0, cont);
    const nl = body.indexOf("\n");
    if (nl === -1) return "";
    body = body.slice(nl + 1);
    return body.replace(/\nstatusCursor=\S+\s*$/, "");
}

async function reconstructAnswer(id, original) {
    let cursor;
    let text = "";
    for (let pages = 1; pages <= 10_000; pages += 1) {
        const content = textOf(await resultTool.execute("tc", { id, cursor }));
        assert.ok(utf8ByteLength(content) <= OUTPUT_BUDGET_BYTES.answer, `page ${pages} exceeded answer budget`);
        text += stripEnvelope(content);
        if (!/hasMore=true/.test(content)) return { text, pages, last: content };
        const next = nextCursorOf(content);
        assert.ok(next, "hasMore requires nextCursor");
        assert.notEqual(next, cursor);
        cursor = next;
    }
    throw new Error(`did not reconstruct ${original.length} chars`);
}

/** Retained raw bytes of one raw page: the text after its header lines and before the continuation. */
function rawBody(content) {
    let body = String(content);
    const cont = body.indexOf("\n---\n");
    if (cont !== -1) body = body.slice(0, cont);
    const lines = body.split("\n").slice(1);
    const header = /^(Observation incomplete|Action required|Unclassified failure observation|Expected failure|\d+ active failure observation|\[parser:|change=|reset=)/;
    while (lines.length && header.test(lines[0])) lines.shift();
    return lines.join("\n");
}

function seedMeta(id, extras = {}) {
    writeMeta({
        id,
        name: extras.name ?? "reviewer",
        status: extras.status ?? "completed",
        pid: extras.pid ?? 0,
        spawnPid: extras.spawnPid ?? THIS_PID,
        cwd: extras.cwd ?? "/tmp",
        promptPreview: extras.promptPreview ?? `task ${id}`,
        startedAt: extras.startedAt ?? 1_700_000_000_000,
        endedAt: extras.endedAt ?? 1_700_000_045_000,
        exitCode: extras.exitCode,
        logPath: logPathFor(id),
        sessionId: id,
        ...extras,
    });
    mkdirSync(runDir(id), { recursive: true });
}

function writeEvents(id, events) {
    mkdirSync(runDir(id), { recursive: true });
    writeFileSync(
        logPathFor(id),
        `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
}

function completedLog(finalText, extras = {}) {
    return [
        {
            type: "tool_execution_start",
            toolCallId: "call_bash",
            toolName: "bash",
            args: { command: "secret-env-dump" },
        },
        {
            type: "tool_execution_end",
            toolCallId: "call_bash",
            toolName: "bash",
            isError: false,
            result: { content: [{ type: "text", text: "ok" }] },
        },
        {
            type: "tool_execution_start",
            toolCallId: "call_read",
            toolName: "read",
        },
        {
            type: "tool_execution_end",
            toolCallId: "call_read",
            toolName: "read",
            isError: false,
        },
        {
            type: "message_end",
            message: {
                role: "assistant",
                content: [{ type: "text", text: finalText }],
                usage: extras.usage ?? { input: 400, output: 800, total: 1200, cost: { total: 0.0034 } },
            },
        },
        { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: finalText }] }] },
    ];
}

describe("registered subagent payloads", () => {
    it("omits ordered tool-name sequences and default usage/cost from ordinary result/output/list", async () => {
        const id = trackDisk(`sa_budget_tools_${Date.now()}`);
        seedMeta(id, { status: "completed", exitCode: 0 });
        writeEvents(id, completedLog("the findings are ready"));

        const result = textOf(await resultTool.execute("tc", { id }));
        const output = textOf(await outputTool.execute("tc", { id }));
        const list = textOf(await listTool.execute("tc", {}));

        for (const payload of [result, output, list]) {
            assert.doesNotMatch(payload, /tools used:/i);
            assert.doesNotMatch(payload, / · tools: /);
            assert.doesNotMatch(payload, /bash, read/);
            assert.doesNotMatch(payload, /1\.2k tok/);
            assert.doesNotMatch(payload, /\$0\.0034/);
            assert.doesNotMatch(payload, /secret-env-dump/);
            assert.ok(utf8ByteLength(payload) <= OUTPUT_BUDGET_BYTES.answer);
        }
        assert.match(result, /the findings are ready/);
        assert.match(result, /lifecycle complete/);
        assert.doesNotMatch(result, /terminal event: yes/i);
        assert.ok(list.includes(id), list);
    });

    it("reconstructs a huge mixed-ASCII/Unicode final answer through default answer pages", async () => {
        const id = trackDisk(`sa_budget_unicode_${Date.now()}`);
        const unit = "café😀"; // 4 + 4 UTF-8 bytes
        const original = `${unit.repeat(3000)}\nEND_MARK_${id}`;
        assert.ok(utf8ByteLength(original) > OUTPUT_BUDGET_BYTES.answer);
        seedMeta(id, { status: "completed", exitCode: 0 });
        writeEvents(id, completedLog(original));

        const { text, pages, last } = await reconstructAnswer(id, original);
        assert.equal(text, original);
        assert.ok(pages > 1, `expected multiple pages, got ${pages}`);
        assert.doesNotMatch(last, /hasMore=true/);

        const first = textOf(await resultTool.execute("tc", { id }));
        const again = textOf(await resultTool.execute("tc", { id }));
        assert.equal(stripEnvelope(again), stripEnvelope(first));
    });

    it("replays the same page cursor independently and continues from nextCursor", async () => {
        const id = trackDisk(`sa_budget_cursors_${Date.now()}`);
        const original = `LINE-${"x".repeat(12_000)}-END`;
        seedMeta(id, { status: "completed", exitCode: 0 });
        writeEvents(id, completedLog(original));

        const page1 = textOf(await resultTool.execute("tc", { id }));
        const cursor1 = nextCursorOf(page1);
        assert.ok(cursor1);
        const page1b = textOf(await resultTool.execute("tc", { id }));
        assert.equal(stripEnvelope(page1b), stripEnvelope(page1));

        const page2a = textOf(await resultTool.execute("tc", { id, cursor: cursor1 }));
        const page2b = textOf(await resultTool.execute("tc", { id, cursor: cursor1 }));
        assert.equal(stripEnvelope(page2a), stripEnvelope(page2b), "two callers holding the same cursor must see the same page");
        assert.notEqual(stripEnvelope(page1), stripEnvelope(page2a));
        const rebuilt = await reconstructAnswer(id, original);
        assert.equal(rebuilt.text, original);
    });

    it("keeps a single huge line pageable without dropping unread bytes", async () => {
        const id = trackDisk(`sa_budget_longline_${Date.now()}`);
        const original = `{"event":"${"n".repeat(20_000)}","ok":true}`;
        seedMeta(id, { status: "completed", exitCode: 0 });
        writeEvents(id, completedLog(original));

        const rebuilt = await reconstructAnswer(id, original);
        assert.equal(rebuilt.text, original);
        assert.ok(rebuilt.pages > 1);
        const first = textOf(await resultTool.execute("tc", { id }));
        assert.ok(utf8ByteLength(first) <= OUTPUT_BUDGET_BYTES.answer);
        assert.match(first, /hasMore=true/);
        assert.match(first, /omittedBytes=\d+/);
    });

    it("surfaces many failures before progress and counts omitted incidents", async () => {
        const id = trackDisk(`sa_budget_failures_${Date.now()}`);
        seedMeta(id, { status: "completed", exitCode: 0 });
        const events = [];
        for (let i = 0; i < 12; i += 1) {
            events.push({
                type: "tool_execution_start",
                toolCallId: `call_${i}`,
                toolName: "bash",
                args: { command: `do-${i}` },
            });
            events.push({
                type: "tool_execution_end",
                toolCallId: `call_${i}`,
                toolName: "bash",
                isError: true,
                result: {
                    isError: true,
                    content: [{ type: "text", text: `incident-${i}-failed` }],
                },
            });
        }
        events.push({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: "PROGRESS_TEXT" }] },
        });
        events.push({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "PROGRESS_TEXT" }] }] });
        writeEvents(id, events);

        const result = textOf(await resultTool.execute("tc", { id }));
        assert.ok(utf8ByteLength(result) <= OUTPUT_BUDGET_BYTES.answer);
        // #315: a completed run counts unclassified tool failures instead of presenting them as its outcome.
        const failureAt = result.indexOf("12 earlier tool failures remain unclassified.");
        const progressAt = result.indexOf("PROGRESS_TEXT");
        assert.ok(failureAt >= 0, result);
        assert.ok(progressAt > failureAt, "failures must precede progress");
        const counts = result.match(/12 active failure observations · (\d+) shown · (\d+) omitted · incidentCursor=i1\./);
        assert.ok(counts, result);
        assert.equal(Number(counts[1]) + Number(counts[2]), 12);
        assert.equal(Number(counts[1]), 0, "unclassified rows are paged, not re-listed");
        assert.match(result, /Work correctness was not inferred from lifecycle alone\./);
        assert.doesNotMatch(result.slice(0, progressAt), /incident-\d+-failed/);
        assert.doesNotMatch(result, /tools used:/i);
        assert.doesNotMatch(result, /do-0.*do-1.*do-2/);
        const incidentCursor = result.match(/incidentCursor=(i1\.\S+)/)?.[1];
        assert.ok(incidentCursor, result);
        let cursor = incidentCursor;
        const pages = [result];
        for (let i = 0; i < 20 && cursor; i += 1) {
            const page = textOf(await resultTool.execute("tc", { id, cursor }));
            pages.push(page);
            assert.ok(utf8ByteLength(page) <= OUTPUT_BUDGET_BYTES.answer, page);
            const next = page.match(/\bnextCursor=(i1\.\S+)/)?.[1];
            if (!page.includes("hasMore=true") || !next || next === cursor) break;
            cursor = next;
        }
        const occurrences = new Map();
        for (const page of pages) {
            for (const match of page.matchAll(/incident-(\d+)-failed/g)) {
                occurrences.set(match[1], (occurrences.get(match[1]) ?? 0) + 1);
            }
        }
        assert.deepEqual([...occurrences.keys()].sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => String(i)));
        assert.ok([...occurrences.values()].every((count) => count === 1), "each incident is shown exactly once across the summary and its pages");
    });

    it("keeps incomplete and orphaned results diagnostic, not clean final answers", async () => {
        const incompleteId = trackDisk(`sa_budget_incomplete_${Date.now()}`);
        seedMeta(incompleteId, { status: "failed", exitCode: 0, failureReason: "incomplete-stream", lifecycleClassification: "incomplete_no_terminal_event" });
        writeEvents(incompleteId, [
            { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "progress before exit" }] } },
            { type: "tool_execution_start", toolCallId: "call_bash", toolName: "bash" },
        ]);
        const incomplete = textOf(await resultTool.execute("tc", { id: incompleteId }));
        assert.match(incomplete, /ended unexpectedly/i);
        assert.match(incomplete, /lifecycle incomplete_no_terminal_event/);
        assert.match(incomplete, /unmatched tools: bash \(call_bash\)/);
        assert.match(incomplete, /progress before exit/);
        assert.doesNotMatch(incomplete, /tools used:/i);
        assert.ok(utf8ByteLength(incomplete) <= OUTPUT_BUDGET_BYTES.answer);
        assert.ok(incomplete.indexOf("ended unexpectedly") < incomplete.indexOf("progress before exit"));

        const orphanId = trackDisk(`sa_budget_orphan_${Date.now()}`);
        seedMeta(orphanId, { status: "orphaned", pid: 0x3ffffff0, pgid: 0x3ffffff0, endedAt: undefined });
        writeEvents(orphanId, [
            { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial assistant progress" }] } },
        ]);
        const orphaned = textOf(await resultTool.execute("tc", { id: orphanId }));
        assert.match(orphaned, /orphaned/i);
        assert.match(orphaned, /non-final|no final result/i);
        assert.match(orphaned, /partial assistant progress/);
        assert.doesNotMatch(orphaned, /tools used:/i);
        assert.doesNotMatch(orphaned, /✓ completed/);
        assert.ok(utf8ByteLength(orphaned) <= OUTPUT_BUDGET_BYTES.answer);
    });

    it("does not treat a missing log as empty healthy output", async () => {
        const id = trackDisk(`sa_budget_nolog_${Date.now()}`);
        seedMeta(id, { status: "running", pid: THIS_PID, endedAt: undefined });
        // No log file.
        const output = textOf(await outputTool.execute("tc", { id }));
        assert.match(output, /unreadable|missing|gap read/i);
        assert.doesNotMatch(output, /^\[.*\]\n\(no output yet\)$/m);
        assert.ok(!/^[\s]*$/.test(output));
        assert.ok(utf8ByteLength(output) <= OUTPUT_BUDGET_BYTES.log);
    });

    it("does not report unreadable metadata as a conclusively missing run", async () => {
        const id = trackDisk(`sa_budget_badmeta_${Date.now()}`);
        mkdirSync(runDir(id), { recursive: true });
        writeFileSync(join(runDir(id), "meta.json"), "{this is not json", "utf8");
        const output = textOf(await outputTool.execute("tc", { id }));
        const result = textOf(await resultTool.execute("tc", { id }));
        for (const payload of [output, result]) {
            assert.match(payload, /unreadable/i);
            assert.doesNotMatch(payload, /Unknown run id/);
            assert.match(payload, new RegExp(id));
        }
    });

    it("returns a small unchanged payload until failures change", async () => {
        const id = trackDisk(`sa_budget_status_${Date.now()}`);
        seedMeta(id, { status: "running", pid: THIS_PID, endedAt: undefined });
        writeEvents(id, [
            { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "still working" }] } },
        ]);
        const first = textOf(await outputTool.execute("tc", { id }));
        const statusCursor = statusCursorOf(first);
        assert.ok(statusCursor, first);
        const unchanged = textOf(await outputTool.execute("tc", { id, cursor: statusCursor }));
        assert.match(unchanged, /No new evidence since cursor/);
        assert.ok(utf8ByteLength(unchanged) < 512);

        observeFailures(failurePath(id), [{
            id: "manual-incident",
            operation: "tool:bash",
            kind: "failure",
            summary: "late incident after cursor",
        }]);
        const updated = textOf(await outputTool.execute("tc", { id, cursor: statusCursor }));
        assert.doesNotMatch(updated, /No new evidence since cursor/);
        assert.match(updated, /late incident after cursor/);
    });

    it("resets a stale cursor instead of serving shifted bytes", async () => {
        const id = trackDisk(`sa_budget_stale_${Date.now()}`);
        seedMeta(id, { status: "completed", exitCode: 0 });
        writeEvents(id, completedLog("stable-answer"));
        const stale = textOf(await resultTool.execute("tc", { id, cursor: "not-a-real-cursor" }));
        assert.match(stale, /reset=stale-cursor/);
        assert.match(stale, /stable-answer/);
    });

    it("pages retained raw evidence at the raw default without skipping unread bytes", async () => {
        const id = trackDisk(`sa_budget_raw_${Date.now()}`);
        seedMeta(id, { status: "completed", exitCode: 0 });
        const marker = "RAW_END_MARKER";
        const blob = `${"R".repeat(80_000)}${marker}`;
        writeFileSync(logPathFor(id), blob);
        let cursor;
        let text = "";
        for (let pages = 1; pages <= 20; pages += 1) {
            const content = textOf(await outputTool.execute("tc", { id, mode: "raw", cursor }));
            assert.ok(utf8ByteLength(content) <= OUTPUT_BUDGET_BYTES.rawPage, `raw page ${pages} exceeded raw budget`);
            text += rawBody(content);
            if (!/hasMore=true/.test(content)) break;
            cursor = nextCursorOf(content);
        }
        assert.equal(text, blob, "raw pages must concatenate to the retained bytes exactly");
    });

    it("paginates list rows under the list budget without full failure paragraphs", async () => {
        const stamp = Date.now();
        const ids = [];
        for (let i = 0; i < 40; i += 1) {
            const id = trackDisk(`sa_budget_list_${stamp}_${String(i).padStart(2, "0")}`);
            ids.push(id);
            seedMeta(id, {
                status: "completed",
                exitCode: 0,
                startedAt: 1_700_000_000_000 + i,
                endedAt: 1_700_000_000_000 + i + 1_000,
                promptPreview: `prompt-preview-${id}-${"p".repeat(80)}`,
            });
            writeEvents(id, completedLog("ok"));
            observeFailures(failurePath(id), [{
                id: `list-fail-${id}`,
                operation: `tool:${id}`,
                kind: "failure",
                summary: `very long unresolved failure paragraph for ${id} ${"x".repeat(400)}`,
            }]);
        }
        const first = textOf(await listTool.execute("tc", { limit: 100 }));
        assert.ok(utf8ByteLength(first) <= OUTPUT_BUDGET_BYTES.list, `list page was ${utf8ByteLength(first)} bytes`);
        assert.doesNotMatch(first, /very long unresolved failure paragraph/);
        assert.match(first, /incident/);
        if (/hasMore=true/.test(first)) {
            const next = nextCursorOf(first);
            const second = textOf(await listTool.execute("tc", { limit: 100, cursor: next }));
            assert.ok(utf8ByteLength(second) <= OUTPUT_BUDGET_BYTES.list);
            assert.notEqual(stripEnvelope(first), stripEnvelope(second));
        }
        assert.ok(ids.some((id) => first.includes(id)), first);
    });

    it("defaults output to 10 lines and keeps the rest behind nextCursor", async () => {
        const id = trackDisk(`sa_budget_lines_${Date.now()}`);
        const original = Array.from({ length: 25 }, (_, i) => `output-line-${String(i + 1).padStart(2, "0")}`).join("\n");
        seedMeta(id, { status: "completed", exitCode: 0 });
        writeEvents(id, completedLog(original));
        const first = textOf(await outputTool.execute("tc", { id }));
        assert.ok(utf8ByteLength(first) <= OUTPUT_BUDGET_BYTES.log);
        assert.match(first, /output-line-01/);
        assert.doesNotMatch(first, /output-line-25/);
        assert.match(first, /hasMore=true/);
        const next = nextCursorOf(first);
        assert.ok(next);
        const second = textOf(await outputTool.execute("tc", { id, cursor: next }));
        assert.match(second, /output-line-11|output-line-12/);
    });

    it("filters list and direct reads to the current session unless all:true", async () => {
        const stamp = Date.now();
        const originA = { cwd: "/tmp", sessionId: `sess-a-${stamp}` };
        const originB = { cwd: "/tmp", sessionId: `sess-b-${stamp}` };
        const idA = trackDisk(`sa_budget_sess_a_${stamp}`);
        const idB = trackDisk(`sa_budget_sess_b_${stamp}`);
        seedMeta(idA, { status: "completed", exitCode: 0, callbackOrigin: originA, promptPreview: "session-a-secret" });
        seedMeta(idB, { status: "completed", exitCode: 0, callbackOrigin: originB, promptPreview: "session-b-secret", startedAt: 9_000_000_000_000, endedAt: 9_000_000_000_001 });
        writeEvents(idA, completedLog("answer-from-session-a"));
        writeEvents(idB, completedLog("answer-from-session-b"));

        const sessionedList = subagentListTool(TypeStub, { getActiveOrigin: () => originA });
        const sessionedResult = subagentResultTool(TypeStub, { getActiveOrigin: () => originA });
        const sessionedOutput = subagentOutputTool(TypeStub, { getActiveOrigin: () => originA });

        const listed = textOf(await sessionedList.execute("tc", {}));
        assert.match(listed, new RegExp(idA));
        assert.doesNotMatch(listed, new RegExp(idB));
        assert.doesNotMatch(listed, /session-b-secret/);
        assert.doesNotMatch(listed, /answer-from-session-b/);

        const foreign = textOf(await sessionedResult.execute("tc", { id: idB }));
        assert.match(foreign, /foreign session/i);
        assert.doesNotMatch(foreign, /answer-from-session-b/);
        assert.doesNotMatch(foreign, /Unknown run id/);

        const foreignOut = textOf(await sessionedOutput.execute("tc", { id: idB }));
        assert.match(foreignOut, /foreign session/i);
        assert.doesNotMatch(foreignOut, /answer-from-session-b/);

        const allowed = textOf(await sessionedResult.execute("tc", { id: idB, all: true }));
        assert.match(allowed, /answer-from-session-b/);

        const globalList = textOf(await sessionedList.execute("tc", { all: true, limit: 10, maxBytes: 4096 }));
        assert.match(globalList, new RegExp(idB));
    });

    it("does not leak evidence when session ownership cannot be read", async () => {
        const id = trackDisk(`sa_budget_unknown_${Date.now()}`);
        seedMeta(id, { status: "completed", exitCode: 0, callbackOrigin: { cwd: "/tmp", sessionId: "hidden" } });
        writeEvents(id, completedLog("classified-answer"));
        const tool = subagentResultTool(TypeStub, { getActiveOrigin: () => undefined });
        const payload = textOf(await tool.execute("tc", { id }));
        assert.match(payload, /ownership unavailable/i);
        assert.doesNotMatch(payload, /classified-answer/);
        assert.doesNotMatch(payload, /Unknown run id/);
        const listed = textOf(await subagentListTool(TypeStub, { getActiveOrigin: () => undefined }).execute("tc", {}));
        assert.doesNotMatch(listed, new RegExp(id));
        assert.match(listed, /Session identity unavailable|No subagent runs match filters/i);
    });

    it("binds list cursors to the selected session scope", async () => {
        const stamp = Date.now();
        const originA = { cwd: "/tmp", sessionId: `scope-a-${stamp}` };
        const originB = { cwd: "/tmp", sessionId: `scope-b-${stamp}` };
        const idsA = [];
        for (let i = 0; i < 12; i += 1) {
            const id = trackDisk(`sa_budget_scope_a_${stamp}_${i}`);
            idsA.push(id);
            seedMeta(id, {
                status: "completed",
                exitCode: 0,
                callbackOrigin: originA,
                startedAt: 1_700_000_000_000 + i,
                endedAt: 1_700_000_000_000 + i + 10,
            });
            writeEvents(id, completedLog("a"));
        }
        const idB = trackDisk(`sa_budget_scope_b_${stamp}`);
        seedMeta(idB, { status: "completed", exitCode: 0, callbackOrigin: originB, startedAt: 1_800_000_000_000 });
        writeEvents(idB, completedLog("b-secret"));
        const listA = subagentListTool(TypeStub, { getActiveOrigin: () => originA });
        const listB = subagentListTool(TypeStub, { getActiveOrigin: () => originB });
        const first = textOf(await listA.execute("tc", { limit: 5 }));
        const next = nextCursorOf(first);
        assert.ok(next, first);
        assert.equal(next.includes("b-secret"), false);
        const crossed = textOf(await listB.execute("tc", { cursor: next }));
        assert.match(crossed, /reset=stale-cursor|foreign|scope session:/);
        assert.doesNotMatch(crossed, /b-secret/);
        assert.ok(!idsA.some((id) => stripEnvelope(crossed).includes(id)) || /reset=stale-cursor/.test(crossed), crossed);
    });

    describe("review regressions (#312)", () => {
        const origin = { cwd: "/tmp", sessionId: `review-${Date.now()}` };
        const session = { getActiveOrigin: () => origin };
        const scopedResult = subagentResultTool(TypeStub, session);
        const scopedOutput = subagentOutputTool(TypeStub, session);
        const scopedList = subagentListTool(TypeStub, session);

        it("reconstructs a default answer exactly while long failures take priority", async () => {
            const id = trackDisk(`sa_review_heavy_${Date.now()}`);
            seedMeta(id, { status: "completed", exitCode: 0, callbackOrigin: origin });
            const answer = `BEGIN_${"答".repeat(1_600)}_END`;
            writeEvents(id, completedLog(answer));
            observeFailures(failurePath(id), Array.from({ length: 5 }, (_, i) => ({
                id: `heavy-${i}`, operation: `heavy-op-${i}`, kind: "failure",
                summary: `FAILURE_${i}_${"界".repeat(120)}`, evidence: "界".repeat(120),
            })));
            let cursor;
            let rebuilt = "";
            for (let page = 0; page < 20; page += 1) {
                const content = textOf(await scopedResult.execute("tc", { id, cursor }));
                assert.ok(utf8ByteLength(content) <= OUTPUT_BUDGET_BYTES.answer, `${utf8ByteLength(content)} bytes`);
                assert.match(content, /5 active failure observations · \d+ shown · \d+ omitted · incidentCursor=/);
                const start = content.indexOf(page === 0 ? "BEGIN_" : "答");
                const end = content.indexOf("\n---\n");
                const body = content.slice(start, end === -1 ? undefined : end);
                assert.ok(body.length > 0, `page ${page} shows answer bytes`);
                rebuilt += body;
                if (!/hasMore=true/.test(content)) break;
                cursor = nextCursorOf(content);
            }
            assert.equal(rebuilt, answer);
        });

        it("reports a metadata-only lifecycle transition against a status cursor", async () => {
            const id = trackDisk(`sa_review_lifecycle_${Date.now()}`);
            seedMeta(id, { status: "running", pid: process.pid, endedAt: undefined, exitCode: undefined, callbackOrigin: origin });
            writeEvents(id, [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "short" }] } }]);
            const before = textOf(await scopedOutput.execute("tc", { id }));
            const cursor = statusCursorOf(before);
            assert.match(textOf(await scopedOutput.execute("tc", { id, cursor })), /No new evidence since cursor/);
            writeMeta({ ...readMeta(id), status: "failed", endedAt: Date.now(), exitCode: 2 });
            const after = textOf(await scopedOutput.execute("tc", { id, cursor }));
            assert.doesNotMatch(after, /No new evidence/);
            assert.match(after, /failed/);
            assert.match(after, /change=content/);
        });

        it("reports list lifecycle and repeated-failure changes against a status cursor", async () => {
            const id = trackDisk(`sa_review_list_${Date.now()}`);
            seedMeta(id, { status: "failed", exitCode: 1, callbackOrigin: origin, startedAt: Date.now() + 10_000_000 });
            writeEvents(id, completedLog("x"));
            observeFailures(failurePath(id), [{ id: "rep-1", operation: "rep-op", kind: "failure", summary: "first" }]);
            const before = textOf(await scopedList.execute("tc", {}));
            const cursor = statusCursorOf(before);
            assert.match(textOf(await scopedList.execute("tc", { cursor })), /No new evidence/);
            observeFailures(failurePath(id), [{ id: "rep-2", operation: "rep-op", kind: "failure", summary: "second" }]);
            const repeated = textOf(await scopedList.execute("tc", { cursor }));
            assert.doesNotMatch(repeated, /No new evidence/);
            assert.match(repeated, /change=failure/);
            const cursor2 = statusCursorOf(repeated);
            writeMeta({ ...readMeta(id), status: "completed", exitCode: 0 });
            const transitioned = textOf(await scopedList.execute("tc", { cursor: cursor2 }));
            assert.doesNotMatch(transitioned, /No new evidence/);
        });

        it("reports missing metadata beside retained evidence as unreadable, not unknown", async () => {
            const id = trackDisk(`sa_review_nometa_${Date.now()}`);
            seedMeta(id, { status: "completed", exitCode: 0, callbackOrigin: origin });
            writeEvents(id, completedLog("retained evidence"));
            unlinkSync(join(runDir(id), "meta.json"));
            const payload = textOf(await scopedResult.execute("tc", { id }));
            assert.match(payload, /metadata unreadable/);
            assert.match(payload, /metadata file is missing/);
            assert.doesNotMatch(payload, /retained evidence/);
            await assert.rejects(() => scopedResult.execute("tc", { id: `sa_review_never_${Date.now()}` }), /Unknown run id/);
        });

        it("counts corrupt run records in the list instead of dropping them", async () => {
            const id = trackDisk(`sa_review_corrupt_${Date.now()}`);
            mkdirSync(runDir(id), { recursive: true });
            writeFileSync(join(runDir(id), "meta.json"), "{not json");
            const listed = textOf(await scopedList.execute("tc", {}));
            assert.match(listed, /run record\(s\) with missing or unreadable metadata/);
            assert.match(listed, /gap read/);
        });

        it("does not expose a legacy same-process run when session identity is unavailable", async () => {
            const id = trackDisk(`sa_review_legacy_${Date.now()}`);
            seedMeta(id, { status: "completed", exitCode: 0, spawnPid: process.pid, callbackOrigin: undefined });
            writeEvents(id, completedLog("UNVERIFIED_SESSION_EVIDENCE"));
            const unavailable = { getActiveOrigin: () => undefined };
            const payload = textOf(await subagentResultTool(TypeStub, unavailable).execute("tc", { id }));
            assert.match(payload, /ownership unavailable/);
            assert.doesNotMatch(payload, /UNVERIFIED_SESSION_EVIDENCE/);
            const listed = textOf(await subagentListTool(TypeStub, unavailable).execute("tc", {}));
            assert.doesNotMatch(listed, new RegExp(id));
            const allowed = textOf(await subagentResultTool(TypeStub, unavailable).execute("tc", { id, all: true }));
            assert.match(allowed, /UNVERIFIED_SESSION_EVIDENCE/);
        });

        it("resets answer and raw cursors when the session scope changes", async () => {
            const id = trackDisk(`sa_review_scope_${Date.now()}`);
            seedMeta(id, { status: "completed", exitCode: 0, callbackOrigin: origin });
            writeEvents(id, completedLog("answer ".repeat(2_000)));
            const answer = textOf(await scopedResult.execute("tc", { id }));
            const crossed = textOf(await scopedResult.execute("tc", { id, all: true, cursor: nextCursorOf(answer) }));
            assert.match(crossed, /reset=stale-cursor/);
            const raw = textOf(await scopedOutput.execute("tc", { id, mode: "raw", maxBytes: 4096 }));
            const rawCrossed = textOf(await scopedOutput.execute("tc", { id, mode: "raw", all: true, cursor: nextCursorOf(raw) }));
            assert.match(rawCrossed, /reset=stale-cursor/);
        });

        it("returns an append-ready raw cursor at the end and then only appended bytes", async () => {
            const id = trackDisk(`sa_review_eof_${Date.now()}`);
            seedMeta(id, { status: "completed", exitCode: 0, callbackOrigin: origin });
            writeEvents(id, completedLog("done"));
            const end = textOf(await scopedOutput.execute("tc", { id, mode: "raw" }));
            assert.doesNotMatch(end, /hasMore=true/);
            const cursor = end.match(/end nextCursor=(\S+)/)?.[1];
            assert.ok(cursor, end);
            appendFileSync(logPathFor(id), "APPENDED_LINE\n");
            const appended = textOf(await scopedOutput.execute("tc", { id, mode: "raw", cursor }));
            assert.match(appended, /APPENDED_LINE/);
            assert.doesNotMatch(appended, /tool_execution_start/);
        });

        it("resets a raw cursor after an in-place rewrite of the same log inode", async () => {
            const id = trackDisk(`sa_review_rewrite_${Date.now()}`);
            seedMeta(id, { status: "completed", exitCode: 0, callbackOrigin: origin });
            writeFileSync(logPathFor(id), `${"a".repeat(300)}${"b".repeat(30_000)}`);
            const inode = statSync(logPathFor(id)).ino;
            const first = textOf(await scopedOutput.execute("tc", { id, mode: "raw" }));
            writeFileSync(logPathFor(id), `${"a".repeat(300)}${"c".repeat(30_000)}`);
            assert.equal(statSync(logPathFor(id)).ino, inode);
            const next = textOf(await scopedOutput.execute("tc", { id, mode: "raw", cursor: nextCursorOf(first) }));
            assert.match(next, /reset=source-replaced/);
            assert.match(next, /a{300}c/);
        });

        it("keeps final-answer indentation and trailing newlines verbatim", async () => {
            const id = trackDisk(`sa_review_ws_${Date.now()}`);
            seedMeta(id, { status: "completed", exitCode: 0, callbackOrigin: origin });
            writeEvents(id, completedLog("  indented\n\n    code\n"));
            const payload = textOf(await scopedResult.execute("tc", { id }));
            assert.ok(payload.includes("\n  indented\n\n    code\n"), payload);
        });

        it("keeps a long-named run's id visible and pages every run", async () => {
            const stamp = Date.now() + 20_000_000;
            const ids = [];
            for (let i = 0; i < 4; i += 1) {
                const id = trackDisk(`sa_review_names_${stamp}_${i}`);
                ids.push(id);
                seedMeta(id, { status: "completed", exitCode: 0, callbackOrigin: origin, name: "n".repeat(2_000), startedAt: stamp + i });
                writeEvents(id, completedLog("x"));
            }
            const seen = new Set();
            let cursor;
            for (let page = 0; page < 10; page += 1) {
                const content = textOf(await scopedList.execute("tc", { cursor, limit: 2 }));
                assert.ok(utf8ByteLength(content) <= OUTPUT_BUDGET_BYTES.list);
                for (const id of ids) if (content.includes(id)) seen.add(id);
                if (!/hasMore=true/.test(content)) break;
                cursor = nextCursorOf(content);
            }
            for (const id of ids) assert.ok(seen.has(id), `${id} never listed`);
        });

        it("always shows a row or a usable cursor on a default list led by failures", async () => {
            const stamp = Date.now() + 40_000_000;
            const ids = [];
            for (let i = 0; i < 21; i += 1) {
                const id = trackDisk(`sa_review_lead_${stamp}_${String(i).padStart(2, "0")}`);
                ids.push(id);
                seedMeta(id, { status: "completed", exitCode: 0, callbackOrigin: origin, startedAt: stamp + i, promptPreview: "p".repeat(100) });
                writeEvents(id, completedLog("x"));
                observeFailures(failurePath(id), [{ id: `lead-${i}`, operation: `lead-op-${i}`, kind: "failure", summary: "e".repeat(450) }]);
            }
            const seen = new Set();
            let content = textOf(await scopedList.execute("tc", {}));
            for (let page = 0; page < 30; page += 1) {
                assert.ok(utf8ByteLength(content) <= OUTPUT_BUDGET_BYTES.list);
                for (const id of ids) if (content.includes(id)) seen.add(id);
                if (!/hasMore=true/.test(content)) break;
                const cursor = nextCursorOf(content);
                assert.ok(cursor, content);
                const next = textOf(await scopedList.execute("tc", { cursor }));
                assert.notEqual(next, content);
                content = next;
            }
            assert.equal(seen.size, 21);
        });
    });
});

describe("output-control aliases and opt-in facts (#321)", () => {
    it("accepts max_bytes and deprecated maxBytes on list/output/result; max_bytes wins", async () => {
        const id = trackDisk(`sa_alias_bytes_${Date.now()}`);
        seedMeta(id, { status: "completed", exitCode: 0 });
        writeEvents(id, completedLog(`ANSWER ${"a".repeat(6000)}`));
        for (const tool of [resultTool, outputTool]) {
            const canonical = textOf(await tool.execute("tc", { id, max_bytes: 700 }));
            assert.ok(utf8ByteLength(canonical) <= 700, canonical);
            assert.equal(stripEnvelope(textOf(await tool.execute("tc", { id, maxBytes: 700 }))), stripEnvelope(canonical));
            assert.equal(stripEnvelope(textOf(await tool.execute("tc", { id, max_bytes: 700, maxBytes: 4096 }))), stripEnvelope(canonical));
        }
        const list = textOf(await listTool.execute("tc", { maxBytes: 300 }));
        assert.ok(utf8ByteLength(list) <= 300, list);
        const listCanonical = textOf(await listTool.execute("tc", { max_bytes: 300, maxBytes: 4096 }));
        assert.ok(utf8ByteLength(listCanonical) <= 300, listCanonical);
    });

    it("declares canonical names and deprecated aliases in the schemas", () => {
        for (const tool of [resultTool, outputTool, listTool]) {
            const properties = tool.parameters;
            assert.ok(properties.max_bytes, tool.name);
            assert.match(properties.maxBytes.description, /Deprecated alias for max_bytes/, tool.name);
        }
        for (const tool of [resultTool, outputTool]) {
            assert.ok(tool.parameters.lines, tool.name);
            assert.match(tool.parameters.tail_lines.description, /Deprecated alias for lines/, tool.name);
            assert.ok("include" in tool.parameters, tool.name);
        }
    });

    it("subagent_output takes lines, with tail_lines as an alias that lines overrides", async () => {
        const id = trackDisk(`sa_alias_lines_${Date.now()}`);
        const answer = Array.from({ length: 40 }, (_, i) => `row-${String(i).padStart(2, "0")}`).join("\n");
        seedMeta(id, { status: "completed", exitCode: 0 });
        writeEvents(id, completedLog(answer));
        const canonical = textOf(await outputTool.execute("tc", { id, lines: 3 }));
        assert.equal(textOf(await outputTool.execute("tc", { id, tail_lines: 3 })), canonical);
        const both = textOf(await outputTool.execute("tc", { id, lines: 2, tail_lines: 9 }));
        assert.match(both, /row-01/);
        assert.doesNotMatch(both, /row-02/);
    });

    it("subagent_result pages the answer by lines when asked, and still reconstructs it", async () => {
        const id = trackDisk(`sa_result_lines_${Date.now()}`);
        const answer = Array.from({ length: 12 }, (_, i) => `answer-line-${String(i).padStart(2, "0")}`).join("\n") + "\n";
        seedMeta(id, { status: "completed", exitCode: 0 });
        writeEvents(id, completedLog(answer));
        const unlimited = textOf(await resultTool.execute("tc", { id }));
        assert.match(unlimited, /answer-line-11/);
        let cursor;
        let rebuilt = "";
        let pages = 0;
        for (; pages < 20; pages += 1) {
            const page = textOf(await resultTool.execute("tc", { id, lines: 5, cursor }));
            const body = stripEnvelope(page);
            assert.ok(body.split("\n").filter(Boolean).length <= 5, page);
            rebuilt += body;
            if (!/hasMore=true/.test(page)) break;
            cursor = nextCursorOf(page);
            assert.ok(cursor, page);
        }
        assert.equal(rebuilt, answer);
        assert.equal(pages + 1, 3);
        assert.equal(stripEnvelope(textOf(await resultTool.execute("tc", { id, tail_lines: 5 }))), stripEnvelope(textOf(await resultTool.execute("tc", { id, lines: 5 }))));
    });

    it("adds spend and tool-count lines only on explicit include", async () => {
        const id = trackDisk(`sa_include_${Date.now()}`);
        seedMeta(id, { status: "completed", exitCode: 0 });
        writeEvents(id, completedLog("the findings are ready"));
        for (const tool of [resultTool, outputTool]) {
            const plain = textOf(await tool.execute("tc", { id }));
            assert.doesNotMatch(plain, /spend:|tools: \d+ call/);
            const cost = textOf(await tool.execute("tc", { id, include: ["cost"] }));
            assert.match(cost, /spend: 1\.2k tok \(↑400 ↓800\) · \$0\.0034/);
            assert.doesNotMatch(cost, /tools: \d+ call/);
            const tools = textOf(await tool.execute("tc", { id, include: ["tools"] }));
            assert.match(tools, /tools: 2 calls · distinct: bash, read/);
            assert.doesNotMatch(tools, /spend:/);
            const both = textOf(await tool.execute("tc", { id, include: ["cost", "tools", "bogus"] }));
            assert.match(both, /spend: /);
            assert.match(both, /tools: 2 calls/);
            assert.match(both, /include: ignored unknown value\(s\) bogus; supported: cost, tools/);
            assert.match(both, /the findings are ready/);
            assert.ok(utf8ByteLength(both) <= OUTPUT_BUDGET_BYTES.answer);
        }
        const raw = textOf(await outputTool.execute("tc", { id, mode: "raw", include: ["tools"] }));
        assert.match(raw, /tools: 2 calls/);
        const nothing = trackDisk(`sa_include_empty_${Date.now()}`);
        seedMeta(nothing, { status: "completed", exitCode: 0 });
        writeEvents(nothing, [{ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] }]);
        const empty = textOf(await resultTool.execute("tc", { id: nothing, include: ["cost", "tools"] }));
        assert.match(empty, /spend: none recorded/);
        assert.match(empty, /tools: 0 calls/);
    });
});

describe("subagent_list incident cache (#323)", () => {
    it("does not rescan unchanged runs and recomputes only a run whose journal or log changed", async () => {
        const stamp = Date.now() + 90_000_000;
        const ids = [];
        for (let i = 0; i < 6; i += 1) {
            const id = trackDisk(`sa_list_cache_${stamp}_${i}`);
            ids.push(id);
            seedMeta(id, { status: "completed", exitCode: 0, startedAt: stamp + i });
            writeEvents(id, completedLog(`answer ${i}`));
        }
        await listTool.execute("tc", { limit: 100 });
        await listTool.execute("tc", { limit: 100 });
        const settled = listIncidentComputationCount();
        await listTool.execute("tc", { limit: 100 });
        assert.equal(listIncidentComputationCount() - settled, 0, "an unchanged registry is served from cache");

        observeFailures(failurePath(ids[2]), [{ id: "cache-probe", operation: "cache-op", kind: "failure", category: "operation", summary: "journal changed" }]);
        const before = listIncidentComputationCount();
        const changed = textOf(await listTool.execute("tc", { limit: 100, max_bytes: 4096 }));
        assert.equal(listIncidentComputationCount() - before, 1, "only the run whose journal changed is recomputed");
        const row = changed.split("\n").find((line) => line.includes(ids[2]));
        assert.match(row ?? "", /1 incident/, changed);

        appendFileSync(logPathFor(ids[4]), `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } })}\n`);
        const beforeLog = listIncidentComputationCount();
        await listTool.execute("tc", { limit: 100 });
        assert.ok(listIncidentComputationCount() - beforeLog >= 1, "a changed log is rescanned");
    });
});
