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
}

export interface Target {
  /** Unix socket on this machine that reaches the daemon. */
  socketPath: string;
  /** Stop forwarding. The ControlMaster is left to expire so the next command reconnects instantly. */
  close(): Promise<void>;
}

/** Remote shell expression for the daemon's server dir, matching `defaultServerDir()`. */
const REMOTE_SERVER_DIR_SCRIPT = 'printf %s "${PI_SERVER_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/server}"';

export async function resolveTarget(options: TargetOptions): Promise<Target> {
  if (!options.host) {
    return { socketPath: options.socket ?? socketPathFor(defaultServerDir()), close: async () => undefined };
  }
  if (options.socket) throw new Error("--socket and --host cannot be combined; use --remote-dir to point at a remote daemon");

  const runner = createProcessRunner();
  const base = resolveSshCommand({ command: "true", ssh: { host: options.host } });
  const mux: SshMuxController = createSshMuxController({
    ...base,
    runner,
    sessionScope: "pi-remote",
    ...(options.controlPathRoot ? { controlPathRoot: options.controlPathRoot } : {}),
  });
  await mux.ensure();

  let remoteDir = options.remoteDir ?? process.env.PI_REMOTE_SERVER_DIR;
  if (!remoteDir) {
    const probe = resolveSshCommand({ command: REMOTE_SERVER_DIR_SCRIPT, ssh: { host: options.host } });
    const result = await runner.runOnce(mux.withMux(probe.commandSpec), undefined, 30_000);
    remoteDir = result.stdout.trim();
    if (result.exitCode !== 0 || !remoteDir.startsWith("/")) {
      throw new Error(`Could not find the daemon directory on ${options.host}: ${result.stderr.trim() || result.stdout.trim() || "empty answer"}`);
    }
  }
  if (!remoteDir.startsWith("/")) throw new Error(`--remote-dir must be an absolute path on ${options.host}: ${remoteDir}`);
  const remoteSocket = socketPathFor(remoteDir);

  // A private directory keeps the forwarded socket reachable by this user only; /tmp keeps the path short.
  const localDir = mkdtempSync(join(process.env.PI_REMOTE_TMP ?? (existsSync("/tmp") ? "/tmp" : tmpdir()), "pi-remote-"));
  const localSocket = join(localDir, "s.sock");
  try {
    await mux.forwardUnixSocket(localSocket, remoteSocket);
  } catch (error) {
    rmSync(localDir, { recursive: true, force: true });
    throw error;
  }
  return {
    socketPath: localSocket,
    async close() {
      await mux.cancelUnixSocketForward(localSocket, remoteSocket).catch(() => undefined);
      rmSync(localDir, { recursive: true, force: true });
    },
  };
}
