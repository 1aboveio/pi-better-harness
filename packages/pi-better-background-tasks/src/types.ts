import type { ResolvedSshIdentity, SshConnectionParams } from "./shared-ssh-core/index.js";

export type { ResolvedSshIdentity, SshConnectionParams };

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
  /** Bytes of stdout never stored because the capture cap was reached. */
  stdoutDiscardedBytes?: number;
  /** Bytes of stderr never stored because the capture cap was reached. */
  stderrDiscardedBytes?: number;
  /** True when stdout or stderr capture overflowed. Distinct from log retention. */
  captureTruncated?: boolean;
}

export interface RemoteTaskParams {
  session?: "tmux" | "direct";
  install_tmux?: boolean;
  workdir?: string;
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
  /**
   * The executable and argv this task was actually launched with, when that
   * differs from `command`/`argv` above — today, an OS write-sandbox wrapper
   * captured from the foreground policy at launch. Re-running a watch poll uses
   * it verbatim, which is how a running task keeps the policy it started under
   * even after the foreground policy changes. `command`/`argv` stay the operator's
   * own request, so status, navigator, and goal surfaces read unchanged.
   */
  launchArgv?: string[];
  maxLogBytes?: number;
  logDiscardedBytes?: number;
  logRetentionEvents?: number;
  /** Incremented on every same-inode compaction so log-page cursors can detect it. */
  logGeneration?: number;
  /** Bytes never captured into watch/command buffers. Distinct from logDiscardedBytes. */
  captureDiscardedBytes?: number;
  captureOverflowEvents?: number;
  stdoutDiscardedBytes?: number;
  stderrDiscardedBytes?: number;
  pid?: number;
  /** Opaque process-start token used to reject recycled child PIDs. */
  pidStartTime?: string;
  pgid?: number;
  spawnPid: number;
  /** Opaque process-start token used to reject recycled supervisor PIDs. */
  spawnPidStartTime?: string;
  successWhen?: Condition;
  failureWhen?: Condition;
  notifyOn?: "terminal";
  stopRequestedAt?: number;
  error?: string;
  /** Set when stop failed while the task is still running. Distinct from poll errors. */
  stopError?: string;
  ssh?: ResolvedSshIdentity;
  remote?: ResolvedRemoteTaskMetadata;
}

export interface TerminalResult {
  status: Exclude<BackgroundTaskStatus, "running">;
  reason: string;
  matchedCondition?: Condition;
  matchedValue?: unknown;
  commandResult?: CommandResult;
}

export function isTerminalStatus(status: BackgroundTaskStatus): boolean {
  return status !== "running";
}