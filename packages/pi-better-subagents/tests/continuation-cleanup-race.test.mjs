/**
 * Cleanup/admission race in the managed-continuation surface
 * (#owner-continuation, final review: lifetime closure).
 *
 * `runDailyCleanupOnce` and `enforceRegistrySizeCapOnce` both snapshot occupancy
 * and then delete. Continuation made the root's workspace, task scratch, and
 * saved history outlive the attempt that created them, and an attempt is
 * admitted by a DIFFERENT process, so "protected at snapshot time" is not the
 * same as "protected at removal time": another process can publish a writer
 * lease and spawn a writer between the snapshot and the deletion.
 *
 * Every case here drives REAL processes and a REAL fs boundary seam:
 *
 * 1. A separate node process runs the actual sweep and pauses inside it at the
 *    first point after its occupancy/plan snapshot (the second read of the
 *    candidate's `meta.json`, which both sweeps perform after planning and
 *    before removing).
 * 2. While it is paused, this process takes the conversation's writer lease
 *    through the real `acquireConversationLease` — a successful new admission.
 * 3. The sweep is released and must retain the conversation it planned to
 *    delete.
 *
 * The same seam proves the launch side: a continuation revalidates the native
 * history identity AFTER it holds the lease, so a history another process
 * removed between validation and admission refuses explicitly instead of
 * letting `--session` reopen (or silently replace) a conversation that is gone.
 *
 * @covers subagent.continuation
 * @level integration
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs, {
    existsSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { register, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(dirname(PACKAGE_DIR));
const CLEANUP_URL = pathToFileURL(join(PACKAGE_DIR, "cleanup.ts")).href;

// Hermetic registry: every path this file touches lives under one temp root,
// made canonical up front so `baseDir()`, `taskWorkspaceDir()`, and the task
// scratch path all agree (registry resolves the temp root with realpath).
const RUNTIME = mkdtempSync(join(realpathSync(tmpdir()), "subagent-cleanup-race-"));
process.env.TMPDIR = RUNTIME;
process.env.TMP = RUNTIME;
process.env.TEMP = RUNTIME;
process.env.PI_SANDBOX_RECOVERY_SNAPSHOT = "off";

// A fake `pi` child on PATH: the launch path resolves it with `which pi`, and no
// case here needs a model or a real child. It publishes the one lifecycle event
// finalization needs and exits successfully.
const binDir = mkdtempSync(join(RUNTIME, "fake-bin-"));
const fakePiPath = join(binDir, "pi");
writeFileSync(fakePiPath, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "DONE" }] }] }) + "\\n");
process.exit(0);
`);
fs.chmodSync(fakePiPath, 0o755);
const originalPath = process.env.PATH ?? "";
process.env.PATH = `${binDir}:${originalPath}`;

register(new URL("./pi_host_stub_hooks.mjs", import.meta.url));

const { default: betterSubagents } = await import("../index.ts");
const {
    cleanupStatePath,
    enforceRegistrySizeCapOnce,
    runDailyCleanupOnce,
} = await import("../cleanup.ts");
const {
    baseDir,
    listMetas,
    logPathFor,
    nextRunId,
    readMeta,
    runDir,
    sessionsDir,
    taskWorkspaceDir,
    writeMeta,
} = await import("../registry.ts");
const {
    acquireConversationLease,
    conversationLeaseDir,
    markRetentionReleased,
    readConversationLease,
    retainConversation,
} = await import("../continuation.ts");
const { killProcessTree } = await import("../spawn.ts");

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);
const OLD = NOW - 20 * DAY_MS;
const OWNER_ORIGIN = { cwd: RUNTIME, sessionId: "owner-session" };

const children = new Set();
const realFs = { readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync };

after(() => {
    for (const child of children) {
        try { killProcessTree(child.pid, "SIGKILL"); } catch { /* already gone */ }
    }
    process.env.PATH = originalPath;
    rmSync(RUNTIME, { recursive: true, force: true });
});

/** Wait for a cross-process marker without a foreground polling loop. */
async function waitUntil(predicate, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return predicate();
}

/** The sweep process pauses where its snapshot ends and the deletion begins. */
const SWEEP_SOURCE = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const [kind, metaPath, ready, go, done] = process.argv.slice(2);
const waitForFile = (file) => {
    const buffer = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(file)) {
        if (Date.now() > deadline) throw new Error("barrier timeout: " + file);
        Atomics.wait(buffer, 0, 0, 10);
    }
};

// Boundary seam: BOTH sweeps read the candidate's meta.json once while they
// snapshot and again when they are about to remove it. Pausing on the second
// read is pausing with the plan already made and nothing deleted yet.
const realReadFileSync = fs.readFileSync;
let reads = 0;
fs.readFileSync = (path, ...args) => {
    if (path === metaPath) {
        reads += 1;
        if (reads === 2) {
            fs.writeFileSync(ready, "ready");
            waitForFile(go);
        }
    }
    return realReadFileSync(path, ...args);
};
syncBuiltinESMExports();

const cleanup = await import(${JSON.stringify(CLEANUP_URL)});
const now = Number(process.env.RACE_NOW);
const protect = process.env.RACE_PROTECT ? JSON.parse(process.env.RACE_PROTECT) : undefined;
const result = kind === "daily"
    ? cleanup.runDailyCleanupOnce({ now, ...(protect ? { protect } : {}) })
    : cleanup.enforceRegistrySizeCapOnce({
        now,
        maxBytes: Number(process.env.RACE_MAX_BYTES),
        force: true,
        ...(protect ? { protect } : {}),
    });
fs.writeFileSync(done, JSON.stringify({ reads, result }));
`;

/**
 * Run one real sweep in another process; when it has planned but not yet
 * deleted, admit a writer for `sessionId` from this process, then let it finish.
 */
async function sweepAcrossAdmission(options) {
    const { kind, metaPath, sessionId, maxBytes, protect } = options;
    const label = `${sessionId}.${kind}`;
    const ready = join(RUNTIME, `${label}.ready`);
    const go = join(RUNTIME, `${label}.go`);
    const done = join(RUNTIME, `${label}.done`);
    const script = join(RUNTIME, `${label}.sweep.mjs`);
    writeFileSync(script, SWEEP_SOURCE);

    const child = spawn(process.execPath, ["--import", "tsx", script, kind, metaPath, ready, go, done], {
        cwd: REPO_ROOT,
        env: {
            ...process.env,
            RACE_NOW: String(NOW),
            RACE_MAX_BYTES: String(maxBytes ?? 0),
            ...(protect ? { RACE_PROTECT: JSON.stringify(protect) } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    let lease;
    try {
        assert.ok(
            await waitUntil(() => existsSync(ready)),
            `the sweep never reached its post-snapshot boundary (exit ${child.exitCode}): ${stderr}`,
        );
        // A successful new admission, taken while the sweep is paused and lost.
        lease = acquireConversationLease({ sessionId, attemptId: nextRunId() });
        assert.equal(readConversationLease(sessionId)?.sessionId, sessionId, "the admitted lease is published");
    } finally {
        writeFileSync(go, "go");
    }

    try {
        assert.ok(await waitUntil(() => existsSync(done)), `the sweep never finished (exit ${child.exitCode}): ${stderr}`);
        if (child.exitCode === null) await once(child, "exit");
        assert.equal(child.exitCode, 0, `the sweep process failed: ${stderr}`);
        return { ...JSON.parse(realFs.readFileSync(done, "utf-8")), lease };
    } finally {
        children.delete(child);
        if (child.exitCode === null) child.kill("SIGKILL");
    }
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
    mkdirSync(sessionsDir(), { recursive: true });
    const path = join(sessionsDir(), `2026-01-01T00-00-00-000Z_${root}.jsonl`);
    writeFileSync(
        path,
        `${JSON.stringify({ type: "session", version: 1, id: root, timestamp: "2026-01-01T00:00:00.000Z", cwd: workspace })}\n`,
    );
    utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
    return path;
}

/** Fresh registry for one test: the same temp root, none of the last test's records. */
function resetRegistry() {
    rmSync(baseDir(), { recursive: true, force: true });
    rmSync(join(RUNTIME, "pi-better-subagent-workspaces"), { recursive: true, force: true });
}

describe("a sweep cannot delete a conversation admitted after its snapshot", () => {
    it("age sweep retains the shared workspace and history of a conversation admitted mid-sweep", async () => {
        resetRegistry();
        const root = nextRunId();
        const workspace = taskWorkspaceDir(root);
        writeReleasedRoot(root, workspace);
        const session = writeSavedSession(root, workspace);
        // Unrelated aged history a sweep must keep retiring, and a conversation
        // this sweep must keep only because the caller protected it.
        const plain = nextRunId();
        const plainCwd = join(RUNTIME, "plain-workspace");
        mkdirSync(plainCwd, { recursive: true });
        writeMeta({
            id: plain,
            status: "completed",
            pid: 0,
            spawnPid: 1,
            cwd: plainCwd,
            promptPreview: "unrelated one-shot",
            startedAt: OLD,
            endedAt: OLD,
            logPath: logPathFor(plain),
            sessionId: plain,
        });
        const kept = nextRunId();
        const keptWorkspace = taskWorkspaceDir(kept);
        writeReleasedRoot(kept, keptWorkspace);
        const keptSession = writeSavedSession(kept, keptWorkspace);

        const { reads, result, lease } = await sweepAcrossAdmission({
            kind: "daily",
            metaPath: join(runDir(root), "meta.json"),
            sessionId: root,
            protect: { sessionIds: [kept], paths: [keptSession] },
        });
        try {
            assert.equal(reads >= 2, true, "the seam fired where the sweep had planned and not yet deleted");
            assert.deepEqual(result.errors, [], "the sweep reports no errors");
            assert.equal(result.removedRunDirs, 1, "only the unrelated run is retired, not the admitted conversation");
            assert.equal(result.removedSessionPaths, 0, "no tracked history is retired");
            assert.ok(existsSync(runDir(root)), "the root's metadata and log survive the admission");
            assert.ok(existsSync(join(workspace, "uncommitted.txt")), "the shared workspace the attempt will use survives");
            assert.ok(existsSync(session), "the saved history the attempt will open survives");
            assert.ok(!existsSync(runDir(plain)), "unrelated aged history is still retired");
            assert.ok(existsSync(runDir(kept)), "the caller's protected conversation is still protected");
            assert.ok(existsSync(join(keptWorkspace, "uncommitted.txt")), "its workspace is still protected");
            assert.ok(existsSync(keptSession), "the caller's protected paths are still protected");
        } finally {
            lease.release();
        }

        // Not stranded: once the writer is gone the same sweep retires it.
        rmSync(cleanupStatePath(), { force: true });
        const after = runDailyCleanupOnce({ now: NOW + DAY_MS });
        assert.deepEqual(after.errors, []);
        assert.equal(after.removedRunDirs, 2, "a quiescent conversation is ordinary aged history again");
        assert.ok(!existsSync(runDir(root)));
        assert.ok(!existsSync(workspace), "its owned workspace is reclaimed");
        assert.ok(!existsSync(session), "its saved history is reclaimed");
        assert.ok(!existsSync(keptSession), "the released caller protection stops applying after the call");
    });

    it("size sweep keeps an occupied root out of the plan's removals and reports the shortfall", async () => {
        resetRegistry();
        const root = nextRunId();
        const workspace = taskWorkspaceDir(root);
        writeReleasedRoot(root, workspace);
        const session = writeSavedSession(root, workspace);
        writeFileSync(logPathFor(root), "r".repeat(64 * 1024));

        const { result, lease } = await sweepAcrossAdmission({
            kind: "cap",
            metaPath: join(runDir(root), "meta.json"),
            sessionId: root,
            maxBytes: 1024,
        });
        try {
            assert.deepEqual(result.errors, [], "the sweep reports no errors");
            assert.ok(!result.removed.includes(root), "the newly occupied root is not removed");
            assert.equal(result.overBudget, true, "the shortfall is reported instead of deleting live work");
            assert.ok(existsSync(runDir(root)), "the root's artifacts survive the admission");
            assert.ok(existsSync(join(workspace, "uncommitted.txt")), "the workspace survives the admission");
            assert.ok(existsSync(session), "the saved history survives the admission");
        } finally {
            lease.release();
        }

        rmSync(cleanupStatePath(), { force: true });
        const after = enforceRegistrySizeCapOnce({ now: NOW + DAY_MS, maxBytes: 1024, force: true });
        assert.deepEqual(after.errors, []);
        assert.ok(after.removed.includes(root), "once quiescent the root is reclaimable again");
        assert.ok(!existsSync(workspace));
    });
});

// ---- launch side: history identity is re-proved under the lease ------------

const WORKSPACE = join(RUNTIME, "workspace");
mkdirSync(WORKSPACE, { recursive: true });

function makeHarness() {
    const tools = new Map();
    const handlers = new Map();
    const pi = {
        events: new EventEmitter(),
        registerTool: (definition) => tools.set(definition.name, definition),
        registerCommand: () => {},
        appendEntry: () => {},
        on: (event, handler) => handlers.set(event, handler),
        sendMessage: () => {},
    };
    const ctx = {
        cwd: WORKSPACE,
        model: { provider: "test", id: "model" },
        hasUI: false,
        isIdle: () => true,
        ui: { notify() {}, setWidget() {} },
        sessionManager: { getSessionId: () => "owner-session", getBranch: () => [] },
    };
    betterSubagents(pi);
    return { tools, handlers, ctx };
}

async function waitTerminal(id) {
    const meta = await waitUntil(() => {
        const current = readMeta(id);
        return current && current.status !== "running" && current.status !== "orphaned";
    }) ? readMeta(id) : undefined;
    assert.ok(meta, `run ${id} never reached a terminal status`);
    return meta;
}

function idOf(result) {
    const text = result.content[0].text;
    const match = text.match(/id=(\S+)/);
    assert.ok(match, `no run id in tool output: ${text}`);
    return match[1];
}

describe("a continuation re-proves its native history under the writer lease", () => {
    it("refuses when another process removes the saved conversation after validation", async () => {
        resetRegistry();
        const h = makeHarness();
        const spawned = idOf(await h.tools.get("subagent_spawn").execute("tc", {
            prompt: "INITIAL TASK", clean: true, sandbox: false, cwd: WORKSPACE, retain_session: true,
        }, undefined, undefined, h.ctx));
        await waitTerminal(spawned);
        // The saved conversation a continuation reopens, written where Pi writes it.
        const sessionPath = join(sessionsDir(), `2026-01-01T00-00-00-000Z_${spawned}.jsonl`);
        writeFileSync(
            sessionPath,
            `${JSON.stringify({ type: "session", version: 1, id: spawned, timestamp: "2026-01-01T00:00:00.000Z", cwd: WORKSPACE })}\n`,
        );

        // Boundary seam: the removing process is real, and it deletes the history
        // while this process is inside admission — after `planContinuation`
        // validated it and after the writer lease is taken.
        const leasePath = join(conversationLeaseDir(), `${spawned}.lock`);
        const removeNow = join(RUNTIME, "history-remove.go");
        // A real, non-cooperating remover: temp-storage reaping or a sweep that
        // won the ordering. It deletes the validated history behind the launch.
        const deleter = spawn(process.execPath, ["-e", `
const fs = require("node:fs");
const [go, target] = process.argv.slice(1);
const buffer = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 15000;
while (!fs.existsSync(go)) {
    if (Date.now() > deadline) process.exit(2);
    Atomics.wait(buffer, 0, 0, 5);
}
fs.rmSync(target, { force: true });
`, removeNow, sessionPath], { stdio: "ignore" });
        children.add(deleter);

        const realReadFileSync = fs.readFileSync;
        let intercepted = false;
        fs.readFileSync = (path, ...args) => {
            if (!intercepted && path === leasePath) {
                intercepted = true;
                // The history disappears while this launch is inside admission —
                // after `planContinuation` validated it.
                fs.writeFileSync(removeNow, "go");
                const buffer = new Int32Array(new SharedArrayBuffer(4));
                const deadline = Date.now() + 15000;
                while (fs.existsSync(sessionPath)) {
                    if (Date.now() > deadline) throw new Error("the removing process never removed the history");
                    Atomics.wait(buffer, 0, 0, 5);
                }
            }
            return realReadFileSync(path, ...args);
        };
        syncBuiltinESMExports();
        try {
            await assert.rejects(
                h.tools.get("subagent_resume").execute("tc", { id: spawned, prompt: "FOLLOWUP" }, undefined, undefined, h.ctx),
                /saved conversation is gone/,
                "a history removed after validation must refuse explicitly",
            );
        } finally {
            fs.readFileSync = realReadFileSync;
            syncBuiltinESMExports();
            if (deleter.exitCode === null) deleter.kill("SIGKILL");
            children.delete(deleter);
        }

        assert.equal(intercepted, true, "the seam fired inside the writer admission");
        assert.equal(existsSync(sessionPath), false, "the history really was removed");
        assert.equal(
            listMetas().filter((meta) => meta.sessionId === spawned).length,
            1,
            "no second attempt was published for a conversation whose history is gone",
        );
        assert.equal(readConversationLease(spawned), undefined, "the refused launch released its lease");
        assert.equal(
            readdirRuns().some((id) => id !== spawned),
            false,
            "the refused launch left no run directory behind",
        );
    });
});

function readdirRuns() {
    try {
        return fs.readdirSync(join(baseDir(), "runs"));
    } catch {
        return [];
    }
}
