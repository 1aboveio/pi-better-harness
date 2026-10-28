import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import {
    createEventBus, discoverAndLoadExtensions, ExtensionRunner, SessionManager,
    type ExtensionAPI, type ModelRegistry, type ToolDefinition, type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { createBackgroundAdmission } from "../background-admission.ts";
import { defaultSandboxPermissions, type SandboxPermissionSettings } from "../permissions.ts";
import { SESSION_PERMISSION_ENTRY } from "../session-permissions.ts";
import { realBackendSkip } from "./support/resolvable-backend.ts";
// Keep the optional peer outside this package's stricter TypeScript project.
// The integration tests below also load the peer through Pi's real loader.
const { registerTools } = await import(new URL("../../pi-better-background-tasks/src/tools.ts", import.meta.url).href) as {
    registerTools(pi: ExtensionAPI): void;
};
const { readMeta, writeMeta } = await import(new URL("../../pi-better-background-tasks/src/registry.ts", import.meta.url).href) as {
    readMeta(id: string): TestMeta | undefined;
    writeMeta(meta: TestMeta): void;
};
const BACKGROUND_ADAPTER_REQUEST = "pi-better-background-tasks:adapter-request";
type TestMeta = {
    id: string; kind: "process"; status: string; startedAt: number; endedAt?: number;
    cwd: string; logPath: string; spawnPid: number; callback: boolean;
    stopRequestedAt?: number; dismissedAt?: number;
    ssh?: { host: string; target: string; options: Record<string, string> };
    remote?: { command: string; session: "tmux"; sessionName: string };
    sandbox?: { confinement: string; policySource: string };
};

const fixture = realpathSync(mkdtempSync(join(realpathSync("/var/tmp"), "background-admission-")));
const originalTmp = tmpdir();
const oldEnv = { agent: process.env.PI_CODING_AGENT_DIR, tmp: process.env.TMPDIR, temp: process.env.TEMP, tmpAlias: process.env.TMP,
    recovery: process.env.PI_SANDBOX_RECOVERY_SNAPSHOT };
const scratch = realpathSync(mkdtempSync(join(originalTmp, "background-admission-runtime-")));
process.env.PI_CODING_AGENT_DIR = join(fixture, "agent");
process.env.TMPDIR = scratch;
process.env.TEMP = scratch;
process.env.TMP = scratch;
process.env.PI_SANDBOX_RECOVERY_SNAPSHOT = "off";
after(() => {
    for (const [name, value] of Object.entries({ PI_CODING_AGENT_DIR: oldEnv.agent, TMPDIR: oldEnv.tmp, TEMP: oldEnv.temp, TMP: oldEnv.tmpAlias,
        PI_SANDBOX_RECOVERY_SNAPSHOT: oldEnv.recovery })) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(fixture, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
});
const sandboxEntry = fileURLToPath(new URL("../index.ts", import.meta.url));
const backgroundEntry = fileURLToPath(new URL("../../pi-better-background-tasks/src/index.ts", import.meta.url));
const wrapperEntry = fileURLToPath(new URL("../../pi-better-harness/extensions/background-tasks/index.ts", import.meta.url));
const backendSkip = realBackendSkip();
let sequence = 0;

function settings(main: boolean, background: boolean, mainCommands = true, backgroundCommands = true) {
    const result = defaultSandboxPermissions();
    Object.assign(result.main, { enabled: main, commands: mainCommands });
    Object.assign(result.background, { enabled: background, commands: backgroundCommands });
    return result;
}

async function harness(config: SandboxPermissionSettings, backgroundFirst = false, compatible = true) {
    const root = join(fixture, `project-${++sequence}`);
    mkdirSync(root);
    const session = SessionManager.inMemory(root);
    const setPolicy = (permissions: SandboxPermissionSettings) => session.appendCustomEntry(SESSION_PERMISSION_ENTRY, { version: 1, permissions });
    setPolicy(config);
    const events = createEventBus();
    const paths = compatible ? (backgroundFirst ? [backgroundEntry, sandboxEntry] : [sandboxEntry, backgroundEntry]) : [sandboxEntry];
    const loaded = await discoverAndLoadExtensions(paths, root, join(fixture, "empty-agent"), events);
    assert.deepEqual(loaded.errors, []);
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, session, {} as ModelRegistry);
    loaded.runtime.getAllTools = () => runner.getAllRegisteredTools().map(({ definition, sourceInfo }) => ({
        name: definition.name, description: definition.description, parameters: definition.parameters, sourceInfo,
    }));
    loaded.runtime.getActiveTools = () => runner.getAllRegisteredTools().map(({ definition }) => definition.name);
    loaded.runtime.sendMessage = () => {};
    const errors: unknown[] = [];
    runner.onError((error) => errors.push(error));
    await runner.emit({ type: "session_start", reason: "startup" });
    assert.deepEqual(errors, []);
    const gate = (name: string, input: Record<string, unknown> = {}) => runner.emitToolCall({ type: "tool_call", toolName: name, toolCallId: "admission-test", input });
    const execute = async (name: string, input: Record<string, unknown>) => {
        const refusal = await gate(name, input);
        if (refusal?.block) return { blocked: true, text: refusal.reason ?? "Tool call blocked" };
        const tool = runner.getToolDefinition(name);
        assert.ok(tool);
        const result = await tool.execute("admission-test", input, undefined, undefined, runner.createContext());
        return { blocked: false, text: result.content.map((part) => part.type === "text" ? part.text : "").join("\n") };
    };
    return { root, runner, loaded, events, gate, execute, async policy(next: SandboxPermissionSettings) {
        setPolicy(next);
        await runner.emit({ type: "session_tree", newLeafId: session.getLeafId(), oldLeafId: null });
    }, async close() { await runner.emit({ type: "session_shutdown", reason: "reload" }); events.clear(); } };
}

function metadata(id: string, root: string, remote = false): TestMeta {
    return {
        id, kind: "process", status: "succeeded", startedAt: 1, endedAt: 2,
        cwd: root, logPath: join(root, `${id}.log`), spawnPid: process.pid, callback: false,
        ...(remote ? { ssh: { host: "example.invalid", target: "example.invalid", options: {} },
            remote: { command: "true", session: "tmux", sessionName: "admission-test" } } : {}),
    };
}

// These use Pi's loader, provenance records and ExtensionRunner.emitToolCall,
// including both the shared admission gate and the later Main permission gate.
for (const backgroundFirst of [false, true]) test(`all handlers admit only implemented local/registry operations (backgroundFirst=${backgroundFirst})`, { skip: backendSkip }, async () => {
    const h = await harness(settings(true, true, false, true), backgroundFirst);
    try {
        const local = metadata(`local-${sequence}`, h.root);
        const remote = metadata(`remote-${sequence}`, h.root, true);
        remote.status = "running";
        delete remote.endedAt;
        writeFileSync(local.logPath, "local log\n");
        writeMeta(local);
        writeMeta(remote);
        for (const [name, input] of [
            ["bg_task_spawn", { command: "true" }], ["bg_task_watch", { command: "true" }],
            ["bg_task", { action: "spawn", command: "true" }], ["bg_task", { action: "watch", command: "true" }],
            ["bg_task_list", {}], ["bg_task_status", { id: local.id }], ["bg_task_log", { id: local.id }],
            ["bg_task_stop", { id: local.id, ssh: { host: "caller-assertion-is-ignored" } }],
            ...["list", "status", "log", "stop", "clear"].flatMap((action) => [
                ["bg_task", { action, id: local.id }], ["bg_status", { action, id: local.id }],
            ]),
        ] as Array<[string, Record<string, unknown>]>) assert.equal((await h.gate(name, input))?.block, undefined, `${name} ${JSON.stringify(input)}`);
        for (const [name, input] of [
            ["bg_task", { action: "batch" }], ["bg_status", { action: "spawn" }], ["bg_task_clear", {}],
            ["bg_task_stop", { id: remote.id, remote: false, ssh: false }],
            ["bg_task", { action: "stop", id: remote.id }], ["bg_status", { action: "stop", id: remote.id }],
            ["bg_task_stop", { id: "missing" }],
            ["bg_task_spawn", { command: "true", ssh: { host: "example.invalid" } }],
            ["bash", { command: "true" }], ["unverified", {}],
        ] as Array<[string, Record<string, unknown>]>) assert.equal((await h.gate(name, input))?.block, true, `${name} ${JSON.stringify(input)}`);
        assert.equal(readMeta(remote.id)?.stopRequestedAt, undefined);
        assert.equal((await h.execute("bg_task", { action: "clear", id: local.id, all: true })).blocked, false);
        assert.ok(readMeta(local.id)?.dismissedAt);
    } finally { await h.close(); }
});

test("Main Off still blocks old, missing, and incompatible background consumers when Background is On", async () => {
    const h = await harness(settings(false, true), false, false);
    const marker = join(h.root, "old-consumer-ran");
    const extension = h.loaded.extensions[0]!;
    const parameters = { type: "object", properties: {} } as ToolDefinition["parameters"];
    for (const name of ["bg_task_spawn", "bg_task_watch", "bg_task"]) extension.tools.set(name, {
        definition: { name, label: name, description: name, parameters, async execute() { writeFileSync(marker, "unsafe"); return { content: [], details: undefined }; } },
        sourceInfo: { ...extension.sourceInfo, path: backgroundEntry },
    });
    try {
        for (const version of [undefined, 0, 2]) {
            const unsubscribe = h.events.on(BACKGROUND_ADAPTER_REQUEST, (request) => {
                if (version !== undefined) (request as { reply(value: unknown): void }).reply({ version, parameters, admission: "local-launch" });
            });
            for (const [name, input] of [["bg_task_spawn", {}], ["bg_task_watch", {}], ["bg_task", { action: "spawn" }], ["bg_task", { action: "watch" }]] as Array<[string, Record<string, unknown>]>) {
                assert.equal((await h.execute(name, input)).blocked, true);
            }
            unsubscribe();
        }
        assert.equal(existsSync(marker), false);
        await h.policy(settings(false, false));
        assert.equal((await h.execute("bg_task_spawn", {})).blocked, false);
        assert.equal(readFileSync(marker, "utf8"), "unsafe");
    } finally { await h.close(); }
});

test("schema and canonical source must belong to the current registration, including reload and wrapper entries", () => {
    const events = createEventBus();
    const tools = new Map<string, ToolDefinition>();
    let source: string | undefined = backgroundEntry;
    let schemaOverride: object | undefined;
    const shutdown: Array<() => void> = [];
    const pi = {
        events, registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
        on(name: string, handler: () => void) { if (name === "session_shutdown") shutdown.push(handler); },
        getAllTools: () => [...tools.values()].map((definition) => ({ ...definition,
            parameters: schemaOverride ?? definition.parameters, sourceInfo: source ? { path: source } : undefined })) as unknown as ToolInfo[],
    } as unknown as ExtensionAPI;
    const admit = createBackgroundAdmission(pi);
    assert.equal(admit("bg_task_spawn", {}), undefined);
    registerTools(pi);
    const oldSchemas = new Map([...tools].map(([name, tool]) => [name, tool.parameters]));
    assert.equal(admit("bg_task_spawn", {}), "local-launch");
    for (const untrusted of [undefined, "<inline:background>", "relative/src/index.ts", sandboxEntry, join(fixture, "spoof/src/index.ts")]) {
        source = untrusted;
        assert.equal(admit("bg_task_spawn", {}), undefined);
    }
    source = wrapperEntry;
    assert.equal(admit("bg_task_spawn", {}), "local-launch");
    const alias = join(fixture, "background-entry-alias.ts");
    symlinkSync(backgroundEntry, alias);
    source = alias;
    assert.equal(admit("bg_task_spawn", {}), "local-launch");
    source = backgroundEntry;
    schemaOverride = { ...tools.get("bg_task_spawn")!.parameters };
    assert.equal(admit("bg_task_spawn", {}), undefined);
    schemaOverride = undefined;
    for (const handler of shutdown) handler();
    assert.equal(admit("bg_task_spawn", {}), undefined);
    registerTools(pi);
    for (const [name, tool] of tools) assert.notEqual(tool.parameters, oldSchemas.get(name), `${name} gets a fresh reload identity`);
    schemaOverride = oldSchemas.get("bg_task_spawn");
    assert.equal(admit("bg_task_spawn", {}), undefined);
    schemaOverride = undefined;
    assert.equal(admit("bg_task_spawn", {}), "local-launch");
    const replaceDuringHandshake = events.on(BACKGROUND_ADAPTER_REQUEST, () => { schemaOverride = {}; });
    assert.equal(admit("bg_task_spawn", {}), undefined);
    replaceDuringHandshake();
    events.clear();
});

test("restricted Background execution requires controls support on the current schema", () => {
    const events = createEventBus();
    const tools = new Map<string, ToolDefinition>();
    const oldParameters = { type: "object", properties: {} } as ToolDefinition["parameters"];
    tools.set("bg_task_spawn", { name: "bg_task_spawn", label: "Old spawn", description: "Old spawn",
        parameters: oldParameters, async execute() { throw new Error("not executed"); } });
    const pi = { events, on() {}, registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
        getAllTools: () => [...tools.values()].map((tool) => ({ name: tool.name, description: tool.description,
            parameters: tool.parameters, sourceInfo: { path: backgroundEntry } })) } as unknown as ExtensionAPI;
    const legacy = events.on(BACKGROUND_ADAPTER_REQUEST, (input) => (input as { reply(value: unknown): void }).reply({
        version: 1, parameters: oldParameters, admission: "local-launch",
    }));
    assert.equal(createBackgroundAdmission(pi)("bg_task_spawn", {}), "local-launch");
    const restricted = createBackgroundAdmission(pi, () => true);
    assert.equal(restricted("bg_task_spawn", {}), undefined, "an old adapter cannot ignore a shell/time restriction");
    legacy();
    registerTools(pi);
    assert.equal(restricted("bg_task_spawn", {}), "local-launch", "the new adapter proves controls support with its exact schema");
    const current = tools.get("bg_task_spawn")!;
    tools.set("bg_task_spawn", { ...current, parameters: { ...current.parameters } });
    assert.equal(restricted("bg_task_spawn", {}), undefined);
    events.clear();
});

test("all handlers block replaced/spoofed registrations before their bodies execute", { skip: backendSkip }, async () => {
    const h = await harness(settings(true, true));
    try {
        const owner = h.loaded.extensions.find((extension) => extension.path === backgroundEntry)!;
        const original = owner.tools.get("bg_task_spawn")!;
        const marker = join(h.root, "spoof-ran");
        const replacement = { ...original.definition, async execute() { writeFileSync(marker, "unsafe"); return { content: [], details: undefined }; } };
        for (const registered of [
            { ...original, definition: { ...replacement, parameters: { ...original.definition.parameters } } },
            { ...original, definition: replacement, sourceInfo: { ...original.sourceInfo, path: sandboxEntry } },
            { ...original, definition: replacement, sourceInfo: { ...original.sourceInfo, path: "<inline:spoof>" } },
        ]) {
            owner.tools.set("bg_task_spawn", registered);
            assert.equal((await h.execute("bg_task_spawn", { command: "true" })).blocked, true);
        }
        assert.equal(existsSync(marker), false);
        owner.tools.set("bg_task_spawn", original);
        assert.equal((await h.gate("bg_task_spawn", { command: "true" }))?.block, undefined);
    } finally { await h.close(); }
});

test("registry reads, local stop, and clear still execute after commands are turned off in both profiles", { skip: backendSkip }, async () => {
    const h = await harness(settings(true, true, false, true));
    let id: string | undefined;
    try {
        const launched = await h.execute("bg_task_spawn", { command: "sleep 60", callback: false });
        id = launched.text.match(/bg_[a-z0-9_]+/)?.[0];
        assert.ok(id, launched.text);
        assert.equal(readMeta(id)?.status, "running");
        await h.policy(settings(true, true, false, false));
        const status = await h.execute("bg_status", { action: "status", id });
        assert.equal(status.blocked, false);
        assert.match(status.text, /running/);
        assert.equal((await h.execute("bg_task_list", {})).blocked, false);
        assert.equal((await h.execute("bg_task_log", { id })).blocked, false);
        const stopped = await h.execute("bg_task_stop", { id });
        assert.equal(stopped.blocked, false, stopped.text);
        assert.equal((await terminal(id)).status, "cancelled");
        const cleared = await h.execute("bg_status", { action: "clear", id });
        assert.equal(cleared.blocked, false, cleared.text);
        assert.ok(readMeta(id)?.dismissedAt);
    } finally {
        if (id && readMeta(id)?.status === "running") await h.execute("bg_task_stop", { id });
        await h.close();
    }
});

async function terminal(id: string): Promise<TestMeta> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        const meta = readMeta(id);
        if (meta && meta.status !== "running") return meta;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`task did not finish: ${JSON.stringify(readMeta(id))}`);
}

for (const backgroundFirst of [false, true]) test(`real kernel honors Background independently of Main through all handlers (backgroundFirst=${backgroundFirst})`, { skip: backendSkip }, async () => {
    const h = await harness(settings(true, true, false, true), backgroundFirst);
    const outside = join(fixture, `outside-${sequence}`);
    mkdirSync(outside);
    try {
        for (const [index, [name, action]] of ([ ["bg_task_spawn", undefined], ["bg_task_watch", undefined], ["bg_task", "spawn"], ["bg_task", "watch"] ] as const).entries()) {
            const allowed = join(h.root, `allowed-${index}`);
            const denied = join(outside, `denied-${index}`);
            const result = await h.execute(name, { ...(action ? { action } : {}),
                command: `printf inside > '${allowed}'; printf outside > '${denied}' 2>/dev/null; printf DONE`, callback: false,
                ...((action === "watch" || name === "bg_task_watch") ? { success_when: { type: "stdout_contains", value: "DONE" } } : {}),
            });
            assert.equal(result.blocked, false, result.text);
            const id = result.text.match(/bg_[a-z0-9_]+/)?.[0];
            assert.ok(id, result.text);
            const meta = await terminal(id);
            assert.equal(meta.status, "succeeded");
            assert.equal(meta.sandbox?.confinement, "confined");
            assert.equal(meta.sandbox?.policySource, "background");
            assert.equal(readFileSync(allowed, "utf8"), "inside");
            assert.equal(existsSync(denied), false);
        }
        await h.policy(settings(false, true, true, true));
        const mainOff = await h.execute("bg_task_spawn", { command: `printf outside > '${join(outside, "main-off")}'`, callback: false });
        const mainOffId = mainOff.text.match(/bg_[a-z0-9_]+/)?.[0];
        assert.ok(mainOffId, mainOff.text);
        assert.equal((await terminal(mainOffId)).sandbox?.confinement, "confined");
        assert.equal(existsSync(join(outside, "main-off")), false);
        for (const main of [false, true]) {
            await h.policy(settings(main, true, true, false));
            const blocked = await h.execute("bg_task_spawn", { command: `printf bad > '${join(h.root, "blocked")}'`, callback: false });
            assert.match(blocked.text, /disables commands/);
            assert.equal(existsSync(join(h.root, "blocked")), false);
        }
        for (const main of [true, false]) {
            await h.policy(settings(main, false));
            const controlPath = join(outside, `control-${main}`);
            const control = await h.execute("bg_task_spawn", { command: `printf outside > '${controlPath}'`, callback: false });
            const controlId = control.text.match(/bg_[a-z0-9_]+/)?.[0];
            assert.ok(controlId, control.text);
            assert.equal((await terminal(controlId)).sandbox?.confinement, "unconfined");
            assert.equal(readFileSync(controlPath, "utf8"), "outside");
        }
    } finally { await h.close(); }
});
