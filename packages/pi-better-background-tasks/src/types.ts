export type BackgroundTaskStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export type BackgroundTaskKind = "process" | "command_watch";

export type Condition =
  | { type: "exit_code"; equals: number }
  | { type: "stdout_contains"; value: string }
  | { type: "stderr_contains"; value: string }
  | { type: "json_path_equals"; path: string; value: unknown }
  | { type: "json_path_exists"; path: string };

export interface CommandSpec {
  command?: string;
  argv?: string[];
  shell?: boolean;
  cwd?: string;
  env?: Record<string, string>;
}

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  startedAt: number;
  endedAt: number;
  timedOut?: boolean;
}

export interface SshConnectionParams {
  host: string;
  user?: string;
  port?: number;
  identity_file?: string;
  jump?: string;
  options?: Record<string, string>;
}

export interface RemoteTaskParams {
  session?: "tmux" | "direct";
  install_tmux?: boolean;
  workdir?: string;
}

export interface ResolvedSshIdentity {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  jump?: string;
  options?: Record<string, string>;
  target: string;
}

export interface ResolvedRemoteTaskMetadata {
  command: string;
  session?: "tmux" | "direct";
  installTmux?: boolean;
  workdir?: string;
  sessionName?: string;
  bootstrapStatus?: "pending" | "present" | "installed" | "needs_user" | "unknown_package_manager" | "install_failed" | "timed_out";
  bootstrapMessage?: string;
  tmuxInstalled?: boolean;
  sessionStarted?: boolean;
  logOffset?: number;
  warning?: string;
  stopMessage?: string;
}

export interface BackgroundTaskCallbackOrigin {
  cwd: string;
  sessionId?: string;
}

export interface BackgroundTaskMeta {
  id: string;
  name?: string;
  kind: BackgroundTaskKind;
  status: BackgroundTaskStatus;
  startedAt: number;
  endedAt?: number;
  deadlineAt?: number;
  intervalMs?: number;
  lastCheckedAt?: number;
  /** Latest command completion or observed process log output. */
  lastProgressAt?: number;
  lastExitCode?: number | null;
  lastSignal?: NodeJS.Signals | null;
  lastState?: unknown;
  result?: unknown;
  logPath: string;
  callback?: boolean;
  callbackSentAt?: number;
  callbackOrigin?: BackgroundTaskCallbackOrigin;
  callbackSuppressedAt?: number;
  callbackSuppressedReason?: string;
  dismissedAt?: number;
  command?: string;
  argv?: string[];
  shell?: boolean;
  cwd: string;
  env?: Record<string, string>;
  maxLogBytes?: number;
  logDiscardedBytes?: number;
  logRetentionEvents?: number;
  pid?: number;
  pgid?: number;
  spawnPid: number;
  successWhen?: Condition;
  failureWhen?: Condition;
  notifyOn?: "terminal";
  stopRequestedAt?: number;
  error?: string;
  ssh?: ResolvedSshIdentity;
  remote?: ResolvedRemoteTaskMetadata;
}

export interface TerminalResult {
  status: Exclude<BackgroundTaskStatus, "running">;
  reason: string;
  matchedCondition?: Condition;
  commandResult?: CommandResult;
}

export function isTerminalStatus(status: BackgroundTaskStatus): boolean {
  return status !== "running";
}