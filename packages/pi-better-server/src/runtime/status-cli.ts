#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureRuntime } from "./client.ts";

try {
  const status = await ensureRuntime({ agentDir: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), serverDir: process.env.PI_SERVER_DIR,
    offline: process.env.PI_OFFLINE === "1",
    onProgress: stage => process.stderr.write(`Runtime: ${stage}\n`) });
  process.stdout.write(JSON.stringify(status) + "\n");
} catch (error) { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; }
