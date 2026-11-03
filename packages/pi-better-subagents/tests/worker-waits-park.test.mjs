/**
 * Park finalization with the REAL registry, saved-conversation checkpoint and
 * cleanup protection.
 *
 * The volatile registry root is redirected through TMPDIR and the durable root
 * through PI_SUBAGENT_DURABLE_DIR before the modules load, so these are real
 * `meta.json` / `park.json` / session files on disk — not in-memory doubles.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";

const sandboxRoot = mkdtempSync(join(tmpdir(), "subagents-park-fixture-"));
const volatileTmp = join(sandboxRoot, "tmp");
const durableRoot = join(sandboxRoot, "durable");
mkdirSync(volatileTmp, { recursive: true });
mkdirSync(durableRoot, { recursive: true });
const originalTmpdir = process.env.TMPDIR;
process.env.TMPDIR = volatileTmp;
process.env.PI_SUBAGENT_DURABLE_DIR = durableRoot;

const registry = await import("../registry.ts");
const { finalizeRun } = await import("../finalization.ts");
const { captureParkCheckpoint } = await import("../park-checkpoint.ts");
const { evaluateParkDisposition, parkedWaits } = await import("../worker-waits.ts");
const { runDailyCleanupOnce } = await import("../cleanup.ts");

const created = [];

before(() => {
    process.env.TMPDIR = volatileTmp;
    process.env.PI_SUBAGENT_DURABLE_DIR = durableRoot;
});

afterEach(() => {
    while (created.length > 0) {
        const id = created.pop();
        try { rmSync(registry.runDir(id), { recursive: true, force: true }); } catch { /* best effort */ }
    }
});

after(() => {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    delete process.env.PI_SUBAGENT_DURABLE_DIR;
    rmSync(sandboxRoot, { recursive: true, force: true });
});

/**
 * A real completed-attempt fixture: run directory, saved conversation whose last
 * message is the wait tool result, launch recipe, and log with a coherent stream.
 */
function parkedRunFixture(id, options = {}) {
    const sessionDirectory = join(durableRoot, "sessions", id);
    mkdirSync(sessionDirectory, { recursive: true });
    const sessionFile = join(sessionDirectory, `${id}.jsonl`);
    const waitId = options.waitId ?? `wait_${id}`;
    const generation = options.generation ?? 1;
    const toolCallId = "call-wait-1";
    const header = JSON.stringify({ type: "session", id, cwd: join(sandboxRoot, "workspace") });
    const call = JSON.stringify({
        type: "message",
        id: "entry-call",
        message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "wait_for_operations", arguments: { task_ids: ["bg_test1"] } }] },
    });
    const result = JSON.stringify({
        type: "message",
        id: "entry-result",
        message: {
            role: "toolResult",
            toolCallId,
            toolName: "wait_for_operations",
            isError: false,
            content: [{ type: "text", text: JSON.stringify({ operationWait: { waitId, generation } }) }],
            details: { operationWait: { waitId, generation }, operationBridge: { marker: "m1", waitId, generation, toolCallId } },
        },
    });
    writeFileSync(sessionFile, `${[header, call, result].join("\n")}\n`);
    const checkpoint = captureParkCheckpoint({ sessionId: id, sessionFile, toolCallId, waitId, generation });

    const workspace = join(sandboxRoot, "workspace");
    mkdirSync(workspace, { recursive: true });
    registry.writeMeta({
        id,
        status: "running",
        pid: process.pid,
        spawnPid: process.pid,
        cwd: workspace,
        promptPreview: "build the release",
        startedAt: Date.now() - 1_000,
        logPath: registry.logPathFor(id),
        sessionId: id,
        sandbox: undefined,
        callback: true,
        recipe: {
            version: 1,
            attemptId: id,
            sessionId: id,
            sessionDir: sessionDirectory,
            cwd: workspace,
            tools: "read,write,bash",
            clean: false,
            allowNested: false,
            approve: false,
            sandbox: false,
            gitCloneWorkspace: false,
            callback: true,
        },
    });
    writeFileSync(registry.logPathFor(id), [
        JSON.stringify({ type: "agent_start" }),
        JSON.stringify({ type: "agent_end" }),
        JSON.stringify({ type: "agent_settled" }),
        "",
    ].join("\n"));
    if (options.writeParkRecord !== false) {
        registry.writeParkRecord(id, {
            version: 1,
            waitId,
            generation,
            phase: "waiting",
            attemptId: id,
            ownerSessionId: "parent-session-1",
            ownerWorkspace: workspace,
            ownerBranchId: "branch-1",
            ownerGoalId: null,
            continuationNote: "Read the build result and continue packaging.",
            checkpoint: {
                sessionId: checkpoint.sessionId,
                sessionFile: checkpoint.sessionFile,
                toolCallId: checkpoint.toolCallId,
                entryId: checkpoint.entryId,
                prefixBytes: checkpoint.prefixBytes,
                prefixSha256: checkpoint.prefixSha256,
            },
            parkedAt: Date.now(),
            updatedAt: Date.now(),
        });
    }
    created.push(id);
    return { id, waitId, generation, sessionFile, workspace, checkpoint };
}

test("a clean exit with a verified checkpoint records a park disposition, not a completion callback", () => {
    const fixture = parkedRunFixture("sa_park_1");

    const disposition = evaluateParkDisposition({ runId: fixture.id, cleanExit: true });
    assert.equal(disposition.parked, true);
    assert.equal(disposition.record.waitId, fixture.waitId);

    const sent = [];
    const result = finalizeRun(fixture.id, 0, {
        sendMessage: (message, options) => sent.push({ message, options }),
    });
    assert.equal(result.applied, true);
    assert.equal(result.outcome.status, "completed");
    assert.equal(result.park.parked, true);
    assert.deepEqual(sent, [], "a parked attempt sends no assignment completion callback");
    assert.match(result.delivery.content, /parked · waiting for wait_sa_park_1/);

    const meta = registry.readMeta(fixture.id);
    assert.equal(meta.status, "completed");
    assert.equal(meta.park.waitId, fixture.waitId);
    assert.equal(meta.park.phase, "waiting");
    // The attempt owes no completion callback: the continuation reports instead.
    assert.equal(meta.completionCallbackPendingAt, undefined);
    assert.equal(meta.completionCallbackSentAt, undefined);
    assert.equal(typeof meta.completionCallbackSuppressedAt, "number");
    assert.match(meta.completionCallbackSuppressedReason, /parked on wait/);

    const parked = parkedWaits().filter((entry) => entry.runId === fixture.id);
    assert.equal(parked.length, 1);
    assert.equal(parked[0].conversationId, fixture.id);
    assert.equal(parked[0].phase, "waiting");
});

test("a non-zero exit holds the park disposition and stays an ordinary failure", () => {
    const fixture = parkedRunFixture("sa_park_2");

    const result = finalizeRun(fixture.id, 1);
    assert.equal(result.outcome.status, "failed");
    assert.equal(result.park.parked, false);

    const meta = registry.readMeta(fixture.id);
    assert.equal(meta.status, "failed");
    assert.equal(meta.park.phase, "held");
    assert.match(meta.park.heldReason, /did not exit cleanly|not a clean park/);
    assert.equal(typeof meta.completionCallbackPendingAt, "number");
    assert.equal(meta.completionCallbackSuppressedAt, undefined);
    // A held park stays visible for its owner but is never auto-resumed.
    assert.equal(parkedWaits().find((entry) => entry.runId === fixture.id)?.phase, "held");
    assert.equal(dispositionFor(fixture.id).parked, false);

function dispositionFor(id) {
    return evaluateParkDisposition({ runId: id, cleanExit: true });
}
});

test("a rewritten saved conversation cannot certify a park", () => {
    const fixture = parkedRunFixture("sa_park_3");
    // Tamper with the persisted prefix the checkpoint proved.
    writeFileSync(fixture.sessionFile, `${JSON.stringify({ type: "session", id: fixture.id, cwd: "/elsewhere" })}\n`);

    const disposition = evaluateParkDisposition({ runId: fixture.id, cleanExit: true });
    assert.equal(disposition.parked, false);
    assert.match(disposition.reason, /no longer verifies/);

    const result = finalizeRun(fixture.id, 0);
    assert.equal(result.park.parked, false);
    assert.equal(registry.readMeta(fixture.id).park.phase, "held");
});

test("cleanup protects a parked conversation and its owned workspace", () => {
    const fixture = parkedRunFixture("sa_park_4");
    finalizeRun(fixture.id, 0);

    // A finished run that is NOT parked is an ordinary removal candidate.
    const ordinary = "sa_park_5";
    mkdirSync(registry.runDir(ordinary), { recursive: true });
    registry.writeMeta({
        id: ordinary,
        status: "completed",
        pid: process.pid,
        spawnPid: process.pid,
        cwd: fixture.workspace,
        promptPreview: "old work",
        startedAt: Date.now() - 90 * 24 * 60 * 60 * 1000,
        endedAt: Date.now() - 90 * 24 * 60 * 60 * 1000,
        logPath: registry.logPathFor(ordinary),
        sessionId: ordinary,
        callback: false,
    });
    created.push(ordinary);

    // The daily sweep: a later local date, zero retention for terminal artifacts.
    const later = Date.now() + 40 * 24 * 60 * 60 * 1000;
    const result = runDailyCleanupOnce({
        now: later,
        terminalRunRetentionMs: 1,
        sessionRetentionMs: 1,
    });
    assert.equal(result.errors.length === 0 || result.errors.every((line) => !line.includes("park")), true, JSON.stringify(result.errors));

    // The parked run and its saved conversation survive; the ordinary one need not.
    assert.ok(registry.readMeta(fixture.id), "a parked attempt keeps its record");
    assert.equal(existsSync(fixture.sessionFile), true, "the saved conversation a resume must reopen survives");
    assert.equal(parkedWaits().filter((entry) => entry.runId === fixture.id).length, 1);
});

test("a consumed or cancelled park is no longer a resume candidate", () => {
    const fixture = parkedRunFixture("sa_park_6");
    registry.updateParkRecord(fixture.id, { phase: "consumed" });
    assert.equal(parkedWaits().find((entry) => entry.runId === fixture.id), undefined);
    assert.equal(evaluateParkDisposition({ runId: fixture.id, cleanExit: true }).parked, false);
    assert.equal(registry.readMeta(fixture.id).park.phase, "consumed");
});
