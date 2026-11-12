// @covers subagent.assignment-projection
// @level unit
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assignmentFor, projectAssignment } from "../assignment-projection.mjs";
import { subagentListTool, subagentOutputTool, subagentResultTool } from "../tools.ts";
import { buildNavigatorRows, buildNavigatorDetail } from "../navigator.mjs";
import { collectSubagentActivity } from "../../pi-better-goal/src/subagents.ts";
import { baseDir, writeMeta, runDir } from "../registry.ts";
import { openStore } from "../../operation-coordinator/index.ts";

const Type = new Proxy({}, { get: () => (value) => value });
const text = (result) => result.content.map((part) => part.text).join("\n");

test("all five states reach actual tools, navigator and activity; exited output remains readable", async () => {
    const directory = mkdtempSync(join(process.cwd(), ".projection-test-"));
    const prior = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    const store = openStore({ path: join(directory, "operation-coordinator.sqlite") });
    try {
        const owner = { kind: "worker-conversation", sessionId: "projection-conversation", workspace: process.cwd() };
        store.registerOperation({ operationId: "projection-op", taskId: "projection-task", launchToken: "token", owner,
            observer: { kind: "background-tasks", version: "1" }, supervision: { hostId: "host", runnerId: "runner" }, authorityRef: "scope" });
        store.registerWait({ waitId: "projection-wait", owner, dependencies: [{ operationId: "projection-op" }],
            origin: { attemptId: "sa_projection_1" }, continuationNote: "Interpret tests." });
        const states = ["running", "waiting", "completed", "failed", "cancelled"];
        for (const [index, state] of states.entries()) {
            const meta = { id: `sa_projection_${index}`, sessionId: state === "waiting" ? owner.sessionId : `conversation-${index}`,
                status: state === "waiting" ? "completed" : state === "cancelled" ? "killed" : state,
                pid: process.pid, spawnPid: process.pid, cwd: process.cwd(), startedAt: Date.now() - index * 1000,
                promptPreview: "projection proof", callbackOrigin: { cwd: process.cwd(), sessionId: "parent" },
                ...(state === "waiting" ? { operations: { conversationId: owner.sessionId, workspace: owner.workspace } } : {}) };
            mkdirSync(runDir(meta.id), { recursive: true });
            writeMeta(meta);
            writeFileSync(join(runDir(meta.id), "output.log"), JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Useful retained output" }] } }) + "\n");
            const projected = assignmentFor(meta);
            assert.equal(projected.state, state);
            assert.equal(assignmentFor(meta).revision, projected.revision);
            const session = { activeOrigin: { cwd: process.cwd(), sessionId: "parent" } };
            for (const tool of [subagentOutputTool(Type, session), subagentResultTool(Type, session)]) {
                const observed = await tool.execute("call", { id: meta.id, all: true, max_bytes: 4096 });
                const body = text(observed);
                const repeated = await tool.execute("repeat", { id: meta.id, all: true, max_bytes: 4096 });
                assert.equal(repeated.details.assignment.revision, observed.details.assignment.revision);
                assert.match(body, new RegExp(`\\[${meta.id} · ${state}`));
                if (state === "waiting") assert.match(body, /Useful retained output/);
            }
            const listing = text(await subagentListTool(Type).execute("list", { all: true, max_bytes: 4096 }));
            assert.match(listing, new RegExp(`${meta.id}  \\[${state}\\]`));
            const deps = { effectiveStatus: (m) => m.status, shortModel: () => "model", fmtElapsed: () => "1s", spendFor: () => "",
                readMeta: () => meta, parseRun: () => ({ finalText: "Useful retained output" }), fmtSpend: () => "" };
            assert.equal(buildNavigatorRows([meta], deps)[0].status, state);
            const detail = buildNavigatorDetail(meta.id, deps);
            assert.equal(detail.assignment.revision, projected.revision);
            assert.equal(detail.output, "Useful retained output");
            const item = collectSubagentActivity({ baseDir: baseDir() }).items.find((item) => item.id === meta.id);
            assert.equal(item.status, state);
            assert.equal(item.details.assignment.revision, projected.revision);
        }
        store.recordTerminalOutcome({ operationId: "projection-op", eventId: "failed-test", owner, outcome: "failed",
            evidence: [{ kind: "log", ref: "failed-test.log", summary: "Tests failed; diagnosis required" }] });
        const parked = JSON.parse((await import("node:fs")).readFileSync(join(runDir("sa_projection_1"), "meta.json"), "utf8"));
        parked.park = { version: 1, phase: "waiting", waitId: "projection-wait", generation: 1 };
        writeMeta(parked);
        assert.equal(assignmentFor(parked).state, "waiting", "a failed test command does not fail its assignment");
        store.recordEvidenceRead({ waitId: "projection-wait", generation: 1, owner, operationId: "projection-op", terminalRevision: 1 });
        store.acknowledgeResult({ waitId: "projection-wait", generation: 1, owner, disposition: "assignment-complete",
            terminalRevisions: [{ operationId: "projection-op", revision: 1 }], note: "Interpreted failed tests; requested diagnosis is complete." });
        assert.equal(assignmentFor(parked).state, "completed");
        const result = await subagentResultTool(Type).execute("interpreted", { id: parked.id, all: true, max_bytes: 4096 });
        assert.equal(result.details.assignment.state, "completed");
        assert.match(text(result), /Useful retained output/);
        assert.equal(collectSubagentActivity({ baseDir: baseDir() }).items.find((item) => item.id === parked.id).status, "completed");
        const missingHost = assignmentFor(parked, "completed", { coordinatorPath: join(directory, "missing.sqlite") });
        assert.equal(missingHost.state, "waiting");
        assert.equal(missingHost.verified, false);
        assert.match(missingHost.reason, /unverified/);
        process.env.PI_CODING_AGENT_DIR = join(directory, "unsupported-host");
        const unsupported = await subagentOutputTool(Type).execute("unsupported", { id: parked.id, all: true, max_bytes: 4096 });
        assert.equal(unsupported.details.assignment.state, "waiting");
        assert.equal(unsupported.details.assignment.verified, false);
        assert.match(text(unsupported), /Useful retained output/);
        process.env.PI_CODING_AGENT_DIR = directory;
        const next = store.registerWait({ waitId: "projection-wait", owner, dependencies: [{ operationId: "projection-op" }],
            origin: { attemptId: "sa_projection_followup" }, continuationNote: "Follow-up" });
        store.cancelWait({ waitId: "projection-wait", generation: next.wait.generation, owner,
            expectedCancelEpoch: next.wait.cancelEpoch, reason: "Explicit stop" });
        const cancelled = assignmentFor({ ...parked, id: "sa_projection_followup", park: undefined }, "orphaned");
        assert.equal(cancelled.state, "cancelled");
        assert.equal(cancelled.termination, "unproven");
        assert.match(cancelled.reason, /Explicit stop/);
        assert.equal(assignmentFor(parked).state, "completed", "cancelling a follow-up must not cancel the original assignment");
    } finally {
        store.close();
        rmSync(directory, { recursive: true, force: true });
        if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = prior;
    }
});

test("consumption, failed commands, unverified caches and uncertain cancellation preserve their meanings", () => {
    const meta = { id: "attempt", status: "completed", park: { phase: "consumed" } };
    const waiting = { verified: true, waits: [{ waitId: "wait", generation: 1, phase: "ready", outcome: "failed" }] };
    assert.equal(projectAssignment(meta, "completed", waiting).state, "waiting");
    waiting.waits[0].phase = "consumed";
    waiting.waits[0].acknowledgement = { disposition: "continue" };
    const consumed = projectAssignment(meta, "completed", waiting);
    assert.equal(consumed.state, "waiting");
    waiting.waits[0].acknowledgement.disposition = "assignment-complete";
    assert.equal(projectAssignment(meta, "completed", waiting).state, "completed");
    assert.notEqual(projectAssignment(meta, "completed", waiting).revision, consumed.revision);
    waiting.waits[0].phase = "cancelled";
    const cancelled = projectAssignment(meta, "orphaned", waiting);
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.termination, "unproven");
    assert.ok(cancelled.evidence.includes("wait:wait:1"));
    assert.equal(projectAssignment(meta, "completed", { verified: false, waits: [], reason: "Unsupported host" }).state, "waiting");
});

test("R1: explicit follow-up waits and automatic descendants cannot reopen earlier assignments through any consumer", async () => {
    const directory = mkdtempSync(join(process.cwd(), ".projection-test-"));
    const prior = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    const store = openStore({ path: join(directory, "operation-coordinator.sqlite") });
    const owner = { kind: "worker-conversation", sessionId: "r1-saved-conversation", workspace: process.cwd() };
    const originals = ["completed", "failed", "killed"].map((status, index) => ({
        id: `sa_r1_original_${index}`, status, startedAt: index + 1, endedAt: index + 2,
        pid: process.pid, spawnPid: process.pid, cwd: owner.workspace, sessionId: owner.sessionId,
        promptPreview: "R1 original", operations: { conversationId: owner.sessionId, workspace: owner.workspace },
    }));
    const save = (meta) => {
        mkdirSync(runDir(meta.id), { recursive: true });
        writeMeta(meta);
        writeFileSync(join(runDir(meta.id), "output.log"), JSON.stringify({ type: "message_end", message: {
            role: "assistant", content: [{ type: "text", text: "Original useful output" }],
        } }) + "\n");
    };
    try {
        originals.forEach(save);
        const snapshots = originals.map((meta) => assignmentFor(meta));
        const followup = { ...originals[0], id: "sa_r1_followup", rootRunId: originals[0].id,
            resumedFrom: originals[0].id, startedAt: 10 };
        save(followup);
        store.registerOperation({ operationId: "r1-op", taskId: "r1-task", launchToken: "r1-token", owner,
            observer: { kind: "background-tasks", version: "1" }, supervision: { hostId: "host", runnerId: "runner" }, authorityRef: "scope" });
        store.registerWait({ waitId: "r1-wait", owner, dependencies: [{ operationId: "r1-op" }],
            origin: { attemptId: followup.id }, continuationNote: "Explicit follow-up work" });
        // A later automatic child shares the conversation root but belongs only to the follow-up.
        const automatic = { ...followup, id: "sa_r1_automatic", resumedFrom: followup.id, startedAt: 20,
            operations: { ...followup.operations, resumeLaunchToken: "r1-auto-token" } };
        save(automatic);
        assert.equal(assignmentFor(followup).state, "waiting");
        assert.equal(assignmentFor(automatic).state, "waiting", "ancestor wait remains part of an automatic assignment");
        for (const [index, meta] of originals.entries()) {
            assert.deepEqual(assignmentFor(meta), snapshots[index], "follow-up cannot change terminal state, revision or evidence");
            const expected = snapshots[index].state;
            for (const tool of [subagentOutputTool(Type), subagentResultTool(Type)]) {
                const observed = await tool.execute("r1", { id: meta.id, all: true, max_bytes: 4096 });
                assert.deepEqual(observed.details.assignment, snapshots[index]);
                assert.match(text(observed), /Original useful output/);
            }
            const list = text(await subagentListTool(Type).execute("r1-list", { all: true, status: [expected], max_bytes: 4096 }));
            assert.match(list, new RegExp(`${meta.id}  \\[${expected}\\]`));
            const deps = { effectiveStatus: (m) => m.status, shortModel: () => "model", fmtElapsed: () => "1s", spendFor: () => "",
                readMeta: () => meta, parseRun: () => ({ finalText: "Original useful output" }), fmtSpend: () => "" };
            assert.deepEqual(buildNavigatorRows([meta], deps)[0].assignment, snapshots[index]);
            assert.deepEqual(buildNavigatorDetail(meta.id, deps).assignment, snapshots[index]);
            const item = collectSubagentActivity({ baseDir: baseDir() }).items.find((item) => item.id === meta.id);
            assert.deepEqual(item.details.assignment, snapshots[index]);
        }
    } finally {
        store.close();
        rmSync(directory, { recursive: true, force: true });
        for (const meta of [...originals, { id: "sa_r1_followup" }, { id: "sa_r1_automatic" }]) rmSync(runDir(meta.id), { recursive: true, force: true });
        if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = prior;
    }
});
