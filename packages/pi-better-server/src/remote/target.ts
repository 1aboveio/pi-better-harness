import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultServerDir, socketPathFor } from "../paths.ts";
import { createSshMuxController, resolveSshCommand, type SshMuxController } from "../shared-ssh-core/index.ts";
import { createProcessRunner } from "./process-runner.ts";

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
  onProgress?: (stage: "ssh" | "directory" | "forward") => void;
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
  const progress = (stage: "ssh" | "directory" | "forward") => {
    checkAbort();
    options.onProgress?.(stage);
    checkAbort();
  };
  checkAbort();
  if (!options.host) {
    return {
      socketPath: options.socket ?? socketPathFor(defaultServerDir()),
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
  const remoteSocket = socketPathFor(remoteDir);

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
