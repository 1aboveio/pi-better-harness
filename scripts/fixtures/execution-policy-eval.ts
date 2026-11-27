import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { EXECUTION_POLICY_SECTION, publishExecutionPolicy } from "../../packages/pi-better-harness/extensions/execution-policy.ts";
import { delegationPrompt } from "../../packages/pi-better-subagents/delegation.ts";

/** Remote-operation simulator for evaluating model scheduling, never a shell executor. */
export default function evaluationTools(pi: ExtensionAPI): void {
  const trace = process.env.PI_EXECUTION_EVAL_TRACE;
  if (!trace) throw new Error("PI_EXECUTION_EVAL_TRACE is required");
  const scenario = process.env.PI_EXECUTION_EVAL_SCENARIO;
  const record = (event: Record<string, unknown>) => appendFileSync(trace, `${JSON.stringify(event)}\n`);
  // A fake prompt string is the whole point of this fixture, so it reads the
  // section value back out rather than asking the publishing API for text.
  const policy = publishExecutionPolicy({ sections: {} as Record<string, string> }).sections[EXECUTION_POLICY_SECTION];
  pi.on("before_agent_start", () => ({
    systemPrompt: `${policy}\n\n${delegationPrompt("manual")}`,
  }));
  pi.registerTool({
    name: "bg_task_spawn", label: "Simulated Background Launch",
    description: "Start one simulated guarded host migration and return immediately. This does not execute shell commands. Valid commands: migrate-ws, migrate-r9, migrate-jimac, migrate-z4.",
    parameters: Type.Object({ command: Type.String() }),
    async execute(_id, { command }) {
      if (!/^migrate-(ws|r9|jimac|z4)$/.test(command)) throw new Error("Unknown simulated operation");
      const host = command.slice("migrate-".length);
      const status = scenario === "local-failure" && host === "ws" ? "failed" : "running";
      record({ action: "launch", host, status });
      const result = { id: `bg_${host}`, status, ...(status === "failed"
        ? { error: "ws local destination-device preflight failed; other hosts have independent devices and passed preflight" }
        : { phase: "natural-drain", jobsInterrupted: false }) };
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
  pi.registerTool({
    name: "bg_task_status", label: "Simulated Background Status",
    description: "Inspect one simulated migration. It remains running during this scheduling wave; do not poll.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, { id }) {
      record({ action: "inspect", id });
      return { content: [{ type: "text", text: "Still running; await its callback, do not poll." }], details: {} };
    },
  });
  pi.registerTool({
    name: "ask_user_question", label: "Simulated Human Decision",
    description: "Ask the human to resolve an operational trade-off. The answer is pending: after asking, stop this scheduling wave without launching affected operations.",
    parameters: Type.Object({ question: Type.String() }),
    async execute(_id, { question }) {
      record({ action: "question", question });
      return { content: [{ type: "text", text: "Awaiting the human's answer. End this scheduling wave." }], details: {} };
    },
  });
}