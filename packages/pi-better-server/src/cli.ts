#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolveAgent, type ServerAgent } from "./cli-args.ts";
import { absolutePath, launcherRuntime, registeredRuntime } from "./startup/runtime.ts";

const log = (message: string): void => void process.stderr.write(`[pi-better-server] ${message}\n`);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let agent: ServerAgent;
  try { agent = resolveAgent(argv, process.env.PI_SERVER_AGENT); }
  catch (error) {
    log(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  // A launcher describes its own runtime; direct Pi CLI users share the per-user registration.
  const runtime = (): ReturnType<typeof launcherRuntime> => process.env.PI_SERVER_LAUNCHER || process.env.PI_SERVER_COMMAND
    ? launcherRuntime() : registeredRuntime() ?? launcherRuntime();
  if (argv[0] === "runtime") {
    if (agent !== "pi") throw new Error("Runtime discovery supports Pi only");
    process.stdout.write(`${JSON.stringify(runtime())}\n`);
    return;
  }
  if (agent === "pi") {
    const selected = runtime();
    process.env.PI_CODING_AGENT_DIR ||= selected.agentDir;
    process.env.PI_SERVER_DIR ||= selected.defaultServerDir;
  }
  if (argv[0] === "ensure") {
    if (agent !== "pi") throw new Error("Server ensure supports Pi only; start the Codex daemon explicitly");
    const { values } = parseArgs({ args: argv.slice(1), options: {
      agent: { type: "string" },
      "server-dir": { type: "string" },
      "timeout-ms": { type: "string" },
      "pi-version": { type: "string" },
      "protocol-version": { type: "string" },
      "require-capability": { type: "string", multiple: true },
    } });
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      const { ensureDaemon } = await import("./startup/ensure.ts");
      const record = await ensureDaemon({
        serverDir: absolutePath(values["server-dir"] ?? process.env.PI_SERVER_DIR, "serverDir"),
        agentDir: absolutePath(process.env.PI_CODING_AGENT_DIR, "agentDir"),
        timeoutMs: values["timeout-ms"] === undefined ? undefined : Number(values["timeout-ms"]),
        piVersion: values["pi-version"],
        protocolVersion: values["protocol-version"] === undefined ? undefined : Number(values["protocol-version"]),
        requiredCapabilities: values["require-capability"],
        signal: controller.signal,
      });
      process.stdout.write(`${JSON.stringify(record)}\n`);
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    return;
  }

  const serverDir = process.env.PI_SERVER_DIR ? { serverDir: process.env.PI_SERVER_DIR } : {};
  const daemon = agent === "codex"
    ? await (await import("./codex/daemon.ts")).startCodexDaemon({ ...serverDir, log })
    : await (await import("./server.ts")).startDaemon({ ...serverDir, log });

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    void daemon.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main().catch((error) => {
  log(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
