/**
 * Regression tests for child exits that occur before a coherent terminal event.
 *
 * // @covers subagent.run-finalization
 * // @level unit
 * // @fails-without-fix subagent.run-finalization
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    appendFileSync,
    closeSync,
    mkdirSync,
    openSync,
    rmSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { classifyChildExit } from "../lifecycle.ts";
import { buildSubagentResultText, finalizeRun } from "../finalization.ts";
import {
    LIFECYCLE_RECORD_PREFIX_BYTES,
    LIFECYCLE_SCAN_CHUNK_BYTES,
} from "../parse.ts";
import { logPathFor, readMeta, runDir, writeMeta } from "../registry.ts";

function writeLargeNewlineFreeRecord(id, { type, toolCallId, toolName, payloadBytes, appendNewline = true }) {
    mkdirSync(runDir(id), { recursive: true });
    const path = logPathFor(id);
    const fd = openSync(path, "w");
    try {
        const headParts = [`"type":"${type}"`];
        if (toolCallId) headParts.push(`"toolCallId":"${toolCallId}"`);
        if (toolName) headParts.push(`"toolName":"${toolName}"`);
        writeSync(fd, `{${headParts.join(",")},"payload":"`);
        const chunk = Buffer.alloc(64 * 1024, 0x78);
        let remaining = payloadBytes;
        while (remaining > 0) {
            const n = Math.min(chunk.length, remaining);
            writeSync(fd, chunk, 0, n);
            remaining -= n;
        }
        writeSync(fd, appendNewline ? `"}\n` : `"}`);
    } finally {
        closeSync(fd);
    }
}

const coherentRun = {
    finalText: "Final answer",
    lastActivity: "Final answer",
    toolCalls: ["read"],
    unmatchedToolCalls: [],
    sawEnd: true,
    usage: { input: 0, output: 0, cacheRead: 0, costUSD: 0, total: 0 },
};

function writeRunLog(id, events) {
    mkdirSync(runDir(id), { recursive: true });
    writeFileSync(
        logPathFor(id),
        `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
}

function seedRunningMeta(id, extras = {}) {
    writeMeta({
        id,
        name: "finalization-integration",
        status: "running",
        pid: process.pid,
        spawnPid: process.pid,
        cwd: process.cwd(),
        promptPreview: "integration finalization",
        startedAt: Date.now() - 1_000,
        logPath: logPathFor(id),
        sessionId: "sess_finalization_test",
        callback: true,
        ...extras,
    });
}

describe("classifyChildExit", () => {
    // @covers subagent.run-finalization
    // @level unit
    // @fails-without-fix subagent.run-finalization
    it("does not complete an exit-0 child with no terminal event", () => {
        const outcome = classifyChildExit(0, { ...coherentRun, sawEnd: false });

        assert.equal(outcome.status, "failed");
        assert.equal(outcome.incomplete, true);
        assert.equal(outcome.classification, "incomplete_no_terminal_event");
        assert.equal(outcome.diagnostics.sawTerminalEvent, false);
        assert.doesNotMatch(outcome.verdict, /completed/i);
    });

    // @covers subagent.run-finalization
    // @level unit
    // @fails-without-fix subagent.run-finalization
    it("does not complete an exit-0 child with an unmatched tool execution", () => {
        const outcome = classifyChildExit(0, {
            ...coherentRun,
            unmatchedToolCalls: [{ id: "call_bash", toolName: "bash" }],
        });

        assert.equal(outcome.status, "failed");
        assert.equal(outcome.incomplete, true);
        assert.equal(outcome.classification, "incomplete_open_tools");
        assert.equal(outcome.diagnostics.unmatchedToolCount, 1);
        assert.match(outcome.verdict, /incomplete/i);
    });

    // @covers subagent.run-finalization
    // @level unit
    // @fails-without-fix subagent.run-finalization
    it("prefers no-terminal-event when both terminal evidence and tools are missing", () => {
        const outcome = classifyChildExit(0, {
            ...coherentRun,
            sawEnd: false,
            unmatchedToolCalls: [{ id: "call_bash", toolName: "bash" }],
        });

        assert.equal(outcome.classification, "incomplete_no_terminal_event");
        assert.equal(outcome.diagnostics.unmatchedToolCount, 1);
        assert.equal(outcome.diagnostics.sawTerminalEvent, false);
    });

    // @covers subagent.run-finalization
    // @level unit
    it("completes an exit-0 child with coherent terminal evidence", () => {
        const outcome = classifyChildExit(0, coherentRun);

        assert.equal(outcome.status, "completed");
        assert.equal(outcome.incomplete, false);
        assert.equal(outcome.classification, "complete");
        assert.equal(outcome.diagnostics.sawTerminalEvent, true);
        assert.equal(outcome.diagnostics.unmatchedToolCount, 0);
        assert.match(outcome.verdict, /completed/i);
    });

    // @covers subagent.run-finalization
    // @level unit
    // @characterizes subagent.run-finalization
    it("preserves failed classification for a nonzero child exit", () => {
        const outcome = classifyChildExit(1, coherentRun);

        assert.equal(outcome.status, "failed");
        assert.equal(outcome.incomplete, false);
        assert.equal(outcome.classification, "failed_exit");
        assert.match(outcome.verdict, /failed/i);
    });

    // @covers subagent.run-finalization
    // @level unit
    // @fails-without-fix subagent.run-finalization
    it("classifies nonzero exit separately from incomplete exit-zero cases", () => {
        const nonzero = classifyChildExit(2, {
            ...coherentRun,
            sawEnd: false,
            unmatchedToolCalls: [{ toolName: "bash" }],
        });
        const incomplete = classifyChildExit(0, {
            ...coherentRun,
            sawEnd: false,
        });

        assert.equal(nonzero.classification, "failed_exit");
        assert.equal(incomplete.classification, "incomplete_no_terminal_event");
        assert.notEqual(nonzero.classification, incomplete.classification);
    });
});

describe("finalizeRun integration", () => {
    // @covers subagent.run-finalization
    // @level integration
    // @fails-without-fix subagent.run-finalization
    it("persists incomplete metadata, callback ATTENTION, and diagnostic result for exit-0 mid-turn logs", () => {
        const id = `sa_finalize_integ_${process.pid}_${Date.now()}`;
        const messages = [];
        const notifications = [];

        writeRunLog(id, [
            { type: "message_end", message: { role: "assistant", content: "progress before exit" } },
            { type: "tool_execution_start", toolCallId: "call_bash", toolName: "bash" },
        ]);
        seedRunningMeta(id);

        try {
            const result = finalizeRun(id, 0, {
                renderWidget: () => {},
                notify: (message, level) => notifications.push({ message, level }),
                sendMessage: (message, options) => messages.push({ message, options }),
            });

            assert.equal(result.applied, true);
            assert.equal(result.outcome?.status, "failed");
            assert.equal(result.outcome?.incomplete, true);
            assert.equal(result.outcome?.classification, "incomplete_no_terminal_event");

            const persisted = readMeta(id);
            assert.ok(persisted);
            assert.equal(persisted.status, "failed");
            assert.equal(persisted.exitCode, 0);
            assert.equal(persisted.failureReason, "incomplete-stream");
            assert.equal(persisted.lifecycleClassification, "incomplete_no_terminal_event");

            assert.equal(messages.length, 1);
            assert.match(messages[0].message.content, /ATTENTION/i);
            assert.match(messages[0].message.content, /lifecycle incomplete_no_terminal_event/);
            assert.match(messages[0].message.content, new RegExp(`subagent_result id="${id}"`));
            assert.doesNotMatch(messages[0].message.content, /progress before exit/);
            assert.equal(messages[0].options.triggerTurn, true);
            assert.equal(notifications[0]?.level, "warning");

            const rendered = buildSubagentResultText(id);
            assert.ok(rendered);
            assert.match(rendered, /lifecycle incomplete_no_terminal_event/);
            assert.match(rendered, /terminal event: no/i);
            assert.match(rendered, /unmatched tools: bash \(call_bash\)/);
            assert.match(rendered, /ended unexpectedly/i);
            assert.match(rendered, /--- best available parsed output ---/);
            assert.match(rendered, /progress before exit/);
            assert.doesNotMatch(rendered, /lifecycle complete/);
            assert.doesNotMatch(rendered, new RegExp(`\\]\\nprogress before exit$`));
        } finally {
            rmSync(runDir(id), { recursive: true, force: true });
        }
    });

    // @covers subagent.run-finalization
    // @level integration
    // @fails-without-fix subagent.run-finalization
    it("persists complete status for coherent exit-0 logs and keeps clean result formatting", () => {
        const id = `sa_finalize_ok_${process.pid}_${Date.now()}`;
        const messages = [];

        writeRunLog(id, [
            { type: "message_end", message: { role: "assistant", content: "Final answer" } },
            { type: "tool_execution_start", toolCallId: "call_read", toolName: "read" },
            { type: "tool_execution_end", toolCallId: "call_read", toolName: "read" },
            { type: "agent_end", messages: [{ role: "assistant", content: "Final answer" }] },
        ]);
        seedRunningMeta(id);

        try {
            const result = finalizeRun(id, 0, {
                renderWidget: () => {},
                notify: () => {},
                sendMessage: (message, options) => messages.push({ message, options }),
            });

            assert.equal(result.applied, true);
            assert.equal(result.outcome?.status, "completed");
            assert.equal(result.outcome?.classification, "complete");

            const persisted = readMeta(id);
            assert.equal(persisted?.status, "completed");
            assert.equal(persisted?.lifecycleClassification, "complete");
            assert.equal(persisted?.failureReason, undefined);

            assert.match(messages[0].message.content, /completed/i);
            assert.doesNotMatch(messages[0].message.content, /ATTENTION/i);

            const rendered = buildSubagentResultText(id);
            assert.ok(rendered);
            assert.match(rendered, /lifecycle complete/);
            assert.match(rendered, /Final answer/);
            assert.doesNotMatch(rendered, /ended unexpectedly/i);
        } finally {
            rmSync(runDir(id), { recursive: true, force: true });
        }
    });

    // @covers subagent.run-finalization
    // @level integration
    // @fails-without-fix subagent.run-finalization
    it("does not complete when unmatched tool start is outside a reduced parse window", () => {
        const id = `sa_finalize_trunc_${process.pid}_${Date.now()}`;
        const messages = [];
        const notifications = [];
        const original = process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES;

        // Unmatched tool_execution_start lives before a large pad so a 1 KiB bounded
        // parse tail only sees agent_end. Lifecycle authority must still scan the
        // complete stream and refuse clean completion.
        const start = JSON.stringify({
            type: "tool_execution_start",
            toolCallId: "call_bash",
            toolName: "bash",
        });
        const pad = `${"x".repeat(5000)}\n`;
        const end = JSON.stringify({
            type: "agent_end",
            messages: [{ role: "assistant", content: "Final answer" }],
        });
        mkdirSync(runDir(id), { recursive: true });
        writeFileSync(logPathFor(id), `${start}\n${pad}${end}\n`);
        seedRunningMeta(id);
        process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES = "1024";

        try {
            const result = finalizeRun(id, 0, {
                renderWidget: () => {},
                notify: (message, level) => notifications.push({ message, level }),
                sendMessage: (message, options) => messages.push({ message, options }),
            });

            assert.equal(result.applied, true);
            assert.equal(result.outcome?.status, "failed");
            assert.equal(result.outcome?.incomplete, true);
            assert.equal(result.outcome?.classification, "incomplete_open_tools");
            assert.equal(result.outcome?.diagnostics.sawTerminalEvent, true);
            assert.equal(result.outcome?.diagnostics.unmatchedToolCount, 1);
            assert.deepEqual(result.outcome?.diagnostics.unmatchedTools, ["bash (call_bash)"]);

            const persisted = readMeta(id);
            assert.equal(persisted?.status, "failed");
            assert.equal(persisted?.exitCode, 0);
            assert.equal(persisted?.failureReason, "incomplete-stream");
            assert.equal(persisted?.lifecycleClassification, "incomplete_open_tools");

            assert.equal(messages.length, 1);
            assert.match(messages[0].message.content, /ATTENTION/i);
            assert.match(messages[0].message.content, /lifecycle incomplete_open_tools/);
            assert.doesNotMatch(messages[0].message.content, /Final answer/);
            assert.equal(notifications[0]?.level, "warning");

            const rendered = buildSubagentResultText(id);
            assert.ok(rendered);
            assert.match(rendered, /lifecycle incomplete_open_tools/);
            assert.match(rendered, /terminal event: yes/i);
            assert.match(rendered, /unmatched tools: bash \(call_bash\)/);
            assert.match(rendered, /ended unexpectedly/i);
            assert.doesNotMatch(rendered, /lifecycle complete/);
        } finally {
            if (original !== undefined) process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES = original;
            else delete process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES;
            rmSync(runDir(id), { recursive: true, force: true });
        }
    });

    // @covers subagent.run-finalization
    // @level integration
    // @fails-without-fix subagent.run-finalization
    it("reclassifies legacy completed metadata when unmatched tools are outside the parse window", () => {
        const id = `sa_legacy_trunc_${process.pid}_${Date.now()}`;
        const original = process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES;

        const start = JSON.stringify({
            type: "tool_execution_start",
            toolCallId: "call_bash",
            toolName: "bash",
        });
        const pad = `${"x".repeat(5000)}\n`;
        const end = JSON.stringify({
            type: "agent_end",
            messages: [{ role: "assistant", content: "Final answer" }],
        });
        mkdirSync(runDir(id), { recursive: true });
        writeFileSync(logPathFor(id), `${start}\n${pad}${end}\n`);
        // Pre-#86 false-completed shape, including a stored complete classification.
        writeMeta({
            id,
            name: "legacy-trunc",
            status: "completed",
            pid: process.pid,
            spawnPid: process.pid,
            cwd: process.cwd(),
            promptPreview: "legacy truncated",
            startedAt: Date.now() - 2_000,
            endedAt: Date.now() - 1_000,
            exitCode: 0,
            lifecycleClassification: "complete",
            logPath: logPathFor(id),
            sessionId: "sess_legacy_trunc",
            callback: true,
        });
        process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES = "1024";

        try {
            const rendered = buildSubagentResultText(id);
            assert.ok(rendered);
            assert.match(rendered, /lifecycle incomplete_open_tools/);
            assert.match(rendered, /terminal event: yes/i);
            assert.match(rendered, /unmatched tools: bash \(call_bash\)/);
            assert.match(rendered, /ended unexpectedly/i);
            assert.doesNotMatch(rendered, /lifecycle complete/);
        } finally {
            if (original !== undefined) process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES = original;
            else delete process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES;
            rmSync(runDir(id), { recursive: true, force: true });
        }
    });

    // @covers subagent.run-finalization
    // @level integration
    // @fails-without-fix subagent.run-finalization
    it("handles a single newline-free event larger than the scan chunk without throwing and keeps coherent completion", () => {
        const id = `sa_finalize_large_nlfree_${process.pid}_${Date.now()}`;
        const messages = [];
        const payloadBytes = LIFECYCLE_SCAN_CHUNK_BYTES * 4; // 256 KiB fixture, larger than chunk + prefix
        assert.ok(payloadBytes > LIFECYCLE_RECORD_PREFIX_BYTES);

        // Large agent_end with type in the retained prefix — lifecycle fields extractable,
        // payload discarded. Coherent exit-0 with terminal evidence stays complete.
        // Memory residual is asserted on scanLifecycleEvidence in parse_run tests; here we
        // prove the real finalize/result path does not throw and still classifies correctly.
        writeLargeNewlineFreeRecord(id, {
            type: "agent_end",
            payloadBytes,
        });
        seedRunningMeta(id);

        try {
            let result;
            assert.doesNotThrow(() => {
                result = finalizeRun(id, 0, {
                    renderWidget: () => {},
                    notify: () => {},
                    sendMessage: (message, options) => messages.push({ message, options }),
                });
            });

            assert.equal(result.applied, true);
            assert.equal(result.outcome?.status, "completed");
            assert.equal(result.outcome?.classification, "complete");
            assert.equal(result.outcome?.incomplete, false);

            const persisted = readMeta(id);
            assert.equal(persisted?.status, "completed");
            assert.equal(persisted?.lifecycleClassification, "complete");

            assert.match(messages[0].message.content, /completed/i);
            assert.doesNotMatch(messages[0].message.content, /ATTENTION/i);

            let rendered;
            assert.doesNotThrow(() => {
                rendered = buildSubagentResultText(id);
            });
            assert.ok(rendered);
            assert.match(rendered, /lifecycle complete/);
            assert.doesNotMatch(rendered, /ended unexpectedly/i);
        } finally {
            rmSync(runDir(id), { recursive: true, force: true });
        }
    });

    // @covers subagent.run-finalization
    // @level integration
    // @fails-without-fix subagent.run-finalization
    it("fails closed on truncated early-type EOF so exit-0 cannot become clean completion", () => {
        const id = `sa_finalize_trunc_early_type_${process.pid}_${Date.now()}`;
        const messages = [];
        mkdirSync(runDir(id), { recursive: true });
        const fd = openSync(logPathFor(id), "w");
        try {
            // Oversized record begins with type:agent_end but never closes before EOF.
            writeSync(fd, `{"type":"agent_end","payload":"`);
            writeSync(fd, Buffer.alloc(LIFECYCLE_RECORD_PREFIX_BYTES + 2048, 0x78));
        } finally {
            closeSync(fd);
        }
        seedRunningMeta(id);

        try {
            const result = finalizeRun(id, 0, {
                renderWidget: () => {},
                notify: () => {},
                sendMessage: (message, options) => messages.push({ message, options }),
            });

            assert.equal(result.applied, true);
            assert.equal(result.outcome?.status, "failed");
            assert.equal(result.outcome?.incomplete, true);
            assert.equal(result.outcome?.classification, "incomplete_no_terminal_event");
            assert.equal(result.outcome?.diagnostics.sawTerminalEvent, false);

            const persisted = readMeta(id);
            assert.equal(persisted?.status, "failed");
            assert.equal(persisted?.failureReason, "incomplete-stream");
            assert.equal(persisted?.lifecycleClassification, "incomplete_no_terminal_event");

            assert.match(messages[0].message.content, /ATTENTION/i);
            assert.match(messages[0].message.content, /lifecycle incomplete_no_terminal_event/);

            const rendered = buildSubagentResultText(id);
            assert.ok(rendered);
            assert.match(rendered, /lifecycle incomplete_no_terminal_event/);
            assert.doesNotMatch(rendered, /lifecycle complete/);
        } finally {
            rmSync(runDir(id), { recursive: true, force: true });
        }
    });

    // @covers subagent.run-finalization
    // @level integration
    // @fails-without-fix subagent.run-finalization
    it("does not treat nested agent_end before top-level message_end as clean completion", () => {
        const id = `sa_finalize_nested_type_${process.pid}_${Date.now()}`;
        const messages = [];
        mkdirSync(runDir(id), { recursive: true });
        const fd = openSync(logPathFor(id), "w");
        try {
            writeSync(
                fd,
                `{"inner":{"type":"agent_end","toolCallId":"nested","toolName":"bash"},"payload":"`,
            );
            writeSync(fd, Buffer.alloc(LIFECYCLE_SCAN_CHUNK_BYTES + 2048, 0x78));
            writeSync(
                fd,
                `","type":"message_end","message":{"role":"assistant","content":"progress only"}}\n`,
            );
        } finally {
            closeSync(fd);
        }
        seedRunningMeta(id);

        try {
            const result = finalizeRun(id, 0, {
                renderWidget: () => {},
                notify: () => {},
                sendMessage: (message, options) => messages.push({ message, options }),
            });

            assert.equal(result.applied, true);
            assert.equal(result.outcome?.status, "failed");
            assert.equal(result.outcome?.incomplete, true);
            assert.equal(result.outcome?.classification, "incomplete_no_terminal_event");
            assert.equal(result.outcome?.diagnostics.sawTerminalEvent, false);

            const persisted = readMeta(id);
            assert.equal(persisted?.status, "failed");
            assert.equal(persisted?.failureReason, "incomplete-stream");
            assert.equal(persisted?.lifecycleClassification, "incomplete_no_terminal_event");

            assert.match(messages[0].message.content, /ATTENTION/i);
            assert.match(messages[0].message.content, /lifecycle incomplete_no_terminal_event/);

            const rendered = buildSubagentResultText(id);
            assert.ok(rendered);
            assert.match(rendered, /lifecycle incomplete_no_terminal_event/);
            assert.doesNotMatch(rendered, /lifecycle complete/);
        } finally {
            rmSync(runDir(id), { recursive: true, force: true });
        }
    });

    // @covers subagent.run-finalization
    // @level integration
    // @fails-without-fix subagent.run-finalization
    it("fails closed on closed oversized agent_end with trailing comma (invalid JSON)", () => {
        const id = `sa_finalize_trail_comma_${process.pid}_${Date.now()}`;
        const messages = [];
        mkdirSync(runDir(id), { recursive: true });
        const fd = openSync(logPathFor(id), "w");
        try {
            // Reviewer counterexample: closed oversized agent_end with trailing comma is
            // invalid JSON and must never finalize as clean completion.
            writeSync(fd, `{"type":"agent_end","payload":"`);
            writeSync(fd, Buffer.alloc(LIFECYCLE_RECORD_PREFIX_BYTES + 2048, 0x78));
            writeSync(fd, `",}\n`);
        } finally {
            closeSync(fd);
        }
        seedRunningMeta(id);

        try {
            const result = finalizeRun(id, 0, {
                renderWidget: () => {},
                notify: () => {},
                sendMessage: (message, options) => messages.push({ message, options }),
            });

            assert.equal(result.applied, true);
            assert.equal(result.outcome?.status, "failed");
            assert.equal(result.outcome?.incomplete, true);
            assert.equal(result.outcome?.classification, "incomplete_no_terminal_event");
            assert.equal(result.outcome?.diagnostics.sawTerminalEvent, false);

            const persisted = readMeta(id);
            assert.equal(persisted?.status, "failed");
            assert.equal(persisted?.failureReason, "incomplete-stream");
            assert.equal(persisted?.lifecycleClassification, "incomplete_no_terminal_event");

            assert.match(messages[0].message.content, /ATTENTION/i);
            assert.match(messages[0].message.content, /lifecycle incomplete_no_terminal_event/);

            const rendered = buildSubagentResultText(id);
            assert.ok(rendered);
            assert.match(rendered, /lifecycle incomplete_no_terminal_event/);
            assert.doesNotMatch(rendered, /lifecycle complete/);
        } finally {
            rmSync(runDir(id), { recursive: true, force: true });
        }
    });

    // @covers subagent.run-finalization
    // @level integration
    // @fails-without-fix subagent.run-finalization
    it("does not let malformed tool_execution_end balance an open tool into clean completion", () => {
        const id = `sa_finalize_bad_tool_end_${process.pid}_${Date.now()}`;
        const messages = [];
        writeRunLog(id, []);
        // Valid open tool, then malformed end (trailing comma), then a terminal-looking event.
        writeFileSync(
            logPathFor(id),
            [
                JSON.stringify({
                    type: "tool_execution_start",
                    toolCallId: "call_bash",
                    toolName: "bash",
                }),
                `{"type":"tool_execution_end","toolCallId":"call_bash",}`,
                JSON.stringify({
                    type: "agent_end",
                    messages: [{ role: "assistant", content: "Final answer" }],
                }),
                "",
            ].join("\n"),
        );
        seedRunningMeta(id);

        try {
            const result = finalizeRun(id, 0, {
                renderWidget: () => {},
                notify: () => {},
                sendMessage: (message, options) => messages.push({ message, options }),
            });

            assert.equal(result.applied, true);
            assert.equal(result.outcome?.status, "failed");
            assert.equal(result.outcome?.incomplete, true);
            // Stream is untrusted after malformed record; terminal authority is cleared.
            assert.equal(result.outcome?.classification, "incomplete_no_terminal_event");
            assert.equal(result.outcome?.diagnostics.sawTerminalEvent, false);

            const persisted = readMeta(id);
            assert.equal(persisted?.status, "failed");
            assert.equal(persisted?.failureReason, "incomplete-stream");
            assert.notEqual(persisted?.lifecycleClassification, "complete");

            assert.match(messages[0].message.content, /ATTENTION/i);
            assert.doesNotMatch(messages[0].message.content, /lifecycle complete/);

            const rendered = buildSubagentResultText(id);
            assert.ok(rendered);
            assert.doesNotMatch(rendered, /lifecycle complete/);
            assert.match(rendered, /lifecycle incomplete/);
        } finally {
            rmSync(runDir(id), { recursive: true, force: true });
        }
    });

    // @covers subagent.run-finalization
    // @level integration
    // @fails-without-fix subagent.run-finalization
    it("does not let duplicate toolCallId with null final value balance an open tool into clean completion", () => {
        const id = `sa_finalize_dup_toolcallid_${process.pid}_${Date.now()}`;
        const messages = [];
        writeRunLog(id, []);
        writeFileSync(
            logPathFor(id),
            [
                JSON.stringify({
                    type: "tool_execution_start",
                    toolCallId: "call_bash",
                    toolName: "bash",
                }),
                // Grammar-valid but duplicate toolCallId; final JSON value is null.
                `{"type":"tool_execution_end","toolCallId":"call_bash","toolCallId":null}`,
                JSON.stringify({
                    type: "agent_end",
                    messages: [{ role: "assistant", content: "Final answer" }],
                }),
                "",
            ].join("\n"),
        );
        seedRunningMeta(id);

        try {
            const result = finalizeRun(id, 0, {
                renderWidget: () => {},
                notify: () => {},
                sendMessage: (message, options) => messages.push({ message, options }),
            });

            assert.equal(result.applied, true);
            assert.equal(result.outcome?.status, "failed");
            assert.equal(result.outcome?.incomplete, true);
            assert.notEqual(result.outcome?.classification, "complete");
            assert.equal(result.outcome?.diagnostics.sawTerminalEvent, false);

            const persisted = readMeta(id);
            assert.equal(persisted?.status, "failed");
            assert.equal(persisted?.failureReason, "incomplete-stream");
            assert.notEqual(persisted?.lifecycleClassification, "complete");

            assert.match(messages[0].message.content, /ATTENTION/i);
            assert.doesNotMatch(messages[0].message.content, /lifecycle complete/);

            const rendered = buildSubagentResultText(id);
            assert.ok(rendered);
            assert.doesNotMatch(rendered, /lifecycle complete/);
            assert.match(rendered, /lifecycle incomplete/);
        } finally {
            rmSync(runDir(id), { recursive: true, force: true });
        }
    });

    // @covers subagent.run-finalization
    // @level integration
    // @fails-without-fix subagent.run-finalization
    it("does not let escaped duplicate toolCallId key balance an open tool into clean completion", () => {
        const id = `sa_finalize_dup_escaped_key_${process.pid}_${Date.now()}`;
        const messages = [];
        writeRunLog(id, []);
        writeFileSync(
            logPathFor(id),
            [
                JSON.stringify({
                    type: "tool_execution_start",
                    toolCallId: "call_bash",
                    toolName: "bash",
                }),
                `{"type":"tool_execution_end","toolCallId":"call_bash","toolCall\\u0049d":null}`,
                JSON.stringify({
                    type: "agent_end",
                    messages: [{ role: "assistant", content: "Final answer" }],
                }),
                "",
            ].join("\n"),
        );
        seedRunningMeta(id);

        try {
            const result = finalizeRun(id, 0, {
                renderWidget: () => {},
                notify: () => {},
                sendMessage: (message, options) => messages.push({ message, options }),
            });

            assert.equal(result.outcome?.status, "failed");
            assert.equal(result.outcome?.incomplete, true);
            assert.notEqual(result.outcome?.classification, "complete");
            assert.equal(result.outcome?.diagnostics.sawTerminalEvent, false);

            const persisted = readMeta(id);
            assert.notEqual(persisted?.lifecycleClassification, "complete");

            const rendered = buildSubagentResultText(id);
            assert.doesNotMatch(rendered, /lifecycle complete/);
            assert.match(rendered, /lifecycle incomplete/);
        } finally {
            rmSync(runDir(id), { recursive: true, force: true });
        }
    });

    // @covers subagent.run-finalization
    // @level integration
    // @fails-without-fix subagent.run-finalization
    it("detects unmatched tool start from a large newline-free record before a terminal tail event", () => {
        const id = `sa_finalize_large_tool_${process.pid}_${Date.now()}`;
        const messages = [];
        writeLargeNewlineFreeRecord(id, {
            type: "tool_execution_start",
            toolCallId: "call_bash",
            toolName: "bash",
            payloadBytes: LIFECYCLE_SCAN_CHUNK_BYTES * 2,
        });
        appendFileSync(
            logPathFor(id),
            `${JSON.stringify({
                type: "agent_end",
                messages: [{ role: "assistant", content: "Final answer" }],
            })}\n`,
        );
        seedRunningMeta(id);

        try {
            const result = finalizeRun(id, 0, {
                renderWidget: () => {},
                notify: () => {},
                sendMessage: (message, options) => messages.push({ message, options }),
            });

            assert.equal(result.outcome?.status, "failed");
            assert.equal(result.outcome?.incomplete, true);
            assert.equal(result.outcome?.classification, "incomplete_open_tools");
            assert.equal(result.outcome?.diagnostics.sawTerminalEvent, true);
            assert.deepEqual(result.outcome?.diagnostics.unmatchedTools, ["bash (call_bash)"]);

            assert.match(messages[0].message.content, /ATTENTION/i);
            assert.match(messages[0].message.content, /lifecycle incomplete_open_tools/);

            const rendered = buildSubagentResultText(id);
            assert.match(rendered, /lifecycle incomplete_open_tools/);
            assert.doesNotMatch(rendered, /lifecycle complete/);
        } finally {
            rmSync(runDir(id), { recursive: true, force: true });
        }
    });

    // @covers subagent.run-finalization
    // @level integration
    // @characterizes subagent.run-finalization
    it("persists failed_exit for nonzero exits without incomplete-stream labeling", () => {
        const id = `sa_finalize_fail_${process.pid}_${Date.now()}`;
        const messages = [];

        writeRunLog(id, [
            { type: "message_end", message: { role: "assistant", content: "boom" } },
            { type: "agent_end", messages: [{ role: "assistant", content: "boom" }] },
        ]);
        seedRunningMeta(id);

        try {
            const result = finalizeRun(id, 2, {
                renderWidget: () => {},
                notify: () => {},
                sendMessage: (message, options) => messages.push({ message, options }),
            });

            assert.equal(result.outcome?.classification, "failed_exit");
            assert.equal(result.outcome?.incomplete, false);

            const persisted = readMeta(id);
            assert.equal(persisted?.status, "failed");
            assert.equal(persisted?.exitCode, 2);
            assert.equal(persisted?.lifecycleClassification, "failed_exit");
            assert.equal(persisted?.failureReason, undefined);

            assert.match(messages[0].message.content, /failed \(exit 2\)/i);
            assert.doesNotMatch(messages[0].message.content, /ATTENTION/i);

            const rendered = buildSubagentResultText(id);
            assert.ok(rendered);
            assert.match(rendered, /lifecycle failed_exit/);
            assert.doesNotMatch(rendered, /ended unexpectedly/i);
        } finally {
            rmSync(runDir(id), { recursive: true, force: true });
        }
    });
});
