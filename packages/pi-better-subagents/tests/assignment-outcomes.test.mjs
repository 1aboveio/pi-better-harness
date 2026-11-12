import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "node:module";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
register(new URL("./pi_host_stub_hooks.mjs", import.meta.url));
const { default: extension } = await import("../index.ts");
const { getCallbackBatcher } = await import("../shared-callback-batcher.ts");
const { finalizeRun } = await import("../finalization.ts");
const { writeMeta, readMeta, runDir, logPathFor, removeRunDirectory } = await import("../registry.ts");
const { registerAssignmentAttempt, coordinatorPath, readOutcome } = await import("../assignment-outcomes.ts");
const { commitAssignmentTerminal, outcomeTranscriptReceipt } = await import("../assignment-outcomes.ts");
const { assignmentFor } = await import("../assignment-projection.mjs");
const { openStore } = await import("../shared-operation-coordinator/index.ts");
const { createObservedWaitHost } = await import("../../pi-better-background-tasks/src/observed-waits.ts");
const { retainObservation, pendingObservations } = await import("../outage-observations.ts");
const { reconcileParkedWaits } = await import("../worker-waits.ts");

function host(sessionId = "parent", options = {}) {
    const tools = new Map(), handlers = new Map(), entries = options.entries ?? [], sent = [];
    const events = new EventEmitter();
    if (!options.noGoal) events.on("pi-better-goal:operation-resume-admission", (request) => request.reply({ allowed: options.allowed !== false, revision: 1, isCurrent: () => options.allowed !== false }));
    const pi = { events, registerTool: (tool) => tools.set(tool.name, tool), on: (name, fn) => handlers.set(name, fn),
        sendMessage: (message, sendOptions) => {
            sent.push({ message, options: sendOptions });
            entries.push({ id: `entry-${entries.length}`, type: "message", message: { role: "custom", ...message } });
        } };
    const ctx = { cwd: process.cwd(), isIdle: () => true, hasUI: false,
        ui: { notify() {}, setWidget() {} }, sessionManager: { getSessionId: () => sessionId, getBranch: () => entries } };
    extension(pi);
    return { pi, ctx, entries, sent, tools, handlers, async start() { await handlers.get("session_start")?.({}, ctx); await new Promise((resolve) => setImmediate(resolve)); }, async close() { await handlers.get("session_shutdown")?.({ reason: "reload" }, ctx); } };
}

function failedAssignment(id, branchId = null) {
    const owner = { kind: "worker-conversation", sessionId: `conversation-${id}`, workspace: process.cwd(), branchId, goalId: null };
    const recipient = { kind: "parent-session", sessionId: "parent", workspace: process.cwd(), branchId, goalId: null };
    const binding = { version: 1, assignmentId: id, owner, recipient };
    registerAssignmentAttempt(binding, id);
    mkdirSync(runDir(id), { recursive: true });
    writeFileSync(logPathFor(id), "");
    const dependencyLog = join(runDir(id), "dependency.log");
    writeFileSync(dependencyLog, "retained failed-test evidence\n");
    const store = openStore({ path: coordinatorPath() });
    store.registerOperation({ operationId: `op-${id}`, taskId: `task-${id}`, launchToken: `launch-${id}`, owner, observer: { kind: "test", version: "1" } });
    store.recordTerminalOutcome({ operationId: `op-${id}`, eventId: `terminal-${id}`, owner, outcome: "failed", evidence: [{ kind: "log", ref: dependencyLog }], reason: "Tests failed" });
    const { wait } = store.registerWait({ owner, dependencies: [{ operationId: `op-${id}` }], continuationNote: "Interpret failed tests", origin: { assignmentRef: id, attemptId: id } });
    const { claim } = store.claimResume({ waitId: wait.waitId, generation: 1, expectedCancelEpoch: 0, lease: { ownerId: "uncertain-writer" }, reservedCheckpointId: "checkpoint" });
    store.publishResumeAttempt({ waitId: wait.waitId, generation: 1, claimId: claim.claimId, claimToken: claim.claimToken, attemptId: `resumed-${id}`, launchToken: "writer-token" });
    writeMeta({ id, name: id, assignment: binding, status: "running", pid: 4194304, spawnPid: process.pid, cwd: process.cwd(), promptPreview: "work", startedAt: Date.now() - 100, sessionId: owner.sessionId, logPath: logPathFor(id), callbackOrigin: { cwd: process.cwd(), sessionId: "parent" }, callback: true });
    finalizeRun(id, 1);
    return { store, wait, meta: readMeta(id), operationId: `op-${id}` };
}

test("ordinary failure uses actual finalizer, callback batcher and result acknowledgement without consuming worker interpretation", async () => {
    const { store, wait, meta, operationId } = failedAssignment("ordinary-outcome");
    const outcome = readOutcome(meta);
    assert.equal(outcome.outcome, "failed");
    assert.equal(store.getWait(wait).phase, "held");
    assert.equal(store.getWait(wait).acknowledgement, null);
    assert.equal(store.listResumeClaims({ waitId: wait.waitId })[0].state, "published");
    assert.throws(() => removeRunDirectory(meta.id), /retains this run/);
    assert.throws(() => store.transitionWaitPhase({ ...wait, from: "held", to: "ready" }), /terminal outcome/);
    const h = host();
    try {
        await h.start();
        await getCallbackBatcher(h.pi).flush();
        assert.equal(h.sent.length, 1);
        assert.match(h.sent[0].message.content, new RegExp(outcome.eventId));
        assert.equal(readOutcome(meta).deliveryReceipt.entryId, "entry-0");
        const result = await h.tools.get("subagent_result").execute("inspect", { id: meta.id, operation_id: operationId }, undefined, undefined, h.ctx);
        assert.match(result.details.outcome.logs[0].text, /retained failed-test/);
        assert.match(result.content[0].text, /retained failed-test/);
        assert.equal(result.details.assignment.state, "failed");
        assert.equal(store.getWait(wait).acknowledgement, null);
        assert.ok(store.listEvidencePins({ waitId: outcome.eventId, generation: 1 }).length);
        await h.tools.get("subagent_result").execute("consume", { id: meta.id, outcome_revision: 1, disposition: "consumed", note: "Inspected evidence; return diagnosis to requester" }, undefined, undefined, h.ctx);
        assert.equal(store.listEvidencePins({ waitId: outcome.eventId, generation: 1 }).length, 0);
        assert.equal(store.getWait(wait).acknowledgement, null);
        assert.equal(store.listResumeClaims({ waitId: wait.waitId })[0].state, "published");
        assert.throws(() => removeRunDirectory(meta.id), /retains this run/);
    } finally { await h.close(); store.close(); }
});

test("quoted outcome text is not a recipient receipt", () => {
    assert.equal(outcomeTranscriptReceipt([{ id: "quote", type: "message", message: { role: "custom", customType: "background-completion-batch", content: "[outcome:quoted-event]" } }], "quoted-event"), null);
});

test("terminal commit before outage report receipt replays once and delivery retains pins until exact consumption", async () => {
    const { store, wait, meta, operationId } = failedAssignment("outage-delivery");
    const outcome = readOutcome(meta);
    const claim = store.listResumeClaims({ waitId: wait.waitId })[0];
    const report = retainObservation(meta, { version: 1, waitId: wait.waitId, generation: 1,
        attemptId: meta.id, phase: "resuming", resumedBy: claim.attemptId,
        resumeClaimId: claim.claimId, resumeClaimToken: claim.claimToken, resumeLaunchToken: claim.launchToken,
        parkedAt: 1, updatedAt: 1 });
    const inactive = host("unrelated");
    const background = createObservedWaitHost(inactive.pi, { storePath: coordinatorPath(),
        supervisorDirectory: join(process.env.TMPDIR, "outage-delivery-supervisor"), pollMs: 0 });
    try {
        background.start(inactive.ctx);
        for (let replay = 0; replay < 2; replay++) await reconcileParkedWaits(background.service,
            { resume: async () => assert.fail("terminal outcome cannot launch") });
        assert.equal(pendingObservations().some((entry) => entry.id === report.id), false);
        assert.equal(readOutcome(meta).eventId, outcome.eventId);
        await inactive.start(); await getCallbackBatcher(inactive.pi).flush();
        assert.equal(inactive.sent.length, 0);
    } finally { background.close(); await inactive.close(); }
    const parent = host();
    try {
        await parent.start(); await getCallbackBatcher(parent.pi).flush();
        assert.equal(parent.sent.length, 1);
        assert.ok(store.listEvidencePins({ waitId: outcome.eventId, generation: 1 }).length);
        await parent.tools.get("subagent_result").execute("inspect", { id: meta.id, operation_id: operationId }, undefined, undefined, parent.ctx);
        await parent.tools.get("subagent_result").execute("consume", { id: meta.id, outcome_revision: 1, disposition: "consumed", note: "Inspected retained outage evidence" }, undefined, undefined, parent.ctx);
        assert.equal(store.listEvidencePins({ waitId: outcome.eventId, generation: 1 }).length, 0);
        assert.equal(store.getWait(wait).acknowledgement, null);
        assert.equal(store.listResumeClaims({ waitId: wait.waitId })[0].state, "published");
    } finally { await parent.close(); store.close(); }
});

test("same-session different branch cannot receive or inspect the outcome", async () => {
    const { store, meta } = failedAssignment("branch-outcome", "captured-branch");
    const wrong = host("parent", { entries: [{ id: "other-branch", type: "custom", customType: "anchor" }] });
    try {
        await wrong.start(); await getCallbackBatcher(wrong.pi).flush();
        assert.equal(wrong.sent.length, 0);
        await assert.rejects(() => wrong.tools.get("subagent_result").execute("foreign-branch", { id: meta.id, all: true }, undefined, undefined, wrong.ctx), /different parent/);
    } finally { await wrong.close(); }
    const right = host("parent", { entries: [{ id: "captured-branch", type: "custom", customType: "anchor" }] });
    try {
        await right.start(); await getCallbackBatcher(right.pi).flush();
        assert.equal(right.sent.length, 1);
        await right.tools.get("subagent_result").execute("inspect", { id: meta.id }, undefined, undefined, right.ctx);
    } finally { await right.close(); store.close(); }
});

test("inactive and paused parents retain outcomes; transcript replay repairs lost receipts without another model handoff", async () => {
    const { store, meta } = failedAssignment("replay-outcome");
    const wrong = host("unrelated");
    try { await wrong.start(); await getCallbackBatcher(wrong.pi).flush(); assert.equal(wrong.sent.length, 0); } finally { await wrong.close(); }
    const paused = host("parent", { allowed: false });
    try { await paused.start(); await getCallbackBatcher(paused.pi).flush(); assert.equal(paused.sent.length, 0); assert.equal(readOutcome(meta).deliveryReceipt, null); } finally { await paused.close(); }
    const eventId = readOutcome(meta).eventId;
    const entries = [{ id: "durable-handoff", type: "message", message: { role: "custom", customType: "background-completion-batch", details: { completionEventIds: [eventId] }, content: "Retained outcome delivery" } }];
    const replay = host("parent", { entries: JSON.parse(JSON.stringify(entries)) });
    try { await replay.start(); await getCallbackBatcher(replay.pi).flush(); assert.equal(replay.sent.length, 0); assert.equal(readOutcome(meta).deliveryReceipt.entryId, "durable-handoff"); } finally { await replay.close(); store.close(); }
});

test("parent reads enforce current permissions, membership and exact dispositions even with all:true", async () => {
    const { store, meta, operationId } = failedAssignment("permission-outcome");
    const wrong = host("unrelated");
    try {
        await wrong.start();
        await assert.rejects(() => wrong.tools.get("subagent_result").execute("foreign", { id: meta.id, all: true, operation_id: operationId }, undefined, undefined, wrong.ctx), /different parent/);
    } finally { await wrong.close(); }
    const h = host();
    try {
        await h.start();
        const call = (params) => h.tools.get("subagent_result").execute("read", { id: meta.id, ...params }, undefined, undefined, h.ctx);
        await getCallbackBatcher(h.pi).flush();
        await assert.rejects(() => call({ operation_id: "not-a-dependency" }), /not an assignment dependency/);
        await assert.rejects(() => call({ outcome_revision: 2 }), /revision/);
        await assert.rejects(() => call({ disposition: "consumed", note: "not inspected" }), /exact outcome_revision/);
        h.pi.events.emit("pi-better-sandbox:policy", { state: "enabled", permissions: { enabled: true, projectFiles: "off", outsideProject: "off", storedCredentials: "off", commands: true, network: false } });
        await assert.rejects(() => call({ operation_id: operationId }), /read permission/);
        assert.equal(readOutcome(meta).inspectedAt, null);
        assert.equal(readOutcome(meta).disposition, null);
    } finally { await h.close(); store.close(); }
});

test("busy parent queues a safe handoff and successful/cancelled standalone outcomes retain separate assignment identities", async () => {
    const { store, meta } = failedAssignment("busy-outcome");
    const h = host();
    try {
        h.ctx.isIdle = () => false;
        await h.start();
        getCallbackBatcher(h.pi).setForegroundRunning(true);
        await getCallbackBatcher(h.pi).flush();
        assert.equal(h.sent.length, 0);
        getCallbackBatcher(h.pi).setForegroundRunning(false);
        h.ctx.isIdle = () => true;
        await getCallbackBatcher(h.pi).flush();
        assert.equal(h.sent.length, 1);
        for (const [id, status, outcome] of [["success-outcome", "completed", "succeeded"], ["cancel-outcome", "killed", "cancelled"]]) {
            const binding = { ...meta.assignment, assignmentId: id };
            registerAssignmentAttempt(binding, id);
            mkdirSync(runDir(id), { recursive: true });
            writeFileSync(logPathFor(id), "");
            let next = { ...meta, id, assignment: binding, status, logPath: logPathFor(id), park: undefined, exitCode: status === "completed" ? 0 : undefined, signal: status === "killed" ? "SIGTERM" : undefined };
            writeMeta(next);
            if (status === "completed") {
                writeFileSync(logPathFor(id), `${JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: "Assigned work complete" }] })}\n`);
                writeMeta({ ...next, status: "running" });
                finalizeRun(id, 0);
                next = readMeta(id);
            }
            assert.equal(commitAssignmentTerminal(next).outcome, outcome);
            const other = store.registerWait({ owner: binding.owner, dependencies: [{ operationId: "op-busy-outcome" }], continuationNote: "Explicit follow-up", origin: { assignmentRef: `follow-up-${id}` } });
            assert.equal(assignmentFor(next).state, status === "completed" ? "completed" : "cancelled");
            store.cancelWait({ ...other.wait, expectedCancelEpoch: other.wait.cancelEpoch, owner: binding.owner, reason: "End isolated fixture" });
        }
    } finally { await h.close(); store.close(); }
});

test("parent result reads logs from a real standalone Background dependency without adopting its task", async () => {
    const h = host();
    const background = createObservedWaitHost(h.pi, { storePath: coordinatorPath(), supervisorDirectory: join(process.env.TMPDIR, "outcome-supervisor"), pollMs: 0 });
    const id = "actual-background-outcome";
    const owner = { kind: "worker-conversation", sessionId: "actual-worker", workspace: process.cwd(), branchId: null, goalId: null };
    const binding = { version: 1, assignmentId: id, owner, recipient: { kind: "parent-session", sessionId: "parent", workspace: process.cwd(), branchId: null, goalId: null } };
    const store = openStore({ path: coordinatorPath() });
    try {
        background.start(h.ctx);
        registerAssignmentAttempt(binding, id);
        const scope = { runId: id, conversationId: owner.sessionId, workspace: owner.workspace, authorityReference: "test-policy" };
        const launched = await background.service.launchForWorker(scope, { kind: "process", params: { shell: false, argv: [process.execPath, "-e", "process.stdout.write('actual failed-test evidence');process.exit(1)"], cwd: owner.workspace } });
        for (let i = 0; i < 200 && store.getOperation(launched.operationId).phase !== "terminal"; i++) {
            background.service.statusForWorker(scope, launched.id);
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(store.getOperation(launched.operationId).phase, "terminal");
        const { wait } = store.registerWait({ owner, dependencies: [{ operationId: launched.operationId }], continuationNote: "Interpret command", origin: { assignmentRef: id } });
        mkdirSync(runDir(id), { recursive: true }); writeFileSync(logPathFor(id), "");
        writeMeta({ id, assignment: binding, status: "running", pid: 4194304, spawnPid: process.pid, cwd: owner.workspace, sessionId: owner.sessionId, promptPreview: "diagnose", startedAt: Date.now(), logPath: logPathFor(id), callback: true, callbackOrigin: { cwd: owner.workspace, sessionId: "parent" } });
        finalizeRun(id, 1);
        await h.start(); await getCallbackBatcher(h.pi).flush();
        const result = await h.tools.get("subagent_result").execute("evidence", { id, operation_id: launched.operationId }, undefined, undefined, h.ctx);
        assert.match(result.content[0].text, /actual failed-test evidence/);
        assert.equal(store.getWait(wait).acknowledgement, null);
        assert.equal(store.listEvidenceReads(wait).length, 0);
        assert.equal(store.getOperation(launched.operationId).owner.sessionId, "actual-worker");
    } finally { background.close(); await h.close(); store.close(); }
});

test("registered stop commits and delivers cancellation without asserting process termination", async () => {
    const h = host();
    const id = "stopped-outcome";
    const binding = { version: 1, assignmentId: id,
        owner: { kind: "worker-conversation", sessionId: "stopped-worker", workspace: process.cwd(), branchId: null, goalId: null },
        recipient: { kind: "parent-session", sessionId: "parent", workspace: process.cwd(), branchId: null, goalId: null } };
    registerAssignmentAttempt(binding, id);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    const exited = once(child, "close");
    try {
        await once(child, "spawn");
        mkdirSync(runDir(id), { recursive: true }); writeFileSync(logPathFor(id), "");
        writeMeta({ id, assignment: binding, status: "running", pid: child.pid, pgid: child.pid, spawnPid: process.pid, cwd: process.cwd(), sessionId: "stopped-worker", promptPreview: "stop fixture", startedAt: Date.now(), logPath: logPathFor(id), callback: true, callbackOrigin: { cwd: process.cwd(), sessionId: "parent" } });
        await h.start();
        await h.tools.get("subagent_stop").execute("stop", { id }, undefined, undefined, h.ctx);
        await new Promise((resolve) => setImmediate(resolve));
        await getCallbackBatcher(h.pi).flush();
        assert.equal(readOutcome(readMeta(id)).outcome, "cancelled");
        assert.equal(readOutcome(readMeta(id)).processUncertain, true);
        assert.equal(h.sent.length, 1);
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited; await h.close();
    }
});

test("standalone parent receives outcomes without Harness or Goal", async () => {
    const { store, meta } = failedAssignment("no-goal-outcome");
    const h = host("parent", { noGoal: true });
    try {
        await h.start(); await new Promise((resolve) => setTimeout(resolve, 75));
        await getCallbackBatcher(h.pi).flush();
        assert.equal(h.sent.length, 1);
        assert.ok(readOutcome(meta).deliveryReceipt);
    } finally { await h.close(); store.close(); }
});
