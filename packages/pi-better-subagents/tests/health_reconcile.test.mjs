/**
 * Unit tests for the subagent health reconciliation seam (issue #63).
 *
 * Process-group-only contract (ADR 0002). Every test injects a fake
 * ProcessProbe — no real processes are orphaned, recycled, or killed.
 * The cases pinned here:
 * - supervised: recorded pid alive and process-start identity still matches
 * - supervised with old metadata (no pgid / start token recorded)
 * - supervised when the start-token probe is momentarily unavailable
 * - orphaned: pid gone but process-group members alive
 * - orphaned after pid recycling when the recorded group survives
 * - lost: pid gone and no process-group evidence (new metadata, immediate)
 * - lost only after confirmation across health ticks for old metadata
 * - out of contract: escaped/reparented descendants are NOT related work —
 *   absence of process-group evidence does not stay orphaned just because a
 *   descendant scan would have found something (and ProcessProbe has no
 *   descendants method)
 * - durability: orphaned never auto-reverts to running; lost never reverts
 * - compatibility: completed/failed/killed are never touched
 *
 * // @covers health.reconcile
 * // @level unit
 * // @covers registry.process-identity
 * // @level unit
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    OLD_METADATA_LOST_CONFIRM_TICKS,
    captureProcessIdentity,
    needsMonitoring,
    realProcessProbe,
    reconcileRun,
} from "../health.ts";

/**
 * Fake process probe. `pids` are alive; `tokens` maps pid → start token;
 * `pgids` maps pid → its group id; `groups` lists alive process groups.
 * There is deliberately no descendant/tree input — #63 is process-group-only.
 */
function makeProbe({ pids = [], tokens = {}, pgids = {}, groups = [] } = {}) {
    return {
        pidExists: (pid) => pids.includes(pid),
        startToken: (pid) => tokens[pid],
        groupId: (pid) => pgids[pid],
        groupAlive: (pgid) => groups.includes(pgid),
    };
}

const NOW = 1_800_000_000_000;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("reconcileRun — supervised running", () => {
    it("keeps a run running when the pid exists and the start token matches", () => {
        const meta = { status: "running", pid: 100, pgid: 100, pidStartTime: "t1" };
        const r = reconcileRun(meta, makeProbe({ pids: [100], tokens: { 100: "t1" } }), NOW);
        assert.equal(r.status, "running");
        assert.equal(r.changed, false);
        assert.equal(r.transition, false);
    });

    it("keeps old metadata (no pgid / start token) running while the pid exists", () => {
        const meta = { status: "running", pid: 100 };
        const r = reconcileRun(meta, makeProbe({ pids: [100] }), NOW);
        assert.equal(r.status, "running");
        assert.equal(r.changed, false);
    });

    it("stays supervised when the start-token probe is unavailable (never distrusts silence)", () => {
        const meta = { status: "running", pid: 100, pgid: 100, pidStartTime: "t1" };
        const r = reconcileRun(meta, makeProbe({ pids: [100], tokens: {} }), NOW);
        assert.equal(r.status, "running");
        assert.equal(r.changed, false);
    });
});

describe("reconcileRun — orphaned", () => {
    it("marks orphaned when the pid is dead but process-group members are alive", () => {
        const meta = { status: "running", pid: 100, pgid: 100, pidStartTime: "t1" };
        const r = reconcileRun(meta, makeProbe({ pids: [], groups: [100] }), NOW);
        assert.equal(r.status, "orphaned");
        assert.equal(r.transition, true);
        assert.equal(r.reason, "orphaned-group-alive");
        assert.equal(r.patch.orphanedAt, NOW);
        assert.equal(r.patch.endedAt, undefined, "orphaned is non-terminal: run keeps accruing time");
    });

    it("falls back to the pid as group id for old detached metadata", () => {
        // Old metas recorded no pgid, but a detached child is its own group
        // leader (pgid == pid), so a live group with that id is valid evidence.
        // This legacy fallback is explicit and conservative: it may delay lost,
        // but it never manufactures completion or failure.
        const meta = { status: "running", pid: 100 };
        const r = reconcileRun(meta, makeProbe({ pids: [], groups: [100] }), NOW);
        assert.equal(r.status, "orphaned");
        assert.equal(r.reason, "orphaned-group-alive");
    });

    it("marks orphaned when the pid was recycled but the recorded group is alive", () => {
        const meta = { status: "running", pid: 100, pgid: 100, pidStartTime: "t1" };
        const probe = makeProbe({ pids: [100], tokens: { 100: "t2" }, groups: [100] });
        const r = reconcileRun(meta, probe, NOW);
        assert.equal(r.status, "orphaned");
        assert.equal(r.transition, true);
        assert.equal(r.reason, "orphaned-group-alive");
    });
});

describe("reconcileRun — lost", () => {
    it("marks lost immediately for new metadata when no process-group evidence remains", () => {
        const meta = { status: "running", pid: 100, pgid: 100, pidStartTime: "t1" };
        const r = reconcileRun(meta, makeProbe({ pids: [] }), NOW);
        assert.equal(r.status, "lost");
        assert.equal(r.transition, true);
        assert.equal(r.reason, "lost-no-evidence");
        assert.equal(r.patch.lostAt, NOW);
        assert.equal(r.patch.endedAt, NOW, "lost is terminal: the run stops accruing time");
    });

    it("marks lost when a recycled pid has no surviving process-group evidence", () => {
        // Token mismatch proves the recorded pid was recycled. Without group
        // evidence the run is lost — #63 does not consult a process tree.
        const meta = { status: "running", pid: 100, pgid: 100, pidStartTime: "t1" };
        const probe = makeProbe({ pids: [100], tokens: { 100: "t2" }, groups: [] });
        const r = reconcileRun(meta, probe, NOW);
        assert.equal(r.status, "lost");
        assert.equal(r.reason, "lost-no-evidence");
    });

    it("confirms lost across health ticks for old metadata before writing it", () => {
        const meta = { status: "running", pid: 100 };
        const probe = makeProbe({ pids: [] });
        const first = reconcileRun(meta, probe, NOW);
        assert.equal(first.status, "running", "first pid-gone tick only suspects loss");
        assert.equal(first.transition, false);
        assert.equal(first.reason, "lost-suspected-old-metadata");
        assert.equal(first.patch.probeMisses, 1);

        let misses = first.patch.probeMisses;
        let last = first;
        while (misses < OLD_METADATA_LOST_CONFIRM_TICKS) {
            last = reconcileRun({ ...meta, probeMisses: misses }, probe, NOW + 1000);
            misses = last.patch.probeMisses ?? misses;
        }
        assert.equal(last.status, "lost");
        assert.equal(last.transition, true);
        assert.equal(last.reason, "lost-confirmed-old-metadata");
    });

    it("resets the old-metadata miss counter when the run is supervised again", () => {
        const meta = { status: "running", pid: 100, probeMisses: 1 };
        const r = reconcileRun(meta, makeProbe({ pids: [100] }), NOW);
        assert.equal(r.status, "running");
        assert.equal(r.transition, false);
        assert.equal(r.patch.probeMisses, 0);
    });
});

describe("reconcileRun — process-group-only (no descendant evidence)", () => {
    it("does not keep a run orphaned without process-group evidence (escaped descendants out of contract)", () => {
        // Counterexample for the removed descendant contract: pid dead, no
        // group members alive. Even if a process-tree scan would have found
        // reparented children of the dead leader, #63 must not stay orphaned —
        // related work is process-group evidence only.
        const meta = { status: "running", pid: 100, pgid: 100, pidStartTime: "t1" };
        const r = reconcileRun(meta, makeProbe({ pids: [], groups: [] }), NOW);
        assert.equal(r.status, "lost");
        assert.equal(r.reason, "lost-no-evidence");
        assert.notEqual(r.reason, "orphaned-descendants-alive");
    });

    it("exposes no descendants method on ProcessProbe (source + runtime seam)", () => {
        const probe = makeProbe({});
        assert.equal("descendants" in probe, false);
        assert.equal(typeof realProcessProbe.descendants, "undefined");
        assert.equal(typeof probe.descendants, "undefined");

        const healthSrc = readFileSync(join(ROOT, "health.ts"), "utf-8");
        assert.match(healthSrc, /export interface ProcessProbe/);
        assert.doesNotMatch(
            healthSrc,
            /descendants\s*\(/,
            "ProcessProbe / realProcessProbe must not expose a descendants method",
        );
        assert.doesNotMatch(
            healthSrc,
            /scanDescendants|orphaned-descendants-alive/,
            "descendant scan paths and reasons must be fully removed from #63",
        );
        assert.match(
            healthSrc,
            /pgid\s*\?\?\s*meta\.pid|meta\.pgid\s*\?\?\s*meta\.pid/,
            "legacy pgid=pid fallback must remain explicit",
        );
    });
});

describe("reconcileRun — durability of orphaned and lost", () => {
    it("keeps an orphaned run orphaned while process-group evidence remains", () => {
        const meta = { status: "orphaned", pid: 100, pgid: 100, pidStartTime: "t1", orphanedAt: NOW - 5000 };
        const r = reconcileRun(meta, makeProbe({ pids: [], groups: [100] }), NOW);
        assert.equal(r.status, "orphaned");
        assert.equal(r.changed, false);
        assert.equal(r.reason, "orphaned-kept");
    });

    it("moves an orphaned run to lost once process-group evidence is gone", () => {
        const meta = { status: "orphaned", pid: 100, pgid: 100, pidStartTime: "t1", orphanedAt: NOW - 5000 };
        const r = reconcileRun(meta, makeProbe({ pids: [] }), NOW);
        assert.equal(r.status, "lost");
        assert.equal(r.transition, true);
        assert.equal(r.patch.lostAt, NOW);
    });

    it("never auto-reverts an orphaned run to running even if the pid probe recovers", () => {
        const meta = { status: "orphaned", pid: 100, pgid: 100, pidStartTime: "t1", orphanedAt: NOW - 5000 };
        const r = reconcileRun(meta, makeProbe({ pids: [100], tokens: { 100: "t1" } }), NOW);
        assert.equal(r.status, "orphaned");
    });

    it("never reverts a lost run even if the pid reappears with a matching token", () => {
        const meta = { status: "lost", pid: 100, pgid: 100, pidStartTime: "t1", lostAt: NOW - 5000, endedAt: NOW - 5000 };
        const r = reconcileRun(meta, makeProbe({ pids: [100], tokens: { 100: "t1" }, groups: [100] }), NOW);
        assert.equal(r.status, "lost");
        assert.equal(r.changed, false);
    });

    it("leaves completed, failed, and killed runs untouched", () => {
        for (const status of ["completed", "failed", "killed"]) {
            const meta = { status, pid: 100, pgid: 100, pidStartTime: "t1" };
            const r = reconcileRun(meta, makeProbe({ pids: [] }), NOW);
            assert.equal(r.status, status);
            assert.equal(r.changed, false, `${status} must not be reconciled`);
        }
    });
});

describe("captureProcessIdentity", () => {
    it("records the process group id and start token when available", () => {
        const id = captureProcessIdentity(100, makeProbe({ pgids: { 100: 100 }, tokens: { 100: "t1" } }));
        assert.equal(id.pgid, 100);
        assert.equal(id.pidStartTime, "t1");
    });

    it("records each identity field independently when only one probe is available", () => {
        // pgid and start-token are separate best-effort capabilities: a
        // restricted Linux shell may expose /proc start times while blocking
        // ps/getpgid. One being unavailable must not suppress the other.
        const onlyToken = captureProcessIdentity(100, makeProbe({ tokens: { 100: "t1" } }));
        assert.equal(onlyToken.pgid, undefined);
        assert.equal(onlyToken.pidStartTime, "t1");
        const onlyGroup = captureProcessIdentity(100, makeProbe({ pgids: { 100: 100 } }));
        assert.equal(onlyGroup.pgid, 100);
        assert.equal(onlyGroup.pidStartTime, undefined);
    });

    it("degrades to undefined fields when the probes are unavailable", () => {
        const id = captureProcessIdentity(100, makeProbe({}));
        assert.equal(id.pgid, undefined);
        assert.equal(id.pidStartTime, undefined);
    });
});

describe("realProcessProbe (self)", () => {
    it("sees this process as alive and never throws", () => {
        assert.equal(realProcessProbe.pidExists(process.pid), true);
        assert.equal(realProcessProbe.pidExists(4194304), false, "pid above the Linux/macOS max must not exist");
    });

    it("resolves group and start-token identity as independent capabilities", () => {
        // groupId (process.getpgid / ps) and startToken (/proc stat / ps
        // lstart) are SEPARATE best-effort capabilities: a restricted Linux
        // shell may expose /proc start times while blocking ps/getpgid, and a
        // sandboxed shell may block both. Each capability is validated on its
        // own; one being unavailable must never require the other to disappear.
        const pgid = realProcessProbe.groupId(process.pid);
        if (pgid !== undefined) {
            assert.ok(pgid > 0, "group id of a live process must be a positive number");
            assert.equal(realProcessProbe.groupAlive(pgid), true);
        }
        const token = realProcessProbe.startToken(process.pid);
        if (token !== undefined) {
            assert.ok(token.length > 0, "start token must be non-empty when the probe exposes it");
            assert.equal(token, realProcessProbe.startToken(process.pid), "start token must be stable across probes");
        }
        // In every environment, including fully restricted ones: liveness
        // works and neither capability probe ever throws (validated above by
        // reaching this point).
        assert.equal(realProcessProbe.pidExists(process.pid), true);
        assert.equal(
            typeof realProcessProbe.descendants,
            "undefined",
            "realProcessProbe must not expose descendant scanning under the process-group-only contract",
        );
    });
});

describe("needsMonitoring", () => {
    const parent = 41001;
    it("is true while a current-parent run is running or orphaned", () => {
        assert.equal(needsMonitoring([{ id: "a", spawnPid: parent, status: "running" }], parent), true);
        assert.equal(needsMonitoring([{ id: "a", spawnPid: parent, status: "orphaned" }], parent), true);
    });
    it("is true for unmarked lost (durable callback recovery)", () => {
        assert.equal(needsMonitoring([{ id: "a", spawnPid: parent, status: "lost" }], parent), true);
        assert.equal(
            needsMonitoring([{ id: "a", spawnPid: parent, status: "lost", lostCallbackSentAt: undefined }], parent),
            true,
        );
    });
    it("is false when only terminal-or-handled or foreign-parent runs remain", () => {
        assert.equal(needsMonitoring([{ id: "a", spawnPid: parent, status: "completed" }], parent), false);
        assert.equal(
            needsMonitoring([{ id: "a", spawnPid: parent, status: "lost", lostCallbackSentAt: 1 }], parent),
            false,
            "marked lost no longer needs the ticker",
        );
        assert.equal(needsMonitoring([{ id: "a", spawnPid: 99999, status: "running" }], parent), false);
        assert.equal(needsMonitoring([{ id: "a", spawnPid: 99999, status: "lost" }], parent), false);
        assert.equal(needsMonitoring([], parent), false);
    });
});
