/**
 * Test-only Pi extension: a scripted local model provider plus a `gate` tool
 * that blocks until the test releases it. The provider is deterministic and
 * logs every request's message roles so tests can see exactly what each LLM
 * call was given. The session around it is a real Pi AgentSession.
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Read lazily: in-process tests point these at a fresh directory per test.
const gateDir = () => process.env.PI_FAKE_GATE_DIR ?? "";
const logFile = () => process.env.PI_FAKE_LOG ?? "";

function textOf(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: { type?: string; text?: string }) => (part.type === "text" ? part.text ?? "" : "")).join("");
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("fake", {
    baseUrl: "http://127.0.0.1:1",
    apiKey: "fake-key",
    api: "fake-api" as never,
    models: [{ id: "fake-1", name: "Fake 1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const messages = context.messages as Array<{ role: string; content?: unknown; toolName?: string }>;
      if (logFile()) {
        appendFileSync(logFile(), `${JSON.stringify({ at: Date.now(), messages: messages.map((m) => ({ role: m.role, text: textOf(m) })) })}\n`);
      }
      const last = messages[messages.length - 1];
      const text = last ? textOf(last) : "";
      let content: Array<{ type: "text"; text: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }>;
      let stopReason: "stop" | "toolUse" = "stop";
      if (last?.role === "user" && text.startsWith("tool ")) {
        content = [{ type: "toolCall", id: `call-${Date.now()}`, name: "gate", arguments: { name: text.slice(5).trim() } }];
        stopReason = "toolUse";
      } else if (last?.role === "toolResult") {
        content = [{ type: "text", text: `tool-done:${text}` }];
      } else {
        content = [{ type: "text", text: `echo:${text}` }];
      }
      const message = {
        role: "assistant" as const,
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason,
        timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message as never });
        stream.push({ type: "done", reason: stopReason, message: message as never });
      });
      return stream;
    },
  });

  pi.registerTool({
    name: "gate",
    label: "Gate",
    description: "Block until the test releases the named gate",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, params, signal) {
      writeFileSync(join(gateDir(), `${params.name}.started`), String(Date.now()));
      const release = join(gateDir(), `${params.name}.release`);
      const deadline = Date.now() + 20_000;
      while (!existsSync(release) && !signal?.aborted && Date.now() < deadline) await new Promise((r) => setTimeout(r, 15));
      writeFileSync(join(gateDir(), `${params.name}.finished`), String(Date.now()));
      return { content: [{ type: "text", text: `gate:${params.name}` }], details: {} };
    },
  });
}
