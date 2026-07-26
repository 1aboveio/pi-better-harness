/**
 * Unit tests for issue #44 — durable navigator visibility + shared stop.
 *
 * Pins:
 * - AC1: RunMeta supports an optional durable `dismissedAt` timestamp; existing
 *   metadata without the field keeps parsing (no migration).
 * - AC2/AC3: visible navigator runs = current-parent runs that are not
 *   dismissed; the footer count is the same set's size.
 * - AC4: dismissed runs remain accessible by ID through the REGISTERED
 *   model-facing tool handlers (subagent_output / subagent_result /
 *   subagent_stop) — the exact execute functions pi registration uses.
 * - AC5: the registered subagent_list handler still returns dismissed runs.
 * - AC6/AC7: stopRun is the shared stop path — it rereads meta + effective
 *   status before acting, so stale state never causes a wrong termination.
 *
 * // @covers registry.dismissal
 * // @level unit
 * // @covers registry.navigator-visibility
 * // @level unit
 * // @covers stop.shared
 * // @level unit
 * // @covers tools.model-facing
 * // @level unit
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import {
    readMeta,
    writeMeta,
    listMetas,
    dismissRun,
    isDismissed,
    navigatorVisibleRuns,
    navigatorVisibleCount,
    runDir,
} from "../registry.ts";
import { stopRun } from "../stop.ts";
import { processExists } from "../spawn.ts";
import {
    subagentListTool,
    subagentOutputTool,
    subagentResultTool,
    subagentStopTool,
} from "../tools.ts";

const THIS_PID = process.pid;
const FOREIGN_PID = THIS_PID + 1;

/** Unique on-disk test ids; cleaned up in `after` so the real tmpdir registry
 *  is left as we found it. */
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
    return {
        id: overrides.id ?? `sa_t44_${n}`,
        status: "completed",
        pid: 0,
        spawnPid: THIS_PID,
        cwd: "/tmp",
        promptPreview: "p",
        startedAt: 1,
        logPath: "/tmp/x.log",
        sessionId: "s",
        ...overrides,
    };
}

/** Spawn a real, detached, long-lived external process for stop tests. */
function spawnSleeper() {
    const proc = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    proc.unref();
    return proc.pid;
}

/** Poll `pred` until true or the deadline passes (bounded, not a fixed sleep). */
async function waitFor(pred, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (pred()) return true;
        await new Promise((r) => setTimeout(r, 20));
    }
    return pred();
}

// ---------------------------------------------------------------------------
// AC1 — durable dismissal timestamp, backward compatible
// ---------------------------------------------------------------------------
describe("registry dismissal durability", () => {
    // @covers registry.dismissal
    // @level unit
    it("metadata without dismissedAt parses unchanged (no migration needed)", () => {
        const id = trackDisk(`sa_t44_legacy_${Date.now()}`);
        const m = meta({ id });
        // Serialized exactly like a pre-#44 record: no dismissedAt key at all.
        writeMeta(m);
        const back = readMeta(id);
        assert.equal(back.id, id);
        assert.equal(back.dismissedAt, undefined);
        assert.equal(isDismissed(back), false);
    });

    // @covers registry.dismissal
    // @level unit
    it("dismissRun persists a dismissedAt timestamp that survives re-read", () => {
        const id = trackDisk(`sa_t44_dismiss_${Date.now()}`);
        writeMeta(meta({ id }));
        const at = 1720000000000;
        const dismissed = dismissRun(id, at);
        assert.equal(dismissed.dismissedAt, at);
        const back = readMeta(id);
        assert.equal(back.dismissedAt, at);
        assert.equal(isDismissed(back), true);
        // Dismissal changes only the timestamp; everything else is preserved.
        assert.equal(back.status, "completed");
        assert.equal(back.promptPreview, "p");
        assert.equal(back.logPath, "/tmp/x.log");
        assert.equal(back.sessionId, "s");
    });

    // @covers registry.dismissal
    // @level unit
    it("dismissRun is idempotent and returns undefined for unknown ids", () => {
        const id = trackDisk(`sa_t44_dismiss2_${Date.now()}`);
        writeMeta(meta({ id }));
        dismissRun(id, 111);
        const again = dismissRun(id, 222);
        assert.equal(again.dismissedAt, 111, "second dismiss must not move the timestamp");
        assert.equal(dismissRun("sa_t44_no_such_run"), undefined);
    });
});

// ---------------------------------------------------------------------------
// AC2/AC3 — visible navigator runs + footer count seam
// ---------------------------------------------------------------------------
describe("navigator visibility", () => {
    // @covers registry.navigator-visibility
    // @level unit
    it("visible runs are current-parent runs that are not dismissed", () => {
        const metas = [
            meta({ id: "own_running", status: "running" }),
            meta({ id: "own_done" }),
            meta({ id: "own_dismissed", dismissedAt: 123 }),
            meta({ id: "foreign", spawnPid: FOREIGN_PID }),
            meta({ id: "foreign_dismissed", spawnPid: FOREIGN_PID, dismissedAt: 123 }),
        ];
        const visible = navigatorVisibleRuns(metas, THIS_PID);
        assert.deepEqual(visible.map((m) => m.id), ["own_running", "own_done"]);
    });

    // @covers registry.navigator-visibility
    // @level unit
    it("footer count is the visible-run count and drops when a run is dismissed", () => {
        const metas = [meta({ id: "a" }), meta({ id: "b" }), meta({ id: "c", spawnPid: FOREIGN_PID })];
        assert.equal(navigatorVisibleCount(metas, THIS_PID), 2);
        const afterDismiss = metas.map((m) => (m.id === "a" ? { ...m, dismissedAt: 1 } : m));
        assert.equal(navigatorVisibleCount(afterDismiss, THIS_PID), 1);
        const allDismissed = afterDismiss.map((m) => ({ ...m, dismissedAt: 1 }));
        assert.equal(navigatorVisibleCount(allDismissed, THIS_PID), 0);
    });

    // @covers registry.navigator-visibility
    // @level unit
    it("dismissal state persists across re-read (reload durability)", () => {
        const id = trackDisk(`sa_t44_reload_${Date.now()}`);
        writeMeta(meta({ id }));
        dismissRun(id);
        // Simulate a /reload: fresh read from disk, then recompute visibility.
        const metas = [readMeta(id), meta({ id: "other" })];
        assert.deepEqual(navigatorVisibleRuns(metas, THIS_PID).map((m) => m.id), ["other"]);
    });
});

// ---------------------------------------------------------------------------
// AC4/AC5 — dismissed-run compatibility through the REGISTERED model-facing
// tool handlers. These tests invoke the exact execute functions that index.ts
// passes to pi.registerTool (built by the factories in tools.ts), so a
// handler-level dismissal filter would fail here, not just at the registry.
// ---------------------------------------------------------------------------

/**
 * Stub for @earendil-works/pi-ai's Type. The parameters schema is inert data
 * as far as the handler is concerned — the stub keeps tools.ts loadable
 * without the pi runtime package installed. Registration in index.ts passes
 * the real Type; the execute function under test is identical either way.
 */
const TypeStub = {
    Object: (v) => v,
    String: (v) => v,
    Number: (v) => v,
    Boolean: (v) => v,
    Array: (v) => v,
    Optional: (v) => v,
};

/** The registered tool definitions, built the same way index.ts builds them. */
function registeredTools() {
    const stoppedNotifications = [];
    return {
        list: subagentListTool(TypeStub),
        output: subagentOutputTool(TypeStub),
        result: subagentResultTool(TypeStub),
        stop: subagentStopTool(TypeStub, { onStopped: () => stoppedNotifications.push(true) }),
        stoppedNotifications,
    };
}

/** Tool results use pi's { content: [{ type: "text", text }] } shape. */
function resultText(result) {
    return result.content[0].text;
}

describe("dismissed-run model-facing tool compatibility", () => {
    // @covers tools.model-facing
    // @covers registry.dismissal
    // @level unit
    it("registered subagent_list handler still lists a dismissed run", async () => {
        const id = trackDisk(`sa_t44_hlist_${Date.now()}`);
        writeMeta(meta({ id }));
        dismissRun(id);
        const tools = registeredTools();
        const out = resultText(await tools.list.execute("tc", {}));
        assert.ok(out.includes(id), `subagent_list output must include the dismissed run; got:\n${out}`);
    });

    // @covers tools.model-facing
    // @covers registry.dismissal
    // @level unit
    it("registered subagent_output handler resolves a dismissed run by id", async () => {
        const id = trackDisk(`sa_t44_hout_${Date.now()}`);
        writeMeta(meta({ id }));
        dismissRun(id);
        const tools = registeredTools();
        const out = resultText(await tools.output.execute("tc", { id }));
        assert.ok(out.startsWith(`[${id} · completed`), `subagent_output must head with the run id + status; got:\n${out}`);
    });

    // @covers tools.model-facing
    // @covers registry.dismissal
    // @level unit
    it("registered subagent_result handler returns a finished dismissed run's result", async () => {
        const id = trackDisk(`sa_t44_hres_${Date.now()}`);
        writeMeta(meta({ id, exitCode: 0 }));
        dismissRun(id);
        const tools = registeredTools();
        const out = resultText(await tools.result.execute("tc", { id }));
        assert.ok(out.startsWith(`[${id} · completed · exit 0`), `subagent_result must head with id + status + exit; got:\n${out}`);
    });

    // @covers tools.model-facing
    // @covers registry.dismissal
    // @level unit
    it("registered subagent_result handler reports a dismissed still-running run without erroring", async () => {
        const id = trackDisk(`sa_t44_hrun_${Date.now()}`);
        // pid = this test process: alive, so effective status stays "running".
        writeMeta(meta({ id, status: "running", pid: THIS_PID }));
        dismissRun(id);
        const tools = registeredTools();
        const out = resultText(await tools.result.execute("tc", { id }));
        assert.ok(out.includes("still running"), `expected the non-blocking still-running reply; got:\n${out}`);
    });

    // @covers tools.model-facing
    // @covers stop.shared
    // @covers registry.dismissal
    // @level unit
    it("registered subagent_stop handler stops a dismissed run (dismissal is not deletion)", async () => {
        const id = trackDisk(`sa_t44_hstop_${Date.now()}`);
        const pid = spawnSleeper();
        writeMeta(meta({ id, status: "running", pid }));
        dismissRun(id);
        const tools = registeredTools();
        const out = resultText(await tools.stop.execute("tc", { id }));
        assert.ok(out.includes(`Stopped subagent ${id}`), `expected the stop confirmation; got:\n${out}`);
        assert.equal(tools.stoppedNotifications.length, 1, "stop handler must fire its onStopped UI callback");
        const back = readMeta(id);
        assert.equal(back.status, "killed");
        assert.equal(isDismissed(back), true, "dismissal survives the stop");
        assert.equal(await waitFor(() => !processExists(pid)), true, "process group must be gone");
    });

    // @covers tools.model-facing
    // @level unit
    it("registered output/result handlers throw Unknown run id for missing ids", async () => {
        const tools = registeredTools();
        await assert.rejects(() => tools.output.execute("tc", { id: "sa_t44_missing" }), /Unknown run id/);
        await assert.rejects(() => tools.result.execute("tc", { id: "sa_t44_missing" }), /Unknown run id/);
    });

    // @covers registry.dismissal
    // @level unit
    it("registry pin: readMeta/listMetas still resolve dismissed runs (what the handlers read)", () => {
        const id = trackDisk(`sa_t44_recover_${Date.now()}`);
        writeMeta(meta({ id }));
        dismissRun(id);
        const back = readMeta(id);
        assert.ok(back, "dismissed run must remain readable by id");
        assert.equal(isDismissed(back), true);
        const listed = listMetas().find((m) => m.id === id);
        assert.ok(listed, "dismissed run must not be hidden from listMetas");
        assert.equal(isDismissed(listed), true);
    });
});

// ---------------------------------------------------------------------------
// AC6/AC7 — shared stop semantics
// ---------------------------------------------------------------------------
describe("shared stop behavior", () => {
    // @covers stop.shared
    // @level unit
    it("stops a live run: SIGTERM to the process group, status killed, endedAt set", async () => {
        const id = trackDisk(`sa_t44_stop_${Date.now()}`);
        const pid = spawnSleeper();
        writeMeta(meta({ id, status: "running", pid }));
        const outcome = stopRun(id);
        assert.equal(outcome.action, "stopped");
        const back = readMeta(id);
        assert.equal(back.status, "killed");
        assert.equal(typeof back.endedAt, "number");
        assert.equal(await waitFor(() => !processExists(pid)), true, "process group must be gone");
    });

    // @covers stop.shared
    // @level unit
    it("rereads effective status: a stale 'running' meta with a dead pid is NOT terminated", () => {
        const id = trackDisk(`sa_t44_stale_${Date.now()}`);
        // Status says running, but no such process exists → effective "exited".
        writeMeta(meta({ id, status: "running", pid: 0x3fffffff }));
        const outcome = stopRun(id);
        assert.equal(outcome.action, "not-running");
        assert.equal(outcome.status, "exited");
        // The on-disk record is left untouched — no bogus killed rewrite.
        assert.equal(readMeta(id).status, "running");
    });

    // @covers stop.shared
    // @level unit
    it("refuses terminal runs without touching them", () => {
        const id = trackDisk(`sa_t44_term_${Date.now()}`);
        writeMeta(meta({ id, status: "completed", endedAt: 5 }));
        const outcome = stopRun(id);
        assert.equal(outcome.action, "not-running");
        assert.equal(outcome.status, "completed");
        assert.equal(readMeta(id).status, "completed");
    });

    // @covers stop.shared
    // @level unit
    it("throws for an unknown run id (same contract as the stop tool)", () => {
        assert.throws(() => stopRun("sa_t44_missing"), /Unknown run id/);
    });

    // @covers stop.shared
    // @covers registry.dismissal
    // @level unit
    it("a dismissed run is still stoppable by id (dismissal is not deletion)", async () => {
        const id = trackDisk(`sa_t44_dst_${Date.now()}`);
        const pid = spawnSleeper();
        writeMeta(meta({ id, status: "running", pid }));
        dismissRun(id);
        const outcome = stopRun(id);
        assert.equal(outcome.action, "stopped");
        const back = readMeta(id);
        assert.equal(back.status, "killed");
        assert.equal(isDismissed(back), true, "dismissal survives the stop");
        assert.equal(await waitFor(() => !processExists(pid)), true);
    });
});
