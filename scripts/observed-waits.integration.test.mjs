// @covers observed-waits.whole-path
// @level integration
//
// Whole-path acceptance for ADR 0020 observed waits and worker park/resume.
//
// This suite runs the ACTUAL first-party modules together:
//
//   - real Background observed-waits host, real SQLite coordinator store, real
//     detached local supervisor task runner;
//   - real Subagents worker bridge host, real unix-socket bridge transport and
//     the real child bridge client;
//   - real native SessionManager / AgentSession / SDK tool-result termination
//     boundary in a separate child process (deterministic offline model only);
//   - real Subagents registry, park record, exit finalization, resume claim
//     fence, capacity ledger and continuation launcher;
//   - the bundled Mergify delivery-watcher recipe with an external watcher stub.
//
// No wait phase, checkpoint, park disposition, terminal result, claim or ack is
// fabricated. The only injected seams are the offline model (it decides which
// tool to call, never the result), the parent Goal admission listeners in the shared
// harness (Goal is not loaded there), and the delivery watcher binary itself
// (stub evidence).
//
// Coverage split, kept explicit so the production path is never confused with a
// harness seam:
//   - the first four tests use the shared real-module harness. Their worker and
//     Background stack are real; the continuation launcher is injected so the
//     Background/bridge/wait semantics can be isolated.
//   - the production `pi -p` journeys load the real Background, Goal and
//     Subagents extension entry files, let the offline parent model call the
//     production `subagent_spawn`, and let the production coordinator launch the
//     continuation CLI. One of them is skipped with the exact launch-wiring
//     blocker documented at that test; the published-cancel journey is active.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, test } from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtures = join(repoRoot, "scripts", "fixtures", "observed-waits");

// Standalone runs get the same private TMPDIR/durable store the root test
// preload provides, so no acceptance artifact reaches the machine registry.
const ownsScratch = !process.env.PI_SCRIPTS_TEST_ISOLATED_TMPDIR;
const scratchRoot = process.env.PI_SCRIPTS_TEST_ISOLATED_TMPDIR
    ?? mkdtempSync(join(tmpdir(), "observed-waits-acceptance-tmp-"));
if (ownsScratch) {
    process.env.TMPDIR = scratchRoot;
    process.env.TMP = scratchRoot;
    process.env.TEMP = scratchRoot;
}
const ownsDurableRoot = !process.env.PI_SUBAGENT_DURABLE_DIR;
const durableRoot = process.env.PI_SUBAGENT_DURABLE_DIR ?? join(scratchRoot, "durable-subagents");
process.env.PI_SUBAGENT_DURABLE_DIR = durableRoot;

// The production launcher resolves its child CLI with `which pi`. Point that at
// the SDK this repository ships (0.82.1), not a globally installed newer Pi, so
// the acceptance exercises the shipped runtime and its parking boundary.
const originalPath = process.env.PATH ?? "";
const sdkEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const sdkCli = join(dirname(dirname(sdkEntry)), "dist", "cli.js");
assert.equal(existsSync(sdkCli), true, `the shipped Pi CLI must exist at ${sdkCli}`);
const piBinDir = join(scratchRoot, "bin");
mkdirSync(piBinDir, { recursive: true });
const piWrapper = join(piBinDir, "pi");
writeFileSync(piWrapper, `#!/bin/sh\nexec "${process.execPath}" "${sdkCli}" "$@"\n`);
chmodSync(piWrapper, 0o755);
process.env.PATH = `${piBinDir}:${originalPath}`;

// Loaded AFTER the durable/session root is fixed: the registry reads it at call
// time, but keeping this dynamic makes standalone runs behave like the suite.
const { createCapacityGate } = await import("../packages/pi-better-subagents/capacity.mjs");
const registry = await import("../packages/pi-better-subagents/registry.ts");
const { finalizeRun } = await import("../packages/pi-better-subagents/finalization.ts");
const {
    OPERATION_RESUME_ADMISSION_EVENT,
    createResumeOrchestration,
    finalizeWorkerParkAfterExit,
    resumePrompt,
} = await import("../packages/pi-better-subagents/worker-waits.ts");
const { supportsParkingBoundary } = await import("../packages/pi-better-subagents/child-operations.ts");
const { createObservedWaitHost } = await import("../packages/pi-better-background-tasks/src/observed-waits.ts");
const { registerTools } = await import("../packages/pi-better-background-tasks/src/tools.ts");
const { openStore } = await import("../packages/operation-coordinator/index.ts");
const { deliveryObserverArguments, resolveDeliveryWatcher } = await import("../packages/pi-better-background-tasks/src/delivery-observer.ts");
const {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    VERSION,
} = await import("@earendil-works/pi-coding-agent");
const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
const { parentProvider } = await import("./fixtures/observed-waits/parent-provider.extension.mjs");
const { findSavedConversation } = await import("../packages/pi-better-subagents/continuation.ts");
const { processExists } = await import("../packages/pi-better-subagents/spawn.ts");
const support = await import("../packages/pi-better-subagents/tests/worker-waits-support.mjs");

const WORKER_FIXTURE = join(fixtures, "worker-session.mjs");
const WATCHER_FIXTURE = join(fixtures, "watch-pr-delivery.stub.mjs");
const OFFLINE_EXTENSION = join(fixtures, "offline-provider.extension.mjs");
const PARENT_EXTENSION = join(fixtures, "parent-provider.extension.mjs");
const PARENT_SESSION = "parent-session-1";
const BRANCH = "branch-1";
const runningChildren = new Set();

afterEach(() => {
    support.cleanupAll();
    for (const child of runningChildren) {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
    runningChildren.clear();
    delete process.env.PI_ACCEPTANCE_WATCH_MARKER;
});

after(() => {
    process.env.PATH = originalPath;
    if (ownsDurableRoot) rmSync(durableRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    if (ownsScratch) rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJson(path) {
    return JSON.parse(readFileSync(path, "utf8"));
}

/** Spawn one real child process and own its lifetime. */
function runFixture(script, env, { label = "fixture", timeoutMs = 90_000 } = {}) {
    const child = spawn(process.execPath, ["--import", "tsx", script], {
        cwd: repoRoot,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
    });
    runningChildren.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    const done = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch { /* already gone */ }
            reject(new Error(`${label} timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        }, timeoutMs);
        child.on("error", (error) => {
            clearTimeout(timer);
            runningChildren.delete(child);
            reject(error);
        });
        child.on("close", (code, signal) => {
            clearTimeout(timer);
            runningChildren.delete(child);
            resolve({ code, signal, stdout, stderr, pid: child.pid });
        });
    });
    return { child, done };
}

function spawnFailure(label, run, result) {
    return new Error([
        `${label} failed`,
        `exit: ${run.code}${run.signal ? ` (${run.signal})` : ""}`,
        `stdout tail:\n${run.stdout.slice(-2_000)}`,
        `stderr tail:\n${run.stderr.slice(-3_000)}`,
        result ? `worker result:\n${JSON.stringify(result, null, 2).slice(0, 3_000)}` : "worker result: missing",
    ].join("\n"));
}

function workerScope(stack, runId, conversationId = runId) {
    return {
        runId,
        conversationId,
        workspace: stack.workspace,
        authorityReference: `authority:acceptance:${conversationId}`,
        branchId: BRANCH,
        goalId: null,
    };
}

function workerPolicy(stack, authorityReference) {
    return {
        version: 1,
        sandbox: null,
        tools: ["read", "write", "bash"],
        clean: false,
        deadlineAt: null,
        authorityReference,
        workspace: stack.workspace,
    };
}

function launchRecipe(stack, attemptId, sessionDirectory) {
    return {
        version: 1,
        attemptId,
        sessionId: attemptId,
        sessionDir: sessionDirectory,
        cwd: stack.workspace,
        tools: "read,write,bash",
        clean: false,
        allowNested: false,
        approve: false,
        sandbox: false,
        gitCloneWorkspace: false,
        callback: true,
    };
}

function metaFor(stack, attemptId, sessionDirectory, authorityReference, plan) {
    return {
        id: attemptId,
        status: "running",
        pid: 0,
        spawnPid: process.pid,
        cwd: stack.workspace,
        promptPreview: "controlled acceptance task",
        startedAt: Date.now() - 1_000,
        logPath: registry.logPathFor(attemptId),
        sessionId: attemptId,
        callback: true,
        recipe: launchRecipe(stack, attemptId, sessionDirectory),
        operations: {
            version: 1,
            bridgeRunId: attemptId,
            conversationId: attemptId,
            authorityReference,
            branchId: BRANCH,
            goalId: null,
            policy: { version: 1, sandbox: null, tools: ["read", "write", "bash"], clean: false, deadlineAt: null },
            tools: [...plan.tools],
        },
    };
}

async function registerWorker(stack, { attemptId, plan, sessionDirectory, authorityReference, writerLeaseId }) {
    const policy = workerPolicy(stack, authorityReference);
    const registration = await stack.bridge.register({
        runId: attemptId,
        conversationId: attemptId,
        workspace: stack.workspace,
        authorityReference,
        branchId: BRANCH,
        goalId: null,
        policy,
        capabilities: plan.capabilities,
        tools: plan.tools,
        schemas: support.schemasFor(stack.pi, plan.tools),
        attemptId,
        ...(writerLeaseId ? { writerLeaseId } : {}),
        owner: {
            sessionId: PARENT_SESSION,
            workspace: stack.workspace,
            branchId: BRANCH,
            goalId: null,
        },
    });
    assert.ok(registration.capabilities.parking, "production bridge plan must expose parking");
    assert.ok(registration.tools.includes("wait_for_operations"));
    assert.ok(sessionDirectory, "a real saved-conversation directory is required");
    return { registration, policy };
}

/**
 * Drive a real worker child through spawn -> wait -> native checkpoint -> clean
 * exit. The parent writes the trusted attempt record first, exactly as the
 * production launcher does, and records the real child pid afterwards.
 */
async function runParkingWorker(stack, options) {
    const { attemptId, outcome = "success" } = options;
    const { sessionDirectory } = support.sessionFixture(durableRoot, attemptId);
    mkdirSync(sessionDirectory, { recursive: true });
    const plan = support.defaultPlan();
    const authorityReference = `authority:acceptance:${attemptId}`;
    registry.writeMeta(metaFor(stack, attemptId, sessionDirectory, authorityReference, plan));
    const { registration } = await registerWorker(stack, {
        attemptId,
        plan,
        sessionDirectory,
        authorityReference,
        writerLeaseId: `lease-${attemptId}`,
    });
    const resultFile = join(stack.root, `${attemptId}-worker.json`);
    const releaseFile = join(stack.root, `${attemptId}-release`);
    const running = runFixture(WORKER_FIXTURE, {
        ...registration.env,
        CHILD_MODE: "park",
        CHILD_OUTCOME: outcome,
        CHILD_RELEASE_FILE: releaseFile,
        CHILD_WORKSPACE: stack.workspace,
        CHILD_SESSION_DIR: sessionDirectory,
        CHILD_SESSION_ID: attemptId,
        CHILD_RESULT_FILE: resultFile,
        CHILD_AGENT_DIR: stack.root,
    }, { label: `worker ${attemptId}` });
    const real = registry.readMeta(attemptId);
    assert.ok(real, "the trusted attempt record must exist before the checkpoint");
    registry.writeMeta({ ...real, pid: running.child.pid });
    const run = await running.done;
    assert.equal(existsSync(resultFile), true, spawnFailure(`worker ${attemptId} produced no result`, run));
    const result = readJson(resultFile);
    assert.equal(run.code, 0, spawnFailure(`worker ${attemptId}`, run, result));
    assert.equal(result.error, undefined, spawnFailure(`worker ${attemptId}`, run, result));
    return { plan, authorityReference, sessionDirectory, resultFile, releaseFile, run, result };
}

function parseWait(workerResult) {
    const wait = JSON.parse(workerResult.waitText);
    const waitId = wait.waitId ?? wait.operationWait?.waitId;
    const generation = wait.generation ?? wait.operationWait?.generation;
    const taskIds = wait.taskIds ?? wait.operationWait?.taskIds ?? [];
    assert.equal(typeof waitId, "string");
    assert.equal(Number.isSafeInteger(generation), true);
    assert.equal(taskIds.length, 1, "the acceptance wait owns exactly one task");
    return { waitId, generation, taskId: taskIds[0] };
}

/** Finalize the real attempt and prove the park after the child exited. */
async function finalizePark(stack, attemptId) {
    support.writeCoherentLog(registry.logPathFor(attemptId));
    const finalized = finalizeRun(attemptId, 0);
    assert.equal(finalized.park.parked, true, `expected a clean park, got ${JSON.stringify(finalized)}`);
    const finalization = await finalizeWorkerParkAfterExit({
        runId: attemptId,
        service: stack.service,
        writerLeaseReleased: true,
        writerPidGone: true,
    });
    assert.equal(finalization.outcome, "parked", JSON.stringify(finalization));
    assert.ok(
        finalization.wait?.phase === "waiting" || finalization.wait?.phase === "ready",
        `a proven park must leave parking (got ${String(finalization.wait?.phase)})`,
    );
    return { finalized, finalization };
}

function waitFor(stack, predicate, { timeoutMs = 30_000, label = "durable transition" } = {}) {
    return (async () => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            await stack.host.reconcileNow();
            if (predicate()) return;
            await sleep(100);
        }
        throw new Error(`timed out waiting for ${label}`);
    })();
}

function waitOf(stack, scope, waitId, generation) {
    return stack.service.listWorkerWaits(scope).find((entry) => entry.waitId === waitId && entry.generation === generation);
}

function allowResume(stack) {
    const seen = [];
    stack.events.on(OPERATION_RESUME_ADMISSION_EVENT, (request) => {
        seen.push(request.owner);
        request.reply({ allowed: true, revision: 1 });
    });
    return seen;
}

/**
 * Production capacity ledger (capacity.mjs) fed by the real registry, not a
 * hand-written allow/deny flag. Only the set of run ids is test-owned.
 */
function registryCapacity(runIds) {
    const countRunning = () => runIds
        .map((id) => registry.readMeta(id))
        .filter((meta) => meta?.status === "running").length;
    const gate = createCapacityGate(countRunning);
    return {
        countRunning,
        pending: () => gate.pending,
        capacity: {
            tryReserve: () => gate.tryReserve(1, 1),
            recheck: () => countRunning() + gate.pending <= 1,
            commit: () => gate.commit(1),
            release: () => gate.release(1),
        },
    };
}

/**
 * Real resume orchestration + real continuation child. The launcher opens the
 * SAME native saved session, reads status/log evidence, acknowledges the exact
 * terminal revision, then continues its own assignment.
 */
function installContinuation(stack, options) {
    const {
        attemptId,
        sessionDirectory,
        plan,
        authorityReference,
        outcome,
        capacity,
        context,
    } = options;
    const launches = [];
    const resumed = [];
    const policy = workerPolicy(stack, authorityReference);
    const orchestration = createResumeOrchestration({
        pi: stack.pi,
        service: () => stack.service,
        rpc: stack.bridge.rpc,
        context,
        capacity,
        launch: async (input) => {
            assert.equal(processExists(registry.readMeta(attemptId).pid), false, "the parked writer is gone before replacement spawn");
            const published = stack.store.listResumeClaims({ waitId: input.park.waitId, generation: input.park.generation })
                .filter((claim) => claim.state === "published");
            assert.equal(published.length, 1, "exactly one resume claim is published before spawn");
            assert.equal(published[0].attemptId, input.assignedRunId);
            assert.equal(published[0].launchToken, input.launchToken);
            launches.push(input);
            const assignedRunId = input.assignedRunId;
            const registration = await stack.bridge.register({
                runId: assignedRunId,
                conversationId: attemptId,
                workspace: stack.workspace,
                authorityReference,
                branchId: BRANCH,
                goalId: null,
                policy,
                capabilities: plan.capabilities,
                tools: plan.tools,
                schemas: support.schemasFor(stack.pi, plan.tools),
                attemptId: assignedRunId,
                owner: {
                    sessionId: PARENT_SESSION,
                    workspace: stack.workspace,
                    branchId: BRANCH,
                    goalId: null,
                },
            });
            const resultFile = join(stack.root, `${assignedRunId}-resume.json`);
            const running = runFixture(WORKER_FIXTURE, {
                ...registration.env,
                CHILD_MODE: "resume",
                CHILD_OUTCOME: outcome,
                CHILD_SESSION_FILE: options.sessionFile,
                CHILD_WORKSPACE: stack.workspace,
                CHILD_SESSION_DIR: sessionDirectory,
                CHILD_SESSION_ID: attemptId,
                CHILD_RESULT_FILE: resultFile,
                CHILD_AGENT_DIR: stack.root,
                CHILD_PROMPT: resumePrompt(input.park),
            }, { label: `resume ${assignedRunId}` });
            const run = await running.done;
            assert.equal(existsSync(resultFile), true, spawnFailure(`resume ${assignedRunId} produced no result`, run));
            const result = readJson(resultFile);
            assert.equal(run.code, 0, spawnFailure(`resume ${assignedRunId}`, run, result));
            assert.equal(result.error, undefined, spawnFailure(`resume ${assignedRunId}`, run, result));
            assert.equal(result.sessionFile, options.sessionFile, "the continuation must reopen the parked saved session");
            resumed.push({ assignedRunId, result, run });
        },
    });
    stack.service.registerContinuationAdapter(orchestration.adapter);
    return { orchestration, launches, resumed };
}

async function prepareParkedWorker(stack, attempt) {
    const { attemptId, outcome = "success" } = attempt;
    const worker = await runParkingWorker(stack, { attemptId, outcome });
    const { waitId, generation, taskId } = parseWait(worker.result);
    const scope = workerScope(stack, attemptId);
    const parking = waitOf(stack, scope, waitId, generation);
    assert.equal(parking.phase, "parking", "the staged checkpoint must not release parking while the writer was alive");

    // The worker exited; the detached runner must still be alive for a task
    // whose controlled duration outlives the worker.
    const status = stack.service.statusForWorker(scope, taskId);
    if (outcome === "success") {
        assert.equal(status.status, "running", "the task runner must survive the worker exit");
    }
    return { ...worker, waitId, generation, taskId, scope, status };
}

/** Release the parent-gated controlled task after proving the runner survived. */
function releaseControlledTask(parked) {
    writeFileSync(parked.releaseFile, "release\n");
}

function assertSlotOccupied(attemptId) {
    const slot = registryCapacity([attemptId]);
    assert.equal(slot.capacity.tryReserve(), false, "the still-running attempt owns its capacity slot");
}

function assertSlotReleased(stack, attemptId) {
    const slot = registryCapacity([attemptId]);
    assert.equal(slot.countRunning(), 0, "a clean worker exit releases the running slot");
    assert.equal(slot.capacity.tryReserve(), true, "the real capacity ledger reports a free slot after exit");
    slot.capacity.release();
}

test("a real worker parks, releases its slot, the runner survives, and the saved session resumes once and acknowledges", { timeout: 180_000 }, async () => {
    const stack = await support.startStack();
    assert.equal(stack.started, true, "the Subagents bridge host must resolve the real Background service");
    assert.equal(supportsParkingBoundary(VERSION), true, `installed SDK ${VERSION} exposes the terminate boundary`);

    const attemptId = "sa_ow_success";
    const parked = await prepareParkedWorker(stack, { attemptId, outcome: "success" });
    assertSlotOccupied(attemptId);

    // --- real native SessionManager / SDK termination boundary ---------------
    assert.equal(parked.result.modelRequests, 2, "the park tool result must terminate before a third model request");
    assert.equal(parked.result.bridge.parkingSupported, true);
    assert.equal(parked.result.bridge.status, "parked");
    assert.equal(parked.result.lastMessage.role, "toolResult");
    assert.equal(parked.result.lastMessage.toolName, "wait_for_operations");
    const diagnosticEvents = parked.result.diagnostics.map((event) => event.event);
    assert.ok(diagnosticEvents.includes("ready"), JSON.stringify(parked.result.diagnostics));
    assert.ok(diagnosticEvents.includes("parking"), JSON.stringify(parked.result.diagnostics));
    assert.ok(diagnosticEvents.includes("parked"), JSON.stringify(parked.result.diagnostics));
    assert.match(parked.result.sessionFile, new RegExp(`_${attemptId}\\.jsonl$`));
    const savedEntries = parked.result.entries.filter((entry) => entry.type === "message");
    assert.ok(savedEntries.some((entry) => entry.toolName === "bg_task_spawn"));
    assert.ok(savedEntries.some((entry) => entry.toolName === "wait_for_operations"));

    // --- unavailable host + full capacity leave the ready wait queued ---------
    const occupier = "sa_ow_occupier";
    registry.writeMeta({
        id: occupier,
        status: "running",
        pid: 999_999,
        spawnPid: process.pid,
        cwd: stack.workspace,
        promptPreview: "unrelated running assignment",
        startedAt: Date.now(),
        logPath: registry.logPathFor(occupier),
        sessionId: occupier,
        callback: false,
    });
    const capacity = registryCapacity([attemptId, occupier]);
    assert.equal(capacity.capacity.tryReserve(), false, "the only slot is occupied");
    // The continuation adapter is registered before the wait can become ready,
    // exactly as the Subagents coordinator starts before any worker launches.
    let supervisorAvailable = false;
    const supervisorCtx = support.createCtx(stack.workspace, "unrelated-session", "unrelated-branch");
    const goals = [];
    stack.events.on(OPERATION_RESUME_ADMISSION_EVENT, (request) => {
        goals.push(request.owner);
        request.reply({ allowed: false, reason: "the parent Goal is paused", revision: 1 });
    });
    const continuation = installContinuation(stack, {
        attemptId,
        sessionDirectory: parked.sessionDirectory,
        sessionFile: parked.result.sessionFile,
        plan: parked.plan,
        authorityReference: parked.authorityReference,
        outcome: "success",
        capacity: capacity.capacity,
        context: () => supervisorAvailable ? supervisorCtx : undefined,
    });

    await finalizePark(stack, attemptId);
    assertSlotReleased(stack, attemptId);

    // A compatible supervisor is available, but no capacity exists yet: the ready
    // delivery must defer without a claim or launch. The parent remains inactive.
    supervisorAvailable = true;
    releaseControlledTask(parked);
    await waitFor(stack, () => waitOf(stack, parked.scope, parked.waitId, parked.generation)?.phase === "ready", {
        label: "the wait to settle and become ready",
    });
    assert.equal(continuation.launches.length, 0, "full capacity must not launch a continuation");
    assert.equal(stack.store.listResumeClaims({ waitId: parked.waitId }).length, 0, "full capacity publishes no claim");
    assert.equal(waitOf(stack, parked.scope, parked.waitId, parked.generation).phase, "ready", "a queued continuation stays ready");
    const ready = waitOf(stack, parked.scope, parked.waitId, parked.generation);
    assert.equal(ready.settled, true);
    assert.equal(ready.dependencies[0].terminalOutcome, "succeeded");

    // The actual background task completed after the worker exited.
    const terminal = stack.service.statusForWorker(parked.scope, parked.taskId);
    assert.equal(terminal.status, "succeeded");
    assert.equal(terminal.terminalOutcome, "succeeded");
    const taskLog = stack.service.logForWorker(parked.scope, parked.taskId, { lines: 20 });
    assert.match(taskLog.stdout, /controlled-task-complete/);

    // Capacity frees up, but no compatible host is available: defer, not claim.
    registry.writeMeta({ ...registry.readMeta(occupier), status: "completed" });
    supervisorAvailable = false;
    await stack.host.reconcileNow();
    await sleep(150);
    await stack.host.reconcileNow();
    assert.equal(continuation.launches.length, 0, "an unavailable supervisor must defer worker dispatch");
    assert.equal(capacity.pending(), 0, "queued work reserves no idle capacity");
    assert.equal(stack.store.listResumeClaims({ waitId: parked.waitId }).length, 0);
    assert.equal(waitOf(stack, parked.scope, parked.waitId, parked.generation).phase, "ready");

    // The unrelated supervisor returns while the parent remains inactive and its
    // Goal rejects parent execution. Resume the SAME worker session exactly once.
    supervisorAvailable = true;
    await waitFor(stack, () => continuation.launches.length === 1, { label: "the single continuation launch" });
    assert.equal(continuation.resumed.length, 1);
    assert.deepEqual(goals, [], "delegated execution must never ask the parent's Goal for admission");
    const captured = registry.readParkRecord(attemptId);
    assert.deepEqual({
        sessionId: captured.ownerSessionId,
        workspace: captured.ownerWorkspace,
        branchId: captured.ownerBranchId,
        goalId: captured.ownerGoalId,
    }, {
        sessionId: PARENT_SESSION,
        workspace: stack.workspace,
        branchId: BRANCH,
        goalId: null,
    }, "the unrelated supervisor never replaces the captured result recipient");
    assert.equal(capacity.pending(), 0, "dispatch commits the reservation exactly once");
    assert.equal(processExists(parked.run.pid), false, "the original conversation writer exited before continuation");

    const resumed = continuation.resumed[0];
    assert.equal(resumed.result.sessionId, attemptId, "the continuation keeps the parked conversation id");
    assert.equal(resumed.result.modelRequests, 3, "status/log -> acknowledge -> final text");
    assert.deepEqual(resumed.result.toolCalls.map((entry) => entry.name), [
        "bg_task_status",
        "bg_task_log",
        "acknowledge_operation_result",
    ]);
    const acknowledged = JSON.parse(resumed.result.ackText);
    assert.equal(acknowledged.phase, "consumed");
    assert.equal(acknowledged.disposition, "assignment-complete");
    const reopened = resumed.result.entries.filter((entry) => entry.type === "message");
    assert.ok(reopened.some((entry) => entry.toolName === "bg_task_spawn"), "the resumed session contains its original history");
    assert.ok(reopened.some((entry) => entry.toolName === "acknowledge_operation_result"));

    const claim = stack.store.listResumeClaims({ waitId: parked.waitId, generation: parked.generation })
        .filter((entry) => entry.state === "published");
    assert.equal(claim.length, 1);
    assert.equal(claim[0].attemptId, continuation.launches[0].assignedRunId);
    assert.equal(claim[0].launchToken, continuation.launches[0].launchToken);

    const consumed = stack.store.getWait({ waitId: parked.waitId, generation: parked.generation });
    assert.equal(consumed.phase, "consumed");
    assert.equal(consumed.acknowledgement.disposition, "assignment-complete");
    assert.deepEqual(consumed.acknowledgement.revisions, [{
        operationId: consumed.dependencies[0].operationId,
        revision: consumed.dependencies[0].terminalRevision,
    }]);

    // Extra reconciliation must not deliver the consumed wait again.
    await stack.host.reconcileNow();
    await stack.host.reconcileNow();
    assert.equal(continuation.launches.length, 1, "the continuation launches at most once");
    assert.equal(waitOf(stack, parked.scope, parked.waitId, parked.generation).phase, "consumed");
    continuation.orchestration.stop();
});

test("a failed controlled task is interpreted as blocked by the resumed saved session", { timeout: 180_000 }, async () => {
    const stack = await support.startStack();
    assert.equal(stack.started, true);
    const attemptId = "sa_ow_failure";
    const parked = await prepareParkedWorker(stack, { attemptId, outcome: "failure" });
    assertSlotOccupied(attemptId);
    assert.equal(parked.result.modelRequests, 2, "the failed task path also stops at the park boundary");
    assert.equal(parked.result.bridge.status, "parked");

    // Keep the parent paused through finalization so the task may settle during
    // parking without racing finalize's park-record write. Activation then uses
    // the ordinary deferred-delivery retry.
    let parentPaused = true;
    const capacity = registryCapacity([attemptId]);
    allowResume(stack);
    const continuation = installContinuation(stack, {
        attemptId,
        sessionDirectory: parked.sessionDirectory,
        sessionFile: parked.result.sessionFile,
        plan: parked.plan,
        authorityReference: parked.authorityReference,
        outcome: "failure",
        capacity: capacity.capacity,
        context: () => parentPaused ? undefined : stack.ctx,
    });
    await finalizePark(stack, attemptId);
    assertSlotReleased(stack, attemptId);

    const failed = stack.service.statusForWorker(parked.scope, parked.taskId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.terminalOutcome, "failed");
    const failedLog = stack.service.logForWorker(parked.scope, parked.taskId, { lines: 20 });
    assert.match(failedLog.stderr, /controlled-task-failure/);
    await waitFor(stack, () => waitOf(stack, parked.scope, parked.waitId, parked.generation)?.phase === "ready", {
        label: "the failed task's wait to become ready",
    });
    assert.equal(continuation.launches.length, 0, "a paused parent defers the ready failure delivery");

    parentPaused = false;
    await waitFor(stack, () => continuation.launches.length === 1, { label: "the failure continuation launch" });
    assert.equal(continuation.resumed.length, 1);
    const resumed = continuation.resumed[0];
    assert.deepEqual(resumed.result.toolCalls.map((entry) => entry.name), [
        "bg_task_status",
        "bg_task_log",
        "acknowledge_operation_result",
    ]);
    const ack = JSON.parse(resumed.result.ackText);
    assert.equal(ack.phase, "consumed");
    assert.equal(ack.disposition, "blocked");
    const consumed = stack.store.getWait({ waitId: parked.waitId, generation: parked.generation });
    assert.equal(consumed.phase, "consumed");
    assert.equal(consumed.acknowledgement.disposition, "blocked");
    assert.match(consumed.acknowledgement.note, /failed/);
    continuation.orchestration.stop();
});

/**
 * Parent-only stack with the PRODUCTION tool definitions (the shared bridge
 * harness intentionally keeps schemas only). The delivery recipe needs the real
 * `execute` bodies from tools.ts.
 */
async function startParentOnlyStack() {
    const root = support.tempDirectory("acceptance-delivery");
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const events = new EventEmitter();
    const tools = new Map();
    const notifications = [];
    const pi = {
        events,
        registerTool(definition) {
            tools.set(definition.name, definition);
            return definition;
        },
        on() { return () => {}; },
        getAllTools: () => [...tools.values()],
        getActiveTools: () => [...tools.keys()],
        setActiveTools() {},
        appendEntry() {},
        getAllCommands: () => [],
        sendMessage() {},
        ui: { notify() {} },
    };
    const storePath = join(root, "operations.sqlite");
    const host = createObservedWaitHost(pi, {
        storePath,
        supervisorDirectory: join(root, "supervisor"),
        pollMs: 0,
        notifyParent: (notification) => notifications.push(notification),
    });
    const ctx = support.createCtx(workspace);
    host.start(ctx);
    registerTools(pi);
    const store = openStore({ path: storePath });
    return {
        root,
        workspace,
        pi,
        events,
        tools,
        notifications,
        host,
        get service() { return host.service; },
        ctx,
        store,
        close() {
            try { store.close(); } catch { /* already closed */ }
            try { host.close(); } catch { /* already closed */ }
        },
    };
}

async function waitUntil(fn, label, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await fn();
        if (value) return value;
        await sleep(100);
    }
    throw new Error(`timed out waiting for ${label}`);
}

function messageText(message) {
    if (!message || !Array.isArray(message.content)) return "";
    return message.content
        .filter((part) => part && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
}

async function callSessionTool(session, name, params = {}) {
    const tool = session.agent.state.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} is registered in the real parent session`);
    const result = await tool.execute(`acceptance-${name}-${Date.now()}`, params, new AbortController().signal);
    return result.content.map((part) => part.text ?? "").join("\n");
}

/**
 * A real parent AgentSession over the production Background and Subagents
 * extensions, loaded from their package entry files. Its model is an offline
 * provider extension; the worker child gets a different provider extension
 * through the ordinary `toolExtensions` config mapping.
 */
async function openProductionParent(project) {
    const agentDir = support.tempDirectory("acceptance-cli-agent");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousParentTrace = process.env.ACCEPTANCE_PARENT_TRACE;
    // Background's store and the Subagents config both resolve the agent
    // directory from the environment, not from createAgentSession's option.
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const parentTrace = join(agentDir, "parent-inventory.json");
    process.env.ACCEPTANCE_PARENT_TRACE = parentTrace;
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(join(agentDir, "extensions", "pi-better-subagents-config.json"), JSON.stringify({
        defaultModel: "acceptance-offline/offline",
        defaultTools: "read,bash,acceptance_offline_model",
        maxConcurrent: 1,
        delegationMode: "adaptive",
        toolExtensions: { acceptance_offline_model: OFFLINE_EXTENSION },
        providerExtensions: { "acceptance-offline": OFFLINE_EXTENSION },
        inheritExtensions: false,
    }, null, 2));

    const settingsManager = SettingsManager.inMemory({
        retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
        cwd: project,
        agentDir,
        settingsManager,
        additionalExtensionPaths: [
            join(repoRoot, "packages", "pi-better-background-tasks", "src", "index.ts"),
            join(repoRoot, "packages", "pi-better-goal", "src", "index.ts"),
            join(repoRoot, "packages", "pi-better-subagents", "index.ts"),
            OFFLINE_EXTENSION,
            PARENT_EXTENSION,
        ],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);

    const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        refreshOnCreate: false,
        modelsPath: join(agentDir, "models.json"),
        modelsStorePath: join(agentDir, "models-store.json"),
    });
    modelRuntime.registerProvider("acceptance-parent", parentProvider);
    const sessionManager = SessionManager.create(project, join(agentDir, "parent-sessions"));
    const { session } = await createAgentSession({
        cwd: project,
        agentDir,
        settingsManager,
        modelRuntime,
        resourceLoader,
        sessionManager,
        model: modelRuntime.getModel("acceptance-parent", "offline"),
    });
    const errors = [];
    await session.bindExtensions({ onError: (error) => errors.push(String(error)), shutdownHandler: () => {} });

    const storePath = join(agentDir, "operation-coordinator.sqlite");
    await waitUntil(() => existsSync(storePath), "the Background observed-waits store to open");
    // session_start handlers are asynchronous: give the Subagents coordinator its
    // service probe before the first spawn can read `workerOperations.available`.
    await waitUntil(async () => {
        try {
            return !(await callSessionTool(session, "bg_task_wait_list")).includes("unavailable");
        } catch {
            return false;
        }
    }, "the Background observed-waits service to become available");
    await sleep(250);

    const tools = session.agent.state.tools;
    for (const name of ["subagent_spawn", "wait_for_operations", "acknowledge_operation_result", "bg_task_wait_cancel"]) {
        assert.ok(tools.some((tool) => tool.name === name), `${name} is in the real parent inventory`);
    }
    const inventory = await waitUntil(() => existsSync(parentTrace) && readJson(parentTrace), "the extension-visible parent inventory", 10_000);
    assert.equal(realpathSync(inventory.markerSource), realpathSync(OFFLINE_EXTENSION), "the marker tool reports its real extension source path through pi.getAllTools()");
    assert.equal(inventory.sawWaitTool, true);
    assert.equal(inventory.sawSpawnTool, true);

    return { session, agentDir, storePath, errors, previousAgentDir, previousParentTrace, inventory };
}

test("the parent delivery recipe registers the bundled watcher, attributes it to the session, and consumes its verdict", { timeout: 120_000 }, async () => {
    const agentDir = support.tempDirectory("acceptance-agent");
    const watcherDir = join(agentDir, "skills", "mergify", "scripts");
    mkdirSync(watcherDir, { recursive: true });
    const watcher = join(watcherDir, "watch-pr-delivery.mjs");
    copyFileSync(WATCHER_FIXTURE, watcher);
    const marker = join(agentDir, "watch-argv.json");
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_ACCEPTANCE_WATCH_MARKER = marker;

    let stack;
    try {
        // The recipe resolves the installed stateful watcher, never a generated
        // polling predicate.
        assert.equal(resolveDeliveryWatcher(), watcher);
        assert.throws(
            () => deliveryObserverArguments("owner/project", 42, "/tmp/llm-poller.mjs"),
            /Unsupported delivery observer implementation/,
        );

        stack = await startParentOnlyStack();
        const tool = stack.tools.get("watch_delivery");
        assert.ok(tool, "the bundled delivery observer tool is registered");
        const ctx = stack.ctx;
        const result = await tool.execute("watch-call-1", { repo: "owner/project", pr: 42 }, undefined, undefined, ctx);
        const payload = JSON.parse(result.content[0].text);
        assert.equal(payload.status, "observing");
        assert.equal(payload.mutationPerformed, false, "observation must not enqueue, merge, push or edit");
        assert.match(payload.taskId, /^bgs_[0-9a-f]{20}$/);
        assert.equal(typeof payload.wait.waitId, "string");

        const waitView = stack.host.waitViewForParent(ctx, payload.wait.waitId, payload.wait.generation);
        assert.equal(waitView.ownerKind, "parent-session");
        assert.deepEqual(waitView.taskIds, [payload.taskId]);
        const pending = stack.host.listWaitsForParent(ctx, { pendingOnly: true });
        assert.equal(pending.some((entry) => entry.waitId === payload.wait.waitId), true, "the watcher wait is registered and visible");

        await waitFor(stack, () => stack.host.statusForParent(ctx, payload.taskId).phase === "terminal", {
            label: "the supervised watcher task to terminate",
        });
        const notification = stack.notifications.find((entry) => entry.waitId === payload.wait.waitId);
        assert.ok(notification, "the parent owner receives the ready notification");
        assert.equal(notification.outcome, "succeeded");
        assert.equal(notification.taskId, payload.taskId);

        const markerValue = readJson(marker);
        assert.deepEqual(markerValue.argv, ["--repo", "owner/project", "--pr", "42"]);
        assert.equal(markerValue.pid > 0, true);

        const statusTool = stack.tools.get("bg_task_status");
        const logTool = stack.tools.get("bg_task_log");
        const statusResult = await statusTool.execute("watch-call-2", { id: payload.taskId }, undefined, undefined, ctx);
        const logResult = await logTool.execute("watch-call-3", { id: payload.taskId, lines: 20 }, undefined, undefined, ctx);
        const statusText = statusResult.content.map((part) => part.text).join("\n");
        const logText = logResult.content.map((part) => part.text).join("\n");
        assert.match(statusText, /succeeded/);
        assert.match(logText, /merged/);
        assert.match(logText, /0123456789abcdef/);

        const view = stack.host.waitViewForParent(ctx, payload.wait.waitId, payload.wait.generation);
        assert.equal(view.phase, "ready");
        const revisions = view.dependencies.map((dep) => ({ operationId: dep.operationId, revision: dep.terminalRevision }));
        const ackTool = stack.tools.get("acknowledge_operation_result");
        const ackResult = await ackTool.execute("watch-call-4", {
            wait_id: view.waitId,
            generation: view.generation,
            terminal_revisions: revisions,
            disposition: "assignment-complete",
            note: "read the Mergify verdict from the watcher log",
        }, undefined, undefined, ctx);
        assert.match(ackResult.content.map((part) => part.text).join("\n"), /phase consumed/);
        const waitRecord = stack.store.getWait({ waitId: view.waitId, generation: view.generation });
        assert.equal(waitRecord.phase, "consumed");
        assert.equal(waitRecord.owner.kind, "parent-session");
        assert.equal(waitRecord.acknowledgement.disposition, "assignment-complete");
    } finally {
        stack?.close();
        if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
});

test("cancelling a parked wait detaches observation and no continuation is launched", { timeout: 180_000 }, async () => {
    const stack = await support.startStack();
    assert.equal(stack.started, true);
    const attemptId = "sa_ow_cancel";
    const parked = await prepareParkedWorker(stack, { attemptId, outcome: "success" });
    assertSlotOccupied(attemptId);

    // The runner is still executing when the wait is cancelled: stopping the
    // operation is a separate choice from detaching observation.
    const stillRunning = stack.service.statusForWorker(parked.scope, parked.taskId);
    assert.equal(stillRunning.status, "running");

    let parentPaused = true;
    const capacity = registryCapacity([attemptId]);
    allowResume(stack);
    const continuation = installContinuation(stack, {
        attemptId,
        sessionDirectory: parked.sessionDirectory,
        plan: parked.plan,
        authorityReference: parked.authorityReference,
        outcome: "success",
        capacity: capacity.capacity,
        context: () => parentPaused ? undefined : stack.ctx,
    });
    await finalizePark(stack, attemptId);
    assertSlotReleased(stack, attemptId);

    const cancelled = stack.service.cancelWorkerWait(parked.scope, {
        waitId: parked.waitId,
        generation: parked.generation,
        reason: "the owner cancelled the parked assignment",
    });
    assert.equal(cancelled.phase, "cancelled");
    await sleep(150);
    assert.equal(registry.readParkRecord(attemptId)?.phase, "cancelled");
    assert.equal(stack.store.listResumeClaims({ waitId: parked.waitId }).length, 0);

    // Activate the owner and capacity: only cancellation stands between the
    // settled task and a resumed continuation. Then release the gated runner.
    parentPaused = false;
    releaseControlledTask(parked);

    // Let the detached runner settle; cancellation must not resurrect delivery.
    await waitFor(stack, () => stack.service.statusForWorker(parked.scope, parked.taskId).phase === "terminal", {
        label: "the cancelled operation's runner to terminate",
    });
    await stack.host.reconcileNow();
    await sleep(150);
    await stack.host.reconcileNow();
    assert.equal(continuation.launches.length, 0, "a cancelled wait never resumes");
    const wait = stack.store.getWait({ waitId: parked.waitId, generation: parked.generation });
    assert.equal(wait.phase, "cancelled");
    const outbox = stack.store.listOutbox({ waitId: parked.waitId }).filter((event) =>
        event.state === "pending" || event.state === "claimed" || event.state === "delivered");
    assert.deepEqual(outbox, [], "cancellation voids or acknowledges any queued delivery");
    const task = stack.service.statusForWorker(parked.scope, parked.taskId);
    assert.equal(task.terminalOutcome, "succeeded", "cancelling the wait does not rewrite the task's own outcome");
    continuation.orchestration.stop();
});

/*
 * Production CRM path: the resumed child's operation bridge and
 * `meta.operations` are registered under the owner captured when the worker
 * parked (`internal.parkOwner`), not under the foreground binding as it stands
 * after the parent model's later tool-result/final branch entries. That keeps the
 * wait's exact-revision reads and acknowledgement owned by the same
 * workspace/session/branch/Goal; the task workspace stays the worker root.
 */
test("production subagent_spawn launches a real CLI worker that parks, and the production continuation CLI reopens and acknowledges the same session", { timeout: 300_000 }, async () => {
    const project = support.tempDirectory("acceptance-cli-project");
    const releaseFile = join(project, "task-release");
    const resumeGate = join(project, "resume-gate");
    const traceFile = join(project, "child-trace.jsonl");
    const previous = {
        project: process.env.ACCEPTANCE_PROJECT,
        release: process.env.ACCEPTANCE_RELEASE_FILE,
        gate: process.env.ACCEPTANCE_RESUME_GATE,
        trace: process.env.ACCEPTANCE_CHILD_TRACE,
        tools: process.env.ACCEPTANCE_WORKER_TOOLS,
        model: process.env.ACCEPTANCE_CHILD_MODEL,
    };
    process.env.ACCEPTANCE_PROJECT = project;
    process.env.ACCEPTANCE_RELEASE_FILE = releaseFile;
    process.env.ACCEPTANCE_CHILD_TRACE = traceFile;
    process.env.ACCEPTANCE_WORKER_TOOLS = [
        "read", "bash", "acceptance_offline_model",
        "bg_task_spawn", "bg_task_status", "bg_task_log",
        "wait_for_operations", "acknowledge_operation_result",
    ].join(",");
    process.env.ACCEPTANCE_CHILD_MODEL = "acceptance-offline/offline";
    delete process.env.ACCEPTANCE_RESUME_GATE;

    let host;
    let store;
    const ownedRunIds = [];
    try {
        host = await openProductionParent(project);

        await host.session.prompt("launch the production CLI worker now");
        await host.session.waitForIdle();
        const spawnResult = host.session.sessionManager.getEntries()
            .filter((entry) => entry.type === "message")
            .map((entry) => entry.message)
            .find((message) => message.role === "toolResult" && message.toolName === "subagent_spawn");
        assert.ok(spawnResult, "the parent model's subagent_spawn tool call returned a result");
        const spawnText = messageText(spawnResult);
        const initialId = /id=(sa_[A-Za-z0-9_]+)/.exec(spawnText)?.[1];
        assert.ok(initialId, `subagent_spawn did not report a run id:\n${spawnText}`);
        ownedRunIds.push(initialId);

        const initialMeta = await waitUntil(() => registry.readMeta(initialId), "the production run record", 30_000);
        assert.equal(initialMeta.status, "running");
        assert.equal(initialMeta.callback, false);
        assert.equal(initialMeta.model, "acceptance-offline/offline");
        assert.match(initialMeta.recipe.tools, /acceptance_offline_model/);
        assert.match(initialMeta.recipe.tools, /wait_for_operations/);
        assert.ok(initialMeta.operations, "the production launcher registered the worker operation bridge");

        // The real `pi -p` child starts, spawns the gated task through the bridge,
        // checkpoints, and exits at the SDK tool-result boundary. The production
        // exit handler owns finalization; this process never writes a park record.
        const parked = await waitUntil(() => {
            const meta = registry.readMeta(initialId);
            const record = registry.readParkRecord(initialId);
            if (meta?.status === "completed" && record && (record.phase === "waiting" || record.phase === "ready")) {
                return { meta, record };
            }
            return undefined;
        }, "the real CLI worker to exit cleanly and park", 120_000);
        assert.ok(parked.record.checkpoint?.entryId, "the parent registered a native checkpoint");
        assert.ok(parked.meta.park, "the parent recorded the park disposition");

        const workerLog = readFileSync(registry.logPathFor(initialId), "utf8");
        assert.match(workerLog, /"type":"agent_settled"/);
        assert.match(workerLog, /wait_for_operations/);
        assert.doesNotMatch(workerLog, /unexpected model request|fixture decision failed/);

        assert.ok(existsSync(host.storePath), "the real Background store is on disk");
        store = openStore({ path: host.storePath });
        const wait = await waitUntil(() => {
            const waits = store.listWaits();
            return waits.find((entry) => entry.owner.kind === "worker-conversation"
                && entry.owner.sessionId === parked.meta.sessionId
                && entry.owner.workspace === project);
        }, "the durable worker wait registered by the real child", 30_000);
        assert.equal(wait.park !== null, true, "the wait carries its park intent");
        assert.ok(wait.phase === "waiting" || wait.phase === "ready");

        const operationId = wait.dependencies[0].operationId;
        const operation = store.getOperation(operationId);
        const taskId = operation.taskId;
        assert.match(taskId, /^bgs_[0-9a-f]{20}$/);
        assert.equal(operation.terminalRevision, 0, "the gated task is still running after the worker exited");
        assert.equal(taskId, /"taskId":"(bgs_[0-9a-f]{20})"/.exec(workerLog)?.[1], "the child used a real supervised task");
        assert.equal(registryCapacity([initialId]).countRunning(), 0, "the parked attempt released its capacity slot");

        // Release the gated task. The production coordinator must launch the
        // continuation itself, through the ordinary `subagent_spawn` path.
        writeFileSync(releaseFile, "release\n");

        // `listMetasForParent` prefers the test process's metadata cache; a run
        // finalized by the live extension instance in this same process can
        // therefore still look `running` there. Re-read each record from disk.
        const successors = () => registry.listMetasForParent(process.pid)
            .filter((meta) => meta.resumedFrom === initialId)
            .map((meta) => registry.readMeta(meta.id))
            .filter((meta) => meta !== undefined);
        let continuation;
        try {
            continuation = await waitUntil(() => {
                const found = successors();
                if (found.length !== 1) return undefined;
                const meta = found[0];
                if (meta.status === "running" || meta.status === "orphaned" || meta.status === "lost") return undefined;
                return meta;
            }, "the production continuation CLI to finish", 60_000);
        } catch (error) {
            const metas = registry.listMetasForParent(process.pid).map((meta) => ({
                id: meta.id, status: meta.status, resumedFrom: meta.resumedFrom, sessionId: meta.sessionId,
                pid: meta.pid, callback: meta.callback, model: meta.model, logPath: meta.logPath,
            }));
            const currentWait = store.getWait({ waitId: wait.waitId, generation: wait.generation });
            const claims = store.listResumeClaims({ waitId: wait.waitId, generation: wait.generation })
                .map((claim) => ({ state: claim.state, attemptId: claim.attemptId, launchToken: claim.launchToken, createdAt: claim.claimedAt }));
            const logs = Object.fromEntries(successors().map((meta) => {
                try { return [meta.id, readFileSync(registry.logPathFor(meta.id), "utf8").slice(-4_000)]; } catch { return [meta.id, "missing"]; }
            }));
            console.error("[production-cli-timeout]", JSON.stringify({
                metas,
                successors: successors().map((meta) => ({
                    id: meta.id, status: meta.status, pid: meta.pid, alive: processExists(meta.pid),
                    sessionId: meta.sessionId, callback: meta.callback,
                })),
                wait: currentWait,
                claims,
                park: registry.readParkRecord(initialId),
                trace: existsSync(traceFile) ? readFileSync(traceFile, "utf8").slice(-4_000) : "missing",
                logs,
            }, null, 2));
            throw error;
        }
        ownedRunIds.push(continuation.id);
        assert.equal(continuation.sessionId, parked.meta.sessionId, "the continuation keeps the native conversation id");
        assert.equal(continuation.recipe.sessionDir, parked.meta.recipe.sessionDir);
        assert.ok(continuation.resumedFrom === initialId);

        const consumed = store.getWait({ waitId: wait.waitId, generation: wait.generation });
        if (consumed.phase !== "consumed") {
            const logs = Object.fromEntries(successors().map((meta) => {
                try { return [meta.id, readFileSync(registry.logPathFor(meta.id), "utf8").slice(-3_000)]; } catch { return [meta.id, "missing"]; }
            }));
            console.error("[production-cli-not-consumed]", JSON.stringify({
                wait: consumed,
                park: registry.readParkRecord(initialId),
                metas: registry.listMetasForParent(process.pid).map((meta) => ({ id: meta.id, status: meta.status, resumedFrom: meta.resumedFrom, sessionId: meta.sessionId, pid: meta.pid })),
                logs,
            }, null, 2));
        }
        assert.equal(consumed.phase, "consumed");
        assert.equal(consumed.acknowledgement.disposition, "assignment-complete");
        assert.equal(store.getOperation(operationId).terminalOutcome, "succeeded");

        const claims = store.listResumeClaims({ waitId: wait.waitId, generation: wait.generation })
            .filter((claim) => claim.state === "published");
        assert.equal(claims.length, 1);
        assert.equal(claims[0].attemptId, continuation.id);

        const continuationLog = readFileSync(registry.logPathFor(continuation.id), "utf8");
        assert.match(continuationLog, /bg_task_status/);
        assert.match(continuationLog, /bg_task_log/);
        assert.match(continuationLog, /acknowledge_operation_result/);
        assert.doesNotMatch(continuationLog, /fixture decision failed/);

        const saved = findSavedConversation({
            sessionDir: parked.meta.recipe.sessionDir,
            sessionId: parked.meta.sessionId,
            expectedCwd: project,
        });
        assert.equal(saved.kind, "ok");
        const sessionText = readFileSync(saved.conversation.path, "utf8");
        assert.match(sessionText, /bg_task_spawn/);
        assert.match(sessionText, /acknowledge_operation_result/);
        assert.equal(saved.conversation.path.endsWith(`_${initialId}.jsonl`), true);

        assert.equal(existsSync(traceFile), true, "the offline child model recorded its own trace");
        const trace = readFileSync(traceFile, "utf8")
            .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
        assert.ok(trace.some((event) => event.mode === "park" && event.step === "wait"));
        assert.ok(trace.some((event) => event.mode === "resume" && event.step === "ack"));

        // No duplicate continuation after the wait is consumed.
        await sleep(1_500);
        assert.equal(successors().length, 1, "exactly one continuation attempt");
        assert.equal(store.listResumeClaims({ waitId: wait.waitId, generation: wait.generation })
            .filter((claim) => claim.state === "published").length, 1);
        assert.deepEqual(host.errors, []);
    } finally {
        try { writeFileSync(releaseFile, "cleanup\n"); } catch { /* ignore */ }
        try { writeFileSync(ackGate, "cleanup\n"); } catch { /* ignore */ }
        if (host?.session) {
            for (const id of ownedRunIds) {
                try { await callSessionTool(host.session, "subagent_stop", { id }); } catch { /* already gone */ }
            }
        }
        try { store?.close(); } catch { /* already closed */ }
        try { await host?.session?.abort?.(); } catch { /* already idle */ }
        try { await host?.session?._extensionRunner?.emit({ type: "session_shutdown" }); } catch { /* already shut down */ }
        try { host?.session.dispose(); } catch { /* already disposed */ }
        if (host) {
            if (host.previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = host.previousAgentDir;
            if (host.previousParentTrace === undefined) delete process.env.ACCEPTANCE_PARENT_TRACE;
            else process.env.ACCEPTANCE_PARENT_TRACE = host.previousParentTrace;
        }
        const restore = (key, value) => {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        };
        restore("ACCEPTANCE_PROJECT", previous.project);
        restore("ACCEPTANCE_RELEASE_FILE", previous.release);
        restore("ACCEPTANCE_RESUME_GATE", previous.gate);
        restore("ACCEPTANCE_RESUME_ACK_GATE", previous.ackGate);
        restore("ACCEPTANCE_CHILD_TRACE", previous.trace);
        restore("ACCEPTANCE_WORKER_TOOLS", previous.tools);
        restore("ACCEPTANCE_CHILD_MODEL", previous.model);
    }
});

test("cancelling a parked assignment after the production continuation CLI is published stops the held real child and never acknowledges", { timeout: 300_000 }, async () => {
    const project = support.tempDirectory("acceptance-cli-cancel-project");
    const releaseFile = join(project, "task-release");
    const ackGate = join(project, "resume-ack-gate");
    const traceFile = join(project, "child-trace.jsonl");
    const previous = {
        project: process.env.ACCEPTANCE_PROJECT,
        release: process.env.ACCEPTANCE_RELEASE_FILE,
        gate: process.env.ACCEPTANCE_RESUME_GATE,
        ackGate: process.env.ACCEPTANCE_RESUME_ACK_GATE,
        trace: process.env.ACCEPTANCE_CHILD_TRACE,
        tools: process.env.ACCEPTANCE_WORKER_TOOLS,
        model: process.env.ACCEPTANCE_CHILD_MODEL,
    };
    process.env.ACCEPTANCE_PROJECT = project;
    process.env.ACCEPTANCE_RELEASE_FILE = releaseFile;
    delete process.env.ACCEPTANCE_RESUME_GATE;
    process.env.ACCEPTANCE_RESUME_ACK_GATE = ackGate;
    process.env.ACCEPTANCE_CHILD_TRACE = traceFile;
    process.env.ACCEPTANCE_WORKER_TOOLS = [
        "read", "bash", "acceptance_offline_model",
        "bg_task_spawn", "bg_task_status", "bg_task_log",
        "wait_for_operations", "acknowledge_operation_result",
    ].join(",");
    process.env.ACCEPTANCE_CHILD_MODEL = "acceptance-offline/offline";

    let host;
    let store;
    const ownedRunIds = [];
    try {
        host = await openProductionParent(project);
        await host.session.prompt("launch the production CLI worker now");
        await host.session.waitForIdle();
        const spawnResult = host.session.sessionManager.getEntries()
            .filter((entry) => entry.type === "message")
            .map((entry) => entry.message)
            .find((message) => message.role === "toolResult" && message.toolName === "subagent_spawn");
        assert.ok(spawnResult, "the parent model's subagent_spawn tool call returned a result");
        const spawnText = messageText(spawnResult);
        const initialId = /id=(sa_[A-Za-z0-9_]+)/.exec(spawnText)?.[1];
        assert.ok(initialId, `subagent_spawn did not report a run id:\n${spawnText}`);
        ownedRunIds.push(initialId);

        const parked = await waitUntil(() => {
            const meta = registry.readMeta(initialId);
            const record = registry.readParkRecord(initialId);
            if (meta?.status === "completed" && record && (record.phase === "waiting" || record.phase === "ready")) {
                return { meta, record };
            }
            return undefined;
        }, "the real CLI worker to park", 120_000);
        assert.ok(parked.record.checkpoint?.entryId, "the parent registered a native checkpoint");
        assert.ok(parked.meta.park, "the parent recorded the park disposition");
        assert.equal(registryCapacity([initialId]).countRunning(), 0, "the parked CLI attempt released its capacity slot");

        store = openStore({ path: host.storePath });
        const wait = await waitUntil(() => store.listWaits().find((entry) =>
            entry.owner.kind === "worker-conversation"
            && entry.owner.sessionId === parked.meta.sessionId
            && entry.owner.workspace === project), "the worker wait", 30_000);
        assert.ok(wait.phase === "waiting" || wait.phase === "ready");
        const operation = store.getOperation(wait.dependencies[0].operationId);
        assert.equal(operation.terminalRevision, 0, "the task is still gated and running");

        writeFileSync(releaseFile, "release\n");

        const successors = () => registry.listMetasForParent(process.pid)
            .filter((meta) => meta.resumedFrom === initialId)
            .map((meta) => registry.readMeta(meta.id))
            .filter((meta) => meta !== undefined);
        const running = await waitUntil(() => {
            const found = successors();
            if (found.length !== 1) return undefined;
            const current = store.getWait({ waitId: wait.waitId, generation: wait.generation });
            const claims = store.listResumeClaims({ waitId: wait.waitId, generation: wait.generation })
                .filter((claim) => claim.state === "published");
            if (current?.phase !== "resuming" || claims.length !== 1) return undefined;
            return { meta: found[0], claim: claims[0], wait: current };
        }, "the production continuation claim and real CLI child", 120_000);
        assert.equal(running.meta.status, "running");
        assert.equal(running.claim.attemptId, running.meta.id);
        assert.equal(running.claim.launchToken, running.meta.operations?.resumeLaunchToken);
        assert.equal(processExists(running.meta.pid), true, "the gated continuation CLI child is alive");

        // It reopened the SAME saved conversation and inspected the terminal
        // evidence through the real bridge, then stopped at the ack gate.
        const heldLog = await waitUntil(() => {
            const text = readFileSync(registry.logPathFor(running.meta.id), "utf8");
            return text.includes("bg_task_status") && text.includes("bg_task_log") ? text : undefined;
        }, "the continuation CLI to read status and log evidence", 30_000);
        assert.doesNotMatch(heldLog, /"toolName":"acknowledge_operation_result"/, "the held child has not acknowledged anything");
        const heldTrace = readFileSync(traceFile, "utf8");
        assert.match(heldTrace, /"step":"status-log"/);
        assert.doesNotMatch(heldTrace, /"step":"ack"/, "the ack was still gated");
        assert.equal(store.getWait({ waitId: wait.waitId, generation: wait.generation }).phase, "resuming");

        // The explicit parked-assignment takeover. Production must follow the
        // published claim and stop the real child. Assignment cancellation leaves
        // the unacknowledged dependency held, with dispatch atomically disarmed.
        const stopped = await callSessionTool(host.session, "subagent_stop", { id: initialId });
        assert.match(stopped, /Durably cancelled the pending wait of parked subagent/);

        await waitUntil(() => {
            return store.getAssignmentOutcome(parked.meta.assignment.assignmentId)?.outcome === "cancelled";
        }, "the durable assignment cancellation", 30_000);
        const outcome = store.getAssignmentOutcome(parked.meta.assignment.assignmentId);
        assert.equal(outcome.processUncertain, true, "recording cancellation does not prove writer termination");
        assert.equal(outcome.recipient.sessionId, host.session.sessionManager.getSessionId());
        const cancelled = store.getWait({ waitId: wait.waitId, generation: wait.generation });
        assert.equal(cancelled.phase, "held");
        assert.equal(cancelled.acknowledgement, null, "a cancelled wait is never acknowledged");
        assert.throws(() => store.transitionWaitPhase({ waitId: wait.waitId, generation: wait.generation, from: "held", to: "ready" }), /terminal outcome/);
        const parkAfter = registry.readParkRecord(initialId);
        assert.equal(parkAfter?.phase, "cancelled");
        assert.match(parkAfter?.cancelReason ?? "", /published continuation .* was stopped|automatic resume is cancelled/);

        const stoppedAttempt = await waitUntil(() => {
            const found = successors();
            if (found.length !== 1) return undefined;
            return found[0].status !== "running" && found[0].status !== "orphaned" && found[0].status !== "lost"
                ? found[0] : undefined;
        }, "the published continuation attempt to stop", 30_000);
        await waitUntil(() => !processExists(stoppedAttempt.pid), "the stopped continuation child to exit", 20_000);
        const stoppedLog = readFileSync(registry.logPathFor(stoppedAttempt.id), "utf8");
        assert.doesNotMatch(stoppedLog, /"toolName":"acknowledge_operation_result"/, "the stopped child never acknowledged");
        await waitUntil(() => store.listResumeClaims({ waitId: wait.waitId, generation: wait.generation })
            .every((claim) => claim.state !== "published"), "the proven-exit writer fence to reconcile", 20_000);
        await callSessionTool(host.session, "subagent_result", { id: initialId, operation_id: operation.operationId });
        assert.ok(store.listEvidencePins({ waitId: outcome.eventId, generation: 1 }).length > 0, "inspection retains outcome evidence");
        const claimsBeforeConsumption = store.listResumeClaims({ waitId: wait.waitId, generation: wait.generation });
        await callSessionTool(host.session, "subagent_result", { id: initialId, outcome_revision: outcome.revision, disposition: "consumed", note: "Inspected cancellation and dependency evidence after explicit stop." });
        assert.equal(store.listEvidencePins({ waitId: outcome.eventId, generation: 1 }).length, 0);
        assert.equal(store.getWait({ waitId: wait.waitId, generation: wait.generation }).acknowledgement, null);
        assert.deepEqual(store.listResumeClaims({ waitId: wait.waitId, generation: wait.generation }), claimsBeforeConsumption, "parent consumption does not resolve writer fences");

        // Releasing the fixture gate afterwards cannot resurrect the cancelled
        // generation or start a duplicate continuation.
        writeFileSync(ackGate, "release\n");
        await sleep(1_500);
        assert.equal(successors().length, 1, "no second continuation is launched");
        assert.equal(store.getWait({ waitId: wait.waitId, generation: wait.generation }).phase, "held");
        assert.equal(store.getAssignmentOutcome(parked.meta.assignment.assignmentId).outcome, "cancelled");
        const claimsAfterCancel = store.listResumeClaims({ waitId: wait.waitId, generation: wait.generation });
        assert.equal(claimsAfterCancel.length, 1, "the cancelled generation never gets a second claim");
        assert.equal(claimsAfterCancel.filter((claim) => claim.state === "claimed" || claim.state === "published").length, 0,
            "independent exit and lease proof invalidates the published resume claim");
        assert.equal(claimsAfterCancel[0].state, "invalidated");
        assert.equal(registryCapacity([initialId, stoppedAttempt.id]).countRunning(), 0, "both attempts released their slots");
        assert.deepEqual(host.errors, []);
    } finally {
        try { writeFileSync(releaseFile, "cleanup\n"); } catch { /* ignore */ }
        try { writeFileSync(ackGate, "cleanup\n"); } catch { /* ignore */ }
        if (host?.session) {
            for (const id of ownedRunIds) {
                try { await callSessionTool(host.session, "subagent_stop", { id }); } catch { /* already gone */ }
            }
        }
        try { store?.close(); } catch { /* already closed */ }
        try { await host?.session?.abort?.(); } catch { /* already idle */ }
        try { await host?.session?._extensionRunner?.emit({ type: "session_shutdown" }); } catch { /* already shut down */ }
        try { host?.session.dispose(); } catch { /* already disposed */ }
        if (host) {
            if (host.previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = host.previousAgentDir;
            if (host.previousParentTrace === undefined) delete process.env.ACCEPTANCE_PARENT_TRACE;
            else process.env.ACCEPTANCE_PARENT_TRACE = host.previousParentTrace;
        }
        const restore = (key, value) => {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        };
        restore("ACCEPTANCE_PROJECT", previous.project);
        restore("ACCEPTANCE_RELEASE_FILE", previous.release);
        restore("ACCEPTANCE_RESUME_GATE", previous.gate);
        restore("ACCEPTANCE_RESUME_ACK_GATE", previous.ackGate);
        restore("ACCEPTANCE_CHILD_TRACE", previous.trace);
        restore("ACCEPTANCE_WORKER_TOOLS", previous.tools);
        restore("ACCEPTANCE_CHILD_MODEL", previous.model);
    }
});
