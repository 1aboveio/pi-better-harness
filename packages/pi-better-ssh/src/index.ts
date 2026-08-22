import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createProcessRemoteRunner } from "./process-runner.js";
import { executeRemoteBash } from "./remote-bash.js";
import type { RemoteBashDependencies, RemoteBashResult } from "./remote-bash.js";

const RemoteBashParams = Type.Object({
  command: Type.String({ description: "Bash command string to execute remotely." }),
  host: Type.String({ description: "SSH Host alias or user@host target. Required until an active profile is supported." }),
  workdir: Type.Optional(Type.String({ description: "Remote working directory applied before the command." })),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout). Cancels only this SSH slave command." })),
  env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Remote environment variables exported before the command." })),
  user: Type.Optional(Type.String({ description: "Structured SSH user override." })),
  port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_535, description: "Structured SSH port override." })),
  identity_file: Type.Optional(Type.String({ description: "Structured SSH identity file path." })),
  jump: Type.Optional(Type.String({ description: "Structured SSH jump host passed with -J." })),
  options: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Additional SSH -o key/value options. Callers cannot disable required BatchMode, connect-timeout, no-TTY, or mux safety options." })),
});

export interface RegisterRemoteBashDependencies {
  runner: RemoteBashDependencies["runner"];
  controlPathRoot?: string;
}

export function registerRemoteBashTool(pi: ExtensionAPI, dependencies: RegisterRemoteBashDependencies): void {
  pi.registerTool({
    name: "remote_bash",
    label: "Remote Bash",
    description: `Run one short remote bash command synchronously over a reusable SSH ControlMaster. Pass an SSH Host alias or user@host; optional workdir, env, timeout, and structured identity fields are supported. Required SSH safety options cannot be disabled. Returns remote output and exitCode without turning a non-zero remote exit into a tool failure. Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first), with full output saved locally. For long-running remote work, use bg_task_spawn (or bg_task_* lifecycle tools) with structured ssh instead.`,
    promptSnippet: "Run a short synchronous remote command through safe reusable SSH",
    promptGuidelines: [
      "Use remote_bash for short synchronous remote commands instead of writing ssh commands inside local bash.",
      "Use bg_task_spawn with structured ssh for long-running or durable remote work instead of remote_bash.",
    ],
    parameters: RemoteBashParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const sessionScope = ctx.sessionManager.getSessionId();
      const result = await executeRemoteBash(params, {
        runner: dependencies.runner,
        sessionScope,
        ...(dependencies.controlPathRoot ? { controlPathRoot: dependencies.controlPathRoot } : {}),
      }, signal);
      return {
        content: [{ type: "text" as const, text: formatToolResult(result, params.timeout) }],
        details: result,
      };
    },
  });
}

export default function sshExtension(pi: ExtensionAPI): void {
  registerRemoteBashTool(pi, { runner: createProcessRemoteRunner() });
}

function formatToolResult(result: RemoteBashResult, timeoutSeconds?: number): string {
  let text = result.output || "(no output)";
  if (result.truncated && result.truncation && result.fullOutputPath) {
    const startLine = result.truncation.totalLines - result.truncation.outputLines + 1;
    const endLine = result.truncation.totalLines;
    text += result.truncation.truncatedBy === "lines"
      ? `\n\n[Showing lines ${startLine}-${endLine} of ${result.truncation.totalLines}. Full output: ${result.fullOutputPath}]`
      : `\n\n[Showing lines ${startLine}-${endLine} of ${result.truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${result.fullOutputPath}]`;
  }
  if (result.timedOut) return `${text}\n\nCommand timed out after ${timeoutSeconds} seconds`;
  if (result.cancelled) return `${text}\n\nCommand cancelled`;
  if (result.exitCode !== 0 && result.exitCode !== undefined) {
    return `${text}\n\nCommand exited with code ${result.exitCode}`;
  }
  return text;
}
