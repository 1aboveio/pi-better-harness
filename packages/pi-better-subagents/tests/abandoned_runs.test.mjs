/**
 * Records whose spawning pi is gone (abandoned-record reconciliation).
 *
 * Reconciliation is owner-gated (a pi must not adjudicate another pi's children)
 * and retention only ever retires TERMINAL records. Both rules are right, and
 * together they trap a `running`/`orphaned` record whose parent died without a
 * clean shutdown: nobody is its owner, so nothing moves it to `lost`, so it never
 * ages out. One such record was observed pinning 1.1 GB indefinitely.
 *
 * The predicate must be conservative in one direction only: it may fail to spot
 * an abandoned record (harmless — nothing happens), but it must NEVER call a live
 * session's parent dead.
 *
 * // @covers subagent.abandoned-records
 * // @level unit
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNTIME = mkdtempSync(join(tmpdir(), "subagent-abandoned-"));
process.env.TMPDIR = RUNTIME;

const { isAbandonedByParent, reconcileRun } = await import("../health.ts");
const { runDailyCleanupOnce } = await import("../cleanup.ts");
const { logPathFor, readMeta, runDir, writeMeta } = await import("../registry.ts");

const OURS = process.pid;
const DEAD_PARENT = 999_001;
const OTHER_LIVE_PARENT = 999_002;

/** Probe where only the pids/groups named alive exist, with optional start tokens. */
function probe({ alive = [], tokens = {}, groups = [] } = {}) {
    return {
        pidExists: (pid) => alive.includes(pid),
        startToken: (pid) => tokens[pid],
        groupId: (pid) => (alive.includes(pid) ? pid : undefined),
        groupAlive: (pgid) => groups.includes(pgid),
    };
}

describe("isAbandonedByParent", () => {
    it("is true when the recorded parent pid no longer exists", () => {
        assert.equal(isAbandonedByParent({ spawnPid: DEAD_PARENT }, probe({ alive: [] }), OURS), true);
    });

    it("is false when the parent is still alive", () => {
        assert.equal(
            isAbandonedByParent({ spawnPid: OTHER_LIVE_PARENT }, probe({ alive: [OTHER_LIVE_PARENT] }), OURS),
            false,
        );
    });

    it("is false for our own runs — that is the owner path", () => {
        assert.equal(isAbandonedByParent({ spawnPid: OURS }, probe({ alive: [] }), OURS), false);
    });

    it("is false when no parent was recorded: abandonment is unprovable", () => {
        for (const meta of [{}, { spawnPid: undefined }, { spawnPid: 0 }, { spawnPid: -1 }]) {
            assert.equal(isAbandonedByParent(meta, probe({ alive: [] }), OURS), false, JSON.stringify(meta));
        }
    });

    it("spots a recycled parent pid when both start tokens are known and differ", () => {
        const meta = { spawnPid: OTHER_LIVE_PARENT, spawnPidStartTime: "at-boot" };
        const recycled = probe({ alive: [OTHER_LIVE_PARENT], tokens: { [OTHER_LIVE_PARENT]: "much-later" } });
        assert.equal(isAbandonedByParent(meta, recycled, OURS), true);

        const same = probe({ alive: [OTHER_LIVE_PARENT], tokens: { [OTHER_LIVE_PARENT]: "at-boot" } });
        assert.equal(isAbandonedByParent(meta, same, OURS), false, "matching token means the parent is the original");
    });

    it("treats unknown identity as not abandoned — never guesses a parent dead", () => {
        // An unavailable token proves nothing (ProcessProbe's contract), and a
        // pid owned by another user reads as existing via EPERM. Both must land
        // on "leave it alone".
        const noRecorded = { spawnPid: OTHER_LIVE_PARENT };
        assert.equal(
            isAbandonedByParent(noRecorded, probe({ alive: [OTHER_LIVE_PARENT], tokens: { [OTHER_LIVE_PARENT]: "x" } }), OURS),
            false,
            "no recorded token",
        );
        const noCurrent = { spawnPid: OTHER_LIVE_PARENT, spawnPidStartTime: "at-boot" };
        assert.equal(
            isAbandonedByParent(noCurrent, probe({ alive: [OTHER_LIVE_PARENT] }), OURS),
            false,
            "no current token",
        );
    });
});

describe("adopted records reach a terminal status and then age out", () => {
    function seed(id, overrides = {}) {
        writeMeta({
            id,
            status: "running",
            pid: 999_100,
            pgid: 999_100,
            pidStartTime: "child-token",
            spawnPid: DEAD_PARENT,
            cwd: RUNTIME,
            promptPreview: "abandoned fixture",
            startedAt: Date.parse("2026-07-20T00:00:00Z"),
            logPath: logPathFor(id),
            sessionId: id,
            ...overrides,
        });
        writeFileSync(logPathFor(id), "x".repeat(2000), "utf-8");
        return id;
    }

    it("reconciles to lost with the same evidence rules an owned record gets", () => {
        // This is the whole point: reconcileRun owns the verdict, adoption only
        // decides that SOMEBODY may ask it.
        const id = seed("sa_abandoned_lost");
        const meta = readMeta(id);
        const dead = probe({ alive: [] });

        assert.equal(isAbandonedByParent(meta, dead, OURS), true, "eligible for adoption");
        const result = reconcileRun(meta, dead, Date.parse("2026-07-30T00:00:00Z"));
        assert.equal(result.status, "lost");
        assert.equal(result.transition, true);
        assert.equal(result.patch.lostAt, Date.parse("2026-07-30T00:00:00Z"));
        rmSync(runDir(id), { recursive: true, force: true });
    });

    it("stays orphaned while the process group still has members", () => {
        // An orphan is a live supervision question even with a dead parent, so
        // adoption must not shortcut it to lost.
        const id = seed("sa_abandoned_group_alive");
        const meta = readMeta(id);
        // Child gone, but its process group still has members.
        const groupStillAlive = probe({ alive: [], groups: [999_100] });
        const result = reconcileRun(meta, groupStillAlive, Date.parse("2026-07-30T00:00:00Z"));
        assert.notEqual(result.status, "lost", "live related process is not lost");
        rmSync(runDir(id), { recursive: true, force: true });
    });

    it("becomes retention-eligible once terminal — which is what unsticks the disk", () => {
        const id = seed("sa_abandoned_ages_out", {
            status: "lost",
            lostAt: Date.parse("2026-07-01T00:00:00Z"),
            endedAt: Date.parse("2026-07-01T00:00:00Z"),
            adoptedFromLostParentAt: Date.parse("2026-07-01T00:00:00Z"),
        });
        const result = runDailyCleanupOnce({
            now: Date.parse("2026-07-30T00:00:00Z"),
            terminalRunRetentionMs: 7 * 24 * 60 * 60 * 1000,
            sessionRetentionMs: 7 * 24 * 60 * 60 * 1000,
        });
        assert.equal(result.ran, true);
        assert.ok(result.removedRunDirs >= 1, "the adopted record is retired by the age sweep");
    });

    it("records why a record went terminal without any session reporting it", () => {
        const id = seed("sa_abandoned_marker");
        const meta = readMeta(id);
        meta.status = "lost";
        meta.adoptedFromLostParentAt = 1_800_000_000_000;
        writeMeta(meta);
        const back = JSON.parse(readFileSync(join(runDir(id), "meta.json"), "utf-8"));
        assert.equal(back.adoptedFromLostParentAt, 1_800_000_000_000, "marker persists for diagnosis");
        rmSync(runDir(id), { recursive: true, force: true });
    });
});

describe("wiring", () => {
    it("adopts on the health tick and at session start, and never notifies or calls back", async () => {
        const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
        const sweep = src.match(/function reconcileAbandonedRuns[\s\S]*?\n}/)?.[0] ?? "";
        assert.ok(sweep, "sweep located");
        assert.match(sweep, /ownedByThisParent\(summary\)\) continue/, "owned runs stay on the owner path");
        assert.match(sweep, /isAbandonedByParent\(summary, realProcessProbe\)/);
        assert.match(sweep, /reconcileRun\(meta, realProcessProbe, now\)/, "same evidence rules");
        assert.doesNotMatch(sweep, /notify|deliverHealthCallback/, "no notify, no callback for a dead session's run");

        // Called from both the tick and session start.
        assert.match(src, /const pi = healthPi;\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*reconcileAbandonedRuns\(\)/);
        assert.match(src, /ensureSubagentProvider\(\);\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*reconcileAbandonedRuns\(\)/);

        // Adopted records must not extend this session's ticker lifetime.
        const health = readFileSync(new URL("../health.ts", import.meta.url), "utf8");
        const monitoring = health.match(/export function needsMonitoring[\s\S]*?\n}/)?.[0] ?? "";
        assert.match(monitoring, /ownedByThisParent/);
        assert.doesNotMatch(monitoring, /isAbandonedByParent/, "an adopted record never keeps the loop alive");
    });

    it("records the spawning pi's start token so recycling can be detected later", () => {
        const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
        assert.match(src, /spawnPid: process\.pid, spawnPidStartTime: parentStartToken\(\)/);
    });
});

process.on("exit", () => {
    try { rmSync(RUNTIME, { recursive: true, force: true }); } catch { /* */ }
});
