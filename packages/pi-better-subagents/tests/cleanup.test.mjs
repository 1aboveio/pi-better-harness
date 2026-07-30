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
    DEFAULT_MAX_REGISTRY_BYTES,
    SIZE_SWEEP_INTERVAL_MS,
    cleanupStatePath,
    collectSizeCapEntries,
    enforceRegistrySizeCapOnce,
    planRegistrySizeCap,
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

// ---------------------------------------------------------------------------
// Registry size cap. Age alone could not bound this directory: 63 GB
// accumulated inside five days, so the seven-day window above never saw it.
// ---------------------------------------------------------------------------

function sizeEntry(id, overrides = {}) {
    return { id, status: "completed", endedAt: DAY - DAY_MS, dirMtimeMs: DAY - DAY_MS, bytes: 1000, ...overrides };
}

describe("planRegistrySizeCap", () => {
    it("does nothing while the registry fits", () => {
        const plan = planRegistrySizeCap([sizeEntry("a"), sizeEntry("b")], { maxBytes: 10_000 });
        assert.deepEqual(plan.remove, []);
        assert.equal(plan.keptBytes, 2000);
        assert.equal(plan.overBudget, false);
    });

    it("retires oldest terminal runs until the registry fits", () => {
        const plan = planRegistrySizeCap([
            sizeEntry("newest", { endedAt: DAY - 1 * DAY_MS, bytes: 6000 }),
            sizeEntry("oldest", { endedAt: DAY - 3 * DAY_MS, bytes: 6000 }),
            sizeEntry("middle", { endedAt: DAY - 2 * DAY_MS, bytes: 6000 }),
        ], { maxBytes: 10_000 });
        assert.deepEqual(plan.remove, ["oldest", "middle"], "oldest first");
        assert.equal(plan.reclaimedBytes, 12_000);
        assert.equal(plan.keptBytes, 6000);
    });

    it("never retires a running or orphaned run to meet the cap, and says so", () => {
        for (const status of ["running", "orphaned"]) {
            const plan = planRegistrySizeCap(
                [sizeEntry("live", { status, endedAt: undefined, bytes: 50_000 })],
                { maxBytes: 1000 },
            );
            assert.deepEqual(plan.remove, [], status);
            assert.equal(plan.overBudget, true, `${status}: over budget is reported, not forced`);
        }
    });

    it("never retires a run the calling pi owns", () => {
        // A size sweep goes after the newest large runs, which is exactly the
        // live session's own work — it can still answer subagent_result for them.
        const plan = planRegistrySizeCap([
            sizeEntry("mine", { bytes: 9000 }),
            sizeEntry("theirs", { endedAt: DAY - 5 * DAY_MS, bytes: 9000 }),
        ], { maxBytes: 10_000, protectedIds: new Set(["mine"]) });
        assert.deepEqual(plan.remove, ["theirs"]);
    });

    it("leaves a metadata-less directory to the age sweep", () => {
        // Size is not evidence about a directory that may be a run mid-spawn.
        const plan = planRegistrySizeCap(
            [sizeEntry("bare", { status: undefined, bytes: 50_000 })],
            { maxBytes: 1000 },
        );
        assert.deepEqual(plan.remove, []);
        assert.equal(plan.overBudget, true);
    });
});

describe("enforceRegistrySizeCapOnce", () => {
    it("measures real directories, retires oldest first, and rate-limits itself", () => {
        rmSync(baseDir(), { recursive: true, force: true });

        const old = "sa_cap_old";
        const recent = "sa_cap_recent";
        const live = "sa_cap_live";
        for (const [id, over] of [
            [old, { endedAt: DAY - 5 * DAY_MS }],
            [recent, { endedAt: DAY - 1 * DAY_MS }],
            [live, { status: "running", endedAt: undefined }],
        ]) {
            writeMeta(meta(id, over));
            writeFileSync(logPathFor(id), "x".repeat(4000));
        }

        const entries = collectSizeCapEntries();
        assert.equal(entries.length, 3, "every run measured");
        assert.ok(entries.every((e) => e.bytes >= 4000), "bytes counted from disk");

        // 12 KB of logs against a 9 KB cap, with the live run untouchable.
        // spawnPid is this process, so own-run protection must be overridden to
        // observe the byte bound at all — which is itself the protection's proof.
        const result = enforceRegistrySizeCapOnce({
            now: DAY,
            maxBytes: 9000,
            force: true,
            protectedIds: new Set(),
        });
        assert.equal(result.ran, true);
        assert.deepEqual(result.removed, [old], "oldest terminal run retired");
        assert.equal(existsSync(runDir(recent)), true, "newer terminal run kept");
        assert.equal(existsSync(runDir(live)), true, "live run kept");
        assert.deepEqual(result.errors, []);

        // Inside the interval the sweep does not run again.
        writeMeta(meta("sa_cap_second", { endedAt: DAY - 6 * DAY_MS }));
        writeFileSync(logPathFor("sa_cap_second"), "y".repeat(9000));
        const skipped = enforceRegistrySizeCapOnce({ now: DAY + 60_000, maxBytes: 1000, protectedIds: new Set() });
        assert.equal(skipped.ran, false, "rate-limited between sweeps");
        assert.equal(existsSync(runDir("sa_cap_second")), true);

        const later = enforceRegistrySizeCapOnce({
            now: DAY + SIZE_SWEEP_INTERVAL_MS,
            maxBytes: 1000,
            protectedIds: new Set(),
        });
        assert.equal(later.ran, true, "runs again once the interval has passed");
    });

    it("protects this pi's own runs by default", () => {
        rmSync(baseDir(), { recursive: true, force: true });
        // meta() stamps spawnPid = process.pid, so every fixture is "ours".
        const id = "sa_cap_owned";
        writeMeta(meta(id, { endedAt: DAY - 9 * DAY_MS }));
        writeFileSync(logPathFor(id), "z".repeat(50_000));

        const result = enforceRegistrySizeCapOnce({ now: DAY, maxBytes: 1000, force: true });
        assert.deepEqual(result.removed, [], "an owned run survives the cap");
        assert.equal(result.overBudget, true, "and the shortfall is reported");
        assert.equal(existsSync(runDir(id)), true);
    });

    it("defaults to a 2 GiB budget — tighter than a single observed log", () => {
        // One run's log has been seen past 3 GB, so the budget must be smaller
        // than "a few of those" or it never binds.
        assert.equal(DEFAULT_MAX_REGISTRY_BYTES, 2 * 1024 * 1024 * 1024);
        assert.equal(SIZE_SWEEP_INTERVAL_MS, 10 * 60 * 1000);
    });
});
