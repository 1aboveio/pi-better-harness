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
    DEFAULT_TIMING_MINUTES,
    TIMING_ENV,
    decideTiming,
    describeTiming,
    emptyProgress,
    foldProgress,
    resolveRunTiming,
    stuckAge,
    timingParameterSchemas,
} from "../timing.ts";
import childSteer, { STEER_FILE_ENV } from "../child-steer.ts";
import { findProviderRejectedKeywords } from "../../../scripts/provider-schema-compat.mjs";

const MIN = 60_000;

describe("timing policy resolution", () => {
    it("uses spawn parameter, then environment, then settings, then the built-in default", () => {
        const env = { [TIMING_ENV.deadline]: "20", [TIMING_ENV.stuck]: "4" };
        const settings = { deadlineMinutes: 25, graceMinutes: 2, maxMinutes: 60 };
        const t = resolveRunTiming({ params: { deadline_minutes: 45 }, settings, env, startedAt: 1000 });
        assert.equal(t.deadlineAt, 1000 + 45 * MIN, "parameter wins");
        assert.equal(t.graceMs, 2 * MIN, "settings when no parameter or env");
        assert.equal(t.ceilingAt, 1000 + 60 * MIN);
        assert.equal(t.stuckMs, 4 * MIN, "environment beats settings");
        const envOnly = resolveRunTiming({ settings, env, startedAt: 0 });
        assert.equal(envOnly.deadlineAt, 20 * MIN);
        const defaults = resolveRunTiming({ startedAt: 0 });
        assert.deepEqual(defaults, {
            deadlineAt: DEFAULT_TIMING_MINUTES.deadline * MIN,
            graceMs: DEFAULT_TIMING_MINUTES.grace * MIN,
            ceilingAt: DEFAULT_TIMING_MINUTES.max * MIN,
            stuckMs: DEFAULT_TIMING_MINUTES.stuck * MIN,
        });
    });

    it("treats null and empty env as unset, 0 as off, and rejects anything else", () => {
        const t = resolveRunTiming({ params: { deadline_minutes: null, max_minutes: 0, stuck_minutes: 0 }, env: { [TIMING_ENV.grace]: "" }, startedAt: 0 });
        assert.equal(t.deadlineAt, 30 * MIN);
        assert.equal(t.graceMs, 5 * MIN);
        assert.equal(t.ceilingAt, undefined);
        assert.equal(t.stuckMs, undefined);
        assert.throws(() => resolveRunTiming({ params: { grace_minutes: -1 }, startedAt: 0 }), /grace_minutes must be/);
        assert.throws(() => resolveRunTiming({ params: { max_minutes: Number.NaN }, startedAt: 0 }), /max_minutes must be/);
        assert.throws(() => resolveRunTiming({ env: { [TIMING_ENV.deadline]: "soon" }, startedAt: 0 }), /PI_SUBAGENT_DEADLINE_MINUTES must be/);
        assert.throws(() => resolveRunTiming({ settings: { stuckMinutes: "ten" }, startedAt: 0 }), /stuckMinutes must be/);
    });

    it("offers provider-accepted schemas that admit explicit null", () => {
        const schema = Type.Object(timingParameterSchemas(Type));
        assert.deepEqual(findProviderRejectedKeywords(JSON.parse(JSON.stringify(schema))), []);
        assert.equal(Value.Check(schema, { deadline_minutes: null, grace_minutes: null, max_minutes: null, stuck_minutes: null }), true);
        assert.equal(Value.Check(schema, { deadline_minutes: 45, stuck_minutes: 0 }), true);
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

    it("counts a successful edit/write, a git commit, and a success after a failure — nothing else", () => {
        assert.equal(fold([start("a", "read"), result("a", "read", 10)]).lastProgressAt, undefined, "a read is not progress");
        assert.equal(fold([start("a", "bash", { command: "npm test" }), result("a", "bash", 10)]).lastProgressAt, undefined, "a green command is not progress");
        assert.equal(fold([start("a", "edit"), result("a", "edit", 10, true)]).lastProgressAt, undefined, "a failed edit is not progress");
        assert.equal(fold([start("a", "edit"), result("a", "edit", 10)]).lastProgressAt, 10);
        assert.equal(fold([start("a", "write"), result("a", "write", 11)]).lastProgressAt, 11);
        assert.equal(fold([start("a", "bash", { command: "git add -A && git commit -m wip" }), result("a", "bash", 12)]).lastProgressAt, 12);
        assert.equal(fold([start("a", "bash", { command: "git -C repo commit -m x" }), result("a", "bash", 13)]).lastProgressAt, 13);
        assert.equal(fold([start("a", "bash", { command: "git log --grep commit" }), result("a", "bash", 13)]).lastProgressAt, undefined);
        assert.equal(fold([
            start("a", "bash", { command: "npm test" }), result("a", "bash", 20, true),
            start("b", "bash", { command: "npm test" }), result("b", "bash", 30),
        ]).lastProgressAt, 30, "a success after a failure is progress");
    });

    it("pauses the stuck clock while a tool call runs", () => {
        const state = fold([assistant(100), start("t", "bash", { command: "npm test" })], 0);
        assert.equal(stuckAge(state, 50_000), undefined, "waiting on a running command is not stuck");
        foldProgress(state, result("t", "bash", 40_100));
        assert.equal(stuckAge(state, 41_000), 41_000 - 40_000, "only time outside the tool call counts");
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

    it("renders the reason for every surface", () => {
        assert.equal(describeTiming({ startedAt: 0, timing: { graceMs: 0 } }), undefined, "limits alone are not news");
        assert.equal(describeTiming({ startedAt: 0, status: "killed", timing: { deadlineAt: 30 * MIN, graceMs: 5 * MIN, steerRequestedAt: 1, stopReason: "deadline" } }).short, "stopped: deadline");
        assert.equal(describeTiming({ startedAt: 0, status: "running", timing: { deadlineAt: 30 * MIN, graceMs: 5 * MIN, steerRequestedAt: 1 } }).short, "deadline: wrapping up");
        assert.equal(describeTiming({ startedAt: 0, status: "completed", timing: { deadlineAt: 30 * MIN, graceMs: 5 * MIN, steerRequestedAt: 1 } }).short, "deadline: finished in grace");
        assert.equal(describeTiming({ startedAt: 0, status: "killed", timing: { ceilingAt: 90 * MIN, graceMs: 0, stopReason: "ceiling" } }).short, "stopped: ceiling");
        assert.equal(describeTiming({ startedAt: 0, timing: { graceMs: 0, stuckMs: MIN, stuckWakeSentAt: 5, stuckAnchorAt: 3 } }).reason, "stuck");
        assert.equal(describeTiming({ startedAt: 0, timing: { graceMs: 0, stuckMs: MIN, stuckWakeSentAt: 5, stuckAnchorAt: 3, lastProgressAt: 9 } }), undefined, "progress since the wake clears it");
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
        const writes = [];
        const originalWrite = process.stdout.write;
        mock.timers.enable({ apis: ["setInterval"] });
        let idle = true;
        try {
            childSteer({ on: (event, fn) => handlers.set(event, fn), sendUserMessage: (text, options) => sent.push({ text, options }) });
            handlers.get("session_start")({}, { isIdle: () => idle });
            process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
            mock.timers.tick(2_000);
            assert.equal(sent.length, 0, "no request yet");
            writeFileSync(path, JSON.stringify({ id: "deadline:sa_x_1", text: "wrap up" }));
            mock.timers.tick(2_000);
            assert.equal(sent.length, 0, "an idle child is not prompted");
            idle = false;
            mock.timers.tick(2_000);
            mock.timers.tick(2_000);
            assert.deepEqual(sent, [{ text: "wrap up", options: { deliverAs: "steer" } }]);
            assert.equal(writes.filter((line) => line.includes('"subagent_steer_delivered"')).length, 1);
            handlers.get("session_shutdown")({}, {});
        } finally {
            process.stdout.write = originalWrite;
            mock.timers.reset();
            if (previous === undefined) delete process.env[STEER_FILE_ENV];
            else process.env[STEER_FILE_ENV] = previous;
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
