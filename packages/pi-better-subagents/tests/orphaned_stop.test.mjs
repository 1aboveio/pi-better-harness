/**
 * Unit tests for issue #68 — orphaned stop / close cleanup.
 *
 * Pins:
 * - subagent_stop / stopRun accept orphaned runs with identifiable process-group work.
 * - Stopping an orphaned run terminates the related process group and records killed.
 * - When no related process remains, logs are reread before choosing final status.
 * - Coherent terminal evidence → completed / failed; none → lost.
 * - Cleanup shares kill/killed semantics with the normal running stop path.
 * - TUI Close for orphaned uses the same path and does not dismiss until terminal.
 * - ADR 0002: no descendant-tree crawling — related work is process-group only.
 *
 * // @covers stop.orphaned-cleanup
 * // @covers navigator.close
 * // @level unit
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
    writeMeta,
    readMeta,
    effectiveStatus,
    dismissRun,
    isDismissed,
    runDir,
    logPathFor,
} from "../registry.ts";
import {
    stopRun,
    relatedProcessGroupId,
    isStoppableStatus,
} from "../stop.ts";
import { processExists } from "../spawn.ts";
import {
    closeConfirmHint,
    executeNavigatorClose,
} from "../navigator.ts";
import {
    subagentStopTool,
    subagentResultTool,
} from "../tools.ts";

const THIS_PID = process.pid;
const diskIds = [];
function trackDisk(id) {
    diskIds.push(id);
    return id;
}
after(() => {
    for (const id of diskIds) {
        try { rmSync(runDir(id), { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

let n = 0;
function meta(overrides = {}) {
    n += 1;
    const id = overrides.id ?? `sa_t68_${n}`;
    return {
        id,
        status: "orphaned",
        pid: 0,
        spawnPid: THIS_PID,
        cwd: "/tmp",
        promptPreview: "p",
        startedAt: Date.now() - 60_000,
        orphanedAt: Date.now() - 30_000,
        logPath: logPathFor(id),
        sessionId: "s68",
        ...overrides,
    };
}

function writeLog(id, events) {
    mkdirSync(runDir(id), { recursive: true });
    writeFileSync(
        logPathFor(id),
        `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
    );
}

function coherentTerminalEvents() {
    return [
        {
            type: "message_update",
            message: {
                role: "assistant",
                content: [{ type: "text", text: "done-from-orphan" }],
            },
        },
        { type: "agent_end" },
    ];
}

function incompleteOpenToolEvents() {
    return [
        {
            type: "tool_execution_start",
            toolCallId: "tc_open",
            toolName: "bash",
        },
        { type: "agent_end" },
    ];
}

/** Detached sleeper that is its own process-group leader (pgid == pid). */
function spawnGroupLeader(seconds = 30) {
    const proc = spawn("sleep", [String(seconds)], { detached: true, stdio: "ignore" });
    proc.unref();
    return proc.pid;
}

/**
 * Leader + child that share the leader's process group (true group members,
 * not escaped descendants). Covers "orphaned stop with process group" and
 * "related members beyond the leader pid" under ADR 0002.
 */
function spawnGroupWithMember(seconds = 30) {
    const proc = spawn(
        "bash",
        ["-c", `sleep ${seconds} & wait`],
        { detached: true, stdio: "ignore" },
    );
    proc.unref();
    return proc.pid;
}

async function waitFor(pred, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (pred()) return true;
        await new Promise((r) => setTimeout(r, 20));
    }
    return pred();
}

const TypeStub = {
    Object: (v) => v,
    String: (v) => v,
    Number: (v) => v,
    Boolean: (v) => v,
    Array: (v) => v,
    Optional: (v) => v,
};

function resultText(result) {
    return result.content[0].text;
}

/** Probe that only knows about process-group liveness we inject. */
function fakeProbe({ aliveGroups = new Set(), pidAlive = new Set() } = {}) {
    return {
        pidExists: (pid) => pidAlive.has(pid),
        startToken: () => undefined,
        groupId: (pid) => (pidAlive.has(pid) ? pid : undefined),
        groupAlive: (pgid) => aliveGroups.has(pgid),
    };
}

// ---------------------------------------------------------------------------
// Helpers / contracts
// ---------------------------------------------------------------------------
describe("orphaned stop contracts", () => {
    // @covers stop.orphaned-cleanup
    // @level unit
    it("isStoppableStatus accepts running and orphaned only", () => {
        assert.equal(isStoppableStatus("running"), true);
        assert.equal(isStoppableStatus("orphaned"), true);
        assert.equal(isStoppableStatus("lost"), false);
        assert.equal(isStoppableStatus("completed"), false);
        assert.equal(isStoppableStatus("killed"), false);
        assert.equal(isStoppableStatus("exited"), false);
    });

    // @covers stop.orphaned-cleanup
    // @level unit
    it("relatedProcessGroupId prefers pgid and falls back to pid (ADR 0002)", () => {
        assert.equal(relatedProcessGroupId({ pid: 10, pgid: 99 }), 99);
        assert.equal(relatedProcessGroupId({ pid: 10 }), 10);
        assert.equal(relatedProcessGroupId({ pid: 0 }), undefined);
    });
});

// ---------------------------------------------------------------------------
// Orphaned stop with live process group
// ---------------------------------------------------------------------------
describe("orphaned stop with process group", () => {
    // @covers stop.orphaned-cleanup
    // @level unit
    it("accepts orphaned runs and kills the recorded process group → durable killed", async () => {
        const id = trackDisk(`sa_t68_pg_${Date.now()}`);
        const pid = spawnGroupLeader();
        // Record a synthetic leader pid that is gone, but the real group (pgid)
        // still has the sleeper — classic orphaned shape.
        writeMeta(meta({
            id,
            status: "orphaned",
            pid: 0x3ffffffe, // not the live sleeper
            pgid: pid,
            pidStartTime: "token-old",
        }));
        writeLog(id, [{ type: "message_update", message: { role: "assistant", content: "partial" } }]);

        const outcome = stopRun(id);
        assert.equal(outcome.action, "stopped");
        const back = readMeta(id);
        assert.equal(back.status, "killed");
        assert.equal(back.lifecycleClassification, "killed");
        assert.equal(typeof back.endedAt, "number");
        assert.equal(await waitFor(() => !processExists(pid)), true, "process group member must be gone");
    });

    // @covers stop.orphaned-cleanup
    // @level unit
    it("orphaned stop with additional process-group members (group-mate, not escaped descendant)", async () => {
        // ADR 0002: related work is the process group. A bash leader that
        // backgrounds `sleep` keeps the sleeper in the same group — that is
        // identifiable related work. Escaped/reparented descendants are out
        // of contract and are not claimed here.
        const id = trackDisk(`sa_t68_members_${Date.now()}`);
        const leaderPid = spawnGroupWithMember();
        writeMeta(meta({
            id,
            status: "orphaned",
            // Leader may still be alive; mark status orphaned to exercise the
            // orphaned branch while the group is live.
            pid: leaderPid,
            pgid: leaderPid,
        }));
        writeLog(id, []);

        const outcome = stopRun(id);
        assert.equal(outcome.action, "stopped");
        assert.equal(readMeta(id).status, "killed");
        assert.equal(
            await waitFor(() => !processExists(leaderPid)),
            true,
            "group leader and group-mates must be terminated",
        );
    });

    // @covers stop.orphaned-cleanup
    // @level unit
    it("uses injected probe for group liveness (no OS dependency)", () => {
        const id = trackDisk(`sa_t68_probe_${Date.now()}`);
        writeMeta(meta({ id, status: "orphaned", pid: 111, pgid: 222 }));
        writeLog(id, []);
        const probe = fakeProbe({ aliveGroups: new Set([222]) });
        const outcome = stopRun(id, { probe, now: () => 9_000 });
        assert.equal(outcome.action, "stopped");
        assert.equal(readMeta(id).status, "killed");
        assert.equal(readMeta(id).endedAt, 9_000);
    });
});

// ---------------------------------------------------------------------------
// Orphaned cleanup without related process — log evidence
// ---------------------------------------------------------------------------
describe("orphaned cleanup with terminal evidence", () => {
    // @covers stop.orphaned-cleanup
    // @level unit
    it("rereads logs and finalizes completed when coherent terminal evidence exists", () => {
        const id = trackDisk(`sa_t68_done_${Date.now()}`);
        writeMeta(meta({ id, status: "orphaned", pid: 0x3ffffff0, pgid: 0x3ffffff0 }));
        writeLog(id, coherentTerminalEvents());
        const probe = fakeProbe({ aliveGroups: new Set() });

        const outcome = stopRun(id, { probe, now: () => 11_000 });
        assert.equal(outcome.action, "finalized");
        assert.equal(outcome.status, "completed");
        const back = readMeta(id);
        assert.equal(back.status, "completed");
        assert.equal(back.lifecycleClassification, "complete");
        assert.equal(back.endedAt, 11_000);
        assert.equal(back.exitCode, 0);
    });

    // @covers stop.orphaned-cleanup
    // @level unit
    it("finalizes failed when terminal event exists with unmatched open tools", () => {
        const id = trackDisk(`sa_t68_fail_${Date.now()}`);
        writeMeta(meta({ id, status: "orphaned", pid: 0x3ffffff1, pgid: 0x3ffffff1 }));
        writeLog(id, incompleteOpenToolEvents());
        const probe = fakeProbe();

        const outcome = stopRun(id, { probe, now: () => 12_000 });
        assert.equal(outcome.action, "finalized");
        assert.equal(outcome.status, "failed");
        const back = readMeta(id);
        assert.equal(back.status, "failed");
        assert.equal(back.lifecycleClassification, "incomplete_open_tools");
        assert.equal(back.failureReason, "incomplete-stream");
        assert.equal(back.endedAt, 12_000);
    });
});

describe("orphaned cleanup to lost", () => {
    // @covers stop.orphaned-cleanup
    // @level unit
    it("records lost when no related process and no coherent terminal evidence", () => {
        const id = trackDisk(`sa_t68_lost_${Date.now()}`);
        writeMeta(meta({ id, status: "orphaned", pid: 0x3ffffff2, pgid: 0x3ffffff2 }));
        // Partial activity, no agent_end / agent_settled.
        writeLog(id, [
            {
                type: "message_update",
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "still thinking" }],
                },
            },
        ]);
        const probe = fakeProbe();

        const outcome = stopRun(id, { probe, now: () => 13_000 });
        assert.equal(outcome.action, "finalized");
        assert.equal(outcome.status, "lost");
        const back = readMeta(id);
        assert.equal(back.status, "lost");
        assert.equal(back.lifecycleClassification, "lost");
        assert.equal(back.lostAt, 13_000);
        assert.equal(back.endedAt, 13_000);
    });

    // @covers stop.orphaned-cleanup
    // @level unit
    it("empty log with no process evidence becomes lost (reread before decide)", () => {
        const id = trackDisk(`sa_t68_empty_${Date.now()}`);
        writeMeta(meta({ id, status: "orphaned", pid: 55, pgid: 55 }));
        writeLog(id, []);
        const outcome = stopRun(id, { probe: fakeProbe(), now: () => 14_000 });
        assert.deepEqual(outcome, { action: "finalized", id, status: "lost" });
        assert.equal(readMeta(id).status, "lost");
    });
});

// ---------------------------------------------------------------------------
// Compatibility with normal running stop
// ---------------------------------------------------------------------------
describe("compatibility with normal running stop", () => {
    // @covers stop.orphaned-cleanup
    // @covers stop.shared
    // @level unit
    it("running stop still SIGTERMs the process group and records killed", async () => {
        const id = trackDisk(`sa_t68_run_${Date.now()}`);
        const pid = spawnGroupLeader();
        writeMeta(meta({ id, status: "running", pid, pgid: pid, orphanedAt: undefined }));
        writeLog(id, []);

        const outcome = stopRun(id);
        assert.equal(outcome.action, "stopped");
        assert.equal(readMeta(id).status, "killed");
        assert.equal(readMeta(id).lifecycleClassification, "killed");
        assert.equal(await waitFor(() => !processExists(pid)), true);
    });

    // @covers stop.orphaned-cleanup
    // @level unit
    it("terminal runs remain not-running and untouched", () => {
        const id = trackDisk(`sa_t68_term_${Date.now()}`);
        writeMeta(meta({ id, status: "completed", endedAt: 5, orphanedAt: undefined }));
        const outcome = stopRun(id);
        assert.equal(outcome.action, "not-running");
        assert.equal(outcome.status, "completed");
        assert.equal(readMeta(id).status, "completed");
        assert.equal(readMeta(id).endedAt, 5);
    });

    // @covers stop.orphaned-cleanup
    // @level unit
    it("lost runs are not re-stopped", () => {
        const id = trackDisk(`sa_t68_loststay_${Date.now()}`);
        writeMeta(meta({
            id,
            status: "lost",
            lostAt: 8,
            endedAt: 8,
            lifecycleClassification: "lost",
        }));
        const outcome = stopRun(id);
        assert.equal(outcome.action, "not-running");
        assert.equal(outcome.status, "lost");
        assert.equal(readMeta(id).status, "lost");
    });
});

// ---------------------------------------------------------------------------
// Model-facing tool
// ---------------------------------------------------------------------------
describe("subagent_stop tool accepts orphaned", () => {
    // @covers stop.orphaned-cleanup
    // @covers tools.model-facing
    // @level unit
    it("tool stops orphaned with live group and reports Stopped", async () => {
        const id = trackDisk(`sa_t68_tool_pg_${Date.now()}`);
        const pid = spawnGroupLeader();
        writeMeta(meta({ id, status: "orphaned", pid: 0x3ffffff3, pgid: pid }));
        writeLog(id, []);
        let redraws = 0;
        const tool = subagentStopTool(TypeStub, { onStopped: () => { redraws += 1; } });
        const out = resultText(await tool.execute("tc", { id }));
        assert.match(out, new RegExp(`Stopped subagent ${id}`));
        assert.equal(readMeta(id).status, "killed");
        assert.equal(redraws, 1);
        assert.equal(await waitFor(() => !processExists(pid)), true);
    });

    // @covers stop.orphaned-cleanup
    // @level unit
    it("tool finalizes orphaned-without-process to lost and reports Resolved", async () => {
        const id = trackDisk(`sa_t68_tool_lost_${Date.now()}`);
        writeMeta(meta({ id, status: "orphaned", pid: 0x3ffffff4, pgid: 0x3ffffff4 }));
        writeLog(id, []);
        // Real probe: these pids are not alive → cleanup → lost.
        const tool = subagentStopTool(TypeStub);
        const out = resultText(await tool.execute("tc", { id }));
        assert.match(out, new RegExp(`Resolved orphaned subagent ${id} → lost`));
        assert.equal(readMeta(id).status, "lost");
    });

    // @covers stop.orphaned-cleanup
    // @level unit
    it("after orphaned cleanup to completed, subagent_result returns a final body", async () => {
        const id = trackDisk(`sa_t68_tool_result_${Date.now()}`);
        writeMeta(meta({ id, status: "orphaned", pid: 0x3ffffff5, pgid: 0x3ffffff5 }));
        writeLog(id, coherentTerminalEvents());
        stopRun(id, { probe: fakeProbe() });
        assert.equal(readMeta(id).status, "completed");
        const resultTool = subagentResultTool(TypeStub);
        const out = resultText(await resultTool.execute("tc", { id }));
        assert.match(out, /completed/i);
        assert.match(out, /done-from-orphan/);
        assert.doesNotMatch(out, /non-final/i);
    });
});

// ---------------------------------------------------------------------------
// TUI Close integration
// ---------------------------------------------------------------------------
describe("TUI Close for orphaned runs", () => {
    // @covers navigator.close
    // @level unit
    it("closeConfirmHint treats orphaned like stoppable (stop wording)", () => {
        assert.equal(
            closeConfirmHint({ id: "sa_o", name: "worker", status: "orphaned" }),
            "x again to stop worker",
        );
        assert.equal(
            closeConfirmHint({ id: "sa_r", name: "worker", status: "running" }),
            "x again to stop worker",
        );
        assert.equal(
            closeConfirmHint({ id: "sa_l", name: "worker", status: "lost" }),
            "x again to dismiss worker",
        );
    });

    // @covers navigator.close
    // @covers stop.orphaned-cleanup
    // @level unit
    it("Close stops orphaned with live group, writes killed, then dismisses", async () => {
        const id = trackDisk(`sa_t68_close_pg_${Date.now()}`);
        const pid = spawnGroupLeader();
        writeMeta(meta({ id, name: "orphan-worker", status: "orphaned", pid: 0x3ffffff6, pgid: pid }));
        writeLog(id, []);

        const outcome = executeNavigatorClose(id, {
            readMeta,
            effectiveStatus,
            stopRun,
            dismissRun,
            now: () => 20_000,
        });
        assert.equal(outcome.action, "stopped-and-dismissed");
        assert.equal(outcome.status, "killed");
        const back = readMeta(id);
        assert.equal(back.status, "killed", "terminal status written before dismiss");
        assert.equal(back.dismissedAt, 20_000);
        assert.equal(isDismissed(back), true);
        assert.equal(await waitFor(() => !processExists(pid)), true);
    });

    // @covers navigator.close
    // @covers stop.orphaned-cleanup
    // @level unit
    it("Close finalizes orphaned-without-process to lost then dismisses", () => {
        const id = trackDisk(`sa_t68_close_lost_${Date.now()}`);
        writeMeta(meta({ id, status: "orphaned", pid: 0x3ffffff7, pgid: 0x3ffffff7 }));
        writeLog(id, []);

        const outcome = executeNavigatorClose(id, {
            readMeta,
            effectiveStatus,
            stopRun: (i) => stopRun(i, { probe: fakeProbe(), now: () => 21_000 }),
            dismissRun,
            now: () => 21_500,
        });
        assert.equal(outcome.action, "stopped-and-dismissed");
        assert.equal(outcome.status, "lost");
        const back = readMeta(id);
        assert.equal(back.status, "lost");
        assert.equal(back.dismissedAt, 21_500);
    });

    // @covers navigator.close
    // @covers stop.orphaned-cleanup
    // @level unit
    it("Close finalizes orphaned with coherent terminal evidence to completed then dismisses", () => {
        const id = trackDisk(`sa_t68_close_done_${Date.now()}`);
        writeMeta(meta({ id, status: "orphaned", pid: 0x3ffffff8, pgid: 0x3ffffff8 }));
        writeLog(id, coherentTerminalEvents());

        const outcome = executeNavigatorClose(id, {
            readMeta,
            effectiveStatus,
            stopRun: (i) => stopRun(i, { probe: fakeProbe(), now: () => 22_000 }),
            dismissRun,
            now: () => 22_500,
        });
        assert.equal(outcome.action, "stopped-and-dismissed");
        assert.equal(outcome.status, "completed");
        const back = readMeta(id);
        assert.equal(back.status, "completed");
        assert.equal(back.dismissedAt, 22_500);
    });

    // @covers navigator.close
    // @level unit
    it("Close does not dismiss an orphaned run until stopRun writes a terminal status", () => {
        const id = trackDisk(`sa_t68_close_hold_${Date.now()}`);
        writeMeta(meta({ id, status: "orphaned", pid: 42, pgid: 42 }));
        writeLog(id, []);

        let dismissCalls = 0;
        const outcome = executeNavigatorClose(id, {
            readMeta,
            effectiveStatus,
            // Simulate a stop path that fails to finalize (must not dismiss).
            stopRun: () => ({ action: "not-running", id, status: "orphaned" }),
            dismissRun: (i, at) => {
                dismissCalls += 1;
                return dismissRun(i, at);
            },
            now: () => 23_000,
        });
        assert.equal(outcome.action, "not-closed");
        assert.equal(outcome.status, "orphaned");
        assert.equal(dismissCalls, 0, "must not dismiss while still orphaned");
        assert.equal(readMeta(id).status, "orphaned");
        assert.equal(readMeta(id).dismissedAt, undefined);
    });

    // @covers navigator.close
    // @level unit
    it("running Close path remains stop+dismiss via shared stopRun", async () => {
        const id = trackDisk(`sa_t68_close_run_${Date.now()}`);
        const pid = spawnGroupLeader();
        writeMeta(meta({
            id,
            status: "running",
            pid,
            pgid: pid,
            orphanedAt: undefined,
        }));
        writeLog(id, []);
        const outcome = executeNavigatorClose(id, {
            readMeta,
            effectiveStatus,
            stopRun,
            dismissRun,
            now: () => 24_000,
        });
        assert.equal(outcome.action, "stopped-and-dismissed");
        assert.equal(outcome.status, "killed");
        assert.equal(readMeta(id).status, "killed");
        assert.equal(readMeta(id).dismissedAt, 24_000);
        assert.equal(await waitFor(() => !processExists(pid)), true);
    });
});
