/**
 * End-to-end worker park/resume against the ACTUAL Background host.
 *
 * Real coordinator store, real local supervisor and background subprocess, real
 * Background service discovery over the event bus, real Subagents bridge host,
 * real child bridge client, real park-checkpoint capture/validation, real
 * registry/finalization, and the real resume claim fence.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, test } from "node:test";

const durableRoot = mkdtempSync(join(tmpdir(), "worker-waits-durable-"));
const volatileRoot = mkdtempSync(join(tmpdir(), "worker-waits-tmp-"));

before(() => {
    process.env.PI_SUBAGENT_DURABLE_DIR = durableRoot;
    process.env.TMPDIR = volatileRoot;
});

after(() => {
    rmSync(durableRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    rmSync(volatileRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

import {
    OPERATION_RESUME_ADMISSION_EVENT,
    createResumeOrchestration,
    finalizeWorkerParkAfterExit,
    planWorkerBridgeTools,
} from "../worker-waits.ts";
import * as registry from "../registry.ts";
import { readParkRecord } from "../registry.ts";
import { finalizeRun } from "../finalization.ts";
import {
    WORKER_CONVERSATION,
    cleanupAll,
    defaultPlan,
    schemasFor,
    sessionFixture,
    startStack,
    tempDirectory,
    writeCoherentLog,
} from "./worker-waits-support.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const cleanup = [];
afterEach(() => cleanupAll());

async function runChild(programPath, env, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", programPath], {
            cwd: options.cwd ?? process.cwd(),
            env: { ...process.env, ...env },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
        child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
        child.on("error", reject);
        child.on("close", (code) => {
            const line = stdout.trim().split("\n").filter(Boolean).pop();
            let result;
            try { result = line ? JSON.parse(line) : undefined; } catch { result = undefined; }
            resolve({ code, stdout, stderr, result });
        });
    });
}

/** Child bridge program: launch a real task, wait, persist a checkpoint. */
function childProgram(directory, { stage = "checkpoint" } = {}) {
    const path = join(directory, "child.mjs");
    writeFileSync(path, `
import { writeFileSync } from "node:fs";
import { readChildOperationBridgeConfig, createOperationBridgeClient } from ${JSON.stringify(join(packageRoot, "child-operations.ts"))};
import { captureParkCheckpoint } from ${JSON.stringify(join(packageRoot, "park-checkpoint.ts"))};
const out = {};
const config = readChildOperationBridgeConfig(process.env);
if (config.status !== "ready") { console.log(JSON.stringify({ error: config.status, reason: config.reason })); process.exit(0); }
const client = createOperationBridgeClient(config.config, {});
try {
    const descriptor = await client.handshake();
    out.tools = descriptor.tools.map((tool) => tool.name).sort();
    if (process.env.CHILD_TASK === "1") {
        out.spawn = await client.request("bg_task_spawn", {
            argv: [process.execPath, "-e", "setTimeout(() => { console.log('done'); }, 250)"],
            shell: false,
            name: "worker-build",
        }, {});
    }
    if (process.env.CHILD_STATUS_TASK) {
        out.status = await client.request("bg_task_status", { id: process.env.CHILD_STATUS_TASK }, {});
    }
    if (process.env.CHILD_WAIT === "1") {
        const taskId = out.spawn.id;
        const wait = await client.request("wait_for_operations", { task_ids: [taskId], continuation_note: "Read the build result and continue packaging." }, {});
        out.wait = wait;
        const waitId = wait.operationWait?.waitId ?? wait.waitId;
        const generation = wait.operationWait?.generation ?? wait.generation;
        const toolCallId = "call-wait-1";
        const sessionFile = process.env.CHILD_SESSION_FILE;
        const sessionId = process.env.CHILD_SESSION_ID;
        const header = JSON.stringify({ type: "session", id: sessionId, cwd: process.env.CHILD_WORKSPACE });
        const call = JSON.stringify({ type: "message", id: "entry-call", message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "wait_for_operations", arguments: { task_ids: [taskId] } }] } });
        const result = JSON.stringify({ type: "message", id: "entry-result", message: {
            role: "toolResult", toolCallId, toolName: "wait_for_operations", isError: false,
            content: [{ type: "text", text: JSON.stringify({ operationWait: { waitId, generation } }) }],
            details: { operationWait: { waitId, generation }, operationBridge: { marker: "m1", waitId, generation, toolCallId } },
        } });
        writeFileSync(sessionFile, [header, call, result].join("\\n") + "\\n");
        const evidence = captureParkCheckpoint({ sessionId, sessionFile, toolCallId, waitId, generation });
        try {
            out.checkpoint = await client.request("checkpoint", {
                wait_id: waitId,
                generation,
                tool_call_id: toolCallId,
                attempt_id: config.config.attemptId,
                evidence,
            }, {});
        } catch (error) {
            out.checkpointError = error.code ?? "error";
            out.checkpointMessage = error.message;
        }
    }
} catch (error) {
    out.fatal = error.message;
} finally {
    await client.close().catch(() => {});
}
console.log(JSON.stringify(out));
`);
    return path;
}

function workerPolicy(workspace, tools) {
    return {
        version: 1,
        sandbox: null,
        tools,
        clean: false,
        deadlineAt: null,
        authorityReference: `authority:test:${randomUUID()}`,
        workspace,
    };
}

const OWNER = {
    sessionId: "parent-session-1",
    workspace: undefined,
    branchId: "branch-1",
    goalId: null,
};

/** Register a real worker bridge run for one attempt. */
async function registerWorker(stack, { runId, conversationId = WORKER_CONVERSATION, attemptId = runId, plan }) {
    const policy = workerPolicy(stack.workspace, ["read", "write", "bash"]);
    const handle = await stack.bridge.register({
        runId,
        conversationId,
        workspace: stack.workspace,
        authorityReference: policy.authorityReference,
        branchId: OWNER.branchId,
        goalId: OWNER.goalId,
        policy,
        capabilities: plan.capabilities,
        tools: plan.tools,
        schemas: schemasFor(stack.pi, plan.tools),
        attemptId,
        owner: { sessionId: OWNER.sessionId, workspace: stack.workspace, branchId: OWNER.branchId, goalId: OWNER.goalId },
    });
    const meta = registry.readMeta(runId);
    if (meta) registry.writeMeta({ ...meta, operations: {
        version: 1, bridgeRunId: runId, conversationId, workspace: stack.workspace,
        authorityReference: policy.authorityReference, policy, tools: plan.tools,
    } });
    return { handle, policy };
}

/** Real run record for the attempt that will park. */
function writeAttemptRecord(stack, { attemptId, sessionDirectory, sessionFile, cwd = stack.workspace }) {
    const meta = {
        id: attemptId,
        status: "running",
        pid: 999_999,
        spawnPid: process.pid,
        cwd,
        promptPreview: "build the release",
        startedAt: Date.now() - 1_000,
        logPath: registry.logPathFor(attemptId),
        sessionId: attemptId,
        callback: true,
        recipe: {
            version: 1,
            attemptId,
            sessionId: attemptId,
            sessionDir: sessionDirectory,
            cwd,
            tools: "read,write,bash",
            clean: false,
            allowNested: false,
            approve: false,
            sandbox: false,
            gitCloneWorkspace: false,
            callback: true,
        },
    };
    registry.writeMeta(meta);
    return meta;
}

function startGoalGate(stack, answer = { allowed: true, revision: 3 }) {
    const seen = [];
    stack.events.on(OPERATION_RESUME_ADMISSION_EVENT, (request) => {
        seen.push(request.owner);
        request.reply(answer);
    });
    return seen;
}

function capacityStub(result = true) {
    const calls = { reserve: 0, commit: 0, release: 0, recheck: 0 };
    return {
        calls,
        capacity: {
            tryReserve() { calls.reserve += 1; return result; },
            recheck() { calls.recheck += 1; return result; },
            commit() { calls.commit += 1; },
            release() { calls.release += 1; },
        },
    };
}

test("a real worker parks, the exit proof finalizes the wait, and the ready task resumes it once", async () => {
    const stack = await startStack();
    assert.equal(stack.started, true, "the Subagents bridge host must resolve the real Background service");

    const attemptId = "sa_worker_live";
    const { sessionDirectory, sessionFile } = sessionFixture(durableRoot, attemptId);
    writeAttemptRecord(stack, { attemptId, sessionDirectory, sessionFile });

    const plan = defaultPlan();
    const { handle } = await registerWorker(stack, { runId: attemptId, conversationId: attemptId, plan });
    // Production schemas, not the bridge's permissive fallback.
    assert.ok(handle.capabilities.parking);
    assert.equal(handle.tools.includes("bg_task_spawn"), true);

    const directory = tempDirectory("child-run");
    const child = await runChild(childProgram(directory), {
        ...handle.env,
        CHILD_TASK: "1",
        CHILD_WAIT: "1",
        CHILD_SESSION_FILE: sessionFile,
        CHILD_SESSION_ID: attemptId,
        CHILD_WORKSPACE: stack.workspace,
    });
    assert.equal(child.code, 0, `child failed: ${child.stderr || child.stdout}`);
    assert.equal(child.result.fatal, undefined, JSON.stringify(child.result));
    assert.equal(child.result.checkpoint?.staged, true, JSON.stringify(child.result));

    const waitId = child.result.wait.operationWait?.waitId ?? child.result.wait.waitId;
    const generation = child.result.wait.operationWait?.generation ?? child.result.wait.generation;
    const taskId = child.result.spawn.id;
    assert.match(taskId, /^bgs_[0-9a-f]{20}$/, "a real supervised task id");

    // Staged while the child was alive: the durable wait must still be parking.
    const scope = { runId: attemptId, conversationId: attemptId, workspace: stack.workspace, authorityReference: "x", branchId: OWNER.branchId, goalId: OWNER.goalId };
    let view = stack.service.listWorkerWaits(scope, { pendingOnly: true }).find((entry) => entry.waitId === waitId);
    assert.equal(view.phase, "parking");
    assert.equal(readParkRecord(attemptId).phase, "parking");
    assert.equal(readParkRecord(attemptId).checkpoint.entryId, "entry-result");

    // Clean exit + verified checkpoint: finalization records a park, not a result.
    writeCoherentLog(registry.logPathFor(attemptId));
    const finalized = finalizeRun(attemptId, 0);
    assert.equal(finalized.park.parked, true);
    assert.equal(finalized.meta.park.phase, "parking");

    // Exit proof: checkpoint staged, writer lease released, original writer gone.
    const finalization = await finalizeWorkerParkAfterExit({
        runId: attemptId,
        service: stack.service,
        writerLeaseReleased: true,
        writerPidGone: true,
    });
    assert.equal(finalization.outcome, "parked", JSON.stringify(finalization));
    assert.equal(finalization.wait.phase, "waiting");
    assert.equal(readParkRecord(attemptId).phase, "waiting");

    // The real background task completes; the host reconciles and dispatches.
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await stack.host.reconcileNow();
        view = stack.service.listWorkerWaits(scope, { pendingOnly: true }).find((entry) => entry.waitId === waitId);
        ready = view?.phase === "ready";
    }
    assert.equal(ready, true, "the settled task must move the durable wait to ready");

    // Resume through the real orchestration + claim fence.
    const goals = startGoalGate(stack);
    const launched = [];
    const { capacity, calls } = capacityStub(true);
    const orchestration = createResumeOrchestration({
        pi: stack.pi,
        service: () => stack.service,
        rpc: stack.bridge.rpc,
        context: () => stack.ctx,
        capacity,
        launch: async (input) => {
            // The claim must already be published with this attempt before spawn.
            const claims = stack.store.listResumeClaims({ waitId, generation });
            const active = claims.find((claim) => claim.state === "published");
            assert.ok(active, "the resume attempt must be published before the launcher runs");
            assert.equal(active.attemptId, input.assignedRunId);
            assert.equal(active.launchToken, input.launchToken);
            assert.equal(readParkRecord(attemptId).phase, "resuming");
            assert.equal(readParkRecord(attemptId).resumedBy, input.assignedRunId);
            launched.push(input);
        },
    });
    stack.service.registerContinuationAdapter(orchestration.adapter);
    const park = {
        runId: attemptId,
        conversationId: attemptId,
        attemptId,
        waitId,
        generation,
        phase: "ready",
        meta: registry.readMeta(attemptId),
        record: readParkRecord(attemptId),
    };
    const outcome = await orchestration.resume(park);
    assert.equal(outcome, "resumed");
    assert.equal(launched.length, 1);
    assert.deepEqual(goals, [], "parent Goal is not worker authority");
    assert.equal(calls.commit, 1);
    const claim = stack.store.listResumeClaims({ waitId, generation }).find((entry) => entry.state === "published");
    assert.ok(claim);
    assert.equal(claim.attemptId, launched[0].assignedRunId);

    // A resumed attempt (new run id, same conversation) still owns the original task.
    const resumedRunId = "sa_worker_resumed";
    const { handle: resumedHandle } = await registerWorker(stack, { runId: resumedRunId, conversationId: attemptId, plan });
    const secondChild = await runChild(childProgram(directory), {
        ...resumedHandle.env,
        CHILD_STATUS_TASK: taskId,
    });
    assert.equal(secondChild.code, 0, `child failed: ${secondChild.stderr || secondChild.stdout}`);
    assert.equal(secondChild.result.fatal, undefined, JSON.stringify(secondChild.result));
    assert.equal(secondChild.result.status.taskId, taskId);
    assert.equal(secondChild.result.status.terminalOutcome, "succeeded");
    orchestration.stop();
});

test("a checkpoint that does not describe the trusted saved conversation is refused", async () => {
    const stack = await startStack();
    const attemptId = "sa_worker_foreign_checkpoint";
    const { sessionDirectory, sessionFile } = sessionFixture(durableRoot, attemptId);
    writeAttemptRecord(stack, { attemptId, sessionDirectory, sessionFile });

    const plan = defaultPlan();
    const { handle } = await registerWorker(stack, { runId: attemptId, conversationId: attemptId, plan });
    // A different, self-consistent session file: the child can hash it correctly,
    // but it is not the conversation the trusted recipe names.
    const foreignDirectory = tempDirectory("foreign-session");
    const foreignFile = join(foreignDirectory, `x_${attemptId}.jsonl`);
    writeFileSync(foreignFile, `${JSON.stringify({ type: "session", id: attemptId, cwd: stack.workspace })}\n`);

    const directory = tempDirectory("child-run");
    const child = await runChild(childProgram(directory), {
        ...handle.env,
        CHILD_TASK: "1",
        CHILD_WAIT: "1",
        CHILD_SESSION_FILE: foreignFile,
        CHILD_SESSION_ID: attemptId,
        CHILD_WORKSPACE: stack.workspace,
    });
    assert.equal(child.code, 0, `child failed: ${child.stderr || child.stdout}`);
    assert.equal(child.result.checkpoint, undefined);
    assert.equal(child.result.checkpointError, "checkpoint-invalid");
    assert.match(child.result.checkpointMessage, /saved conversation|saved session|evidence/i);
    assert.equal(readParkRecord(attemptId), undefined, "no park record is written for unproven evidence");
});
