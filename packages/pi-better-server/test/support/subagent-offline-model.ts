import { existsSync, watch, writeFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
      if (turn === 1) writeFileSync(entered, JSON.stringify({ pid: process.pid, model: model.id }));
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
