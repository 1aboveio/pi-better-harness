/**
 * Issue #617: a model that miscopies one character of a `subagent_result`
 * cursor must not be trapped on page 1.
 *
 * A cursor payload carries an integrity tag over its other fields. A near-miss
 * is reported as `reset=cursor-corrupt` — never as `source-replaced`, which
 * claims the source changed — and, when the decoded offset still lands inside
 * the answer, the pager resumes there. Before this, the digest field mismatch
 * restarted at byte 0 and minted the identical cursor again, so a caller that
 * reproduced the same mis-transcription each turn could never read the tail.
 *
 * // @covers subagent.result-pagination
 * // @level unit
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { writeMeta, runDir, logPathFor } from "../registry.ts";
import { subagentResultTool } from "../tools.ts";

const THIS_PID = process.pid;
const diskIds = [];

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

const ORIGIN = { cwd: "/tmp", sessionId: "result-cursor-session" };

/** A finished run whose final answer is far larger than one answer page. */
function writeLongAnswerRun(id) {
    diskIds.push(id);
    writeMeta({
        id,
        name: "reviewer",
        status: "completed",
        pid: 0,
        spawnPid: THIS_PID,
        cwd: "/tmp",
        promptPreview: "long answer",
        startedAt: 1,
        endedAt: 2,
        exitCode: 0,
        logPath: logPathFor(id),
        sessionId: id,
        callbackOrigin: ORIGIN,
    });
    mkdirSync(runDir(id), { recursive: true });
    const lines = Array.from({ length: 220 }, (_, i) => `answer-line-${String(i).padStart(3, "0")} ${"z".repeat(70)}`);
    writeFileSync(logPathFor(id), [
        JSON.stringify({
            type: "message_end",
            message: {
                role: "assistant",
                content: [{ type: "text", text: lines.join("\n") }],
                usage: { input: 10, output: 20, total: 30, cost: { total: 0.01 } },
            },
        }),
        JSON.stringify({ type: "agent_end" }),
    ].join("\n") + "\n");
    return { first: lines[0], last: lines[lines.length - 1] };
}

function textOf(result) {
    return result.content.map((c) => c.text ?? "").join("\n");
}

const CURSOR_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * The same cursor as a model re-types it: exactly one base64url character
 * changed, with the payload still parsing as the same cursor kind. `accept`
 * picks the reported near-miss (only the digest field moved).
 */
function miscopiedCursor(cursor, kind, accept) {
    const body = cursor.slice(3);
    const original = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    for (let index = 0; index < body.length; index += 1) {
        for (const replacement of CURSOR_ALPHABET) {
            if (replacement === body[index]) continue;
            const candidate = `p1.${body.slice(0, index)}${replacement}${body.slice(index + 1)}`;
            let payload;
            try {
                payload = JSON.parse(Buffer.from(candidate.slice(3), "base64url").toString("utf8"));
            } catch {
                continue;
            }
            if (payload?.k === kind && accept(payload, original)) return candidate;
        }
    }
    throw new Error("no single-character miscopy of this cursor satisfied the expectation");
}

function cursorFrom(text, name) {
    const cursor = text.match(new RegExp(`${name}=(\\S+)`))?.[1];
    assert.ok(cursor, `payload must carry ${name}`);
    return cursor;
}

describe("subagent_result cursor corruption (#617)", () => {
    // @covers subagent.result-pagination
    // @level unit
    it("continues after a miscopied answer cursor instead of replaying page 1", async () => {
        const id = `sa_result_cursor_${Date.now()}`;
        const { first, last } = writeLongAnswerRun(id);
        const tool = subagentResultTool(TypeStub);

        const page1 = textOf(await tool.execute("tc", { id, max_bytes: 2048 }));
        assert.match(page1, /hasMore=true/);
        assert.ok(page1.includes(first));
        const next = cursorFrom(page1, "nextCursor");

        const miscopied = miscopiedCursor(next, "t", (payload, original) => payload.o === original.o && payload.v !== original.v);
        const page2 = textOf(await tool.execute("tc", { id, cursor: miscopied, max_bytes: 2048 }));

        assert.match(page2, /reset=cursor-corrupt/, "a hand-copied cursor must be reported as corrupt");
        assert.doesNotMatch(page2, /reset=source-replaced/, "a finished, static run must not be reported as replaced");
        assert.doesNotMatch(page2, /reset=stale-cursor/);
        assert.ok(!page2.includes(first), "the corrupt cursor must not replay page 1");
        assert.match(page2, /hasMore=true/);
        assert.notEqual(cursorFrom(page2, "nextCursor"), next, "it must not mint the page-1 cursor again");

        // Following the cursors this response mints reaches the end of the answer.
        let cursor = cursorFrom(page2, "nextCursor");
        let seen = new Set([next, cursor]);
        let lastPage = page2;
        for (let pages = 0; pages < 100; pages += 1) {
            const page = textOf(await tool.execute("tc", { id, cursor, max_bytes: 2048 }));
            assert.doesNotMatch(page, /reset=/, "cursors minted after the corrupt one are valid");
            lastPage = page;
            if (!/hasMore=true/.test(page)) break;
            cursor = cursorFrom(page, "nextCursor");
            assert.ok(!seen.has(cursor), "paging must advance, never repeat a cursor");
            seen.add(cursor);
        }
        assert.doesNotMatch(lastPage, /hasMore=true/);
        assert.ok(lastPage.includes(last), "the end of the answer is reachable");
    });
});
