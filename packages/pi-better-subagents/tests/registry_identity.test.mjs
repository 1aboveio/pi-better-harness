/**
 * Unit tests for run-metadata process identity (issue #63).
 *
 * Pins:
 * - new runs persist pgid / pidStartTime in meta.json and read them back
 * - old metadata without the new fields still parses (no migration)
 * - effectiveStatus passes durable orphaned/lost through and still reports a
 *   live pid as running (existing behavior preserved)
 * - isFinalResultStatus: orphaned is non-terminal for result behavior, lost is
 *   terminal like completed/failed/killed
 *
 * // @covers registry.process-identity
 * // @level unit
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import {
    canExitFinalize,
    effectiveStatus,
    isFinalResultStatus,
    nextRunId,
    readMeta,
    runDir,
    writeMeta,
} from "../registry.ts";

describe("run metadata process identity", () => {
    it("round-trips pgid and pidStartTime through meta.json", () => {
        const id = nextRunId();
        const meta = {
            id, status: "running", pid: 43210, spawnPid: 1, cwd: "/tmp",
            promptPreview: "p", startedAt: 1, logPath: `/tmp/${id}.log`, sessionId: id,
            pgid: 43210, pidStartTime: "token-abc",
        };
        try {
            writeMeta(meta);
            const back = readMeta(id);
            assert.equal(back.pgid, 43210);
            assert.equal(back.pidStartTime, "token-abc");
        } finally {
            rmSync(runDir(id), { recursive: true, force: true });
        }
    });

    it("reads old metadata without process identity fields (no migration)", () => {
        const id = nextRunId();
        const oldMeta = {
            id, status: "running", pid: 43210, spawnPid: 1, cwd: "/tmp",
            promptPreview: "p", startedAt: 1, logPath: `/tmp/${id}.log`, sessionId: id,
        };
        try {
            writeMeta(oldMeta);
            const back = readMeta(id);
            assert.equal(back.status, "running");
            assert.equal(back.pgid, undefined);
            assert.equal(back.pidStartTime, undefined);
            assert.equal(back.probeMisses, undefined);
        } finally {
            rmSync(runDir(id), { recursive: true, force: true });
        }
    });
});

describe("effectiveStatus with durable supervision statuses", () => {
    const base = { pid: process.pid, status: "running" };
    it("passes orphaned and lost through untouched", () => {
        assert.equal(effectiveStatus({ ...base, status: "orphaned" }), "orphaned");
        assert.equal(effectiveStatus({ ...base, status: "lost" }), "lost");
        assert.equal(effectiveStatus({ ...base, status: "completed" }), "completed");
    });
    it("still reports a live pid as running", () => {
        assert.equal(effectiveStatus(base), "running");
    });
});

describe("canExitFinalize", () => {
    it("lets coherent child-exit evidence finalize running and provisional orphaned/lost", () => {
        // A health tick can observe the just-exited pid before the close
        // handler runs and persist a provisional orphaned/lost; the real exit
        // is the stronger evidence and must still finalize the run.
        assert.equal(canExitFinalize("running"), true);
        assert.equal(canExitFinalize("orphaned"), true);
        assert.equal(canExitFinalize("lost"), true);
    });
    it("never overwrites a true terminal record", () => {
        // Idempotency (completed/failed) and a deliberate kill (killed) are
        // not undone by a later exit event.
        assert.equal(canExitFinalize("completed"), false);
        assert.equal(canExitFinalize("failed"), false);
        assert.equal(canExitFinalize("killed"), false);
    });
});

describe("isFinalResultStatus", () => {
    it("treats running and orphaned as non-final (no result yet)", () => {
        assert.equal(isFinalResultStatus("running"), false);
        assert.equal(isFinalResultStatus("orphaned"), false);
    });
    it("treats lost as terminal alongside completed/failed/killed/exited", () => {
        assert.equal(isFinalResultStatus("lost"), true);
        assert.equal(isFinalResultStatus("completed"), true);
        assert.equal(isFinalResultStatus("failed"), true);
        assert.equal(isFinalResultStatus("killed"), true);
        assert.equal(isFinalResultStatus("exited"), true);
    });
});
