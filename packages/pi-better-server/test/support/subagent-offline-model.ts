import { existsSync, watch, writeFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export function continuationModels(baseUrl: string) {
  return { providers: { test: {
    baseUrl, api: "openai-completions", apiKey: "offline-fixture",
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    models: ["model", "escalated"].map(id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  } } };
}

/** Clean workers use the SDK's real OpenAI transport against this offline provider. */
export async function startContinuationModel(artifacts: string) {
  const sockets = new Set<import("node:net").Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer(async (request, response) => {
    try {
    let bytes = "";
    for await (const chunk of request) { bytes += chunk; if (bytes.length > 1024 * 1024) { response.writeHead(413).end(); return; } }
    const body = JSON.parse(bytes);
    const content = body.messages?.filter((message: any) => message.role === "user").at(-1)?.content ?? "";
    const prompt = typeof content === "string" ? content : content.map((part: any) => part.text ?? "").join("");
    const key = createHash("sha256").update(prompt).digest("hex");
    const path = join(artifacts, `control-${key}.json`);
    const pause = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).sleepMs : 0;
    if (pause) await new Promise<void>(resolve => { const timer = setTimeout(() => { timers.delete(timer); resolve(); }, pause); timers.add(timer); });
    const followup = body.messages?.some((message: any) => message.role === "assistant");
    const answer = followup ? `FOLLOWUP:${prompt}` : "INITIAL ANSWER";
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (delta: unknown, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ id: "offline-continuation", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    send({ role: "assistant", content: answer }); send({}, "stop"); response.end("data: [DONE]\n\n");
    } catch {
      if (!response.destroyed) response.writeHead(400).end("Invalid offline model request");
    }
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, async close() {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

/** External model substitute; the production SDK and worker bootstrap remain real. */
export default function offline(pi: ExtensionAPI) {
  let turn = 0;
  pi.registerProvider("openai", {
    baseUrl: "https://example.invalid", apiKey: "offline-fixture", api: "openai-completions",
    models: [{ id: "gpt-4.1", name: "Offline launch fixture", input: ["text"], reasoning: false,
      contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model) {
      turn++;
      const stream = createAssistantMessageEventStream();
      const gate = process.env.LAUNCH_RELEASE!, entered = process.env.LAUNCH_ENTERED!;
      if (turn === 1) {
        const proof = JSON.stringify({ pid: process.pid, model: model.id });
        writeFileSync(entered, proof);
        writeFileSync(`${entered}.${process.pid}`, proof);
      }
      const finish = () => {
        const content = turn === 1 ? [{ type: "toolCall", id: "launch-report", name: "report_assignment_result", arguments: {
          status: "complete", reason: "Offline provider observed real worker bootstrap and release", evidence: [{ path: entered, explanation: "Actual worker PID and model after production bootstrap" }] } }]
          : [{ type: "text", text: "real-worker-bootstrap-complete" }];
        const reason = turn === 1 ? "toolUse" : "stop";
        const response: any = { role: "assistant", content,
          api: model.api, provider: model.provider, model: model.id, stopReason: reason, timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "start", partial: response }); stream.push({ type: "done", reason, message: response }); stream.end();
      };
      if (existsSync(gate)) queueMicrotask(finish);
      else {
        const watcher = watch(process.env.LAUNCH_WORKSPACE!, () => { if (existsSync(gate)) { watcher.close(); finish(); } });
      }
      return stream;
    },
  });
}
