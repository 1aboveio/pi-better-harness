// @covers subagent.failure-observations
// @level integration
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { runDir, logPathFor, baseDir, recordTaskRuntimeProvenance, taskRuntimeProvenancePath } from "../registry.ts";
import { collectRunFailures, failurePath, failureSummary, readRunFailures, resetFailureScanCursor, toolOperation, TRUST_WAIT_MS } from "../failures.ts";
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
    assert.equal(failureSummary(f.id, "/repo"), "No failures need action · 1 unclassified tool error (history)");
    f.append(start("other", "pwd"), end("other", false, "ok"));
    state = collectRunFailures(f.id, "/repo");
    assert.equal(activeFailures(state).length, 1);
    assert.equal(activeFailures(collectRunFailures(f.id, "/repo")).length, 1);
    resetFailureScanCursor(f.id);
    assert.equal(activeFailures(collectRunFailures(f.id, "/repo")).length, 1);
    assert.equal(pendingFailureAttention(state, Date.now() + 61_000), undefined, "a live child's single tool error is its own to handle");
    const due = pendingFailureAttention(state, Date.now() + 61_000, { terminal: true });
    assert.deepEqual(due?.incidents, ["tool:bad"]);
    markFailureAttentionDelivered(failurePath(f.id), due);
    assert.equal(pendingFailureAttention(readRunFailures(f.id), Date.now() + 61_000, { terminal: true }), undefined);
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
    assert.match(summary, /1 earlier tool failure remains unclassified/);
    assert.match(failureSummary(f.id, "/repo"), /\nAlso in history: 1 unclassified tool error$/);
    assert.match(summary, /truncated or rewritten/);
});

// ---- #315: structured intent, explicit disposition, reduced incident state ------------------

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { activeFailures as active315, failureCounts, failureHistory, formatPendingAttention, formatTerminalFailureFacts, requiresAction } from "../shared-failure-observations.ts";
import { runFailureFacts } from "../failures.ts";

/** A run launched on the trusted task runtime: parent-written metadata is what enables structured intent. */
function confinedFixture(t) {
    const f = fixture(t);
    writeFileSync(join(runDir(f.id), "meta.json"), JSON.stringify({ id: f.id, status: "running", cwd: "/repo", taskRuntime: true, startedAt: 1 }));
    recordTaskRuntimeProvenance(f.id);
    t.after(() => rmSync(taskRuntimeProvenancePath(f.id), { force: true }));
    return f;
}
const bashStart = (toolCallId, args) => ({ type: "tool_execution_start", toolCallId, toolName: "bash", args });
const bashFail = (toolCallId, text) => ({ type: "tool_execution_end", toolCallId, toolName: "bash", isError: true, result: { content: [{ type: "text", text }] } });
const bashOk = (toolCallId, text = "ok", details) => ({ type: "tool_execution_end", toolCallId, toolName: "bash", isError: false, result: { content: [{ type: "text", text }], ...(details ? { details } : {}) } });
const dispose = (toolCallId, args, isError = false) => [
    { type: "tool_execution_start", toolCallId, toolName: "failure_disposition", args },
    { type: "tool_execution_end", toolCallId, toolName: "failure_disposition", isError, result: { content: [{ type: "text", text: isError ? "Disposition rejected" : "Recorded" }] } },
];

test("#315 compound command: the final shell exit is classified; an earlier successful subcommand is not evidence", (t) => {
    const f = confinedFixture(t);
    // `git commit && lsof -i :3000` — the commit succeeded, lsof found nothing (exit 1).
    f.append(bashStart("chain", { command: "git commit -m x && lsof -i :3000" }),
        bashFail("chain", "[main abc123] x\n 1 file changed\n\nCommand exited with code 1"));
    let state = collectRunFailures(f.id, "/repo");
    assert.equal(active315(state).length, 1, "prose about a successful commit does not excuse the non-zero exit");
    // The same chain with the probe's exit declared before execution is an expected failure.
    f.append(bashStart("chain-declared", { command: "git commit -m y && lsof -i :3000", expectedExitCodes: [1] }),
        bashOk("chain-declared", "[main def456] y\n\nCommand exited with code 1\n(Exit code 1 was declared expected.)", { exitCode: 1, expectedExit: true }));
    // A declared code that does not match the structured exit stays an ordinary failure.
    f.append(bashStart("chain-mismatch", { command: "git push && lsof -i :3000", expectedExitCodes: [1] }),
        bashFail("chain-mismatch", "fatal: could not read Username\n\nCommand exited with code 128"));
    // Claiming expectedExit without having declared the code before execution is not honored.
    f.append(bashStart("undeclared", { command: "rg foo" }), bashOk("undeclared", "", { exitCode: 1, expectedExit: true }));
    state = collectRunFailures(f.id, "/repo");
    const byLabel = Object.groupBy(active315(state), (x) => x.status);
    assert.equal(byLabel.expected?.length, 1);
    assert.match(byLabel.expected[0].summary, /declared expected code 1/);
    assert.equal(byLabel.unresolved?.length, 2);
    assert.equal(pendingFailureAttention(state, Date.now() + 3_600_000), undefined, "none of these wake a running parent");
});

test("#315 intentional no-match probes declared before execution never open actionable incidents", (t) => {
    const f = confinedFixture(t);
    const probes = [["rg", { command: "rg -n 'missing' src", expectedExitCodes: [1] }], ["diff", { command: "git diff --exit-code", expectedExitCodes: [1] }],
        ["lsof", { command: "lsof -i :4180", expectedExitCodes: [1] }]];
    for (const [id, args] of probes) f.append(bashStart(id, args), bashOk(id, "(no output)\n\nCommand exited with code 1", { exitCode: 1, expectedExit: true }));
    const state = collectRunFailures(f.id, "/repo", true);
    assert.equal(active315(state).filter((x) => x.status === "expected").length, 3);
    assert.equal(active315(state).filter((x) => x.status === "unresolved").length, 0);
    assert.equal(pendingFailureAttention(state, Date.now(), { terminal: true }), undefined, "expected failures are not delivered even at completion");
    assert.match(runFailureFacts(state, true), /3 expected failures recorded\./);
    assert.doesNotMatch(runFailureFacts(state, true), /Work correctness/);
});

test("#315 changed timeout/scope retry with a declared operationId recovers automatically; without it the exact rule still applies", (t) => {
    const f = confinedFixture(t);
    f.append(bashStart("full", { command: "npm test", timeout: 60, operationId: "unit-tests", attemptId: "full-1" }),
        bashFail("full", "Command timed out after 60 seconds"));
    f.append(bashStart("scoped", { command: "npm test -- test/scoped.test.ts", timeout: 600, operationId: "unit-tests", attemptId: "scoped-2" }),
        bashOk("scoped", "1 passed"));
    let state = collectRunFailures(f.id, "/repo");
    assert.equal(active315(state).length, 0, "the declared operation recovered");
    assert.equal(failureCounts(state).recovered, 1);
    // No operationId: a changed command is a different operation and cannot recover the first.
    f.append(bashStart("e2e", { command: "npx playwright test", timeout: 60 }), bashFail("e2e", "Command timed out after 60 seconds"),
        bashStart("e2e-scoped", { command: "npx playwright test smoke.spec.ts", timeout: 600 }), bashOk("e2e-scoped"));
    state = collectRunFailures(f.id, "/repo");
    assert.deepEqual(active315(state).map((x) => x.id), ["tool:e2e"]);
    // attemptId is evidence identity only: an exact retry with a different attemptId still recovers.
    f.append(bashStart("lint-1", { command: "npm run lint", attemptId: "lint-a" }), bashFail("lint-1", "lint failed"),
        bashStart("lint-2", { command: "npm run lint", attemptId: "lint-b" }), bashOk("lint-2"));
    assert.deepEqual(active315(collectRunFailures(f.id, "/repo")).map((x) => x.id), ["tool:e2e"]);
});

test("#315 merge-conflict remediation: the child explicitly supersedes the conflict with the verifying attempt as evidence", (t) => {
    const f = confinedFixture(t);
    f.append(bashStart("pick", { command: "git cherry-pick abc123", attemptId: "pick-1" }),
        bashFail("pick", "CONFLICT (content): Merge conflict in src/a.ts\n\nCommand exited with code 1"));
    f.append(bashStart("continue", { command: "git add src/a.ts && git cherry-pick --continue", attemptId: "pick-continue" }), bashOk("continue", "[main 42] picked"));
    // Rejections fail closed and write nothing.
    f.append(...dispose("d-bad-evidence", { disposition: "superseded", targets: ["pick-1"], reason: "resolved", evidence: "pick-1" }));
    f.append(...dispose("d-unknown", { disposition: "superseded", targets: ["nope"], reason: "resolved", evidence: "pick-continue" }));
    f.append(...dispose("d-no-evidence", { disposition: "superseded", targets: ["pick-1"], reason: "resolved" }));
    f.append(...dispose("d-recovered-other-op", { disposition: "recovered", targets: ["pick-1"], reason: "resolved", evidence: "pick-continue" }));
    let state = collectRunFailures(f.id, "/repo");
    assert.equal(active315(state).length, 1);
    assert.equal(state.dispositions, undefined);
    f.append(...dispose("d-ok", { disposition: "superseded", targets: ["pick-1"], reason: "conflict resolved and cherry-pick continued", evidence: "pick-continue" }));
    state = collectRunFailures(f.id, "/repo");
    assert.equal(active315(state).length, 0);
    const [closed] = failureHistory(state);
    assert.equal(closed.status, "superseded");
    assert.match(closed.disposition.evidence, /attempt pick-continue succeeded/);
    // A second disposition of the same incident is rejected; the journal is append-only and replays after reload.
    f.append(...dispose("d-again", { disposition: "expected", targets: ["pick-1"], reason: "again" }));
    const journal = readFileSync(failurePath(f.id), "utf8");
    assert.equal(journal.match(/"kind":"disposition"/g)?.length, 1);
    resetFailureScanCursor(f.id);
    assert.equal(active315(collectRunFailures(f.id, "/repo")).length, 0);
    assert.equal(readFileSync(failurePath(f.id), "utf8"), journal, "a rescan after reload does not duplicate dispositions");
    const program = `import {readFailureState} from ${JSON.stringify(new URL("../shared-failure-observations.ts", import.meta.url).href)}; const s=readFailureState(process.argv[1]); console.log(JSON.stringify({dispositions:s.dispositions.length, status:Object.values(s.observations)[0].status}));`;
    assert.deepEqual(JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program, failurePath(f.id)], { encoding: "utf8" })),
        { dispositions: 1, status: "superseded" });
});

test("#315 an earlier-started or failed attempt cannot be evidence; exit 0 of an unrelated command resolves nothing", (t) => {
    const f = confinedFixture(t);
    f.append(bashStart("early", { command: "npm run build", attemptId: "early" }), bashStart("bad", { command: "npm test", attemptId: "bad" }),
        bashFail("bad", "tests failed"), bashOk("early", "built"));
    f.append(bashStart("unrelated", { command: "echo all tests passed" }), bashOk("unrelated", "all tests passed"));
    f.append(...dispose("d-early", { disposition: "superseded", targets: ["bad"], reason: "build passed", evidence: "early" }));
    const state = collectRunFailures(f.id, "/repo");
    assert.deepEqual(active315(state).map((x) => x.id), ["tool:bad"]);
    assert.equal(state.dispositions, undefined);
});

test("#315 an explicit open disposition makes an owned failure actionable for the parent", (t) => {
    const f = confinedFixture(t);
    f.append(bashStart("auth", { command: "gh pr view 1", attemptId: "auth" }), bashFail("auth", "HTTP 401: Requires authentication"));
    let state = collectRunFailures(f.id, "/repo");
    assert.equal(requiresAction(active315(state)[0]), false);
    f.append(...dispose("d-open", { disposition: "open", targets: ["auth"], reason: "gh credentials are missing in the sandbox" }));
    state = collectRunFailures(f.id, "/repo");
    assert.equal(requiresAction(active315(state)[0]), true);
    assert.match(formatPendingAttention(state, ["tool:auth"]), /^Action required · .*HTTP 401.*open: gh credentials are missing/);
});

test("#315 session-scale fixture: production-derived kyc child logs reduce to a handful of actionable incidents without deleting history", (t) => {
    // Provenance: tool_execution_start/end rows of the 29 child runs of production session
    // 01a0dfb2 (issue #315), limited to operations that failed at least once. Commands, paths,
    // and outputs are replaced by stable placeholders; identity equality, order, isError, and the
    // tool's error shape (exit code / timeout / ENOENT / edit match) are preserved.
    const rows = readFileSync(new URL("./fixtures/issue-315/kyc-session-tool-failures.jsonl", import.meta.url), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const runs = Map.groupBy(rows, (row) => row.run);
    const totals = { failures: 0, unresolved: 0, actionRequired: 0, unclassified: 0, recovered: 0, attentionRunning: 0, terminalLines: 0, history: 0 };
    for (const [, events] of runs) {
        const f = confinedFixture(t);
        f.append(...events.map(({ run: _run, ...event }) => event));
        const state = collectRunFailures(f.id, "/repo", true);
        totals.failures += events.filter((e) => e.type === "tool_execution_end" && e.isError).length;
        const counts = failureCounts(state);
        totals.unresolved += counts.actionRequired + counts.unclassified;
        totals.actionRequired += counts.actionRequired;
        totals.unclassified += counts.unclassified;
        totals.recovered += counts.recovered;
        totals.history += failureHistory(state).length;
        if (pendingFailureAttention(state, Date.now() + 3_600_000)) totals.attentionRunning += 1;
        const due = pendingFailureAttention(state, Date.now(), { terminal: true });
        totals.terminalLines += formatTerminalFailureFacts(state, due?.incidents ?? []).split("\n").filter(Boolean).length;
        const journal = readFileSync(failurePath(f.id), "utf8");
        assert.equal(journal.match(/"kind":"failure"/g)?.length, events.filter((e) => e.type === "tool_execution_end" && e.isError).length,
            "every source failure remains in the append-only journal");
    }
    t.diagnostic(JSON.stringify(totals));
    assert.equal(runs.size, 29);
    assert.equal(totals.failures, 181);
    assert.ok(totals.unresolved >= 140, "the same retained observations exist; nothing was deleted");
    assert.ok(totals.actionRequired <= 3, `actionable incidents: ${totals.actionRequired}`);
    assert.ok(totals.attentionRunning <= 1, `running wakes: ${totals.attentionRunning}`);
    assert.ok(totals.terminalLines <= runs.size * 4, `terminal lines: ${totals.terminalLines}`);
});

test("#315 review: an unconfined child cannot use operationId or expectedExitCodes to recover or excuse a failure", (t) => {
    const f = fixture(t); // no task-runtime metadata: plain SDK bash ignores unknown fields
    f.append(bashStart("t1", { command: "npm test", operationId: "t" }), bashFail("t1", "1 failing"),
        bashStart("t2", { command: "true", operationId: "t" }), bashOk("t2"),
        bashStart("probe", { command: "rg nope", expectedExitCodes: [1] }), bashOk("probe", "", { exitCode: 1, expectedExit: true }));
    f.append(...dispose("d", { disposition: "superseded", targets: ["t1"], reason: "claimed", evidence: "t2" }));
    const state = collectRunFailures(f.id, "/repo");
    assert.deepEqual(active315(state).map((x) => x.id), ["tool:t1"], "the incident stays open under the exact-retry rule");
    assert.equal(state.dispositions, undefined, "dispositions are only honoured from the confined runtime");
    assert.equal(active315(state).filter((x) => x.status === "expected").length, 0);
    // Exact retry still recovers it.
    f.append(bashStart("t3", { command: "npm test", operationId: "t" }), bashOk("t3"));
    assert.equal(active315(collectRunFailures(f.id, "/repo")).length, 0);
});

test("#315 review: rejected intents are visible but never grouped with, or escalate, the operation they named", (t) => {
    const f = confinedFixture(t);
    for (const id of ["bad-1", "bad-2", "bad-3"]) {
        f.append(bashStart(id, { command: "npm test", expectedExitCodes: [0] }), bashFail(id, "Invalid command intent: expectedExitCodes must be ... The command was not run."));
    }
    f.append(bashStart("named", { command: "ls", attemptId: "a1" }), bashOk("named"),
        bashStart("reuse", { command: "ls", attemptId: "a1" }), bashFail("reuse", "Invalid command intent: attemptId a1 was already used. The command was not run."));
    const state = collectRunFailures(f.id, "/repo");
    const active = active315(state);
    assert.equal(active.length, 4);
    assert.ok(active.every((x) => x.category === "rejected-intent" && x.count === 1 && !requiresAction(x)));
    assert.match(active[0].summary, /not run: invalid command intent/);
    assert.equal(pendingFailureAttention(state, Date.now() + 3_600_000), undefined, "no Action required wake for commands that never ran");
    // The operation itself is unaffected: a real failure of it is a fresh, separate incident.
    f.append(bashStart("real", { command: "npm test" }), bashFail("real", "1 failing"));
    assert.equal(active315(collectRunFailures(f.id, "/repo")).find((x) => x.id === "tool:real")?.count, 1);
});

test("explicit-null intent fields are undeclared: a command that ran and failed is an ordinary failure that escalates", (t) => {
    // Provenance: the two bash calls of production child run sa_mujnmedf_4 (harness 0.6.1,
    // openai/gpt-5.6-sol) that 0.6.x misfiled as "bash not run: invalid command intent". The model
    // sent `expectedExitCodes: null`; Pi dropped the null before execute and the command ran and
    // failed for real (a Gradle lock EPERM, then a 1200 s timeout). Paths are placeholders; the
    // arguments, isError, and each output's head and tail are verbatim.
    const rows = readFileSync(new URL("./fixtures/null-intent/sa_mujnmedf_4-bash-rows.jsonl", import.meta.url), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(rows.filter((row) => row.type === "tool_execution_start").every((row) => row.args.expectedExitCodes === null));
    const f = confinedFixture(t);
    f.append(...rows);
    let state = collectRunFailures(f.id, "/repo");
    let active = active315(state);
    assert.deepEqual(active.map((x) => [x.category, x.count]), [["tool", 2]], "both runs are failures of the one declared operation, not rejected intents");
    assert.doesNotMatch(active[0].summary, /not run/);
    assert.match(active[0].summary, /bash failed: /);
    assert.equal(requiresAction(active[0]), false, "two failures are still below the repeated-failure threshold");
    // A third failure of the same operation escalates, exactly as it would without the nulls.
    f.append(bashStart("build-3", { attemptId: "android-apk-build-3", command: "pnpm build:android", expectedExitCodes: null, operationId: "android-apk-build", timeout: 1200 }),
        bashFail("build-3", "Exit status 1\n\nCommand exited with code 1"));
    state = collectRunFailures(f.id, "/repo");
    active = active315(state);
    assert.deepEqual(active.map((x) => [x.category, x.count]), [["tool", 3]]);
    assert.equal(requiresAction(active[0]), true);
    assert.ok(pendingFailureAttention(state, Date.now() + 3_600_000), "a repeated real failure wakes the parent");
});

test("explicit-null intent fields do not change exact identity: null-only retries group and recover like omitted ones", (t) => {
    const f = confinedFixture(t);
    const nulls = { operationId: null, attemptId: null, expectedExitCodes: null };
    f.append(bashStart("n1", { command: "npm test", ...nulls }), bashFail("n1", "1 failing\n\nCommand exited with code 1"),
        bashStart("n2", { command: "npm test" }), bashFail("n2", "1 failing\n\nCommand exited with code 1"),
        bashStart("n3", { command: "npm test", expectedExitCodes: null }), bashFail("n3", "1 failing\n\nCommand exited with code 1"));
    let active = active315(collectRunFailures(f.id, "/repo"));
    assert.deepEqual(active.map((x) => [x.category, x.count]), [["tool", 3]]);
    assert.equal(requiresAction(active[0]), true);
    f.append(bashStart("n4", { command: "npm test", ...nulls }), bashOk("n4"));
    active = active315(collectRunFailures(f.id, "/repo"));
    assert.equal(active.length, 0, "the exact retry recovers it, nulls or not");
});

test("rejected-intent is filed only from the child's own pre-run refusal, never re-derived from arguments", (t) => {
    const f = confinedFixture(t);
    // Pi's schema check refuses expectedExitCodes [0] before execute; nothing ran.
    f.append(bashStart("schema", { command: "npm test", expectedExitCodes: [0] }),
        bashFail("schema", "Validation failed for tool \"bash\":\n  - expectedExitCodes.0: must be >= 1\n\nReceived arguments:\n{}"));
    // The intent bash's own refusal of a duplicate code the schema cannot express.
    f.append(bashStart("dup", { command: "npm test", expectedExitCodes: [1, 1] }),
        bashFail("dup", "Invalid command intent: expectedExitCodes must be 1-16 distinct integers from 1 to 255. The command was not run."));
    // Pi coerced operationId 42 to "42" and the command ran and failed: the parent's own validator
    // disagrees with the raw argument, but the end row is a real run, so it is a real failure.
    f.append(bashStart("coerced", { command: "npm run lint", operationId: 42 }), bashFail("coerced", "lint error\n\nCommand exited with code 1"));
    // A command whose output merely contains the refusal wording still ran.
    f.append(bashStart("echo", { command: "cat notes.txt; exit 1" }),
        bashFail("echo", "Invalid command intent: x. The command was not run.\n\nCommand exited with code 1"));
    const byId = Object.fromEntries(active315(collectRunFailures(f.id, "/repo")).map((x) => [x.id, x]));
    assert.equal(byId["tool:schema"].category, "rejected-intent");
    assert.match(byId["tool:schema"].summary, /not run: invalid command intent \(expectedExitCodes must be/);
    assert.equal(byId["tool:dup"].category, "rejected-intent");
    assert.match(byId["tool:dup"].summary, /not run: invalid command intent \(expectedExitCodes must be 1-16 distinct/);
    assert.equal(byId["tool:coerced"].category, "tool");
    assert.match(byId["tool:coerced"].summary, /^bash failed: .*lint error/);
    assert.equal(byId["tool:echo"].category, "tool");
});

test("#315 review: a later exact-retry success does not erase an expected classification", (t) => {
    const f = confinedFixture(t);
    f.append(bashStart("probe", { command: "git diff --exit-code", expectedExitCodes: [1] }), bashOk("probe", "diff", { exitCode: 1, expectedExit: true }),
        bashStart("probe-2", { command: "git diff --exit-code", expectedExitCodes: [1] }), bashOk("probe-2", ""));
    const state = collectRunFailures(f.id, "/repo");
    assert.equal(failureCounts(state).expected, 1);
    assert.equal(failureCounts(state).recovered, 0);
});

// ---- #325 follow-ups -------------------------------------------------------------------------

/** Intent a trusted child would use to recover and excuse failures. */
function appendIntentRun(f) {
    f.append(bashStart("t1", { command: "npm test", operationId: "t" }), bashFail("t1", "1 failing"),
        bashStart("t2", { command: "npm test -- scoped", operationId: "t" }), bashOk("t2"),
        bashStart("probe", { command: "rg nope", expectedExitCodes: [1] }), bashOk("probe", "", { exitCode: 1, expectedExit: true }));
}

test("#325 a child-forged taskRuntime flag is ignored: trust needs the parent-authored provenance record", (t) => {
    const forged = fixture(t);
    // What a child able to write its own run directory could do: claim the trusted runtime in meta.json.
    writeFileSync(join(runDir(forged.id), "meta.json"), JSON.stringify({ id: forged.id, status: "running", cwd: "/repo", taskRuntime: true, startedAt: 1 }));
    appendIntentRun(forged);
    let state = collectRunFailures(forged.id, "/repo");
    assert.deepEqual(active315(state).map((x) => [x.id, x.status]), [["tool:t1", "unresolved"]], "exact rule: no declared recovery, no expected exit");
    // A provenance record naming another run does not transfer trust either.
    const other = fixture(t);
    writeFileSync(join(runDir(other.id), "meta.json"), JSON.stringify({ id: other.id, status: "running", cwd: "/repo", taskRuntime: true, startedAt: 1 }));
    mkdirSync(join(baseDir(), "task-runtime"), { recursive: true });
    writeFileSync(taskRuntimeProvenancePath(other.id), JSON.stringify({ version: 1, id: forged.id }));
    t.after(() => rmSync(taskRuntimeProvenancePath(other.id), { force: true }));
    appendIntentRun(other);
    assert.deepEqual(active315(collectRunFailures(other.id, "/repo")).map((x) => x.id), ["tool:t1"]);
    // The record lives outside every run directory, under the registry root the task policy denies to the child.
    assert.ok(taskRuntimeProvenancePath(forged.id).startsWith(baseDir() + "/"));
    assert.ok(!taskRuntimeProvenancePath(forged.id).startsWith(runDir(forged.id) + "/"));
    // The same log from a genuinely parent-launched run is honoured.
    const trusted = confinedFixture(t);
    appendIntentRun(trusted);
    state = collectRunFailures(trusted.id, "/repo");
    assert.deepEqual(active315(state).map((x) => [x.id, x.status]), [["tool:probe", "expected"]]);
    assert.equal(failureCounts(state).recovered, 1);
});

test("#325 a transient metadata read failure defers the scan instead of pinning the run to the exact rule", (t) => {
    const f = confinedFixture(t);
    const meta = join(runDir(f.id), "meta.json");
    const good = readFileSync(meta, "utf8");
    writeFileSync(meta, "{not json"); // e.g. read mid-replace, or a transient I/O error
    appendIntentRun(f);
    let state = collectRunFailures(f.id, "/repo");
    assert.equal(active315(state).length, 0, "nothing is folded while trust is unknown");
    assert.equal(readRunFailures(f.id).seen.length, 0, "and nothing is journaled under the wrong rule");
    writeFileSync(meta, good);
    state = collectRunFailures(f.id, "/repo");
    assert.deepEqual(active315(state).map((x) => [x.id, x.status]), [["tool:probe", "expected"]], "the retry honours the trusted runtime");
    assert.equal(failureCounts(state).recovered, 1, "the declared retry recovered");
});

test("#325 permanently unreadable metadata: the wait is bounded and real failures stay visible under the exact rule", (t) => {
    // Terminal read: no waiting at all.
    const done = confinedFixture(t);
    writeFileSync(join(runDir(done.id), "meta.json"), "{corrupt");
    appendIntentRun(done);
    let state = collectRunFailures(done.id, "/repo", true);
    const facts = runFailureFacts(state, true);
    assert.match(facts, /Observation incomplete · .*Run metadata could not be read/);
    assert.deepEqual(active315(state).filter((x) => x.category !== "observation-incomplete").map((x) => [x.id, x.status]), [["tool:t1", "unresolved"]],
        "the real failure is scanned (exact rule: the undeclared-trust retry does not recover it)");
    // Running read: waits, then scans once TRUST_WAIT_MS has passed.
    const running = confinedFixture(t);
    writeFileSync(join(runDir(running.id), "meta.json"), "{corrupt");
    appendIntentRun(running);
    const start = Date.now();
    t.mock.method(Date, "now", () => start);
    assert.equal(active315(collectRunFailures(running.id, "/repo")).length, 0, "within the bound: deferred");
    Date.now.mock.mockImplementation(() => start + TRUST_WAIT_MS);
    state = collectRunFailures(running.id, "/repo");
    assert.deepEqual(active315(state).map((x) => x.id).sort(), [active315(state).find((x) => x.category === "observation-incomplete").id, "tool:t1"].sort());
});
