import { runCommandOnce, spawnCommand } from "./process.js";
import type { SpawnedProcess } from "./process.js";
import {
  createTmuxSessionController,
  resolveSshCommand,
} from "./shared-ssh-core/index.js";
import type {
  RemoteRunner,
  TmuxBootstrapOptions,
  TmuxBootstrapResult,
  TmuxPackageManager,
  TmuxSessionPollResult,
} from "./shared-ssh-core/index.js";
import type {
  CommandResult,
  CommandSpec,
  RemoteTaskParams,
  ResolvedRemoteTaskMetadata,
  ResolvedSshIdentity,
  SshConnectionParams,
} from "./types.js";

export {
  DEFAULT_SSH_CONNECT_TIMEOUT_SECONDS,
  DEFAULT_TMUX_BOOTSTRAP_TIMEOUT_MS,
} from "./shared-ssh-core/index.js";
export type {
  RemoteRunner,
  TmuxBootstrapOptions,
  TmuxBootstrapResult,
  TmuxPackageManager,
  TmuxSessionPollResult,
};

export interface SshRemoteTaskIntent {
  operation: "spawn" | "watch";
  taskId?: string;
  sessionName?: string;
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
  bootstrapTmux(options?: TmuxBootstrapOptions): Promise<TmuxBootstrapResult>;
  startTmuxSession(tmuxPath: string): Promise<CommandResult>;
  pollTmuxSession(logOffset: number, timeoutMs?: number): Promise<TmuxSessionPollResult>;
  killTmuxSession(): Promise<CommandResult>;
  spawn(logPath: string, detached: boolean): SpawnedProcess;
  runOnce(maxBufferBytes?: number, timeoutMs?: number): Promise<CommandResult>;
}

const processRemoteRunner: RemoteRunner = {
  spawn: spawnCommand,
  runOnce: runCommandOnce,
};
const DIRECT_STOP_WARNING = "Direct SSH mode has weak stop semantics: stopping the local SSH client may leave the remote process running.";

export function expandSshRemoteTaskPreset(
  intent: SshRemoteTaskIntent,
  runner: RemoteRunner = processRemoteRunner,
): ResolvedSshRemoteTask {
  const resolved = resolveSshCommand({
    command: intent.command,
    cwd: intent.cwd,
    env: intent.env,
    ssh: intent.ssh,
  });
  const command = resolved.commandSpec.command!;
  const session = intent.operation === "spawn" ? intent.remote?.session ?? "tmux" : "direct";
  const installTmux = intent.operation === "spawn" && session === "tmux"
    ? intent.remote?.install_tmux !== false
    : false;
  const sessionName = session === "tmux"
    ? intent.sessionName ?? (intent.taskId ? sessionNameForTask(intent.taskId) : undefined)
    : undefined;
  const remote: ResolvedRemoteTaskMetadata = {
    command,
    session,
    installTmux,
    ...(intent.remote?.workdir !== undefined ? { workdir: intent.remote.workdir } : {}),
    ...(sessionName ? { sessionName, bootstrapStatus: "pending", sessionStarted: false } : {}),
    ...(session === "direct" && intent.operation === "spawn" ? { warning: DIRECT_STOP_WARNING } : {}),
  };
  const controller = createTmuxSessionController({
    ...resolved,
    runner,
    sessionName: sessionName ?? "pi-bg-unused",
    command,
    workdir: intent.remote?.workdir,
    installTmux,
  });
  const requireTmuxSession = (): void => {
    if (!sessionName) throw new Error("taskId is required for tmux-backed SSH spawn lifecycle operations");
  };

  return {
    commandSpec: resolved.commandSpec,
    metadata: { ssh: resolved.identity, remote },
    bootstrapTmux: (options) => controller.bootstrapTmux(options),
    startTmuxSession: (tmuxPath) => {
      requireTmuxSession();
      return controller.startTmuxSession(tmuxPath);
    },
    pollTmuxSession: (logOffset, timeoutMs) => {
      requireTmuxSession();
      return controller.pollTmuxSession(logOffset, timeoutMs);
    },
    killTmuxSession: () => {
      requireTmuxSession();
      return controller.killTmuxSession();
    },
    spawn: (logPath, detached) => runner.spawn(resolved.commandSpec, logPath, detached),
    runOnce: (maxBufferBytes, timeoutMs) => runner.runOnce(resolved.commandSpec, maxBufferBytes, timeoutMs),
  };
}

function sessionNameForTask(taskId: string): string {
  return `pi-bg-${taskId.replaceAll(/[^A-Za-z0-9_-]/g, "-")}`;
}
