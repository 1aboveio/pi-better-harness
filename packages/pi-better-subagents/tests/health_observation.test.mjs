/**
 * Unit tests for multi-dimensional subagent health observations (issue #66).
 *
 * Stale is residual: compaction, open tools, and recoverable model-error phases
 * must not collapse into stale when event evidence supports those dimensions.
 * Raw log mtime/size is diagnostic only and never marks a run healthy by itself.
 *
 * // @covers health.observation
 * // @level unit
 * // @covers health.event-facts
 * // @level unit
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, utimesSync, rmSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    DEFAULT_HEALTH_THRESHOLDS,
    extractChildEventFacts,
    extractChildEventFactsFromLog,
    observeRunHealth,
    resolveHealthThresholds,
} from "../health-observation.ts";
import { logPathFor, runDir } from "../registry.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = join(ROOT, "docs/evidence/issue-64/fixtures");
const NOW = 1_800_000_000_000;

const T = {
    ...DEFAULT_HEALTH_THRESHOLDS,
    quietMs: 30_000,
    staleMs: 120_000,
    longToolMs: 60_000,
    longCompactionMs: 60_000,
};

function uniqueId(prefix) {
    return `${prefix}_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function cleanup(id) {
    try { rmSync(runDir(id), { recursive: true, force: true }); } catch { /* */ }
}

function loadFixtureEvents(name) {
    const path = join(FIX, name);
    assert.ok(existsSync(path), `missing fixture ${name}`);
    const events = [];
    for (const line of readFileSync(path, "utf-8").split("\n")) {
        const s = line.trim();
        if (!s || s[0] !== "{") continue;
        events.push(JSON.parse(s));
    }
    return events;
}

/** Attach explicit observation times so tests do not depend on wall clock. */
function withAt(events, startAt, stepMs = 1000) {
    return events.map((e, i) => ({ ...e, at: startAt + i * stepMs }));
}

describe("extractChildEventFacts — meaningful activity", () => {
    it("updates lastMeaningfulAt from parsed meaningful child events (not raw noise)", () => {
        const events = [
            { type: "session", at: NOW - 10_000 },
            { type: "agent_start", at: NOW - 9_000 },
            // raw noise would not be JSON; non-meaningful lifecycle alone is weak
            { type: "turn_start", at: NOW - 8_000 },
            {
                type: "message_end",
                at: NOW - 5_000,
                message: {
                    role: "assistant",
                    stopReason: "stop",
                    content: [{ type: "text", text: "hello" }],
                },
            },
            { type: "agent_settled", at: NOW - 4_000 },
        ];
        const facts = extractChildEventFacts(events);
        assert.equal(facts.lastMeaningfulAt, NOW - 4_000);
        assert.equal(facts.sawAgentSettled, true);
    });

    it("tracks open tools from tool_execution_start without matching end", () => {
        const events = [
            {
                type: "tool_execution_start",
                at: NOW - 20_000,
                toolCallId: "call_1",
                toolName: "bash",
            },
            {
                type: "tool_execution_update",
                at: NOW - 15_000,
                toolCallId: "call_1",
                toolName: "bash",
            },
        ];
        const facts = extractChildEventFacts(events);
        assert.equal(facts.activeTools.length, 1);
        assert.equal(facts.activeTools[0].toolName, "bash");
        assert.equal(facts.activeTools[0].toolCallId, "call_1");
        assert.equal(facts.activeTools[0].startedAt, NOW - 20_000);
        assert.equal(facts.lastMeaningfulAt, NOW - 15_000);
    });

    it("detects compaction_start without end as compacting", () => {
        const events = [
            { type: "compaction_start", at: NOW - 90_000, reason: "threshold" },
        ];
        const facts = extractChildEventFacts(events);
        assert.equal(facts.compacting, true);
        assert.equal(facts.compactionStartedAt, NOW - 90_000);
        assert.equal(facts.lastMeaningfulAt, NOW - 90_000);
    });

    it("records recoverable model errors and auto_retry phases", () => {
        const events = [
            {
                type: "message_end",
                at: NOW - 50_000,
                message: {
                    role: "assistant",
                    stopReason: "error",
                    errorMessage: "503: unavailable",
                    content: [],
                },
            },
            {
                type: "auto_retry_start",
                at: NOW - 49_000,
                attempt: 1,
                maxAttempts: 3,
                delayMs: 2000,
                errorMessage: "503: unavailable",
            },
        ];
        const facts = extractChildEventFacts(events);
        assert.equal(facts.model.state, "retrying");
        assert.match(facts.model.lastError?.message ?? "", /503/);
        assert.ok(facts.model.errorHistory.length >= 1);
    });

    it("clears agent_end.willRetry after later successful assistant message_end", () => {
        // Realistic #64 envelope: agent_end.willRetry=true, auto_retry_start,
        // then a recovered assistant message_end. willRetry must not stay latched.
        const events = [
            {
                type: "message_end",
                at: NOW - 50_000,
                message: {
                    role: "assistant",
                    stopReason: "error",
                    errorMessage: "503: unavailable",
                    content: [],
                },
            },
            {
                type: "agent_end",
                at: NOW - 49_500,
                willRetry: true,
                messages: [],
            },
            {
                type: "auto_retry_start",
                at: NOW - 49_000,
                attempt: 1,
                maxAttempts: 3,
                delayMs: 2000,
                errorMessage: "503: unavailable",
            },
            {
                type: "message_end",
                at: NOW - 5_000,
                message: {
                    role: "assistant",
                    stopReason: "stop",
                    content: [{ type: "text", text: "recovered" }],
                },
            },
        ];
        const facts = extractChildEventFacts(events);
        assert.equal(facts.model.state, "ok", "successful assistant supersedes retry intent");
        assert.equal(facts.willRetry, false);
        assert.ok(facts.model.errorHistory.some((e) => /503/.test(e.message)));

        const obs = observeRunHealth({
            status: "running",
            now: NOW,
            facts,
            thresholds: T,
            process: { supervised: true },
        });
        assert.equal(obs.model.state, "ok");
        assert.equal(obs.model.listWarning, undefined);
        assert.ok(!obs.compactFacts.some((f) => /model retrying|model error/i.test(f)));
        assert.ok(obs.model.errorHistory.some((e) => /503/.test(e.message)));
    });

    it("clears agent_end.willRetry after later successful tool_execution_end", () => {
        const events = [
            {
                type: "message_end",
                at: NOW - 40_000,
                message: {
                    role: "assistant",
                    stopReason: "error",
                    errorMessage: "503: unavailable",
                    content: [],
                },
            },
            { type: "agent_end", at: NOW - 39_500, willRetry: true, messages: [] },
            {
                type: "auto_retry_start",
                at: NOW - 39_000,
                attempt: 1,
                maxAttempts: 3,
                errorMessage: "503: unavailable",
            },
            {
                type: "tool_execution_start",
                at: NOW - 10_000,
                toolCallId: "call_ok",
                toolName: "bash",
            },
            {
                type: "tool_execution_end",
                at: NOW - 5_000,
                toolCallId: "call_ok",
                toolName: "bash",
                isError: false,
            },
        ];
        const facts = extractChildEventFacts(events);
        assert.equal(facts.model.state, "ok", "successful tool end supersedes retry intent");
        assert.equal(facts.willRetry, false);
        assert.equal(facts.activeTools.length, 0);
        assert.ok(facts.model.errorHistory.some((e) => /503/.test(e.message)));

        const obs = observeRunHealth({
            status: "running",
            now: NOW,
            facts,
            thresholds: T,
            process: { supervised: true },
        });
        assert.equal(obs.model.state, "ok");
        assert.equal(obs.model.listWarning, undefined);
        assert.ok(!obs.compactFacts.some((f) => /model retrying|model error/i.test(f)));
    });
});

describe("observeRunHealth — activity residual stale", () => {
    it("quiet-to-stale: ages from healthy → quiet → stale on meaningful silence", () => {
        const facts = extractChildEventFacts([
            {
                type: "message_end",
                at: NOW - 10_000,
                message: {
                    role: "assistant",
                    stopReason: "stop",
                    content: [{ type: "text", text: "ok" }],
                },
            },
        ]);

        const healthy = observeRunHealth({
            status: "running",
            now: NOW,
            facts,
            thresholds: T,
            process: { supervised: true },
        });
        assert.equal(healthy.activity, "healthy");
        assert.ok(!healthy.compactFacts.includes("stale"));

        const quiet = observeRunHealth({
            status: "running",
            now: NOW + 40_000, // 50s since last meaningful
            facts,
            thresholds: T,
            process: { supervised: true },
        });
        assert.equal(quiet.activity, "quiet");

        const stale = observeRunHealth({
            status: "running",
            now: NOW + 200_000, // well past staleMs from last meaningful
            facts,
            thresholds: T,
            process: { supervised: true },
        });
        assert.equal(stale.activity, "stale");
        assert.ok(stale.compactFacts.some((f) => f.includes("stale")));
    });

    it("compaction-not-stale: open compaction is compacting, not stale", () => {
        const facts = extractChildEventFacts([
            {
                type: "message_end",
                at: NOW - 300_000,
                message: {
                    role: "assistant",
                    stopReason: "stop",
                    content: [{ type: "text", text: "before compact" }],
                },
            },
            { type: "compaction_start", at: NOW - 40_000, reason: "threshold" },
        ]);
        const obs = observeRunHealth({
            status: "running",
            now: NOW,
            facts,
            thresholds: T,
            process: { supervised: true },
        });
        assert.equal(obs.compaction.state, "compacting");
        assert.notEqual(obs.activity, "stale");
        assert.ok(obs.compactFacts.some((f) => /compact/i.test(f)));
        assert.ok(!obs.compactFacts.some((f) => f === "stale" || f.startsWith("stale")));
    });

    it("long-compaction: long compacting is distinct from stale", () => {
        const facts = extractChildEventFacts([
            { type: "compaction_start", at: NOW - 90_000, reason: "threshold" },
        ]);
        const obs = observeRunHealth({
            status: "running",
            now: NOW,
            facts,
            thresholds: T,
            process: { supervised: true },
        });
        assert.equal(obs.compaction.state, "long_compacting");
        assert.notEqual(obs.activity, "stale");
        assert.ok(obs.compactFacts.some((f) => /long.?compact/i.test(f)));
        assert.ok(!obs.compactFacts.some((f) => /\bstale\b/i.test(f)));
    });

    it("tool-running: active tool is represented separately from stale", () => {
        const facts = extractChildEventFacts([
            {
                type: "tool_execution_start",
                at: NOW - 20_000,
                toolCallId: "call_bash",
                toolName: "bash",
            },
        ]);
        const obs = observeRunHealth({
            status: "running",
            now: NOW,
            facts,
            thresholds: T,
            process: { supervised: true },
        });
        assert.equal(obs.tool.state, "running");
        assert.equal(obs.tool.active?.toolName, "bash");
        assert.notEqual(obs.activity, "stale");
        assert.ok(obs.compactFacts.some((f) => /bash/i.test(f)));
        assert.ok(!obs.compactFacts.some((f) => /\bstale\b/i.test(f)));
    });

    it("long-tool: long tool call is distinct from stale", () => {
        const facts = extractChildEventFacts([
            {
                type: "tool_execution_start",
                at: NOW - 90_000,
                toolCallId: "call_bash",
                toolName: "bash",
            },
        ]);
        const obs = observeRunHealth({
            status: "running",
            now: NOW,
            facts,
            thresholds: T,
            process: { supervised: true },
        });
        assert.equal(obs.tool.state, "long_running");
        assert.notEqual(obs.activity, "stale");
        assert.ok(obs.compactFacts.some((f) => /long|bash/i.test(f)));
        assert.ok(!obs.compactFacts.some((f) => /\bstale\b/i.test(f)));
    });

    it("model-error recovery: recoverable error is separate; clears compact warning after good activity; history retained", () => {
        const errorEvents = [
            {
                type: "message_end",
                at: NOW - 80_000,
                message: {
                    role: "assistant",
                    stopReason: "error",
                    errorMessage: "503: unavailable",
                    content: [],
                },
            },
            {
                type: "auto_retry_start",
                at: NOW - 79_000,
                attempt: 1,
                maxAttempts: 3,
                errorMessage: "503: unavailable",
            },
        ];
        const erroring = observeRunHealth({
            status: "running",
            now: NOW,
            facts: extractChildEventFacts(errorEvents),
            thresholds: T,
            process: { supervised: true },
        });
        assert.ok(erroring.model.state === "error" || erroring.model.state === "retrying");
        assert.ok(erroring.model.listWarning, "compact/list warning while unrecovered");
        assert.notEqual(erroring.activity, "stale");
        assert.ok(erroring.compactFacts.some((f) => /model|error|retry/i.test(f)));
        assert.ok(!erroring.compactFacts.some((f) => /\bstale\b/i.test(f)));

        const recoveredEvents = [
            ...errorEvents,
            {
                type: "auto_retry_end",
                at: NOW - 10_000,
                success: true,
                attempt: 1,
            },
            {
                type: "message_end",
                at: NOW - 5_000,
                message: {
                    role: "assistant",
                    stopReason: "stop",
                    content: [{ type: "text", text: "recovered answer" }],
                },
            },
        ];
        const recovered = observeRunHealth({
            status: "running",
            now: NOW,
            facts: extractChildEventFacts(recoveredEvents),
            thresholds: T,
            process: { supervised: true },
        });
        assert.equal(recovered.model.state, "ok");
        assert.equal(recovered.model.listWarning, undefined);
        assert.ok(!recovered.compactFacts.some((f) => /model error|retrying/i.test(f)));
        assert.ok(
            recovered.model.errorHistory.some((e) => /503/.test(e.message)),
            "detail history retains last model error after recovery",
        );
        assert.equal(recovered.activity, "healthy");
    });

    it("fatal model errors remain compatible with durable failed status", () => {
        const facts = extractChildEventFacts([
            {
                type: "message_end",
                at: NOW - 20_000,
                message: {
                    role: "assistant",
                    stopReason: "error",
                    errorMessage: "401 unauthorized",
                    content: [],
                },
            },
            { type: "agent_settled", at: NOW - 19_000 },
        ]);
        const obs = observeRunHealth({
            status: "failed",
            now: NOW,
            facts,
            thresholds: T,
            process: { supervised: false },
        });
        assert.equal(obs.status, "failed");
        assert.equal(obs.process.liveness, "terminal");
        assert.ok(obs.model.lastError || obs.model.errorHistory.length > 0);
        // Observation must not invent a non-failed durable status.
        assert.notEqual(obs.status, "running");
    });

    it("raw-log-noise: raw log write alone does not mark a run healthy", () => {
        const facts = extractChildEventFacts([
            {
                type: "message_end",
                at: NOW - 300_000,
                message: {
                    role: "assistant",
                    stopReason: "stop",
                    content: [{ type: "text", text: "old progress" }],
                },
            },
        ]);
        const obs = observeRunHealth({
            status: "running",
            now: NOW,
            facts,
            rawLog: { mtimeMs: NOW - 1_000, sizeBytes: 99999 },
            thresholds: T,
            process: { supervised: true },
        });
        assert.equal(obs.activity, "stale");
        assert.equal(obs.rawLog.mtimeMs, NOW - 1_000);
        assert.ok(obs.rawLog.sizeBytes === 99999);
        // Fresh raw write must not appear as the activity signal.
        assert.ok(!obs.compactFacts.some((f) => /raw.?log.*healthy/i.test(f)));
    });

    it("long_model_call is not exposed without explicit lifecycle evidence", () => {
        const facts = extractChildEventFacts([
            { type: "turn_start", at: NOW - 90_000 },
            {
                type: "message_end",
                at: NOW - 89_000,
                message: {
                    role: "user",
                    content: [{ type: "text", text: "go" }],
                },
            },
        ]);
        const obs = observeRunHealth({
            status: "running",
            now: NOW,
            facts,
            thresholds: T,
            process: { supervised: true },
        });
        assert.equal(facts.longModelCallSupported, false);
        assert.equal(obs.model.longModelCall, undefined);
        assert.ok(!obs.compactFacts.some((f) => /long_model_call|long model/i.test(f)));
    });

    it("supports configurable thresholds without changing defaults for other callers", () => {
        const facts = extractChildEventFacts([
            {
                type: "message_end",
                at: NOW - 45_000,
                message: {
                    role: "assistant",
                    stopReason: "stop",
                    content: [{ type: "text", text: "x" }],
                },
            },
        ]);
        const strict = observeRunHealth({
            status: "running",
            now: NOW,
            facts,
            thresholds: { quietMs: 10_000, staleMs: 40_000 },
            process: { supervised: true },
        });
        assert.equal(strict.activity, "stale");

        const relaxed = observeRunHealth({
            status: "running",
            now: NOW,
            facts,
            thresholds: { quietMs: 60_000, staleMs: 600_000 },
            process: { supervised: true },
        });
        assert.equal(relaxed.activity, "healthy");

        assert.equal(DEFAULT_HEALTH_THRESHOLDS.quietMs > 0, true);
        const resolved = resolveHealthThresholds({ healthQuietMs: 12_345 });
        assert.equal(resolved.quietMs, 12_345);
        assert.equal(resolved.staleMs, DEFAULT_HEALTH_THRESHOLDS.staleMs);
    });

    it("observes orphaned runs with process liveness distinct from activity", () => {
        const facts = extractChildEventFacts([
            {
                type: "tool_execution_start",
                at: NOW - 15_000,
                toolCallId: "c1",
                toolName: "bash",
            },
        ]);
        const obs = observeRunHealth({
            status: "orphaned",
            now: NOW,
            facts,
            thresholds: T,
            process: { supervised: false },
        });
        assert.equal(obs.status, "orphaned");
        assert.equal(obs.process.liveness, "orphaned");
        assert.equal(obs.tool.state, "running");
        assert.notEqual(obs.activity, "stale");
    });
});

describe("extractChildEventFactsFromLog — fixtures + raw diagnostic", () => {
    const ids = [];
    after(() => {
        for (const id of ids) cleanup(id);
    });

    it("parses #64 tool fixture and keeps raw log diagnostics separate", () => {
        const id = uniqueId("sa_hobs_tool");
        ids.push(id);
        mkdirSync(runDir(id), { recursive: true });
        const body = readFileSync(join(FIX, "tool-start-end.ndjson"), "utf-8");
        // Prepend raw noise that must not count as meaningful activity.
        writeFileSync(
            logPathFor(id),
            "Warning: No project session found with id 'x'; creating a new session.\n" + body,
            "utf-8",
        );
        const mtimeSec = Math.floor(NOW / 1000);
        utimesSync(logPathFor(id), mtimeSec, mtimeSec);

        const { facts, rawLog } = extractChildEventFactsFromLog(id, { now: NOW });
        assert.ok(facts.lastMeaningfulAt !== undefined, "meaningful activity from parsed events");
        assert.ok(Array.isArray(facts.activeTools));
        assert.equal(rawLog.mtimeMs, mtimeSec * 1000);
        assert.ok((rawLog.sizeBytes ?? 0) > 0);

        // Truncate to only noise + session header: no meaningful progress → stale residual.
        writeFileSync(
            logPathFor(id),
            "Warning: banner only\n" + JSON.stringify({ type: "session", id: "x" }) + "\n",
            "utf-8",
        );
        utimesSync(logPathFor(id), mtimeSec, mtimeSec);
        const noisy = extractChildEventFactsFromLog(id, { now: NOW });
        const obs = observeRunHealth({
            status: "running",
            now: NOW,
            facts: noisy.facts,
            rawLog: noisy.rawLog,
            thresholds: T,
            process: { supervised: true },
            startedAt: NOW - 300_000,
        });
        assert.equal(obs.activity, "stale");
        assert.ok(obs.rawLog.mtimeMs !== undefined);
    });

    it("parses #64 compaction fixture envelopes", () => {
        const events = withAt(loadFixtureEvents("compaction-rpc-manual.ndjson"), NOW - 10_000);
        const facts = extractChildEventFacts(events);
        // Fixture ends with compaction_end, so not currently compacting.
        assert.equal(facts.compacting, false);
        assert.ok(facts.lastCompaction);
        assert.match(facts.lastCompaction.errorMessage ?? "", /Nothing to compact/i);
    });

    it("parses #64 model-error fixture retry envelope", () => {
        const events = withAt(loadFixtureEvents("model-error-bad-model.ndjson"), NOW - 60_000, 500);
        const facts = extractChildEventFacts(events);
        assert.ok(facts.model.errorHistory.length >= 1);
        // Fixture ends with exhausted retries + settled — not actively retrying.
        assert.ok(facts.sawAgentSettled);
    });

    it("fresh raw noise after old untimestamped meaningful events does not refresh activity", () => {
        // Reviewer reproduction: untimestamped tool start/end must not mint
        // lastMeaningfulAt from raw mtime/now. Appending only non-JSON noise and
        // bumping mtime must leave residual stale activity.
        const id = uniqueId("sa_hobs_raw_mtime");
        ids.push(id);
        mkdirSync(runDir(id), { recursive: true });

        const oldMeaningful = [
            JSON.stringify({
                type: "tool_execution_start",
                toolCallId: "call_old",
                toolName: "bash",
                // deliberately no at/timestamp — structural fact only
            }),
            JSON.stringify({
                type: "tool_execution_end",
                toolCallId: "call_old",
                toolName: "bash",
                isError: false,
            }),
        ].join("\n") + "\n";

        writeFileSync(logPathFor(id), oldMeaningful, "utf-8");
        const oldSec = Math.floor((NOW - 300_000) / 1000);
        utimesSync(logPathFor(id), oldSec, oldSec);

        const first = extractChildEventFactsFromLog(id, { now: NOW });
        assert.equal(
            first.facts.lastMeaningfulAt,
            undefined,
            "untimestamped events must not synthesise wall-clock lastMeaningfulAt from mtime/now",
        );
        assert.equal(first.facts.activeTools.length, 0, "tool closed structurally");

        const firstObs = observeRunHealth({
            status: "running",
            now: NOW,
            facts: first.facts,
            rawLog: first.rawLog,
            thresholds: T,
            process: { supervised: true },
            startedAt: NOW - 300_000,
        });
        assert.equal(firstObs.activity, "stale");
        const firstMeaningful = first.facts.lastMeaningfulAt;

        // Append only non-JSON diagnostic noise and freshen mtime.
        writeFileSync(
            logPathFor(id),
            oldMeaningful + "Warning: No project session found with id 'x'; creating a new session.\n",
            "utf-8",
        );
        const freshSec = Math.floor(NOW / 1000);
        utimesSync(logPathFor(id), freshSec, freshSec);

        const second = extractChildEventFactsFromLog(id, { now: NOW });
        assert.equal(
            second.facts.lastMeaningfulAt,
            firstMeaningful,
            "fresh raw noise must not move lastMeaningfulAt",
        );
        assert.equal(second.rawLog.mtimeMs, freshSec * 1000);

        const secondObs = observeRunHealth({
            status: "running",
            now: NOW,
            facts: second.facts,
            rawLog: second.rawLog,
            thresholds: T,
            process: { supervised: true },
            startedAt: NOW - 300_000,
        });
        assert.equal(secondObs.activity, "stale", "raw mtime refresh must not promote activity to healthy");
        assert.ok(secondObs.compactFacts.some((f) => /\bstale\b/i.test(f)));
        assert.notEqual(secondObs.activity, "healthy");
    });
});
