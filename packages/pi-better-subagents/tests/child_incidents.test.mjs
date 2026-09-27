// @covers subagent.failure-observations
// @level integration
/**
 * #315 child side: the guarded task runtime's bash accepts structured intent validated before
 * execution, and the child-facing `failure_disposition` tool validates against the same incident
 * model the parent replays. The parent then journals exactly what the child accepted.
 * Real SDK session + real task guard; only the model loop is replaced by direct tool execution.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describeSandboxSupport } from "../shared-sandbox-core.ts";
import taskGuard from "../task-guard.ts";
import { collectRunFailures, failurePath } from "../failures.ts";
import { logPathFor, runDir } from "../registry.ts";
import { activeFailures, failureHistory } from "../shared-failure-observations.ts";
import { readCommandIntent } from "../incident-model.ts";

/**
 * Real-kernel lane convention (docs/development-and-release.md, "Sandbox confinement lanes"):
 * skip without a usable backend, but PI_SANDBOX_REQUIRE_BACKEND turns that skip into a failure.
 * CI runs this file in the macos-sandbox and linux-sandbox lanes (test:*-sandbox scripts).
 */
function realBackendSkip() {
    const support = describeSandboxSupport();
    const required = process.env.PI_SANDBOX_REQUIRE_BACKEND;
    if (required && (!support.supported || support.backend !== required)) {
        throw new Error(`PI_SANDBOX_REQUIRE_BACKEND=${required} but this runner selected ${support.supported ? support.backend : support.reason}`);
    }
    if (!support.supported) return `requires a real sandbox backend: ${support.reason}`;
    const probe = support.backend === "linux-bubblewrap"
        ? spawnSync(support.executable, ["--ro-bind", "/", "/", "--", "/bin/true"], { encoding: "utf8" })
        : spawnSync(support.executable, ["-p", "(version 1) (allow default)", "/usr/bin/true"], { encoding: "utf8" });
    if (probe.status !== 0) {
        const reason = probe.error?.message ?? probe.stderr;
        if (required) throw new Error(`PI_SANDBOX_REQUIRE_BACKEND=${required} but ${support.backend} cannot start: ${reason}`);
        return `requires usable ${support.backend}: ${reason}`;
    }
    return false;
}
const backendSkip = realBackendSkip();

function fixture(t) {
    const base = realpathSync(mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/var/tmp", "pi-child-incidents-")));
    const project = join(base, "project"), agent = join(base, "agent"), control = join(base, "control"), scratch = join(base, "scratch");
    for (const dir of [project, agent, control, scratch]) mkdirSync(dir);
    writeFileSync(join(scratch, ".sandbox-anchor"), "");
    writeFileSync(join(agent, "auth.json"), "{}");
    writeFileSync(join(agent, "settings.json"), "{}");
    const policy = { version: 1, root: project, home: join(base, "home"), agentDir: agent, profilePath: join(control, "task.sb"), scratch,
        // A policy every backend can enforce (the task_runtime defaults; Linux bubblewrap cannot hide credentials under a read-only whole-root bind).
        permissions: { projectFiles: "read-write", outsideProject: "read", storedCredentials: "read", commands: true, network: true },
        denyWrite: [agent, control, join(scratch, ".sandbox-anchor")], tools: ["read", "write", "edit", "bash"] };
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agent;
    t.after(() => {
        if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgent;
        rmSync(base, { recursive: true, force: true });
    });
    return { base, project, agent, policy };
}

async function sessionFixture(t, f) {
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({ cwd: f.project, agentDir: f.agent, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        extensionFactories: [{ name: "task-sandbox", factory: (pi) => taskGuard(pi, f.policy, (error) => { throw error; }) }] });
    await loader.reload();
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: join(f.agent, "models.json"), modelsStorePath: join(f.agent, "models-store.json") });
    const { session } = await createAgentSession({ cwd: f.project, agentDir: f.agent, resourceLoader: loader, modelRuntime,
        settingsManager, sessionManager: SessionManager.inMemory(f.project), noTools: "builtin" });
    t.after(() => session.dispose());
    await session.bindExtensions({});
    return session;
}

/** Runs one tool call through the guard and records it in the session and a parent-visible child log. */
function childRun(t, session) {
    const id = `sa_child_incidents_${randomUUID()}`;
    mkdirSync(runDir(id), { recursive: true });
    // Launched on the trusted task runtime: the parent-written flag that enables structured intent.
    writeFileSync(join(runDir(id), "meta.json"), JSON.stringify({ id, status: "running", cwd: process.cwd(), taskRuntime: true }));
    t.after(() => rmSync(runDir(id), { recursive: true, force: true }));
    const log = (row) => appendFileSync(logPathFor(id), JSON.stringify(row) + "\n");
    const assistant = (toolCall) => session.sessionManager.appendMessage({ role: "assistant", content: [toolCall], api: "test", provider: "test", model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse", timestamp: Date.now() });
    async function call(toolCallId, name, args) {
        assistant({ type: "toolCall", id: toolCallId, name, arguments: args });
        log({ type: "tool_execution_start", toolCallId, toolName: name, args });
        const tool = session.agent.state.tools.find((candidate) => candidate.name === name);
        assert.ok(tool, `${name} is active in the child`);
        const decision = await session.agent.beforeToolCall?.({ toolCall: { id: toolCallId, name, arguments: args }, args });
        let result, isError = false;
        try {
            if (decision?.block) throw new Error(decision.reason);
            result = await tool.execute(toolCallId, args, new AbortController().signal);
        } catch (error) {
            isError = true;
            result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: {} };
        }
        session.sessionManager.appendMessage({ role: "toolResult", toolCallId, toolName: name, content: result.content, details: result.details, isError, timestamp: Date.now() });
        log({ type: "tool_execution_end", toolCallId, toolName: name, isError, result });
        return { isError, text: result.content.map((part) => part.text ?? "").join(""), details: result.details };
    }
    return { id, call, cwd: session.sessionManager.getCwd?.() ?? process.cwd() };
}

test("the child and parent share one intent validator", () => {
    assert.deepEqual(readCommandIntent({ expectedExitCodes: [1, 2], operationId: "tests", attemptId: "a-1" }).intent, { expectedExitCodes: [1, 2], operationId: "tests", attemptId: "a-1" });
    for (const bad of [{ expectedExitCodes: [0] }, { expectedExitCodes: [] }, { expectedExitCodes: [1, 1] }, { expectedExitCodes: "1" }, { operationId: "has space" }, { attemptId: "" }]) {
        assert.ok(readCommandIntent(bad).error, JSON.stringify(bad));
    }
});

test("declared exit codes are validated before execution and classify only the final structured exit", { skip: backendSkip }, async (t) => {
    const f = fixture(t);
    const session = await sessionFixture(t, f);
    const child = childRun(t, session);
    const probe = await child.call("probe", "bash", { command: "printf 'no match\\n'; exit 1", expectedExitCodes: [1] });
    assert.equal(probe.isError, false);
    assert.deepEqual(probe.details, { exitCode: 1, expectedExit: true });
    assert.match(probe.text, /Exit code 1 was declared expected/);
    const mismatch = await child.call("mismatch", "bash", { command: "exit 2", expectedExitCodes: [1] });
    assert.equal(mismatch.isError, true, "an undeclared code stays an ordinary failure");
    const marker = join(f.project, "should-not-exist");
    const invalid = await child.call("invalid", "bash", { command: `touch '${marker}'`, expectedExitCodes: [0] });
    assert.equal(invalid.isError, true);
    assert.match(invalid.text, /Invalid command intent.*not run/);
    assert.equal(existsSync(marker), false, "invalid intent is rejected before the command runs");
    const timeout = await child.call("slow", "bash", { command: "sleep 5", timeout: 0.2, expectedExitCodes: [1] });
    assert.equal(timeout.isError, true, "a timeout is never an expected exit");
    const state = collectRunFailures(child.id, child.cwd, true);
    assert.deepEqual(activeFailures(state).filter((x) => x.status === "expected").map((x) => x.id), ["tool:probe"]);
    assert.deepEqual(activeFailures(state).filter((x) => x.status === "unresolved").map((x) => x.id).sort(), ["tool:invalid", "tool:mismatch", "tool:slow"]);
    assert.equal(activeFailures(state).find((x) => x.id === "tool:invalid").category, "rejected-intent", "the command that never ran is not a failure of its operation");
});

test("a child supersedes its merge conflict through failure_disposition and the parent journals exactly that", { skip: backendSkip }, async (t) => {
    const f = fixture(t);
    const session = await sessionFixture(t, f);
    const child = childRun(t, session);
    const conflict = await child.call("pick", "bash", { command: "echo 'CONFLICT (content): Merge conflict in a.ts'; exit 1", attemptId: "pick-1" });
    assert.equal(conflict.isError, true);
    const reused = await child.call("reuse", "bash", { command: "true", attemptId: "pick-1" });
    assert.match(reused.text, /attemptId pick-1 was already used/);
    await child.call("continue", "bash", { command: "echo resolved", attemptId: "pick-continue" });
    const unknown = await child.call("d-unknown", "failure_disposition", { disposition: "superseded", targets: ["nope"], reason: "resolved", evidence: "pick-continue" });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /Unknown incident, attempt, or operation "nope"[\s\S]*Open incidents:[\s\S]*tool:pick \/ pick-1/);
    const noEvidence = await child.call("d-no-evidence", "failure_disposition", { disposition: "superseded", targets: ["pick-1"], reason: "resolved" });
    assert.match(noEvidence.text, /requires evidence/);
    const accepted = await child.call("d-ok", "failure_disposition", { disposition: "superseded", targets: ["pick-1"], reason: "conflict resolved", evidence: "pick-continue" });
    assert.equal(accepted.isError, false, accepted.text);
    assert.match(accepted.text, /Recorded superseded for 1 incident: tool:pick/);
    const again = await child.call("d-again", "failure_disposition", { disposition: "expected", targets: ["pick-1"], reason: "twice" });
    assert.match(again.text, /already disposed/);
    const state = collectRunFailures(child.id, child.cwd, true);
    const pick = failureHistory(state).find((x) => x.id === "tool:pick");
    assert.equal(pick.status, "superseded");
    assert.match(pick.disposition.evidence, /attempt pick-continue succeeded/);
    assert.equal(state.dispositions.length, 1);
    assert.equal(readFileSync(failurePath(child.id), "utf8").match(/"kind":"disposition"/g).length, 1);
    // The reused-attemptId rejection stays visible as its own non-escalating incident; nothing else is open.
    assert.deepEqual(activeFailures(state).map((x) => [x.id, x.category]), [["tool:reuse", "rejected-intent"]]);
});
