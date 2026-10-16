#!/usr/bin/env node
import { startDaemon } from "./server.ts";

const daemon = await startDaemon({
  ...(process.env.PI_SERVER_DIR ? { serverDir: process.env.PI_SERVER_DIR } : {}),
  log: (message) => process.stderr.write(`[pi-better-server] ${message}\n`),
});

let stopping = false;
const shutdown = (): void => {
  if (stopping) return;
  stopping = true;
  void daemon.stop().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
