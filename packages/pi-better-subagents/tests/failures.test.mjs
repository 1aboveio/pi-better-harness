// @covers subagent.failure-observations
// @level integration
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { runDir, logPathFor } from "../registry.ts";
import { collectRunFailures, failurePath, failureSummary, readRunFailures, resetFailureScanCursor, toolOperation } from "../failures.ts";
import { activeFailures, markFailureAttentionDelivered, pendingFailureAttention } from "../shared-failure-observations.ts";

function fixture(t) {
    const id = `sa_failure_${randomUUID()}`;
    mkdirSync(runDir(id), { recursive: true });
    t.after(() => rmSync(runDir(id), { recursive: true, force: true }));
    return { id, log: logPathFor(id), append: (...events) => appendFileSync(logPathFor(id), events.map((e) => JSON.stringify(e)).join("\n") + "\n") };
}
const start = (toolCallId, command) => ({ type: "tool_execution_start", toolCallId, toolName: "bash", args: { command } });
const end = (toolCallId, isError, message) => ({ type: "tool_execution_end", toolCallId, toolName: "bash", isError, result: { content: [{ type: "text", text: message }] } });
const progress = (text) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });

test("failure after green progress survives tail noise, reload-style replay and unrelated success", (t) => {
    const f = fixture(t);
    f.append(progress("tests green"), start("bad", "npm test"), end("bad", true, "tests failed"));
    appendFileSync(f.log, Array.from({ length: 200 }, () => JSON.stringify(progress("all good"))).join("\n") + "\n");
    let state = collectRunFailures(f.id, "/repo");
    assert.match(failureSummary(f.id, "/repo"), /^Unresolved failure.*tests failed/s);
    f.append(start("other", "pwd"), end("other", false, "ok"));
    state = collectRunFailures(f.id, "/repo");
    assert.equal(activeFailures(state).length, 1);
    assert.equal(activeFailures(collectRunFailures(f.id, "/repo")).length, 1);
    resetFailureScanCursor(f.id);
    assert.equal(activeFailures(collectRunFailures(f.id, "/repo")).length, 1);
    const due = pendingFailureAttention(state, Date.now() + 61_000);
    assert.deepEqual(due?.incidents, ["tool:bad"]);
    markFailureAttentionDelivered(failurePath(f.id), due);
    assert.equal(pendingFailureAttention(readRunFailures(f.id), Date.now() + 61_000), undefined);
    f.append(start("retry", "npm test"), end("retry", false, "pass"));
    assert.equal(activeFailures(collectRunFailures(f.id, "/repo")).length, 0);
});

test("parallel earlier start cannot recover failure, later exact retry can", (t) => {
    const f = fixture(t);
    f.append(start("parallel", "npm test"), start("bad", "npm test"), end("bad", true, "failed"), end("parallel", false, "pass"));
    assert.equal(activeFailures(collectRunFailures(f.id, "/repo")).length, 1);
    f.append(start("retry", "npm test"), end("retry", false, "pass"));
    assert.equal(activeFailures(collectRunFailures(f.id, "/repo")).length, 0);
    assert.notEqual(toolOperation("bash", { command: "npm test" }, "/repo"), toolOperation("bash", { command: "npm test" }, "/elsewhere"));
});

test("nonzero, model errors, expected errors, malformed/partial records and sidecar corruption", (t) => {
    const f = fixture(t);
    f.append(start("nonzero", "npm test"), { ...end("nonzero", false, "test output"), result: { exitCode: 2, stderr: "test failed" } },
        { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "model unavailable" } },
        start("expected", "false"), { ...end("expected", true, "expected miss"), expected: true });
    appendFileSync(f.log, '{broken\n{"type":"tool_execution_end","toolCallId":"partial"');
    const state = collectRunFailures(f.id, "/repo", true);
    assert.match(failureSummary(f.id, "/repo", true), /Observation incomplete/);
    assert.equal(activeFailures(state).filter((x) => x.status === "unresolved").length, 3);
    assert.equal(activeFailures(state).filter((x) => x.status === "expected").length, 1);
    assert.ok(!pendingFailureAttention(state, Date.now(), { terminal: true })?.incidents.includes("tool:expected"));
    const expectedOnly = fixture(t);
    expectedOnly.append(start("expected-only", "false"), { ...end("expected-only", true, "intentional"), expected: true });
    assert.equal(pendingFailureAttention(collectRunFailures(expectedOnly.id, "/repo"), Date.now() + 61_000), undefined);
    appendFileSync(failurePath(f.id), '{bad\n');
    assert.match(failureSummary(f.id, "/repo", true), /Failure journal contains unreadable records/);
});

test("model retry recovers its own prior error, not an unrelated tool failure", (t) => {
    const f = fixture(t);
    f.append(start("bad", "npm test"), end("bad", true, "test failure"),
        { type: "auto_retry_start", errorMessage: "rate limited" },
        { type: "auto_retry_end", success: true });
    const state = collectRunFailures(f.id, "/repo");
    assert.deepEqual(activeFailures(state).map((x) => x.id), ["tool:bad"]);
});

test("domain status codes and file contents do not masquerade as command failure", (t) => {
    const f = fixture(t);
    f.append({ ...start("read", ""), toolName: "read", args: { path: "notes.txt" } },
        { ...end("read", false, "Command exited with code 2"), toolName: "read", result: { code: 200, content: [{ type: "text", text: "Command exited with code 2" }] } });
    f.append(start("echo", "echo 'Command exited with code 2'"), end("echo", false, "Command exited with code 2"));
    assert.equal(activeFailures(collectRunFailures(f.id, "/repo")).length, 0);
});

test("missing logs and invalid structured outcomes are explicit observation gaps", (t) => {
    const f = fixture(t);
    f.append(progress("working"));
    collectRunFailures(f.id, "/repo");
    for (let cycle = 0; cycle < 3; cycle++) {
        renameSync(f.log, f.log + ".saved");
        assert.match(failureSummary(f.id, "/repo", true), /Child log is unavailable/);
        renameSync(f.log + ".saved", f.log);
        assert.equal(activeFailures(collectRunFailures(f.id, "/repo", true)).length, 0);
    }
    f.append({ type: "tool_execution_end", toolCallId: "missing-outcome", toolName: "bash" });
    assert.match(failureSummary(f.id, "/repo", true), /Observation incomplete/);
});

test("truncation is incomplete without erasing prior incident", (t) => {
    const f = fixture(t);
    f.append(start("bad", "npm test"), end("bad", true, "failed"));
    collectRunFailures(f.id, "/repo");
    writeFileSync(f.log, JSON.stringify(progress("new log")) + "\n");
    const summary = failureSummary(f.id, "/repo", true);
    assert.match(summary, /tests? failed|failed/);
    assert.match(summary, /truncated or rewritten/);
});
