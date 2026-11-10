/**
 * Harness timing policy (timing.ts) and the child-side steer delivery (child-steer.ts).
 *
 * // @covers subagent.timing
 * // @level unit
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
    TIMING_ENV,
    decideTiming,
    describeTiming,
    emptyProgress,
    foldProgress,
    resolveRunTiming,
    stuckAlertText,
    stuckAge,
    timingParameterSchemas,
    toolWaitAlertText,
    isTimingMinutes,
    validatedTimingMinutes,
    MAX_SEEN_CALLS,
    callKey,
    isMutatingTool,
} from "../timing.ts";
import childSteer, { STEER_FILE_ENV, readSteerReceipt } from "../child-steer.ts";
import { mergeJobOptions } from "../batch.mjs";
import { findProviderRejectedKeywords } from "../../../scripts/provider-schema-compat.mjs";

const MIN = 60_000;

describe("timing policy resolution", () => {
    it("uses spawn parameter, then environment, then settings, then the built-in default", () => {
        const env = { [TIMING_ENV.deadline]: "20", [TIMING_ENV.stuck]: "4" };
        const settings = { deadlineMinutes: 25, graceMinutes: 2, maxMinutes: 60, toolWaitMinutes: 7 };
        const t = resolveRunTiming({ params: { deadline_minutes: 45, tool_wait_minutes: 3 }, settings, env, startedAt: 1000 });
        assert.equal(t.deadlineAt, 1000 + 45 * MIN, "parameter wins");
        assert.equal(t.graceMs, 2 * MIN, "settings when no parameter or env");
        assert.equal(t.ceilingAt, 1000 + 60 * MIN);
        assert.equal(t.toolWaitMs, 3 * MIN, "the tool-wait parameter is independent");
        assert.equal(t.stuckMs, 4 * MIN, "environment beats settings");
        const envOnly = resolveRunTiming({ settings, env, startedAt: 0 });
        assert.equal(envOnly.deadlineAt, 20 * MIN);
        assert.equal(envOnly.toolWaitMs, 7 * MIN, "the tool-wait setting is independent of the stuck setting");
        const defaults = resolveRunTiming({ startedAt: 0 });
        assert.deepEqual(defaults, {
            graceMs: 5 * MIN,
            toolWaitMs: 5 * MIN,
            stuckMs: 10 * MIN,
        }, "elapsed-time limits are opt-in; tool-wait and stall detection are default-on and independent");
    });

    it("treats null and empty env as unset, 0 as off, and rejects anything else", () => {
        const t = resolveRunTiming({ params: { deadline_minutes: null, max_minutes: 0, tool_wait_minutes: 0, stuck_minutes: 0 }, env: { [TIMING_ENV.grace]: "" }, startedAt: 0 });
        assert.equal(t.deadlineAt, undefined);
        assert.equal(t.graceMs, 5 * MIN);
        assert.equal(t.ceilingAt, undefined);
        assert.equal(t.toolWaitMs, undefined);
        assert.equal(t.stuckMs, undefined);
        assert.throws(() => resolveRunTiming({ params: { grace_minutes: -1 }, startedAt: 0 }), /grace_minutes must be/);
        assert.throws(() => resolveRunTiming({ params: { max_minutes: Number.NaN }, startedAt: 0 }), /max_minutes must be/);
        assert.throws(() => resolveRunTiming({ params: { tool_wait_minutes: -1 }, startedAt: 0 }), /tool_wait_minutes must be/);
        assert.throws(() => resolveRunTiming({ env: { [TIMING_ENV.deadline]: "soon" }, startedAt: 0 }), /PI_SUBAGENT_DEADLINE_MINUTES must be/);
        assert.throws(() => resolveRunTiming({ settings: { toolWaitMinutes: "soon" }, startedAt: 0 }), /toolWaitMinutes must be/);
        assert.throws(() => resolveRunTiming({ settings: { stuckMinutes: "ten" }, startedAt: 0 }), /stuckMinutes must be/);
        assert.equal(isTimingMinutes(0), true);
        assert.equal(isTimingMinutes(7 * 24 * 60), true);
        assert.equal(isTimingMinutes(7 * 24 * 60 + 1), false);
        assert.equal(validatedTimingMinutes("0.5", "toolWaitMinutes"), 0.5);
        assert.throws(() => validatedTimingMinutes("", "stuckMinutes"), /stuckMinutes must be/);
    });

    it("a batch job's null or omitted value inherits the shared value; a number or 0 overrides it", () => {
        const shared = { deadline_minutes: 12, grace_minutes: 2, max_minutes: 40, tool_wait_minutes: 6, stuck_minutes: 3 };
        const inherited = mergeJobOptions(shared, { prompt: "a", deadline_minutes: null });
        assert.equal(inherited.deadline_minutes, 12);
        assert.equal(inherited.tool_wait_minutes, 6);
        assert.equal(inherited.stuck_minutes, 3);
        const own = mergeJobOptions(shared, { prompt: "b", deadline_minutes: 7, tool_wait_minutes: 0, stuck_minutes: 0 });
        assert.equal(own.deadline_minutes, 7);
        assert.equal(own.tool_wait_minutes, 0);
        assert.equal(own.stuck_minutes, 0);
        assert.equal(resolveRunTiming({ params: mergeJobOptions(undefined, { prompt: "c", deadline_minutes: null }), startedAt: 0 }).deadlineAt, undefined,
            "with no shared value, null falls through to the disabled default");
    });

    it("offers provider-accepted schemas that admit explicit null", () => {
        const schema = Type.Object(timingParameterSchemas(Type));
        assert.deepEqual(findProviderRejectedKeywords(JSON.parse(JSON.stringify(schema))), []);
        assert.equal(Value.Check(schema, { deadline_minutes: null, grace_minutes: null, max_minutes: null, tool_wait_minutes: null, stuck_minutes: null }), true);
        assert.equal(Value.Check(schema, { deadline_minutes: 45, tool_wait_minutes: 5, stuck_minutes: 0 }), true);
        assert.equal(Value.Check(schema, {}), true);
        assert.equal(Value.Check(schema, { deadline_minutes: "45" }), false);
    });
});

describe("progress", () => {
    const start = (id, name, args = {}) => ({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
    const result = (id, name, at, isError = false) => ({ type: "message_end", message: { role: "toolResult", toolCallId: id, toolName: name, isError, timestamp: at } });
    const assistant = (at) => ({ type: "message_end", message: { role: "assistant", timestamp: at } });

    function fold(events, startedAt = 0) {
        const state = emptyProgress(startedAt);
        for (const event of events) foldProgress(state, event);
        return state;
    }

    it("counts any successful call that is not an exact repeat; edits, commits, and a success after a failure always count", () => {
        assert.equal(fold([start("a", "read", { path: "x" }), result("a", "read", 10)]).lastProgressAt, 10, "a first read is progress");
        assert.equal(fold([start("a", "bash", { command: "npm test" }), result("a", "bash", 10, true)]).lastProgressAt, undefined, "a failure is not progress");
        assert.equal(fold([
            start("a", "read", { path: "x", offset: null }), result("a", "read", 10),
            start("b", "read", { path: "x" }), result("b", "read", 20),
            start("c", "read", { offset: undefined, path: "x" }), result("c", "read", 30),
        ]).lastProgressAt, 10, "the same read again (null/absent/key order normalized) is not progress");
        assert.equal(fold([
            start("a", "read", { path: "x" }), result("a", "read", 10),
            start("b", "read", { path: "y" }), result("b", "read", 20),
            start("c", "bash", { command: "rg foo" }), result("c", "bash", 30),
        ]).lastProgressAt, 30, "distinct calls keep counting");
        assert.equal(fold([start("a", "read", { path: "x" }), result("a", "read", 10), start("b", "grep", { path: "x" }), result("b", "grep", 20)]).lastProgressAt, 20, "the tool name is part of the identity");
        assert.equal(fold([start("a", "edit", { path: "a" }), result("a", "edit", 10), start("b", "edit", { path: "a" }), result("b", "edit", 20)]).lastProgressAt, 20, "a repeated edit still counts");
        assert.equal(fold([start("a", "bash", { command: "git commit -m x" }), result("a", "bash", 10), start("b", "bash", { command: "git commit -m x" }), result("b", "bash", 20)]).lastProgressAt, 20, "a repeated commit still counts");
        assert.equal(fold([
            start("a", "bash", { command: "npm test" }), result("a", "bash", 20, true),
            start("b", "bash", { command: "npm test" }), result("b", "bash", 30),
        ]).lastProgressAt, 30, "a success after a failure counts even when the call repeats");
        assert.equal(fold([
            start("a", "bash", { command: "npm test" }), result("a", "bash", 20),
            start("b", "bash", { command: "npm test" }), result("b", "bash", 30),
        ]).lastProgressAt, 20, "re-running the same green command is not progress");
    });

    it("treats any file-mutating tool like edit/write: a repeat still counts", () => {
        for (const name of ["edit", "write", "multi_edit", "MultiEdit", "apply_patch", "str_replace", "str_replace_editor", "write_file", "edit_file"]) {
            assert.equal(isMutatingTool(name), true, name);
            assert.equal(fold([start("a", name, { patch: "p" }), result("a", name, 10), start("b", name, { patch: "p" }), result("b", name, 20)]).lastProgressAt, 20, `repeated ${name}`);
        }
        for (const name of ["read", "bash", "grep", "web_fetch", "editor", "rewrite"]) assert.equal(isMutatingTool(name), false, name);
    });

    it("bounds remembered calls per run, forgetting the oldest", () => {
        const state = emptyProgress(0);
        for (let i = 0; i <= MAX_SEEN_CALLS; i++) {
            foldProgress(state, start(`c${i}`, "read", { path: `f${i}` }));
            foldProgress(state, result(`c${i}`, "read", i + 1));
        }
        assert.equal(state.seen.size, MAX_SEEN_CALLS);
        assert.equal(callKey("read", { path: "f0" }).length, 22, "a fixed-size hash, not the arguments");
        foldProgress(state, start("again", "read", { path: "f0" }));
        foldProgress(state, result("again", "read", 999_999));
        assert.equal(state.lastProgressAt, 999_999, "the evicted oldest call counts again");
    });

    it("pauses the stuck clock while a tool call runs", () => {
        // An earlier identical run, so the long one's success is a repeat, not progress.
        const state = fold([start("p", "bash", { command: "npm test" }), result("p", "bash", 50), assistant(100), start("t", "bash", { command: "npm test" })], 0);
        assert.equal(stuckAge(state, 50_000), undefined, "waiting on a running command is not stuck");
        foldProgress(state, result("t", "bash", 40_100));
        assert.equal(state.lastProgressAt, 50);
        assert.equal(stuckAge(state, 41_000), 41_000 - 50 - 40_000, "only time outside the tool call counts");
    });

    it("records each open call's own start, including parallel calls and durable seeds", () => {
        const state = emptyProgress(0);
        foldProgress(state, assistant(1_000));
        foldProgress(state, start("first", "bash", { command: "npm test" }));
        foldProgress(state, start("second", "bash", { command: "npm run lint" }));
        assert.equal(state.open.get("first").startedAt, 1_000);
        assert.equal(state.open.get("second").startedAt, 1_000, "parallel starts share the last event timestamp");

        const reloaded = emptyProgress(0, [
            { id: "first", since: 1_000, name: "bash", command: "npm test" },
            { id: "second", since: 2_000, name: "bash", command: "npm run lint" },
        ]);
        assert.deepEqual([...reloaded.open.keys()], ["first", "second"]);
        assert.equal(reloaded.open.get("first").startedAt, 1_000);
        assert.equal(reloaded.open.get("second").startedAt, 2_000);
        assert.equal(reloaded.inFlightSince, 1_000, "the pause begins when the first call opened");
        // The real start still replaces the seed's empty arguments without moving its wait.
        foldProgress(reloaded, start("first", "bash", { command: "npm test" }));
        assert.equal(reloaded.open.get("first").startedAt, 1_000);
        assert.equal(reloaded.open.get("first").seeded, undefined);
        assert.equal(reloaded.open.get("second").seeded, true, "a parallel seeded call is not superseded by its sibling");
    });

    it("keeps a durable record of the open call, so a bounded reload read does not turn waiting into no progress (#620)", () => {
        // The parent reloaded and can only rebuild from a bounded log window that no longer
        // holds the call's start; the recorded call is its still-alive evidence.
        const seeded = emptyProgress(0, { id: "build", since: 1_000 });
        assert.deepEqual([...seeded.open.keys()], ["build"]);
        assert.equal(stuckAge(seeded, 60 * MIN), undefined, "a child waiting on the recorded call is not stuck");

        // Its own result ends the call; a silent build is a pause, not progress.
        foldProgress(seeded, result("build", "bash", 70_000));
        assert.equal(seeded.lastProgressAt, undefined, "the call's result is not itself progress");
        assert.equal(seeded.open.size, 0);
        assert.equal(stuckAge(seeded, 70_999), 70_999 - (70_000 - 1_000), "only time outside the call counts");

        // A later, different call supersedes a record whose own end was never seen: a
        // sequential child cannot still be in the earlier call.
        const superseded = emptyProgress(0, { id: "build", since: 1_000 });
        superseded.lastEventAt = 2_000;
        foldProgress(superseded, start("next", "read", { path: "a" }));
        assert.deepEqual([...superseded.open.keys()], ["next"]);
        assert.equal(superseded.open.get("next").seeded, undefined, "the real start replaces the record");
        assert.equal(superseded.pausedMs, 2_000 - 1_000, "the recorded wait stays a pause");

        // A record without a usable id or start is ignored, never invented.
        assert.equal(emptyProgress(0, {}).open.size, 0);
        assert.equal(emptyProgress(0, { id: "", since: 5 }).open.size, 0);
        const clamped = emptyProgress(1_000, { id: "build", since: 10 });
        assert.equal(clamped.inFlightSince, 1_000, "the pause cannot start before the run");
    });
});

describe("timing decisions", () => {
    const base = { deadlineAt: 1000, graceMs: 500, ceilingAt: 5000 };

    it("steers and wakes once at the deadline, stops after grace, and stops at the ceiling without grace", () => {
        assert.deepEqual(decideTiming(base, emptyProgress(0), 999), {});
        assert.deepEqual(decideTiming(base, emptyProgress(0), 1000), { steer: true, deadlineWake: true });
        const steered = { ...base, steerRequestedAt: 1000, deadlineWakeSentAt: 1001 };
        assert.deepEqual(decideTiming(steered, emptyProgress(0), 1400), {}, "nothing repeats inside grace");
        assert.deepEqual(decideTiming(steered, emptyProgress(0), 1500), { stop: "deadline" });
        assert.deepEqual(decideTiming({ graceMs: 0, ceilingAt: 5000 }, emptyProgress(0), 5000), { stop: "ceiling" });
        assert.deepEqual(decideTiming({ ...steered, stopReason: "deadline" }, emptyProgress(0), 9000), {}, "a stopped run is left alone");
    });

    it("starts grace when the steer is delivered, and holds the stop while it waits behind an open tool call", () => {
        const t = { deadlineAt: 1000, graceMs: 500, steerRequestedAt: 1000, deadlineWakeSentAt: 1000 };
        const busy = emptyProgress(0);
        foldProgress(busy, { type: "tool_execution_start", toolCallId: "long", toolName: "bash", args: { command: "npm test" } });
        assert.deepEqual(decideTiming(t, busy, 9000), {}, "undelivered behind a running tool call: held");
        assert.deepEqual(decideTiming({ ...t, ceilingAt: 9000 }, busy, 9000), { stop: "ceiling" }, "the ceiling still bounds it");
        foldProgress(busy, { type: "message_end", message: { role: "toolResult", toolCallId: "long", toolName: "bash", isError: false, timestamp: 8000 } });
        const delivered = { ...t, steerDeliveredAt: 8100 };
        assert.deepEqual(decideTiming(delivered, busy, 8599), {}, "grace runs from delivery");
        assert.deepEqual(decideTiming(delivered, busy, 8600), { stop: "deadline" });
        assert.deepEqual(decideTiming(t, emptyProgress(0), 1500), { stop: "deadline" }, "undelivered with no tool open (no steer extension): grace from the request");
    });

    it("wakes once per stuck spell and never for a progressing child", () => {
        const t = { graceMs: 0, stuckMs: 300 };
        const quiet = emptyProgress(0);
        assert.equal(decideTiming(t, quiet, 299).stuckWake, undefined);
        assert.deepEqual(decideTiming(t, quiet, 300).stuckWake, { anchorAt: 0, ageMs: 300 });
        assert.equal(decideTiming({ ...t, stuckWakeSentAt: 301, stuckAnchorAt: 0 }, quiet, 900).stuckWake, undefined, "once");
        const busy = emptyProgress(0);
        busy.lastProgressAt = 800;
        assert.equal(decideTiming({ ...t, stuckWakeSentAt: 301, stuckAnchorAt: 0 }, busy, 900).stuckWake, undefined, "progressing");
        assert.deepEqual(decideTiming({ ...t, stuckWakeSentAt: 301, stuckAnchorAt: 0 }, busy, 1100).stuckWake, { anchorAt: 800, ageMs: 300 }, "re-armed by progress");
        assert.equal(decideTiming({ deadlineAt: 100, graceMs: 10_000, stuckMs: 300, steerRequestedAt: 100, deadlineWakeSentAt: 100 }, quiet, 5000).stuckWake, undefined,
            "past the deadline, the wrap-up flow governs");
    });

    it("wakes once per open tool call at its own threshold, including parallel calls, without becoming stuck", () => {
        const t = { graceMs: 0, toolWaitMs: 300 };
        const state = emptyProgress(0);
        foldProgress(state, { type: "tool_execution_start", toolCallId: "long", toolName: "bash", args: { command: "npm test" } });
        assert.deepEqual(decideTiming(t, state, 299), {});
        assert.deepEqual(decideTiming(t, state, 300).toolWaitWakes, [
            { callId: "long", startedAt: 0, ageMs: 300, name: "bash", command: "npm test" },
        ]);
        assert.equal(decideTiming(t, state, 300).stuckWake, undefined, "a running tool is waiting, not no-progress");
        assert.deepEqual(decideTiming({ ...t, toolWaitAlerted: ["long"] }, state, 900), {}, "one alert per call across reconstruction");

        const parallel = emptyProgress(0);
        foldProgress(parallel, { type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "first" } });
        foldProgress(parallel, { type: "tool_execution_start", toolCallId: "b", toolName: "read", args: { path: "x" } });
        assert.deepEqual(decideTiming(t, parallel, 300).toolWaitWakes?.map((wake) => wake.callId), ["a", "b"],
            "parallel calls alert independently");
        assert.deepEqual(decideTiming({ ...t, toolWaitAlerted: ["a"] }, parallel, 300).toolWaitWakes?.map((wake) => wake.callId), ["b"],
            "the marker for one call does not suppress its sibling");

        const reloadSeed = emptyProgress(0, [
            { id: "a", since: 100, name: "bash", command: "first" },
            { id: "b", since: 200, name: "read" },
        ]);
        const reload = decideTiming(t, reloadSeed, 400);
        assert.deepEqual(reload.toolWaitWakes?.map((wake) => [wake.callId, wake.ageMs]), [["a", 300]],
            "the persisted calls keep their own start times after reconstruction");
        assert.deepEqual(decideTiming({ graceMs: 0, toolWaitMs: 300, toolWaitAlerted: ["a", "b"] }, reloadSeed, 500), {},
            "a reload with the alert marker does not repeat it");
    });

    it("keeps tool-wait dedup separate from the stuck spell and re-arms on a later call", () => {
        const state = emptyProgress(0);
        foldProgress(state, { type: "message_end", message: { role: "assistant", timestamp: 100 } });
        foldProgress(state, { type: "tool_execution_start", toolCallId: "first", toolName: "bash", args: { command: "make" } });
        const t = { graceMs: 0, toolWaitMs: 300, stuckMs: 300 };
        assert.deepEqual(decideTiming(t, state, 400).toolWaitWakes?.map((wake) => wake.callId), ["first"]);
        // The first call returns without progress: its wait is a pause.
        foldProgress(state, { type: "message_end", message: { role: "toolResult", toolCallId: "first", toolName: "bash", isError: true, timestamp: 500 } });
        const settled = { ...t, toolWaitAlerted: ["first"] };
        assert.equal(decideTiming(settled, state, 600).stuckWake, undefined, "the long call's duration is a pause");
        assert.deepEqual(decideTiming(settled, state, 700).stuckWake, { anchorAt: 0, ageMs: 300 },
            "the tool-wait marker does not suppress a genuine no-progress spell");
        // A later tool call gets its own wait alert even while the stuck marker is set.
        foldProgress(state, { type: "tool_execution_start", toolCallId: "second", toolName: "bash", args: { command: "make test" } });
        const second = decideTiming({ ...t, stuckWakeSentAt: 700, stuckAnchorAt: 0, toolWaitAlerted: ["first"] }, state, 1_200);
        assert.deepEqual(second.toolWaitWakes?.map((wake) => wake.callId), ["second"], "the next call alerts independently");
        assert.equal(second.stuckWake, undefined, "its wait keeps the stuck clock paused");
    });

    it("a recorded open call holds both the stuck wake and the deadline stop across a bounded reload (#620)", () => {
        const seeded = emptyProgress(0, { id: "build", since: 1_000 });
        assert.deepEqual(decideTiming({ graceMs: 0, stuckMs: 300 }, seeded, 10 * MIN), {}, "a silent build past the window is still waiting");
        const deadline = { deadlineAt: 500, graceMs: 1_000, steerRequestedAt: 500, deadlineWakeSentAt: 500, stuckMs: 300 };
        assert.deepEqual(decideTiming(deadline, seeded, 10 * MIN), {}, "the hold survives a reload that lost the call's start");
        // Once the call's own result arrives, the ordinary accounting resumes: the wait was a
        // pause, and the undelivered steer's grace runs from the request (the documented rule).
        foldProgress(seeded, { type: "message_end", message: { role: "toolResult", toolCallId: "build", toolName: "bash", isError: false, timestamp: 2_000 } });
        assert.deepEqual(decideTiming({ graceMs: 0, stuckMs: 300 }, seeded, 1_299), {}, "the call's time is a pause, so no wake yet");
        assert.deepEqual(decideTiming({ graceMs: 0, stuckMs: 300 }, seeded, 1_300), { stuckWake: { anchorAt: 0, ageMs: 300 } },
            "a full window of genuine silence still wakes the parent");
        assert.deepEqual(decideTiming(deadline, seeded, 10 * MIN), { stop: "deadline" });
    });

    it("renders the reason for every surface", () => {
        assert.equal(describeTiming({ startedAt: 0, timing: { graceMs: 0 } }), undefined, "limits alone are not news");
        assert.equal(describeTiming({ startedAt: 0, status: "killed", timing: { deadlineAt: 30 * MIN, graceMs: 5 * MIN, steerRequestedAt: 1, stopReason: "deadline" } }).short, "stopped: deadline");
        assert.equal(describeTiming({ startedAt: 0, status: "running", timing: { deadlineAt: 30 * MIN, graceMs: 5 * MIN, steerRequestedAt: 1 } }).short, "deadline: wrapping up");
        assert.equal(describeTiming({ startedAt: 0, status: "completed", timing: { deadlineAt: 30 * MIN, graceMs: 5 * MIN, steerRequestedAt: 1 } }).short, "deadline: finished in grace");
        for (const status of ["failed", "killed", "lost", "orphaned", "exited"]) {
            const note = describeTiming({ startedAt: 0, status, timing: { deadlineAt: 30 * MIN, graceMs: 5 * MIN, steerRequestedAt: 1 } });
            assert.equal(note.short, "deadline: passed", `${status} after the deadline is not "finished in grace"`);
            assert.match(note.line, new RegExp(`ended ${status} before the harness stopped it`));
        }
        assert.equal(describeTiming({ startedAt: 0, status: "killed", timing: { ceilingAt: 90 * MIN, graceMs: 0, stopReason: "ceiling" } }).short, "stopped: ceiling");
        assert.equal(describeTiming({ startedAt: 0, timing: { graceMs: 0, stuckMs: MIN, stuckWakeSentAt: 5, stuckAnchorAt: 3 } }).reason, "stuck");
        assert.equal(describeTiming({ startedAt: 0, timing: { graceMs: 0, stuckMs: MIN, stuckWakeSentAt: 5, stuckAnchorAt: 3, lastProgressAt: 9 } }), undefined, "progress since the wake clears it");
    });

    it("renders factual long-tool and no-progress alerts without prescribing a response", () => {
        const tool = toolWaitAlertText({
            id: "sa_alert_1", label: "builder (sa_alert_1)", callId: "call_7",
            toolName: "bash", command: "npm test -- --watch=false",
            openMs: 5.2 * MIN, thresholdMs: 5 * MIN, now: 10 * MIN,
            lastProgressAt: 2 * MIN, logPath: "/tmp/run/output.log",
        });
        assert.match(tool, /sa_alert_1/);
        assert.match(tool, /tool wait/i);
        assert.match(tool, /call_7/);
        assert.match(tool, /bash: npm test/);
        assert.match(tool, /open for 5\.2m/);
        assert.match(tool, /threshold 5m/);
        assert.match(tool, /Last progress: 8m ago/);
        assert.match(tool, /subagent_output id="sa_alert_1"/);
        assert.match(tool, /does not stop, cancel, or restart/);
        assert.doesNotMatch(tool, /before deciding|no action is needed|Inspect it with|must |should /i);

        const stuck = stuckAlertText({
            id: "sa_alert_2", label: "reviewer (sa_alert_2)", ageMs: 10 * MIN, windowMs: 10 * MIN,
            now: 12 * MIN, logPath: "/tmp/run/output.log",
        });
        assert.match(stuck, /no progress/i);
        assert.match(stuck, /only repeated earlier calls/);
        assert.match(stuck, /Current operation: none \(no tool call open\)/);
        assert.match(stuck, /Last progress: none observed/);
        assert.match(stuck, /subagent_output id="sa_alert_2"/);
        assert.doesNotMatch(stuck, /before deciding|no action is needed|Inspect it with|must |should /i);
    });
});

describe("child steer delivery", () => {
    it("delivers a steer request once, as a steer, only while the agent is working", async () => {
        const dir = mkdtempSync(join(tmpdir(), "child-steer-"));
        const path = join(dir, "steer.json");
        const previous = process.env[STEER_FILE_ENV];
        process.env[STEER_FILE_ENV] = path;
        const handlers = new Map();
        const sent = [];
        mock.timers.enable({ apis: ["setInterval"] });
        let idle = true;
        try {
            childSteer({ on: (event, fn) => handlers.set(event, fn), sendUserMessage: (text, options) => sent.push({ text, options }) });
            handlers.get("session_start")({}, { isIdle: () => idle });
            mock.timers.tick(2_000);
            assert.equal(sent.length, 0, "no request yet");
            writeFileSync(path, JSON.stringify({ id: "deadline:sa_x_1", text: "wrap up" }));
            mock.timers.tick(2_000);
            assert.equal(sent.length, 0, "an idle child is not prompted");
            idle = false;
            mock.timers.tick(2_000);
            mock.timers.tick(2_000);
            assert.deepEqual(sent, [{ text: "wrap up", options: { deliverAs: "steer" } }]);
            assert.equal(readSteerReceipt(path), undefined, "queued behind the current tool call is not delivered yet");
            handlers.get("message_end")({ message: { role: "user", content: [{ type: "text", text: "other" }] } }, {});
            handlers.get("message_end")({ message: { role: "assistant", content: [{ type: "text", text: "wrap up" }] } }, {});
            assert.equal(readSteerReceipt(path), undefined);
            const before = Date.now();
            handlers.get("message_end")({ message: { role: "user", content: [{ type: "text", text: "wrap up" }] } }, {});
            const receipt = readSteerReceipt(path);
            assert.equal(receipt.id, "deadline:sa_x_1", "a receipt when the steer enters the conversation");
            assert.ok(receipt.at >= before);
            handlers.get("session_shutdown")({}, {});
        } finally {
            mock.timers.reset();
            if (previous === undefined) delete process.env[STEER_FILE_ENV];
            else process.env[STEER_FILE_ENV] = previous;
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
