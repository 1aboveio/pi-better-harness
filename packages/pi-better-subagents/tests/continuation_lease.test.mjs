/**
 * Conversation writer lease: one writer while the lease holder is gone.
 *
 * The lease is taken by the supervising pi process, but the process that writes
 * the saved conversation is the detached child it spawned. That child outlives
 * its supervisor, so a dead (or pid-recycled) holder — and a `killed`/`lost`
 * record whose kill has not landed — must not be treated as quiescence.
 *
 * Every case here drives REAL processes: the stale holder is a real node process
 * that acquired the lease through `acquireConversationLease` and exited without
 * releasing it, and the surviving writer is a real live pid recorded on ordinary
 * run metadata. Process start identity is injected only where pid recycling
 * cannot be produced on demand.
 *
 * Recovery must also stay non-destructive: a refused admission leaves the
 * published lease bytes exactly as they were and leaves no temporary file behind.
 *
 * Lease recovery, release, and retention writes are serialized per conversation
 * by a kernel-owned SQLite transaction. The cross-process cases here prove that
 * an admission cannot observe an emptied stale path, that a concurrent refresh
 * cannot revive an acknowledged release, and that a supervisor which dies
 * between spawning its detached child and publishing metadata leaves a lease
 * that ordinary admission refuses: missing metadata cannot prove the child was
 * never spawned. An explicit operator recovery is required for that state.
 *
 * @covers subagent.continuation
 * @level integration
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CONTINUATION_URL = pathToFileURL(join(PACKAGE_DIR, "continuation.ts")).href;

// Hermetic registry: every lease and run directory this file touches lives under
// one per-run temp directory, never the machine registry.
const RUNTIME = mkdtempSync(join(tmpdir(), "subagent-lease-"));
process.env.TMPDIR = RUNTIME;

const {
    ConversationBusyError,
    ConversationLockUnavailableError,
    acquireConversationLease,
    conversationLeaseDir,
    markRetentionReleased,
    readConversationLease,
    readRetention,
    refreshRetentionForAttempt,
    retainConversation,
    retentionDir,
    withConversationMutation,
} = await import("../continuation.ts");
const {
    logPathFor,
    nextRunId,
    processStartToken,
    readMeta,
    removeRunDirectory,
    writeMeta,
} = await import("../registry.ts");
const { killProcessTree, processExists } = await import("../spawn.ts");

const WORKSPACE = join(RUNTIME, "workspace");
mkdirSync(WORKSPACE, { recursive: true });

const workers = new Set();

after(async () => {
    for (const worker of workers) {
        if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
    }
    await Promise.all([...workers].map((worker) => worker.exitCode === null && worker.signalCode === null
        ? once(worker, "exit")
        : undefined));
    rmSync(RUNTIME, { recursive: true, force: true });
});

/** A real live process standing in for the detached writer. */
function spawnWorker() {
    const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    workers.add(worker);
    return worker;
}

/** Wait for a cross-process marker without a foreground monitor loop. */
async function waitUntil(predicate, timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return predicate();
}

/** A cross-process result file is complete only once it parses as JSON. */
function isCompleteJson(path) {
    try {
        JSON.parse(readFileSync(path, "utf-8"));
        return true;
    } catch {
        return false;
    }
}

async function killWorker(worker) {
    if (worker.exitCode === null && worker.signalCode === null) {
        worker.kill("SIGKILL");
        await once(worker, "exit");
    }
    workers.delete(worker);
}

/**
 * Take a lease from a REAL child process that then exits without releasing it,
 * which is exactly what a supervising pi does when it dies mid-attempt. The lease
 * survives at its path with a pid the OS reports as gone.
 */
async function leaseFromDeadHolder(sessionId, attemptId) {
    const script = `import { acquireConversationLease } from ${JSON.stringify(CONTINUATION_URL)};
const lease = acquireConversationLease({ sessionId: ${JSON.stringify(sessionId)}, attemptId: ${JSON.stringify(attemptId)} });
process.stdout.write(JSON.stringify({ pid: process.pid, path: lease.path }));`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: PACKAGE_DIR, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [code] = await once(child, "exit");
    assert.equal(code, 0, `the stale-lease holder must acquire the lease and exit: ${stderr}`);
    const holder = JSON.parse(stdout);
    assert.equal(holder.path, join(conversationLeaseDir(), `${sessionId}.lock`));
    return holder;
}

/** Ordinary run metadata for `attemptId`, as the launch path records it. */
function writeAttempt(attemptId, options) {
    const { status, pid, spawnPid, pidStartTime, sessionId, endedAt } = options;
    writeMeta({
        id: attemptId,
        status,
        pid,
        spawnPid,
        cwd: WORKSPACE,
        promptPreview: "detached writer",
        startedAt: Date.now(),
        logPath: logPathFor(attemptId),
        sessionId,
        ...(pid > 0 ? { pgid: pid } : {}),
        ...(pidStartTime !== undefined ? { pidStartTime } : {}),
        ...(endedAt !== undefined ? { endedAt } : {}),
    });
}

function publishedBytes(leasePath) {
    return readFileSync(leasePath, "utf-8");
}

/** Recovery must never leave a temp file behind, live or stale. */
function assertNoTemporaryLeaseFiles() {
    const leftovers = readdirSync(conversationLeaseDir()).filter((name) => name.startsWith("."));
    assert.deepEqual(leftovers, [], `lease recovery left temporary files behind: ${leftovers.join(", ")}`);
}

function assertBusy(sessionId, attemptId) {
    assert.throws(
        () => acquireConversationLease({ sessionId, attemptId }),
        (error) => error instanceof ConversationBusyError,
    );
}

describe("conversation writer lease across a dead lease holder", () => {
    it("refuses a second writer while the dead holder's detached child is still writing", async () => {
        const sessionId = nextRunId();
        const holderAttempt = nextRunId();
        const worker = spawnWorker();
        try {
            const holder = await leaseFromDeadHolder(sessionId, holderAttempt);
            const leasePath = holder.path;
            const before = publishedBytes(leasePath);
            const staleToken = readConversationLease(sessionId)?.token;
            assert.equal(readConversationLease(sessionId)?.pid, holder.pid);
            // The supervisor is gone, but the attempt it launched still runs: the
            // child, not the lease holder, is the conversation writer.
            writeAttempt(holderAttempt, {
                status: "running",
                pid: worker.pid,
                spawnPid: holder.pid,
                pidStartTime: processStartToken(worker.pid),
                sessionId,
            });

            assertBusy(sessionId, nextRunId());
            assert.equal(publishedBytes(leasePath), before, "a refused admission leaves the published lease untouched");
            const stillPublished = readConversationLease(sessionId);
            assert.equal(stillPublished?.token, staleToken, "the surviving writer keeps its token");
            assert.equal(stillPublished?.attemptId, holderAttempt, "the lease still names the attempt that owns it");
            assertNoTemporaryLeaseFiles();

            // Once the writer is gone, the same lease is recoverable.
            await killWorker(worker);
            const lease = acquireConversationLease({ sessionId, attemptId: nextRunId() });
            try {
                assert.notEqual(lease.token, staleToken, "the new writer owns the path");
                assert.equal(readConversationLease(sessionId)?.attemptId, lease.attemptId);
                assertNoTemporaryLeaseFiles();
            } finally {
                lease.release();
            }
            assert.equal(readConversationLease(sessionId), undefined, "release removes only its own lease");
            assertNoTemporaryLeaseFiles();
        } finally {
            await killWorker(worker);
            removeRunDirectory(holderAttempt);
        }
    });

    it("refuses a second writer when the attempt is recorded killed or lost but its child is still alive", async () => {
        for (const status of ["killed", "lost"]) {
            const sessionId = nextRunId();
            const holderAttempt = nextRunId();
            const worker = spawnWorker();
            try {
                const holder = await leaseFromDeadHolder(sessionId, holderAttempt);
                writeAttempt(holderAttempt, {
                    status,
                    pid: worker.pid,
                    spawnPid: holder.pid,
                    pidStartTime: processStartToken(worker.pid),
                    sessionId,
                    endedAt: Date.now(),
                });

                // Terminal metadata is not quiescence: the recorded child still runs.
                assertBusy(sessionId, nextRunId());

                await killWorker(worker);
                const lease = acquireConversationLease({ sessionId, attemptId: nextRunId() });
                lease.release();
                assert.equal(readConversationLease(sessionId), undefined);
                assertNoTemporaryLeaseFiles();
            } finally {
                await killWorker(worker);
                removeRunDirectory(holderAttempt);
            }
        }
    });

    it("recovers only when writer absence is proven, and never from missing metadata", async () => {
        const gonePid = spawnWorker();
        await killWorker(gonePid);
        const recycled = spawnWorker();
        try {
            // A dead holder whose attempt's child is also dead: recover.
            const deadSession = nextRunId();
            const deadAttempt = nextRunId();
            await leaseFromDeadHolder(deadSession, deadAttempt);
            writeAttempt(deadAttempt, {
                status: "running",
                pid: gonePid.pid,
                spawnPid: 1,
                pidStartTime: "start-token-of-the-dead-writer",
                sessionId: deadSession,
            });
            const afterDeadWriter = acquireConversationLease({ sessionId: deadSession, attemptId: nextRunId() });
            afterDeadWriter.release();
            removeRunDirectory(deadAttempt);

            // No attempt record at all: a supervisor can die between spawning its
            // detached child and publishing metadata, so this is NOT quiescence.
            // Ordinary admission refuses; only an explicit operator recovery may
            // abandon the unverifiable writer.
            const orphanSession = nextRunId();
            const orphanAttempt = nextRunId();
            const orphanHolder = await leaseFromDeadHolder(orphanSession, orphanAttempt);
            assertBusy(orphanSession, nextRunId());
            assert.equal(readConversationLease(orphanSession)?.pid, orphanHolder.pid, "the unverifiable lease is preserved");
            const afterNoRecord = acquireConversationLease({
                sessionId: orphanSession,
                attemptId: nextRunId(),
                explicitRecovery: true,
            });
            afterNoRecord.release();
            assert.equal(readConversationLease(orphanSession), undefined);

            // A live pid that is not the recorded writer (pid recycled): recover.
            const recycledSession = nextRunId();
            const recycledAttempt = nextRunId();
            await leaseFromDeadHolder(recycledSession, recycledAttempt);
            writeAttempt(recycledAttempt, {
                status: "running",
                pid: recycled.pid,
                spawnPid: 1,
                pidStartTime: "start-token-before-recycling",
                sessionId: recycledSession,
            });
            const afterRecycled = acquireConversationLease({
                sessionId: recycledSession,
                attemptId: nextRunId(),
                probe: { startToken: (pid) => pid === recycled.pid ? "start-token-after-recycling" : undefined },
            });
            afterRecycled.release();
            removeRunDirectory(recycledAttempt);

            for (const sessionId of [deadSession, orphanSession, recycledSession]) {
                assert.equal(readConversationLease(sessionId), undefined);
            }
            assertNoTemporaryLeaseFiles();
            assert.equal(readMeta(deadAttempt), undefined, "fixtures are removed, not left in the registry");
        } finally {
            await killWorker(recycled);
        }
    });
});

describe("serialized conversation mutations across real processes", () => {
    it("admits exactly one of two processes reclaiming the same stale lease", async () => {
        const sessionId = nextRunId();
        const staleAttempt = nextRunId();
        await leaseFromDeadHolder(sessionId, staleAttempt);
        writeAttempt(staleAttempt, { status: "completed", pid: 0, spawnPid: 1, sessionId });
        const contenders = [0, 1].map((index) => ({
            id: `contender-${index}`,
            result: join(RUNTIME, `${sessionId}.contender-${index}.json`),
        }));
        const children = contenders.map((contender) => {
            const script = join(RUNTIME, `${sessionId}.${contender.id}.mjs`);
            writeFileSync(script, `
import fs from 'node:fs';
const { acquireConversationLease } = await import(${JSON.stringify(CONTINUATION_URL)});
try {
  const lease = acquireConversationLease({ sessionId: ${JSON.stringify(sessionId)}, attemptId: ${JSON.stringify(contender.id)} });
  fs.writeFileSync(${JSON.stringify(contender.result)}, JSON.stringify({ ok: true, token: lease.token, pid: process.pid }));
  setInterval(() => {}, 1000);
} catch (error) {
  fs.writeFileSync(${JSON.stringify(contender.result)}, JSON.stringify({ ok: false, name: error.name }));
}
`);
            const child = spawn(process.execPath, ["--import", "tsx", script], {
                cwd: PACKAGE_DIR, env: process.env, stdio: "ignore",
            });
            workers.add(child);
            return child;
        });
        let recovered;
        try {
            assert.ok(
                await waitUntil(() => contenders.every((contender) => isCompleteJson(contender.result))),
                "both contenders must report an admission decision",
            );
            const results = contenders.map((contender) => JSON.parse(readFileSync(contender.result, "utf-8")));
            const winners = results.filter((result) => result.ok);
            const refused = results.filter((result) => !result.ok);
            assert.equal(winners.length, 1, `exactly one writer may win: ${JSON.stringify(results)}`);
            assert.equal(refused.length, 1);
            assert.equal(refused[0].name, ConversationBusyError.name);
            assert.equal(readConversationLease(sessionId)?.token, winners[0].token);
            assert.equal(readConversationLease(sessionId)?.pid, winners[0].pid);

            for (const child of children) await killWorker(child);
            // The winning contender exits without metadata; its lease is unknown
            // evidence and needs the explicit operator escape to clear.
            assertBusy(sessionId, nextRunId());
            recovered = acquireConversationLease({ sessionId, attemptId: nextRunId(), explicitRecovery: true });
            recovered.release();
            assert.equal(readConversationLease(sessionId), undefined);
        } finally {
            for (const child of children) await killWorker(child);
            recovered?.release();
            removeRunDirectory(staleAttempt);
        }
    });

    it("serializes an atomic stale-lease replacement against another admission", async () => {
        const sessionId = nextRunId();
        const staleAttempt = nextRunId();
        const leasePath = join(conversationLeaseDir(), `${sessionId}.lock`);
        const ready = join(RUNTIME, `${sessionId}.reclaim-ready`);
        const go = join(RUNTIME, `${sessionId}.reclaim-go`);
        const done = join(RUNTIME, `${sessionId}.reclaim-done`);
        const script = join(RUNTIME, "stale-reclaimer.mjs");
        writeFileSync(script, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const leasePath = ${JSON.stringify(leasePath)};
const ready = ${JSON.stringify(ready)};
const go = ${JSON.stringify(go)};
const done = ${JSON.stringify(done)};
const wait = (file) => {
  const deadline = Date.now() + 8000;
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(file) && Date.now() < deadline) Atomics.wait(buffer, 0, 0, 10);
  if (!fs.existsSync(file)) throw new Error('barrier timeout: ' + file);
};
        const rename = fs.renameSync;
        let intercepted = false;
        fs.renameSync = (from, to, ...args) => {
          if (!intercepted && to === leasePath) {
            intercepted = true;
            fs.writeFileSync(ready, 'ready');
            wait(go);
          }
          return rename(from, to, ...args);
        };
syncBuiltinESMExports();
const { acquireConversationLease } = await import(${JSON.stringify(CONTINUATION_URL)});
try {
  const lease = acquireConversationLease({ sessionId: ${JSON.stringify(sessionId)}, attemptId: 'reclaimer' });
  fs.writeFileSync(done, JSON.stringify({ token: lease.token, pid: process.pid }));
  setInterval(() => {}, 1000);
} catch (error) {
  fs.writeFileSync(done, JSON.stringify({ error: error.name, message: error.message }));
}
`);
        // A real dead holder leaves a lease that is reclaimable by evidence: the
        // named attempt completed and its recorded writer is gone.
        const staleHolder = await leaseFromDeadHolder(sessionId, staleAttempt);
        writeAttempt(staleAttempt, { status: "completed", pid: 0, spawnPid: 1, sessionId });
        const reclaimer = spawn(process.execPath, ["--import", "tsx", script], {
            cwd: PACKAGE_DIR, env: process.env, stdio: "ignore",
        });
        workers.add(reclaimer);
        let recovered;
        try {
            assert.ok(await waitUntil(() => existsSync(ready)), "the reclaimer must reach the replacement point");
            assert.equal(
                readConversationLease(sessionId)?.pid,
                staleHolder.pid,
                "the stale lease stays published until its atomic replacement",
            );

            // The original defect admitted a holder here. The kernel transaction
            // makes that observation impossible: admission fails closed instead of
            // interleaving with the replacement.
            assertBusy(sessionId, nextRunId());
            assert.equal(
                readConversationLease(sessionId)?.pid,
                staleHolder.pid,
                "a refused admission leaves the stale lease untouched",
            );

            writeFileSync(go, "go");
            assert.ok(await waitUntil(() => isCompleteJson(done)), "the reclaimer must publish its lease");
            const result = JSON.parse(readFileSync(done, "utf-8"));
            assert.equal(result.error, undefined, `reclaimer failed: ${result.message}`);
            assert.equal(result.pid, reclaimer.pid);
            const published = readConversationLease(sessionId);
            assert.equal(published?.token, result.token);
            assert.equal(published?.pid, reclaimer.pid);

            // A live reclaimer without attempt metadata is still a live holder.
            assertBusy(sessionId, nextRunId());
            assert.throws(
                () => acquireConversationLease({ sessionId, attemptId: nextRunId(), explicitRecovery: true }),
                (error) => error instanceof ConversationBusyError,
                "explicit recovery never steals a live holder's lease",
            );
            await killWorker(reclaimer);
            // Dead holder, still no metadata: the child it may have spawned cannot
            // be excluded, so ordinary admission stays closed.
            assertBusy(sessionId, nextRunId());
            recovered = acquireConversationLease({
                sessionId,
                attemptId: nextRunId(),
                explicitRecovery: true,
            });
            assert.equal(readConversationLease(sessionId)?.attemptId, recovered.attemptId);
            assertNoTemporaryLeaseFiles();
        } finally {
            await killWorker(reclaimer);
            recovered?.release();
            removeRunDirectory(staleAttempt);
        }
    });

    it("refuses a second writer when a supervisor dies after spawning its detached child", async () => {
        const sessionId = nextRunId();
        const deadAttempt = nextRunId();
        const marker = join(RUNTIME, `${sessionId}.crash-marker.json`);
        const script = join(RUNTIME, "crash-parent.mjs");
        writeFileSync(script, `
import { writeFileSync } from 'node:fs';
import { acquireConversationLease } from ${JSON.stringify(CONTINUATION_URL)};
import { spawnDetached } from ${JSON.stringify(pathToFileURL(join(PACKAGE_DIR, "spawn.ts")).href)};
acquireConversationLease({ sessionId: ${JSON.stringify(sessionId)}, attemptId: ${JSON.stringify(deadAttempt)} });
const child = spawnDetached({
  file: process.execPath,
  fileArgs: ['-e', 'setInterval(() => {}, 1000)'],
  cwd: ${JSON.stringify(WORKSPACE)},
  logPath: ${JSON.stringify(join(RUNTIME, "crash-child.log"))},
});
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ parent: process.pid, child: child.pid }));
process.kill(process.pid, 'SIGKILL');
`);
        const parent = spawn(process.execPath, ["--import", "tsx", script], {
            cwd: PACKAGE_DIR, env: process.env, stdio: "ignore",
        });
        await once(parent, "exit");
        const { parent: deadParent, child: childPid } = JSON.parse(readFileSync(marker, "utf-8"));
        let writer;
        try {
            assert.ok(await waitUntil(() => processExists(childPid)), "the detached writer must survive its supervisor");
            assert.equal(readMeta(deadAttempt), undefined, "the crash happened before the first metadata publication");
            assert.equal(readConversationLease(sessionId)?.pid, deadParent, "the dead supervisor still holds the lease");

            // Missing metadata cannot prove the child was never spawned.
            assertBusy(sessionId, nextRunId());
            assert.equal(readConversationLease(sessionId)?.pid, deadParent, "the unverifiable lease is preserved");

            const recovered = acquireConversationLease({
                sessionId,
                attemptId: nextRunId(),
                explicitRecovery: true,
            });
            writer = recovered;
            assert.equal(readConversationLease(sessionId)?.attemptId, recovered.attemptId);
        } finally {
            killProcessTree(childPid, "SIGKILL");
            await waitUntil(() => !processExists(childPid));
            writer?.release();
            removeRunDirectory(deadAttempt);
        }
    });

    it("preserves an acknowledged retention release against a concurrent refresh", async () => {
        const sessionId = nextRunId();
        const retentionFile = join(retentionDir(), `${sessionId}.json`);
        const ready = join(RUNTIME, `${sessionId}.release-ready`);
        const go = join(RUNTIME, `${sessionId}.release-go`);
        const done = join(RUNTIME, `${sessionId}.release-done`);
        const script = join(RUNTIME, "retention-releaser.mjs");
        retainConversation({
            sessionId,
            ownerRunId: sessionId,
            workspace: WORKSPACE,
            ownerOrigin: { cwd: WORKSPACE, sessionId: "owner-session" },
            attemptId: sessionId,
        });
        writeFileSync(script, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const retentionFile = ${JSON.stringify(retentionFile)};
const ready = ${JSON.stringify(ready)};
const go = ${JSON.stringify(go)};
const done = ${JSON.stringify(done)};
const wait = (file) => {
  const deadline = Date.now() + 8000;
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(file) && Date.now() < deadline) Atomics.wait(buffer, 0, 0, 10);
  if (!fs.existsSync(file)) throw new Error('barrier timeout: ' + file);
};
const rename = fs.renameSync;
let intercepted = false;
fs.renameSync = (from, to, ...args) => {
  const result = rename(from, to, ...args);
  if (!intercepted && to === retentionFile) {
    intercepted = true;
    fs.writeFileSync(ready, 'ready');
    wait(go);
  }
  return result;
};
syncBuiltinESMExports();
const { readRetention, markRetentionReleased } = await import(${JSON.stringify(CONTINUATION_URL)});
const released = markRetentionReleased(readRetention(${JSON.stringify(sessionId)}), ${JSON.stringify({ cwd: WORKSPACE, sessionId: "owner-session" })}, 123456789);
fs.writeFileSync(done, JSON.stringify({ releasedAt: released.releasedAt }));
`);
        const releaser = spawn(process.execPath, ["--import", "tsx", script], {
            cwd: PACKAGE_DIR, env: process.env, stdio: "ignore",
        });
        workers.add(releaser);
        try {
            assert.ok(await waitUntil(() => existsSync(ready)), "the release must publish while it holds the lock");
            assert.equal(readRetention(sessionId)?.releasedAt, 123456789, "release is durable before the lock is dropped");
            assert.throws(
                () => refreshRetentionForAttempt({ sessionId, attemptId: nextRunId() }),
                (error) => error instanceof ConversationBusyError,
                "a concurrent refresh must not enter while release is open",
            );
            assert.equal(readRetention(sessionId)?.releasedAt, 123456789);

            writeFileSync(go, "go");
            assert.ok(await waitUntil(() => isCompleteJson(done)), "the releaser must finish");
            await killWorker(releaser);
            assert.equal(JSON.parse(readFileSync(done, "utf-8")).releasedAt, 123456789);
            assert.equal(refreshRetentionForAttempt({ sessionId, attemptId: nextRunId() }), undefined);
            assert.equal(readRetention(sessionId)?.releasedAt, 123456789, "a later refresh cannot revive the release");
        } finally {
            await killWorker(releaser);
            rmSync(retentionFile, { force: true });
        }
    });

    it("releases the transaction before the child lifetime and fails closed without node:sqlite", async () => {
        const sessionId = nextRunId();
        const lease = acquireConversationLease({ sessionId, attemptId: nextRunId() });
        try {
            assert.equal(withConversationMutation(sessionId, () => "unlocked"), "unlocked", "admission holds only its mutation");
            retainConversation({
                sessionId,
                ownerRunId: sessionId,
                workspace: WORKSPACE,
                ownerOrigin: { cwd: WORKSPACE, sessionId: "owner-session" },
                attemptId: sessionId,
            });
            const refreshedAttempt = nextRunId();
            assert.equal(
                refreshRetentionForAttempt({ sessionId, attemptId: refreshedAttempt })?.lastAttemptId,
                refreshedAttempt,
            );
        } finally {
            lease.release();
            rmSync(join(retentionDir(), `${sessionId}.json`), { force: true });
        }
        assert.throws(
            () => withConversationMutation(sessionId, () => { throw new Error("body failed"); }),
            /body failed/,
        );
        assert.equal(
            withConversationMutation(sessionId, () => "lock released after an error"),
            "lock released after an error",
        );

        const script = join(RUNTIME, "without-sqlite.mjs");
        writeFileSync(script, `
const { acquireConversationLease, retainConversation } = await import(${JSON.stringify(CONTINUATION_URL)});
const failures = [];
for (const run of [
  () => acquireConversationLease({ sessionId: ${JSON.stringify(sessionId)}, attemptId: 'no-sqlite' }),
  () => retainConversation({
    sessionId: ${JSON.stringify(sessionId)},
    ownerRunId: ${JSON.stringify(sessionId)},
    workspace: ${JSON.stringify(WORKSPACE)},
    ownerOrigin: { cwd: ${JSON.stringify(WORKSPACE)}, sessionId: 'owner-session' },
    attemptId: 'no-sqlite',
  }),
]) {
  try { run(); failures.push('admitted'); } catch (error) { failures.push(error.name); }
}
process.stdout.write(JSON.stringify(failures));
`);
        // On runtimes where the negation flag is unknown, node:sqlite is not
        // available by default either, so the same prerequisite path applies.
        const disableSqlite = spawnSync(process.execPath, ["--no-experimental-sqlite", "-e", "0"]).status === 0
            ? ["--no-experimental-sqlite"]
            : [];
        const child = spawn(process.execPath, [...disableSqlite, "--import", "tsx", script], {
            cwd: PACKAGE_DIR, env: process.env, stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        const [code] = await once(child, "exit");
        assert.equal(code, 0, `the no-sqlite child must report and exit cleanly: ${stderr}`);
        assert.deepEqual(JSON.parse(stdout), [
            ConversationLockUnavailableError.name,
            ConversationLockUnavailableError.name,
        ]);
        assert.equal(readConversationLease(sessionId), undefined, "no lease is published without the kernel lock");
        assert.equal(readRetention(sessionId), undefined, "no retention write happens without the kernel lock");
    });
});
