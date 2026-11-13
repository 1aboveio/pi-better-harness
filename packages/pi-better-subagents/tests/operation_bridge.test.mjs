// @covers observed-waits.worker-operation-bridge
// @level integration
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createOperationBridgeHost } from "../worker-operations-host.ts";
import {
    completePendingPark,
    createOperationBridgeClient,
    installChildOperationBridge,
    readChildOperationBridgeConfig,
    supportsParkingBoundary,
    verifyDescriptor,
    verifyToolResultCheckpoint,
} from "../child-operations.ts";
import {
    OperationToolError,
    canonicalToolSchema,
    createBridgeDescriptor,
    createToolDescriptor,
    descriptorsForCapabilities,
    normalizeWaitForOperationsResult,
    parseBridgeEndpoint,
    validateJsonSchema,
} from "../operation-bridge-types.ts";

const WORKSPACE = mkdtempSync(join(tmpdir(), "operation-bridge-workspace-"));
process.on("exit", () => { try { rmSync(WORKSPACE, { recursive: true, force: true }); } catch { /* best effort */ } });

function shortSocketPath() {
    for (const base of ["/tmp", "/var/tmp", tmpdir()]) {
        try {
            const root = mkdtempSync(join(base, "op-retry-"));
            const path = join(root, "s.sock");
            if (Buffer.byteLength(path) <= 100) return { root, path };
            rmSync(root, { recursive: true, force: true });
        } catch { /* try the next base */ }
    }
    throw new Error("no short temporary directory for the socket test");
}

function capabilities(overrides = {}) {
    return {
        background: { spawn: true, watch: true, status: true, log: true },
        wait: true,
        acknowledge: true,
        parking: true,
        ...overrides,
    };
}

function spawnSchema() {
    return {
        type: "object",
        additionalProperties: true,
        required: ["command"],
        properties: { command: { type: "string", minLength: 1 } },
    };
}

function registration(overrides = {}) {
    const counters = { spawn: 0, watch: 0, status: 0, log: 0, wait: 0, acknowledge: 0, checkpoint: 0, parkFailed: 0 };
    const caps = overrides.capabilities ?? capabilities();
    const tools = overrides.tools ?? [
        createToolDescriptor("bg_task_spawn", { parameters: spawnSchema(), description: "production spawn schema" }),
        ...descriptorsForCapabilities(caps).filter((tool) => tool.name !== "bg_task_spawn"),
    ];
    const handlers = {
        bg_task_spawn: async (params, context) => {
            counters.spawn += 1;
            return { taskId: "bg_owned_1", text: "started", command: params.command, cwd: context.cwd };
        },
        bg_task_watch: async () => { counters.watch += 1; return { taskId: "bg_owned_1", text: "watching" }; },
        bg_task_status: async (params) => { counters.status += 1; return { taskId: params.id, text: "running" }; },
        bg_task_log: async (params) => { counters.log += 1; return { taskId: params.id, text: "log tail" }; },
        wait_for_operations: async (params) => {
            counters.wait += 1;
            return {
                waitId: "wait-1",
                generation: 1,
                phase: "parking",
                settled: false,
                park: true,
                taskIds: params.task_ids,
                continuationNote: params.continuation_note,
                dependencies: [{ taskId: params.task_ids[0], operationId: "op-1", terminalRevision: 0, terminalOutcome: null }],
            };
        },
        acknowledge_operation_result: async (params) => {
            counters.acknowledge += 1;
            return { waitId: params.wait_id, generation: params.generation, disposition: params.disposition, phase: "consumed" };
        },
        checkpoint: async (params) => { counters.checkpoint += 1; return { recorded: true, waitId: params.wait_id }; },
        park_failed: async (params) => { counters.parkFailed += 1; return { recorded: true, waitId: params.wait_id, reason: params.reason }; },
        ...overrides.handlers,
    };
    return {
        counters,
        run: {
            runId: "run-1",
            conversationId: "conv-1",
            workspace: WORKSPACE,
            authorityReference: "authority:test",
            capabilities: caps,
            tools,
            ownership: overrides.ownership ?? ((taskId) => taskId === "bg_owned_1"),
            ...(overrides.checkpointEvidenceValidator
                ? { checkpointEvidenceValidator: overrides.checkpointEvidenceValidator }
                : {}),
            handlers,
        },
    };
}

async function startHost(options = {}) {
    return await createOperationBridgeHost({
        transport: process.platform === "win32" ? "tcp" : "unix",
        requestTimeoutMs: options.requestTimeoutMs ?? 2_000,
        maxRequestBytes: options.maxRequestBytes ?? 64 * 1024,
        ...options,
    });
}

function clientFor(host, token, overrides = {}) {
    return createOperationBridgeClient({
        endpoint: host.endpoint,
        token,
        runId: "run-1",
        conversationId: "conv-1",
        ...overrides,
    }, { requestTimeoutMs: 4_000 });
}

async function withBridge(runOptions = {}, hostOptions = {}, work) {
    const host = await startHost(hostOptions);
    const fixture = registration(runOptions);
    try {
        const handle = host.registerRun(fixture.run);
        const client = clientFor(host, handle.token);
        try {
            await client.handshake();
            await work({ host, client, handle, fixture });
        } finally {
            await client.close();
        }
    } finally {
        await host.close();
    }
}

function checkpointEvidence(prefix = "a") {
    return {
        version: 1,
        sessionId: "conv-1",
        sessionFile: join(WORKSPACE, "session.jsonl"),
        toolCallId: "call-1",
        waitId: "wait-1",
        generation: 1,
        entryId: "result",
        prefixBytes: 128,
        prefixSha256: prefix.repeat(64),
    };
}

function pendingPark(overrides = {}) {
    return {
        waitId: "wait-1",
        generation: 1,
        toolCallId: "call-1",
        marker: "marker-1",
        taskIds: ["bg_owned_1"],
        continuationNote: "read the result",
        result: {
            waitId: "wait-1",
            generation: 1,
            phase: "parking",
            settled: false,
            park: true,
            taskIds: ["bg_owned_1"],
            dependencies: [],
        },
        ...overrides,
    };
}

function checkpointFixture() {
    const root = mkdtempSync(join(tmpdir(), "operation-checkpoint-"));
    const sessionFile = join(root, "session.jsonl");
    const details = {
        operationWait: {
            waitId: "wait-1",
            generation: 1,
            phase: "parking",
            settled: false,
            park: true,
            taskIds: ["bg_owned_1"],
            dependencies: [],
        },
        operationBridge: { version: 1, marker: "marker-1", waitId: "wait-1", generation: 1, toolCallId: "call-1" },
    };
    const records = [
        { type: "session", version: 3, id: "conv-1", cwd: root },
        {
            type: "message",
            id: "request",
            message: {
                role: "assistant",
                content: [{ type: "toolCall", id: "call-1", name: "wait_for_operations", arguments: { task_ids: ["bg_owned_1"] } }],
            },
        },
        {
            type: "message",
            id: "result",
            message: {
                role: "toolResult",
                toolCallId: "call-1",
                toolName: "wait_for_operations",
                isError: false,
                content: [{ type: "text", text: JSON.stringify(details) }],
                details,
            },
        },
    ];
    writeFileSync(sessionFile, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    return { root, sessionFile, records };
}

describe("worker operation bridge transport", () => {
    it("handshakes with the production spawn schema and routes a launch through the injectable handler", async () => {
        await withBridge({}, {}, async ({ client, fixture }) => {
            assert.equal(client.descriptor?.tools.find((tool) => tool.name === "bg_task_spawn")?.parameters.required?.[0], "command");
            const result = await client.request("bg_task_spawn", { command: "true" });
            assert.equal(result.text, "started");
            assert.equal(result.taskId, "bg_owned_1");
            assert.equal(result.command, "true");
            assert.equal(result.cwd, WORKSPACE, "handlers receive the registered workspace, not a caller authority field");
            assert.equal(fixture.counters.spawn, 1);
        });
    });

    it("refuses invalid credentials before any handler runs", async () => {
        const host = await startHost();
        const fixture = registration();
        try {
            const handle = host.registerRun(fixture.run);
            const wrong = clientFor(host, "x".repeat(43));
            await assert.rejects(() => wrong.handshake(), (error) => error.code === "invalid-token");
            await assert.rejects(
                () => wrong.request("bg_task_status", { id: "bg_owned_1" }),
                (error) => error.code === "invalid-token",
            );
            assert.equal(fixture.counters.spawn + fixture.counters.status + fixture.counters.wait, 0);

            const second = registration();
            const secondHandle = host.registerRun({ ...second.run, runId: "run-2", conversationId: "conv-2" });
            const crossed = createOperationBridgeClient({
                endpoint: host.endpoint,
                token: secondHandle.token,
                runId: "run-1",
                conversationId: "conv-1",
            });
            await assert.rejects(() => crossed.handshake(), (error) => error.code === "invalid-token");
            assert.equal(fixture.counters.status, 0);
            assert.equal(second.counters.status, 0);
            await wrong.close();
            await crossed.close();
            assert.ok(handle.token.length >= 32);
        } finally {
            await host.close();
        }
    });

    it("refuses a foreign task id through the ownership callback and refuses a foreign launched task id", async () => {
        await withBridge({}, {}, async ({ client, fixture }) => {
            await assert.rejects(
                () => client.request("bg_task_status", { id: "bg_foreign" }),
                (error) => error.code === "foreign-task",
            );
            assert.equal(fixture.counters.status, 0);
            const owned = await client.request("bg_task_status", { id: "bg_owned_1" });
            assert.equal(owned.taskId, "bg_owned_1");
            assert.equal(fixture.counters.status, 1);
            await assert.rejects(
                () => client.request("wait_for_operations", { task_ids: ["bg_owned_1", "bg_foreign"], continuation_note: "wait" }),
                (error) => error.code === "foreign-task",
            );
            assert.equal(fixture.counters.wait, 0);
        });

        let foreignSpawnCalls = 0;
        await withBridge({
            handlers: {
                bg_task_spawn: async () => {
                    foreignSpawnCalls += 1;
                    return { taskId: "bg_foreign", text: "should not escape" };
                },
            },
        }, {}, async ({ client }) => {
            await assert.rejects(
                () => client.request("bg_task_spawn", { command: "true" }),
                (error) => error.code === "foreign-result-task",
            );
            assert.equal(foreignSpawnCalls, 1, "the handler is injectable but its foreign result is refused");
        });

        let readCalls = 0;
        let waitCalls = 0;
        await withBridge({
            handlers: {
                bg_task_status: async () => { readCalls += 1; return { taskId: "bg_foreign", text: "foreign log data" }; },
                bg_task_log: async () => { readCalls += 1; return { id: "bg_foreign", text: "foreign log tail" }; },
                wait_for_operations: async () => {
                    waitCalls += 1;
                    return {
                        waitId: "wait-leak",
                        generation: 1,
                        phase: "parking",
                        settled: false,
                        park: true,
                        taskIds: ["bg_foreign"],
                        dependencies: [],
                    };
                },
            },
        }, {}, async ({ client, host }) => {
            await assert.rejects(
                () => client.request("bg_task_status", { id: "bg_owned_1" }),
                (error) => error.code === "foreign-result-task",
            );
            await assert.rejects(
                () => client.request("bg_task_log", { id: "bg_owned_1" }),
                (error) => error.code === "foreign-result-task",
            );
            await assert.rejects(
                () => client.request("wait_for_operations", { task_ids: ["bg_owned_1"], continuation_note: "wait" }),
                (error) => error.code === "foreign-result-task",
            );
            assert.equal(readCalls, 2);
            assert.equal(waitCalls, 1);
            assert.deepEqual(host.getRun("run-1").issuedWaitIds, [], "a refused wait result is not registered");
        });
    });

    it("replays a launch under the same idempotency key without a second handler call and rejects a conflicting replay", async () => {
        await withBridge({}, {}, async ({ client, fixture }) => {
            const first = await client.request("bg_task_spawn", { command: "true" }, { idempotencyKey: "launch-key-1" });
            const replay = await client.request("bg_task_spawn", { command: "true" }, { idempotencyKey: "launch-key-1" });
            assert.deepEqual(replay, first);
            assert.equal(fixture.counters.spawn, 1);
            await assert.rejects(
                () => client.request("bg_task_spawn", { command: "false" }, { idempotencyKey: "launch-key-1" }),
                (error) => error.code === "idempotency-conflict",
            );
            assert.equal(fixture.counters.spawn, 1);
            await client.request("bg_task_spawn", { command: "true" }, { idempotencyKey: "launch-key-2" });
            assert.equal(fixture.counters.spawn, 2);
        });
    });

    it("keeps a consumed launch key after result eviction and never executes it again", async () => {
        await withBridge({}, { maxIdempotencyEntriesPerRun: 1 }, async ({ client, fixture }) => {
            await client.request("bg_task_spawn", { command: "true" }, { idempotencyKey: "key-a" });
            await client.request("bg_task_spawn", { command: "true" }, { idempotencyKey: "key-b" });
            assert.equal(fixture.counters.spawn, 2);
            await assert.rejects(
                () => client.request("bg_task_spawn", { command: "true" }, { idempotencyKey: "key-a" }),
                (error) => error.code === "idempotency-evicted",
            );
            assert.equal(fixture.counters.spawn, 2, "an evicted completed launch must not run again");
            await assert.rejects(
                () => client.request("bg_task_spawn", { command: "false" }, { idempotencyKey: "key-a" }),
                (error) => error.code === "idempotency-conflict",
            );
            assert.equal(fixture.counters.spawn, 2);
        });
    });

    it("rotates and revokes per-run tokens so stale credentials cannot invoke handlers", async () => {
        const host = await startHost();
        const fixture = registration();
        try {
            const handle = host.registerRun(fixture.run);
            const oldClient = clientFor(host, handle.token);
            await oldClient.handshake();
            assert.equal((await oldClient.request("bg_task_status", { id: "bg_owned_1" })).taskId, "bg_owned_1");
            const nextToken = host.rotateRunToken("run-1");
            await assert.rejects(
                () => oldClient.request("bg_task_status", { id: "bg_owned_1" }),
                (error) => error.code === "stale-token",
            );
            assert.equal(fixture.counters.status, 1);

            const nextClient = clientFor(host, nextToken);
            await nextClient.handshake();
            assert.equal((await nextClient.request("bg_task_status", { id: "bg_owned_1" })).taskId, "bg_owned_1");
            host.revokeRun("run-1", "test revocation");
            await assert.rejects(
                () => nextClient.request("bg_task_status", { id: "bg_owned_1" }),
                (error) => error.code === "run-revoked",
            );
            assert.equal(fixture.counters.status, 2);
            assert.throws(() => host.rotateRunToken("run-1"), /revoked/);
            assert.equal(host.getRun("run-1")?.revoked, true);

            const afterRevoke = clientFor(host, nextToken);
            await assert.rejects(() => afterRevoke.handshake(), (error) => error.code === "run-revoked");
            await oldClient.close();
            await nextClient.close();
            await afterRevoke.close();
        } finally {
            await host.close();
        }
    });

    it("returns tool errors, refuses authority fields, cwd escapes, oversized bodies and secrets in results without widening execution", async () => {
        const host = await startHost({ maxRequestBytes: 1_024, requestTimeoutMs: 100 });
        let watchCalls = 0;
        const fixture = registration({
            handlers: {
                bg_task_status: async () => { throw new OperationToolError("the current profile refuses this operation"); },
                bg_task_log: async () => ({ taskId: "bg_owned_1", token: "must-never-reach-the-child" }),
                bg_task_watch: async () => {
                    watchCalls += 1;
                    return await new Promise((resolve) => { setTimeout(() => resolve({ taskId: "bg_owned_1" }), 300); });
                },
            },
        });
        try {
            const handle = host.registerRun(fixture.run);
            const client = clientFor(host, handle.token);
            await client.handshake();
            await assert.rejects(
                () => client.request("bg_task_status", { id: "bg_owned_1" }),
                (error) => error.code === "tool-error" && error.message.includes("profile refuses"),
            );
            await assert.rejects(
                () => client.request("bg_task_status", { id: "bg_owned_1", run_id: "another-run" }),
                (error) => error.code === "authority-field",
            );
            await assert.rejects(
                () => client.request("bg_task_status", { id: "bg_owned_1", cwd: ".." }),
                (error) => error.code === "cwd-outside",
            );
            await assert.rejects(
                () => client.request("bg_task_status", { id: "bg_owned_1", cwd: "missing-directory" }),
                (error) => error.code === "cwd-invalid",
            );
            await assert.rejects(
                () => client.request("bg_task_log", { id: "bg_owned_1" }),
                (error) => error.code === "secret-in-result",
            );
            await assert.rejects(
                () => client.request("bg_task_spawn", {
                    command: "true",
                    env: { PI_BETTER_OPERATIONS_TOKEN: "must-not-reach-a-launched-task" },
                }),
                (error) => error.code === "bridge-env-leak",
            );
            await assert.rejects(
                () => client.request("bg_task_spawn", { command: "x".repeat(4_000) }),
                (error) => error.code === "request-too-large",
            );
            await assert.rejects(
                () => client.request("bg_task_watch", { command: "true" }, { idempotencyKey: "watch-timeout" }),
                (error) => error.code === "handler-timeout",
            );
            await assert.rejects(
                () => client.request("bg_task_watch", { command: "true" }, { idempotencyKey: "watch-timeout" }),
                (error) => error.code === "launch-outcome-unknown",
            );
            await assert.rejects(
                () => client.request("bash", { command: "echo widened" }),
                (error) => ["invalid-request", "unsupported-method"].includes(error.code),
            );
            assert.equal(fixture.counters.spawn, 0, "oversized request never reached the launch handler");
            assert.equal(watchCalls, 1, "handler timed out after the host accepted it");
            assert.equal(client.descriptor?.tools.length, 6);
            assert.ok(client.descriptor?.tools.every((tool) => tool.name !== "bg_task_stop"));
            await client.close();
        } finally {
            await host.close();
        }
    });

    it("records a checkpoint only for a wait generation issued to this run", async () => {
        await withBridge({}, {}, async ({ client, fixture }) => {
            const wait = await client.request("wait_for_operations", {
                task_ids: ["bg_owned_1"],
                continuation_note: "read the result",
            });
            assert.equal(wait.waitId, "wait-1");
            assert.equal(fixture.counters.wait, 1);
            await assert.rejects(
                () => client.request("checkpoint", {
                    wait_id: "wait-other",
                    generation: 1,
                    tool_call_id: "call-1",
                    evidence: checkpointEvidence(),
                }),
                (error) => error.code === "unknown-wait",
            );
            const recorded = await client.request("checkpoint", {
                wait_id: "wait-1",
                generation: 1,
                tool_call_id: "call-1",
                evidence: checkpointEvidence(),
            });
            assert.equal(recorded.recorded, true);
            assert.equal(fixture.counters.checkpoint, 1);
            await assert.rejects(
                () => client.request("checkpoint", {
                    wait_id: "wait-1",
                    generation: 1,
                    tool_call_id: "call-1",
                    evidence: { ...checkpointEvidence(), prefixSha256: "not-a-hash" },
                }),
                (error) => error.code === "checkpoint-invalid",
            );
        });
    });


async function realSdkParkingSession(t, { batch = false, bashEnvCheck = false, settled = false } = {}) {
    const root = mkdtempSync(join(tmpdir(), "operation-sdk-parking-"));
    const agentDir = join(root, "agent");
    const sessionDir = join(root, "sessions");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    const counters = { modelRequests: 0, checkpoint: 0, parkFailed: 0, shutdowns: 0 };
    const diagnostics = [];
    const host = await createOperationBridgeHost({ requestTimeoutMs: 4_000 });
    const sessionManager = SessionManager.create(root, sessionDir);
    const conversationId = sessionManager.getSessionId();
    const handle = host.registerRun({
        runId: "run-real",
        conversationId,
        workspace: root,
        authorityReference: "test:real-sdk",
        capabilities: {
            background: { spawn: false, watch: false, status: false, log: false },
            wait: true,
            acknowledge: false,
            parking: true,
        },
        tools: [createToolDescriptor("wait_for_operations")],
        ownership: (taskId) => taskId === "bg_1",
        handlers: {
            wait_for_operations: async () => ({
                waitId: "wait-real",
                generation: 1,
                phase: "parking",
                settled,
                park: true,
                taskIds: ["bg_1"],
                dependencies: settled ? [{ taskId: "bg_1", terminalRevision: 1, terminalOutcome: "succeeded" }] : [],
            }),
            checkpoint: async () => { counters.checkpoint += 1; return { recorded: true }; },
            park_failed: async () => { counters.parkFailed += 1; return { recorded: true }; },
        },
    });
    const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const provider = {
        baseUrl: "https://example.invalid",
        apiKey: "offline-fixture",
        api: "openai-completions",
        models: [{ id: "offline", name: "Offline fixture", input: ["text"], reasoning: false,
            contextWindow: 128_000, maxTokens: 1024, cost }],
        streamSimple(model) {
            const stream = createAssistantMessageEventStream();
            counters.modelRequests += 1;
            const first = counters.modelRequests === 1;
            const content = bashEnvCheck && first
                ? [{
                    type: "toolCall",
                    id: "real-bash-call",
                    name: "bash",
                    arguments: { command: "printf '%s' \"${PI_BETTER_OPERATIONS_TOKEN:-missing}\"" },
                }]
                : first
                    ? [
                        { type: "toolCall", id: "real-wait-call", name: "wait_for_operations",
                            arguments: { task_ids: ["bg_1"], continuation_note: "read the result" } },
                        ...(batch ? [{ type: "toolCall", id: "real-other-call", name: "other_work", arguments: {} }] : []),
                    ]
                    : [{ type: "text", text: bashEnvCheck ? "checked environment" : "continued after wait" }];
            const response = {
                role: "assistant",
                content,
                api: model.api,
                provider: model.provider,
                model: model.id,
                stopReason: first ? "toolUse" : "stop",
                timestamp: Date.now(),
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...cost, total: 0 } },
            };
            queueMicrotask(() => {
                stream.push({ type: "done", reason: response.stopReason, message: response });
                stream.end(response);
            });
            return stream;
        },
    };
    const settingsManager = SettingsManager.inMemory({
        retry: { enabled: false },
        compaction: { enabled: false },
        cacheWarming: { enabled: false },
    });
    const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        refreshOnCreate: false,
        modelsPath: join(agentDir, "models.json"),
        modelsStorePath: join(agentDir, "models-store.json"),
    });
    modelRuntime.registerProvider("real-parking-test", provider);
    const trustedRoot = realpathSync(sessionDir);
    const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [{
            name: "operation-bridge-under-test",
            factory(pi) {
                pi.registerProvider("real-parking-test", provider);
                if (batch) {
                    pi.registerTool({
                        name: "other_work",
                        label: "Other work",
                        description: "Deterministic parallel fixture",
                        parameters: Type.Object({}),
                        async execute() {
                            return { content: [{ type: "text", text: "other work done" }], details: undefined };
                        },
                    });
                }
                installChildOperationBridge(pi, {
                    config: {
                        endpoint: host.endpoint,
                        token: handle.token,
                        runId: "run-real",
                        conversationId,
                    },
                    handshakeAttempts: 1,
                    sessionFileValidator: (file) => file === trustedRoot || file.startsWith(`${trustedRoot}/`),
                    onDiagnostic: (event) => diagnostics.push(event),
                });
            },
        }],
    });
    await loader.reload();
    const { session } = await createAgentSession({
        cwd: root,
        agentDir,
        settingsManager,
        modelRuntime,
        resourceLoader: loader,
        sessionManager,
        model: modelRuntime.getModel("real-parking-test", "offline"),
        ...(bashEnvCheck ? {} : { noTools: "builtin" }),
    });
    const errors = [];
    await session.bindExtensions({
        onError: (error) => errors.push(String(error)),
        shutdownHandler: () => { counters.shutdowns += 1; },
    });
    t.after(async () => {
        await session.abort().catch(() => {});
        try { await session._extensionRunner.emit({ type: "session_shutdown" }); } catch { /* best effort */ }
        session.dispose();
        await host.close();
        rmSync(root, { recursive: true, force: true });
    });
    return { session, sessionManager, counters, diagnostics, errors };
}

    it("lets the parent reject checkpoint evidence before any checkpoint handler runs", async () => {
        await withBridge({
            checkpointEvidenceValidator: (evidence) => evidence.sessionId === "conv-trusted",
        }, {}, async ({ client, fixture }) => {
            await client.request("wait_for_operations", {
                task_ids: ["bg_owned_1"],
                continuation_note: "read the result",
            });
            await assert.rejects(
                () => client.request("checkpoint", {
                    wait_id: "wait-1",
                    generation: 1,
                    tool_call_id: "call-1",
                    evidence: checkpointEvidence(),
                }),
                (error) => error.code === "checkpoint-invalid" && /rejected/.test(error.message),
            );
            assert.equal(fixture.counters.checkpoint, 0);
        });
    });

    it("certifies only a saved wait tool result and fails closed when the checkpoint is missing or changed", () => {
        const fixture = checkpointFixture();
        try {
            const pending = pendingPark();
            const ctx = {
                sessionManager: {
                    getEntries: () => fixture.records,
                    getSessionId: () => "conv-1",
                    getSessionFile: () => fixture.sessionFile,
                },
                shutdown: () => { throw new Error("shutdown must not run during verification"); },
            };
            const verified = verifyToolResultCheckpoint({ pending, ctx });
            assert.equal(verified.certified, true);
            assert.equal(verified.evidence.entryId, "result");
            assert.equal(verified.evidence.prefixBytes > 0, true);

            const trusted = verifyToolResultCheckpoint({ pending, ctx, sessionFileValidator: () => true });
            assert.equal(trusted.certified, true);
            const untrustedPath = verifyToolResultCheckpoint({ pending, ctx, sessionFileValidator: () => false });
            assert.equal(untrustedPath.certified, false);
            assert.match(untrustedPath.reason, /trusted native-session path/);

            const stale = verifyToolResultCheckpoint({ pending: pendingPark({ marker: "wrong-marker" }), ctx });
            assert.equal(stale.certified, false);
            assert.match(stale.reason, /park request/);

            const writeRecords = (mutate) => {
                const records = JSON.parse(JSON.stringify(fixture.records));
                mutate(records);
                writeFileSync(fixture.sessionFile, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
            };
            writeRecords((records) => {
                records[2].message.toolName = "bash";
                records[2].message.isError = true;
            });
            assert.equal(verifyToolResultCheckpoint({ pending, ctx }).certified, false, "a disk result from another tool cannot certify parking");
            writeRecords((records) => { records[2].message.isError = true; });
            assert.equal(verifyToolResultCheckpoint({ pending, ctx }).certified, false, "a disk error result cannot certify parking");
            writeRecords((records) => { records[2].message.details.operationBridge.marker = "another-marker"; });
            assert.equal(verifyToolResultCheckpoint({ pending, ctx }).certified, false, "a disk marker from another park request cannot certify parking");
            writeRecords((records) => { records[1].message.content[0].name = "bash"; });
            assert.equal(verifyToolResultCheckpoint({ pending, ctx }).certified, false, "a disk call from another tool cannot certify parking");
            writeRecords((records) => {
                records.push({ type: "message", id: "after", message: { role: "assistant", content: [{ type: "text", text: "continued" }] } });
            });
            assert.equal(verifyToolResultCheckpoint({ pending, ctx }).certified, false, "a later batched message cannot certify parking");
            writeFileSync(fixture.sessionFile, `${fixture.records.map((record) => JSON.stringify(record)).join("\n")}\n`);

            const missing = verifyToolResultCheckpoint({
                pending,
                ctx: {
                    sessionManager: {
                        getEntries: () => fixture.records.slice(0, -1),
                        getSessionId: () => "conv-1",
                        getSessionFile: () => fixture.sessionFile,
                    },
                    shutdown: () => {},
                },
            });
            assert.equal(missing.certified, false);
            assert.match(missing.reason, /native session view|last persisted/);

            const laterMemory = verifyToolResultCheckpoint({
                pending,
                ctx: {
                    sessionManager: {
                        getEntries: () => [
                            ...fixture.records,
                            { type: "message", id: "after-memory", message: { role: "assistant", content: [{ type: "text", text: "continued" }] } },
                        ],
                        getSessionId: () => "conv-1",
                        getSessionFile: () => fixture.sessionFile,
                    },
                    shutdown: () => {},
                },
            });
            assert.equal(laterMemory.certified, false, "a later tool or assistant message prevents parking");

            truncateSync(fixture.sessionFile, 10);
            const truncated = verifyToolResultCheckpoint({ pending, ctx });
            assert.equal(truncated.certified, false);
        } finally {
            rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it("signals the host checkpoint before requesting shutdown and reports park failure without shutdown", async () => {
        const calls = [];
        const client = {
            request: async (method) => {
                calls.push(method);
                return { recorded: true };
            },
        };
        let shutdowns = 0;
        const ctx = { sessionManager: { getEntries: () => [], getSessionId: () => "conv-1", getSessionFile: () => undefined }, shutdown: () => { shutdowns += 1; } };
        const good = await completePendingPark({
            pending: pendingPark(),
            ctx,
            client,
            verifier: () => ({ certified: true, evidence: checkpointEvidence() }),
        });
        assert.equal(good.parked, true);
        assert.deepEqual(calls, ["checkpoint"]);
        assert.equal(shutdowns, 1);

        calls.length = 0;
        shutdowns = 0;
        const bad = await completePendingPark({
            pending: pendingPark(),
            ctx,
            client,
            verifier: () => ({ certified: false, reason: "tool result was not flushed" }),
        });
        assert.equal(bad.parked, false);
        assert.deepEqual(calls, ["park_failed"]);
        assert.equal(shutdowns, 0);

        calls.length = 0;
        shutdowns = 0;
        const denied = await completePendingPark({
            pending: pendingPark(),
            ctx,
            client: { request: async (method) => { calls.push(method); throw new Error("parent refused checkpoint"); } },
            verifier: () => ({ certified: true, evidence: checkpointEvidence() }),
        });
        assert.equal(denied.parked, false);
        assert.equal(denied.checkpointRecorded, undefined);
        assert.deepEqual(calls, ["checkpoint", "park_failed"]);
        assert.equal(shutdowns, 0);

        calls.length = 0;
        let shutdownAttempts = 0;
        const shutdownFailure = await completePendingPark({
            pending: pendingPark(),
            ctx: {
                sessionManager: { getEntries: () => [], getSessionId: () => "conv-1", getSessionFile: () => undefined },
                shutdown: () => { shutdownAttempts += 1; throw new Error("SDK refused shutdown"); },
            },
            client,
            verifier: () => ({ certified: true, evidence: checkpointEvidence() }),
        });
        assert.equal(shutdownFailure.parked, false);
        assert.equal(shutdownFailure.checkpointRecorded, true);
        assert.equal(shutdownAttempts, 1);
        assert.deepEqual(calls, ["checkpoint", "park_failed"]);
        assert.match(shutdownFailure.reason, /clean shutdown/);
    });

    it("blocks SDK tool dispatch after a park request and refuses bridge credentials in child launch params", async () => {
        const caps = {
            background: { spawn: true, watch: false, status: false, log: false },
            wait: true,
            acknowledge: false,
            parking: true,
        };
        const descriptor = createBridgeDescriptor(
            "run-ex",
            "conv-ex",
            [createToolDescriptor("bg_task_spawn"), createToolDescriptor("wait_for_operations")],
            caps,
            { maxRequestBytes: 65_536, maxResponseBytes: 65_536, requestTimeoutMs: 2_000 },
        );
        const requests = [];
        const fakeClient = {
            endpoint: "unix:///dummy",
            config: {
                endpoint: "unix:///dummy",
                token: "t".repeat(43),
                runId: "run-ex",
                conversationId: "conv-ex",
            },
            descriptor,
            handshake: async () => descriptor,
            request: async (method, params) => {
                requests.push({ method, params });
                if (method === "wait_for_operations") {
                    return {
                        waitId: "wait-batch",
                        generation: 1,
                        phase: "parking",
                        settled: false,
                        park: true,
                        taskIds: ["bg_1"],
                        dependencies: [],
                    };
                }
                return { taskId: "bg_1", text: "ok" };
            },
            close: async () => {},
        };
        const handlers = new Map();
        const tools = new Map();
        const pi = {
            on: (name, handler) => handlers.set(name, handler),
            registerTool: (tool) => tools.set(tool.name, tool),
        };
        const handle = installChildOperationBridge(pi, {
            config: fakeClient.config,
            clientFactory: () => fakeClient,
            handshakeAttempts: 1,
        });
        const ctx = {
            sessionManager: { getEntries: () => [], getSessionId: () => "conv-ex", getSessionFile: () => undefined },
            shutdown: () => {},
        };
        await handlers.get("session_start")({}, ctx);
        assert.equal(tools.size, 2);

        const leaked = await tools.get("bg_task_spawn").execute(
            "call-env",
            { command: "true", env: { PI_BETTER_OPERATIONS_TOKEN: "must-not-reach-a-task" } },
            undefined,
            undefined,
            ctx,
        );
        assert.equal(leaked.isError, true);
        assert.match(leaked.content[0].text, /refusing to pass/);
        assert.equal(requests.some((request) => request.method === "bg_task_spawn"), false);

        const wait = await tools.get("wait_for_operations").execute(
            "call-batch",
            { task_ids: ["bg_1"], continuation_note: "wait" },
            undefined,
            undefined,
            ctx,
        );
        assert.equal(wait.details.operationWait.park, true);
        assert.equal(handle.getState().status, "parking");
        const blocked = handlers.get("tool_call")({ toolName: "bash", input: {} });
        assert.equal(blocked.block, true);
        assert.match(blocked.reason, /park/i);
        assert.equal(handlers.get("tool_call")({ toolName: "wait_for_operations", input: {} }).block, true);
        handlers.get("session_shutdown")?.();
    });

    it("retries an interrupted launch once with the same idempotency key and re-handshakes", async () => {
        const caps = {
            background: { spawn: true, watch: false, status: false, log: false },
            wait: false,
            acknowledge: false,
            parking: false,
        };
        const descriptor = createBridgeDescriptor(
            "run-retry",
            "conv-retry",
            [createToolDescriptor("bg_task_spawn")],
            caps,
            { maxRequestBytes: 65_536, maxResponseBytes: 65_536, requestTimeoutMs: 2_000 },
        );
        const seen = [];
        const server = createServer((socket) => {
            let buffer = "";
            socket.on("data", (chunk) => {
                buffer += chunk.toString("utf8");
                let newline = buffer.indexOf("\n");
                while (newline >= 0) {
                    const line = buffer.slice(0, newline);
                    buffer = buffer.slice(newline + 1);
                    if (line) {
                        const request = JSON.parse(line);
                        if (request.method === "handshake") {
                            socket.write(`${JSON.stringify({ v: 1, id: request.id, ok: true, result: descriptor })}\n`);
                        } else if (request.method === "bg_task_spawn") {
                            seen.push({ key: request.key, id: request.id });
                            if (seen.length === 1) {
                                socket.destroy();
                                return;
                            }
                            socket.write(`${JSON.stringify({
                                v: 1,
                                id: request.id,
                                ok: true,
                                result: { taskId: "bg_1", text: "retried once" },
                            })}\n`);
                        }
                    }
                    newline = buffer.indexOf("\n");
                }
            });
        });
        let root;
        let endpoint;
        if (process.platform === "win32") {
            await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
            endpoint = `tcp://127.0.0.1:${server.address().port}`;
        } else {
            const socket = shortSocketPath();
            root = socket.root;
            await new Promise((resolveListen, rejectListen) => {
                server.once("error", rejectListen);
                server.listen(socket.path, resolveListen);
            });
            endpoint = `unix://${socket.path}`;
        }
        const client = createOperationBridgeClient({
            endpoint,
            token: "t".repeat(43),
            runId: "run-retry",
            conversationId: "conv-retry",
        }, { requestTimeoutMs: 2_000 });
        try {
            const result = await client.request(
                "bg_task_spawn",
                { command: "true" },
                { idempotencyKey: "retry-key" },
            );
            assert.equal(result.text, "retried once");
            assert.equal(seen.length, 2);
            assert.equal(seen[0].key, "retry-key");
            assert.equal(seen[1].key, "retry-key");
            assert.notEqual(seen[0].id, seen[1].id);
        } finally {
            await client.close();
            await new Promise((resolveClose) => server.close(resolveClose));
            if (root) rmSync(root, { recursive: true, force: true });
        }
    });

    it("reads only complete parent-owned child environment and rejects a handshake that could add tools", () => {
        const config = {
            endpoint: "unix:///tmp/operations.sock",
            token: "t".repeat(43),
            runId: "run-1",
            conversationId: "conv-1",
        };
        assert.equal(readChildOperationBridgeConfig({}).status, "disabled");
        assert.equal(readChildOperationBridgeConfig({ PI_BETTER_OPERATIONS_ENDPOINT: config.endpoint }).status, "invalid");
        const ready = readChildOperationBridgeConfig({
            PI_BETTER_OPERATIONS_ENABLED: "1",
            PI_BETTER_OPERATIONS_ENDPOINT: config.endpoint,
            PI_BETTER_OPERATIONS_TOKEN: config.token,
            PI_BETTER_OPERATIONS_RUN_ID: config.runId,
            PI_BETTER_OPERATIONS_CONVERSATION_ID: config.conversationId,
        });
        assert.equal(ready.status, "ready");
        assert.equal(ready.config.token, config.token);

        const descriptor = {
            bridgeVersion: 1,
            runId: "run-1",
            conversationId: "conv-1",
            tools: [createToolDescriptor("bg_task_spawn")],
            capabilities: capabilities({ parking: false, wait: false }),
            limits: { maxRequestBytes: 1_000, maxResponseBytes: 1_000, requestTimeoutMs: 1_000 },
        };
        descriptor.fingerprint = "0".repeat(64);
        assert.throws(() => verifyDescriptor(descriptor, config), /fingerprint/);
        const withExtra = {
            ...descriptor,
            tools: [...descriptor.tools, { name: "bash", label: "Bash", description: "not bridge owned", parameters: { type: "object" } }],
            fingerprint: "1".repeat(64),
        };
        assert.throws(() => verifyDescriptor(withExtra, config), /allowlist/);
    });

    it("normalizes a coordinator-shaped wait record without trusting nested fields as authority", () => {
        const normalized = normalizeWaitForOperationsResult({
            wait: {
                waitId: "wait-9",
                generation: 2,
                phase: "registering",
                park: { attemptId: "attempt-1", checkpointId: "checkpoint-1" },
                settled: false,
                continuationNote: "read the terminal evidence",
                dependencies: [{ operationId: "op-1", terminalRevision: 0, terminalOutcome: null }],
                origin: { taskIds: ["bg_owned_1"] },
            },
        });
        assert.equal(normalized.ok, true);
        assert.equal(normalized.result.waitId, "wait-9");
        assert.equal(normalized.result.park, true);
        assert.deepEqual(normalized.result.taskIds, ["bg_owned_1"]);
        assert.equal(normalized.result.continuationNote, "read the terminal evidence");
        const leak = normalizeWaitForOperationsResult({ wait: { waitId: "wait-9", generation: 2, token: "secret" } });
        assert.equal(leak.ok, false);
    });


    it("hides bridge credentials around tool execution and withholds wait on an unsupported SDK version", async () => {
        const tokenKey = "PI_BETTER_OPERATIONS_TOKEN";
        const original = process.env[tokenKey];
        process.env[tokenKey] = "bridge-secret-should-not-leak";
        try {
            assert.equal(supportsParkingBoundary("0.82.0"), false);
            assert.equal(supportsParkingBoundary("0.82.1"), true);
            assert.equal(supportsParkingBoundary("1.4.0"), true);
            assert.equal(supportsParkingBoundary(""), false);

            const caps = {
                background: { spawn: false, watch: false, status: false, log: false },
                wait: true,
                acknowledge: false,
                parking: true,
            };
            const descriptor = createBridgeDescriptor(
                "run-env",
                "conv-env",
                [createToolDescriptor("wait_for_operations")],
                caps,
                { maxRequestBytes: 65_536, maxResponseBytes: 65_536, requestTimeoutMs: 2_000 },
            );
            const config = {
                endpoint: "unix:///dummy",
                token: "t".repeat(43),
                runId: "run-env",
                conversationId: "conv-env",
            };
            const fakeClient = {
                endpoint: config.endpoint,
                config,
                descriptor,
                handshake: async () => descriptor,
                request: async () => ({ recorded: true }),
                close: async () => {},
            };
            const handlers = new Map();
            const tools = new Map();
            const diagnostics = [];
            const pi = {
                on: (name, handler) => handlers.set(name, handler),
                registerTool: (tool) => tools.set(tool.name, tool),
            };
            const installed = installChildOperationBridge(pi, {
                config,
                sdkVersion: "0.82.1",
                clientFactory: () => fakeClient,
                handshakeAttempts: 1,
                onDiagnostic: (event) => diagnostics.push(event),
            });
            await handlers.get("session_start")({}, {});
            assert.equal(tools.has("wait_for_operations"), true);
            handlers.get("tool_execution_start")({ toolName: "bash" });
            handlers.get("tool_execution_start")({ toolName: "other_work" });
            assert.equal(process.env[tokenKey], undefined, "the token is hidden before a command runs");
            assert.equal(installed.getState().bridgeEnvironmentHidden, true);
            handlers.get("tool_execution_end")({ toolName: "bash" });
            assert.equal(process.env[tokenKey], undefined, "a parallel tool keeps the token hidden");
            handlers.get("tool_execution_end")({ toolName: "other_work" });
            assert.equal(process.env[tokenKey], "bridge-secret-should-not-leak");
            assert.equal(installed.getState().bridgeEnvironmentHidden, false);
            handlers.get("session_shutdown")?.();

            const oldHandlers = new Map();
            const oldTools = new Map();
            const oldPi = {
                on: (name, handler) => oldHandlers.set(name, handler),
                registerTool: (tool) => oldTools.set(tool.name, tool),
            };
            const oldInstalled = installChildOperationBridge(oldPi, {
                config,
                sdkVersion: "0.82.0",
                clientFactory: () => fakeClient,
                handshakeAttempts: 1,
                onDiagnostic: (event) => diagnostics.push(event),
            });
            await oldHandlers.get("session_start")({}, {});
            assert.equal(oldTools.has("wait_for_operations"), false);
            assert.equal(oldInstalled.getState().parkingSupported, false);
            assert.ok(diagnostics.some((event) => event.event === "parking-unsupported"));
            oldHandlers.get("session_shutdown")?.();
        } finally {
            if (original === undefined) delete process.env[tokenKey];
            else process.env[tokenKey] = original;
        }
    });


    it("keeps running when a wait result is already settled", async () => {
        const caps = {
            background: { spawn: false, watch: false, status: false, log: false },
            wait: true,
            acknowledge: false,
            parking: true,
        };
        const descriptor = createBridgeDescriptor(
            "run-settled",
            "conv-settled",
            [createToolDescriptor("wait_for_operations")],
            caps,
            { maxRequestBytes: 65_536, maxResponseBytes: 65_536, requestTimeoutMs: 2_000 },
        );
        const config = {
            endpoint: "unix:///dummy",
            token: "t".repeat(43),
            runId: "run-settled",
            conversationId: "conv-settled",
        };
        const fakeClient = {
            endpoint: config.endpoint,
            config,
            descriptor,
            handshake: async () => descriptor,
            request: async () => ({
                waitId: "wait-settled",
                generation: 1,
                phase: "ready",
                settled: true,
                park: true,
                taskIds: ["bg_1"],
                dependencies: [{ taskId: "bg_1", terminalRevision: 1, terminalOutcome: "succeeded" }],
            }),
            close: async () => {},
        };
        const handlers = new Map();
        const tools = new Map();
        const pi = {
            on: (name, handler) => handlers.set(name, handler),
            registerTool: (tool) => tools.set(tool.name, tool),
        };
        const installed = installChildOperationBridge(pi, {
            config,
            sdkVersion: "0.82.1",
            clientFactory: () => fakeClient,
            handshakeAttempts: 1,
        });
        await handlers.get("session_start")({}, {});
        const result = await tools.get("wait_for_operations").execute(
            "call-settled",
            { task_ids: ["bg_1"], continuation_note: "read the result" },
            undefined,
            undefined,
            {},
        );
        assert.equal(result.terminate, undefined, "a settled wait must not terminate the run");
        assert.equal(installed.getState().pendingPark, undefined);
        assert.equal(installed.getState().status, "ready");
        assert.equal(handlers.get("tool_call")({ toolName: "bash", input: {} }), undefined);
        handlers.get("session_shutdown")?.();
    });

    it("stops a real AgentSession before the next model request and certifies the saved wait result", { timeout: 20_000 }, async (t) => {
        assert.equal(supportsParkingBoundary(VERSION), true, `installed SDK ${VERSION} has the terminate boundary`);
        const fixture = await realSdkParkingSession(t, { batch: false });
        await fixture.session.prompt("Wait for the operation");
        await fixture.session.waitForIdle();
        assert.equal(fixture.counters.modelRequests, 1, "the tool result must terminate before a second model request");
        assert.equal(fixture.counters.checkpoint, 1, "the real host must receive one checkpoint");
        assert.equal(fixture.counters.parkFailed, 0);
        assert.equal(fixture.counters.shutdowns, 1, "the public SDK shutdown handler must run");
        assert.deepEqual(fixture.errors, []);
        const messages = fixture.sessionManager.getEntries()
            .filter((entry) => entry.type === "message")
            .map((entry) => entry.message);
        const last = messages.at(-1);
        assert.equal(last.role, "toolResult");
        assert.equal(last.toolName, "wait_for_operations");
        assert.equal(last.isError, false);
        assert.equal(messages.some((message) =>
            message.role === "assistant" && Array.isArray(message.content) &&
            message.content.some((part) => part.type === "text" && /continued after wait/.test(part.text))), false);
        const sessionFile = fixture.sessionManager.getSessionFile();
        assert.ok(sessionFile);
        assert.match(readFileSync(sessionFile, "utf8"), /wait_for_operations/);
    });

    it("parks a settled wait until the active writer has checkpointed and exited", { timeout: 20_000 }, async (t) => {
        const fixture = await realSdkParkingSession(t, { settled: true });
        await fixture.session.prompt("Wait for the already settled operation");
        await fixture.session.waitForIdle();
        assert.equal(fixture.counters.modelRequests, 1, "the writer must not continue while its wait is parking");
        assert.equal(fixture.counters.checkpoint, 1);
        assert.equal(fixture.counters.parkFailed, 0);
        assert.equal(fixture.counters.shutdowns, 1);
        assert.deepEqual(fixture.errors, []);
    });

    it("refuses parking when a wait shares a real SDK tool batch with another call", { timeout: 20_000 }, async (t) => {
        const fixture = await realSdkParkingSession(t, { batch: true });
        await fixture.session.prompt("Try a batched wait");
        await fixture.session.waitForIdle();
        assert.equal(fixture.counters.modelRequests, 2, "a refused batched wait must not terminate the run");
        assert.equal(fixture.counters.checkpoint, 0);
        assert.equal(fixture.counters.parkFailed, 0);
        assert.equal(fixture.counters.shutdowns, 0);
        const messages = fixture.sessionManager.getEntries()
            .filter((entry) => entry.type === "message")
            .map((entry) => entry.message);
        const waitResult = messages.find((message) => message.role === "toolResult" && message.toolName === "wait_for_operations");
        assert.ok(waitResult);
        assert.equal(waitResult.isError, true);
        const text = waitResult.content.map((part) => part.text ?? "").join("\n");
        assert.match(text, /only tool call/);
    });

    it("removes bridge credentials from an unconfined real SDK bash execution", { timeout: 20_000 }, async (t) => {
        const tokenKey = "PI_BETTER_OPERATIONS_TOKEN";
        const original = process.env[tokenKey];
        process.env[tokenKey] = "bridge-secret-should-not-leak";
        t.after(() => {
            if (original === undefined) delete process.env[tokenKey];
            else process.env[tokenKey] = original;
        });
        const fixture = await realSdkParkingSession(t, { bashEnvCheck: true });
        if (!fixture.session.agent.state.tools.some((tool) => tool.name === "bash")) {
            t.skip("the installed SDK has no bash tool in this environment");
            return;
        }
        await fixture.session.prompt("Check the environment");
        await fixture.session.waitForIdle();
        assert.equal(fixture.counters.modelRequests, 2);
        assert.equal(fixture.counters.checkpoint, 0);
        assert.equal(fixture.counters.shutdowns, 0);
        const messages = fixture.sessionManager.getEntries()
            .filter((entry) => entry.type === "message")
            .map((entry) => entry.message);
        const bashResult = messages.find((message) => message.role === "toolResult" && message.toolName === "bash");
        assert.ok(bashResult);
        const output = bashResult.content.map((part) => part.text ?? "").join("\n");
        assert.match(output, /missing/);
        assert.doesNotMatch(output, /bridge-secret-should-not-leak/);
        assert.equal(process.env[tokenKey], "bridge-secret-should-not-leak", "the environment is restored after the tool boundary");
    });

    it("lets a finished foreground process exit naturally while an accepted bridge connection is idle", { timeout: 20_000 }, async (t) => {
        const root = mkdtempSync(join(tmpdir(), "operation-bridge-exit-"));
        const hostModuleUrl = new URL("../worker-operations-host.ts", import.meta.url).href;
        const scriptPath = join(root, "exit-probe.mjs");
        writeFileSync(scriptPath, `
            import { createOperationBridgeHost } from ${JSON.stringify(hostModuleUrl)};
            const host = await createOperationBridgeHost({ transport: process.platform === "win32" ? "tcp" : "unix" });
            const handle = host.registerRun({
                runId: "run-exit",
                conversationId: "conv-exit",
                workspace: ${JSON.stringify(root)},
                authorityReference: "test:exit",
                capabilities: {
                    background: { spawn: false, watch: false, status: false, log: false },
                    wait: false,
                    acknowledge: false,
                    parking: false,
                },
                tools: [],
                ownership: () => false,
                handlers: {},
            });
            process.stdout.write(JSON.stringify({ endpoint: host.endpoint, token: handle.token }) + "\\n");
            await new Promise((resolve) => {
                process.stdin.setEncoding("utf8");
                process.stdin.once("data", resolve);
            });
            process.stdin.pause();
            process.stdin.unref?.();
            process.stdout.write("finished\\n");
            // Deliberately no host.close(): the foreground process must exit naturally.
        `);
        const child = spawn(process.execPath, ["--import", "tsx", scriptPath], {
            cwd: process.cwd(),
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
        child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
        let socket;
        try {
            const info = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`bridge host did not announce its endpoint: ${stderr}`)), 8_000);
                child.stdout.once("data", (chunk) => {
                    clearTimeout(timer);
                    try { resolve(JSON.parse(chunk.toString("utf8").split("\n")[0])); }
                    catch (error) { reject(error); }
                });
            });
            const endpoint = parseBridgeEndpoint(info.endpoint);
            socket = endpoint.kind === "unix"
                ? connect({ path: endpoint.path })
                : connect({ host: endpoint.host, port: endpoint.port });
            await new Promise((resolve, reject) => {
                socket.once("connect", resolve);
                socket.once("error", reject);
            });
            child.stdin.write("finish\n");
            const exit = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    child.kill("SIGKILL");
                    reject(new Error(`bridge host stayed alive after main work: ${stderr}`));
                }, 8_000);
                child.once("exit", (code, signal) => {
                    clearTimeout(timer);
                    resolve({ code, signal });
                });
            });
            assert.equal(exit.code, 0, `child exit ${JSON.stringify(exit)} stderr=${stderr} stdout=${stdout}`);
            assert.match(stdout, /finished/);
        } finally {
            socket?.destroy();
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("uses the small JSON Schema validator for production-shaped constraints", () => {
        assert.equal(validateJsonSchema(canonicalToolSchema("wait_for_operations"), { task_ids: ["bg_1"], continuation_note: "next" }).ok, true);
        const missing = validateJsonSchema(canonicalToolSchema("wait_for_operations"), { task_ids: [] });
        assert.equal(missing.ok, false);
        assert.match(missing.message, /fewer|required/);
        assert.equal(validateJsonSchema(canonicalToolSchema("acknowledge_operation_result"), {
            wait_id: "wait-1",
            generation: 1,
            terminal_revisions: [{ operation_id: "op-1", revision: 1 }],
            disposition: "continue",
            note: "read",
        }).ok, true);
        assert.equal(validateJsonSchema(canonicalToolSchema("acknowledge_operation_result"), {
            wait_id: "wait-1",
            generation: 1,
            terminal_revisions: [{ operation_id: "op-1", revision: 1 }],
            disposition: "accepted-by-nobody",
            note: "read",
        }).ok, false);

        const unsupportedNot = validateJsonSchema({ not: { $ref: "#/$defs/denied" } }, {});
        assert.equal(unsupportedNot.ok, false);
        assert.equal(unsupportedNot.schemaError, true);
        assert.match(unsupportedNot.message, /unsupported schema keyword \$ref/);

        const unsupportedAnyOf = validateJsonSchema({ anyOf: [{ type: "string" }, { $ref: "#/$defs/x" }] }, "matches the first branch");
        assert.equal(unsupportedAnyOf.ok, false);
        assert.equal(unsupportedAnyOf.schemaError, true);

        const unsupportedOneOf = validateJsonSchema({ oneOf: [{ type: "string" }, { $ref: "#/$defs/x" }] }, "matches the first branch");
        assert.equal(unsupportedOneOf.ok, false);
        assert.equal(unsupportedOneOf.schemaError, true);

        const unvisitedBranch = validateJsonSchema({
            not: { type: "object", properties: { hidden: { $ref: "#/$defs/x" } } },
        }, {});
        assert.equal(unvisitedBranch.ok, false);
        assert.equal(unvisitedBranch.schemaError, true);

        assert.equal(validateJsonSchema({ not: { type: "string" } }, "forbidden").ok, false);
        assert.equal(validateJsonSchema({ not: { type: "string" } }, 42).ok, true);
    });
});
