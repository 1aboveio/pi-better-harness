/**
 * Completed-subagent continuation (#owner-continuation).
 *
 * The extension-level tests load the REAL extension with a fake ExtensionAPI
 * and a PATH-injected fake `pi` child. That child is a real Node process that
 * reopens/appends the saved conversation through the installed Pi SDK's REAL
 * SessionManager, so "same conversation" is proven against real session
 * persistence rather than a mock. No model call is made: the child writes a
 * terminal `agent_end` event and exits 0, which is exactly the lifecycle
 * evidence the registry/parse/finalization path consumes.
 *
 * Covered contract:
 * - `retain_session:true` keeps a completed conversation and workspace and
 *   leaves ordinary one-shot launches unchanged;
 * - `subagent_resume` allocates a NEW attempt/run id, keeps the SAME native
 *   session id and history, records `resumedFrom` lineage, and leaves the old
 *   log/result/callback/timing evidence immutable;
 * - a parked owner occupies zero capacity slots and a resumed attempt occupies
 *   one;
 * - one conversation admits one writer (admission refusal + cross-process lease
 *   with conservative stale recovery);
 * - cleanup protects retained conversations/workspaces until `subagent_release`
 *   and reclaims them afterwards without deleting at release time;
 * - only the owning foreground session may continue or release;
 * - missing history/workspace and a stricter current human permission profile
 *   refuse continuation instead of silently changing it.
 *
 * @covers subagent.continuation
 * @level integration
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { spawn } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { EventEmitter, once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(dirname(PACKAGE_DIR));
const REAL_SDK_URL = pathToFileURL(join(REPO_ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href;

// Hermetic registry + child artifacts: everything this file writes lives under
// one per-run temp directory, never a checked-in path or the machine registry.
const RUNTIME = mkdtempSync(join(tmpdir(), "subagent-continuation-"));
process.env.TMPDIR = RUNTIME;
const ARTIFACTS = join(RUNTIME, "children");
mkdirSync(ARTIFACTS, { recursive: true });
process.env.PI_CONTINUATION_ARTIFACTS = ARTIFACTS;
process.env.PI_CONTINUATION_SDK_URL = REAL_SDK_URL;

register(new URL("./pi_host_stub_hooks.mjs", import.meta.url));

const { default: betterSubagents } = await import("../index.ts");
const {
    baseDir,
    listMetas,
    logPathFor,
    nextRunId,
    processStartToken,
    readMeta,
    runDir,
    sessionsDir,
    taskWorkspaceDir,
    writeMeta,
} = await import("../registry.ts");
const {
    ConversationBusyError,
    acquireConversationLease,
    conversationLeaseDir,
    findSavedConversation,
    markRetentionReleased,
    planContinuation,
    readConversationLease,
    readRetention,
    retainConversation,
    retainedSessionIds,
} = await import("../continuation.ts");
const { runDailyCleanupOnce, enforceRegistrySizeCapOnce } = await import("../cleanup.ts");
const { killProcessTree } = await import("../spawn.ts");
const { SANDBOX_POLICY_CHANNEL, SANDBOX_POLICY_REQUEST_CHANNEL } = await import("../permission-policy.ts");

const DAY_MS = 24 * 60 * 60 * 1000;
const WORKSPACE = join(RUNTIME, "workspace");
mkdirSync(WORKSPACE, { recursive: true });

// ---- fake `pi` binary (real SDK session writes, no model calls) -----------
const fakePi = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const record = { pid: process.pid, argv, sessionPath: sessionPath ?? null, sessionDir, sessionId: sessionId ?? null, prompt };
    const recordPath = path.join(process.env.PI_CONTINUATION_ARTIFACTS, process.pid + ".json");
    const finish = (extra) => {
        fs.writeFileSync(recordPath, JSON.stringify({ ...record, ...extra }));
        process.stdout.write(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: extra.answer }] }] }) + "\\n");
        process.exit(0);
    };
    try {
        const pause = Number(process.env.PI_CONTINUATION_SLEEP_MS || 0);
        const manager = sessionPath
            ? SessionManager.open(sessionPath, sessionDir)
            : SessionManager.create(process.cwd(), sessionDir, { id: sessionId });
        const before = manager.getEntries().filter((entry) => entry.type === "message").length;
        if (pause > 0) await sleep(pause);
        if (sessionPath) {
            manager.appendMessage({ role: "user", content: [{ type: "text", text: prompt }] });
            manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "FOLLOWUP:" + prompt }] });
        } else {
            manager.appendMessage({ role: "user", content: [{ type: "text", text: "INITIAL TASK" }] });
            manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "INITIAL ANSWER" }] });
        }
        const answer = sessionPath ? "FOLLOWUP:" + prompt : "INITIAL ANSWER";
        finish({
            sessionFile: manager.getSessionFile(),
            sessionIdAfter: manager.getSessionId(),
            before,
            after: manager.getEntries().filter((entry) => entry.type === "message").length,
            answer,
        });
    } catch (error) {
        fs.writeFileSync(recordPath, JSON.stringify({ ...record, error: String(error && error.message || error) }));
        process.exit(1);
    }
})();
`;

const binDir = mkdtempSync(join(RUNTIME, "fake-bin-"));
const fakePiPath = join(binDir, "pi");
writeFileSync(fakePiPath, fakePi);
chmodSync(fakePiPath, 0o755);
const originalPath = process.env.PATH ?? "";
process.env.PATH = `${binDir}:${originalPath}`;

const policyMain = { enabled: false, projectFiles: "read-write", outsideProject: "read", storedCredentials: "read", commands: true, network: true };
const policyChildEnforced = { ...policyMain, enabled: true };

// ---- harness ---------------------------------------------------------------
function makeHarness(options = {}) {
    const events = new EventEmitter();
    let snapshot = options.policy;
    events.on(SANDBOX_POLICY_REQUEST_CHANNEL, () => {
        if (snapshot) events.emit(SANDBOX_POLICY_CHANNEL, snapshot);
    });
    const tools = new Map();
    const handlers = new Map();
    const sent = [];
    const pi = {
        events,
        registerTool: (definition) => tools.set(definition.name, definition),
        registerCommand: () => {},
        appendEntry: () => {},
        on: (event, handler) => handlers.set(event, handler),
        sendMessage: (message, sendOptions) => sent.push({ message, options: sendOptions }),
    };
    const ctx = {
        cwd: options.cwd ?? WORKSPACE,
        model: { provider: "test", id: "model" },
        hasUI: false,
        isIdle: () => true,
        ui: { notify() {}, setWidget() {} },
        sessionManager: { getSessionId: () => options.sessionId ?? "owner-session", getBranch: () => [] },
    };
    betterSubagents(pi);
    return {
        pi, tools, handlers, sent, ctx,
        publishPolicy(next) { snapshot = next; events.emit(SANDBOX_POLICY_CHANNEL, next); },
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

async function waitTerminal(id) {
    const meta = await waitFor(() => {
        const current = readMeta(id);
        return current && current.status !== "running" && current.status !== "orphaned" ? current : undefined;
    });
    assert.ok(meta, `run ${id} never reached a terminal status`);
    return meta;
}

function idOf(result) {
    const text = result.content[0].text;
    const match = text.match(/id=(\S+)/);
    assert.ok(match, `no run id in tool output: ${text}`);
    return match[1];
}

async function spawnRun(h, params) {
    const result = await h.tools.get("subagent_spawn").execute("tc", {
        prompt: "INITIAL TASK", clean: true, sandbox: false, cwd: WORKSPACE, ...params,
    }, undefined, undefined, h.ctx);
    return idOf(result);
}

async function resumeRun(h, params) {
    return h.tools.get("subagent_resume").execute("tc", params, undefined, undefined, h.ctx);
}

async function resultText(h, id) {
    return (await h.tools.get("subagent_result").execute("tc", { id }, undefined, undefined, h.ctx)).content[0].text;
}

async function runningCount(h) {
    const result = await h.tools.get("subagent_settings").execute("tc", {}, undefined, undefined, h.ctx);
    return result.details.runningCount;
}

function childRecord(pid) {
    return JSON.parse(readFileSync(join(ARTIFACTS, `${pid}.json`), "utf-8"));
}

function sessionMessages(path) {
    return readFileSync(path, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.type === "message")
        .map((entry) => ({
            role: entry.message.role,
            text: (entry.message.content ?? []).map((block) => block.text ?? "").join(""),
        }));
}

function sessionHeader(path) {
    return JSON.parse(readFileSync(path, "utf-8").split("\n")[0]);
}

async function reap(ids) {
    for (const id of ids) {
        const meta = readMeta(id);
        if (meta && (meta.status === "running" || meta.status === "orphaned")) killProcessTree(meta.pid, "SIGKILL");
    }
    for (const id of ids) {
        await waitFor(() => {
            const meta = readMeta(id);
            return !meta || (meta.status !== "running" && meta.status !== "orphaned");
        }, { timeoutMs: 4000 });
    }
}

function removeRun(id) {
    rmSync(runDir(id), { recursive: true, force: true });
}

after(() => {
    process.env.PATH = originalPath;
    delete process.env.PI_CONTINUATION_SLEEP_MS;
    rmSync(RUNTIME, { recursive: true, force: true });
});

describe("completed-subagent continuation", () => {
    it("continues the SAME saved conversation under a new attempt id and preserves the old attempt", async () => {
        const h = makeHarness();
        let rootId;
        let resumedId;
        try {
            rootId = await spawnRun(h, { retain_session: true });
            const root = await waitTerminal(rootId);
            assert.equal(root.status, "completed");
            assert.equal(root.sessionId, rootId, "a fresh launch uses the attempt id as its native session id");
            assert.equal(root.recipe?.sessionId, rootId);
            assert.equal(root.recipe?.clean, true);
            assert.equal(root.recipe?.cwd, root.cwd);
            assert.equal(readFileSync(join(runDir(rootId), "prompt.md"), "utf-8"), "INITIAL TASK");
            const initialConversation = findSavedConversation({
                sessionDir: root.recipe.sessionDir, sessionId: root.sessionId, expectedCwd: root.cwd,
            });
            assert.equal(initialConversation.kind, "ok", JSON.stringify(initialConversation));
            const sessionPath = initialConversation.conversation.path;
            assert.deepEqual(sessionMessages(sessionPath).map((m) => m.role), ["user", "assistant"]);
            // The fresh child allocated a new session and never used --session.
            const freshChild = childRecord(root.pid);
            assert.ok(freshChild.argv.includes("--session-id"));
            assert.ok(!freshChild.argv.includes("--session"));

            const rootLog = readFileSync(logPathFor(rootId), "utf-8");
            const rootResult = await resultText(h, rootId);
            // Let the ordinary completion handoff settle before snapshotting, so the
            // only thing this test can observe changing later is continuation's own work.
            await waitFor(() => {
                const current = readMeta(rootId);
                return current && (current.completionCallbackSentAt !== undefined || current.completionCallbackSuppressedAt !== undefined);
            }, { timeoutMs: 5000 });
            const rootSnapshot = readMeta(rootId);
            assert.equal(typeof rootSnapshot.completionCallbackSentAt, "number", "the root completion was handed off");

            resumedId = idOf(await resumeRun(h, { id: rootId, prompt: "FIX IT" }));
            assert.notEqual(resumedId, rootId, "continuation allocates a new attempt id");
            const resumed = await waitTerminal(resumedId);
            assert.equal(resumed.status, "completed");
            assert.equal(resumed.sessionId, rootId, "continuation keeps the native session id");
            assert.equal(resumed.rootRunId, rootId);
            assert.equal(resumed.resumedFrom, rootId);
            assert.notEqual(resumed.logPath, root.logPath, "each attempt has its own log");
            assert.equal(readFileSync(join(runDir(resumedId), "prompt.md"), "utf-8"), "FIX IT");

            // Launch recipe continuity: the continuation kept the frozen intent
            // (clean child, same workspace, same effective model) instead of
            // re-resolving role/catalog or inheriting today's foreground model.
            assert.equal(resumed.recipe.tools, root.recipe.tools);
            assert.equal(resumed.recipe.clean, root.recipe.clean);
            assert.equal(resumed.recipe.sessionDir, root.recipe.sessionDir);
            assert.equal(resumed.recipe.model, root.recipe.model);
            assert.equal(resumed.recipe.effort, root.recipe.effort);
            assert.equal(resumed.recipe.allowNested, root.recipe.allowNested);
            assert.equal(resumed.recipe.sandbox, false);

            // Real context continuation: the SAME file, same header id, and the
            // real SessionManager saw the prior two messages before appending.
            const continued = findSavedConversation({
                sessionDir: root.recipe.sessionDir, sessionId: root.sessionId, expectedCwd: root.cwd,
            });
            assert.equal(continued.kind, "ok");
            assert.equal(continued.conversation.path, sessionPath, "the continuation reopens the same session file");
            assert.equal(sessionHeader(sessionPath).id, rootId);
            assert.deepEqual(sessionMessages(sessionPath), [
                { role: "user", text: "INITIAL TASK" },
                { role: "assistant", text: "INITIAL ANSWER" },
                { role: "user", text: "FIX IT" },
                { role: "assistant", text: "FOLLOWUP:FIX IT" },
            ]);
            const resumedChild = childRecord(resumed.pid);
            assert.ok(resumedChild.argv.includes("--session"), "continuation opens an explicit saved session");
            assert.equal(resumedChild.argv[resumedChild.argv.indexOf("--session") + 1], sessionPath);
            assert.ok(!resumedChild.argv.includes("--session-id"), "Pi rejects --session with --session-id");
            assert.equal(resumedChild.before, 2, "the child loaded the prior conversation before appending");
            assert.equal(resumedChild.after, 4);

            // Old attempt evidence is untouched.
            assert.equal(readFileSync(logPathFor(rootId), "utf-8"), rootLog);
            assert.equal(await resultText(h, rootId), rootResult);
            const rootAfter = readMeta(rootId);
            for (const field of ["status", "sessionId", "endedAt", "exitCode", "lifecycleClassification",
                "completionCallbackPendingAt", "completionCallbackSentAt", "completionCallbackSuppressedAt", "logPath", "recipe"]) {
                assert.deepEqual(rootAfter[field], rootSnapshot[field], `root ${field} must not change on continuation`);
            }
        } finally {
            await reap([rootId, resumedId].filter(Boolean));
            h.shutdown();
        }
    });

    it("parks a completed owner at zero capacity slots and occupies one only while an attempt runs", async () => {
        const h = makeHarness();
        let rootId;
        let resumedId;
        try {
            rootId = await spawnRun(h, { retain_session: true });
            await waitTerminal(rootId);
            assert.equal(await runningCount(h), 0, "a parked completed owner holds no slot");

            process.env.PI_CONTINUATION_SLEEP_MS = "2500";
            try {
                resumedId = idOf(await resumeRun(h, { id: rootId, prompt: "SLOW FOLLOW-UP" }));
            } finally {
                delete process.env.PI_CONTINUATION_SLEEP_MS;
            }
            assert.equal(readMeta(resumedId).status, "running");
            assert.equal(await runningCount(h), 1, "the resumed attempt occupies exactly one slot");
            await waitTerminal(resumedId);
            assert.equal(await runningCount(h), 0, "completion frees the slot again");
        } finally {
            await reap([rootId, resumedId].filter(Boolean));
            h.shutdown();
        }
    });

    it("admits one writer per conversation: a live duplicate and a foreign lease holder are refused", async () => {
        const h = makeHarness();
        let rootId;
        let resumedId;
        let holder;
        try {
            rootId = await spawnRun(h, { retain_session: true });
            await waitTerminal(rootId);

            process.env.PI_CONTINUATION_SLEEP_MS = "2500";
            try {
                resumedId = idOf(await resumeRun(h, { id: rootId, prompt: "FIRST WRITER" }));
                // The first attempt is live, so admission refuses the duplicate
                // before anything else can touch the conversation.
                await assert.rejects(
                    resumeRun(h, { id: rootId, prompt: "SECOND WRITER" }),
                    /still active in the same conversation|already being written/,
                );
            } finally {
                delete process.env.PI_CONTINUATION_SLEEP_MS;
            }
            await waitTerminal(resumedId);

            // Cross-process lease: a foreign LIVE holder (not this pi) blocks the
            // writer even though the attempt metadata is terminal.
            const foreignHolder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });
            holder = foreignHolder;
            mkdirSync(conversationLeaseDir(), { recursive: true });
            writeFileSync(join(conversationLeaseDir(), `${rootId}.lock`), JSON.stringify({
                pid: holder.pid,
                start: processStartToken(holder.pid),
                token: "foreign-holder",
                sessionId: rootId,
                attemptId: rootId,
                at: Date.now(),
            }));
            await assert.rejects(
                resumeRun(h, { id: rootId, prompt: "THIRD WRITER" }),
                /already being written by another attempt/,
            );
            assert.equal(listMetas().filter((meta) => meta.sessionId === rootId).length, 2, "no attempt was launched");
            // A dead holder is recovered conservatively on the next admission.
            killProcessTree(holder.pid, "SIGKILL");
            await once(foreignHolder, "exit");
            holder = undefined;
            const recovered = idOf(await resumeRun(h, { id: rootId, prompt: "RECOVERED WRITER" }));
            await waitTerminal(recovered);
            await reap([recovered]);
            removeRun(recovered);
        } finally {
            if (holder?.pid) killProcessTree(holder.pid, "SIGKILL");
            await reap([rootId, resumedId].filter(Boolean));
            h.shutdown();
        }
    });

    it("recovers stale conversation leases only with process or terminal-attempt evidence", async () => {
        const sessionId = nextRunId();
        mkdirSync(conversationLeaseDir(), { recursive: true });
        const leasePath = join(conversationLeaseDir(), `${sessionId}.lock`);
        const write = (payload) => writeFileSync(leasePath, JSON.stringify({
            token: "stale", sessionId, attemptId: sessionId, at: Date.now(), ...payload,
        }));
        try {
            // A dead holder alone is ambiguous: its child could have survived
            // before metadata publication. Recover after writer absence is proven.
            write({ pid: 4194304, start: "dead" });
            assert.throws(() => acquireConversationLease({ sessionId, attemptId: "sa_unknown_writer" }), ConversationBusyError);
            writeMeta({
                id: sessionId, status: "completed", pid: 0, spawnPid: 4194304, cwd: WORKSPACE,
                promptPreview: "quiescent writer", startedAt: Date.now() - 60_000, endedAt: Date.now() - 60_000,
                logPath: logPathFor(sessionId), sessionId,
            });
            const first = acquireConversationLease({ sessionId, attemptId: "sa_attempt_a" });
            assert.notEqual(readConversationLease(sessionId)?.token, "stale");
            first.release();
            assert.equal(readConversationLease(sessionId), undefined);

            // Live pid whose start identity changed (pid recycled): recover.
            // The OS start-token probe is a kernel boundary seam here because the
            // test runner itself is denied process inspection on some hosts.
            const live = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });
            try {
                write({ pid: live.pid, start: "old-start-token" });
                const second = acquireConversationLease({
                    sessionId, attemptId: "sa_attempt_b",
                    probe: { startToken: (pid) => pid === live.pid ? "new-start-token" : undefined },
                });
                second.release();
            } finally {
                killProcessTree(live.pid, "SIGKILL");
                await once(live, "exit");
            }

            // Live pid with a matching start token: never steal.
            const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });
            try {
                write({ pid: holder.pid, start: "same-start-token" });
                assert.throws(
                    () => acquireConversationLease({
                        sessionId, attemptId: "sa_attempt_c",
                        probe: { startToken: (pid) => pid === holder.pid ? "same-start-token" : undefined },
                    }),
                    (error) => error instanceof ConversationBusyError,
                );
            } finally {
                killProcessTree(holder.pid, "SIGKILL");
                await once(holder, "exit");
            }

            // This process's own stale lease for an already terminal attempt: recover.
            const finishedAt = Date.now() - 60_000;
            const finished = nextRunId();
            writeMeta({
                id: finished, status: "completed", pid: 0, spawnPid: process.pid, cwd: WORKSPACE,
                promptPreview: "done", startedAt: finishedAt, endedAt: finishedAt,
                logPath: logPathFor(finished), sessionId,
            });
            write({ pid: process.pid, start: processStartToken(process.pid), attemptId: finished, at: finishedAt });
            const third = acquireConversationLease({ sessionId, attemptId: "sa_attempt_d" });
            assert.equal(readConversationLease(sessionId)?.attemptId, "sa_attempt_d");
            third.release();
            removeRun(finished);

            // Unparsable bytes are not stolen inside the grace window.
            writeFileSync(leasePath, "not-json");
            assert.throws(() => acquireConversationLease({ sessionId, attemptId: "sa_attempt_e" }), ConversationBusyError);
            const aged = (Date.now() - 60_000) / 1000;
            utimesSync(leasePath, aged, aged);
            const fourth = acquireConversationLease({ sessionId, attemptId: "sa_attempt_f" });
            fourth.release();
        } finally {
            rmSync(leasePath, { force: true });
            removeRun(sessionId);
        }
    });

    it("protects retained history and workspace from cleanup until release, then reclaims them", async () => {
        const now = Date.UTC(2026, 6, 30, 12, 0, 0);
        const old = now - 20 * DAY_MS;
        const retainedId = nextRunId();
        const plainId = nextRunId();
        const workspace = taskWorkspaceDir(retainedId);
        const scratch = join(RUNTIME, "pi-task-scratch-abc123");
        mkdirSync(workspace, { recursive: true });
        mkdirSync(scratch, { recursive: true });
        writeFileSync(join(workspace, "work.txt"), "uncommitted work");
        writeFileSync(join(scratch, "state.txt"), "scratch state");
        const meta = (id, overrides = {}) => ({
            id, status: "completed", pid: 0, spawnPid: 1, cwd: WORKSPACE,
            promptPreview: "cleanup fixture", startedAt: old, endedAt: old,
            logPath: logPathFor(id), sessionId: id, rootRunId: id, ...overrides,
        });
        writeMeta(meta(retainedId, { taskRuntime: true, cwd: workspace, taskScratch: scratch }));
        writeFileSync(logPathFor(retainedId), "retained log\n");
        writeMeta(meta(plainId));
        writeFileSync(logPathFor(plainId), "plain log\n");
        mkdirSync(sessionsDir(), { recursive: true });
        const retainedSession = join(sessionsDir(), `2026-01-01T00-00-00-000Z_${retainedId}.jsonl`);
        writeFileSync(retainedSession, `${JSON.stringify({ type: "session", version: 1, id: retainedId, timestamp: "2026-01-01T00:00:00.000Z", cwd: workspace })}\n`);
        const seconds = old / 1000;
        utimesSync(retainedSession, seconds, seconds);
        retainConversation({
            sessionId: retainedId, ownerRunId: retainedId, workspace,
            ownerOrigin: { cwd: WORKSPACE, sessionId: "owner-session" }, attemptId: retainedId, now,
        });
        try {
            assert.ok(retainedSessionIds().has(retainedId));

            runDailyCleanupOnce({ now });
            assert.ok(existsSync(runDir(retainedId)), "retained run directory survives the age sweep");
            assert.ok(existsSync(retainedSession), "retained saved conversation survives the age sweep");
            assert.ok(existsSync(join(workspace, "work.txt")), "retained workspace survives the age sweep");
            assert.ok(existsSync(join(scratch, "state.txt")), "retained task scratch survives the age sweep");
            assert.ok(!existsSync(runDir(plainId)), "an ordinary old completed run is still removed");

            const capped = enforceRegistrySizeCapOnce({ now, maxBytes: 1, force: true });
            assert.ok(!capped.removed.includes(retainedId), "the size sweep never picks a retained conversation");
            assert.equal(capped.overBudget, true);

            const record = readRetention(retainedId);
            assert.ok(record);
            markRetentionReleased(record, { cwd: WORKSPACE, sessionId: "owner-session" }, now);
            assert.equal(readRetention(retainedId)?.releasedAt, now, "release records the decision without deleting anything");
            assert.ok(existsSync(runDir(retainedId)), "release does not delete immediately");
            assert.equal(readFileSync(logPathFor(retainedId), "utf-8"), "retained log\n");

            runDailyCleanupOnce({ now: now + 20 * DAY_MS });
            assert.ok(!existsSync(runDir(retainedId)), "after release the age sweep may retire the conversation");
            assert.ok(!existsSync(retainedSession));
            assert.ok(!existsSync(workspace), "after release the owned workspace may be reclaimed");
            assert.ok(!existsSync(scratch), "after release the owned task scratch may be reclaimed");
        } finally {
            rmSync(runDir(retainedId), { recursive: true, force: true });
            rmSync(runDir(plainId), { recursive: true, force: true });
            rmSync(workspace, { recursive: true, force: true });
            rmSync(scratch, { recursive: true, force: true });
            rmSync(retainedSession, { force: true });
            rmSync(join(baseDir(), "retained", `${retainedId}.json`), { force: true });
        }
    });

    it("lets only the owning foreground session continue or release a conversation", async () => {
        const owner = makeHarness();
        const stranger = makeHarness({ sessionId: "another-session" });
        let rootId;
        try {
            rootId = await spawnRun(owner, { retain_session: true });
            await waitTerminal(rootId);

            await assert.rejects(
                resumeRun(stranger, { id: rootId, prompt: "HIJACK" }),
                /only its owning foreground session may continue it/,
            );
            await assert.rejects(
                stranger.tools.get("subagent_release").execute("tc", { id: rootId }, undefined, undefined, stranger.ctx),
                /only its owning foreground session may change retention/,
            );
            // No readable foreground identity is a refusal, never a cwd-wide grant.
            assert.throws(
                () => planContinuation({ id: rootId, prior: readMeta(rootId), origin: undefined, others: listMetas() }),
                /foreground session identity is unavailable/,
            );
            assert.equal(readRetention(rootId)?.releasedAt, undefined, "a refused release leaves retention intact");
            assert.equal(listMetas().filter((meta) => meta.sessionId === rootId).length, 1, "no hijack attempt launched");
        } finally {
            await reap([rootId].filter(Boolean));
            owner.shutdown();
            stranger.shutdown();
        }
    });

    it("refuses missing history, a missing workspace, and a stricter current permission profile", async () => {
        const h = makeHarness();
        const ids = [];
        try {
            // Missing saved conversation.
            const goneId = await spawnRun(h, { retain_session: true });
            ids.push(goneId);
            const gone = await waitTerminal(goneId);
            const found = findSavedConversation({
                sessionDir: gone.recipe.sessionDir, sessionId: gone.sessionId, expectedCwd: gone.cwd,
            });
            assert.equal(found.kind, "ok");
            rmSync(found.conversation.path, { force: true });
            await assert.rejects(
                resumeRun(h, { id: goneId, prompt: "ANYONE THERE" }),
                /saved conversation is gone/,
            );

            // Missing workspace.
            const lostWorkspace = join(RUNTIME, "lost-workspace");
            mkdirSync(lostWorkspace, { recursive: true });
            const workspaceId = await spawnRun(h, { cwd: lostWorkspace, retain_session: true });
            ids.push(workspaceId);
            await waitTerminal(workspaceId);
            rmSync(lostWorkspace, { recursive: true, force: true });
            await assert.rejects(
                resumeRun(h, { id: workspaceId, prompt: "STILL THERE" }),
                /workspace .* is missing/,
            );

            // A human profile that now enforces confinement cannot be bypassed by
            // continuing an unsandboxed conversation.
            const confinedId = await spawnRun(h, { retain_session: true });
            ids.push(confinedId);
            await waitTerminal(confinedId);
            h.publishPolicy({ state: "enabled", permissions: { ...policyMain, enabled: true }, subagentPermissions: policyChildEnforced });
            await assert.rejects(
                resumeRun(h, { id: confinedId, prompt: "SANDWICH" }),
                /cannot bypass it|would change its confinement/,
            );
            assert.equal(listMetas().filter((meta) => meta.sessionId === confinedId).length, 1, "no attempt launched under refused policy");
        } finally {
            await reap(ids);
            h.shutdown();
        }
    });

    it("releases retention without deleting or rewriting completed evidence, and never revives it", async () => {
        const h = makeHarness();
        let rootId;
        let resumedId;
        try {
            rootId = await spawnRun(h, { retain_session: true });
            await waitTerminal(rootId);
            const logBefore = readFileSync(logPathFor(rootId), "utf-8");
            const resultBefore = await resultText(h, rootId);
            const metaBefore = readMeta(rootId);

            const released = await h.tools.get("subagent_release").execute("tc", { id: rootId }, undefined, undefined, h.ctx);
            assert.equal(released.details.status, "released");
            assert.ok(existsSync(runDir(rootId)), "release deletes nothing");
            assert.equal(readFileSync(logPathFor(rootId), "utf-8"), logBefore);
            assert.equal(await resultText(h, rootId), resultBefore);
            for (const field of ["status", "endedAt", "exitCode", "sessionId", "recipe", "completionCallbackPendingAt"]) {
                assert.deepEqual(readMeta(rootId)[field], metaBefore[field]);
            }
            const releasedAt = readRetention(rootId)?.releasedAt;
            assert.equal(typeof releasedAt, "number");

            await assert.rejects(
                h.tools.get("subagent_release").execute("tc", { id: rootId }, undefined, undefined, h.ctx),
                /already released/,
            );

            // Artifacts still exist, so continuation remains possible while they
            // do — but it must not silently re-retain the released conversation.
            resumedId = idOf(await resumeRun(h, { id: rootId, prompt: "AFTER RELEASE" }));
            await waitTerminal(resumedId);
            assert.equal(readRetention(rootId)?.releasedAt, releasedAt, "a released conversation is not retained again");

            // A continuation of a continuation keeps one lineage root and the same
            // conversation, so repeated review rounds never fork history.
            const secondGeneration = idOf(await resumeRun(h, { id: resumedId, prompt: "SECOND GENERATION" }));
            const second = await waitTerminal(secondGeneration);
            assert.equal(second.sessionId, rootId);
            assert.equal(second.rootRunId, rootId);
            assert.equal(second.resumedFrom, resumedId);
            await reap([secondGeneration]);
            removeRun(secondGeneration);
        } finally {
            await reap([rootId, resumedId].filter(Boolean));
            h.shutdown();
        }
    });
});
