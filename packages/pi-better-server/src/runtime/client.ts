import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { stageRuntime } from "../startup/install.ts";
import { inspectDaemonOwner } from "../daemon-owner.ts";
import type { RunRemote, ServerArtifact } from "../startup/managed-types.ts";
import { runtimeRoot } from "./root.ts";
import { socketPathFor } from "./socket.ts";
export { WorkClient } from "./work-client.mjs";

export interface RuntimeOptions {
  agentDir: string;
  serverDir?: string;
  installRoot?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (stage: string) => void;
  offline?: boolean;
}

/** One bounded LF-JSON exchange; importing this module never loads the Pi SDK. */
export async function runtimeStatus(socketPath: string, agentDir: string, artifact: ServerArtifact, timeoutMs = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`runtime-unhealthy: no response at ${socketPath}; inspect the live owner`)); }, timeoutMs);
    let buffer = "", greeted = false;
    const fail = (error: Error) => { clearTimeout(timer); socket.destroy(); reject(error); };
    socket.on("error", fail);
    socket.on("end", () => fail(new Error("runtime-unavailable: server closed the connection")));
    socket.on("connect", () => socket.write(JSON.stringify({ id: "hello", type: "hello", protocolVersion: 1, runtimeRoot: agentDir, requiredCapabilities: ["runtime-status-v1"] }) + "\n"));
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) return fail(new Error("runtime-unhealthy: response exceeds 1 MiB"));
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n"), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try {
          const reply = JSON.parse(line);
          if (!reply.success) throw new Error(reply.error ?? "runtime-unavailable");
          const data = reply.data;
          if (!greeted) {
            if (reply.id !== "hello" || data?.protocolVersion !== 1 || data.agentDir !== agentDir
              || data.build?.contentId !== artifact.build.contentId || data.nodeVersion !== artifact.build.nodeVersion
              || !data.capabilities?.includes("runtime-status-v1") || !data.instanceId) throw new Error("capability-mismatch: root, pinned build, Node or runtime capability differs; update the installed packages together");
            greeted = true;
            socket.write(JSON.stringify({ id: "status", type: "runtime_get_status" }) + "\n");
          } else {
            if (reply.id !== "status") throw new Error("runtime-unhealthy: unexpected response");
            clearTimeout(timer); socket.destroy(); resolve(data);
          }
        } catch (error) { return fail(error as Error); }
      }
    });
  });
}

const runLocal: RunRemote = (command, input, timeoutMs) => new Promise((resolve, reject) => {
  const child = spawn("/bin/sh", ["-c", command], { stdio: "pipe", timeout: timeoutMs });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.on("error", reject);
  child.stdin.on("error", () => undefined);
  child.on("close", (exitCode, signal) => resolve({ stdout, stderr, exitCode, timedOut: signal === "SIGTERM" }));
  child.stdin.end(input);
});

export async function ensureRuntime(options: RuntimeOptions): Promise<any> {
  options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error("Runtime timeout must be from 1 to 120000 ms");
  const platform = `${process.platform}-${process.arch}`;
  const directory = fileURLToPath(new URL("../../artifacts/", import.meta.url));
  let artifact: ServerArtifact;
  try {
    const manifest = JSON.parse(readFileSync(join(directory, `${platform}.json`), "utf8"));
    artifact = { ...manifest, bytes: readFileSync(join(directory, `${platform}.gz`)) };
  } catch (error) { throw new Error(`runtime-unavailable: cannot read pinned artifact for ${platform}; reinstall the standalone package. ${String(error)}`); }
  const { decodeServerArtifact } = await import("../startup/artifact.ts");
  decodeServerArtifact(artifact);
  const root = runtimeRoot(options.agentDir, options.serverDir ?? join(options.agentDir, "server"));
  const socketPath = socketPathFor(root.serverDir);
  const query = () => runtimeStatus(socketPath, root.agentDir, artifact, Math.min(timeoutMs, 2000));
  try { return await query(); }
  catch (error) {
    if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
  const owner = inspectDaemonOwner(root.serverDir);
  if (owner.status === "live" || owner.status === "ambiguous") throw new Error(`runtime-unhealthy: existing ${owner.status} owner at ${root.serverDir}; no replacement was started`);
  let runtime;
  try { runtime = await stageRuntime({ run: runLocal, artifact, installRoot: options.installRoot ?? join(root.agentDir, "managed-runtime"), signal: options.signal, onProgress: options.onProgress, offline: options.offline }); }
  catch (error) { throw new Error(`runtime-unavailable: ${String(error)}. Connect to the network to cache the pinned runtime, or repair the reported corrupt cache; no fallback manager was started.`); }
  const fd = openSync(join(root.serverDir, "daemon.log"), "a", 0o600);
  try {
    const env = { ...process.env, PI_SERVER_DIR: root.serverDir, PI_CODING_AGENT_DIR: root.agentDir, PI_SERVER_AGENT: "pi" };
    for (const key of ["NODE_OPTIONS", "PI_SERVER_ACTIVATION_ID", "PI_SERVER_ROLLBACK_OPERATION_ID", "PI_SERVER_ROLLBACK_PERMIT"]) delete (env as NodeJS.ProcessEnv)[key];
    const child = spawn(runtime.node, [runtime.entrypoint, "--agent", "pi"], { cwd: root.serverDir, env, detached: true, stdio: ["ignore", fd, fd] });
    child.on("error", () => undefined); child.unref();
  } finally { closeSync(fd); }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted();
    try { return await query(); }
    catch (error) { if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    await delay(50, undefined, { signal: options.signal });
  }
  throw new Error(`runtime-unavailable: startup timed out; inspect ${join(root.serverDir, "daemon.log")}; owner was not replaced`);
}
