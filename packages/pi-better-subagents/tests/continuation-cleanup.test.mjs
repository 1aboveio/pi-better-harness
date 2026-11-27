/**
 * Continuation cleanup lifetime (#owner-continuation, independent review P1).
 *
 * Retention release is not quiescence. A released conversation can still be in
 * use: a later attempt runs inside the root's shared clone and appends to the
 * root's saved session, a `killed` record is written before its kill lands, and
 * a writer lease exists during the admission window before the attempt's
 * metadata is published. Both sweeps must therefore protect the whole
 * conversation — every attempt's run directory plus the root-owned workspace,
 * task scratch, and saved history — until nothing can write it any more.
 *
 * The fixtures are real registry records, a real detached child process holding
 * the shared workspace as its cwd, and the real writer lease. They do not mock
 * cleanup or the registry, so each assertion fails on the actual deletion the
 * review reproduced.
 *
 * @covers subagent.continuation
 * @level integration
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(dirname(PACKAGE_DIR));

// Hermetic registry: every path this file touches lives under one temp root,
// made canonical up front so `baseDir()`, `taskWorkspaceDir()`, and the task
// scratch path all agree (registry resolves the temp root with realpath).
const RUNTIME = mkdtempSync(join(realpathSync(tmpdir()), "subagent-continuation-cleanup-"));
process.env.TMPDIR = RUNTIME;
process.env.TMP = RUNTIME;
process.env.TEMP = RUNTIME;
process.env.PI_SANDBOX_RECOVERY_SNAPSHOT = "off";

const {
    cleanupStatePath,
    enforceRegistrySizeCapOnce,
    runDailyCleanupOnce,
} = await import("../cleanup.ts");
const {
    baseDir,
    logPathFor,
    nextRunId,
    processStartToken,
    runDir,
    sessionsDir,
    taskWorkspaceDir,
    writeMeta,
} = await import("../registry.ts");
const {
    acquireConversationLease,
    markRetentionReleased,
    readConversationLease,
    retainConversation,
} = await import("../continuation.ts");
const { killProcessTree, processExists } = await import("../spawn.ts");

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);
const OLD = NOW - 20 * DAY_MS;
const OWNER_ORIGIN = { cwd: RUNTIME, sessionId: "owner-session" };
const children = new Set();

after(() => {
    for (const child of children) {
        try { killProcessTree(child.pid, "SIGKILL"); } catch { /* already gone */ }
    }
    rmSync(RUNTIME, { recursive: true, force: true });
});

/** A real detached process that keeps running until the test kills it. */
function spawnLiveChild(cwd) {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        cwd,
        detached: true,
        stdio: "ignore",
    });
    children.add(child);
    return child;
}

async function stopChild(child) {
    if (!processExists(child.pid)) return;
    killProcessTree(child.pid, "SIGKILL");
    await once(child, "exit");
}

/** An aged, completed, released root that owns its disposable task workspace. */
function writeReleasedRoot(root, workspace, overrides = {}) {
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "uncommitted.txt"), "retained edits\n");
    writeMeta({
        id: root,
        status: "completed",
        pid: 0,
        spawnPid: 1,
        cwd: workspace,
        taskRuntime: true,
        promptPreview: "retained root",
        startedAt: OLD,
        endedAt: OLD,
        logPath: logPathFor(root),
        sessionId: root,
        rootRunId: root,
        callbackOrigin: OWNER_ORIGIN,
        ...overrides,
    });
    const retained = retainConversation({
        sessionId: root,
        ownerRunId: root,
        workspace,
        ownerOrigin: OWNER_ORIGIN,
        attemptId: root,
        now: OLD,
    });
    markRetentionReleased(retained, OWNER_ORIGIN, OLD);
}

/** The saved native conversation a continuation reopens. */
function writeSavedSession(root, workspace, mtimeMs = OLD) {
    const legacySessionDir = join(baseDir(), "sessions");
    mkdirSync(legacySessionDir, { recursive: true });
    const path = join(legacySessionDir, `2026-01-01T00-00-00-000Z_${root}.jsonl`);
    writeFileSync(
        path,
        `${JSON.stringify({ type: "session", version: 1, id: root, timestamp: "2026-01-01T00:00:00.000Z", cwd: workspace })}\n`,
    );
    utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
    return path;
}

/** A continuation attempt of `root`'s conversation, in the root's workspace. */
function writeAttempt(root, attempt, workspace, overrides = {}) {
    writeMeta({
        id: attempt,
        status: "running",
        pid: 0,
        spawnPid: 1,
        cwd: workspace,
        promptPreview: "continuation attempt",
        startedAt: NOW,
        logPath: logPathFor(attempt),
        sessionId: root,
        rootRunId: root,
        resumedFrom: root,
        callbackOrigin: OWNER_ORIGIN,
        ...overrides,
    });
}

function sweep(now, protection) {
    rmSync(cleanupStatePath(), { force: true });
    const result = runDailyCleanupOnce({ now, ...(protection ? { protect: protection } : {}) });
    assert.deepEqual(result.errors, [], "sweep reports no errors");
    return result;
}

/** Fresh registry for one test: the same temp root, none of the last test's records. */
function resetRegistry() {
    rmSync(baseDir(), { recursive: true, force: true });
    rmSync(join(RUNTIME, "pi-better-subagent-workspaces"), { recursive: true, force: true });
    rmSync(join(RUNTIME, "pi-task-scratch-abc123"), { recursive: true, force: true });
}

function sizeSweep(now, maxBytes) {
    rmSync(cleanupStatePath(), { force: true });
    const result = enforceRegistrySizeCapOnce({ now, maxBytes, force: true });
    assert.deepEqual(result.errors, [], "size sweep reports no errors");
    return result;
}

describe("cleanup protects a conversation that a continuation is still using", () => {
    it("keeps an aged released root clone, scratch, and history while a live attempt runs in it", async () => {
        resetRegistry();
        const root = nextRunId();
        const attempt = nextRunId();
        const plain = nextRunId();
        const workspace = taskWorkspaceDir(root);
        const scratch = join(RUNTIME, "pi-task-scratch-abc123");
        mkdirSync(scratch, { recursive: true });
        writeFileSync(join(scratch, "state.txt"), "scratch state\n");
        writeReleasedRoot(root, workspace, { taskScratch: scratch });
        const session = writeSavedSession(root, workspace);
        writeMeta({
            id: plain,
            status: "completed",
            pid: 0,
            spawnPid: 1,
            cwd: RUNTIME,
            promptPreview: "unrelated one-shot",
            startedAt: OLD,
            endedAt: OLD,
            logPath: logPathFor(plain),
            sessionId: plain,
        });
        const child = spawnLiveChild(workspace);
        writeAttempt(root, attempt, workspace, {
            pid: child.pid,
            pidStartTime: processStartToken(child.pid),
        });
        try {
            assert.equal(processExists(child.pid), true, "the child is a real live process");

            sweep(NOW);

            assert.equal(processExists(child.pid), true, "the sweep does not signal the child");
            assert.ok(existsSync(join(workspace, "uncommitted.txt")), "the shared clone survives while the attempt runs");
            assert.ok(existsSync(join(scratch, "state.txt")), "the root-owned task scratch survives");
            assert.ok(existsSync(session), "the saved conversation survives");
            assert.ok(existsSync(runDir(root)), "the released root's metadata and log survive");
            assert.ok(existsSync(runDir(attempt)), "the running attempt survives");
            assert.ok(!existsSync(runDir(plain)), "an unrelated old completed run is still retired");

            // Quiescence: the attempt ends, and the conversation becomes
            // ordinary aged history again.
            await stopChild(child);
            writeAttempt(root, attempt, workspace, {
                status: "completed",
                startedAt: OLD,
                endedAt: OLD,
                pid: 0,
            });

            sweep(NOW + DAY_MS);

            assert.ok(!existsSync(runDir(root)), "after quiescence the released root is retired");
            assert.ok(!existsSync(workspace), "its owned workspace is reclaimed with it");
            assert.ok(!existsSync(scratch), "its owned task scratch is reclaimed with it");
            assert.ok(!existsSync(session), "its saved conversation is reclaimed with it");
            assert.ok(!existsSync(runDir(attempt)), "the completed attempt is retired too");
        } finally {
            await stopChild(child);
        }
    });

    it("keeps the conversation through the admission window, when only the writer lease exists", () => {
        resetRegistry();
        const root = nextRunId();
        const pendingAttempt = nextRunId();
        const workspace = taskWorkspaceDir(root);
        writeReleasedRoot(root, workspace);
        const session = writeSavedSession(root, workspace);
        const lease = acquireConversationLease({ sessionId: root, attemptId: pendingAttempt });
        try {
            assert.equal(readConversationLease(root)?.attemptId, pendingAttempt);
            assert.equal(existsSync(runDir(pendingAttempt)), false, "no attempt metadata is published yet");

            sweep(NOW);

            assert.ok(existsSync(runDir(root)), "the root survives the admission window");
            assert.ok(existsSync(join(workspace, "uncommitted.txt")), "the workspace survives the admission window");
            assert.ok(existsSync(session), "the history the attempt will open survives the admission window");

            lease.release();
            sweep(NOW + DAY_MS);

            assert.ok(!existsSync(runDir(root)), "after the lease is gone the released root is retired");
            assert.ok(!existsSync(workspace), "and its workspace is reclaimed");
        } finally {
            lease.release();
        }
    });

    it("keeps an aged released root while a killed attempt's child is still alive", async () => {
        resetRegistry();
        const root = nextRunId();
        const attempt = nextRunId();
        const workspace = taskWorkspaceDir(root);
        writeReleasedRoot(root, workspace);
        const session = writeSavedSession(root, workspace);
        const child = spawnLiveChild(workspace);
        const pidStartTime = processStartToken(child.pid);
        writeAttempt(root, attempt, workspace, {
            status: "killed",
            pid: child.pid,
            pidStartTime,
            startedAt: OLD,
            endedAt: OLD,
        });
        try {
            sweep(NOW);

            assert.equal(processExists(child.pid), true, "the child outlived the killed record");
            assert.ok(existsSync(join(workspace, "uncommitted.txt")), "the workspace is not removed under a live writer");
            assert.ok(existsSync(session), "the live writer's conversation file is not removed");
            assert.ok(existsSync(runDir(root)), "the root artifacts survive while the writer lives");
            assert.ok(existsSync(runDir(attempt)), "the killed attempt's artifacts survive while its child lives");

            await stopChild(child);
            assert.equal(processExists(child.pid), false);

            sweep(NOW + DAY_MS);

            assert.ok(!existsSync(runDir(root)), "once the child is gone the released root is retired");
            assert.ok(!existsSync(workspace), "and its workspace is reclaimed");
            assert.ok(!existsSync(session), "and its history is reclaimed");
        } finally {
            await stopChild(child);
        }
    });

    it("keeps an unbound dead-holder lease until its detached writer is known quiescent", () => {
        resetRegistry();
        const root = nextRunId();
        const workspace = taskWorkspaceDir(root);
        writeReleasedRoot(root, workspace);
        const script = join(RUNTIME, "lease-holder.mjs");
        writeFileSync(script, `
import { acquireConversationLease } from ${JSON.stringify(join(PACKAGE_DIR, "continuation.ts"))};
acquireConversationLease({ sessionId: process.argv[2], attemptId: process.argv[3] });
`);
        const attempt = nextRunId();
        const holder = spawnSync(
            process.execPath,
            ["--import", "tsx", script, root, attempt],
            { cwd: REPO_ROOT, encoding: "utf-8" },
        );
        assert.equal(holder.status, 0, holder.stderr);
        const stale = readConversationLease(root);
        assert.ok(stale, "the dead holder left its lease behind");
        assert.equal(processExists(stale.pid), false, "the lease names a process that no longer exists");

        sweep(NOW);

        assert.ok(existsSync(runDir(root)), "a supervisor may have died after spawning but before publishing its child");
        assert.ok(existsSync(workspace), "missing writer metadata cannot authorize deletion");
        writeAttempt(root, attempt, workspace, { status: "completed", pid: 0, startedAt: OLD, endedAt: OLD });
        sweep(NOW + DAY_MS);
        assert.ok(!existsSync(runDir(root)), "known quiescent writer metadata permits ordinary cleanup");
        assert.ok(!existsSync(workspace), "a dead holder alone no longer pins proven quiescent work");
    });

    it("protects a validated conversation and its paths for the launching caller", () => {
        resetRegistry();
        // Root A is protected only by the exact paths a resume validated; root B
        // only by its conversation id. Both fields are the contract index passes.
        const byPath = nextRunId();
        const byPathWorkspace = taskWorkspaceDir(byPath);
        writeReleasedRoot(byPath, byPathWorkspace);
        const byPathSession = writeSavedSession(byPath, byPathWorkspace);
        const bySession = nextRunId();
        const bySessionWorkspace = taskWorkspaceDir(bySession);
        writeReleasedRoot(bySession, bySessionWorkspace);

        const protectedSweep = sweep(NOW, {
            sessionIds: [bySession],
            paths: [byPathSession, byPathWorkspace],
        });

        assert.equal(protectedSweep.ran, true);
        assert.ok(existsSync(byPathSession), "an explicitly protected history file survives");
        assert.ok(existsSync(join(byPathWorkspace, "uncommitted.txt")), "a protected workspace is not removed with its run");
        assert.ok(existsSync(runDir(byPath)), "the run owning a protected path survives");
        assert.ok(existsSync(join(bySessionWorkspace, "uncommitted.txt")), "a protected conversation's workspace survives");
        assert.ok(existsSync(runDir(bySession)), "a protected conversation's run survives");

        sweep(NOW + DAY_MS);

        assert.ok(!existsSync(byPathSession), "without the caller's protection the same sweep retires it");
        assert.ok(!existsSync(byPathWorkspace));
        assert.ok(!existsSync(bySessionWorkspace));
    });

    it("exempts an occupied conversation from the size cap, then reclaims it after quiescence", async () => {
        resetRegistry();
        const root = nextRunId();
        const attempt = nextRunId();
        const filler = nextRunId();
        const workspace = taskWorkspaceDir(root);
        writeReleasedRoot(root, workspace);
        // The root's own run directory carries weight, so the byte plan would
        // pick it first: it is the oldest terminal candidate.
        writeFileSync(logPathFor(root), "r".repeat(4096));
        writeMeta({
            id: filler,
            status: "completed",
            pid: 0,
            spawnPid: 1,
            cwd: RUNTIME,
            promptPreview: "reclaimable filler",
            startedAt: OLD + DAY_MS,
            endedAt: OLD + DAY_MS,
            logPath: logPathFor(filler),
            sessionId: filler,
        });
        writeFileSync(logPathFor(filler), "f".repeat(8192));
        const child = spawnLiveChild(workspace);
        writeAttempt(root, attempt, workspace, {
            pid: child.pid,
            pidStartTime: processStartToken(child.pid),
        });
        try {
            const capped = sizeSweep(NOW, 1024);

            assert.ok(capped.removed.includes(filler), "the unprotected terminal filler is reclaimed");
            assert.ok(!capped.remove.includes(root), "the occupied root is never a size-cap candidate");
            assert.equal(capped.overBudget, true, "the cap reports honestly instead of deleting live work");
            assert.ok(existsSync(join(workspace, "uncommitted.txt")), "the running attempt keeps its workspace");
            assert.ok(existsSync(runDir(root)), "the running attempt keeps the root's artifacts");

            await stopChild(child);
            writeAttempt(root, attempt, workspace, {
                status: "completed",
                startedAt: OLD,
                endedAt: OLD,
                pid: 0,
            });

            const after = sizeSweep(NOW + DAY_MS, 1024);

            assert.ok(after.removed.includes(root), "once quiescent the root is reclaimable again");
            assert.ok(!existsSync(workspace), "and its workspace is reclaimed");
            assert.ok(!existsSync(runDir(root)));
        } finally {
            await stopChild(child);
        }
    });
});
