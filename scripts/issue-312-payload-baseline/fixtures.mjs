/**
 * Synthetic disk fixtures for issue #312 payload measurement.
 *
 * Reuses the same registry / log / failure APIs the product tests use
 * (`writeMeta`, `logPathFor`, `appendWatchResult`, `observeFailures` via
 * log scan / `recordFailure`). No live model child, no real credentials.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { FROZEN_NOW } from "./isolate.mjs";

export const SYNTHETIC_CWD = "/tmp/issue-312-synthetic-workspace";
export const SYNTHETIC_SESSION = "issue-312-baseline";
export const SYNTHETIC_MARKER = "issue-312-synthetic";

const STARTED_AT = FROZEN_NOW - 45_000;
const ENDED_AT = FROZEN_NOW;

export const UNICODE_JSON_LINE = JSON.stringify({
    marker: SYNTHETIC_MARKER,
    note: "合成任务 ✓ 测量载荷",
    emoji: "📦🧠✅",
    combining: "e\u0301",
    terminalFailure: true,
    payload: "你".repeat(2500),
});

export const TOOL_SEQUENCE = ["bash", "read", "bash", "write", "edit"];

function ndjson(events) {
    return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function toolStart(id, name, args = {}) {
    return { type: "tool_execution_start", toolCallId: id, toolName: name, args };
}

function toolEnd(id, name, extra = {}) {
    return { type: "tool_execution_end", toolCallId: id, toolName: name, isError: false, ...extra };
}

function assistantText(text, usage = { input: 400, output: 800, cost: { total: 0.0034 } }) {
    return {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text }], usage },
    };
}

function agentEnd(text) {
    return { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text }] }] };
}

function writeSubagentLog(registry, id, events) {
    mkdirSync(registry.runDir(id), { recursive: true });
    writeFileSync(registry.logPathFor(id), ndjson(events));
}

function seedSubagentMeta(registry, id, extras = {}) {
    registry.writeMeta({
        id,
        name: extras.name ?? `synthetic-${id.replace(/^sa_issue312_/, "")}`,
        status: extras.status ?? "completed",
        pid: extras.pid ?? 0,
        spawnPid: process.pid,
        cwd: SYNTHETIC_CWD,
        promptPreview: `synthetic ${SYNTHETIC_MARKER} ${id}`,
        startedAt: STARTED_AT,
        endedAt: extras.endedAt ?? ENDED_AT,
        exitCode: extras.exitCode,
        logPath: registry.logPathFor(id),
        sessionId: SYNTHETIC_SESSION,
        callbackOrigin: extras.callbackOrigin ?? { cwd: SYNTHETIC_CWD, sessionId: SYNTHETIC_SESSION },
        callback: extras.callback ?? true,
        lifecycleClassification: extras.lifecycleClassification,
        failureReason: extras.failureReason,
        orphanedAt: extras.orphanedAt,
        ...extras.meta,
    });
}

function successEvents(finalText) {
    const tools = [
        toolStart("call_bash_1", "bash", { command: "ls" }),
        toolEnd("call_bash_1", "bash"),
        toolStart("call_read_1", "read", { path: "notes.md" }),
        toolEnd("call_read_1", "read"),
        toolStart("call_bash_2", "bash", { command: "pwd" }),
        toolEnd("call_bash_2", "bash"),
        toolStart("call_write_1", "write", { path: "out.md" }),
        toolEnd("call_write_1", "write"),
        toolStart("call_edit_1", "edit", { path: "out.md" }),
        toolEnd("call_edit_1", "edit"),
    ];
    return [
        assistantText("working"),
        ...tools,
        assistantText(finalText),
        agentEnd(finalText),
    ];
}

export function seedSubagentSuccess(registry) {
    const id = "sa_issue312_success";
    const finalText = [
        `${SYNTHETIC_MARKER} review complete.`,
        "Finding: the helper returns the bounded page.",
        "Next: reconstruct unread bytes through the caller cursor.",
    ].join("\n");
    writeSubagentLog(registry, id, successEvents(finalText));
    seedSubagentMeta(registry, id, { status: "running", endedAt: undefined, exitCode: undefined });
    return { id, finalText };
}

export function seedSubagentFailed(registry) {
    const id = "sa_issue312_failed";
    const finalText = `${SYNTHETIC_MARKER} child reported a failed_exit after the last assistant message.`;
    writeSubagentLog(registry, id, successEvents(finalText));
    seedSubagentMeta(registry, id, { status: "running", endedAt: undefined, exitCode: undefined });
    return { id, finalText };
}

export function seedSubagentIncomplete(registry) {
    const id = "sa_issue312_incomplete";
    const progress = `${SYNTHETIC_MARKER} progress before unexpected exit`;
    const events = [
        assistantText(progress, { input: 12, output: 9, cost: { total: 0.0002 } }),
        toolStart("call_bash", "bash", { command: "sleep 30" }),
    ];
    mkdirSync(registry.runDir(id), { recursive: true });
    const chunks = [ndjson(events)];
    // ~40 long lines so the raw-tail fallback can approach DEFAULT_RAW_TAIL_BYTES (256 KiB).
    const line = `{"type":"message_update","marker":"${SYNTHETIC_MARKER}","blob":"${"x".repeat(7000)}"}`;
    chunks.push(Array.from({ length: 40 }, () => line).join("\n"), "\n");
    writeFileSync(registry.logPathFor(id), chunks.join(""));
    seedSubagentMeta(registry, id, { status: "running", endedAt: undefined, exitCode: undefined });
    return { id, progress };
}

export function seedSubagentOrphaned(registry) {
    const id = "sa_issue312_orphaned";
    const progress = `${SYNTHETIC_MARKER} partial assistant progress while supervision is broken`;
    writeSubagentLog(registry, id, [
        assistantText(progress),
        toolStart("call_bash", "bash", { command: "npm test" }),
        toolEnd("call_bash", "bash"),
        toolStart("call_read", "read", { path: "README.md" }),
    ]);
    seedSubagentMeta(registry, id, {
        status: "orphaned",
        pid: 0,
        exitCode: undefined,
        orphanedAt: FROZEN_NOW - 30_000,
        endedAt: undefined,
        lifecycleClassification: "orphaned",
    });
    return { id, progress };
}

export function seedSubagentUnicode(registry) {
    const id = "sa_issue312_unicode";
    writeSubagentLog(registry, id, successEvents(UNICODE_JSON_LINE));
    seedSubagentMeta(registry, id, {
        status: "completed",
        exitCode: 0,
        lifecycleClassification: "complete",
        name: "unicode-json",
    });
    return { id, finalText: UNICODE_JSON_LINE };
}

/**
 * A final answer several times the default answer page (2 KiB): numbered
 * mixed ASCII/CJK/emoji lines so a dropped, duplicated, or split page shows up
 * as a byte mismatch rather than passing by accident.
 */
export const MULTI_PAGE_ANSWER = [
    `${SYNTHETIC_MARKER} multi-page answer begins.`,
    ...Array.from({ length: 60 }, (_, i) =>
        `${String(i + 1).padStart(3, "0")} finding: 合成段落 ✓ café 📦 — keep line ${i + 1} intact across page boundaries.`),
    `${SYNTHETIC_MARKER} multi-page answer ends.`,
].join("\n");

export function seedSubagentMultiPage(registry) {
    const id = "sa_issue312_multi_page";
    writeSubagentLog(registry, id, successEvents(MULTI_PAGE_ANSWER));
    seedSubagentMeta(registry, id, {
        status: "completed",
        exitCode: 0,
        lifecycleClassification: "complete",
        name: "multi-page",
    });
    return { id, finalText: MULTI_PAGE_ANSWER };
}

export function seedSubagentManyFailures(registry) {
    const id = "sa_issue312_many_failures";
    const events = [assistantText("starting checks")];
    for (let i = 0; i < 12; i += 1) {
        const callId = `call_fail_${i}`;
        const command = `synthetic-op-${i}`;
        events.push(toolStart(callId, "bash", { command }));
        events.push(toolEnd(callId, "bash", {
            isError: true,
            result: { content: [{ type: "text", text: `${SYNTHETIC_MARKER} failure ${i}: ${command} exited 2` }] },
        }));
    }
    const finalText = `${SYNTHETIC_MARKER} finished with unresolved tool incidents still open.`;
    events.push(assistantText(finalText), agentEnd(finalText));
    writeSubagentLog(registry, id, events);
    seedSubagentMeta(registry, id, {
        status: "completed",
        exitCode: 0,
        lifecycleClassification: "complete",
        name: "many-failures",
    });
    return { id, finalText };
}

/**
 * The quiet-history evidence shape (Pi session 01a0e22e, run sa_mujnmann_3): a completed run whose
 * only failures are eight unclassified child tool errors (ENOENT reads, a read past the end
 * of a file, an rg no-match) and two declared expected failures. Nothing needs action.
 */
export const QUIET_HISTORY_TOOL_ERRORS = [
    ["read", { path: "src/kyc/rules.ts" }, "ENOENT: no such file or directory, access '/Users/synthetic/projects/kyc/src/kyc/rules.ts'"],
    ["read", { path: "src/kyc/checks.ts" }, "ENOENT: no such file or directory, access '/Users/synthetic/projects/kyc/src/kyc/checks.ts'"],
    ["read", { path: "docs/kyc/flow.md" }, "ENOENT: no such file or directory, access '/Users/synthetic/projects/kyc/docs/kyc/flow.md'"],
    ["read", { path: "src/kyc/index.ts", offset: 400 }, "Offset 400 is beyond end of file (212 lines total)"],
    ["read", { path: "src/kyc/types.ts", offset: 900 }, "Offset 900 is beyond end of file (88 lines total)"],
    ["bash", { command: "rg -n 'riskTier' src/kyc" }, "(no output)\n\nCommand exited with code 1"],
    ["bash", { command: "rg -n 'sanctionsList' packages" }, "(no output)\n\nCommand exited with code 1"],
    ["read", { path: "src/kyc/legacy/adapter.ts" }, "ENOENT: no such file or directory, access '/Users/synthetic/projects/kyc/src/kyc/legacy/adapter.ts'"],
];

export function seedSubagentQuietHistory(registry) {
    const id = "sa_issue312_quiet_history";
    const events = [assistantText("reviewing the kyc module")];
    QUIET_HISTORY_TOOL_ERRORS.forEach(([tool, args, text], i) => {
        const callId = `call_quiet_${i}`;
        events.push(toolStart(callId, tool, args));
        events.push(toolEnd(callId, tool, { isError: true, result: { content: [{ type: "text", text }] } }));
    });
    for (let i = 0; i < 2; i += 1) {
        const callId = `call_expected_${i}`;
        const command = `git diff --exit-code -- src/kyc/part-${i}.ts`;
        events.push(toolStart(callId, "bash", { command }));
        events.push(toolEnd(callId, "bash", { isError: true, expected: true, result: { content: [{ type: "text", text: "Command exited with code 1" }] } }));
    }
    const finalText = `${SYNTHETIC_MARKER} kyc review complete; no blocking findings.`;
    events.push(assistantText(finalText), agentEnd(finalText));
    writeSubagentLog(registry, id, events);
    seedSubagentMeta(registry, id, {
        status: "completed",
        exitCode: 0,
        lifecycleClassification: "complete",
        name: "quiet-history",
    });
    return { id, finalText };
}

function seedBgMeta(registry, id, extras = {}) {
    mkdirSync(registry.taskDir(id), { recursive: true });
    const logPath = registry.logPathFor(id);
    registry.writeMeta({
        id,
        name: extras.name ?? `synthetic-${id.replace(/^bg_issue312_/, "")}`,
        kind: extras.kind ?? "process",
        status: extras.status ?? "succeeded",
        startedAt: STARTED_AT,
        endedAt: extras.endedAt ?? ENDED_AT,
        logPath,
        cwd: SYNTHETIC_CWD,
        shell: true,
        spawnPid: process.pid,
        callback: extras.callback ?? true,
        callbackOrigin: { cwd: SYNTHETIC_CWD, sessionId: SYNTHETIC_SESSION },
        command: extras.command ?? "true",
        lastExitCode: extras.lastExitCode,
        lastSignal: extras.lastSignal,
        lastState: extras.lastState,
        result: extras.result,
        error: extras.error,
        logDiscardedBytes: extras.logDiscardedBytes,
        logRetentionEvents: extras.logRetentionEvents,
        intervalMs: extras.intervalMs,
        lastCheckedAt: extras.lastCheckedAt,
        successWhen: extras.successWhen,
        failureWhen: extras.failureWhen,
        ...extras.meta,
    });
    return logPath;
}

export function seedBgSuccess(registry, logs) {
    const id = "bg_issue312_success";
    const logPath = seedBgMeta(registry, id, {
        status: "succeeded",
        kind: "process",
        lastExitCode: 0,
        command: "printf 'ready\\n'",
        result: { reason: "exit_code" },
    });
    writeFileSync(logPath, [
        `${SYNTHETIC_MARKER} process start`,
        "compiling module",
        "running checks",
        "ready",
        "exit 0",
        "",
    ].join("\n"));
    return { id };
}

export function seedBgFailed(registry, logs, failures) {
    const id = "bg_issue312_failed";
    const logPath = seedBgMeta(registry, id, {
        status: "failed",
        kind: "command_watch",
        lastExitCode: 0,
        command: "cat state.json",
        intervalMs: 30_000,
        lastCheckedAt: ENDED_AT,
        successWhen: { type: "json_path_equals", path: "$.ready", value: true },
        failureWhen: { type: "json_path_equals", path: "$.terminalFailure", value: true },
        result: {
            reason: "failure_when",
            matchedCondition: { type: "json_path_equals", path: "$.terminalFailure", value: true },
        },
        lastState: { terminalFailure: true, marker: SYNTHETIC_MARKER },
        error: "failure_when matched",
    });
    logs.appendWatchResult(logPath, {
        stdout: JSON.stringify({ terminalFailure: true, marker: SYNTHETIC_MARKER }),
        stderr: "",
        exitCode: 0,
        signal: null,
        startedAt: STARTED_AT,
        endedAt: STARTED_AT + 12,
    });
    failures.recordFailure(
        registry.readMeta(id),
        "failure_when",
        `${SYNTHETIC_MARKER} matched $.terminalFailure = true`,
        "poll-18",
        { category: "condition", evidence: `${logPath}#poll=18` },
    );
    return { id };
}

export function seedBgRepeatedPoll(registry, logs) {
    const id = "bg_issue312_repeated_poll";
    const logPath = seedBgMeta(registry, id, {
        status: "running",
        kind: "command_watch",
        endedAt: undefined,
        lastExitCode: 0,
        intervalMs: 30_000,
        lastCheckedAt: FROZEN_NOW - 4_000,
        command: "cat status.json",
        successWhen: { type: "json_path_equals", path: "$.status", value: "done" },
        lastState: { status: "pending", marker: SYNTHETIC_MARKER },
    });
    const stdout = JSON.stringify({ status: "pending", marker: SYNTHETIC_MARKER });
    for (let i = 0; i < 80; i += 1) {
        logs.appendWatchResult(logPath, {
            stdout,
            stderr: "",
            exitCode: 0,
            signal: null,
            startedAt: STARTED_AT + i * 30_000,
            endedAt: STARTED_AT + i * 30_000 + 18,
        });
    }
    return { id, pollCount: 80, distinctStdout: 1 };
}

export function seedBgUnicode(registry) {
    const id = "bg_issue312_unicode";
    const logPath = seedBgMeta(registry, id, {
        status: "succeeded",
        kind: "command_watch",
        lastExitCode: 0,
        lastState: UNICODE_JSON_LINE,
        result: { reason: "json_path_equals" },
        command: "cat payload.json",
    });
    writeFileSync(logPath, `${UNICODE_JSON_LINE}\n`);
    return { id };
}

export function seedBgManyFailures(registry, failures) {
    const id = "bg_issue312_many_failures";
    const logPath = seedBgMeta(registry, id, {
        status: "failed",
        kind: "command_watch",
        lastExitCode: 7,
        command: "check",
        error: `${SYNTHETIC_MARKER} 12 unresolved incidents remain`,
    });
    writeFileSync(logPath, `${SYNTHETIC_MARKER} many-failure watcher\n`);
    const meta = registry.readMeta(id);
    for (let i = 0; i < 12; i += 1) {
        failures.recordFailure(
            meta,
            `watch-poll-${i}`,
            `${SYNTHETIC_MARKER} poll ${i} failed: evaluator could not read $.step${i}`,
            `event-${i}`,
            { category: "observation-incomplete", incomplete: i % 4 === 0, evidence: `${logPath}#poll=${i}` },
        );
    }
    return { id };
}

export function seedSubagentForeign(registry) {
    const id = "sa_issue312_foreign";
    writeSubagentLog(registry, id, successEvents(`${SYNTHETIC_MARKER} foreign-session secret answer`));
    seedSubagentMeta(registry, id, {
        status: "completed",
        exitCode: 0,
        lifecycleClassification: "complete",
        name: "foreign",
        callbackOrigin: { cwd: SYNTHETIC_CWD, sessionId: "issue-312-other-session" },
        sessionId: "issue-312-other-session",
    });
    return { id };
}

export const REQUIRED_FAMILIES = [
    "success",
    "failed",
    "incomplete",
    "orphaned",
    "repeated-poll",
    "unicode-long-line-json",
    "many-failures",
    "many-completions",
    "multi-page-answer",
    "quiet-history",
];
