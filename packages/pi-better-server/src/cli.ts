#!/usr/bin/env node
import { resolveAgent, type ServerAgent } from "./cli-args.ts";
import { startCodexDaemon } from "./codex/daemon.ts";
import { startDaemon } from "./server.ts";

const log = (message: string): void => void process.stderr.write(`[pi-better-server] ${message}\n`);
const serverDir = process.env.PI_SERVER_DIR ? { serverDir: process.env.PI_SERVER_DIR } : {};
let agent: ServerAgent;
try {
  agent = resolveAgent(process.argv.slice(2), process.env.PI_SERVER_AGENT);
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const daemon = agent === "codex" ? await startCodexDaemon({ ...serverDir, log }) : await startDaemon({ ...serverDir, log });

let stopping = false;
const shutdown = (): void => {
  if (stopping) return;
  stopping = true;
  void daemon.stop().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
