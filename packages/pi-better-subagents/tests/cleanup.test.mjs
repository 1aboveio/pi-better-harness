import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNTIME = mkdtempSync(join(tmpdir(), "subagent-cleanup-"));
process.env.TMPDIR = RUNTIME;

const {
    cleanupStatePath,
    runDailyCleanupOnce,
} = await import("../cleanup.ts");
const {
    baseDir,
    logPathFor,
    runDir,
    sessionsDir,
    writeMeta,
} = await import("../registry.ts");

const DAY = new Date("2026-07-30T12:00:00").getTime();
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION = 7 * DAY_MS;

after(() => {
    rmSync(RUNTIME, { recursive: true, force: true });
});

function meta(id, overrides = {}) {
    return {
        id,
        status: "completed",
        pid: 0,
        spawnPid: process.pid,
        cwd: RUNTIME,
        promptPreview: "cleanup fixture",
        startedAt: DAY - 10 * DAY_MS,
        endedAt: DAY - 9 * DAY_MS,
        logPath: logPathFor(id),
        sessionId: id,
        ...overrides,
    };
}

function writeSessionFile(name, mtimeMs) {
    mkdirSync(sessionsDir(), { recursive: true });
    const path = join(sessionsDir(), name);
    writeFileSync(path, "session\n");
    const seconds = mtimeMs / 1000;
    utimesSync(path, seconds, seconds);
    return path;
}

describe("daily cleanup", () => {
    it("runs at most once per local day and removes only old terminal tmp artifacts", () => {
        rmSync(baseDir(), { recursive: true, force: true });

        const oldDone = "sa_cleanup_old_done";
        const recentDone = "sa_cleanup_recent_done";
        const oldRunning = "sa_cleanup_old_running";
        writeMeta(meta(oldDone));
        writeFileSync(logPathFor(oldDone), "old terminal log\n");
        writeMeta(meta(recentDone, { startedAt: DAY - DAY_MS, endedAt: DAY - DAY_MS }));
        writeFileSync(logPathFor(recentDone), "recent terminal log\n");
        writeMeta(meta(oldRunning, { status: "running", endedAt: undefined, sessionId: "active-session" }));
        writeFileSync(logPathFor(oldRunning), "active log\n");

        const oldSession = writeSessionFile("old-child-session.jsonl", DAY - 9 * DAY_MS);
        const recentSession = writeSessionFile("recent-child-session.jsonl", DAY - DAY_MS);
        const activeSession = writeSessionFile("active-session.jsonl", DAY - 9 * DAY_MS);

        const first = runDailyCleanupOnce({
            now: DAY,
            terminalRunRetentionMs: RETENTION,
            sessionRetentionMs: RETENTION,
        });
        assert.equal(first.ran, true);
        assert.equal(first.errors.length, 0);
        assert.equal(existsSync(runDir(oldDone)), false, "old terminal run dir is pruned");
        assert.equal(existsSync(runDir(recentDone)), true, "recent terminal run dir is retained");
        assert.equal(existsSync(runDir(oldRunning)), true, "running run dir is retained even when old");
        assert.equal(existsSync(oldSession), false, "old child session file is pruned");
        assert.equal(existsSync(recentSession), true, "recent child session file is retained");
        assert.equal(existsSync(activeSession), true, "active session file is retained even when old");
        assert.equal(existsSync(cleanupStatePath()), true, "daily marker is written");

        const secondOld = "sa_cleanup_second_old";
        writeMeta(meta(secondOld));
        const skipped = runDailyCleanupOnce({
            now: DAY + 60_000,
            terminalRunRetentionMs: RETENTION,
            sessionRetentionMs: RETENTION,
        });
        assert.equal(skipped.ran, false, "same local day skips cleanup");
        assert.equal(existsSync(runDir(secondOld)), true, "same-day cleanup does not rerun");

        const next = runDailyCleanupOnce({
            now: DAY + DAY_MS,
            terminalRunRetentionMs: RETENTION,
            sessionRetentionMs: RETENTION,
        });
        assert.equal(next.ran, true, "next local day runs cleanup again");
        assert.equal(existsSync(runDir(secondOld)), false, "next-day cleanup prunes old terminal artifacts");
    });
});
