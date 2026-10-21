import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { PROTOCOL_VERSION } from "../protocol.ts";
import { socketPathFor } from "../paths.ts";
import { NATIVE_CAPABILITIES, validateHello, type Readiness } from "./ensure.ts";
import type { StagedRuntime } from "./managed-types.ts";
import { absolutePath, shellQuote, type InstalledRuntime } from "./runtime.ts";

export function ensureArgs(serverDir: string, desiredRuntime?: string): string[] {
  return ["ensure", "--agent", "pi", "--server-dir", absolutePath(serverDir, "serverDir"),
    ...(desiredRuntime ? ["--desired-runtime", absolutePath(desiredRuntime, "desiredRuntime")] : []),
    "--pi-version", PI_VERSION, "--protocol-version", String(PROTOCOL_VERSION),
    ...NATIVE_CAPABILITIES.flatMap((capability) => ["--require-capability", capability])];
}

export function remoteEnsureScript(runtime: InstalledRuntime, serverDir: string, desiredRuntime?: string): string {
  return `exec env PI_CODING_AGENT_DIR=${shellQuote(runtime.agentDir)} PI_SERVER_DIR=${shellQuote(serverDir)} ${shellQuote(runtime.launcher)} ${ensureArgs(serverDir, desiredRuntime).map(shellQuote).join(" ")}`;
}

export function activationArgs(runtime: StagedRuntime, agentDir: string, serverDir: string, operationId: string): string[] {
  return ["activate", "--agent", "pi", "--runtime", absolutePath(runtime.manifestPath, "runtime manifest"),
    "--agent-dir", absolutePath(agentDir, "agentDir"), "--server-dir", absolutePath(serverDir, "serverDir"), "--operation-id", operationId];
}

/** Runs the staged CLI, including when the installed legacy launcher has no activate subcommand. */
export function remoteActivationScript(runtime: StagedRuntime, agentDir: string, serverDir: string, operationId: string): string {
  return `exec env PI_CODING_AGENT_DIR=${shellQuote(absolutePath(agentDir, "agentDir"))} PI_SERVER_DIR=${shellQuote(absolutePath(serverDir, "serverDir"))} ${shellQuote(runtime.node)} ${shellQuote(runtime.entrypoint)} ${activationArgs(runtime, agentDir, serverDir, operationId).map(shellQuote).join(" ")}`;
}

export function parseReadiness(text: string, serverDir: string): Readiness {
  const data = JSON.parse(text) as Readiness | null;
  if (!data || data.version !== 1 || data.agent !== "pi" || data.serverDir !== resolve(serverDir) || data.socketPath !== socketPathFor(resolve(serverDir))) {
    throw new Error("Invalid server readiness record or unexpected daemon directory");
  }
  validateHello(data.hello);
  return data;
}
