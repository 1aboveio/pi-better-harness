import { execFileSync, spawn } from "node:child_process";
import type { CodexEndpoint } from "../codex/daemon.ts";
import type { DaemonClient } from "../client.ts";
import type { RemoteContext } from "./context.ts";
import type { SessionSummary } from "../protocol.ts";

/** Local `codex --version` as "0.159.2". */
function localCodexVersion(bin: string): string {
  const output = execFileSync(bin, ["--version"], { encoding: "utf8" });
  const match = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(output);
  if (!match) throw new Error(`Unrecognized \`${bin} --version\` output: ${output.trim()}`);
  return match[1]!;
}

/** `pi-remote attach` for a Codex thread: the native TUI against the host's app-server, through an ssh-forwarded unix socket. */
export async function attachCodex(client: DaemonClient, session: SessionSummary, extraCodexArgs: string[], values: Record<string, string | boolean | undefined>, context: RemoteContext): Promise<number> {
  if (session.ownership) throw new Error(`Session ${session.sessionId} is ${session.ownership} on this host; attach where it now lives`);
  const reply = await client.request({ type: "codex_endpoint" });
  if (!reply.success) throw new Error(`This daemon cannot attach: ${reply.error ?? "no Codex endpoint"}.`);
  const endpoint = reply.data as CodexEndpoint;

  const bin = (values["codex-bin"] as string | undefined) ?? process.env.PI_CODEX_BIN ?? "codex";
  const local = localCodexVersion(bin);
  if (local !== endpoint.codexVersion) {
    throw new Error(`Codex CLI version mismatch: this machine runs codex-cli ${local}, the host runs codex-cli ${endpoint.codexVersion}. Both ends must run the same version.`);
  }

  // The TUI talks to the remote app-server only through this ssh-forwarded unix socket.
  const forward = await context.forwardSocket(endpoint.socketPath);
  try {
    const child = spawn(bin, [...extraCodexArgs, "resume", session.sessionId, "--remote", `unix://${forward.socketPath}`], { stdio: "inherit" });
    const stopChild = (): void => void child.kill("SIGTERM");
    context.signal.addEventListener("abort", stopChild, { once: true });
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 130 : 1)));
    });
  } finally {
    await forward.close();
  }
}
