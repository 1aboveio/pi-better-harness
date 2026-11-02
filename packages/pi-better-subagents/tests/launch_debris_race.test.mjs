/**
 * Launch-debris purge vs a concurrent launch (#623 review R1).
 *
 * The first fix classified debris by shape and deleted it immediately. A purge
 * could therefore run between "no metadata, no log" and recursive deletion while
 * another pi published a child and its `meta.json`/`output.log`, deleting the
 * live attempt's artifacts and leaving the child running. Explicit stop had no
 * age guard, so an ordinary fresh launch was enough; the aged sweep used the
 * same unsafe operation.
 *
 * Contract proven here:
 * - the recorded reproducer interleaving (a publication that lands between the
 *   purger's negative observations) preserves the published run — the previous
 *   code returned `purged` and deleted the directory;
 * - a publisher that holds the run's metadata lock is never deleted under: the
 *   purge waits for the lock, re-classifies, and preserves the published run;
 * - a launch claim owned by a live process is never debris at any age, so the
 *   aged sweep and an explicit stop both preserve a launch that is still
 *   preparing; once its owner is gone the same record is reclaimed.
 *
 * Real child processes only: holder fixtures are separate Node processes sharing
 * this test's private TMPDIR, so the coordination is genuinely cross-process.
 *
 * // @covers subagent.launch-debris
 * // @level integration
 */
import fs from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNTIME = mkdtempSync(join(tmpdir(), "subagent-debris-race-"));
process.env.TMPDIR = RUNTIME;
process.env.PI_CODING_AGENT_DIR = join(RUNTIME, "agent");
process.env.PI_SUBAGENT_DURABLE_DIR = join(RUNTIME, "durable");

const REGISTRY_URL = new URL("../registry.ts", import.meta.url).href;

const {
    abandonedLaunchRecord,
    baseDir,
    launchAttemptInProgress,
    logPathFor,
    promptPathFor,
    runDir,
} = await import("../registry.ts");
const { sweepAbandonedLaunches } = await import("../cleanup.ts");
const { stopRun } = await import("../stop.ts");
const { spawnDetached, killProcessTree } = await import("../spawn.ts");

const HOUR = 60 * 60 * 1000;

function reset() {
    rmSync(baseDir(), { recursive: true, force: true });
}

function runDirs() {
    try {
        return readdirSync(join(baseDir(), "runs"));
    } catch {
        return [];
    }
}

/** Wait for a file to appear; false on timeout. */
async function waitForFile(path, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fs.existsSync(path)) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
}

/** Settle when a child process has exited, including one that already exited. */
function hasExited(child) {
    return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once("exit", () => resolve());
    });
}

/** A separate pi that prepares a launch (claim + prompt) and then waits to be killed. */
function startPreparingLaunch(id, readyPath) {
    const script = `
import fs from "node:fs";
const [registryUrl, runDir, promptPath, id, readyPath] = process.argv.slice(1);
const { recordLaunchAttempt } = await import(registryUrl);
fs.mkdirSync(runDir, { recursive: true });
recordLaunchAttempt(id);
fs.writeFileSync(promptPath, "launch still preparing");
fs.writeFileSync(readyPath, "ready");
setInterval(() => {}, 1000);
`;
    return spawn(process.execPath, [
        "--import", "tsx", "--input-type=module", "-e", script,
        REGISTRY_URL, runDir(id), promptPathFor(id), id, readyPath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * A separate pi that publishes metadata while holding the run's metadata lock:
 * `setMetaWriteBarrierForTests` runs inside `writeMeta`'s critical section, after
 * the lock is taken and before `meta.json` is replaced. It stays alive after
 * publishing so the recorded pid is a live "child" for status resolution.
 */
function startPublishingLaunch(id, lockedPath, holdMs = 400) {
    const script = `
import fs from "node:fs";
const [registryUrl, id, lockedPath, holdMs] = process.argv.slice(1);
const { runDir, promptPathFor, logPathFor, setMetaWriteBarrierForTests, writeMeta } = await import(registryUrl);
fs.mkdirSync(runDir(id), { recursive: true });
fs.writeFileSync(promptPathFor(id), "launch about to publish");
setMetaWriteBarrierForTests(() => {
    fs.writeFileSync(lockedPath, "locked");
    const until = Date.now() + Number(holdMs);
    while (Date.now() < until) { /* hold the publication lock */ }
});
writeMeta({
    id, status: "running", pid: process.pid, spawnPid: process.pid, cwd: process.env.TMPDIR,
    promptPreview: "concurrent publish", startedAt: Date.now(), logPath: logPathFor(id), sessionId: id,
});
setMetaWriteBarrierForTests(undefined);
fs.writeFileSync(lockedPath + ".published", "published");
setInterval(() => {}, 1000);
`;
    return spawn(process.execPath, [
        "--import", "tsx", "--input-type=module", "-e", script,
        REGISTRY_URL, id, lockedPath, String(holdMs),
    ], { stdio: ["ignore", "pipe", "pipe"] });
}

describe("launch-debris purge vs a concurrent launch (#623 R1)", () => {
    it("preserves a run published between the purger's negative observations (recorded reproducer)", async () => {
        reset();
        const id = "sa_racewitness_1";
        mkdirSync(runDir(id), { recursive: true });
        const prompt = promptPathFor(id);
        writeFileSync(prompt, "active launch");
        const exists = fs.existsSync;
        let child;
        try {
            // The reviewer's interleaving: a second pi publishes its child,
            // metadata, and log at the purger's prompt existence check, i.e.
            // after the negative metadata/log observations.
            fs.existsSync = function (path) {
                if (path === prompt && !child) {
                    child = spawnDetached({
                        file: process.execPath, fileArgs: ["-e", "setInterval(()=>{},1000)"],
                        cwd: RUNTIME, logPath: logPathFor(id),
                    });
                    writeFileSync(join(runDir(id), "meta.json"), JSON.stringify({
                        id, status: "running", pid: child.pid, spawnPid: process.pid,
                        startedAt: Date.now(), cwd: RUNTIME, logPath: logPathFor(id), sessionId: id,
                    }));
                }
                return exists(path);
            };
            syncBuiltinESMExports();
            const outcome = stopRun(id);
            assert.equal(outcome.action, "preserved", "a published run is never purged");
            assert.equal(outcome.status, "running");
            assert.doesNotThrow(() => process.kill(child.pid, 0), "the live child is untouched");
            assert.equal(exists(join(runDir(id), "meta.json")), true, "published metadata survives");
            assert.equal(exists(logPathFor(id)), true, "the child's log survives");
            assert.equal(exists(prompt), true, "the attempt's prompt survives");
        } finally {
            fs.existsSync = exists;
            syncBuiltinESMExports();
            if (child) {
                killProcessTree(child.pid, "SIGKILL");
                await child.exit;
            }
        }
    });

    it("waits for a publisher's metadata lock and preserves the published run", async () => {
        reset();
        const id = "sa_racelock_1";
        const locked = join(RUNTIME, "publisher.locked");
        const holder = startPublishingLaunch(id, locked);
        try {
            assert.ok(await waitForFile(locked), "the holder is publishing under the run lock");
            // No metadata, no log, no claim: only the publication lock separates
            // this live writer from the purger's debris classification.
            assert.equal(abandonedLaunchRecord(id)?.id, id);
            const outcome = stopRun(id);
            assert.deepEqual(outcome, { action: "preserved", id, status: "running" });
            const meta = JSON.parse(readFileSync(join(runDir(id), "meta.json"), "utf-8"));
            assert.equal(meta.id, id, "the publisher's metadata is intact");
            assert.equal(meta.pid, holder.pid);
            assert.ok(await waitForFile(locked + ".published"), "the publisher finished its write");
        } finally {
            holder.kill("SIGKILL");
            await hasExited(holder);
        }
    });

    it("aged sweep preserves a live preparing launch, then reclaims it once its owner is gone", async () => {
        reset();
        const id = "sa_raceclaim_1";
        const ready = join(RUNTIME, "preparer.ready");
        const preparer = startPreparingLaunch(id, ready);
        try {
            assert.ok(await waitForFile(ready), "the second pi claimed its run directory");
            assert.equal(launchAttemptInProgress(id), true);
            assert.equal(abandonedLaunchRecord(id), undefined, "a live claim is never debris");
            // Any age: the claim, not the clock, decides ownership.
            const sweep = sweepAbandonedLaunches({ now: Date.now() + 24 * HOUR, graceMs: 0 });
            assert.deepEqual(sweep.removed, [], "the aged sweep preserves a live preparing launch");
            assert.deepEqual(sweep.errors, []);
            assert.deepEqual(stopRun(id), { action: "preserved", id, status: "launching" });
            assert.deepEqual(runDirs(), [id]);
            assert.equal(fs.existsSync(promptPathFor(id)), true);
        } finally {
            preparer.kill("SIGKILL");
            await hasExited(preparer);
        }
        // Positive control: the same record is real debris once its owner is dead.
        const after = sweepAbandonedLaunches({ now: Date.now() + 24 * HOUR, graceMs: 0 });
        assert.deepEqual(after.removed, [id], "a dead launch attempt is reclaimed");
        assert.deepEqual(runDirs(), []);
    });
});

process.on("exit", () => {
    try { rmSync(RUNTIME, { recursive: true, force: true }); } catch { /* best effort */ }
});
