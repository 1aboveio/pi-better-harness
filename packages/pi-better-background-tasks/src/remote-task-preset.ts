import { runCommandOnce, spawnCommand } from "./process.js";
import type { SpawnedProcess } from "./process.js";
import type {
  CommandResult,
  CommandSpec,
  RemoteTaskParams,
  ResolvedRemoteTaskMetadata,
  ResolvedSshIdentity,
  SshConnectionParams,
} from "./types.js";

export const DEFAULT_SSH_CONNECT_TIMEOUT_SECONDS = 10;

export interface RemoteRunner {
  spawn(spec: CommandSpec, logPath: string, detached: boolean): SpawnedProcess;
  runOnce(spec: CommandSpec, maxBufferBytes?: number): Promise<CommandResult>;
}

export interface SshRemoteTaskIntent {
  operation: "spawn" | "watch";
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  ssh: SshConnectionParams;
  remote?: RemoteTaskParams;
}

export interface ResolvedSshRemoteTask {
  commandSpec: CommandSpec;
  metadata: {
    ssh: ResolvedSshIdentity;
    remote: ResolvedRemoteTaskMetadata;
  };
  spawn(logPath: string, detached: boolean): SpawnedProcess;
  runOnce(maxBufferBytes?: number): Promise<CommandResult>;
}

const processRemoteRunner: RemoteRunner = {
  spawn: spawnCommand,
  runOnce: runCommandOnce,
};

const REQUIRED_SSH_OPTIONS = new Set(["batchmode", "connecttimeout", "requesttty"]);

export function expandSshRemoteTaskPreset(
  intent: SshRemoteTaskIntent,
  runner: RemoteRunner = processRemoteRunner,
): ResolvedSshRemoteTask {
  const command = requireValue(intent.command, "command is required when ssh is set");
  const host = requireToken(intent.ssh.host, "ssh.host is required");
  const user = optionalToken(intent.ssh.user, "ssh.user must not be empty or contain whitespace");
  const target = user ? `${user}@${host}` : host;
  const argv = [
    "ssh",
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${DEFAULT_SSH_CONNECT_TIMEOUT_SECONDS}`,
    "-T",
  ];

  if (intent.ssh.port !== undefined) {
    if (!Number.isInteger(intent.ssh.port) || intent.ssh.port < 1 || intent.ssh.port > 65_535) {
      throw new Error("ssh.port must be an integer between 1 and 65535");
    }
    argv.push("-p", String(intent.ssh.port));
  }

  const identityFile = optionalValue(intent.ssh.identity_file, "ssh.identity_file must not be empty");
  if (identityFile) argv.push("-i", identityFile);
  const jump = optionalValue(intent.ssh.jump, "ssh.jump must not be empty");
  if (jump) argv.push("-J", jump);

  for (const [rawKey, rawValue] of Object.entries(intent.ssh.options ?? {})) {
    const key = requireToken(rawKey, "ssh option names must not be empty or contain whitespace");
    if (REQUIRED_SSH_OPTIONS.has(key.toLowerCase())) continue;
    argv.push("-o", `${key}=${String(rawValue)}`);
  }
  argv.push("--", target, command);

  const commandSpec: CommandSpec = {
    command,
    argv,
    shell: false,
    cwd: intent.cwd,
    env: intent.env,
  };
  const ssh: ResolvedSshIdentity = {
    host,
    ...(user ? { user } : {}),
    ...(intent.ssh.port !== undefined ? { port: intent.ssh.port } : {}),
    ...(identityFile ? { identityFile } : {}),
    ...(jump ? { jump } : {}),
    ...(intent.ssh.options ? { options: { ...intent.ssh.options } } : {}),
    target,
  };
  const remote: ResolvedRemoteTaskMetadata = {
    command,
    ...(intent.operation === "watch"
      ? { session: "direct", installTmux: false }
      : {
        ...(intent.remote?.session ? { session: intent.remote.session } : {}),
        ...(intent.remote?.install_tmux !== undefined ? { installTmux: intent.remote.install_tmux } : {}),
      }),
    ...(intent.remote?.workdir !== undefined ? { workdir: intent.remote.workdir } : {}),
  };

  return {
    commandSpec,
    metadata: { ssh, remote },
    spawn: (logPath, detached) => runner.spawn(commandSpec, logPath, detached),
    runOnce: (maxBufferBytes) => runner.runOnce(commandSpec, maxBufferBytes),
  };
}

function requireValue(value: string | undefined, message: string): string {
  if (!value || value.trim().length === 0) throw new Error(message);
  return value;
}

function requireToken(value: string | undefined, message: string): string {
  const resolved = requireValue(value, message).trim();
  if (/\s/.test(resolved)) throw new Error(message);
  return resolved;
}

function optionalValue(value: string | undefined, message: string): string | undefined {
  if (value === undefined) return undefined;
  return requireValue(value, message);
}

function optionalToken(value: string | undefined, message: string): string | undefined {
  if (value === undefined) return undefined;
  return requireToken(value, message);
}
