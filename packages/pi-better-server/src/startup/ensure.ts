import { spawn } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { DaemonClient, HandshakeError } from "../client.ts";
import { serverHello } from "../handshake.ts";
import { ensureServerDir, socketPathFor } from "../paths.ts";
import { PROTOCOL_VERSION, type HelloData } from "../protocol.ts";

export interface Readiness {
  version: 1;
  agent: "pi";
  serverDir: string;
  socketPath: string;
  hello: HelloData;
}

export interface EnsureOptions {
  serverDir: string;
  agentDir: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  piVersion?: string;
  protocolVersion?: number;
  requiredCapabilities?: readonly string[];
}

export const NATIVE_CAPABILITIES = ["native-client-v1", "session-browser-v1"] as const;

function abortCheck(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

function absent(error: unknown): boolean {
  return ["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "");
}

export function validateHello(hello: HelloData | undefined, options: Pick<EnsureOptions, "piVersion" | "protocolVersion" | "requiredCapabilities"> = {}): asserts hello is HelloData {
  if (!hello || hello.protocolVersion !== (options.protocolVersion ?? PROTOCOL_VERSION)) throw new HandshakeError("Daemon protocol version mismatch");
  const majorMinor = (value: string) => /^v?(\d+\.\d+)(?:\.|$)/.exec(value)?.[1];
  const expected = majorMinor(options.piVersion ?? PI_VERSION);
  if (!expected || typeof hello.piVersion !== "string" || majorMinor(hello.piVersion) !== expected) throw new HandshakeError(`Daemon Pi version mismatch (expected ${options.piVersion ?? PI_VERSION}, got ${hello.piVersion})`);
  if (!Array.isArray(hello.capabilities) || !hello.capabilities.every((value) => typeof value === "string")) throw new HandshakeError("Daemon did not announce a valid capabilities array; update the installed server");
  const missing = (options.requiredCapabilities ?? NATIVE_CAPABILITIES).filter((capability) => !hello.capabilities!.includes(capability));
  if (missing.length) throw new HandshakeError(`Daemon missing capabilities: ${missing.join(", ")}. Update the installed server before reconnecting.`);
}

async function health(socketPath: string, timeoutMs: number, options: EnsureOptions): Promise<HelloData> {
  const signal = AbortSignal.any([AbortSignal.timeout(Math.max(1, timeoutMs)), ...(options.signal ? [options.signal] : [])]);
  const client = await DaemonClient.connect(socketPath, { signal, hello: { piVersion: options.piVersion ?? PI_VERSION, protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION } });
  try {
    validateHello(client.server, options);
    return client.server;
  } finally { client.close(); }
}

/** Only ENOENT/ECONNREFUSED permit startup. A connected but unhealthy peer is never replaced. */
export async function ensureDaemon(options: EnsureOptions): Promise<Readiness> {
  abortCheck(options.signal);
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) throw new Error("Ensure timeout must be an integer from 1 to 120000 ms");
  const serverDir = resolve(options.serverDir);
  const socketPath = socketPathFor(serverDir);
  const deadline = Date.now() + timeoutMs;
  const ready = (hello: HelloData): Readiness => ({ version: 1, agent: "pi", serverDir, socketPath, hello });
  try { return ready(await health(socketPath, Math.min(2_000, timeoutMs), options)); }
  catch (error) {
    abortCheck(options.signal);
    if (!absent(error)) throw new Error(`Server health at ${socketPath}: ${error instanceof Error ? error.message : String(error)}. Existing listener was not replaced; inspect or update it explicitly.`);
  }
  abortCheck(options.signal);
  try { validateHello(serverHello(), options); }
  catch (error) {
    throw new Error(`Server runtime at ${serverDir} is incompatible: ${error instanceof Error ? error.message : String(error)}. Update/register a compatible installed runtime; no daemon was launched.`);
  }
  if (Date.now() >= deadline) throw new Error(`Server readiness timed out at ${socketPath} before launch`);
  const logPath = join(serverDir, "daemon.log");
  let exitDetail = "";
  try {
    ensureServerDir(serverDir);
    const fd = openSync(logPath, "a", 0o600);
    try {
      // No inherited SSH pipes or controlling terminal: the product daemon outlives this ensure client.
      const child = spawn(process.execPath, [fileURLToPath(new URL("../cli.ts", import.meta.url)), "--agent", "pi"], {
        detached: true,
        cwd: serverDir,
        stdio: ["ignore", fd, fd],
        env: { ...process.env, PI_SERVER_DIR: serverDir, PI_CODING_AGENT_DIR: options.agentDir, PI_SERVER_AGENT: "pi" },
      });
      child.on("error", (error) => { exitDetail = `launch failed: ${error.message}`; });
      child.on("exit", (code, signal) => { exitDetail = `launcher exited (${signal ?? code})`; });
      child.unref();
    } finally { closeSync(fd); }
  } catch (error) {
    throw new Error(`Server launch at ${serverDir}: ${error instanceof Error ? error.message : String(error)}; check permissions and installed runtime`);
  }

  let lastError = "daemon has not listened yet";
  while (Date.now() < deadline) {
    abortCheck(options.signal);
    try { return ready(await health(socketPath, Math.min(500, deadline - Date.now()), options)); }
    catch (error) {
      abortCheck(options.signal);
      if (error instanceof HandshakeError) throw new Error(`Server readiness at ${socketPath}: ${error.message}. Listener was not replaced.`);
      lastError = error instanceof Error ? error.message : String(error);
    }
    // Competing launchers may exit while the exclusive owner is still restoring its registry.
    await delay(Math.min(100, Math.max(1, deadline - Date.now())), undefined, { signal: options.signal });
  }
  let tail = "";
  try {
    const fd = openSync(logPath, "r");
    try {
      const size = fstatSync(fd).size;
      const buffer = Buffer.alloc(Math.min(2_000, size));
      readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      tail = buffer.toString("utf8").trim();
    } finally { closeSync(fd); }
  } catch { /* The log path remains actionable. */ }
  throw new Error(`Server readiness timed out after ${timeoutMs}ms at ${socketPath}: ${exitDetail || lastError}. Inspect ${logPath}${tail ? `\n${tail}` : ""}`);
}
