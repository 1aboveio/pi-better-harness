import { writeFileSync, existsSync, watch } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
/** External model substitute; the production SDK and worker bootstrap remain real. */
export default function offline(pi: ExtensionAPI) {
  let turn = 0;
  pi.registerProvider("openai", {
    baseUrl: "https://example.invalid", apiKey: "offline-fixture", api: "openai-completions",
    models: [{ id: "gpt-4.1", name: "Offline launch fixture", input: ["text"], reasoning: false,
      contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      turn++;
      const stream = createAssistantMessageEventStream();
      const gate = process.env.LAUNCH_RELEASE!, entered = process.env.LAUNCH_ENTERED!;
      if (turn === 1) {
        const proof = JSON.stringify({ pid: process.pid, model: model.id });
        writeFileSync(entered, proof);
        writeFileSync(`${entered}.${process.pid}`, proof);
      }
      const finish = () => {
        const results = context.messages.filter((m: any) => m.role === "toolResult") as any[];
        const spawnResult = results.find(m => m.toolName === "bg_task_spawn");
        const waitResult = results.find(m => m.toolName === "wait_for_operations");
        let call: any;
        if (!spawnResult) call = { name: "bg_task_spawn", arguments: { argv: [process.execPath, "-e", `const fs=require('fs'); const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(t);console.log('dependency complete')}},50)`], shell: false, name: "park-dependency" } };
        else if (!waitResult) {
          const text = spawnResult.content?.filter((p:any)=>p.type === "text").map((p:any)=>p.text).join(" ") ?? "";
          const id = spawnResult.details?.id ?? text.match(/bgs_[a-f0-9]{20}/)?.[0];
          if (!id) throw new Error(`No task id: ${JSON.stringify(spawnResult)}`);
          call = { name: "wait_for_operations", arguments: { task_ids: [id], continuation_note: "Report completion after dependency settles." } };
        } else if (!results.some(m => m.toolName === "bg_task_status")) {
          call = { name: "bg_task_status", arguments: { id: waitResult.details.taskIds[0] } };
        } else if (!results.some(m => m.toolName === "bg_task_log")) {
          call = { name: "bg_task_log", arguments: { id: waitResult.details.taskIds[0] } };
        } else if (!results.some(m => m.toolName === "acknowledge_operation_result")) {
          const ready = results.find(m => m.toolName === "bg_task_status").details.waits[0];
          call = { name: "acknowledge_operation_result", arguments: { wait_id: ready.waitId, generation: ready.generation,
            terminal_revisions: ready.dependencies.map((d:any) => ({ operation_id: d.operationId, revision: d.terminalRevision })),
            disposition: "assignment-complete", note: "Read exact completed dependency status and log." } };
        } else if (!results.some(m => m.toolName === "report_assignment_result")) {
          writeFileSync(`${entered}.continued`, JSON.stringify({ pid: process.pid }));
          call = { name: "report_assignment_result", arguments: { status: "complete", reason: "Dependency settled and original conversation resumed", evidence: [{ path: gate, explanation: "Dependency release evidence" }] } };
        }
        const content = call ? [{ type: "toolCall", id: `park-${process.pid}-${turn}`, ...call }] : [{ type: "text", text: "continued" }];
        const reason = call ? "toolUse" : "stop";
        const response: any = { role: "assistant", content,
          api: model.api, provider: model.provider, model: model.id, stopReason: reason, timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "start", partial: response }); stream.push({ type: "done", reason, message: response }); stream.end();
      };
      const resumed = context.messages.some((m: any) => m.role === "toolResult" && m.toolName === "wait_for_operations");
      const bootstrapGate = process.env.CONTINUATION_BOOTSTRAP_GATE;
      if (resumed && turn === 1 && bootstrapGate && !existsSync(bootstrapGate)) {
        writeFileSync(`${bootstrapGate}.entered`, JSON.stringify({ pid: process.pid }));
        const watcher = watch(process.env.LAUNCH_WORKSPACE!, () => {
          if (existsSync(bootstrapGate)) { watcher.close(); finish(); }
        });
      } else queueMicrotask(finish);
      return stream;
    },
  });
}
