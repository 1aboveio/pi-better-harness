// Captured provider events are INPUTS to the real parser, not assertions about
// fixture wording. Error/compaction fixtures also exercise health_observation.
import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("parses captured assistant text and measured usage through the real log reader", async () => {
    const root = mkdtempSync(join(tmpdir(), "signature-parser-"));
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = root;
    try {
        const { parseRun, resetParseRunCursor } = await import("../parse.ts");
        const { runDir, logPathFor } = await import("../registry.ts");
        for (const name of ["normal-model-response.ndjson", "usage-cost-events.ndjson", "tool-start-end.ndjson"]) {
            const body = readFileSync(new URL(`../docs/evidence/issue-64/fixtures/${name}`, import.meta.url), "utf8");
            const events = body.split("\n").filter((line) => line.trim().startsWith("{")).map((line) => JSON.parse(line));
            const messages = events.filter((event) => event.type === "message_end" && event.message?.role === "assistant").map((event) => event.message);
            assert.ok(messages.length > 0, "capture must include an assistant response");
            const last = messages.at(-1);
            const expectedText = typeof last.content === "string" ? last.content : last.content.filter((part) => part.type === "text").map((part) => part.text).join("").trim();
            assert.ok(expectedText.length > 0);
            const id = name.replaceAll(".", "_");
            mkdirSync(runDir(id), { recursive: true });
            writeFileSync(logPathFor(id), body);
            const parsed = parseRun(id);
            assert.equal(parsed.finalText, expectedText);
            assert.equal(parsed.sawEnd, true);
            assert.deepEqual(parsed.unmatchedToolCalls, []);
            assert.equal(parsed.usage.input, messages.reduce((sum, message) => sum + (message.usage?.input ?? 0), 0));
            assert.equal(parsed.usage.output, messages.reduce((sum, message) => sum + (message.usage?.output ?? 0), 0));
            assert.equal(parsed.usage.costUSD, messages.reduce((sum, message) => sum + (message.usage?.cost?.total ?? 0), 0));
            resetParseRunCursor(id);
        }
    } finally {
        if (previous === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previous;
        rmSync(root, { recursive: true, force: true });
    }
});
