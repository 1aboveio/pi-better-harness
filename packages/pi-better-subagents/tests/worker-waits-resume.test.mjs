/**
 * Resume admission edges against the ACTUAL Background host and store.
 *
 * The child pipeline (launch → wait → checkpoint → park → resume) is covered in
 * `worker-waits-bridge.test.mjs`. These tests use the same real host, store,
 * supervisor and RPC surface to drive the refusal paths: full capacity must leave
 * the generation ready, parent Goal state does not gate delegated work, captured
 * scope survives migration, and a post-publish failure is held rather than relaunched.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, test } from "node:test";
import {
    assertAssignmentPermissionScope,
    createWorkerOperationsHost,
    getWorkerOperationService,
    OBSERVED_WAITS_SERVICE_CHANNEL,
    OBSERVED_WAITS_SERVICE_REQUEST_CHANNEL,
    OPERATION_RESUME_ADMISSION_EVENT,
    PreSpawnResumeError,
    createResumeOrchestration,
    planWorkerBridgeTools,
    resolveProductionSchemas,
} from "../worker-waits.ts";
import { captureParkCheckpoint } from "../park-checkpoint.ts";
import * as registry from "../registry.ts";
import { readParkRecord } from "../registry.ts";
import {
    cleanupAll,
    defaultPlan,
    schemasFor,
    sessionFixture,
    startStack,
    writeCoherentLog,
} from "./worker-waits-support.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const durableRoot = mkdtempSync(join(tmpdir(), "worker-resume-durable-"));
const volatileRoot = mkdtempSync(join(tmpdir(), "worker-resume-tmp-"));

before(() => {
    process.env.PI_SUBAGENT_DURABLE_DIR = durableRoot;
    process.env.TMPDIR = volatileRoot;
});

after(() => {
    rmSync(durableRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    rmSync(volatileRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

afterEach(() => cleanupAll());

const OWNER = { sessionId: "parent-session-1", branchId: "branch-1", goalId: null };

test("standalone Subagents refuses parking capability without Background or with a v1 host", async () => {
    for (const version of [null, 1]) {
        const events = new EventEmitter();
        if (version) events.on(OBSERVED_WAITS_SERVICE_REQUEST_CHANNEL, () => events.emit(
            OBSERVED_WAITS_SERVICE_CHANNEL, { version, available: true, assignmentContinuation: 1 },
        ));
        const pi = { events };
        assert.equal(getWorkerOperationService(pi), undefined);
        const host = createWorkerOperationsHost({ pi, childExtensionPath: "unused" });
        assert.equal(await host.start(), false);
        assert.equal(host.available, false);
        await host.close();
    }
});

test("assignment permissions fail closed on authority loss, tightening and widening", () => {
    const sandbox = { root: "/assignment", permissions: { network: false, commands: true }, denyWrite: ["/assignment/private"] };
    const captured = { sandbox, mandatoryPermissions: true };
    assert.doesNotThrow(() => assertAssignmentPermissionScope(captured, { sandbox: structuredClone(sandbox), mandatoryPermissions: true }));
    assert.throws(() => assertAssignmentPermissionScope(captured, { sandbox, mandatoryPermissions: false }), /authority is unavailable/);
    assert.throws(() => assertAssignmentPermissionScope({ sandbox }, { sandbox, mandatoryPermissions: false }), /authority is unavailable/);
    assert.doesNotThrow(() => assertAssignmentPermissionScope({ sandbox, mandatoryPermissions: false }, { sandbox, mandatoryPermissions: false }));
    assert.doesNotThrow(() => assertAssignmentPermissionScope(captured, {
        sandbox: { ...sandbox, denyWrite: [...sandbox.denyWrite, "/runtime/new-control"] }, mandatoryPermissions: true,
    }));
    assert.throws(() => assertAssignmentPermissionScope(captured, {
        sandbox: { ...sandbox, denyWrite: [] }, mandatoryPermissions: true,
    }), /protected paths/);
    for (const commands of [true, false]) assert.throws(() => assertAssignmentPermissionScope(captured, {
        sandbox: { ...sandbox, permissions: { network: true, commands } }, mandatoryPermissions: true,
    }), /captured assignment scope/);
    assert.throws(() => assertAssignmentPermissionScope(undefined, { sandbox: null, mandatoryPermissions: false }), /permissions are missing/);
});

async function workerRun(stack, { runId, conversationId, plan, goalId = null }) {
    const policy = {
        version: 1,
        sandbox: null,
        tools: ["read", "write", "bash"],
        clean: false,
        deadlineAt: null,
        authorityReference: `authority:test:${randomUUID()}`,
        workspace: stack.workspace,
    };
    await stack.bridge.register({
        runId,
        conversationId,
        workspace: stack.workspace,
        authorityReference: policy.authorityReference,
        branchId: OWNER.branchId,
        goalId,
        policy,
        capabilities: plan.capabilities,
        tools: plan.tools,
        schemas: schemasFor(stack.pi, plan.tools),
        attemptId: runId,
        owner: { sessionId: OWNER.sessionId, workspace: stack.workspace, branchId: OWNER.branchId, goalId },
    });
    return policy;
}

/**
 * Build a real, ready park generation: a supervised task was launched, the wait
 * was registered and checkpointed, the writer exited, and the task settled.
 */
async function seedReadyPark(stack, { attemptId, goalId = null }) {
    const plan = defaultPlan();
    const policy = await workerRun(stack, { runId: attemptId, conversationId: attemptId, plan, goalId });
    const owner = { kind: "worker-conversation", sessionId: attemptId, workspace: stack.workspace, branchId: OWNER.branchId, goalId };
    const launch = await stack.bridge.rpc.call("execute-tool", {
        runId: attemptId,
        conversationId: attemptId,
        tool: "bg_task_spawn",
        params: { argv: [process.execPath, "-e", "setTimeout(() => {}, 400)"], shell: false, name: "resume-task" },
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
    // Stage while the writer is alive, then prove its exit (the test acts as the
    // trusted observer the real launch path is).
    const staged = await stack.bridge.rpc.call("checkpoint", {
        runId: attemptId,
        conversationId: attemptId,
        waitId,
        generation,
        toolCallId: "call-wait-1",
        attemptId,
        evidence: { version: 1, sessionId: attemptId, sessionFile: "x.jsonl", toolCallId: "call-wait-1", waitId, generation, entryId: "e", prefixBytes: 1, prefixSha256: "a".repeat(64) },
    });
    assert.equal(staged.staged, true);
    await stack.bridge.rpc.call("checkpoint", {
        runId: attemptId,
        conversationId: attemptId,
        waitId,
        generation,
        writerLeaseReleased: true,
        writerPidGone: true,
    });

    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await stack.host.reconcileNow();
        ready = stack.service.listWorkerWaits({ runId: attemptId, conversationId: attemptId, workspace: stack.workspace, authorityReference: policy.authorityReference, branchId: OWNER.branchId, goalId }, { pendingOnly: true })
            .some((entry) => entry.waitId === waitId && entry.phase === "ready");
    }
    assert.equal(ready, true, "the durable generation must be ready before resuming");

    // The parked attempt's real record + verified park disposition.
    const { sessionDirectory, sessionFile } = sessionFixture(durableRoot, attemptId);
    const workspace = stack.workspace;
    const header = JSON.stringify({ type: "session", id: attemptId, cwd: workspace });
    const call = JSON.stringify({ type: "message", id: "e1", message: { role: "assistant", content: [{ type: "toolCall", id: "call-wait-1", name: "wait_for_operations" }] } });
    const result = JSON.stringify({ type: "message", id: "e2", message: { role: "toolResult", toolCallId: "call-wait-1", toolName: "wait_for_operations", isError: false, content: [], details: { operationWait: { waitId, generation } } } });
    writeFileSync(sessionFile, `${[header, call, result].join("\n")}\n`);
    const checkpoint = captureParkCheckpoint({ sessionId: attemptId, sessionFile, toolCallId: "call-wait-1", waitId, generation });
    registry.writeMeta({
        id: attemptId,
        status: "running",
        pid: 999_999,
        spawnPid: process.pid,
        cwd: workspace,
        promptPreview: "build the release",
        startedAt: Date.now() - 1_000,
        logPath: registry.logPathFor(attemptId),
        sessionId: attemptId,
        callback: true,
        operations: {
            version: 1,
            bridgeRunId: attemptId,
            conversationId: attemptId,
            authorityReference: policy.authorityReference,
            branchId: OWNER.branchId,
            goalId,
            policy: { version: 1, sandbox: null, tools: policy.tools, clean: false, deadlineAt: null },
            tools: plan.tools,
        },
        recipe: {
            version: 1,
            attemptId,
            sessionId: attemptId,
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
    writeCoherentLog(registry.logPathFor(attemptId));
    registry.writeParkRecord(attemptId, {
        version: 1,
        waitId,
        generation,
        phase: "waiting",
        attemptId,
        ownerSessionId: OWNER.sessionId,
        ownerWorkspace: workspace,
        ownerBranchId: OWNER.branchId,
        ownerGoalId: goalId,
        continuationNote: "Read the result and continue.",
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
    return {
        waitId,
        generation,
        taskId,
        park: {
            runId: attemptId,
            conversationId: attemptId,
            attemptId,
            waitId,
            generation,
            phase: "waiting",
            meta: registry.readMeta(attemptId),
            record: readParkRecord(attemptId),
        },
    };
}

function goalGate(stack, decide) {
    const seen = [];
    stack.events.on(OPERATION_RESUME_ADMISSION_EVENT, (request) => {
        seen.push(request.owner);
        request.reply(decide(request.owner));
    });
    return seen;
}

function orchestrationFor(stack, { capacity, launch }) {
    return createResumeOrchestration({
        pi: stack.pi,
        service: () => stack.service,
        rpc: stack.bridge.rpc,
        context: () => stack.ctx,
        capacity,
        launch,
    });
}

function capacity(value = true) {
    const calls = { reserve: 0, commit: 0, release: 0 };
    return {
        calls,
        value: {
            tryReserve() { calls.reserve += 1; return value; },
            recheck() { return value; },
            commit() { calls.commit += 1; },
            release() { calls.release += 1; },
        },
    };
}

test("full capacity leaves the generation ready and creates no claim", async () => {
    const stack = await startStack();
    const seeded = await seedReadyPark(stack, { attemptId: "sa_capacity" });
    goalGate(stack, () => ({ allowed: true, revision: 1 }));
    const cap = capacity(false);
    const launched = [];
    const orchestration = orchestrationFor(stack, { capacity: cap.value, launch: async (input) => launched.push(input) });

    const outcome = await orchestration.resume(seeded.park);

    assert.equal(outcome, "skipped");
    assert.deepEqual(launched, []);
    const view = stack.service.listWorkerWaits({ runId: "sa_capacity", conversationId: "sa_capacity", workspace: stack.workspace, authorityReference: "x", branchId: OWNER.branchId, goalId: null }, { pendingOnly: true })
        .find((entry) => entry.waitId === seeded.waitId);
    assert.equal(view.phase, "ready", "a queued resume stays ready");
    assert.equal(readParkRecord("sa_capacity").phase, "waiting", "the park record is untouched");
    assert.equal(stack.store.listResumeClaims({ waitId: seeded.waitId }).length, 0, "no claim is published while queued");
});

test("a parent Goal refusal does not gate the delegated assignment", async () => {
    const stack = await startStack();
    const seeded = await seedReadyPark(stack, { attemptId: "sa_goal_refused" });
    goalGate(stack, () => ({ allowed: false, reason: "Goal has an active permission hold", revision: 9 }));
    const cap = capacity(true);
    const launched = [];
    const orchestration = orchestrationFor(stack, { capacity: cap.value, launch: async (input) => launched.push(input) });

    const outcome = await orchestration.resume(seeded.park);

    assert.equal(outcome, "resumed");
    assert.equal(launched.length, 1);
    assert.equal(cap.calls.commit, 1);
    assert.equal(readParkRecord("sa_goal_refused").heldReason, undefined);
    const view = stack.service.listWorkerWaits({ runId: "sa_goal_refused", conversationId: "sa_goal_refused", workspace: stack.workspace, authorityReference: "x", branchId: OWNER.branchId, goalId: null }, { pendingOnly: true })
        .find((entry) => entry.waitId === seeded.waitId);
    assert.equal(view.phase, "resuming");
    assert.equal(stack.store.listResumeClaims({ waitId: seeded.waitId }).length, 1);
});

test("admission preserves captured Goal provenance without querying the parent's Goal", async () => {
    const stack = await startStack();
    const seeded = await seedReadyPark(stack, { attemptId: "sa_goal_bound", goalId: "goal-7" });
    const seen = goalGate(stack, (owner) => owner.goalId === "goal-7"
        ? { allowed: true, revision: 4 }
        : { allowed: false, reason: "Owning Goal is no longer current", revision: 4 });
    const cap = capacity(true);
    const orchestration = orchestrationFor(stack, { capacity: cap.value, launch: async () => {} });

    const outcome = await orchestration.resume(seeded.park);

    assert.equal(outcome, "resumed");
    assert.deepEqual(seen, [], "parent Goal is provenance only");
    assert.equal(readParkRecord("sa_goal_bound").ownerGoalId, "goal-7");
});

test("a failure after the claim is published is held, never relaunched", async () => {
    const stack = await startStack();
    const seeded = await seedReadyPark(stack, { attemptId: "sa_publish_fail" });
    goalGate(stack, () => ({ allowed: true, revision: 1 }));
    const cap = capacity(true);
    const orchestration = orchestrationFor(stack, {
        capacity: cap.value,
        launch: async () => { throw new PreSpawnResumeError("current permissions refuse this recipe"); },
    });

    const outcome = await orchestration.resume(seeded.park);

    assert.equal(outcome, "held");
    const claim = stack.store.listResumeClaims({ waitId: seeded.waitId }).find((entry) => entry.state === "published");
    assert.ok(claim, "the published attempt is retained for reconciliation");
    assert.equal(readParkRecord("sa_publish_fail").phase, "held");
    assert.match(readParkRecord("sa_publish_fail").heldReason, /current permissions refuse/);
});

test("inactive parents do not gate admission, and migration preserves the captured policy", async () => {
    const stack = await startStack();
    const seeded = await seedReadyPark(stack, { attemptId: "sa_migration", goalId: "old-goal" });
    stack.ctx.sessionManager.getSessionId = () => "unrelated-session";
    stack.ctx.sessionManager.getBranch = () => [];
    const captured = structuredClone(seeded.park.meta.operations.policy);
    const cap = capacity();
    let launched = 0;
    const orchestration = orchestrationFor(stack, { capacity: cap.value, launch: async (input) => {
        launched += 1;
        assert.deepEqual(input.park.meta.operations.policy, captured);
        assert.equal(input.park.record.ownerSessionId, OWNER.sessionId);
        assert.equal(input.park.record.ownerBranchId, OWNER.branchId);
    } });
    assert.equal(await orchestration.resume(seeded.park), "resumed");
    assert.equal(launched, 1);
});

test("missing host queues without capacity; incompatible hosts and missing migration policy refuse", async () => {
    for (const mode of ["absent", "legacy", "missing-policy"]) {
        const stack = await startStack();
        const seeded = await seedReadyPark(stack, { attemptId: `sa_host_${mode}` });
        if (mode === "missing-policy") delete seeded.park.meta.operations.policy;
        const cap = capacity();
        const orchestration = createResumeOrchestration({
            pi: stack.pi, rpc: stack.bridge.rpc, context: () => stack.ctx,
            service: () => mode === "absent" ? undefined : mode === "legacy"
                ? { ...stack.service, assignmentContinuation: undefined } : stack.service,
            capacity: cap.value, launch: async () => assert.fail("must not launch"),
        });
        assert.equal(await orchestration.resume(seeded.park), mode === "absent" ? "skipped" : "held");
        assert.equal(cap.calls.reserve, 0);
        assert.equal(stack.store.listResumeClaims({ waitId: seeded.waitId }).length, 0);
        if (mode !== "absent") assert.match(readParkRecord(seeded.park.runId).heldReason, /does not support|permission policy is missing/);
    }
});

test("production schemas gate bridge tools and sandboxed workers are not withheld", () => {
    const stackSchemas = resolveProductionSchemas(
        { getAllTools: () => [] },
        ["bg_task_spawn", "bg_task_status", "wait_for_operations", "acknowledge_operation_result"],
    );
    assert.deepEqual(stackSchemas.missing.sort(), ["bg_task_spawn", "bg_task_status"]);
    assert.equal(stackSchemas.schemas.has("wait_for_operations"), true);

    const plan = planWorkerBridgeTools({
        allow: ["read"],
        excluded: [],
        clean: false,
        explicitTools: false,
        productionSchemas: new Set(["wait_for_operations", "acknowledge_operation_result"]),
    });
    // Background tools without a production schema are withheld, not advertised
    // with a permissive fallback.
    assert.deepEqual(plan.tools.sort(), ["acknowledge_operation_result", "wait_for_operations"]);
    assert.equal(plan.capabilities.background.spawn, false);

    // A sandboxed worker is planned exactly like any other; its task policy and
    // the task guard decide admission, not a blanket withholding here.
    const sandboxedPlan = planWorkerBridgeTools({
        allow: ["read"],
        excluded: [],
        clean: false,
        explicitTools: false,
    });
    assert.equal(sandboxedPlan.tools.length, 6);
});
