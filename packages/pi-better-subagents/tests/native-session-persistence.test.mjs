/**
 * Durable native-session persistence for ordinary launches.
 *
 * A subagent's conversation is an ordinary Pi session file. It used to live in
 * the volatile runtime registry under `os.tmpdir()`, so changing TMPDIR, a full
 * restart, or the age/size sweeps could strand a completed attempt's history and
 * launch recipe even though nothing about the user's request asked for a
 * disposable session. This suite pins the direct-storage contract:
 *
 * - a NEW child session directory is the durable Pi agent directory
 *   (`<PI_CODING_AGENT_DIR>/subagents/sessions`, honored, never a temp path);
 * - a completed attempt publishes a compact continuation record under
 *   `subagents/attempts`, so `readMeta`/`listMetas` still discover and resume it
 *   after the volatile raw log is reclaimed and after TMPDIR changes;
 * - durable sessions and recipes never expire with the daily sweep, while the
 *   volatile log/run directory still does (logs stay bounded);
 * - an owned git-clone workspace survives routine cleanup for a conversation
 *   whose recipe/session persists, and legacy no-recipe attempts keep the old
 *   reclaimable behavior;
 * - explicit deletion of the saved history or the durable record is not
 *   resurrected: continuation refuses a missing conversation.
 *
 * The first test launches the REAL extension with the REAL Pi SDK session
 * writer (a fake `pi` binary, no model call) and then removes the volatile run
 * directory and switches TMPDIR before resuming, so "durable" is proven against
 * a different volatile registry rather than a mock.
 *
 * @covers subagent.continuation
 * @level integration
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(dirname(PACKAGE_DIR));
const REAL_SDK_URL = pathToFileURL(join(REPO_ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href;

const RUNTIME = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "subagent-persistence-")));
const WORKSPACE = join(RUNTIME, "workspace");
const VOLATILE_A = join(RUNTIME, "volatile-a");
const VOLATILE_B = join(RUNTIME, "volatile-b");
const DURABLE = join(RUNTIME, "durable");
const ARTIFACTS = join(RUNTIME, "children");
for (const dir of [WORKSPACE, VOLATILE_A, VOLATILE_B, ARTIFACTS]) mkdirSync(dir, { recursive: true });
// Durable root pinned explicitly: the suite must never read or write the
// machine's real `~/.pi/agent/subagents`.
process.env.PI_SUBAGENT_DURABLE_DIR = DURABLE;
process.env.TMPDIR = VOLATILE_A;
process.env.TMP = VOLATILE_A;
process.env.TEMP = VOLATILE_A;
process.env.PI_CONTINUATION_ARTIFACTS = ARTIFACTS;
process.env.PI_CONTINUATION_SDK_URL = REAL_SDK_URL;
process.env.PI_SANDBOX_RECOVERY_SNAPSHOT = "off";

register(new URL("./pi_host_stub_hooks.mjs", import.meta.url));

const { default: betterSubagents } = await import("../index.ts");
const {
    baseDir,
    listMetas,
    nextRunId,
    readMeta,
    runDir,
    sessionsDir,
    taskWorkspaceDir,
    writeMeta,
} = await import("../registry.ts");
const {
    findSavedConversation,
    planContinuation,
    readRetention,
} = await import("../continuation.ts");
const { cleanupStatePath, enforceRegistrySizeCapOnce, runDailyCleanupOnce } = await import("../cleanup.ts");
const { readRunFailures } = await import("../failures.ts");

const DAY_MS = 24 * 60 * 60 * 1000;
const DURABLE_SESSIONS = join(DURABLE, "sessions");
const DURABLE_ATTEMPTS = join(DURABLE, "attempts");

after(() => {
    rmSync(RUNTIME, { recursive: true, force: true });
});

// ---- fake `pi` binary (real SDK session writes, no model calls) -----------
const fakePi = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

(async () => {
    const { SessionManager } = await import(process.env.PI_CONTINUATION_SDK_URL);
    const argv = process.argv.slice(2);
    let sessionPath;
    let sessionDir;
    let sessionId;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--session") sessionPath = argv[++i];
        else if (arg === "--session-dir") sessionDir = argv[++i];
        else if (arg === "--session-id") sessionId = argv[++i];
    }
    const prompt = argv[argv.length - 1];
    const recordPath = path.join(process.env.PI_CONTINUATION_ARTIFACTS, process.pid + ".json");
    const finish = (extra) => {
        fs.writeFileSync(recordPath, JSON.stringify({ sessionPath, sessionDir, sessionId, prompt, ...extra }));
        process.stdout.write(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: extra.answer }] }] }) + "\\n");
        process.exit(0);
    };
    try {
        const manager = sessionPath
            ? SessionManager.open(sessionPath, sessionDir)
            : SessionManager.create(process.cwd(), sessionDir, { id: sessionId });
        const before = manager.getEntries().filter((entry) => entry.type === "message").length;
        manager.appendMessage({ role: "user", content: [{ type: "text", text: prompt }] });
        manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "ANSWER:" + prompt }] });
        finish({
            sessionFile: manager.getSessionFile(),
            before,
            after: manager.getEntries().filter((entry) => entry.type === "message").length,
        });
    } catch (error) {
        fs.writeFileSync(recordPath, JSON.stringify({ error: String(error && error.message || error) }));
        process.exit(1);
    }
})();
`;
const binDir = join(RUNTIME, "fake-bin");
mkdirSync(binDir, { recursive: true });
const fakePiPath = join(binDir, "pi");
writeFileSync(fakePiPath, fakePi);
chmodSync(fakePiPath, 0o755);
const originalPath = process.env.PATH ?? "";
process.env.PATH = `${binDir}:${originalPath}`;

// ---- harness ---------------------------------------------------------------
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
        sessionManager: { getSessionId: () => "foreground-session", getBranch: () => [] },
    };
    betterSubagents(pi);
    return {
        tools, ctx,
        shutdown() { handlers.get("session_shutdown")?.({}, ctx); },
    };
}

async function waitFor(fn, { timeoutMs = 8000, intervalMs = 20 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await fn();
        if (value) return value;
        if (Date.now() > deadline) return undefined;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

function idOf(result) {
    const text = result.content[0].text;
    const match = text.match(/id=(\S+)/);
    assert.ok(match, `no run id in tool output: ${text}`);
    return match[1];
}

async function waitTerminal(id) {
    const meta = await waitFor(() => {
        const current = readMeta(id);
        return current && current.status !== "running" && current.status !== "orphaned" ? current : undefined;
    });
    assert.ok(meta, `run ${id} never reached a terminal status`);
    return meta;
}

function sweep(now) {
    rmSync(cleanupStatePath(), { force: true });
    const result = runDailyCleanupOnce({ now, terminalRunRetentionMs: 0, sessionRetentionMs: 0 });
    assert.deepEqual(result.errors, []);
    return result;
}

function switchVolatileRoot(to) {
    process.env.TMPDIR = to;
    process.env.TMP = to;
    process.env.TEMP = to;
}

/** The durable-archive incidents journaled for one run (see the output payload). */
function archiveIncidents(id) {
    return Object.values(readRunFailures(id).observations).filter((incident) => incident.operation === "durable-archive");
}

function resetDurableStore() {
    mkdirSync(DURABLE, { recursive: true });
    rmSync(DURABLE_ATTEMPTS, { recursive: true, force: true });
    rmSync(join(DURABLE, "session-state"), { recursive: true, force: true });
}

/** A completed attempt the way the launcher records one, with a real recipe. */
function writeCompletedRecipeAttempt(id, { cwd, overrides = {}, recipe = {} } = {}) {
    const old = Date.now() - 30 * DAY_MS;
    writeMeta({
        id,
        status: "completed",
        pid: 0,
        spawnPid: 1,
        cwd,
        promptPreview: "persistence fixture",
        startedAt: old,
        endedAt: old,
        logPath: join(runDir(id), "output.log"),
        sessionId: id,
        rootRunId: id,
        recipe: {
            version: 1,
            attemptId: id,
            sessionId: id,
            sessionDir: sessionsDir(),
            cwd,
            tools: "read",
            clean: true,
            allowNested: false,
            approve: false,
            sandbox: false,
            gitCloneWorkspace: false,
            callback: false,
            ...recipe,
        },
        ...overrides,
    });
    return old;
}

/** The saved native conversation Pi writes for a fresh launch. */
function writeSavedSession(root, workspace, mtimeMs = Date.now() - 30 * DAY_MS, sessionDir = sessionsDir()) {
    mkdirSync(sessionDir, { recursive: true });
    const path = join(sessionDir, `2026-01-01T00-00-00-000Z_${root}.jsonl`);
    writeFileSync(
        path,
        `${JSON.stringify({ type: "session", version: 1, id: root, timestamp: "2026-01-01T00:00:00.000Z", cwd: workspace })}\n`,
    );
    return path;
}

describe("durable native-session persistence", () => {
    it("keeps an ordinary (no retention) launch resumable after volatile cleanup and a TMPDIR change", async () => {
        const h = makeHarness();
        try {
            const id = idOf(await h.tools.get("subagent_spawn").execute("tc", {
                prompt: "INITIAL TASK", clean: true, sandbox: false, cwd: WORKSPACE,
            }, undefined, undefined, h.ctx));
            const meta = await waitTerminal(id);
            assert.equal(meta.status, "completed");

            // New child sessions live in the durable Pi agent directory, not TMPDIR.
            assert.equal(meta.recipe.sessionDir, sessionsDir());
            assert.equal(sessionsDir(), DURABLE_SESSIONS, "the session root is the durable agent subdirectory");
            assert.equal(meta.recipe.sessionDir.startsWith(baseDir() + sep), false, "the session root is outside the volatile registry");
            const lookup = findSavedConversation({
                sessionDir: meta.recipe.sessionDir, sessionId: meta.sessionId, expectedCwd: WORKSPACE,
            });
            assert.equal(lookup.kind, "ok");
            const sessionPath = lookup.conversation.path;
            assert.ok(sessionPath.startsWith(DURABLE_SESSIONS + sep), sessionPath);
            assert.equal(readRetention(meta.sessionId), undefined, "no retention record was requested or written");

            // The compact continuation record is published for a completed attempt.
            const archive = join(DURABLE_ATTEMPTS, `${id}.json`);
            assert.equal(existsSync(archive), true, "a completed attempt is archived durably");
            assert.equal(statSync(archive).mode & 0o777, 0o600, "the durable record is private");
            assert.equal(statSync(DURABLE_ATTEMPTS).mode & 0o777, 0o700, "the durable record directory is private");

            // The daily sweep still bounds the volatile raw log, and keeps durable evidence.
            sweep(Date.now() + 30 * DAY_MS);
            assert.equal(existsSync(runDir(id)), false, "the volatile run directory and its log are reclaimed");
            assert.equal(existsSync(sessionPath), true, "the saved native conversation is durable");
            assert.equal(existsSync(archive), true, "the compact attempt record is durable");

            // A different volatile root (a restart with another TMPDIR) still finds it.
            switchVolatileRoot(VOLATILE_B);
            assert.notEqual(baseDir(), VOLATILE_A, "the volatile registry moved");
            const recovered = readMeta(id);
            assert.ok(recovered, "readMeta discovers the archived completed attempt");
            assert.equal(recovered.status, "completed");
            assert.equal(recovered.recipe.sessionDir, sessionsDir());
            assert.ok(listMetas().some((entry) => entry.id === id), "listMetas discovers it too");
            const listed = await h.tools.get("subagent_list").execute("list", {}, undefined, undefined, h.ctx);
            assert.ok(listed.content[0].text.includes(`session_id=${meta.sessionId}`),
                "the public local list discovers the saved session after its volatile registry is gone");

            const plan = planContinuation({
                id,
                prior: recovered,
                origin: { cwd: WORKSPACE, sessionId: "another-foreground" },
                others: listMetas(),
            });
            assert.equal(plan.conversation.path, sessionPath);

            // Resume for real: the child appends to the SAME saved conversation.
            // The public continuation seam names the native session id.
            const resumedId = idOf(await h.tools.get("subagent_spawn").execute("tc", {
                prompt: "AFTER RESTART", session_id: meta.sessionId,
            }, undefined, undefined, h.ctx));
            const resumed = await waitTerminal(resumedId);
            assert.equal(resumed.status, "completed");
            assert.equal(resumed.sessionId, meta.sessionId, "the native conversation id is kept");
            assert.equal(resumed.recipe.sessionDir, sessionsDir());
            const child = JSON.parse(readFileSync(join(ARTIFACTS, `${resumed.pid}.json`), "utf8"));
            assert.equal(child.before, 2, "the resumed child reopened the durable history instead of creating an empty one");
            assert.equal(child.after, 4);

            // And the resumed attempt is itself discoverable from the durable root.
            switchVolatileRoot(VOLATILE_A);
            assert.ok(existsSync(join(DURABLE_ATTEMPTS, `${resumedId}.json`)));
        } finally {
            h.shutdown();
            switchVolatileRoot(VOLATILE_A);
            process.env.PATH = originalPath;
        }
    });

    it("keeps an owned clone workspace for a persistent recipe, and refuses when history is explicitly deleted", () => {
        rmSync(baseDir(), { recursive: true, force: true });
        const id = nextRunId();
        const workspace = taskWorkspaceDir(id);
        mkdirSync(workspace, { recursive: true });
        writeFileSync(join(workspace, "uncommitted.txt"), "work\n");
        const old = writeCompletedRecipeAttempt(id, {
            cwd: workspace,
            overrides: { taskRuntime: true },
            recipe: { sandbox: true, sandboxDir: workspace, gitCloneWorkspace: true },
        });
        const session = writeSavedSession(id, workspace, old);

        sweep(Date.now() + 30 * DAY_MS);
        assert.equal(existsSync(runDir(id)), false, "the volatile run directory is still reclaimed");
        assert.equal(existsSync(join(workspace, "uncommitted.txt")), true, "the conversation's clone survives routine cleanup");
        assert.equal(existsSync(session), true, "its saved conversation survives");
        const archive = join(DURABLE_ATTEMPTS, `${id}.json`);
        assert.equal(existsSync(archive), true);

        // Resumable from the durable record alone.
        const prior = readMeta(id);
        assert.ok(prior);
        assert.equal(prior.recipe.sessionDir, sessionsDir());
        assert.equal(planContinuation({
            id, prior, origin: { cwd: workspace, sessionId: "foreground" }, others: listMetas(),
        }).conversation.path, session);

        // Explicit deletion of the saved history refuses and is not resurrected.
        rmSync(session, { force: true });
        assert.throws(() => planContinuation({
            id, prior, origin: { cwd: workspace, sessionId: "foreground" }, others: listMetas(),
        }), /saved conversation is gone/);
        assert.equal(existsSync(session), false, "no empty replacement history is created");

        // Explicit deletion of the durable record is not resurrected either.
        rmSync(archive, { force: true });
        assert.equal(readMeta(id), undefined, "a deleted durable record stays missing");
    });

    it("keeps legacy no-recipe attempts reclaimable as before", () => {
        rmSync(baseDir(), { recursive: true, force: true });
        const id = nextRunId();
        const workspace = taskWorkspaceDir(id);
        mkdirSync(workspace, { recursive: true });
        writeFileSync(join(workspace, "work.txt"), "legacy\n");
        const old = Date.now() - 30 * DAY_MS;
        writeMeta({
            id,
            status: "completed",
            pid: 0,
            spawnPid: 1,
            cwd: workspace,
            taskRuntime: true,
            promptPreview: "legacy fixture",
            startedAt: old,
            endedAt: old,
            logPath: join(runDir(id), "output.log"),
            sessionId: id,
        });
        assert.equal(existsSync(join(DURABLE_ATTEMPTS, `${id}.json`)), false, "a no-recipe legacy attempt is not archived");
        const session = writeSavedSession(id, workspace, old, join(baseDir(), "sessions"));

        sweep(Date.now() + 30 * DAY_MS);
        assert.equal(existsSync(runDir(id)), false);
        assert.equal(existsSync(workspace), false, "a legacy owned workspace is still reclaimed");
        assert.equal(existsSync(session), false, "a legacy saved session is still reclaimed");
    });

    it("does not pin a failed attempt's clone: only completed conversations are durable", () => {
        rmSync(baseDir(), { recursive: true, force: true });
        const id = nextRunId();
        const workspace = taskWorkspaceDir(id);
        mkdirSync(workspace, { recursive: true });
        writeFileSync(join(workspace, "work.txt"), "failed attempt\n");
        const old = Date.now() - 30 * DAY_MS;
        writeMeta({
            id,
            status: "failed",
            pid: 0,
            spawnPid: 1,
            cwd: workspace,
            taskRuntime: true,
            promptPreview: "failed fixture",
            startedAt: old,
            endedAt: old,
            logPath: join(runDir(id), "output.log"),
            sessionId: id,
            recipe: {
                version: 1,
                attemptId: id,
                sessionId: id,
                sessionDir: sessionsDir(),
                cwd: workspace,
                tools: "read",
                clean: true,
                allowNested: false,
                approve: false,
                sandbox: true,
                sandboxDir: workspace,
                gitCloneWorkspace: true,
                callback: false,
            },
        });
        assert.equal(existsSync(join(DURABLE_ATTEMPTS, `${id}.json`)), false, "a failed attempt publishes no durable record");

        sweep(Date.now() + 30 * DAY_MS);
        assert.equal(existsSync(runDir(id)), false);
        assert.equal(existsSync(workspace), false, "an unresumable attempt's clone does not accumulate forever");
    });

    it("retains the only copy of a recipe and its clone while the durable archive cannot be published", async () => {
        rmSync(baseDir(), { recursive: true, force: true });
        resetDurableStore();
        const id = nextRunId();
        const workspace = taskWorkspaceDir(id);
        mkdirSync(workspace, { recursive: true });
        writeFileSync(join(workspace, "uncommitted.txt"), "work\n");
        // A real filesystem refusal, not a code path: the attempts path is a file.
        writeFileSync(DURABLE_ATTEMPTS, "not a directory");
        const old = writeCompletedRecipeAttempt(id, {
            cwd: workspace,
            overrides: { taskRuntime: true },
            recipe: { sandbox: true, sandboxDir: workspace, gitCloneWorkspace: true },
        });
        const session = writeSavedSession(id, workspace, old);
        const archive = join(DURABLE_ATTEMPTS, `${id}.json`);
        assert.equal(existsSync(archive), false, "publication failed; the volatile run holds the only recipe");

        // Finalization did not throw, and the failed publication is observable in the
        // run's own failures journal, which the output/result payloads report.
        const failed = archiveIncidents(id);
        assert.equal(failed.length, 1, "exactly one durable-archive incident is journaled");
        assert.equal(failed[0].status, "unresolved");
        assert.equal(failed[0].category, "storage");
        // The existing failure journal is what the output payload reports, so the
        // publication failure is visible to the operator, not silent.
        writeFileSync(join(runDir(id), "output.log"),
            `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })}\n`);
        const h = makeHarness();
        try {
            const output = await h.tools.get("subagent_output").execute("tc", { id, all: true }, undefined, undefined, h.ctx);
            assert.match(output.content[0].text, /durable continuation record could not be published/,
                `the output payload reports the retained archive: ${output.content[0].text}`);
        } finally {
            h.shutdown();
        }

        // Age bound: the run holding the only recipe is retained as a whole.
        const aged = sweep(Date.now() + 30 * DAY_MS);
        assert.equal(aged.removedRunDirs, 0);
        assert.equal(existsSync(runDir(id)), true, "the volatile record holding the only recipe is retained");
        assert.equal(existsSync(join(workspace, "uncommitted.txt")), true, "the uncommitted clone survives");
        assert.equal(existsSync(session), true, "the saved conversation survives");

        // Size bound: the same protection, and a retried failure does not spam the journal.
        const capped = enforceRegistrySizeCapOnce({ now: Date.now() + 30 * DAY_MS, maxBytes: 1, force: true });
        assert.deepEqual(capped.removed, []);
        assert.equal(capped.overBudget, true, "the retained run is still counted against the budget");
        assert.equal(existsSync(runDir(id)), true, "the size bound retains it too");
        assert.equal(existsSync(join(workspace, "uncommitted.txt")), true);
        assert.equal(archiveIncidents(id).length, 1, "a repeated publication failure adds no new incident");
        assert.equal(readMeta(id)?.recipe?.sessionDir, sessionsDir(), "the only recipe is still readable");

        // Fix the filesystem: the next sweep publishes the compact record first.
        rmSync(DURABLE_ATTEMPTS, { force: true });
        rmSync(cleanupStatePath(), { force: true });
        const published = runDailyCleanupOnce({ now: Date.now(), terminalRunRetentionMs: 60 * DAY_MS, sessionRetentionMs: 60 * DAY_MS });
        assert.deepEqual(published.errors, []);
        assert.equal(existsSync(archive), true, "the retry published the compact record");
        assert.equal(archiveIncidents(id)[0].status, "resolved", "the earlier publication failure is resolved");
        assert.equal(existsSync(runDir(id)), true, "nothing was deleted in this sweep");

        // Only now may the raw log and volatile metadata be reclaimed.
        sweep(Date.now() + 30 * DAY_MS);
        assert.equal(existsSync(runDir(id)), false, "the raw log and volatile metadata are reclaimed");
        assert.equal(existsSync(archive), true, "the compact record is durable");
        assert.equal(existsSync(join(workspace, "uncommitted.txt")), true, "the owned clone is kept");
        assert.equal(existsSync(session), true, "the saved native conversation is kept");
        const prior = readMeta(id);
        assert.ok(prior, "the durable record answers for the reclaimed run");
        assert.equal(prior.recipe.sessionDir, sessionsDir());
        assert.equal(planContinuation({
            id, prior, origin: { cwd: workspace, sessionId: "foreground" }, others: listMetas(),
        }).conversation.path, session);
    });

    it("does not offer an older completed archive once a newer attempt of the conversation was reclaimed", () => {
        rmSync(baseDir(), { recursive: true, force: true });
        resetDurableStore();
        const sessionId = `session${Date.now().toString(36)}`;
        const workspace = join(WORKSPACE, "conversation");
        mkdirSync(workspace, { recursive: true });
        const old = Date.now() - 30 * DAY_MS;
        const completedId = nextRunId();
        writeCompletedRecipeAttempt(completedId, {
            cwd: workspace,
            overrides: { sessionId, startedAt: old, endedAt: old },
            recipe: { sessionId },
        });
        const session = writeSavedSession(sessionId, workspace, old);
        assert.equal(readMeta(completedId)?.status, "completed");

        // A later attempt of the same conversation failed; this sweep reclaims its record.
        const failedId = nextRunId();
        writeMeta({
            id: failedId,
            status: "failed",
            pid: 0,
            spawnPid: 1,
            cwd: workspace,
            promptPreview: "failed continuation attempt",
            startedAt: old + 1000,
            endedAt: old + 1000,
            logPath: join(runDir(failedId), "output.log"),
            sessionId,
            rootRunId: completedId,
            resumedFrom: completedId,
            recipe: {
                version: 1,
                attemptId: failedId,
                sessionId,
                sessionDir: sessionsDir(),
                cwd: workspace,
                tools: "read",
                clean: true,
                allowNested: false,
                approve: false,
                sandbox: false,
                gitCloneWorkspace: false,
                callback: false,
            },
        });

        sweep(Date.now() + 30 * DAY_MS);
        assert.equal(existsSync(runDir(failedId)), false, "the failed attempt's volatile record is reclaimed");
        sweep(Date.now() + 31 * DAY_MS);
        assert.equal(existsSync(session), true, "native saved history never expires, even after its completion is tombstoned");
        assert.equal(existsSync(runDir(completedId)), false);
        assert.equal(existsSync(join(DURABLE_ATTEMPTS, `${completedId}.json`)), true,
            "the completed attempt's evidence is kept");
        // The compact record no longer speaks for the conversation: the last attempt
        // that ran did not complete, so there is no state to branch from.
        assert.equal(readMeta(completedId), undefined, "the stale archive is not offered");
        assert.equal(listMetas().some((meta) => meta.id === completedId), false);
        assert.throws(() => planContinuation({
            id: completedId,
            prior: readMeta(completedId),
            origin: { cwd: workspace, sessionId: "foreground" },
            others: listMetas(),
        }), /no such run id/);
        assert.equal(existsSync(session), true, "the saved history is never deleted by an archival marker");

        // A newer completion is the conversation's newest attempt again, so the marker
        // no longer applies and the conversation is resumable.
        const retriedId = nextRunId();
        writeCompletedRecipeAttempt(retriedId, {
            cwd: workspace,
            overrides: { sessionId, startedAt: old + 2000, endedAt: old + 2000 },
            recipe: { sessionId },
        });
        assert.equal(readMeta(retriedId)?.status, "completed");
        assert.equal(existsSync(join(DURABLE, "session-state", `${sessionId}.json`)), false,
            "the superseded marker is dropped");
    });
});
