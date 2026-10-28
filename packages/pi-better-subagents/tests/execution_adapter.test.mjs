// @covers subagent.execution-adapter
// @level integration
/**
 * Shell / direct application / command time limit controls.
 *
 * The producer (pi-better-sandbox) publishes `shell` and `commandTimeoutSeconds`
 * in the Subagents profile. This file covers the consumer side: the bus snapshot
 * validation and copy, the immutable task policy the launch freezes, the
 * direct-only loadout substitution, the guard's activation rules, and the
 * capability handshake the producer admits a restrictive launch with. The last
 * two tests drive the real SDK session and the real kernel: a direct application
 * runs, a shell interpreter is refused under Shell scripts Off, and the published
 * time limit stops a longer program.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createSubagentExecutionAdmission } from "../../pi-better-sandbox/subagent-admission.ts";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describeSandboxSupport } from "../shared-sandbox-core.ts";
import { TASK_BUILTINS } from "../shared-task-sandbox.ts";
import {
    announceExecutionAdapter, currentSandboxPermissions, EXECUTION_ADAPTER_REQUEST_CHANNEL,
    EXECUTION_ADAPTER_VERSION, isCommandTimeoutSeconds, MAX_COMMAND_TIMEOUT_SECONDS,
    observeSandboxPermissions, resolveCommandSettings, resolveSubagentPermissions, SANDBOX_POLICY_CHANNEL,
    SANDBOX_POLICY_REQUEST_CHANNEL,
} from "../permission-policy.ts";
import {
    applyDirectApplicationLoadout, parseTaskPolicy, prepareTaskRuntime, RUN_APPLICATION, SDK_BUILTIN_TOOLS, selectTaskTools,
} from "../task-policy.ts";
import taskGuard from "../task-guard.ts";
import { planTaskTools } from "../subagent-tools.ts";
import { defaultSubagentTools } from "../shared-task-tools.ts";

const RUN_APPLICATION_BUILTIN = TASK_BUILTINS.includes(RUN_APPLICATION);

const main = { enabled: false, projectFiles: "read-write", outsideProject: "read",
    storedCredentials: "read", commands: true, network: true };
const child = { ...main, enabled: true };

function busFixture() {
    const events = new EventEmitter();
    const pi = { events };
    let snapshot = { state: "disabled", permissions: main, subagentPermissions: child };
    events.on(SANDBOX_POLICY_REQUEST_CHANNEL, () => events.emit(SANDBOX_POLICY_CHANNEL, snapshot));
    return { pi, events, publish(next) { snapshot = next; events.emit(SANDBOX_POLICY_CHANNEL, next); } };
}

// ---- bus snapshot ------------------------------------------------------------

test("absent shell and time limit keep their historical defaults and their keys stay absent", () => {
    const { pi } = busFixture();
    const published = currentSandboxPermissions(pi);
    assert.deepEqual(published.subagentPermissions, { ...child });
    assert.equal("shell" in published.subagentPermissions, false);
    assert.equal("commandTimeoutSeconds" in published.subagentPermissions, false);
    assert.deepEqual(resolveCommandSettings(published.subagentPermissions), { shell: true, commandTimeoutSeconds: null });
    assert.deepEqual(resolveCommandSettings(undefined), { shell: true, commandTimeoutSeconds: null });
});

test("published shell and time limit are validated, copied and frozen", () => {
    const { pi, publish } = busFixture();
    const publisher = { ...child, shell: false, commandTimeoutSeconds: 600 };
    publish({ state: "disabled", permissions: main, subagentPermissions: publisher });
    const snapshot = currentSandboxPermissions(pi).subagentPermissions;
    assert.equal(snapshot.shell, false);
    assert.equal(snapshot.commandTimeoutSeconds, 600);
    assert.ok(Object.isFrozen(snapshot));
    const plan = resolveSubagentPermissions(pi, undefined);
    assert.equal(plan.permissions.shell, false);
    assert.equal(plan.permissions.commandTimeoutSeconds, 600);
    assert.deepEqual(resolveCommandSettings(plan.permissions), { shell: false, commandTimeoutSeconds: 600 });
    // Editing the producer's own object after publication cannot reach a copied snapshot.
    publisher.shell = true;
    publisher.commandTimeoutSeconds = 1;
    assert.equal(snapshot.shell, false);
    assert.equal(snapshot.commandTimeoutSeconds, 600);
    assert.equal(plan.permissions.shell, false);
    assert.equal(plan.permissions.commandTimeoutSeconds, 600);
    publish({ state: "disabled", permissions: main, subagentPermissions: { ...child, commandTimeoutSeconds: null } });
    assert.deepEqual(resolveCommandSettings(resolveSubagentPermissions(pi, undefined).permissions),
        { shell: true, commandTimeoutSeconds: null });
});

test("invalid shell switches and command time limits are refused instead of coerced", () => {
    const invalidCap = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_COMMAND_TIMEOUT_SECONDS + 1, 1.5e9, "600", true];
    for (const commandTimeoutSeconds of invalidCap) {
        const { pi, publish } = busFixture();
        publish({ state: "disabled", permissions: main, subagentPermissions: { ...child, commandTimeoutSeconds } });
        assert.throws(() => resolveSubagentPermissions(pi, undefined), /Invalid sandbox permission profile/,
            `rejects ${String(commandTimeoutSeconds)}`);
    }
    for (const shell of ["off", 0, 1]) {
        const { pi, publish } = busFixture();
        publish({ state: "disabled", permissions: main, subagentPermissions: { ...child, shell } });
        assert.throws(() => resolveSubagentPermissions(pi, undefined), /Invalid sandbox permission profile/,
            `rejects shell ${String(shell)}`);
    }
    assert.equal(isCommandTimeoutSeconds(MAX_COMMAND_TIMEOUT_SECONDS), true, "the largest timer-safe cap is allowed");
    assert.equal(isCommandTimeoutSeconds(0.5), true, "fractional seconds are positive finite seconds");
});

test("a malformed Main profile still fails closed when the Subagents profile carries the new fields", () => {
    const { pi, publish } = busFixture();
    publish({ state: "disabled", permissions: { ...main, commandTimeoutSeconds: -5 },
        subagentPermissions: { ...child, shell: false } });
    assert.throws(() => resolveSubagentPermissions(pi, undefined), /Invalid sandbox permission profile/);
});

// ---- immutable task policy ---------------------------------------------------

const supported = describeSandboxSupport().supported;

function policyFixture(t, permissions = {}) {
    // /var/tmp keeps the macOS compatibility temp exception from rejecting the fixture's own home.
    const base = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/var/tmp", "pi-execution-adapter-"));
    const project = join(base, "project"), agent = join(base, "agent"), control = join(base, "control");
    const scratch = join(base, "scratch");
    for (const dir of [project, agent, control, scratch]) mkdirSync(dir);
    writeFileSync(join(agent, "settings.json"), "{}");
    writeFileSync(join(scratch, ".sandbox-anchor"), "");
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const policy = { version: 1, root: project, home: base, agentDir: agent, profilePath: join(control, "task.sb"),
        scratch,
        permissions: { projectFiles: "read-write", outsideProject: "read", storedCredentials: "read",
            commands: true, network: true, ...permissions },
        denyWrite: [control], tools: ["read", "bash"] };
    return { base, project, agent, control, policy };
}

test("a legacy task policy resolves to shell On and no cap", (t) => {
    const f = policyFixture(t);
    const policy = parseTaskPolicy(f.policy);
    assert.equal(policy.permissions.shell, true);
    assert.equal(policy.permissions.commandTimeoutSeconds, null);
    assert.ok(Object.isFrozen(policy.permissions));
});

test("the task policy copies, freezes and validates the direct-only controls", (t) => {
    const f = policyFixture(t, { shell: false, commandTimeoutSeconds: 600 });
    const policy = parseTaskPolicy(f.policy);
    assert.equal(policy.permissions.shell, false);
    assert.equal(policy.permissions.commandTimeoutSeconds, 600);
    assert.ok(Object.isFrozen(policy.permissions));
    // Detached: later edits to the producer's object cannot change a launched policy.
    f.policy.permissions.shell = true;
    f.policy.permissions.commandTimeoutSeconds = null;
    assert.equal(policy.permissions.shell, false);
    assert.equal(policy.permissions.commandTimeoutSeconds, 600);
    for (const commandTimeoutSeconds of [0, -60, Number.NaN, MAX_COMMAND_TIMEOUT_SECONDS + 1, "600"]) {
        assert.throws(() => parseTaskPolicy({ ...f.policy, permissions: { ...f.policy.permissions, commandTimeoutSeconds } }),
            /Invalid task sandbox command timeout/);
    }
    assert.throws(() => parseTaskPolicy({ ...f.policy, permissions: { ...f.policy.permissions, shell: "off" } }),
        /Invalid task sandbox shell setting/);
});

test("a prepared launch writes the resolved controls into the frozen policy file", { skip: !supported }, (t) => {
    const f = policyFixture(t, { shell: false, commandTimeoutSeconds: 600 });
    const prepared = prepareTaskRuntime({ root: f.project, controlDir: f.control, tools: ["read", RUN_APPLICATION],
        permissions: f.policy.permissions,
        piBin: fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent"))) });
    t.after(() => rmSync(prepared.policy.scratch, { recursive: true, force: true }));
    assert.equal(prepared.policy.permissions.shell, false);
    assert.equal(prepared.policy.permissions.commandTimeoutSeconds, 600);
    const written = JSON.parse(readFileSync(prepared.policyPath, "utf8"));
    assert.equal(written.permissions.shell, false);
    assert.equal(written.permissions.commandTimeoutSeconds, 600);
    assert.deepEqual(written.tools, ["read", RUN_APPLICATION]);
});

// ---- direct-only loadout -----------------------------------------------------

test("Shell On leaves the requested loadout exactly as it is", () => {
    const loadout = applyDirectApplicationLoadout(["read", "bash", "edit"], { shell: true });
    assert.deepEqual(loadout.tools, ["read", "bash", "edit"]);
    assert.equal(loadout.substituted, false);
});

test("Shell Off replaces a requested bash with the guarded application capability", () => {
    const loadout = applyDirectApplicationLoadout(["read", "bash", "write", "bash"], { shell: false });
    assert.deepEqual(loadout.tools, ["read", RUN_APPLICATION, "write"], "order is kept and duplicates collapse");
    assert.equal(loadout.substituted, true);
    assert.equal(loadout.excluded, false);
});

test("a read-only loadout gains no application capability", () => {
    const loadout = applyDirectApplicationLoadout(["read", "edit"], { shell: false });
    assert.deepEqual(loadout.tools, ["read", "edit"]);
    assert.equal(loadout.substituted, false);
});

test("exclusions are never restored by substitution", () => {
    const excludedApplication = applyDirectApplicationLoadout(["read", "bash"], {
        shell: false, excluded: new Set(["run_application"]),
    });
    assert.deepEqual(excludedApplication.tools, ["read"], "no bash, and no restored run_application");
    assert.equal(excludedApplication.excluded, true);
    const excludedBash = applyDirectApplicationLoadout(["read", "bash"], { shell: false, excluded: new Set(["bash"]) });
    assert.deepEqual(excludedBash.tools, ["read"], "an excluded bash is not replaced by a different capability");
    assert.equal(excludedBash.substituted, false);
    const requestedApplication = applyDirectApplicationLoadout(["read", RUN_APPLICATION], { shell: false });
    assert.deepEqual(requestedApplication.tools, ["read", RUN_APPLICATION]);
});

test("the task tool plan treats the substituted application tool as a builtin, not a refused trusted tool", () => {
    const plan = planTaskTools({
        requested: ["read", RUN_APPLICATION, "apply_patch"], settings: defaultSubagentTools(),
        network: true, builtins: TASK_BUILTINS, registered: [],
        resolvePath: () => undefined,
    });
    assert.deepEqual(plan.refused.filter((tool) => tool.name === RUN_APPLICATION), []);
    assert.equal(plan.applyPatch, true, "the guarded patch adapter is unaffected by the direct-only loadout");
});

test("only SDK builtins may reach --tools, never a guard-installed task builtin", () => {
    assert.deepEqual([...SDK_BUILTIN_TOOLS], ["read", "write", "edit", "bash"]);
    for (const taskOnly of [RUN_APPLICATION, "process_list", "apply_patch"]) {
        assert.equal(SDK_BUILTIN_TOOLS.includes(taskOnly), false, `${taskOnly} is not an SDK builtin`);
    }
});

// ---- guard activation --------------------------------------------------------

/** The builtin list a synced shared task sandbox installs (vendored copies may lag). */
const SYNCED_BUILTINS = [...TASK_BUILTINS, RUN_APPLICATION, "apply_patch"];
function policyInput(tools, overrides = {}) {
    return { version: 1, root: "/", home: "/", agentDir: "/", profilePath: "/p", scratch: "/s",
        permissions: { projectFiles: "off", outsideProject: "off", storedCredentials: "off",
            commands: true, network: true, ...overrides },
        denyWrite: [], tools };
}

test("activation: the requested set is filtered by the builtin list and the policy", () => {
    const tools = ["read", "bash", RUN_APPLICATION, "process_list", "web_fetch"];
    assert.deepEqual(selectTaskTools(policyInput(tools), SYNCED_BUILTINS), ["read", "bash", RUN_APPLICATION]);
    assert.deepEqual(selectTaskTools(policyInput(tools, { shell: false }), SYNCED_BUILTINS), ["read", RUN_APPLICATION]);
    assert.deepEqual(selectTaskTools(policyInput(tools, { commands: false }), SYNCED_BUILTINS), ["read"]);
    assert.deepEqual(selectTaskTools(policyInput(tools, { processAccess: "read" }), SYNCED_BUILTINS),
        ["read", "bash", RUN_APPLICATION, "process_list"]);
    assert.deepEqual(selectTaskTools(policyInput(["read"], { shell: false }), SYNCED_BUILTINS), ["read"],
        "a read-only loadout is not widened by direct-application confinement");
    assert.deepEqual(selectTaskTools(policyInput(["bash"]), [...TASK_BUILTINS]), ["bash"],
        "a vendored sandbox without the application adapter simply has no run_application to activate");
});

test("the post-sync composition hands a direct-only child run_application, never bash", () => {
    const settings = resolveCommandSettings({ shell: false, commandTimeoutSeconds: 600 });
    const loadout = applyDirectApplicationLoadout(["read", "bash", "edit"], { shell: settings.shell });
    assert.deepEqual(loadout.tools, ["read", RUN_APPLICATION, "edit"]);
    const policy = policyInput(loadout.tools, { shell: false, commandTimeoutSeconds: 600 });
    assert.deepEqual(selectTaskTools(policy, SYNCED_BUILTINS), ["read", RUN_APPLICATION, "edit"]);
    const frozen = parseTaskPolicy(policy);
    assert.equal(frozen.permissions.shell, false);
    assert.equal(frozen.permissions.commandTimeoutSeconds, 600);
});

/** The child-side guard over a stand-in Pi that records its activated tool set. */
const originalStdoutWrite = process.stdout.write;
function guardFixture(t, policy) {
    const tools = new Map();
    const handlers = new Map();
    const active = [];
    const pi = {
        registerTool: (tool) => tools.set(tool.name, { ...tool, sourceInfo: { path: "<inline:task-sandbox>" } }),
        on: (name, handler) => handlers.set(name, handler),
        events: { on() {}, emit() {} },
        getAllTools: () => [...tools.values()],
        setActiveTools: (names) => { active.length = 0; active.push(...names); },
        getActiveTools: () => [...active],
    };
    const written = [];
    t.mock.method(process.stdout, "write", function (chunk, ...args) {
        const text = String(chunk);
        if (text.startsWith('{"type":"task_sandbox_ready"')) { written.push(JSON.parse(text)); return true; }
        return originalStdoutWrite.call(this, chunk, ...args);
    });
    taskGuard(pi, policy, (error) => { throw error; });
    return { pi, handlers, active, written, ready: () => handlers.get("session_start")({}, { cwd: policy.root }) };
}

test("the guard withholds bash under Shell Off and activates the substituted direct-application tool",
    { skip: !supported }, async (t) => {
        // The parent substitutes; the guard enforces. A policy that still lists bash gets no bash,
        // and the guard never invents a capability the parent did not hand down.
        const withheld = policyFixture(t, { shell: false, commandTimeoutSeconds: 600 });
        withheld.policy.tools = ["read", "bash"];
        const withheldGuard = guardFixture(t, withheld.policy);
        await withheldGuard.ready();
        assert.deepEqual(withheldGuard.active, ["read", "failure_disposition"]);
        assert.deepEqual(withheldGuard.written.at(-1).tools, ["read"]);

        const direct = policyFixture(t, { shell: false, commandTimeoutSeconds: 600 });
        direct.policy.tools = RUN_APPLICATION_BUILTIN ? ["read", RUN_APPLICATION] : ["read"];
        const directGuard = guardFixture(t, direct.policy);
        await directGuard.ready();
        if (RUN_APPLICATION_BUILTIN) {
            assert.deepEqual(directGuard.active, ["read", RUN_APPLICATION, "failure_disposition"]);
            assert.deepEqual(directGuard.written.at(-1).tools, ["read", RUN_APPLICATION]);
        } else {
            // A vendored task sandbox without the adapter cannot activate a name it does not install.
            assert.deepEqual(directGuard.active, ["read", "failure_disposition"]);
        }

        const readOnly = policyFixture(t, { shell: false });
        readOnly.policy.tools = ["read", "edit"];
        const readOnlyGuard = guardFixture(t, readOnly.policy);
        await readOnlyGuard.ready();
        assert.deepEqual(readOnlyGuard.active, ["read", "edit", "failure_disposition"],
            "direct-only confinement does not add application execution to a read-only loadout");
    });

test("Run applications Off activates neither command tool", { skip: !supported }, async (t) => {
    const f = policyFixture(t, { commands: false, shell: false });
    f.policy.tools = RUN_APPLICATION_BUILTIN ? ["read", "bash", RUN_APPLICATION] : ["read", "bash"];
    const guard = guardFixture(t, f.policy);
    await guard.ready();
    assert.equal(guard.active.includes("bash"), false);
    assert.equal(guard.active.includes(RUN_APPLICATION), false);
    assert.deepEqual(guard.written.at(-1).tools, ["read"]);
});

test("Shell On keeps a requested bash and does not add the application adapter", { skip: !supported }, async (t) => {
    const f = policyFixture(t);
    f.policy.tools = ["read", "bash"];
    const guard = guardFixture(t, f.policy);
    await guard.ready();
    assert.deepEqual(guard.active, ["read", "bash", "failure_disposition"]);
});

// ---- capability handshake ----------------------------------------------------

/** The path the producer trusts and the schemas of one factory load. */
const SPAWN_SOURCE = fileURLToPath(new URL("../index.ts", import.meta.url));
function producerPipeline(t, schemas) {
    // The real bus, the real producer admission, and the real consumer answer.
    const events = createEventBus();
    const shutdownHooks = [];
    const registered = new Map();
    const pi = {
        events,
        getAllTools: () => [...registered].map(([name, parameters]) =>
            ({ name, parameters, sourceInfo: { path: SPAWN_SOURCE } })),
        on: (event, handler) => { if (event === "session_shutdown") shutdownHooks.push(handler); },
    };
    t.after(() => events.clear());
    announceExecutionAdapter(pi, { parametersFor: (name) => schemas.get(name), runApplication: true });
    return { pi, shutdownHooks, registered, admit: createSubagentExecutionAdmission(pi) };
}

test("the consumer answers the producer's admission request with its registered schema identity", () => {
    const events = createEventBus();
    const parameters = { type: "object", properties: { prompt: { type: "string" } } };
    const tools = { subagent_spawn: { name: "subagent_spawn", parameters } };
    announceExecutionAdapter({ events }, { parametersFor: (name) => tools[name]?.parameters, runApplication: true });
    let reply;
    events.emit(EXECUTION_ADAPTER_REQUEST_CHANNEL, {
        version: EXECUTION_ADAPTER_VERSION, name: "subagent_spawn", reply: (value) => { reply = value; },
    });
    assert.equal(reply.version, EXECUTION_ADAPTER_VERSION);
    assert.deepEqual(Object.keys(reply), ["version", "parameters"], "only the version travels beside the schema");
    assert.equal(reply.parameters, parameters, "the reply carries the exact registered parameters object");
    assert.ok(Object.isFrozen(reply));
    events.clear();
});

test("no reply for a foreign tool, an unknown version, or a malformed request", () => {
    const events = createEventBus();
    const parameters = { type: "object" };
    announceExecutionAdapter({ events }, {
        parametersFor: (name) => name === "subagent_spawn" ? parameters : undefined, runApplication: true,
    });
    const replies = [];
    const reply = (value) => replies.push(value);
    events.emit(EXECUTION_ADAPTER_REQUEST_CHANNEL, { version: EXECUTION_ADAPTER_VERSION, name: "web_search", reply });
    events.emit(EXECUTION_ADAPTER_REQUEST_CHANNEL, { version: 2, name: "subagent_spawn", reply });
    events.emit(EXECUTION_ADAPTER_REQUEST_CHANNEL, { version: EXECUTION_ADAPTER_VERSION, reply });
    events.emit(EXECUTION_ADAPTER_REQUEST_CHANNEL, { version: EXECUTION_ADAPTER_VERSION, name: "subagent_spawn" });
    events.emit(EXECUTION_ADAPTER_REQUEST_CHANNEL, undefined);
    assert.deepEqual(replies, [], "an unsupported tool, a missing reply, or an incompatible version is never admitted");
    events.clear();
});

test("without the guarded direct-application builtin the consumer proves no compatibility", () => {
    // Shell scripts Off is honored by substituting run_application. A vendored task copy
    // without that builtin cannot honor it, so the producer must keep refusing the launch
    // instead of receiving an answer that silently drops the restriction.
    const events = createEventBus();
    announceExecutionAdapter({ events }, { parametersFor: () => ({ type: "object" }), runApplication: false });
    const replies = [];
    events.emit(EXECUTION_ADAPTER_REQUEST_CHANNEL, {
        version: EXECUTION_ADAPTER_VERSION, name: "subagent_spawn", reply: (value) => replies.push(value),
    });
    assert.deepEqual(replies, []);
    events.clear();
});

test("a repeat registration replaces the old schema snapshot and shutdown removes the proof", (t) => {
    const firstSchema = { type: "object", properties: { prompt: { type: "string" } } };
    const first = new Map([["subagent_spawn", firstSchema]]);
    const { pi, shutdownHooks, registered, admit } = producerPipeline(t, first);
    registered.set("subagent_spawn", firstSchema);
    assert.equal(admit("subagent_spawn"), true, "the first load proves its own registration");

    // A reload registers again on the same bus with fresh schema identities, without
    // depending on the previous load's shutdown having run first.
    const secondSchema = { type: "object", properties: { prompt: { type: "string" }, model: { type: "string" } } };
    const second = new Map([["subagent_spawn", secondSchema]]);
    announceExecutionAdapter(pi, { parametersFor: (name) => second.get(name), runApplication: true });
    registered.set("subagent_spawn", secondSchema);
    assert.equal(admit("subagent_spawn"), true, "the newest registration answers");
    registered.set("subagent_spawn", firstSchema);
    assert.equal(admit("subagent_spawn"), false, "the replaced load's schema is no longer served");

    registered.set("subagent_spawn", secondSchema);
    assert.equal(admit("subagent_spawn"), true);
    shutdownHooks.at(-1)();
    assert.equal(admit("subagent_spawn"), false, "shutdown removes compatibility proof");

    // A later load in this process registers again on the same bus and proves its schemas.
    announceExecutionAdapter(pi, { parametersFor: (name) => second.get(name), runApplication: true });
    assert.equal(admit("subagent_spawn"), true, "a later registration re-establishes the proof");
    shutdownHooks.at(-1)();
    assert.equal(admit("subagent_spawn"), false, "and its shutdown removes it again");
});

test("late policy subscription still replays the published profile", () => {
    const { pi } = busFixture();
    observeSandboxPermissions(pi);
    assert.equal(currentSandboxPermissions(pi).subagentPermissions.enabled, true);
});

// ---- real-kernel direct application ------------------------------------------

async function sessionFor(t, policy) {
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({ cwd: policy.root, agentDir: policy.agentDir, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        extensionFactories: [{ name: "task-sandbox", factory: (pi) => taskGuard(pi, policy, (error) => { throw error; }) }] });
    await loader.reload();
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
        modelsPath: join(policy.agentDir, "models.json"), modelsStorePath: join(policy.agentDir, "models-store.json") });
    const { session } = await createAgentSession({ cwd: policy.root, agentDir: policy.agentDir,
        resourceLoader: loader, modelRuntime, settingsManager,
        sessionManager: SessionManager.inMemory(policy.root), noTools: "builtin" });
    t.after(() => session.dispose());
    await session.bindExtensions({});
    return session;
}

async function runTool(session, name, params) {
    const tool = session.agent.state.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} is active`);
    const decision = await session.agent.beforeToolCall?.({ toolCall: { id: "execution-adapter", name, arguments: params }, args: params });
    if (decision?.block) throw new Error(decision.reason);
    return tool.execute("execution-adapter", params, new AbortController().signal);
}

test("a confined direct-only child runs an application and refuses a shell interpreter",
    { skip: !supported || (RUN_APPLICATION_BUILTIN ? false : "the vendored task sandbox has no run_application adapter") }, async (t) => {
        const f = policyFixture(t, { shell: false, commandTimeoutSeconds: 30 });
        f.policy.tools = ["read", RUN_APPLICATION];
        const session = await sessionFor(t, f.policy);
        assert.equal(session.agent.state.tools.some((tool) => tool.name === "bash"), false,
            "Shell Off does not activate bash");
        const direct = await runTool(session, RUN_APPLICATION, {
            executable: process.execPath, args: ["-e", "console.log('direct-ok')"],
        });
        assert.match(JSON.stringify(direct), /direct-ok/);
        await assert.rejects(runTool(session, RUN_APPLICATION, { executable: "/bin/sh", args: ["-c", "echo shell-ok"] }),
            /Shell scripts are Off/);
    });

test("the published command time limit bounds a direct application run",
    { skip: !supported || (RUN_APPLICATION_BUILTIN ? false : "the vendored task sandbox has no run_application adapter") }, async (t) => {
        const f = policyFixture(t, { shell: false, commandTimeoutSeconds: 0.5 });
        f.policy.tools = ["read", RUN_APPLICATION];
        const session = await sessionFor(t, f.policy);
        const started = Date.now();
        await assert.rejects(runTool(session, RUN_APPLICATION, {
            executable: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"],
        }), /timeout|timed out/i);
        assert.ok(Date.now() - started < 8000, "the 0.5 s cap stopped the run, not the 10 s program");
    });
