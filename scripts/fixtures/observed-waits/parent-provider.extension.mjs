/**
 * Offline foreground model for the real parent ExtensionAPI boundary.
 *
 * The parent AgentSession loads the production Background and Subagents
 * extensions plus this file. Its first turn calls the production
 * `subagent_spawn` tool; every later turn only reports that the launch was
 * returned. It never launches a child itself and never fabricates a run id.
 */
import { writeFileSync } from "node:fs";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

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

const provider = {
    baseUrl: "https://example.invalid",
    apiKey: "offline-fixture",
    api: "openai-completions",
    models: [{
        id: "offline",
        name: "Offline parent fixture",
        input: ["text"],
        reasoning: false,
        contextWindow: 128_000,
        maxTokens: 1024,
        cost: COST,
    }],
    streamSimple(model, context) {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
            const messages = context.messages ?? [];
            const alreadySpawned = messages.some((message) =>
                message?.role === "toolResult" && message.toolName === "subagent_spawn");
            if (alreadySpawned) {
                const message = response(model, [{ type: "text", text: "parent already launched the worker" }], "stop");
                stream.push({ type: "done", reason: "stop", message });
                stream.end(message);
                return;
            }
            const project = process.env.ACCEPTANCE_PROJECT;
            const message = response(model, [{
                type: "toolCall",
                id: "acceptance-parent-spawn",
                name: "subagent_spawn",
                arguments: {
                    prompt: [
                        "PARK_FLOW",
                        "Start the controlled background task through the operation bridge, then wait for it.",
                    ].join("\n"),
                    tools: process.env.ACCEPTANCE_WORKER_TOOLS
                        ?? "read,bash,acceptance_offline_model,bg_task_spawn,bg_task_status,bg_task_log,wait_for_operations,acknowledge_operation_result",
                    model: process.env.ACCEPTANCE_CHILD_MODEL ?? "acceptance-offline/offline",
                    callback: false,
                    approve: true,
                    sandbox: false,
                    cwd: project,
                    name: "acceptance-cli-worker",
                },
            }], "toolUse");
            stream.push({ type: "done", reason: "toolUse", message });
            stream.end(message);
        });
        return stream;
    },
};

export default function acceptanceParentModel(pi) {
    pi.registerProvider("acceptance-parent", provider);
    // Record the REAL parent inventory view: the marker tool's source path is
    // what makes the child extension mapping verifiable at the extension
    // boundary rather than from a test-owned module import.
    pi.on("session_start", () => {
        const file = process.env.ACCEPTANCE_PARENT_TRACE;
        if (!file) return;
        try {
            const tools = pi.getAllTools?.() ?? [];
            const marker = tools.find((tool) => tool.name === "acceptance_offline_model");
            writeFileSync(file, JSON.stringify({
                markerSource: marker?.sourceInfo?.path ?? null,
                markerSourceSource: marker?.sourceInfo?.source ?? null,
                tools: tools.map((tool) => tool.name).sort(),
                sawWaitTool: tools.some((tool) => tool.name === "wait_for_operations"),
                sawSpawnTool: tools.some((tool) => tool.name === "subagent_spawn"),
            }, null, 2));
        } catch (error) {
            writeFileSync(file, JSON.stringify({ error: String(error) }));
        }
    });
}

export { provider as parentProvider };
