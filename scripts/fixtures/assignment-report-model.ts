import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";

export default function (pi: ExtensionAPI) {
  let turn = 0;
  const prompt = process.argv.at(-1) ?? "";
  const noReport = prompt.includes("reload unfinished");
  const incomplete = prompt.includes("first incomplete");
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  pi.registerProvider("reload-subagent", {
    baseUrl: "https://example.invalid", apiKey: "offline", api: "openai-completions",
    models: [{ id: "offline", name: "Offline report producer", input: ["text"], reasoning: false, contextWindow: 128000, maxTokens: 2048, cost }],
    streamSimple(model, context) {
      turn++;
      const stream = createAssistantMessageEventStream();
      const transcript = JSON.stringify(context.messages);
      if (turn === 1 && prompt.includes("complete follow-up")
        && (!transcript.includes("Assessment unfinished") || !transcript.includes("Report retained."))) {
        throw new Error("Explicit continuation did not reopen the prior worker history");
      }
      let content: unknown[];
      if (turn === 1) content = [{ type: "toolCall", id: "artifact", name: "write", arguments: { path: "assessment.txt", content: incomplete || noReport ? "Assessment unfinished" : "reload-survives answer" } }];
      else if (turn === 2 && !noReport) content = [{ type: "toolCall", id: "report", name: "report_assignment_result", arguments: {
        status: incomplete ? "incomplete" : "complete", reason: incomplete ? "Assessment unfinished; continue this conversation." : "Requested assessment completed and checked.",
        evidence: [{ path: "assessment.txt", explanation: "The assessment produced by the synchronous write tool." }],
      } }];
      else {
        if (!noReport && !transcript.includes("Report retained.")) throw new Error("Assignment report was not accepted by the real bridge");
        content = [{ type: "text", text: noReport ? "Assessment unfinished" : "reload-survives answer" }];
      }
      const answer = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        stopReason: content.some((p: any) => p.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...cost, total: 0 } } };
      const finish = () => { stream.push({ type: "done", reason: answer.stopReason, message: answer } as never); stream.end(answer as never); };
      const release = process.env.PI_744_REPORT_RELEASE;
      if (answer.stopReason === "stop" && release && !existsSync(release)) {
        const timer = setInterval(() => { if (existsSync(release)) { clearInterval(timer); finish(); } }, 20);
      } else queueMicrotask(finish);
      return stream;
    },
  });
}
