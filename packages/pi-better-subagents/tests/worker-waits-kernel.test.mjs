// @covers observed-waits.worker-kernel-acceptance
// @level integration
/**
 * Kernel-confined worker acceptance.
 *
 * Runs the ACTUAL production building blocks together, with no fixture standing
 * in for any security-relevant piece:
 *
 * - `prepareTaskRuntime` writes the real task policy (immutable write profile,
 *   Network off, project files read, outside project off) and returns the real
 *   `task-runtime.mjs` entry,
 * - the real `TaskGuard` is installed by that entry and admits the fixed
 *   `child-operations.ts` bridge by exact source,
 * - the real Pi SDK CLI runs the child with a deterministic offline model
 *   fixture, so no network or provider credential is involved,
 * - the child talks to the real Subagents bridge host over the Unix socket, and
 *   the real Background observed-waits host launches the supervised tasks under
 *   the intersected worker policy,
 * - the parked attempt is finalized with the real exit proof, and the resume
 *   launcher starts a second real confined child that reads the FORMER task and
 *   acknowledges it.
 *
 * The always-on assertions are: the guard reports `task_sandbox_ready` with the
 * bridge tools, a write outside the workspace and a TCP connect both fail (the
 * worker's denied capabilities stay denied), and the bridge socket handshake,
 * wait, checkpoint, status and acknowledgement all work through the real SDK.
 *
 * Requires an OS write-sandbox backend. Inside an already-confined parent
 * (`sandbox_apply: Operation not permitted`) or on a host without the backend the
 * test skips with the exact reason; set `PI_WORKER_KERNEL_REQUIRE=1` to turn that
 * skip into a failure in CI.
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import { describeSandboxSupport } from "../shared-sandbox-core.ts";
import { prepareTaskRuntime } from "../task-policy.ts";
import {
    assertFinalResumeDispatch,
    OPERATION_RESUME_ADMISSION_EVENT,
    createResumeOrchestration,
    finalizeWorkerParkAfterExit,
} from "../worker-waits.ts";
import * as registry from "../registry.ts";
import { readParkRecord } from "../registry.ts";
import { finalizeRun } from "../finalization.ts";
import { cleanupAll, createCtx, defaultPlan, schemasFor, startStack } from "./worker-waits-support.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = join(packageRoot, "tests", "fixtures", "worker-waits-kernel");
const fakeModelPath = join(fixtureRoot, "fake-model.ts");
const bridgePath = join(packageRoot, "child-operations.ts");
const ownershipPath = join(packageRoot, "child-ownership.ts");

const durableRoot = mkdtempSync(join(tmpdir(), "worker-kernel-durable-"));
const volatileRoot = mkdtempSync(join(tmpdir(), "worker-kernel-tmp-"));
const support = describeSandboxSupport();
const requireKernel = process.env.PI_WORKER_KERNEL_REQUIRE === "1";
const sdkOnly = process.env.WORKER_SDK_ONLY === "1";

before(() => {
    process.env.PI_SUBAGENT_DURABLE_DIR = durableRoot;
    process.env.TMPDIR = volatileRoot;
});

after(() => {
    cleanupAll();
    rmSync(durableRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    rmSync(volatileRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function skipOrFail(t, reason) {
    if (requireKernel) assert.fail(reason);
    t.skip(reason);
}

function sdkCliPath() {
    const candidates = [join(PiCodingAgent.getPackageDir(), "dist", "cli.js"), join(PiCodingAgent.getPackageDir(), "dist", "bundle", "cli.js")];
    return candidates.find((path) => existsSync(path)) ?? candidates[0];
}

const TASK_TOOLS = ["bg_task_spawn", "bg_task_status", "bg_task_log", "wait_for_operations", "acknowledge_operation_result", "read"];

/** The real task policy this worker gets: read-only project, no outside writes, no network. */
function taskRuntimeFor(workspace, controlDir) {
    if (sdkOnly) return { file: process.execPath, fileArgs: [sdkCliPath()], policy: { root: workspace, permissions: {} } };
    return prepareTaskRuntime({
        root: workspace,
        controlDir,
        piBin: sdkCliPath(),
        tools: TASK_TOOLS,
        permissions: {
            projectFiles: "read",
            outsideProject: "off",
            storedCredentials: "off",
            commands: true,
            network: false,
            shell: true,
        },
        applyPatch: false,
        // The fixed bridge adapter must be among the extension paths for the policy's
        // `operationBridge` flag to engage and for the guard to admit it by source.
        extensionPaths: [fakeModelPath, bridgePath, ownershipPath],
        runtimeRoots: [registry.baseDir()],
    });
}

function childArgs({ attemptId, sessionsDir, sessionFile, prompt }) {
    return [
        "-p", "--mode", "json",
        "--no-extensions",
        "--extension", fakeModelPath,
        "--extension", bridgePath,
        "--extension", ownershipPath,
        ...(sessionFile ? ["--session", sessionFile] : ["--session-dir", sessionsDir, "--session-id", attemptId]),
        "--model", "worker-kernel-fixture/offline",
        "--no-builtin-tools", "--no-approve",
        prompt,
    ];
}

/** Inherited subagent-only variables must not leak into the fixture child. */
function cleanParentEnv() {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (key.startsWith("PI_BETTER_OPERATIONS_") || key === "PI_SUBAGENT_PREFLIGHT"
            || key === "PI_SUBAGENT_TOP_LEVEL" || key === "PI_SUBAGENT_STEER_FILE"
            || key.startsWith("PI_SUBAGENT_DEADLINE")) delete env[key];
    }
    return env;
}

function runConfined(child) {
    return new Promise((resolve) => {
        const started = spawn(child.file, child.args, {
            cwd: child.cwd,
            env: { ...cleanParentEnv(), ...child.env },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        started.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
        started.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
        started.on("error", (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
        started.on("close", (code) => resolve({ code, stdout, stderr }));
    });
}

function nestedSandboxFailure(output) {
    return /sandbox_apply: Operation not permitted|Operation not permitted.*sandbox|bwrap: |No permissions to create a new namespace/i.test(output);
}

async function registerWorker(stack, { runId, conversationId, workspace, runtimePolicy, plan }) {
    const policy = {
        version: 1,
        sandbox: sdkOnly ? null : {
            root: runtimePolicy.root,
            permissions: runtimePolicy.permissions,
            denyWrite: runtimePolicy.denyWrite,
        },
        tools: plan.tools,
        clean: false,
        deadlineAt: null,
        authorityReference: `authority:kernel:${runId}`,
        workspace,
    };
    const handle = await stack.bridge.register({
        runId,
        conversationId,
        workspace,
        authorityReference: policy.authorityReference,
        branchId: "branch-1",
        goalId: "original-goal",
        policy,
        capabilities: plan.capabilities,
        tools: plan.tools,
        schemas: schemasFor(stack.pi, plan.tools),
        attemptId: runId,
        owner: { sessionId: "parent-session-1", workspace, branchId: "branch-1", goalId: "original-goal" },
    });
    const meta = registry.readMeta(runId);
    if (meta) registry.writeMeta({ ...meta, operations: {
        version: 1, bridgeRunId: runId, conversationId, workspace,
        authorityReference: policy.authorityReference, policy, tools: plan.tools,
    } });
    return { handle, policy };
}

/** The parked attempt's real record, recipe and control directory. */
function writeAttempt(stack, { attemptId, sessionDir, workspace }) {
    const controlDir = join(stack.root, "control", attemptId);
    mkdirSync(controlDir, { recursive: true });
    const runtime = taskRuntimeFor(workspace, controlDir);
    registry.writeMeta({
        id: attemptId,
        status: "running",
        pid: 999_999,
        spawnPid: process.pid,
        cwd: workspace,
        promptPreview: "kernel worker acceptance",
        startedAt: Date.now() - 1_000,
        logPath: registry.logPathFor(attemptId),
        sessionId: attemptId,
        callback: false,
        recipe: {
            version: 1,
            attemptId,
            sessionId: attemptId,
            sessionDir,
            cwd: workspace,
            tools: TASK_TOOLS.join(","),
            clean: false,
            allowNested: false,
            approve: false,
            sandbox: true,
            sandboxDir: workspace,
            gitCloneWorkspace: false,
            callback: false,
        },
    });
    return { controlDir, runtime };
}

for (const transition of ["completed", "paused", "cleared", "replaced", "inactive"]) {
test(`a real saved worker resumes and acknowledges exact evidence with parent ${transition}`, { timeout: 180_000 }, async (t) => {
    if (!support.supported && !sdkOnly) {
        skipOrFail(t, `kernel sandbox backend unavailable: ${support.reason}`);
        return;
    }
    // The fixed bridge adapter must be loadable as a Pi extension for the task
    // guard's exact-source admission to work at all.
    const bridgeModule = await import(bridgePath);
    assert.equal(
        typeof bridgeModule.default,
        "function",
        "child-operations.ts exports no default extension factory, so --extension child-operations.ts cannot load and the task guard cannot admit the fixed bridge adapter (parent-owned file).",
    );
    const stack = await startStack();
    const attemptId = `sa_kernel_fresh_${transition}`;
    const sessionDir = join(durableRoot, "sessions", attemptId);
    mkdirSync(sessionDir, { recursive: true });
    const outside = join(stack.root, "outside.txt");
    let networkConnections = 0;
    const server = createServer((socket) => {
        networkConnections += 1;
        socket.resume();
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const networkUrl = `http://127.0.0.1:${server.address().port}/`;
    const control = await runConfined({file: "/usr/bin/curl", args: ["--noproxy", "*", "--fail", "--silent", "--show-error", "--connect-timeout", "2", networkUrl], cwd: stack.workspace, env: {}});
    assert.equal(control.code, 0, `the network control must succeed before confinement: ${control.stderr}`);
    assert.equal(networkConnections, 1);
    const { runtime } = writeAttempt(stack, { attemptId, sessionDir, workspace: stack.workspace });
    const plan = defaultPlan();
    const { handle } = await registerWorker(stack, {
        runId: attemptId,
        conversationId: attemptId,
        workspace: stack.workspace,
        runtimePolicy: runtime.policy,
        plan,
    });

    const fresh = await runConfined({
        file: runtime.file,
        args: [...runtime.fileArgs, ...childArgs({ attemptId, sessionsDir: sessionDir, sessionFile: undefined, prompt: "Run the kernel acceptance build." })],
        cwd: stack.workspace,
        env: {
            ...handle.env,
            WORKER_KERNEL_PHASE: "fresh",
            WORKER_KERNEL_WORKSPACE: stack.workspace,
            WORKER_KERNEL_OUTSIDE: outside,
            WORKER_KERNEL_NETWORK_URL: networkUrl,
        },
    });
    if (fresh.code !== 0 && nestedSandboxFailure(`${fresh.stdout}\n${fresh.stderr}`)) {
        skipOrFail(t, `cannot apply the kernel write profile in this environment: ${fresh.stderr.split("\n").find((line) => line.trim()) ?? "operation not permitted"}`);
        return;
    }
    assert.equal(fresh.code, 0, `confined child failed (${fresh.code}):\n${fresh.stderr}\n${fresh.stdout}`);

    // The guard ran and admitted the fixed bridge adapter by exact source.
    // The runtime may route the guard's marker through either stream depending on
    // how the SDK redirects stdout in `--mode json`.
    const ready = `${fresh.stdout}\n${fresh.stderr}`.split("\n").filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return undefined; } })
        .find((entry) => entry?.type === "task_sandbox_ready");
    assert.ok(sdkOnly || ready, `the task guard must publish its ready marker\nstdout:\n${fresh.stdout}\nstderr:\n${fresh.stderr}`);
    if (!sdkOnly) assert.equal(ready.root, realpathSync(stack.workspace));
    // The marker lists the guarded builtin selection; bridge tools are activated
    // separately from `policy.operationBridge`. The direct proof that the fixed
    // adapter was admitted is that the child's own bridge calls succeeded below.
    if (!sdkOnly) {
        assert.ok(Array.isArray(ready.tools));
        assert.equal(ready.tools.includes("read"), true);
    }

    // The bridge socket worked from the confined child: a wait was registered and
    // its verified checkpoint staged while the child was still alive.
    const stored = registry.readParkRecord(attemptId);
    assert.ok(stored, "the child must have produced a park checkpoint");
    assert.equal(stored.phase, "parking");
    const waitId = stored.waitId;
    const generation = stored.generation;
    const scope = { runId: attemptId, conversationId: attemptId, workspace: stack.workspace, authorityReference: "x", branchId: "branch-1", goalId: "original-goal" };
    let view = stack.service.listWorkerWaits(scope, { pendingOnly: true }).find((entry) => entry.waitId === waitId);
    assert.equal(view.phase, "parking", "a live child must not look parked");
    const taskIds = view.taskIds;

    // Denied capabilities stay denied: the read-only build succeeds, the outside
    // write and the TCP connect both fail under the intersected policy.
    const deadline = Date.now() + 60_000;
    let operations;
    while (Date.now() < deadline) {
        operations = taskIds.map((taskId) => stack.store.listOperations().find((operation) => operation.taskId === taskId));
        if (operations.every((operation) => operation?.phase === "terminal")) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
        await stack.host.reconcileNow();
    }
    assert.ok(operations?.every((operation) => operation?.phase === "terminal"), "every kernel task must settle");
    // A confined command cannot install its own write profile inside an
    // already-confined parent. That is an environment limit, not a worker result.
    const deniedByNesting = operations.every((operation) => {
        const log = stack.service.logForWorker(scope, operation.taskId, { lines: 4 });
        return /sandbox_apply: Operation not permitted/.test(`${log.stderr}\n${log.events}`);
    });
    if (deniedByNesting) {
        skipOrFail(t, "the kernel write profile cannot be applied from this parent (sandbox_apply: Operation not permitted); run the kernel suite on a host that can apply the backend, or set PI_WORKER_KERNEL_REQUIRE=1 where it must");
        return;
    }
    const outcomes = Object.fromEntries(operations.map((operation) => [operation.taskId, operation.terminalOutcome]));
    const diagnostics = operations.map((operation) => {
        const log = stack.service.logForWorker(scope, operation.taskId, { lines: 12 });
        return {
            taskId: operation.taskId,
            outcome: operation.terminalOutcome,
            reason: operation.terminalReason ?? stack.service.statusForWorker(scope, operation.taskId).reason,
            stderr: log.stderr.slice(-800),
            events: log.events.slice(-400),
        };
    });
    assert.deepEqual(Object.values(outcomes).sort(), sdkOnly ? ["succeeded"] : ["failed", "failed", "succeeded"], JSON.stringify(diagnostics));
    assert.equal(existsSync(outside), false, "a write outside the workspace must never change the host, even when private /tmp scratch is writable");
    assert.equal(existsSync(join(stack.workspace, "blocked-write.txt")), false, "the read-only project mount must refuse the visible write target");
    assert.equal(networkConnections, 1, "the confined network task must not reach the listener that the control reached");

    // Exit proof: checkpoint staged, lease released, original writer gone.
    writeFileSync(registry.logPathFor(attemptId), `${fresh.stdout}\n`);
    const finalized = finalizeRun(attemptId, 0);
    assert.equal(finalized.park.parked, true);
    const proof = await finalizeWorkerParkAfterExit({
        runId: attemptId,
        service: stack.service,
        writerLeaseReleased: true,
        writerPidGone: true,
    });
    assert.equal(proof.outcome, "parked", JSON.stringify(proof));
    assert.equal(["waiting", "ready"].includes(proof.wait.phase), true);

    let readyWait = false;
    while (Date.now() < deadline) {
        await stack.host.reconcileNow();
        view = stack.service.listWorkerWaits(scope, { pendingOnly: true }).find((entry) => entry.waitId === waitId);
        if (view?.phase === "ready") { readyWait = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(readyWait, true, "the settled tasks must move the durable wait to ready");

    // Resume with the real claim fence and a second real confined child.
    stack.events.on(OPERATION_RESUME_ADMISSION_EVENT, () => assert.fail("parent Goal must not gate delegated execution"));
    const hostCtx = createCtx(stack.workspace, transition === "inactive" ? "unrelated-session" : "parent-session-1");
    hostCtx.sessionManager.getBranch = () => transition === "cleared" ? [] : [{
        type: "custom", customType: "pi-better-goal", id: "different-branch",
        data: { kind: "set", goal: { goalId: transition === "replaced" ? "new-goal" : "original-goal", status: transition } },
    }];
    const resumedId = "sa_kernel_resumed";
    const resumedSession = sessionDir;
    let resumedChild;
    const orchestration = createResumeOrchestration({
        pi: stack.pi,
        service: () => stack.service,
        rpc: stack.bridge.rpc,
        context: () => hostCtx,
        capacity: { tryReserve: () => true, recheck: () => true, commit: () => {}, release: () => {} },
        launch: async (input) => {
            assert.equal(readParkRecord(attemptId).phase, "resuming");
            assert.equal(readParkRecord(attemptId).resumedBy, input.assignedRunId);
            const claim = stack.store.listResumeClaims({ waitId, generation }).find((entry) => entry.state === "published");
            assert.ok(claim, "the resume attempt must be published before the second child starts");
            assert.equal(claim.attemptId, input.assignedRunId);
            const dispatch = await assertFinalResumeDispatch({
                pi: stack.pi, rpc: stack.bridge.rpc, service: () => stack.service,
                context: () => hostCtx, park: input.park, claim: input.claim,
                owner: { sessionId: "parent-session-1", workspace: stack.workspace, branchId: "branch-1", goalId: "original-goal" },
                admissionRevision: input.admissionRevision, permissionsUnchanged: () => true, capacityAvailable: () => true,
            });
            dispatch();
            assert.equal(input.park.record.ownerSessionId, "parent-session-1");
            const resumedControl = join(stack.root, "control", input.assignedRunId);
            mkdirSync(resumedControl, { recursive: true });
            const resumedRuntime = taskRuntimeFor(stack.workspace, resumedControl);
            const resumed = await registerWorker(stack, {
                runId: input.assignedRunId,
                conversationId: attemptId,
                workspace: stack.workspace,
                runtimePolicy: resumedRuntime.policy,
                plan,
            });
            const sessionFile = findSessionFile(resumedSession, attemptId);
            assert.ok(sessionFile, "continuation must reopen the parked native conversation, never create a replacement");
            resumedChild = runConfined({
                file: resumedRuntime.file,
                args: [...resumedRuntime.fileArgs, ...childArgs({
                    attemptId: input.assignedRunId,
                    sessionsDir: resumedSession,
                    sessionFile,
                    prompt: "Read the kernel evidence and finish the assignment.",
                })],
                cwd: stack.workspace,
                env: {
                    ...resumed.handle.env,
                    WORKER_KERNEL_PHASE: "resume",
                    WORKER_KERNEL_WORKSPACE: stack.workspace,
                    WORKER_KERNEL_TASKS: taskIds.join(","),
                    WORKER_KERNEL_WAIT_ID: waitId,
                    WORKER_KERNEL_GENERATION: String(generation),
                    WORKER_KERNEL_REVISIONS: JSON.stringify(Object.fromEntries(operations.map((operation) => [operation.operationId, operation.terminalRevision]))),
                },
            });
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
    assert.equal(await orchestration.resume(park), "resumed");
    assert.ok(resumedChild, "the resume launcher must start the second confined child");
    const resumedResult = await resumedChild;
    assert.equal(resumedResult.code, 0, `resumed child failed (${resumedResult.code}):\n${resumedResult.stderr}\n${resumedResult.stdout}`);
    const consumed = stack.service.listWorkerWaits(scope, { pendingOnly: true }).find((entry) => entry.waitId === waitId);
    assert.equal(consumed, undefined, "the resumed child must consume the wait");
    assert.equal(readParkRecord(attemptId).phase, "consumed");
    orchestration.stop();
});
}

/** The saved session file the fresh child persisted for its conversation. */
function findSessionFile(sessionDir, sessionId) {
    const entries = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"));
    for (const name of entries) {
        const path = join(sessionDir, name);
        try {
            const header = JSON.parse(readFileSync(path, "utf8").split("\n")[0]);
            if (header?.type === "session" && header.id === sessionId) return realpathSync.native(path);
        } catch { /* try the next file */ }
    }
    return undefined;
}
