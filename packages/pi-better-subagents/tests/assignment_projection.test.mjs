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
        store.registerWait({ waitId: "projection-wait", owner, dependencies: [{ operationId: "projection-op" }], continuationNote: "Interpret tests." });
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
        const next = store.registerWait({ waitId: "projection-wait", owner, dependencies: [{ operationId: "projection-op" }], continuationNote: "Follow-up" });
        store.cancelWait({ waitId: "projection-wait", generation: next.wait.generation, owner,
            expectedCancelEpoch: next.wait.cancelEpoch, reason: "Explicit stop" });
        const cancelled = assignmentFor(parked, "orphaned");
        assert.equal(cancelled.state, "cancelled");
        assert.equal(cancelled.termination, "unproven");
        assert.match(cancelled.reason, /Explicit stop/);
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
