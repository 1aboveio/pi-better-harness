import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { buildSubagentResultText, finalizeRun } from "../finalization.ts";
import { logPathFor, readMeta, runDir, writeMeta } from "../registry.ts";

const id = `sa_smoke_midturn_${process.pid}_${Date.now()}`;
mkdirSync(runDir(id), { recursive: true });
writeFileSync(logPathFor(id), [
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: "progress" } }),
    JSON.stringify({ type: "tool_execution_start", toolCallId: "call_bash", toolName: "bash" }),
].join("\n"));
writeMeta({
    id,
    name: "smoke-midturn",
    status: "running",
    pid: process.pid,
    spawnPid: process.pid,
    cwd: process.cwd(),
    promptPreview: "smoke mid-turn exit",
    startedAt: Date.now() - 500,
    logPath: logPathFor(id),
    sessionId: "sess_smoke_midturn",
    callback: true,
});

try {
    const messages = [];
    const result = finalizeRun(id, 0, {
        renderWidget: () => {},
        notify: () => {},
        sendMessage: (message, options) => messages.push({ message, options }),
    });

    assert.equal(result.applied, true);
    assert.equal(result.outcome?.status, "failed");
    assert.equal(result.outcome?.incomplete, true);
    assert.equal(result.outcome?.classification, "incomplete_no_terminal_event");

    const persisted = readMeta(id);
    assert.equal(persisted?.status, "failed");
    assert.equal(persisted?.lifecycleClassification, "incomplete_no_terminal_event");
    assert.equal(persisted?.failureReason, "incomplete-stream");

    assert.equal(messages.length, 1);
    assert.match(messages[0].message.content, /ATTENTION/i);
    assert.match(messages[0].message.content, /lifecycle incomplete_no_terminal_event/);
    assert.doesNotMatch(messages[0].message.content, /\nprogress$/);

    const rendered = buildSubagentResultText(id);
    assert.ok(rendered);
    assert.match(rendered, /lifecycle incomplete_no_terminal_event/);
    assert.match(rendered, /ended unexpectedly/i);
    assert.doesNotMatch(rendered, /\]\nprogress$/);

    console.log("SMOKE PASS: exit-0 mid-turn log is classified as incomplete failed");
} finally {
    rmSync(runDir(id), { recursive: true, force: true });
}
