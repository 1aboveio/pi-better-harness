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

/** Block until the test releases the named gate (a gate tool call does the same inside a turn). */
async function holdGate(name: string): Promise<void> {
  writeFileSync(join(gateDir(), `${name}.started`), String(Date.now()));
  const release = join(gateDir(), `${name}.release`);
  const deadline = Date.now() + 20_000;
  while (!existsSync(release) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 15));
  writeFileSync(join(gateDir(), `${name}.finished`), String(Date.now()));
}

export default function (pi: ExtensionAPI) {
  // Record every input event's source; swallow any input starting with "swallow" so the extension "handles" it.
  // `hold <gate>` holds the starting prompt open on that gate, then handles the input so no turn runs.
  pi.on("input", async (event) => {
    if (logFile()) appendFileSync(`${logFile()}.inputs`, `${JSON.stringify({ text: event.text, source: event.source })}\n`);
    if (event.text.startsWith("hold ")) {
      await holdGate(event.text.slice(5).trim());
      return { action: "handled" as const };
    }
    return event.text.startsWith("swallow") ? { action: "handled" as const } : { action: "continue" as const };
  });

  // `/kick <text>` starts a turn from inside the extension, so no daemon prompt is waiting on it.
  pi.registerCommand("kick", { description: "Start a turn with the given text", handler: async (args) => void pi.sendUserMessage(args) });

  // `/slow <gate>` holds the starting prompt open on that gate, then finishes without a turn.
  pi.registerCommand("slow", {
    description: "Hold the starting prompt open on the named gate, then finish without a turn",
    handler: async (args) => holdGate(args.trim()),
  });

  // Pi 1.x only: while `settle.hold` exists in the gate dir, agent_settled blocks until `settle.release` appears.
  (pi as unknown as { on(event: string, handler: () => Promise<void>): void }).on("agent_settled", async () => {
    if (!existsSync(join(gateDir(), "settle.hold"))) return;
    writeFileSync(join(gateDir(), "settle.started"), String(Date.now()));
    const deadline = Date.now() + 20_000;
    while (!existsSync(join(gateDir(), "settle.release")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 15));
  });

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
      } else if (last?.role === "user" && text.startsWith("ask ")) {
        content = [{ type: "toolCall", id: `call-${Date.now()}`, name: "ask", arguments: { question: text.slice(4).trim() } }];
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

  pi.registerTool({
    name: "ask",
    label: "Ask",
    description: "Ask the person a question through the extension UI and return the answer",
    parameters: Type.Object({ question: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const answer = await ctx.ui.input(params.question, "answer");
      return { content: [{ type: "text", text: `answer:${answer ?? "none"}` }], details: {} };
    },
  });
}
