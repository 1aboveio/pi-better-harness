import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultServerDir, socketPathFor } from "../paths.ts";
import { createSshMuxController, resolveSshCommand, type SshMuxController } from "../shared-ssh-core/index.ts";
import { createProcessRunner } from "./process-runner.ts";
import { ensureArgs, parseReadiness, remoteEnsureScript } from "../startup/commands.ts";
import { absolutePath, discoverLocalRuntime, INSTALL_GUIDANCE, parseRuntime, remoteRuntimeScript } from "../startup/runtime.ts";

export interface TargetOptions {
  /** ssh alias (or user@host) of the machine running the daemon. Absent: the local daemon. */
  host?: string;
  /** Explicit daemon socket on this machine (local mode only). */
  socket?: string;
  /** Daemon server dir on the remote host. Default: ask the remote shell. */
  remoteDir?: string;
  /** Where the ssh ControlMaster sockets live; default is ssh-core's. */
  controlPathRoot?: string;
  /** Cancels connection setup only, not a successfully resolved target. */
  signal?: AbortSignal;
  /** Pi startup is enabled by default. Transport-only callers can opt out. */
  ensureServer?: boolean;
  /** Codex must retain its own startup path; never auto-start a Pi daemon for it. */
  agent?: "pi" | "codex";
  onProgress?: (stage: "ssh" | "directory" | "server" | "forward") => void;
}

export interface Target {
  /** Unix socket on this machine that reaches the daemon. */
  socketPath: string;
  /**
   * Reach another unix socket on the same machine as the daemon (e.g. the Codex app-server's
   * control socket) through a second SSH forward. For the local daemon it is the same path.
   */
  forwardSocket(remoteSocketPath: string): Promise<{ socketPath: string; close(): Promise<void> }>;
  /** Stop forwarding. The ControlMaster is left to expire so the next command reconnects instantly. */
  close(): Promise<void>;
}

/** Remote shell expression for the daemon's server dir, matching `defaultServerDir()`. */
const REMOTE_SERVER_DIR_SCRIPT = 'printf %s "${PI_SERVER_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/server}"';

export async function resolveTarget(options: TargetOptions): Promise<Target> {
  const checkAbort = () => {
    if (options.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
  };
  const progress = (stage: "ssh" | "directory" | "server" | "forward") => {
    checkAbort();
    options.onProgress?.(stage);
    checkAbort();
  };
  checkAbort();
  const ensureServer = options.ensureServer !== false && (options.agent ?? process.env.PI_SERVER_AGENT ?? "pi") === "pi";
  if (!options.host) {
    let socketPath = options.socket;
    const candidate = ensureServer && !options.socket ? discoverLocalRuntime() : undefined;
    if (candidate) {
      progress("directory");
      const runner = createProcessRunner({ signal: options.signal });
      const discovery = await runner.runOnce({
        shell: false, argv: [candidate.launcher, "runtime", "--agent", "pi"],
        env: candidate.discoveryEnv,
      }, undefined, 30_000);
      checkAbort();
      if (discovery.exitCode !== 0) throw new Error(`Runtime discovery: ${discovery.stderr.trim() || "launcher failed"}. ${INSTALL_GUIDANCE}`);
      const runtime = parseRuntime(discovery.stdout);
      const serverDir = process.env.PI_SERVER_DIR || runtime.defaultServerDir;
      progress("server");
      const result = await runner.runOnce({
        shell: false, argv: [runtime.launcher, ...ensureArgs(serverDir)],
        env: { PI_CODING_AGENT_DIR: runtime.agentDir, PI_SERVER_DIR: serverDir },
      }, undefined, 30_000);
      checkAbort();
      if (result.exitCode !== 0) throw new Error(`Server ensure at ${serverDir}: ${result.stderr.trim() || "launcher failed"}. ${INSTALL_GUIDANCE}`);
      socketPath = parseReadiness(result.stdout, serverDir).socketPath;
    }
    socketPath ??= socketPathFor(defaultServerDir());
    return {
      socketPath,
      forwardSocket: async (remoteSocketPath) => ({ socketPath: remoteSocketPath, close: async () => undefined }),
      close: async () => undefined,
    };
  }
  if (options.socket) throw new Error("--socket and --host cannot be combined; use --remote-dir to point at a remote daemon");

  const runner = createProcessRunner({ signal: options.signal });
  const base = resolveSshCommand({ command: "true", ssh: { host: options.host } });
  const muxOptions = {
    ...base,
    sessionScope: "pi-remote",
    ...(options.controlPathRoot ? { controlPathRoot: options.controlPathRoot } : {}),
  };
  const mux: SshMuxController = createSshMuxController({ ...muxOptions, runner });
  // The setup signal must not disable cleanup or forwards opened by the established target.
  const liveMux = createSshMuxController({ ...muxOptions, runner: createProcessRunner() });
  progress("ssh");
  await mux.ensure();
  checkAbort();

  progress("directory");
  let remoteDir = options.remoteDir ?? process.env.PI_REMOTE_SERVER_DIR;
  let remoteSocket: string;
  if (ensureServer) {
    const discovery = resolveSshCommand({ command: remoteRuntimeScript(process.env.PI_SERVER_COMMAND), ssh: { host: options.host } });
    const found = await runner.runOnce(mux.withMux(discovery.commandSpec), undefined, 30_000);
    checkAbort();
    if (found.exitCode !== 0) throw new Error(`Runtime discovery on ${options.host}: ${found.stderr.trim() || "no installed runtime"}. ${INSTALL_GUIDANCE}`);
    let runtime;
    try { runtime = parseRuntime(found.stdout); }
    catch (error) { throw new Error(`Runtime discovery on ${options.host}: ${String(error)}. ${INSTALL_GUIDANCE}`); }
    remoteDir = absolutePath(remoteDir ?? runtime.defaultServerDir, "--remote-dir");
    progress("server");
    const ensure = resolveSshCommand({ command: remoteEnsureScript(runtime, remoteDir), ssh: { host: options.host } });
    const result = await runner.runOnce(mux.withMux(ensure.commandSpec), undefined, 30_000);
    checkAbort();
    if (result.exitCode !== 0) throw new Error(`Server ensure on ${options.host} at ${remoteDir}: ${result.stderr.trim() || (result.timedOut ? "SSH readiness command timed out" : "launcher failed")}. ${INSTALL_GUIDANCE}`);
    try { remoteSocket = parseReadiness(result.stdout, remoteDir).socketPath; }
    catch (error) { throw new Error(`Server readiness on ${options.host} at ${remoteDir}: ${String(error)}`); }
  } else {
    if (!remoteDir) {
      const probe = resolveSshCommand({ command: REMOTE_SERVER_DIR_SCRIPT, ssh: { host: options.host } });
      const result = await runner.runOnce(mux.withMux(probe.commandSpec), undefined, 30_000);
      checkAbort();
      remoteDir = result.stdout.trim();
      if (result.exitCode !== 0 || !remoteDir.startsWith("/")) {
        throw new Error(`Could not find the daemon directory on ${options.host}: ${result.stderr.trim() || result.stdout.trim() || "empty answer"}`);
      }
    }
    if (!remoteDir.startsWith("/")) throw new Error(`--remote-dir must be an absolute path on ${options.host}: ${remoteDir}`);
    remoteSocket = socketPathFor(remoteDir);
  }

  progress("forward");
  // A private directory keeps the forwarded socket reachable by this user only; /tmp keeps the path short.
  const localDir = mkdtempSync(join(process.env.PI_REMOTE_TMP ?? (existsSync("/tmp") ? "/tmp" : tmpdir()), "pi-remote-"));
  const localSocket = join(localDir, "s.sock");
  try {
    await mux.forwardUnixSocket(localSocket, remoteSocket);
    checkAbort();
  } catch (error) {
    await liveMux.cancelUnixSocketForward(localSocket, remoteSocket).catch(() => undefined);
    rmSync(localDir, { recursive: true, force: true });
    checkAbort();
    throw error;
  }
  return {
    socketPath: localSocket,
    async forwardSocket(remoteSocketPath) {
      const dir = mkdtempSync(join(process.env.PI_REMOTE_TMP ?? (existsSync("/tmp") ? "/tmp" : tmpdir()), "pi-remote-"));
      const local = join(dir, "f.sock");
      try {
        await liveMux.forwardUnixSocket(local, remoteSocketPath);
      } catch (error) {
        await liveMux.cancelUnixSocketForward(local, remoteSocketPath).catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
        throw error;
      }
      return {
        socketPath: local,
        async close() {
          await liveMux.cancelUnixSocketForward(local, remoteSocketPath).catch(() => undefined);
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
    async close() {
      await liveMux.cancelUnixSocketForward(localSocket, remoteSocket).catch(() => undefined);
      rmSync(localDir, { recursive: true, force: true });
    },
  };
}
