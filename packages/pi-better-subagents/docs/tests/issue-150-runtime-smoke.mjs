/**
 * Runtime smoke for #150 — completion callbacks are outcome-focused.
 *
 * Exercises the two changed seams through their real entry points:
 *  1. subagent.completion-callback — formatCallbackTrigger / buildCompletionDelivery
 *     with a long, repetitive tool trace: outcome metadata and the
 *     subagent_result instruction must survive; the trace must not.
 *  2. subagent.run-finalization — a real finalizeRun against a temp run dir
 *     whose log carries a long repetitive tool trace: the delivered callback
 *     must omit the trace while the durable subagent_result keeps the detail.
 *
 * Run: node --experimental-strip-types docs/tests/issue-150-runtime-smoke.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { buildCompletionDelivery, formatCallbackTrigger } from "../../completion.mjs";
import { buildSubagentResultText, finalizeRun } from "../../finalization.ts";
import { logPathFor, runDir, writeMeta } from "../../registry.ts";

const longTrace = Array.from({ length: 200 }, (_, i) => (i % 2 ? "bash" : "read")).join(",");
const TRACE_RE = /read|bash|tools:/;

// --- surface 1: subagent.completion-callback -------------------------------
const completed = formatCallbackTrigger({
    id: "sa_smoke150",
    label: "smoke (sa_smoke150)",
    verdict: "✓ completed",
    stat: "1m 05s · 3.1k tok · $0.0040",
    tools: longTrace,
    lifecycleClassification: "complete",
});
assert.ok(completed.includes("smoke (sa_smoke150)"), "label retained");
assert.ok(completed.includes("✓ completed"), "verdict retained");
assert.ok(completed.includes("1m 05s"), "elapsed retained");
assert.ok(completed.includes("lifecycle complete"), "lifecycle classification retained");
assert.ok(completed.includes('subagent_result id="sa_smoke150"'), "handoff instruction retained");
assert.doesNotMatch(completed, TRACE_RE, "completed callback omits the tool trace");

const failed = formatCallbackTrigger({
    id: "sa_smoke150",
    label: "smoke (sa_smoke150)",
    verdict: "✗ failed (exit 1)",
    stat: "12s · 900 tok",
    tools: longTrace,
});
assert.ok(failed.includes("✗ failed (exit 1)"), "failed verdict retained");
assert.doesNotMatch(failed, TRACE_RE, "failed callback omits the tool trace");

const incomplete = formatCallbackTrigger({
    id: "sa_smoke150",
    label: "smoke (sa_smoke150)",
    verdict: "✗ failed (exit 0)",
    stat: "3s",
    tools: longTrace,
    incomplete: true,
    lifecycleClassification: "incomplete_no_terminal_event",
});
assert.match(incomplete, /ATTENTION: a background subagent exited unexpectedly/, "incomplete wording retained");
assert.ok(incomplete.includes("Inspect the diagnostic with subagent_result"), "incomplete instruction retained");
assert.doesNotMatch(incomplete, TRACE_RE, "incomplete callback omits the tool trace");

const delivery = buildCompletionDelivery({
    id: "sa_smoke150",
    label: "smoke (sa_smoke150)",
    verdict: "✓ completed",
    stat: "1m 05s · 3.1k tok",
    tools: longTrace,
    callback: true,
    resultText: "SMOKE RESULT MUST NOT LEAK",
});
assert.equal(delivery.options.triggerTurn, true, "callback:true still triggers a turn");
assert.ok(!delivery.content.includes("SMOKE RESULT MUST NOT LEAK"), "result text never embedded");
assert.doesNotMatch(delivery.content, TRACE_RE, "delivery content omits the tool trace");
console.log("SMOKE PASS: subagent.completion-callback — outcome metadata + handoff retained, long trace omitted (completed/failed/incomplete)");

// --- surface 2: subagent.run-finalization ----------------------------------
const id = `sa_smoke150_${process.pid}`;
mkdirSync(runDir(id), { recursive: true });
const events = [];
for (let i = 0; i < 60; i++) {
    const toolName = i % 2 ? "bash" : "read";
    events.push(
        { type: "tool_execution_start", toolCallId: `call_${i}`, toolName },
        { type: "tool_execution_end", toolCallId: `call_${i}`, toolName },
    );
}
events.push(
    { type: "message_end", message: { role: "assistant", content: "Final answer" } },
    { type: "agent_end", messages: [{ role: "assistant", content: "Final answer" }] },
);
writeFileSync(logPathFor(id), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
writeMeta({
    id,
    name: "smoke-150",
    status: "running",
    pid: process.pid,
    spawnPid: process.pid,
    cwd: process.cwd(),
    promptPreview: "runtime smoke 150",
    startedAt: Date.now() - 65_000,
    logPath: logPathFor(id),
    sessionId: "sess_smoke150",
    callback: true,
});

try {
    const messages = [];
    const result = finalizeRun(id, 0, {
        renderWidget: () => {},
        notify: () => {},
        sendMessage: (message, options) => messages.push({ message, options }),
    });
    assert.equal(result.applied, true, "finalizeRun applied");
    assert.equal(messages.length, 1, "exactly one delivery");
    const content = messages[0].message.content;
    assert.match(content, /completed/i, "delivered verdict retained");
    assert.ok(content.includes("lifecycle complete"), "delivered lifecycle retained");
    assert.ok(content.includes(`subagent_result id="${id}"`), "delivered handoff instruction retained");
    assert.doesNotMatch(content, /read|bash|tools:/i, "delivered callback omits the 120-call trace");

    const rendered = buildSubagentResultText(id);
    assert.ok(rendered, "durable result still renders");
    assert.match(rendered, /Final answer/, "durable result keeps the final answer");
    console.log("SMOKE PASS: subagent.run-finalization — finalizeRun delivery omits 120-call trace; detail remains in subagent_result");
} finally {
    rmSync(runDir(id), { recursive: true, force: true });
}
