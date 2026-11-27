/**
 * Deterministic real-SDK worker fixture for scripts/observed-waits.integration.test.mjs.
 *
 * This is NOT a mocked worker: it creates a native `SessionManager`, runs a real
 * `AgentSession` with the production child operation bridge installed over the
 * real unix-socket transport, and uses a deterministic offline model only to
 * decide which bridge tool to call. The model never fabricates tool results.
 *
 * Modes:
 *  - park:   bg_task_spawn -> wait_for_operations (single call, terminate boundary)
 *  - resume: open the SAME saved session, bg_task_status + bg_task_log -> acknowledge
 *
 * Everything the parent asserts on is written to CHILD_RESULT_FILE as JSON.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";

const here = fileURLToPath(new URL(".", import.meta.url));
const operationsModule = new URL("../../../packages/pi-better-subagents/child-operations.ts", import.meta.url).href;
const { installChildOperationBridge } = await import(operationsModule);

const mode = process.env.CHILD_MODE === "resume" ? "resume" : "park";
const workspace = process.env.CHILD_WORKSPACE;
const sessionDir = process.env.CHILD_SESSION_DIR;
const sessionId = process.env.CHILD_SESSION_ID;
const resultFile = process.env.CHILD_RESULT_FILE;
const outcome = process.env.CHILD_OUTCOME === "failure" ? "failure" : "success";
const releaseFile = process.env.CHILD_RELEASE_FILE ?? "";
const promptText = process.env.CHILD_PROMPT ?? (
    mode === "park"
        ? "Start the controlled background task, then wait for its terminal evidence."
        : "Continue the parked assignment."
);

if (!workspace || !sessionDir || !sessionId || !resultFile) {
    throw new Error("worker-session fixture needs CHILD_WORKSPACE, CHILD_SESSION_DIR, CHILD_SESSION_ID and CHILD_RESULT_FILE");
}

const sessionManager = mode === "resume"
    ? SessionManager.open(process.env.CHILD_SESSION_FILE, sessionDir, workspace)
    : SessionManager.create(workspace, sessionDir, { id: sessionId });

const counters = { modelRequests: 0 };
const diagnostics = [];
const toolCalls = [];
let ackToolResult;
let waitToolResult;
let bridgeHandle;

function textOf(message) {
    if (!message || !Array.isArray(message.content)) return "";
    return message.content
        .filter((part) => part && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
}

function toolResultNamed(messages, name) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role === "toolResult" && message.toolName === name) return message;
    }
    return undefined;
}

function lastUserText(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === "user") return textOf(messages[index]);
    }
    return "";
}

function parseJsonText(message) {
    const text = textOf(message);
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/**
 * The successful task is gated by a parent-owned release file, not a guessed
 * duration: the parent can prove the runner is still alive after the worker
 * exits, then release it deterministically. A hard fallback prevents a leaked
 * process if the parent dies.
 */
function taskScript() {
    if (outcome === "failure") {
        return "console.error('controlled-task-failure'); process.exit(3);";
    }
    return [
        "const fs = require('node:fs');",
        `const release = ${JSON.stringify(releaseFile)};`,
        "const started = Date.now();",
        "const timer = setInterval(() => {",
        "  if (release && fs.existsSync(release)) { clearInterval(timer); console.log('controlled-task-complete'); process.exit(0); }",
        "  if (Date.now() - started > 60000) { clearInterval(timer); console.error('controlled-task-release-timeout'); process.exit(4); }",
        "}, 50);",
    ].join("\n");
}

function call(id, name, args) {
    return { type: "toolCall", id, name, arguments: args };
}

function response(model, content, stopReason) {
    return {
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason,
        timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
}

function decide(model, context) {
    const messages = context.messages ?? [];
    counters.modelRequests += 1;
    const request = counters.modelRequests;

    if (mode === "park") {
        if (request === 1) {
            return response(model, [
                call("acceptance-spawn", "bg_task_spawn", {
                    argv: [process.execPath, "-e", taskScript()],
                    shell: false,
                    name: "acceptance-controlled-task",
                    callback: false,
                    cwd: workspace,
                    env: { ACCEPTANCE_RELEASE_FILE: releaseFile },
                }),
            ], "toolUse");
        }
        if (request === 2) {
            const spawned = parseJsonText(toolResultNamed(messages, "bg_task_spawn"));
            const taskId = typeof spawned?.taskId === "string"
                ? spawned.taskId
                : /bgs_[0-9a-f]{20}/.exec(textOf(toolResultNamed(messages, "bg_task_spawn")) ?? "")?.[0];
            if (!taskId) throw new Error("the spawn tool result did not carry a durable task id");
            return response(model, [
                call("acceptance-wait", "wait_for_operations", {
                    task_ids: [taskId],
                    continuation_note: "Read the controlled task evidence and continue the assignment.",
                }),
            ], "toolUse");
        }
        // Reaching here means the SDK did NOT stop at the park boundary.
        return response(model, [{ type: "text", text: "unexpected model request after the wait result" }], "stop");
    }

    if (request === 1) {
        const historyText = messages.map(textOf).join("\n");
        const taskId = /bgs_[0-9a-f]{20}/.exec(historyText)?.[0];
        if (!taskId) throw new Error("the resumed conversation did not contain the parked task id");
        return response(model, [
            call("acceptance-status", "bg_task_status", { id: taskId }),
            call("acceptance-log", "bg_task_log", { id: taskId, lines: 50 }),
        ], "toolUse");
    }
    if (request === 2) {
        const status = parseJsonText(toolResultNamed(messages, "bg_task_status"));
        if (!status || typeof status.operationId !== "string" || typeof status.terminalRevision !== "number") {
            throw new Error(`the status tool result was not terminal evidence: ${textOf(toolResultNamed(messages, "bg_task_status")).slice(0, 300)}`);
        }
        const prompt = lastUserText(messages);
        const waitId = /Durable wait: (\S+) generation (\d+)/.exec(prompt)?.[1];
        const generation = Number(/Durable wait: (\S+) generation (\d+)/.exec(prompt)?.[2] ?? 0);
        if (!waitId || !generation) throw new Error("the resume prompt did not carry the durable wait identity");
        return response(model, [
            call("acceptance-ack", "acknowledge_operation_result", {
                wait_id: waitId,
                generation,
                terminal_revisions: [{ operation_id: status.operationId, revision: status.terminalRevision }],
                disposition: outcome === "failure" ? "blocked" : "assignment-complete",
                note: `interpreted ${String(status.terminalOutcome)} evidence from the saved conversation`,
            }),
        ], "toolUse");
    }
    return response(model, [{
        type: "text",
        text: outcome === "failure"
            ? "read the failed task evidence and acknowledged it as blocked"
            : "read the successful task evidence and acknowledged the assignment complete",
    }], "stop");
}

const provider = {
    baseUrl: "https://example.invalid",
    apiKey: "offline-fixture",
    api: "openai-completions",
    models: [{
        id: "offline",
        name: "Offline acceptance fixture",
        input: ["text"],
        reasoning: false,
        contextWindow: 128_000,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model, context) {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
            try {
                const message = decide(model, context);
                if (message.content.some((part) => part.type === "toolCall")) {
                    for (const part of message.content) {
                        if (part.type === "toolCall") toolCalls.push({ name: part.name, arguments: part.arguments });
                    }
                }
                stream.push({ type: "done", reason: message.stopReason, message });
                stream.end(message);
            } catch (error) {
                const message = response(model, [{ type: "text", text: `fixture decision failed: ${error.message}` }], "error");
                message.errorMessage = error.message;
                stream.push({ type: "error", reason: "error", error: message });
                stream.end(message);
            }
        });
        return stream;
    },
};

const agentDir = process.env.CHILD_AGENT_DIR;
const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: false },
    cacheWarming: { enabled: false },
});
const loader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [{
        name: "acceptance-operation-bridge",
        factory(pi) {
            pi.registerProvider("acceptance-offline", provider);
            bridgeHandle = installChildOperationBridge(pi, {
                handshakeAttempts: 10,
                handshakeRetryDelayMs: 100,
                sessionFileValidator: (file) => file === sessionDir || file.startsWith(`${sessionDir}/`),
                onDiagnostic: (event) => diagnostics.push(event),
            });
        },
    }],
});
await loader.reload();
const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    refreshOnCreate: false,
    modelsPath: `${agentDir}/models.json`,
    modelsStorePath: `${agentDir}/models-store.json`,
});
modelRuntime.registerProvider("acceptance-offline", provider);

let session;
let error;
try {
    const created = await createAgentSession({
        cwd: workspace,
        agentDir,
        settingsManager,
        modelRuntime,
        resourceLoader: loader,
        sessionManager,
        model: modelRuntime.getModel("acceptance-offline", "offline"),
    });
    session = created.session;
    const errors = [];
    await session.bindExtensions({
        onError: (failure) => errors.push(String(failure)),
        shutdownHandler: () => {},
    });
    await session.prompt(promptText);
    await session.waitForIdle();
    const entries = sessionManager.getEntries().filter((entry) => entry.type === "message");
    waitToolResult = entries.map((entry) => entry.message).find((message) => message.role === "toolResult" && message.toolName === "wait_for_operations");
    ackToolResult = entries.map((entry) => entry.message).find((message) => message.role === "toolResult" && message.toolName === "acknowledge_operation_result");
    if (errors.length > 0) error = errors.join("\n");
} catch (failure) {
    error = failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure);
}

const lastMessage = sessionManager.getEntries().filter((entry) => entry.type === "message").at(-1)?.message;
const result = {
    mode,
    outcome,
    workspace,
    cwd: here,
    error,
    modelRequests: counters.modelRequests,
    toolCalls,
    diagnostics: diagnostics.map((event) => ({ event: event.event, code: event.code, message: event.message })),
    bridge: bridgeHandle?.getState(),
    sessionId: sessionManager.getSessionId(),
    sessionFile: sessionManager.getSessionFile(),
    entries: sessionManager.getEntries().map((entry) => entry.type === "message"
        ? {
            type: entry.type,
            role: entry.message.role,
            ...(entry.message.toolName ? { toolName: entry.message.toolName } : {}),
            text: textOf(entry.message).slice(0, 500),
        }
        : { type: entry.type }),
    lastMessage: lastMessage ? { role: lastMessage.role, toolName: lastMessage.toolName } : undefined,
    waitText: waitToolResult ? textOf(waitToolResult).slice(0, 2_000) : undefined,
    ackText: ackToolResult ? textOf(ackToolResult).slice(0, 2_000) : undefined,
};
writeFileSync(resultFile, JSON.stringify(result, null, 2));

try { session?.dispose(); } catch { /* best effort */ }
// Give the bridge client's fire-and-forget socket close a moment to run.
await new Promise((resolve) => setTimeout(resolve, 150));
writeFileSync(1, `${JSON.stringify({
    mode,
    error,
    modelRequests: counters.modelRequests,
    bridgeStatus: result.bridge?.status,
    sessionFile: result.sessionFile,
})}\n`);
process.exit(error ? 1 : 0);
