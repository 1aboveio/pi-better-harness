/**
 * Issue #64 — child event signature fixtures must stay representative.
 *
 * Documentation / evidence only: asserts committed NDJSON fixtures contain the
 * event shapes later health classification will rely on. No production surfaces.
 *
 * // @covers docs.evidence.issue-64.child-event-signatures
 * // @level unit
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = join(ROOT, "docs/evidence/issue-64/fixtures");
const NOTES = join(ROOT, "docs/evidence/issue-64/NOTES.md");
const NOISE = join(ROOT, "docs/evidence/issue-64/redacted/raw-noise-samples.txt");

function loadEvents(name) {
    const path = join(FIX, name);
    assert.ok(existsSync(path), `missing fixture ${name}`);
    const events = [];
    for (const line of readFileSync(path, "utf-8").split("\n")) {
        const s = line.trim();
        if (!s || s[0] !== "{") continue;
        events.push(JSON.parse(s));
    }
    assert.ok(events.length > 0, `${name} must contain JSON events`);
    return events;
}

function typesOf(events) {
    return new Set(events.map((e) => e.type).filter(Boolean));
}

function hasAssistantUsage(events) {
    return events.some((e) => {
        if (e.type !== "message_end") return false;
        const m = e.message;
        return m?.role === "assistant" && m.usage && typeof m.usage === "object"
            && ("input" in m.usage || "output" in m.usage || "cost" in m.usage);
    });
}

function assistantTextContent(message) {
    const content = message?.content;
    if (!Array.isArray(content)) return [];
    return content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text);
}

function hasSuccessfulAssistantResponse(events) {
    return events.some((e) => {
        if (e.type !== "message_end") return false;
        const m = e.message;
        if (m?.role !== "assistant") return false;
        if (m.stopReason === "error" || m.errorMessage) return false;
        if (typeof m.stopReason !== "string" || m.stopReason.length === 0) return false;
        return assistantTextContent(m).some((text) => text.trim().length > 0);
    });
}

describe("issue #64 child event signature fixtures", () => {
    it("keeps discovery notes and noise samples committed", () => {
        assert.ok(existsSync(NOTES), "NOTES.md required");
        const notes = readFileSync(NOTES, "utf-8");
        assert.match(notes, /meaningful activity/i);
        assert.match(notes, /compaction/i);
        assert.match(notes, /long_model_call|model-call lifecycle/i);
        assert.ok(existsSync(NOISE), "raw noise samples required");
        const noise = readFileSync(NOISE, "utf-8").trim();
        assert.ok(noise.length > 0, "noise samples must not be empty");
        assert.ok(!noise.trimStart().startsWith("{"), "noise file is non-JSON text");
    });

    it("captures a normal model response lifecycle", () => {
        const events = loadEvents("normal-model-response.ndjson");
        const types = typesOf(events);
        for (const t of ["session", "agent_start", "turn_start", "message_end", "agent_end", "agent_settled"]) {
            assert.ok(types.has(t), `normal fixture missing ${t}`);
        }
        // AC1: require a real assistant completion, not merely any message_end (user echo).
        assert.ok(
            hasSuccessfulAssistantResponse(events),
            "normal fixture needs assistant message_end with non-error stopReason and text content",
        );
        const assistantEnd = events.find((e) => {
            if (e.type !== "message_end" || e.message?.role !== "assistant") return false;
            if (e.message?.stopReason === "error" || e.message?.errorMessage) return false;
            return assistantTextContent(e.message).some((t) => t.trim().length > 0);
        });
        assert.ok(assistantEnd);
        assert.notEqual(assistantEnd.message.stopReason, "error");
        assert.ok(
            assistantTextContent(assistantEnd.message).some((t) => t.trim().length > 0),
            "assistant response content must be non-empty text",
        );
    });

    it("captures tool_execution_start and tool_execution_end", () => {
        const events = loadEvents("tool-start-end.ndjson");
        const starts = events.filter((e) => e.type === "tool_execution_start");
        const ends = events.filter((e) => e.type === "tool_execution_end");
        assert.ok(starts.length >= 1, "need tool start");
        assert.ok(ends.length >= 1, "need tool end");
        assert.equal(typeof starts[0].toolName, "string");
        assert.equal(typeof starts[0].toolCallId, "string");
        assert.equal(typeof ends[0].toolName, "string");
        assert.equal(typeof ends[0].isError, "boolean");
        // Matching id when both present
        assert.ok(
            ends.some((e) => starts.some((s) => s.toolCallId === e.toolCallId)),
            "start/end should share a toolCallId",
        );
    });

    it("captures usage/cost on assistant message_end", () => {
        const events = loadEvents("usage-cost-events.ndjson");
        assert.ok(hasAssistantUsage(events), "assistant usage block required");
        const usageEvent = events.find((e) => e.type === "message_end" && e.message?.role === "assistant" && e.message?.usage);
        assert.ok(usageEvent, "assistant message_end with usage required");
        const usage = usageEvent.message.usage;
        // AC3: cost object is required evidence, not optional.
        assert.equal(typeof usage.cost, "object");
        assert.ok(usage.cost && !Array.isArray(usage.cost), "usage.cost object required");
        assert.equal(typeof usage.cost.total, "number", "usage.cost.total must be numeric");
        assert.ok(Number.isFinite(usage.cost.total), "usage.cost.total must be finite");
        // Prefer the common input/output cost fields when present.
        if ("input" in usage.cost) {
            assert.equal(typeof usage.cost.input, "number");
        }
        if ("output" in usage.cost) {
            assert.equal(typeof usage.cost.output, "number");
        }
    });

    it("captures terminal agent events", () => {
        for (const name of ["normal-model-response.ndjson", "tool-start-end.ndjson"]) {
            const types = typesOf(loadEvents(name));
            assert.ok(types.has("agent_end"), `${name} needs agent_end`);
            assert.ok(types.has("agent_settled"), `${name} needs agent_settled`);
        }
    });

    it("captures model/API error signatures when present", () => {
        const bad = loadEvents("model-error-bad-model.ndjson");
        const errMsgs = bad.filter((e) => e.message?.stopReason === "error" || e.message?.errorMessage);
        assert.ok(errMsgs.length >= 1, "error-bearing assistant messages required");
        const types = typesOf(bad);
        assert.ok(types.has("auto_retry_start"), "retryable path should expose auto_retry_start");
        assert.ok(types.has("auto_retry_end"), "retryable path should expose auto_retry_end");
        assert.ok(types.has("agent_settled"), "exhausted retries still settle");

        const net = loadEvents("model-error-network.ndjson");
        assert.ok(
            net.some((e) => e.message?.stopReason === "error" && e.message?.errorMessage),
            "API failure fixture needs stopReason=error + errorMessage",
        );
    });

    it("captures explicit compaction_start/end envelopes", () => {
        const events = loadEvents("compaction-rpc-manual.ndjson");
        const start = events.find((e) => e.type === "compaction_start");
        const end = events.find((e) => e.type === "compaction_end");
        assert.ok(start, "compaction_start required");
        assert.ok(end, "compaction_end required");
        assert.ok(["manual", "threshold", "overflow"].includes(start.reason), `unexpected reason ${start.reason}`);
        assert.equal(typeof end.aborted, "boolean");
        assert.equal(typeof end.willRetry, "boolean");
        // This capture failed early (session too small) but still proves the envelope.
        assert.ok(end.errorMessage === undefined || typeof end.errorMessage === "string");
    });

    it("documents meaningful-activity and detectability verdicts in NOTES", () => {
        const notes = readFileSync(NOTES, "utf-8");
        assert.match(notes, /Safe activity signals/i);
        assert.match(notes, /tool_execution_start/);
        assert.match(notes, /Raw log byte growth|raw log/i);
        assert.match(notes, /explicitly detectable/i);
        assert.match(notes, /inference-only|Unsupported|unsupported/i);
    });
});
