/**
 * Deterministic offline model extension for the REAL `pi -p` child CLI.
 *
 * The worker launch is told to load this extension through the normal
 * `toolExtensions` config mapping for `acceptance_offline_model`, so the child
 * gets its provider the same way any user-installed provider package would.
 * The marker tool exists only to make that mapping concrete and observable in
 * the parent tool inventory.
 *
 * Modes are derived from the actual conversation, not from a fixture flag:
 *   - a last user turn containing the production resume prompt's
 *     `Durable wait: <id> generation <n>` line is a continuation;
 *   - anything else is the initial worker.
 *
 * The model only chooses which bridge tools to call. Every tool result and
 * terminal verdict comes from the real Background host and the real saved
 * session.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function textOf(message) {
    if (!message || !Array.isArray(message.content)) return "";
    return message.content
        .filter((part) => part && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
}

function lastUserText(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === "user") return textOf(messages[index]);
    }
    return "";
}

/** Assistant requests made after the most recent user message (this turn only). */
function assistantTurnsThisTurn(messages) {
    let turns = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const role = messages[index]?.role;
        if (role === "user") break;
        if (role === "assistant") turns += 1;
    }
    return turns;
}

function toolResultNamed(messages, name) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role === "toolResult" && message.toolName === name) return message;
    }
    return undefined;
}

function parseJsonText(message) {
    try {
        return JSON.parse(textOf(message));
    } catch {
        return undefined;
    }
}

function trace(event) {
    const file = process.env.ACCEPTANCE_CHILD_TRACE;
    if (!file) return;
    try {
        mkdirSync(dirname(file), { recursive: true });
        const line = JSON.stringify({ at: Date.now(), pid: process.pid, ...event });
        // Append without reading the file: the worker and the continuation are
        // separate processes and must not race a read-modify-write.
        writeFileSync(file, `${line}\n`, { flag: "a" });
    } catch { /* tracing is diagnostic only */ }
}

function controlledTaskScript() {
    const release = process.env.ACCEPTANCE_RELEASE_FILE ?? "";
    return [
        "const fs = require('node:fs');",
        `const release = ${JSON.stringify(release)};`,
        "const started = Date.now();",
        "const timer = setInterval(() => {",
        "  if (release && fs.existsSync(release)) { clearInterval(timer); console.log('controlled-task-complete'); process.exit(0); }",
        "  if (Date.now() - started > 90000) { clearInterval(timer); console.error('controlled-task-release-timeout'); process.exit(4); }",
        "}, 50);",
    ].join("\n");
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
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...COST, total: 0 } },
    };
}

function call(id, name, args) {
    return { type: "toolCall", id, name, arguments: args };
}

function decide(model, context) {
    const messages = context.messages ?? [];
    const prompt = lastUserText(messages);
    const waitLine = /Durable wait: (\S+) generation (\d+)/.exec(prompt);
    const historyText = messages.map(textOf).join("\n");
    const taskId = /bgs_[0-9a-f]{20}/.exec(historyText)?.[0];

    const turn = assistantTurnsThisTurn(messages);
    if (!waitLine) {
        if (turn === 0) {
            trace({ mode: "park", step: "spawn" });
            return response(model, [
                call("acceptance-worker-spawn", "bg_task_spawn", {
                    argv: [process.execPath, "-e", controlledTaskScript()],
                    shell: false,
                    name: "acceptance-cli-controlled-task",
                    callback: false,
                    cwd: process.env.ACCEPTANCE_PROJECT,
                    env: { ACCEPTANCE_RELEASE_FILE: process.env.ACCEPTANCE_RELEASE_FILE ?? "" },
                }),
            ], "toolUse");
        }
        if (!taskId) {
            trace({ mode: "park", step: "no-task-id" });
            throw new Error("the initial worker did not receive a durable task id from bg_task_spawn");
        }
        trace({ mode: "park", step: "wait", taskId });
        return response(model, [
            call("acceptance-worker-wait", "wait_for_operations", {
                task_ids: [taskId],
                continuation_note: "Read the controlled CLI task evidence and continue the assignment.",
            }),
        ], "toolUse");
    }

    const waitId = waitLine[1];
    const generation = Number(waitLine[2]);
    if (turn === 0) {
        if (!taskId) {
            trace({ mode: "resume", step: "no-task-id" });
            throw new Error("the continuation conversation did not contain the parked task id");
        }
        trace({ mode: "resume", step: "status-log", taskId, waitId, generation });
        return response(model, [
            call("acceptance-resume-status", "bg_task_status", { id: taskId }),
            call("acceptance-resume-log", "bg_task_log", { id: taskId, lines: 50 }),
        ], "toolUse");
    }
    if (turn === 1) {
        const status = parseJsonText(toolResultNamed(messages, "bg_task_status"));
        if (!status || typeof status.operationId !== "string" || typeof status.terminalRevision !== "number") {
            trace({ mode: "resume", step: "bad-status" });
            throw new Error("the continuation did not receive terminal status evidence");
        }
        const disposition = status.terminalOutcome === "failed" ? "blocked" : "assignment-complete";
        trace({ mode: "resume", step: "ack", waitId, generation, operationId: status.operationId, revision: status.terminalRevision, disposition });
        return response(model, [
            call("acceptance-resume-ack", "acknowledge_operation_result", {
                wait_id: waitId,
                generation,
                terminal_revisions: [{ operation_id: status.operationId, revision: status.terminalRevision }],
                disposition,
                note: `interpreted ${String(status.terminalOutcome)} evidence from the saved CLI conversation`,
            }),
        ], "toolUse");
    }
    trace({ mode: "resume", step: "final" });
    return response(model, [{
        type: "text",
        text: "read the terminal CLI task evidence and acknowledged the saved conversation result",
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
        cost: COST,
    }],
    streamSimple(model, context) {
        const stream = createAssistantMessageEventStream();
        const emit = () => {
            try {
                const message = decide(model, context);
                stream.push({ type: "done", reason: message.stopReason, message });
                stream.end(message);
            } catch (error) {
                const message = response(model, [{ type: "text", text: `fixture decision failed: ${error.message}` }], "error");
                message.errorMessage = error.message;
                trace({ mode: "error", message: error.message });
                stream.push({ type: "error", reason: "error", error: message });
                stream.end(message);
            }
        };
        // A continuation can be held (a) before its first model request, or
        // (b) after the real status/log evidence reads but before the ack call,
        // when the production launcher has already published the claim and
        // spawned the real CLI child. Both windows keep the child alive.
        const messages = context.messages ?? [];
        const lastPrompt = lastUserText(messages);
        const resume = /Durable wait: /.test(lastPrompt);
        const turn = assistantTurnsThisTurn(messages);
        const hold = resume
            ? turn === 0
                ? process.env.ACCEPTANCE_RESUME_GATE
                : turn === 1
                    ? process.env.ACCEPTANCE_RESUME_ACK_GATE
                    : undefined
            : undefined;
        if (hold && !existsSync(hold)) {
            const deadline = Date.now() + 60_000;
            const timer = setInterval(() => {
                if (existsSync(hold) || Date.now() > deadline) {
                    clearInterval(timer);
                    trace({ mode: "resume", step: existsSync(hold) ? "gate-released" : "gate-timeout", gate: turn === 0 ? "first" : "ack" });
                    emit();
                }
            }, 50);
        } else {
            queueMicrotask(emit);
        }
        return stream;
    },
};

export default function acceptanceOfflineModel(pi) {
    pi.registerProvider("acceptance-offline", provider);
    pi.registerTool({
        name: "acceptance_offline_model",
        label: "Offline model marker",
        description: "Marks the deterministic offline provider extension as loaded through normal tool mapping.",
        parameters: { type: "object", additionalProperties: false, properties: {} },
        async execute() {
            return { content: [{ type: "text", text: "acceptance_offline_model loaded" }], details: {} };
        },
    });
}
