/**
 * Launch debris (#623): run records that never became runs.
 *
 * A launch creates the run directory, writes `prompt.md`, and prepares the
 * sandbox `control/` dir before the child starts and `meta.json` is committed.
 * A throw in that window (or a pi that dies there) used to leave a directory the
 * registry could only report as "missing or unreadable metadata (ownership
 * unknown)" on every `subagent_list`, forever, until the seven-day age sweep.
 * Operators had to `rm -rf` it by hand.
 *
 * The contract proven here:
 * - such a directory is classified as an abandoned launch record, not run
 *   evidence: `subagent_list` names it, says it is not counted, and offers the
 *   explicit purge; the old "ownership unknown" gap is gone;
 * - `subagent_stop <id>` removes it on demand (operator cleanup);
 * - the launch-debris sweep reclaims it after the grace period, and leaves a
 *   directory with a real log alone (that one may be a started child's
 *   evidence and stays an unreadable record under normal retention);
 * - a launch failure AFTER the run directory and prompt exist leaves nothing
 *   behind (the real extension path, driven end to end).
 *
 * // @covers subagent.launch-debris
 * // @level unit
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNTIME = mkdtempSync(join(tmpdir(), "subagent-launch-debris-"));
process.env.TMPDIR = RUNTIME;

const {
    ABANDONED_LAUNCH_GRACE_MS,
    abandonedLaunchRecord,
    baseDir,
    listRunRecords,
    logPathFor,
    runDir,
    taskWorkspaceDir,
} = await import("../registry.ts");
const { cleanupStatePath, localDateKey, runDailyCleanupOnce, sweepAbandonedLaunches } = await import("../cleanup.ts");
const { stopRun } = await import("../stop.ts");
const { subagentListTool, subagentStopTool } = await import("../tools.ts");

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-07-30T12:00:00Z");

/** A launch attempt that stopped after `prompt.md` and `control/`, before any child. */
function seedDebris(id, { ageMs = 2 * HOUR, withLog = false } = {}) {
    mkdirSync(join(runDir(id), "control"), { recursive: true });
    writeFileSync(join(runDir(id), "prompt.md"), "review the diff");
    if (withLog) writeFileSync(logPathFor(id), "");
    const at = new Date(NOW - ageMs);
    utimesSync(runDir(id), at, at);
    return runDir(id);
}

function reset() {
    rmSync(baseDir(), { recursive: true, force: true });
}

const TYPE_STUB = {
    Object: (properties) => ({ type: "object", properties }),
    Optional: (schema) => schema,
    String: () => ({ type: "string" }),
    Number: () => ({ type: "number" }),
    Boolean: () => ({ type: "boolean" }),
    Array: (items) => ({ type: "array", items }),
};

async function listText() {
    const out = await subagentListTool(TYPE_STUB).execute("t", { all: true }, undefined, undefined, { cwd: "/repo" });
    return out.content[0].text;
}

describe("launch debris (#623)", () => {
    it("classifies a prompt/control directory with no metadata and no log as an abandoned launch", () => {
        reset();
        const id = "sa_debrisclass_1";
        seedDebris(id);
        assert.deepEqual(abandonedLaunchRecord(id), { id, mtimeMs: statSync(runDir(id)).mtimeMs });
        assert.deepEqual(listRunRecords().abandoned, [id]);
        assert.deepEqual(listRunRecords().unreadable, []);
    });

    it("does not classify a directory with a log as debris: it may be a started child's evidence", () => {
        reset();
        const id = "sa_debrislogged_1";
        seedDebris(id, { withLog: true });
        assert.equal(abandonedLaunchRecord(id), undefined);
        assert.deepEqual(listRunRecords().abandoned, []);
        assert.equal(listRunRecords().unreadable.length, 1, "still an honest unreadable record");
    });

    it("does not classify corrupt metadata as debris", () => {
        reset();
        const id = "sa_debriscorrupt_1";
        seedDebris(id);
        writeFileSync(join(runDir(id), "meta.json"), "{corrupt");
        assert.equal(abandonedLaunchRecord(id), undefined);
        assert.deepEqual(listRunRecords().unreadable.map((item) => item.id), [id]);
    });

    it("subagent_list names abandoned launches as not-run-evidence and offers the purge", async () => {
        reset();
        const id = "sa_debrislisted_1";
        seedDebris(id);
        const text = await listText();
        assert.ok(!/ownership unknown/.test(text), `debris must not be reported as unknown ownership:\n${text}`);
        assert.match(text, /1 abandoned launch record\(s\), not run evidence and not counted/);
        assert.match(text, new RegExp(id));
        assert.match(text, /Cleanup reclaims them after 1 hour; remove one now with subagent_stop <id>/);
        assert.ok(!/gap read/.test(text), "an abandoned launch is not a read gap in run evidence");
    });

    it("subagent_stop purges an abandoned launch record on demand", async () => {
        reset();
        const id = "sa_debrisstop_1";
        seedDebris(id);
        const workspace = taskWorkspaceDir(id);
        mkdirSync(workspace, { recursive: true });
        const out = await subagentStopTool(TYPE_STUB).execute("t", { id });
        assert.match(out.content[0].text, /Removed abandoned launch record sa_debrisstop_1/);
        assert.equal(existsSync(runDir(id)), false);
        assert.equal(existsSync(workspace), false, "the clone workspace the attempt owned goes too");
    });

    it("subagent_stop still refuses an id that is not a launch attempt", () => {
        reset();
        assert.throws(() => stopRun("sa_neverexisted_1"), /Unknown run id: sa_neverexisted_1/);
    });

    it("the sweep reclaims debris only after the grace period", () => {
        reset();
        const fresh = "sa_debrisfresh_1";
        const stale = "sa_debrisstale_1";
        seedDebris(fresh, { ageMs: ABANDONED_LAUNCH_GRACE_MS / 2 });
        seedDebris(stale, { ageMs: 2 * HOUR });
        const result = sweepAbandonedLaunches({ now: NOW });
        assert.deepEqual(result.removed, [stale]);
        assert.deepEqual(result.errors, []);
        assert.equal(existsSync(runDir(stale)), false);
        assert.equal(existsSync(runDir(fresh)), true, "a launch still inside the grace window is kept");
    });

    it("the sweep leaves a directory with a log alone", () => {
        reset();
        const id = "sa_debrisloggedold_1";
        seedDebris(id, { withLog: true, ageMs: 30 * 24 * HOUR });
        assert.deepEqual(sweepAbandonedLaunches({ now: NOW }).removed, []);
        assert.equal(existsSync(runDir(id)), true);
    });

    it("a launch's hygiene pass reclaims earlier debris even when the daily sweep already ran today", () => {
        reset();
        mkdirSync(baseDir(), { recursive: true });
        writeFileSync(cleanupStatePath(), JSON.stringify({ lastLocalDate: localDateKey(NOW) }));
        const id = "sa_debrisdaily_1";
        seedDebris(id, { ageMs: 2 * HOUR });
        const result = runDailyCleanupOnce({ now: NOW });
        assert.equal(result.ran, false, "the daily age sweep still runs at most once a day");
        assert.equal(result.removedAbandonedLaunches, 1);
        assert.equal(existsSync(runDir(id)), false);
    });
});

process.on("exit", () => {
    try { rmSync(RUNTIME, { recursive: true, force: true }); } catch { /* best effort */ }
});
