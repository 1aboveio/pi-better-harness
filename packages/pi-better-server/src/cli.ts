#!/usr/bin/env node
import { startCodexDaemon } from "./codex/daemon.ts";
import { startDaemon } from "./server.ts";

const log = (message: string): void => void process.stderr.write(`[pi-better-server] ${message}\n`);
const serverDir = process.env.PI_SERVER_DIR ? { serverDir: process.env.PI_SERVER_DIR } : {};
const agentFlag = process.argv.indexOf("--agent");
const agent = (agentFlag === -1 ? process.env.PI_SERVER_AGENT : process.argv[agentFlag + 1]) ?? "pi";
if (agent !== "pi" && agent !== "codex") throw new Error(`Unknown --agent ${agent}; expected pi or codex`);

const daemon = agent === "codex" ? await startCodexDaemon({ ...serverDir, log }) : await startDaemon({ ...serverDir, log });

let stopping = false;
const shutdown = (): void => {
  if (stopping) return;
  stopping = true;
  void daemon.stop().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
