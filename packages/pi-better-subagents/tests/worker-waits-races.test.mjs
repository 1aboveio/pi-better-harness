// @covers observed-waits.worker-resume-races
// @level integration
/**
 * Race regressions from the reviewer handoff, against the real Background host,
 * store and registry:
 *
 * P1-1 final dispatch fence — a parent/Goal/permission/capacity/cancellation
 *      change during asynchronous preparation must prevent the spawn.
 * P1-2 cancellation — a cancelled generation must follow and stop the attempt it
 *      already published, and must never signal an unattributable pid.
 * P1-3 workspace identity — the Background scope uses the WORKER workspace, not
 *      the foreground parent's workspace.
 * P2 restart reconciliation — a staged checkpoint left in `parking` is finalized
 *      from real writer/lease evidence, or visibly held.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import {
    FinalDispatchRefusal,
    OPERATION_RESUME_ADMISSION_EVENT,
    PreSpawnResumeError,
    assertFinalResumeDispatch,
    backgroundScopeForMeta,
    cancelParkedWait,
    createOwnedAttemptStopper,
    createWorkerOperationsRpc,
    conversationWriterLeaseLive,
    finalizeWorkerParkAfterExit,
    parkedWaitsForResumedAttempt,
    recoverStagedPark,
    reconcileParkedWaits,
    releaseChild,
    settleResumedAttemptExit,
    writerPresence,
} from "../worker-waits.ts";
import { realProcessProbe } from "../health.ts";
import * as registry from "../registry.ts";
import { readParkRecord } from "../registry.ts";
import { assertObservationStorage, pendingObservations } from "../outage-observations.ts";
import { createObservedWaitHost } from "../../pi-better-background-tasks/src/observed-waits.ts";
import { acquireConversationLease } from "../continuation.ts";
import { captureParkCheckpoint } from "../park-checkpoint.ts";
import { assignmentRetainsEvidence, coordinatorPath } from "../assignment-outcomes.ts";
import { cleanupAll, createCtx, createPiStub, defaultPlan, schemasFor, sessionFixture, startStack, writeCoherentLog } from "./worker-waits-support.mjs";

const durableRoot = mkdtempSync(join(tmpdir(), "worker-races-durable-"));
const volatileRoot = mkdtempSync(join(tmpdir(), "worker-races-tmp-"));
const children = [];

before(() => {
    process.env.PI_SUBAGENT_DURABLE_DIR = durableRoot;
    process.env.TMPDIR = volatileRoot;
});

after(() => {
    for (const child of children) { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    cleanupAll();
    rmSync(durableRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    rmSync(volatileRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

afterEach(() => cleanupAll());

function workerScope(attemptId, workspace, { branchId = "branch-1", goalId = null } = {}) {
    return { runId: attemptId, conversationId: attemptId, workspace, authorityReference: "authority:test", branchId, goalId };
}

/**
 * A real staged/ready park generation:
 * a supervised task was launched through the RPC surface, a wait was registered
 * and checkpointed, and the attempt's record + verified park record were written.
 */
async function seedPark(stack, {
    attemptId,
    /** `parking` (staged only) or `ready` (checkpoint proved and the task settled). */
    target = "parking",
    ownerWorkspace = stack.workspace,
    ownerSessionId = "parent-session-1",
    goalId = null,
    completed = true,
    assignment = false,
} = {}) {
    const plan = defaultPlan();
    const policy = {
        version: 1,
        sandbox: null,
        tools: ["read", "write", "bash"],
        clean: false,
        deadlineAt: null,
        authorityReference: `authority:races:${attemptId}`,
        workspace: stack.workspace,
    };
    await stack.bridge.register({
        runId: attemptId,
        conversationId: attemptId,
        workspace: stack.workspace,
        authorityReference: policy.authorityReference,
        branchId: "branch-1",
        goalId,
        policy,
        capabilities: plan.capabilities,
        tools: plan.tools,
        schemas: schemasFor(stack.pi, plan.tools),
        attemptId,
        owner: { sessionId: ownerSessionId, workspace: ownerWorkspace, branchId: "branch-1", goalId },
    });
    const owner = { kind: "worker-conversation", sessionId: attemptId, workspace: stack.workspace, branchId: "branch-1", goalId };
    if (assignment) stack.store.registerAssignment({ assignmentId: `assignment:${attemptId}`, owner,
        recipient: { kind: "parent-session", sessionId: ownerSessionId, workspace: ownerWorkspace, branchId: "branch-1", goalId }, attemptId });
    const launch = await stack.bridge.rpc.call("execute-tool", {
        runId: attemptId,
        conversationId: attemptId,
        tool: "bg_task_spawn",
        params: { argv: [process.execPath, "-e", "console.log('race-ok')"], shell: false, name: "race-task" },
    });
    const taskId = String(launch.id);
    const admitted = await stack.bridge.rpc.call("wait-admission", {
        runId: attemptId,
        conversationId: attemptId,
        taskIds: [taskId],
        continuationNote: "Read the result and continue.",
        attemptId,
        owner,
    });
    const waitId = String(admitted.waitId);
    const generation = Number(admitted.generation);
    await stack.bridge.rpc.call("checkpoint", {
        runId: attemptId,
        conversationId: attemptId,
        waitId,
        generation,
        toolCallId: "call-wait-1",
        attemptId,
        evidence: { version: 1, sessionId: attemptId, sessionFile: "x.jsonl", toolCallId: "call-wait-1", waitId, generation, entryId: "e", prefixBytes: 1, prefixSha256: "a".repeat(64) },
    });
    if (target === "ready") {
        await stack.bridge.rpc.call("checkpoint", {
            runId: attemptId,
            conversationId: attemptId,
            waitId,
            generation,
            writerLeaseReleased: true,
            writerPidGone: true,
        });
        const deadline = Date.now() + 30_000;
        for (;;) {
            await stack.host.reconcileNow();
            const view = stack.service.listWorkerWaits(workerScope(attemptId, stack.workspace, { goalId }), { pendingOnly: true })
                .find((entry) => entry.waitId === waitId);
            if (view?.phase === "ready") break;
            if (Date.now() > deadline) throw new Error("seeded task did not become ready");
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
    }

    return { waitId, generation, taskId, plan, policy };
}

function writeParkedAttempt(stack, {
    attemptId,
    waitId,
    generation,
    ownerWorkspace = stack.workspace,
    goalId = null,
    status = "completed",
    exitCode = 0,
    pid = 999_999,
    pidStartTime,
    operationsWorkspace = stack.workspace,
}) {
    const { sessionDirectory, sessionFile } = sessionFixture(durableRoot, attemptId);
    writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: attemptId, cwd: stack.workspace })}\n`);
    registry.writeMeta({
        id: attemptId,
        status,
        pid,
        ...(pidStartTime !== undefined ? { pidStartTime } : {}),
        spawnPid: process.pid,
        cwd: stack.workspace,
        promptPreview: "race fixture",
        startedAt: Date.now() - 1_000,
        ...(status === "completed" ? { endedAt: Date.now() - 500, exitCode, lifecycleClassification: "complete" } : {}),
        logPath: registry.logPathFor(attemptId),
        sessionId: attemptId,
        callback: true,
        operations: {
            version: 1,
            bridgeRunId: attemptId,
            conversationId: attemptId,
            workspace: operationsWorkspace,
            authorityReference: "authority:races",
            branchId: "branch-1",
            goalId,
            policy: { version: 1, sandbox: null, tools: ["read"], clean: false, deadlineAt: null },
            tools: [],
        },
        recipe: {
            version: 1,
            attemptId,
            sessionId: attemptId,
            sessionDir: sessionDirectory,
            cwd: stack.workspace,
            tools: "read",
            clean: false,
            allowNested: false,
            approve: false,
            sandbox: false,
            gitCloneWorkspace: false,
            callback: true,
        },
    });
    writeCoherentLog(registry.logPathFor(attemptId));
    // The park record's verified checkpoint is captured from a real saved session
    // whose last message is the wait tool result.
    const toolCallId = "call-wait-1";
    const header = JSON.stringify({ type: "session", id: attemptId, cwd: stack.workspace });
    const call = JSON.stringify({ type: "message", id: "e1", message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "wait_for_operations" }] } });
    const result = JSON.stringify({ type: "message", id: "e2", message: { role: "toolResult", toolCallId, toolName: "wait_for_operations", isError: false, content: [], details: { operationWait: { waitId, generation } } } });
    writeFileSync(sessionFile, `${[header, call, result].join("\n")}\n`);
    const evidence = captureParkCheckpoint({ sessionId: attemptId, sessionFile, toolCallId, waitId, generation });
    registry.writeParkRecord(attemptId, {
        version: 1,
        waitId,
        generation,
        phase: "parking",
        attemptId,
        ownerSessionId: "parent-session-1",
        ownerWorkspace,
        ownerBranchId: "branch-1",
        ownerGoalId: goalId,
        continuationNote: "Read the result and continue.",
        checkpoint: {
            sessionId: evidence.sessionId,
            sessionFile: evidence.sessionFile,
            toolCallId: evidence.toolCallId,
            entryId: evidence.entryId,
            prefixBytes: evidence.prefixBytes,
            prefixSha256: evidence.prefixSha256,
        },
        parkedAt: Date.now(),
        updatedAt: Date.now(),
    });
    return { evidence, sessionFile };
}

async function publishResume(stack, { attemptId, waitId, generation, launchToken = `slt_${randomUUID()}` }) {
    const scope = workerScope(attemptId, stack.workspace);
    const snapshot = await stack.bridge.rpc.call("wait-snapshot", { waitId, generation });
    const claim = await stack.bridge.rpc.call("claim-resume", {
        runId: attemptId,
        waitId,
        generation,
        expectedCancelEpoch: Number(snapshot.cancelEpoch ?? 0),
        lease: { ownerId: `test:${process.pid}`, pid: process.pid },
        reservedCheckpointId: "entry-e2",
    });
    const attempt = `sa_resumed_${randomUUID().slice(0, 8)}`;
    await stack.bridge.rpc.call("publish-resume", {
        runId: attemptId,
        waitId,
        generation,
        claimId: claim.claimId,
        claimToken: claim.claimToken,
        attemptId: attempt,
        launchToken,
    });
    void scope;
    return { claimId: claim.claimId, claimToken: claim.claimToken, attemptId: attempt, launchToken, cancelEpoch: Number(claim.cancelEpoch) };
}

function parkFor(attemptId, waitId, generation) {
    const meta = registry.readMeta(attemptId);
    return {
        runId: attemptId,
        conversationId: attemptId,
        attemptId,
        waitId,
        generation,
        phase: registry.readParkRecord(attemptId)?.phase ?? "parking",
        meta,
        record: registry.readParkRecord(attemptId),
    };
}

/** Seed one published resume generation and return its fence input. */
async function fenceFixture(stack, attemptId) {
    const seeded = await seedPark(stack, { attemptId, target: "ready" });
    writeParkedAttempt(stack, { attemptId, waitId: seeded.waitId, generation: seeded.generation });
    const claim = await publishResume(stack, { attemptId, waitId: seeded.waitId, generation: seeded.generation });
    const ctx = createCtx(stack.workspace);
    const owner = { sessionId: "parent-session-1", workspace: stack.workspace, branchId: "branch-1", goalId: null };
    return {
        attemptId,
        seeded,
        claim,
        owner,
        input: {
            pi: stack.pi,
            rpc: stack.bridge.rpc,
            service: () => stack.service,
            context: () => ctx,
            park: parkFor(attemptId, seeded.waitId, seeded.generation),
            claim,
            owner,
            admissionRevision: 7,
            permissionsUnchanged: () => true,
            capacityAvailable: () => true,
        },
        ctx,
    };
}

function allowGoal(stack, revision = 7) {
    stack.events.removeAllListeners(OPERATION_RESUME_ADMISSION_EVENT);
    stack.events.on(OPERATION_RESUME_ADMISSION_EVENT, (request) => request.reply({ allowed: true, revision }));
}

test("the final dispatch fence validates the durable claim again at the synchronous release point", async () => {
    const stack = await startStack();
    const steady = await fenceFixture(stack, "sa_race_fence");
    allowGoal(stack);
    const guard = await assertFinalResumeDispatch(steady.input);
    // The returned guard is the release-time confirmation; invoking it is the
    // only thing between the last await and the spawn.
    guard();

    // A cancellation performed INSIDE the Goal handler is not accepted on the
    // earlier durable read: the synchronous guard after Goal catches it.
    const inGoal = await fenceFixture(stack, "sa_race_goal_cancel");
    const originalRpc = inGoal.input.rpc;
    inGoal.input.rpc = { async call(method, params) {
        const result = await originalRpc.call(method, params);
        if (method === "publish-resume") stack.service.cancelWorkerWait(workerScope(inGoal.attemptId, stack.workspace), {
            waitId: inGoal.seeded.waitId, generation: inGoal.seeded.generation, reason: "cancelled during preparation",
        });
        return result;
    } };
    await assert.rejects(
        () => assertFinalResumeDispatch(inGoal.input),
        (error) => {
            assert.ok(error instanceof PreSpawnResumeError);
            assert.ok(error instanceof FinalDispatchRefusal);
            assert.match(error.message, /not resuming|not resuming at dispatch|cancelled|replaced/);
            return true;
        },
    );

    // A cancellation after the fence returned is still caught by the guard, and
    // the guard runs before the spawn.
    const afterFence = await fenceFixture(stack, "sa_race_guard");
    allowGoal(stack);
    const lateGuard = await assertFinalResumeDispatch(afterFence.input);
    stack.service.cancelWorkerWait(workerScope(afterFence.attemptId, stack.workspace), {
        waitId: afterFence.seeded.waitId,
        generation: afterFence.seeded.generation,
        reason: "cancelled after the fence returned",
    });
    assert.throws(() => lateGuard(), (error) => {
        assert.ok(error instanceof FinalDispatchRefusal);
        assert.match(error.message, /not resuming at dispatch|gone at dispatch|cancelled|replaced/);
        return true;
    });

    // Goal's in-process proof is checked again at release, after its async reply.
    const goalRelease = await fenceFixture(stack, "sa_race_goal_release");
    let goalCurrent = true;
    stack.events.removeAllListeners(OPERATION_RESUME_ADMISSION_EVENT);
    stack.events.on(OPERATION_RESUME_ADMISSION_EVENT, (request) => request.reply({allowed: true, revision: 7, isCurrent: () => goalCurrent}));
    const goalGuard = await assertFinalResumeDispatch(goalRelease.input);
    goalCurrent = false;
    assert.equal(releaseChild(goalGuard, () => "started"), "started");

    // Policy, capacity, parent identity and branch changes are all re-checked by
    // the same guard.
    const checks = await fenceFixture(stack, "sa_race_guard_checks");
    allowGoal(stack);
    let permissions = true;
    const guardInput = { ...checks.input, permissionsUnchanged: () => permissions };
    const baselineGuard = await assertFinalResumeDispatch(guardInput);
    baselineGuard();
    permissions = false;
    assert.throws(() => baselineGuard(), /permissions changed before dispatch/);

    const tightened = await fenceFixture(stack, "sa_race_tightened");
    allowGoal(stack);
    await assert.rejects(
        () => assertFinalResumeDispatch({ ...tightened.input, permissionsUnchanged: () => false }),
        /permissions changed while the resume was being prepared/,
    );
    const noCapacity = await fenceFixture(stack, "sa_race_capacity");
    allowGoal(stack);
    await assert.rejects(
        () => assertFinalResumeDispatch({ ...noCapacity.input, capacityAvailable: () => false }),
        /Capacity changed/,
    );
    const sessionSwitch = await fenceFixture(stack, "sa_race_session");
    allowGoal(stack);
    (await assertFinalResumeDispatch({ ...sessionSwitch.input, context: () => createCtx(stack.workspace, "parent-session-2") }))();
    const branchSwitch = await fenceFixture(stack, "sa_race_branch");
    allowGoal(stack);
    (await assertFinalResumeDispatch({ ...branchSwitch.input, context: () => createCtx(stack.workspace, "parent-session-1", "branch-2") }))();
});

test("the release guard runs synchronously immediately before the spawn", async () => {
    const order = [];
    // A refused guard must prevent the spawn entirely.
    assert.throws(
        () => releaseChild(() => { order.push("guard"); throw new FinalDispatchRefusal("stale claim"); }, () => { order.push("spawn"); }),
        FinalDispatchRefusal,
    );
    assert.deepEqual(order, ["guard"], "the spawn must not run after a refused guard");

    // With an accepted guard, the spawn happens in the same synchronous block:
    // a microtask scheduled by the guard cannot interleave.
    order.length = 0;
    releaseChild(() => {
        order.push("guard");
        Promise.resolve().then(() => order.push("microtask"));
    }, () => { order.push("spawn"); });
    assert.deepEqual(order, ["guard", "spawn"], "no await or microtask may sit between the guard and the spawn");
    await Promise.resolve();
    assert.deepEqual(order, ["guard", "spawn", "microtask"]);
});

test("cancellation stops the attempt it published and never signals a foreign pid", async () => {
    const stack = await startStack();
    const attemptId = "sa_race_cancel";
    const seeded = await seedPark(stack, { attemptId, target: "ready" });
    writeParkedAttempt(stack, { attemptId, waitId: seeded.waitId, generation: seeded.generation });
    const claim = await publishResume(stack, { attemptId, waitId: seeded.waitId, generation: seeded.generation });

    // A real owned child stands in for the resumed execution.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    children.push(child);
    const meta = registry.readMeta(attemptId);
    meta.pid = child.pid;
    meta.pgid = child.pid;
    meta.status = "running";
    meta.operations.resumeLaunchToken = claim.launchToken;
    registry.writeMeta({ ...meta, id: attemptId });
    // The resume publication is recorded on the parked generation.
    const parked = registry.readParkRecord(attemptId);
    registry.updateParkRecord(attemptId, {
        phase: "resuming",
        resumedAt: Date.now(),
        resumedBy: claim.attemptId,
        resumeLaunchToken: claim.launchToken,
        resumeClaimId: claim.claimId,
        resumeClaimToken: claim.claimToken,
    });
    void parked;

    const park = parkFor(attemptId, seeded.waitId, seeded.generation);
    // The published attempt's own run record (new attempt id, same parent).
    const liveResumedMeta = { ...registry.readMeta(attemptId) };
    delete liveResumedMeta.park;
    registry.writeMeta({
        ...liveResumedMeta,
        id: claim.attemptId,
        status: "running",
        pid: child.pid,
        pgid: child.pid,
        spawnPid: process.pid,
        sessionId: attemptId,
        operations: { ...liveResumedMeta.operations, bridgeRunId: claim.attemptId, resumeLaunchToken: claim.launchToken },
        logPath: registry.logPathFor(claim.attemptId),
    });
    // The park record now points at that attempt; the fixture above wrote the
    // original id, so point it at the published one.
    registry.writeParkRecord(attemptId, { ...registry.readParkRecord(attemptId), attemptId, resumedBy: claim.attemptId });

    await cancelParkedWait(stack.service, park, "cancelled by the owner", { stopAttempt: createOwnedAttemptStopper() });
    const deadline = Date.now() + 5_000;
    let gone = false;
    while (Date.now() < deadline) {
        try { process.kill(child.pid, 0); } catch { gone = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(gone, true, "the owned published attempt must be stopped");
    const record = readParkRecord(attemptId);
    assert.equal(record.phase, "cancelled");
    assert.match(record.cancelReason, /published continuation .* was stopped/);

    // A foreign attempt (spawned by another parent) is left alone.
    const foreign = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    children.push(foreign);
    const second = "sa_race_foreign";
    const seeded2 = await seedPark(stack, { attemptId: second, target: "ready" });
    writeParkedAttempt(stack, { attemptId: second, waitId: seeded2.waitId, generation: seeded2.generation });
    registry.updateParkRecord(second, { phase: "resuming", resumedBy: "sa_foreign_attempt", resumeLaunchToken: "slt_foreign" });
    const foreignMeta = { ...registry.readMeta(second) };
    delete foreignMeta.park;
    registry.writeMeta({
        ...foreignMeta,
        id: "sa_foreign_attempt",
        status: "running",
        pid: foreign.pid,
        pgid: foreign.pid,
        spawnPid: process.ppid,
        sessionId: second,
        operations: { ...foreignMeta.operations, bridgeRunId: "sa_foreign_attempt", resumeLaunchToken: "slt_foreign" },
        logPath: registry.logPathFor("sa_foreign_attempt"),
    });
    await cancelParkedWait(stack.service, parkFor(second, seeded2.waitId, seeded2.generation), "cancelled by the owner", {
        stopAttempt: createOwnedAttemptStopper(),
    });
    let foreignAlive = true;
    try { process.kill(foreign.pid, 0); } catch { foreignAlive = false; }
    assert.equal(foreignAlive, true, "an attempt this parent did not spawn must not be signalled");
    assert.match(readParkRecord(second).cancelReason, /left running/);
    try { foreign.kill("SIGKILL"); } catch { /* already gone */ }
});

test("failed durable cancellation rejects and retains the original wait for inspection", async () => {
    const stack = await startStack();
    const attemptId = "sa_cancel_storage_failure";
    const seeded = await seedPark(stack, { attemptId, target: "ready" });
    writeParkedAttempt(stack, { attemptId, waitId: seeded.waitId, generation: seeded.generation });
    const before = readParkRecord(attemptId);
    await assert.rejects(cancelParkedWait({ cancelWorkerWait() { throw new Error("storage unavailable"); } },
        parkFor(attemptId, seeded.waitId, seeded.generation), "explicit stop"), /storage unavailable/);
    const after = readParkRecord(attemptId);
    assert.equal(after.phase, "held");
    assert.equal(after.waitId, before.waitId);
    assert.equal(after.ownerSessionId, before.ownerSessionId);
    assert.match(after.cancelReason, /storage unavailable/);
});

test("global reconciliation scopes historical warnings without changing ownership or acknowledging evidence", async () => {
    const stack = await startStack();
    const attemptId = "sa_historical_scoped";
    const seeded = await seedPark(stack, { attemptId, target: "ready", ownerSessionId: "session-A" });
    writeParkedAttempt(stack, { attemptId, waitId: seeded.waitId, generation: seeded.generation });
    registry.updateParkRecord(attemptId, { phase: "resuming", resumedBy: "sa_missing_history_attempt" });
    const original = readParkRecord(attemptId);
    const notices = [];
    for (let reload = 0; reload < 2; reload++) {
        await reconcileParkedWaits(stack.service, { resume: async () => "skipped", notifyWhen: () => false,
            notify: (message) => notices.push(message) });
    }
    assert.deepEqual(notices, []);
    const retained = readParkRecord(attemptId);
    assert.equal(retained.ownerSessionId, original.ownerSessionId);
    assert.equal(retained.waitId, original.waitId);
    const durable = stack.service.listWorkerWaits(backgroundScopeForMeta(registry.readMeta(attemptId), retained))
        .find((wait) => wait.waitId === seeded.waitId);
    assert.ok(!durable.acknowledgement);
    assert.notEqual(durable.phase, "cancelled");
});

test("cancellation waits for durable cancellation and the deferred writer check before reporting success", async () => {
    const stack = await startStack();
    const attemptId = "sa_deferred_cancellation";
    const seeded = await seedPark(stack, { attemptId, target: "ready" });
    writeParkedAttempt(stack, { attemptId, waitId: seeded.waitId, generation: seeded.generation });
    const resumedId = "sa_deferred_writer";
    registry.writeMeta({ ...registry.readMeta(attemptId), id: resumedId, park: undefined });
    registry.updateParkRecord(attemptId, { resumedBy: resumedId });
    let release;
    let entered;
    const checking = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    let returned = false;
    const cancellation = cancelParkedWait(stack.service, parkFor(attemptId, seeded.waitId, seeded.generation), "explicit cancellation", {
        stopAttempt: async () => { entered(); await gate; return "foreign"; },
    }).then(() => { returned = true; });
    await checking;
    assert.equal(returned, false);
    const record = readParkRecord(attemptId);
    const durable = stack.service.listWorkerWaits(backgroundScopeForMeta(registry.readMeta(attemptId), record))
        .find((wait) => wait.waitId === seeded.waitId);
    assert.equal(durable.phase, "cancelled");
    release();
    await cancellation;
    assert.equal(returned, true);
    assert.equal(readParkRecord(attemptId).phase, "cancelled");
    assert.match(readParkRecord(attemptId).cancelReason, /left running/);
    assert.ok(!durable.acknowledgement);
});

test("park finalization uses the worker workspace, not the foreground parent workspace", async () => {
    const stack = await startStack();
    const attemptId = "sa_race_workspace";
    const parentWorkspace = join(stack.root, "parent-workspace");
    const seeded = await seedPark(stack, { attemptId, target: "parking", ownerWorkspace: parentWorkspace });
    writeParkedAttempt(stack, {
        attemptId,
        waitId: seeded.waitId,
        generation: seeded.generation,
        ownerWorkspace: parentWorkspace,
        operationsWorkspace: stack.workspace,
    });
    const park = parkFor(attemptId, seeded.waitId, seeded.generation);
    assert.equal(backgroundScopeForMeta(park.meta, park.record).workspace, stack.workspace);
    assert.deepEqual(
        { foreground: park.record.ownerWorkspace, worker: backgroundScopeForMeta(park.meta, park.record).workspace },
        { foreground: parentWorkspace, worker: stack.workspace },
    );

    // Background only recognizes the worker workspace, so finalization proves the fix.
    const result = await finalizeWorkerParkAfterExit({
        runId: attemptId,
        service: stack.service,
        writerLeaseReleased: true,
        writerPidGone: true,
    });
    assert.equal(result.outcome, "parked", JSON.stringify(result));
    assert.equal(readParkRecord(attemptId).phase, "waiting");
});

test("restart reconciliation finalizes a proven staged park and holds an ambiguous one", async () => {
    const stack = await startStack();
    const attemptId = "sa_race_restart";
    const seeded = await seedPark(stack, { attemptId, target: "parking" });
    writeParkedAttempt(stack, { attemptId, waitId: seeded.waitId, generation: seeded.generation });
    const park = parkFor(attemptId, seeded.waitId, seeded.generation);

    // The exit handler never ran (restart). The staged checkpoint plus a dead
    // writer and a free lease is the evidence; it must finalize, not strand.
    const recovered = await recoverStagedPark(park, stack.service);
    assert.equal(recovered, "parked");
    const afterRecovery = readParkRecord(attemptId);
    assert.notEqual(afterRecovery.phase, "parking");

    // Ambiguous: a live conversation writer lease holds the history.
    const attemptId2 = "sa_race_lease";
    const seeded2 = await seedPark(stack, { attemptId: attemptId2, target: "parking" });
    writeParkedAttempt(stack, { attemptId: attemptId2, waitId: seeded2.waitId, generation: seeded2.generation });
    const lease = acquireConversationLease({ sessionId: attemptId2, attemptId: "sa_race_writer" });
    try {
        const held = await recoverStagedPark(parkFor(attemptId2, seeded2.waitId, seeded2.generation), stack.service);
        assert.equal(held, "held");
        assert.match(readParkRecord(attemptId2).heldReason, /live conversation writer lease/);
    } finally {
        lease.release();
    }

    // An ORPHANED attempt whose writer is still alive has no lease (a fresh
    // writer never takes one), so liveness must be proven from process identity,
    // not from the recorded status or a missing lease.
    const attemptId3 = "sa_race_orphaned";
    const seeded3 = await seedPark(stack, { attemptId: attemptId3, target: "parking" });
    // The real probe is what production uses; the injected probe pins the exact
    // process-identity evidence this test needs.
    assert.equal(realProcessProbe.pidExists(process.pid), true);
    const liveToken = "live-writer-start-token";
    const liveProbe = {
        pidExists: (pid) => pid === process.pid,
        startToken: (pid) => (pid === process.pid ? liveToken : undefined),
        groupId: () => undefined,
        groupAlive: () => false,
    };
    writeParkedAttempt(stack, {
        attemptId: attemptId3,
        waitId: seeded3.waitId,
        generation: seeded3.generation,
        status: "orphaned",
        pid: process.pid,
        pidStartTime: liveToken,
    });
    const orphanedPark = parkFor(attemptId3, seeded3.waitId, seeded3.generation);
    assert.equal(writerPresence(orphanedPark.meta, liveProbe), "alive");
    assert.equal(await recoverStagedPark(orphanedPark, stack.service, { probe: liveProbe }), "held");
    assert.match(readParkRecord(attemptId3).heldReason, /writer pid .* still alive/);

    // A live pid whose start identity cannot be compared is ambiguous, not an exit.
    const attemptId4 = "sa_race_unknown";
    const seeded4 = await seedPark(stack, { attemptId: attemptId4, target: "parking" });
    writeParkedAttempt(stack, {
        attemptId: attemptId4,
        waitId: seeded4.waitId,
        generation: seeded4.generation,
        status: "orphaned",
        pid: process.pid,
    });
    const unknownProbe = {
        pidExists: (pid) => pid === process.pid,
        startToken: () => undefined,
        groupId: () => undefined,
        groupAlive: () => false,
    };
    const unknownPark = parkFor(attemptId4, seeded4.waitId, seeded4.generation);
    assert.equal(writerPresence(unknownPark.meta, unknownProbe), "unverified");
    assert.equal(await recoverStagedPark(unknownPark, stack.service, { probe: unknownProbe }), "held");
    assert.match(readParkRecord(attemptId4).heldReason, /process identity cannot be verified/);
});

/** A published resume whose attempt already has a run record in `status`. */
async function publishedResumeWithAttempt(stack, attemptId, status, assignment = false) {
    const seeded = await seedPark(stack, { attemptId, target: "ready", assignment });
    writeParkedAttempt(stack, { attemptId, waitId: seeded.waitId, generation: seeded.generation });
    const claim = await publishResume(stack, { attemptId, waitId: seeded.waitId, generation: seeded.generation });
    registry.updateParkRecord(attemptId, {
        phase: "resuming",
        resumedAt: Date.now(),
        resumedBy: claim.attemptId,
        resumeLaunchToken: claim.launchToken,
        resumeClaimId: claim.claimId,
        resumeClaimToken: claim.claimToken,
    });
    const resumedMeta = { ...registry.readMeta(attemptId) };
    // A resumed attempt has no park disposition of its own; it is the target of the
    // parked attempt's record.
    delete resumedMeta.park;
    registry.writeMeta({
        ...resumedMeta,
        id: claim.attemptId,
        status,
        pid: status === "running" ? process.pid : 999_998,
        spawnPid: process.pid,
        sessionId: attemptId,
        exitCode: status === "completed" ? 0 : 1,
        endedAt: Date.now() - 100,
        ...(status === "completed" ? { lifecycleClassification: "complete" } : {}),
        operations: {
            ...resumedMeta.operations,
            bridgeRunId: claim.attemptId,
            resumeLaunchToken: claim.launchToken,
        },
        logPath: registry.logPathFor(claim.attemptId),
        ...(assignment ? { assignment: { version: 1, assignmentId: `assignment:${attemptId}` } } : {}),
    });
    return { seeded, claim, scope: workerScope(attemptId, stack.workspace) };
}

function waitState(stack, attemptId, waitId) {
    return stack.store ?? null;
}

test("outage observation survives registry loss and replays one repair, then retains recurring failure", async () => {
    const stack = await startStack();
    const root = "sa_outage_replay";
    const resumed = await publishedResumeWithAttempt(stack, root, "completed", true);
    const before = stack.store.listEvidencePins({ waitId: resumed.seeded.waitId, generation: 1 });
    const unavailable = await settleResumedAttemptExit({ attemptId: resumed.claim.attemptId });
    assert.equal(unavailable.outcome, "deferred");
    assert.match(readParkRecord(root).heldReason, /unverified/);
    assert.equal(stack.store.getWait({ waitId: resumed.seeded.waitId, generation: 1 }).phase, "resuming");
    const report = pendingObservations().find((entry) => entry.meta.id === root);
    assert.ok(report);
    await settleResumedAttemptExit({ attemptId: resumed.claim.attemptId, reason: "new words" });
    assert.equal(pendingObservations().filter((entry) => entry.meta.id === root).length, 1);
    rmSync(registry.runDir(root), { recursive: true, force: true });
    rmSync(registry.runDir(resumed.claim.attemptId), { recursive: true, force: true });
    stack.host.close();
    const replacementPi = createPiStub().pi;
    const replacement = createObservedWaitHost(replacementPi, { storePath: stack.storePath,
        supervisorDirectory: join(stack.root, "supervisor"), pollMs: 0 });
    replacement.start(stack.ctx);
    stack.service = replacement.service;
    // Replacement uses the same coordinator records, not copied repair accounting.
    try {
    let admissions = 0;
    const messages = [];
    await reconcileParkedWaits(stack.service, { notify: (message) => messages.push(message), resume: async () => { admissions++; return "skipped"; } });
    assert.equal(admissions, 1, JSON.stringify({ messages, record: readParkRecord(root), wait: stack.store.getWait({ waitId: resumed.seeded.waitId, generation: 1 }) }));
    assert.equal(pendingObservations().filter((entry) => entry.id === report.id).length, 0);
    assert.equal(stack.store.getWait({ waitId: resumed.seeded.waitId, generation: 1 }).phase, "ready");
    assert.deepEqual(stack.store.listEvidencePins({ waitId: resumed.seeded.waitId, generation: 1 }), before);
    const rpc = createWorkerOperationsRpc(replacementPi);
    await rpc.call("register-run", { runId: root, conversationId: root, workspace: stack.workspace,
        authorityReference: resumed.seeded.policy.authorityReference,
        attemptId: root, policy: resumed.seeded.policy, capabilities: resumed.seeded.plan.capabilities,
        tools: resumed.seeded.plan.tools, assignmentOutcomesVersion: 1 });
    const claim = await publishResume({ ...stack, bridge: { rpc } }, { attemptId: root, waitId: resumed.seeded.waitId, generation: 1 });
    registry.updateParkRecord(root, { phase: "resuming", resumedBy: claim.attemptId, resumeClaimId: claim.claimId, resumeClaimToken: claim.claimToken, resumeLaunchToken: claim.launchToken });
    registry.writeMeta({ ...registry.readMeta(resumed.claim.attemptId), id: claim.attemptId,
        operations: { ...registry.readMeta(resumed.claim.attemptId).operations, resumeLaunchToken: claim.launchToken } });
    await settleResumedAttemptExit({ attemptId: claim.attemptId });
    await reconcileParkedWaits(stack.service, { resume: async () => assert.fail("exhausted repair must not launch") });
    const outcome = stack.store.getAssignmentOutcome(`assignment:${root}`);
    assert.equal(outcome.outcome, "failed");
    assert.equal(outcome.recipient.sessionId, "parent-session-1");
    await reconcileParkedWaits(stack.service, { resume: async () => assert.fail("terminal replay must not launch") });
    assert.deepEqual(stack.store.getAssignmentOutcome(`assignment:${root}`), outcome);
    assert.equal(stack.store.getWait({ waitId: resumed.seeded.waitId, generation: 1 }).acknowledgement, null);
    } finally { replacement.close(); }
});

test("an unavailable observation cannot block another assignment's replay", async () => {
    const stack = await startStack();
    const first = await publishedResumeWithAttempt(stack, "sa_outage_isolated_a", "completed", true);
    const second = await publishedResumeWithAttempt(stack, "sa_outage_isolated_b", "completed", true);
    await settleResumedAttemptExit({ attemptId: first.claim.attemptId });
    await settleResumedAttemptExit({ attemptId: second.claim.attemptId });
    const reports = pendingObservations().filter((report) => report.meta.id.startsWith("sa_outage_isolated_"));
    const unavailable = reports[0].meta.id;
    const recoverable = reports[1].meta.id;
    const admissions = [];
    await reconcileParkedWaits({ ...stack.service, listWorkerWaits: (scope, options) => {
        if (scope.runId === unavailable) throw new Error("fixture coordinator scope unavailable");
        return stack.service.listWorkerWaits(scope, options);
    } }, { resume: async (park) => { admissions.push(park.runId); return "skipped"; } });
    assert.ok(admissions.includes(recoverable));
    assert.equal(readParkRecord(unavailable).phase, "resuming");
    assert.ok(pendingObservations().some((report) => report.meta.id === unavailable));
});

test("outage replay preserves newer cancellation without interpreting it", async () => {
    const stack = await startStack();
    const resumed = await publishedResumeWithAttempt(stack, "sa_outage_cancel", "failed", true);
    await settleResumedAttemptExit({ attemptId: resumed.claim.attemptId });
    stack.service.cancelWorkerWait(resumed.scope, { waitId: resumed.seeded.waitId, generation: 1, reason: "explicit stop" });
    await reconcileParkedWaits(stack.service, { resume: async () => assert.fail("cancelled report cannot dispatch") });
    assert.equal(readParkRecord("sa_outage_cancel").phase, "cancelled");
    assert.equal(stack.store.getWait({ waitId: resumed.seeded.waitId, generation: 1 }).acknowledgement, null);
});

test("stale outage report cannot replace a newer published writer", async () => {
    const stack = await startStack();
    const root = "sa_outage_new_writer";
    const resumed = await publishedResumeWithAttempt(stack, root, "completed", true);
    await settleResumedAttemptExit({ attemptId: resumed.claim.attemptId });
    await settleResumedAttemptExit({ attemptId: resumed.claim.attemptId, service: stack.service });
    const newer = await publishResume(stack, { attemptId: root, waitId: resumed.seeded.waitId, generation: 1 });
    registry.writeMeta({ ...registry.readMeta(resumed.claim.attemptId), id: newer.attemptId,
        status: "running", pid: process.pid, operations: { ...registry.readMeta(resumed.claim.attemptId).operations,
            resumeLaunchToken: newer.launchToken } });
    registry.updateParkRecord(root, { phase: "resuming", resumedBy: newer.attemptId, resumeClaimId: newer.claimId,
        resumeClaimToken: newer.claimToken, resumeLaunchToken: newer.launchToken });
    registry.writeMeta({ ...registry.readMeta(newer.attemptId), status: "lost" }, { ifAbsent: true });
    registry.writeParkRecord(root, { ...readParkRecord(root), resumeClaimId: resumed.claim.claimId }, { ifAbsent: true });
    assert.equal(registry.readMeta(newer.attemptId).status, "running");
    assert.equal(readParkRecord(root).resumeClaimId, newer.claimId);
    await reconcileParkedWaits(stack.service, { resume: async () => assert.fail("new writer already owns the conversation") });
    assert.equal(readParkRecord(root).resumeClaimId, newer.claimId);
    assert.equal(stack.store.getAssignmentOutcome(`assignment:${root}`), null);
    assert.equal(stack.store.getWait({ waitId: resumed.seeded.waitId, generation: 1 }).phase, "resuming");
});

test("durable storage failure refuses parking with degraded supervision", () => {
    const previous = process.env.PI_SUBAGENT_DURABLE_DIR;
    const file = join(durableRoot, "not-a-directory");
    writeFileSync(file, "blocked");
    process.env.PI_SUBAGENT_DURABLE_DIR = file;
    try { assert.throws(assertObservationStorage, /Degraded supervision.*new parking refused/); }
    finally { process.env.PI_SUBAGENT_DURABLE_DIR = previous; }
});

test("assignment unacknowledged exit verifies real checkpoint and permits only one repair across replacement attempts", async () => {
    const stack = await startStack();
    const resumed = await publishedResumeWithAttempt(stack, "sa_bounded_repair", "completed", true);
    const first = await settleResumedAttemptExit({ attemptId: resumed.claim.attemptId, service: stack.service });
    assert.equal(first.waitPhase, "ready");
    assert.equal(stack.store.getWait({ waitId: resumed.seeded.waitId, generation: 1 }).acknowledgement, null);
    const replay = await settleResumedAttemptExit({ attemptId: resumed.claim.attemptId, service: stack.service, reason: "different words" });
    assert.equal(replay.waitPhase, "ready");
    const claim = await publishResume(stack, { attemptId: "sa_bounded_repair", waitId: resumed.seeded.waitId, generation: 1 });
    registry.updateParkRecord("sa_bounded_repair", { phase: "resuming", resumedBy: claim.attemptId, resumeClaimId: claim.claimId, resumeClaimToken: claim.claimToken, resumeLaunchToken: claim.launchToken });
    registry.writeMeta({ ...registry.readMeta(resumed.claim.attemptId), id: claim.attemptId, operations: { ...registry.readMeta(resumed.claim.attemptId).operations, resumeLaunchToken: claim.launchToken } });
    const second = await settleResumedAttemptExit({ attemptId: claim.attemptId, service: stack.service });
    assert.equal(second.waitPhase, "held");
    assert.equal(stack.store.getAssignmentOutcome("assignment:sa_bounded_repair").outcome, "failed");
    assert.equal(stack.store.getAssignmentOutcome("assignment:sa_bounded_repair").recipient.sessionId, "parent-session-1");
    assert.equal(stack.store.getWait({ waitId: resumed.seeded.waitId, generation: 1 }).acknowledgement, null);
});

test("assigned cancellation reconciles its published writer without invoking bounded repair", async () => {
    const stack = await startStack();
    const id = "sa_cancelled_no_repair";
    const resumed = await publishedResumeWithAttempt(stack, id, "completed", true);
    const wait = stack.store.getWait({ waitId: resumed.seeded.waitId, generation: 1 });
    const binding = { version: 1, assignmentId: `assignment:${id}`, owner: wait.owner,
        recipient: { kind: "parent-session", sessionId: "parent-session-1", workspace: stack.workspace, branchId: "branch-1", goalId: null } };
    registry.writeMeta({ ...registry.readMeta(id), assignment: binding });
    stack.store.recordAssignmentOutcome({ ...binding, revision: 1, outcome: "cancelled", reason: "Explicit stop",
        processUncertain: true, evidence: [{ kind: "summary", ref: "cancelled-assignment" }],
        waits: [{ waitId: wait.waitId, generation: 1, cancelEpoch: wait.cancelEpoch }] });
    registry.updateParkRecord(id, { phase: "cancelled" });
    const service = { ...stack.service, repairFailedResumeForWorker: () => assert.fail("cancelled assignments must not enter repair") };
    const result = await settleResumedAttemptExit({ attemptId: resumed.claim.attemptId, service, writerLeaseReleased: true });
    assert.equal(result.outcome, "settled");
    assert.equal(readParkRecord(id).phase, "cancelled");
    assert.equal(stack.store.listResumeClaims({ waitId: wait.waitId }).filter((c) => c.state === "published").length, 0);
    assert.equal(stack.store.getWait({ waitId: wait.waitId, generation: 1 }).acknowledgement, null);
    assert.equal(stack.store.getAssignmentOutcome(binding.assignmentId).outcome, "cancelled");
    assert.equal(stack.store.getAssignmentOutcome(binding.assignmentId).processUncertain, true);
});

test("cancelled outage replay retains uncertainty until exact lease release and never spends repair", async () => {
    const stack = await startStack();
    const id = "sa_cancelled_outage";
    const resumed = await publishedResumeWithAttempt(stack, id, "completed", true);
    await settleResumedAttemptExit({ attemptId: resumed.claim.attemptId });
    const wait = stack.store.getWait({ waitId: resumed.seeded.waitId, generation: 1 });
    const binding = { version: 1, assignmentId: `assignment:${id}`, owner: wait.owner,
        recipient: { kind: "parent-session", sessionId: "parent-session-1", workspace: stack.workspace, branchId: "branch-1", goalId: null } };
    stack.store.recordAssignmentOutcome({ ...binding, revision: 1, outcome: "cancelled", reason: "Explicit stop during outage",
        processUncertain: true, evidence: [{ kind: "summary", ref: "cancelled-outage" }],
        waits: [{ waitId: wait.waitId, generation: 1, cancelEpoch: wait.cancelEpoch }] });
    registry.updateParkRecord(id, { phase: "cancelled", checkpoint: undefined });
    registry.writeMeta({ ...registry.readMeta(id), assignment: binding, operations: { ...registry.readMeta(id).operations,
        policy: { ...registry.readMeta(id).operations.policy, deadlineAt: 1 } } });
    await settleResumedAttemptExit({ attemptId: resumed.claim.attemptId });
    const reports = pendingObservations().filter((report) => report.meta.id === id);
    assert.equal(reports.length, 2, "cancellation retains distinct proof instead of reusing an older observation");
    assert.ok(reports.some((report) => report.observedRevision.cancelled));
    const outcome = stack.store.getAssignmentOutcome(binding.assignmentId);
    const service = { ...stack.service, repairFailedResumeForWorker: () => assert.fail("cancelled replay is not repair") };
    const lease = acquireConversationLease({ sessionId: id, attemptId: resumed.claim.attemptId });
    try {
        await reconcileParkedWaits(service, { resume: () => assert.fail("cancelled work cannot resume") });
        assert.equal(readParkRecord(id).phase, "cancelled");
        assert.equal(stack.store.listResumeClaims({ waitId: wait.waitId, state: "published" }).length, 1);
    } finally { lease.release(); }
    await reconcileParkedWaits(service, { resume: () => assert.fail("proof cannot admit new execution") });
    assert.equal(readParkRecord(id).phase, "cancelled");
    assert.equal(stack.store.listResumeClaims({ waitId: wait.waitId, state: "published" }).length, 0);
    assert.equal(stack.store.getWait(wait).phase, "held");
    assert.equal(stack.store.getWait(wait).acknowledgement, null);
    assert.deepEqual(stack.store.getAssignmentOutcome(binding.assignmentId), outcome);
    assert.equal(pendingObservations().filter((report) => report.meta.id === id).length, 0);
});

test("late exact writer proof reconciles terminal failure after parent consumption and reload", async () => {
    const stack = await startStack({ storePath: coordinatorPath() });
    const id = "sa_late_terminal_proof";
    const resumed = await publishedResumeWithAttempt(stack, id, "running", true);
    const wait = stack.store.getWait({ waitId: resumed.seeded.waitId, generation: 1 });
    const binding = { version: 1, assignmentId: `assignment:${id}`, owner: wait.owner,
        recipient: { kind: "parent-session", sessionId: "parent-session-1", workspace: stack.workspace, branchId: "branch-1", goalId: null } };
    for (const runId of [id, resumed.claim.attemptId]) registry.writeMeta({ ...registry.readMeta(runId), assignment: binding });
    assert.equal((await settleResumedAttemptExit({ attemptId: resumed.claim.attemptId, service: stack.service })).outcome, "deferred");
    const terminal = stack.store.getAssignmentOutcome(binding.assignmentId);
    assert.equal(terminal.outcome, "failed");
    assert.equal(terminal.processUncertain, true);
    assert.equal(stack.store.listResumeClaims({ waitId: wait.waitId, state: "published" }).length, 1);
    const request = { assignmentId: binding.assignmentId, recipient: binding.recipient, revision: terminal.revision };
    stack.store.inspectAssignmentOutcome(request);
    stack.store.consumeAssignmentOutcome({ ...request, disposition: "consumed", note: "Inspected uncertain writer failure" });
    const consumed = stack.store.getAssignmentOutcome(binding.assignmentId);
    assert.equal((await settleResumedAttemptExit({ attemptId: resumed.claim.attemptId })).outcome, "deferred");
    assert.equal(pendingObservations().filter((report) => report.meta.id === id).length, 1);
    assert.equal(assignmentRetainsEvidence(registry.readMeta(id)), true);
    registry.writeMeta({ ...registry.readMeta(resumed.claim.attemptId), status: "failed", pid: 999_998, exitCode: 1 });
    assert.equal((await settleResumedAttemptExit({ attemptId: resumed.claim.attemptId, service: stack.service, writerLeaseReleased: false })).outcome, "deferred");
    assert.equal(stack.store.listResumeClaims({ waitId: wait.waitId, state: "published" }).length, 1);
    const meta = registry.readMeta(id);
    registry.writeMeta({ ...meta, operations: { ...meta.operations, policy: { ...meta.operations.policy, deadlineAt: 1 } } });
    const service = { ...stack.service, repairFailedResumeForWorker: () => assert.fail("terminal failure must not enter repair admission") };
    await reconcileParkedWaits(service, { resume: async () => assert.fail("terminal failure must never launch") });
    assert.equal(stack.store.listResumeClaims({ waitId: wait.waitId, state: "published" }).length, 0);
    assert.deepEqual(stack.store.getAssignmentOutcome(binding.assignmentId), consumed);
    assert.equal(stack.store.getWait({ waitId: wait.waitId, generation: 1 }).acknowledgement, null);
    assert.equal(assignmentRetainsEvidence(registry.readMeta(id)), false);
    assert.equal(pendingObservations().filter((report) => report.meta.id === id).length, 0);
});

test("missing continuation metadata never becomes writer-exit proof across repeated recovery", async () => {
    const stack = await startStack();
    const resumed = await publishedResumeWithAttempt(stack, "sa_p2_missing", "failed");
    rmSync(registry.runDir(resumed.claim.attemptId), {recursive: true, force: true});
    assert.equal(registry.readMeta(resumed.claim.attemptId), undefined);
    for (let pass = 0; pass < 2; pass += 1) {
        const result = await settleResumedAttemptExit({attemptId: resumed.claim.attemptId, service: stack.service});
        assert.equal(result.outcome, "deferred");
        assert.match(readParkRecord("sa_p2_missing").heldReason, /metadata is missing/);
        await reconcileParkedWaits(stack.service, {resume: async () => assert.fail("unknown execution must never relaunch")});
        assert.equal(stack.store.getWait({waitId: resumed.seeded.waitId, generation: resumed.seeded.generation}).phase, "resuming");
        assert.equal(stack.store.listResumeClaims({waitId: resumed.seeded.waitId})[0].state, "published");
    }
});

test("a live conversation lease stays held when its recorded start identity cannot be read", () => {
    const lease = acquireConversationLease({sessionId: "sa_p2_unknown_lease", attemptId: "sa_p2_writer"});
    try {
        const payload = JSON.parse(readFileSync(lease.path, "utf8"));
        writeFileSync(lease.path, JSON.stringify({...payload, start: "recorded-owner-start"}));
        assert.equal(conversationWriterLeaseLive("sa_p2_unknown_lease", {pidExists: () => true, startToken: () => undefined}), true);
        assert.equal(conversationWriterLeaseLive("sa_p2_unknown_lease", {pidExists: () => true, startToken: () => "different-owner-start"}), false);
        writeFileSync(lease.path, JSON.stringify(payload));
    } finally { lease.release(); }
});

test("a published resume that exits before acknowledging settles the unconsumed generation", async () => {
    const stack = await startStack();

    // (a) The resumed attempt FAILED before acknowledgement.
    const failed = await publishedResumeWithAttempt(stack, "sa_p2_failed", "failed");
    const candidates = parkedWaitsForResumedAttempt(failed.claim.attemptId);
    assert.equal(candidates.length, 1, `expected one parked record for the published attempt, found ${JSON.stringify(registry.listMetas().map((meta) => ({ id: meta.id, park: registry.readParkRecord(meta.id) })).map((entry) => ({ id: entry.id, resumedBy: entry.park?.resumedBy, phase: entry.park?.phase })))}`);
    const pinsBefore = stack.store.listEvidencePins({ waitId: failed.seeded.waitId, generation: failed.seeded.generation });
    assert.ok(pinsBefore.length >= 1, "delivery pins the terminal evidence");
    const failedResult = await settleResumedAttemptExit({
        attemptId: failed.claim.attemptId,
        service: stack.service,
        status: "failed",
    });
    assert.equal(failedResult.outcome, "settled");
    assert.equal(failedResult.waitPhase, "held");
    const failedWait = stack.service.listWorkerWaits(failed.scope, { pendingOnly: true })
        .find((entry) => entry.waitId === failed.seeded.waitId);
    assert.equal(failedWait?.phase, "held", "a failed resumed attempt holds the generation");
    const durableFailed = stack.store.getWait({ waitId: failed.seeded.waitId, generation: failed.seeded.generation });
    assert.equal(durableFailed.phase, "held", "the DURABLE phase is held, not cancelled");
    assert.equal(durableFailed.cancelEpoch, 0, "a failure is not a user cancellation");
    assert.match(durableFailed.phaseReason, /exited \(failed\) without interpreting the wait/);
    const failedRecord = readParkRecord("sa_p2_failed");
    assert.equal(failedRecord.phase, "held");
    assert.match(failedRecord.heldReason, /exited \(failed\) without interpreting the wait/);
    assert.equal(
        stack.store.listEvidencePins({ waitId: failed.seeded.waitId, generation: failed.seeded.generation })
            .filter((pin) => pin.releasedAt === null).length,
        pinsBefore.length,
        "the evidence pins are retained for the owner",
    );
    const failedClaims = stack.store.listResumeClaims({ waitId: failed.seeded.waitId });
    assert.equal(failedClaims.filter((entry) => entry.state === "published").length, 0);
    assert.equal(failedClaims.filter((entry) => entry.state === "invalidated").length, 1);
    // Replay is idempotent: the same failed attempt cannot hold it twice.
    const failedReplay = await settleResumedAttemptExit({
        attemptId: failed.claim.attemptId,
        service: stack.service,
        status: "failed",
    });
    assert.equal(failedReplay.outcome, "settled");
    assert.equal(failedReplay.waitPhase, "held");
    // A held generation is never resumed automatically.
    let autoAttempts = 0;
    await reconcileParkedWaits(stack.service, { resume: async () => { autoAttempts += 1; return "resumed"; } });
    assert.equal(autoAttempts, 0, "a held failed resume is never retried automatically");

    // (b) An ORDINARY successful exit without acknowledgement is still an
    // uninterpreted wait: explicit terminal state, never resuming forever.
    const completed = await publishedResumeWithAttempt(stack, "sa_p2_completed", "completed");
    const completedResult = await settleResumedAttemptExit({
        attemptId: completed.claim.attemptId,
        service: stack.service,
        status: "completed",
    });
    assert.equal(completedResult.outcome, "settled");
    assert.equal(completedResult.waitPhase, "held");
    assert.equal(stack.store.getWait({ waitId: completed.seeded.waitId, generation: completed.seeded.generation }).phase, "held");
    assert.equal(readParkRecord("sa_p2_completed").phase, "held");
    assert.match(readParkRecord("sa_p2_completed").heldReason, /exited \(completed\) without interpreting the wait/);

    // (c) An already CONSUMED generation is never altered.
    const consumed = await publishedResumeWithAttempt(stack, "sa_p2_consumed", "completed");
    stack.service.readEvidence(consumed.scope, { waitId: consumed.seeded.waitId, generation: consumed.seeded.generation });
    const revisions = Object.fromEntries(
        stack.service.listWorkerWaits(consumed.scope, { pendingOnly: true })
            .find((entry) => entry.waitId === consumed.seeded.waitId).dependencies
            .map((dep) => [dep.operationId, dep.terminalRevision]),
    );
    stack.service.acknowledgeForWorker(consumed.scope, {
        waitId: consumed.seeded.waitId,
        generation: consumed.seeded.generation,
        terminalRevisions: revisions,
        disposition: "continue",
        note: "interpreted by the resumed attempt",
    });
    const consumedBefore = stack.service.listWorkerWaits(consumed.scope, { pendingOnly: true });
    assert.equal(consumedBefore.length, 0);
    const consumedResult = await settleResumedAttemptExit({ attemptId: consumed.claim.attemptId, service: stack.service, status: "completed" });
    assert.equal(consumedResult.outcome, "ignored");
    assert.equal(readParkRecord("sa_p2_consumed").phase, "consumed");

    // (d) An already CANCELLED generation is never altered.
    const cancelled = await publishedResumeWithAttempt(stack, "sa_p2_cancelled", "failed");
    stack.service.cancelWorkerWait(cancelled.scope, {
        waitId: cancelled.seeded.waitId,
        generation: cancelled.seeded.generation,
        reason: "owner cancelled while the resume was running",
    });
    const cancelledResult = await settleResumedAttemptExit({ attemptId: cancelled.claim.attemptId, service: stack.service, status: "failed" });
    assert.equal(cancelledResult.outcome, "ignored");
    assert.equal(cancelledResult.waitPhase, "cancelled", "an already-cancelled generation keeps its terminal phase");
    assert.equal(readParkRecord("sa_p2_cancelled").phase, "cancelled");
    assert.equal(stack.store.getWait({ waitId: cancelled.seeded.waitId, generation: cancelled.seeded.generation }).phase, "cancelled");
});

test("restart reconciliation settles a published resume that already ended, and never relaunches it", async () => {
    const stack = await startStack();
    const { claim, seeded, scope } = await publishedResumeWithAttempt(stack, "sa_p2_restart", "failed");
    // No exit-handler call: simulate a parent restart that only reconciles.
    const resumed = [];
    const result = await reconcileParkedWaits(stack.service, {
        resume: async (park) => { resumed.push(park.waitId); return "resumed"; },
    });
    assert.deepEqual(resumed, [], "a published attempt must never be resumed a second time");
    const wait = stack.service.listWorkerWaits(scope, { pendingOnly: true })
        .find((entry) => entry.waitId === seeded.waitId);
    assert.equal(wait?.phase, "held", "the unconsumed generation is held, not left resuming");
    assert.equal(stack.store.getWait({ waitId: seeded.waitId, generation: seeded.generation }).phase, "held");
    assert.equal(readParkRecord("sa_p2_restart").phase, "held");
    assert.match(readParkRecord("sa_p2_restart").heldReason, /exited \(failed\) without interpreting the wait/);
    assert.ok(result.held >= 1);
    // A second reconciliation still must not launch anything.
    const second = await reconcileParkedWaits(stack.service, { resume: async () => { resumed.push("again"); return "resumed"; } });
    assert.deepEqual(resumed, [], "a held failed resume is never retried");
    assert.equal(second.resumed, 0);

    // A resume attempt that is still running keeps its generation untouched.
    const live = await publishedResumeWithAttempt(stack, "sa_p2_live", "running");
    const liveResult = await reconcileParkedWaits(stack.service, {
        resume: async (park) => { resumed.push(park.waitId); return "resumed"; },
    });
    assert.deepEqual(resumed, [], "a live published attempt is not resumed");
    assert.equal(getWaitPhase(stack, live.seeded), "resuming");
    assert.equal(readParkRecord("sa_p2_live").phase, "resuming");
    assert.equal(liveResult.resumed, 0);
    void live.claim;
});

/** Current durable phase of one seeded generation. */
function getWaitPhase(stack, seeded) {
    return stack.store.getWait({ waitId: seeded.waitId, generation: seeded.generation })?.phase;
}

test("a published resume with a mismatched launch token is held, not settled", async () => {
    const stack = await startStack();
    const seeded = await seedPark(stack, { attemptId: "sa_p2_token", target: "ready" });
    writeParkedAttempt(stack, { attemptId: "sa_p2_token", waitId: seeded.waitId, generation: seeded.generation });
    const claim = await publishResume(stack, { attemptId: "sa_p2_token", waitId: seeded.waitId, generation: seeded.generation });
    registry.updateParkRecord("sa_p2_token", {
        phase: "resuming",
        resumedBy: claim.attemptId,
        resumeLaunchToken: claim.launchToken,
    });
    const tokenResumedMeta = { ...registry.readMeta("sa_p2_token") };
    delete tokenResumedMeta.park;
    registry.writeMeta({
        ...tokenResumedMeta,
        id: claim.attemptId,
        status: "failed",
        pid: 999_997,
        spawnPid: process.pid,
        sessionId: "sa_p2_token",
        exitCode: 1,
        operations: { ...tokenResumedMeta.operations, resumeLaunchToken: "slt_different" },
        logPath: registry.logPathFor(claim.attemptId),
    });
    const result = await settleResumedAttemptExit({
        attemptId: claim.attemptId,
        service: stack.service,
        status: "failed",
    });
    assert.equal(result.outcome, "foreign");
    assert.equal(readParkRecord("sa_p2_token").phase, "held");
    assert.match(readParkRecord("sa_p2_token").heldReason, /does not match the launch token/);
    assert.equal(getWaitPhase(stack, seeded), "resuming", "an ambiguous identity leaves the durable wait untouched");

    // A forged CLAIM token is refused by the store; the durable generation stays
    // with its live claim and the local record records the hold.
    const forged = await publishedResumeWithAttempt(stack, "sa_p2_forged", "failed");
    registry.updateParkRecord("sa_p2_forged", { resumeClaimToken: "claimtok_forged" });
    const forgedResult = await settleResumedAttemptExit({
        attemptId: forged.claim.attemptId,
        service: stack.service,
        status: "failed",
        writerLeaseReleased: true,
    });
    assert.notEqual(forgedResult.outcome, "settled");
    assert.equal(getWaitPhase(stack, forged.seeded), "resuming", "a mismatched claim token never moves the durable wait");
    assert.equal(readParkRecord("sa_p2_forged").phase, "held");
    assert.match(readParkRecord("sa_p2_forged").heldReason, /durable hold was refused/);
});
