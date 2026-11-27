/**
 * Deterministic offline model for the kernel-confined worker acceptance.
 *
 * Loaded into the real Pi child as an ordinary extension. It registers one
 * provider/model whose stream is produced locally from the phase encoded in the
 * environment, so the acceptance exercises the real SDK, the real task guard,
 * the real bridge transport and real kernel-confined command execution without
 * any network or provider credentials.
 *
 * Phases:
 * - `fresh`: launch three supervised tasks (a read-only command, a write outside
 *   the workspace, a TCP connect), then wait on all of them so the worker parks.
 * - `resume`: read every former task's evidence, acknowledge the interpretation,
 *   and finish.
 */
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = "worker-kernel-fixture";
const MODEL = "offline";
const TASK_ID = /bgs_[0-9a-f]{20}/g;

interface MessageLike {
    role?: string;
    content?: Array<{ type?: string; text?: string; name?: string }>;
}

function transcriptText(context: unknown): string {
    const messages = (context as { messages?: MessageLike[] } | undefined)?.messages ?? [];
    const parts: string[] = [];
    for (const message of messages) {
        for (const part of message.content ?? []) {
            if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
        }
    }
    return parts.join("\n");
}

function discoveredTaskIds(context: unknown): string[] {
    const ids = transcriptText(context).match(TASK_ID) ?? [];
    return [...new Set(ids)];
}

function response(model: { api: string; provider: string; id: string }, content: unknown[]) {
    return {
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: content.some((part) => (part as { type?: string }).type === "toolCall") ? "toolUse" : "stop",
        timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
}

export default function fakeModel(pi: ExtensionAPI): void {
    const phase = process.env.WORKER_KERNEL_PHASE === "resume" ? "resume" : "fresh";
    const workspace = process.env.WORKER_KERNEL_WORKSPACE ?? process.cwd();
    const outside = process.env.WORKER_KERNEL_OUTSIDE ?? `${workspace}/../outside.txt`;
    const networkUrl = process.env.WORKER_KERNEL_NETWORK_URL ?? "";
    let turn = 0;
    const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const provider = {
        baseUrl: "https://example.invalid",
        apiKey: "offline-fixture",
        api: "openai-completions" as const,
        models: [{
            id: MODEL,
            name: "Worker kernel fixture",
            input: ["text"] as const,
            reasoning: false,
            contextWindow: 128_000,
            maxTokens: 2_048,
            cost,
        }],
        streamSimple(model: { api: string; provider: string; id: string }, context?: unknown) {
            turn += 1;
            const stream = createAssistantMessageEventStream();
            let content: unknown[];
            if (phase === "fresh") {
                if (turn === 1) {
                    content = [
                        {
                            type: "toolCall",
                            id: "kernel-spawn-read",
                            name: "bg_task_spawn",
                            arguments: { argv: ["/bin/sh", "-c", "printf kernel-read-ok"], shell: false, name: "kernel-read" },
                        },
                        {
                            type: "toolCall",
                            id: "kernel-spawn-write",
                            name: "bg_task_spawn",
                            arguments: {
                                argv: ["/bin/sh", "-c", "printf escape > \"$1\"; printf mutation > \"$2\"", "kernel-write", outside, `${workspace}/blocked-write.txt`],
                                shell: false,
                                name: "kernel-write",
                            },
                        },
                        {
                            type: "toolCall",
                            id: "kernel-spawn-net",
                            name: "bg_task_spawn",
                            arguments: {
                                argv: ["/usr/bin/curl", "--noproxy", "*", "--fail", "--silent", "--show-error", "--connect-timeout", "2", networkUrl],
                                shell: false,
                                name: "kernel-net",
                            },
                        },
                    ];
                    if (process.env.WORKER_SDK_ONLY === "1") content = [{
                        type: "toolCall", id: "sdk-spawn", name: "bg_task_spawn",
                        arguments: { argv: [process.execPath, "-e", process.env.WORKER_KERNEL_FAILED_TEST === "1" ? "setTimeout(() => { console.error('test assertion failed'); process.exitCode = 1; }, 1500)" : "setTimeout(() => console.log('sdk-evidence'), 1500)"], shell: false },
                    }];
                } else if (turn === 2) {
                    const taskIds = discoveredTaskIds(context);
                    content = taskIds.length > 0
                        ? [{
                            type: "toolCall",
                            id: "kernel-wait",
                            name: "wait_for_operations",
                            arguments: { task_ids: taskIds, continuation_note: "Read every kernel task result, then continue packaging." },
                        }]
                        : [{ type: "text", text: "no supervised task was launched" }];
                } else {
                    content = [{ type: "text", text: "parked pending the kernel tasks" }];
                }
            } else if (process.env.WORKER_KERNEL_UNACK === "1") {
                content = [{ type: "text", text: "Useful retained output, without interpreting the dependency." }];
            } else if (turn === 1) {
                const taskIds = (process.env.WORKER_KERNEL_TASKS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
                content = taskIds.map((id, index) => ({
                    type: "toolCall",
                    id: `kernel-status-${index}`,
                    name: "bg_task_status",
                    arguments: { id },
                }));
                if (content.length === 0) content = [{ type: "text", text: "no former task to inspect" }];
            } else if (turn === 2) {
                content = [{
                    type: "toolCall",
                    id: "kernel-ack",
                    name: "acknowledge_operation_result",
                    arguments: {
                        wait_id: process.env.WORKER_KERNEL_WAIT_ID ?? "",
                        generation: Number(process.env.WORKER_KERNEL_GENERATION ?? 1),
                        terminal_revisions: JSON.parse(process.env.WORKER_KERNEL_REVISIONS ?? "{}"),
                        disposition: "assignment-complete",
                        note: process.env.WORKER_KERNEL_FAILED_TEST === "1" ? "I inspected the failed test's exact terminal revision; this assigned diagnosis is complete." : process.env.WORKER_SDK_ONLY === "1" ? "The dependency succeeded; I inspected its exact terminal revision." : "The read-only build succeeded; the write and network attempts were denied, which is the expected confined result.",
                    },
                }];
            } else {
                content = [{ type: "text", text: "assignment complete after interpreting the kernel evidence" }];
            }
            const answer = response(model, content);
            queueMicrotask(() => {
                stream.push({ type: "done", reason: answer.stopReason, message: answer });
                stream.end(answer);
            });
            return stream;
        },
    };
    pi.registerProvider(PROVIDER, provider as never);
}
