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
export const DEFAULT_TMUX_BOOTSTRAP_TIMEOUT_MS = 120_000;

export interface RemoteRunner {
  spawn(spec: CommandSpec, logPath: string, detached: boolean): SpawnedProcess;
  runOnce(spec: CommandSpec, maxBufferBytes?: number, timeoutMs?: number): Promise<CommandResult>;
}

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

export type TmuxPackageManager = "apt-get" | "dnf" | "yum" | "apk" | "pacman" | "zypper" | "brew";

type TmuxBootstrapCapability = {
  target: string;
  tmuxPath: string;
  tmuxVersion: string;
  message: string;
};

type TmuxBootstrapGuidance = {
  target: string;
  mutated: boolean;
  verifyCommand: string;
  message: string;
};

export type TmuxBootstrapResult =
  | (TmuxBootstrapCapability & {
    status: "present";
    mutated: false;
  })
  | (TmuxBootstrapCapability & {
    status: "installed";
    packageManager: TmuxPackageManager;
    mutated: true;
    installCommand: string;
    verifyCommand: string;
  })
  | (TmuxBootstrapGuidance & {
    status: "needs_user";
    reason: "passwordless_sudo_unavailable" | "install_disabled";
    packageManager: TmuxPackageManager;
    mutated: false;
    installCommand: string;
  })
  | (TmuxBootstrapGuidance & {
    status: "unknown_package_manager";
    mutated: false;
  })
  | (TmuxBootstrapGuidance & {
    status: "install_failed";
    packageManager?: TmuxPackageManager;
    exitCode: number | null;
    installCommand?: string;
  })
  | (TmuxBootstrapGuidance & {
    status: "timed_out";
    packageManager?: TmuxPackageManager;
    installCommand?: string;
  });

export interface TmuxBootstrapOptions {
  timeoutMs?: number;
}

export interface TmuxSessionPollResult {
  status: "running" | "missing" | "timed_out" | number;
  logSize: number;
  output: string;
  commandResult: CommandResult;
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

const REQUIRED_SSH_OPTIONS = new Set(["batchmode", "connecttimeout", "requesttty"]);
const DIRECT_STOP_WARNING = "Direct SSH mode has weak stop semantics: stopping the local SSH client may leave the remote process running.";
const TMUX_STATUS_PREFIX = "__PI_BG_STATUS__=";
const TMUX_SIZE_PREFIX = "__PI_BG_SIZE__=";
const TMUX_CAPTURE_CHUNK_BYTES = 256 * 1024;
const TMUX_PROBE_COMMAND = "tmux_path=$(command -v tmux) || exit 127; printf '%s\\n' \"$tmux_path\" && \"$tmux_path\" -V";
const TMUX_PACKAGE_MANAGERS: TmuxPackageManager[] = ["apt-get", "dnf", "yum", "apk", "pacman", "zypper", "brew"];
const TMUX_INSTALL_COMMANDS: Record<TmuxPackageManager, string> = {
  "apt-get": "apt-get update && apt-get install -y tmux",
  dnf: "dnf install -y tmux",
  yum: "yum install -y tmux",
  apk: "apk add --no-cache tmux",
  pacman: "pacman -Sy --noconfirm tmux",
  zypper: "zypper --non-interactive install tmux",
  brew: "brew install tmux",
};
const TMUX_DETECT_COMMAND = [
  "remote_user=$(id -un) || exit 1",
  "remote_uid=$(id -u) || exit 1",
  "package_manager=''",
  `for candidate in ${TMUX_PACKAGE_MANAGERS.join(" ")}; do if command -v \"$candidate\" >/dev/null 2>&1; then package_manager=$candidate; break; fi; done`,
  "if [ \"$package_manager\" = brew ]; then privilege=direct; elif [ \"$remote_uid\" -eq 0 ]; then privilege=root; elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then privilege=sudo; else privilege=needs_user; fi",
  "printf 'user=%s\\nuid=%s\\npm=%s\\nprivilege=%s\\n' \"$remote_user\" \"$remote_uid\" \"$package_manager\" \"$privilege\"",
].join("; ");

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

  const requireSessionName = (): string => {
    if (!sessionName) throw new Error("taskId is required for tmux-backed SSH spawn lifecycle operations");
    return sessionName;
  };

  return {
    commandSpec,
    metadata: { ssh, remote },
    bootstrapTmux: async (options) => bootstrapTmux(
      commandSpec,
      target,
      runner,
      installTmux,
      resolveBootstrapTimeoutMs(options?.timeoutMs),
    ),
    startTmuxSession: (tmuxPath) => runner.runOnce(withRemoteCommand(
      commandSpec,
      tmuxStartCommand(tmuxPath, requireSessionName(), command, intent.remote?.workdir),
    )),
    pollTmuxSession: async (logOffset, timeoutMs) => parseTmuxPollResult(await runner.runOnce(withRemoteCommand(
      commandSpec,
      tmuxPollCommand(requireSessionName(), logOffset),
    ), undefined, timeoutMs), logOffset),
    killTmuxSession: () => runner.runOnce(withRemoteCommand(
      commandSpec,
      `tmux kill-session -t ${shellQuote(requireSessionName())}`,
    )),
    spawn: (logPath, detached) => runner.spawn(commandSpec, logPath, detached),
    runOnce: (maxBufferBytes, timeoutMs) => runner.runOnce(commandSpec, maxBufferBytes, timeoutMs),
  };
}

function sessionNameForTask(taskId: string): string {
  return `pi-bg-${taskId.replaceAll(/[^A-Za-z0-9_-]/g, "-")}`;
}

function tmuxLogPath(sessionName: string): string {
  return `/tmp/${sessionName}.log`;
}

function tmuxExitPath(sessionName: string): string {
  return `/tmp/${sessionName}.exit`;
}

function tmuxStartCommand(tmuxPath: string, sessionName: string, command: string, workdir?: string): string {
  const logPath = tmuxLogPath(sessionName);
  const exitPath = tmuxExitPath(sessionName);
  const script = [
    ...(workdir ? [`cd -- ${shellQuote(workdir)}`] : []),
    `sh -lc ${shellQuote(command)} >${shellQuote(logPath)} 2>&1`,
    "exit_code=$?",
    `printf '%s\\n' "$exit_code" >${shellQuote(exitPath)}`,
    "exit \"$exit_code\"",
  ].join("; ");
  return [
    `rm -f ${shellQuote(logPath)} ${shellQuote(exitPath)}`,
    `${shellQuote(tmuxPath)} new-session -d -s ${shellQuote(sessionName)} sh -lc ${shellQuote(script)}`,
  ].join("; ");
}

function tmuxPollCommand(sessionName: string, logOffset: number): string {
  const normalizedOffset = Math.max(0, Math.floor(logOffset));
  const logPath = tmuxLogPath(sessionName);
  const exitPath = tmuxExitPath(sessionName);
  return [
    "status=running",
    `if test -f ${shellQuote(exitPath)}; then status=$(cat ${shellQuote(exitPath)}); elif ! tmux has-session -t ${shellQuote(sessionName)} 2>/dev/null; then status=missing; fi`,
    `size=$(wc -c < ${shellQuote(logPath)} 2>/dev/null || printf '0')`,
    "size=$(printf '%s' \"$size\" | tr -d '[:space:]')",
    `next_offset=$(( ${normalizedOffset} + ${TMUX_CAPTURE_CHUNK_BYTES} ))`,
    "if test \"$next_offset\" -gt \"$size\"; then next_offset=$size; fi",
    "reported_status=$status",
    "if test \"$next_offset\" -lt \"$size\"; then reported_status=running; fi",
    `printf '${TMUX_STATUS_PREFIX}%s\\n${TMUX_SIZE_PREFIX}%s\\n' "$reported_status" "$next_offset"`,
    `if test "$next_offset" -gt ${normalizedOffset}; then tail -c +${normalizedOffset + 1} ${shellQuote(logPath)} | head -c $(( next_offset - ${normalizedOffset} )); fi`,
  ].join("; ");
}

function parseTmuxPollResult(result: CommandResult, logOffset: number): TmuxSessionPollResult {
  if (result.timedOut) {
    return {
      status: "timed_out",
      logSize: Math.max(0, Math.floor(logOffset)),
      output: result.stdout,
      commandResult: result,
    };
  }
  const [statusLine = "", sizeLine = "", ...outputLines] = result.stdout.split("\n");
  if (!statusLine.startsWith(TMUX_STATUS_PREFIX) || !sizeLine.startsWith(TMUX_SIZE_PREFIX)) {
    throw new Error(`remote tmux supervision returned an invalid response${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`);
  }
  const rawStatus = statusLine.slice(TMUX_STATUS_PREFIX.length);
  const rawSize = sizeLine.slice(TMUX_SIZE_PREFIX.length);
  const logSize = Number(rawSize);
  if (!Number.isSafeInteger(logSize) || logSize < 0) {
    throw new Error(`remote tmux supervision returned invalid log size ${JSON.stringify(rawSize)}`);
  }
  const status = rawStatus === "running" || rawStatus === "missing"
    ? rawStatus
    : Number(rawStatus);
  if (typeof status === "number" && !Number.isInteger(status)) {
    throw new Error(`remote tmux supervision returned invalid status ${JSON.stringify(rawStatus)}`);
  }
  return {
    status,
    logSize,
    output: outputLines.join("\n"),
    commandResult: result,
  };
}

async function bootstrapTmux(
  commandSpec: CommandSpec,
  target: string,
  runner: RemoteRunner,
  installEnabled: boolean,
  timeoutMs: number,
): Promise<TmuxBootstrapResult> {
  const deadlineAt = Date.now() + timeoutMs;
  let timeoutContext: TmuxBootstrapTimeoutContext = {
    target,
    mutated: false,
    verifyCommand: sshGuidanceCommand(commandSpec, target, "command -v tmux && tmux -V"),
    stage: "probing tmux",
  };
  const run = async (remoteCommand: string): Promise<CommandResult> => {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new TmuxBootstrapTimeoutError();
    const result = await runner.runOnce(withRemoteCommand(commandSpec, remoteCommand), undefined, remainingMs);
    if (result.timedOut) throw new TmuxBootstrapTimeoutError();
    return result;
  };

  try {
    return await bootstrapTmuxWithinDeadline(run, commandSpec, target, installEnabled, timeoutContext, (context) => {
      timeoutContext = context;
    });
  } catch (error) {
    if (!(error instanceof TmuxBootstrapTimeoutError)) throw error;
    const remediation = timeoutContext.installCommand
      ? `Run: ${timeoutContext.installCommand} Then verify: ${timeoutContext.verifyCommand}`
      : `Install tmux manually if needed, then verify: ${timeoutContext.verifyCommand}`;
    return {
      status: "timed_out",
      target: timeoutContext.target,
      ...(timeoutContext.packageManager ? { packageManager: timeoutContext.packageManager } : {}),
      mutated: timeoutContext.mutated,
      ...(timeoutContext.installCommand ? { installCommand: timeoutContext.installCommand } : {}),
      verifyCommand: timeoutContext.verifyCommand,
      message: `tmux bootstrap timed out on ${timeoutContext.target} while ${timeoutContext.stage}. ${remediation}`,
    };
  }
}

interface TmuxBootstrapTimeoutContext {
  target: string;
  packageManager?: TmuxPackageManager;
  mutated: boolean;
  installCommand?: string;
  verifyCommand: string;
  stage: string;
}

class TmuxBootstrapTimeoutError extends Error {}

async function bootstrapTmuxWithinDeadline(
  run: (remoteCommand: string) => Promise<CommandResult>,
  commandSpec: CommandSpec,
  target: string,
  installEnabled: boolean,
  initialTimeoutContext: TmuxBootstrapTimeoutContext,
  setTimeoutContext: (context: TmuxBootstrapTimeoutContext) => void,
): Promise<TmuxBootstrapResult> {
  setTimeoutContext(initialTimeoutContext);
  const probe = await run(TMUX_PROBE_COMMAND);
  const capability = parseTmuxCapability(probe);
  if (capability) {
    return {
      status: "present",
      target,
      ...capability,
      mutated: false,
      message: `${capability.tmuxVersion} is available at ${capability.tmuxPath} on ${target}.`,
    };
  }
  const initialVerifyCommand = sshGuidanceCommand(commandSpec, target, "command -v tmux && tmux -V");
  if (probe.exitCode !== 127) {
    const detail = resultDetail(probe);
    return {
      status: "install_failed",
      target,
      exitCode: probe.exitCode,
      mutated: false,
      verifyCommand: initialVerifyCommand,
      message: `tmux bootstrap could not probe ${target} (exit ${probe.exitCode ?? "unknown"})${detail ? `: ${detail}` : "."} Install tmux manually if needed, then verify: ${initialVerifyCommand}`,
    };
  }

  setTimeoutContext({ ...initialTimeoutContext, stage: "detecting the package manager" });
  const detection = await run(TMUX_DETECT_COMMAND);
  if (detection.exitCode !== 0) {
    const detail = resultDetail(detection);
    return {
      status: "install_failed",
      target,
      exitCode: detection.exitCode,
      mutated: false,
      verifyCommand: initialVerifyCommand,
      message: `tmux bootstrap could not inspect ${target} for an installer (exit ${detection.exitCode ?? "unknown"})${detail ? `: ${detail}` : "."} Install tmux manually if needed, then verify: ${initialVerifyCommand}`,
    };
  }
  const detected = parseDetection(detection);
  const guidanceTarget = detected && !target.includes("@") ? `${detected.user}@${target}` : target;
  const verifyCommand = sshGuidanceCommand(commandSpec, guidanceTarget, "command -v tmux && tmux -V");
  if (!detected || !isTmuxPackageManager(detected.packageManager)) {
    return {
      status: "unknown_package_manager",
      target: guidanceTarget,
      mutated: false,
      verifyCommand,
      message: `tmux is missing on ${guidanceTarget}, but none of ${formatPackageManagerList()} was found. Install tmux manually, then verify: ${verifyCommand}`,
    };
  }

  const packageManager = detected.packageManager;
  const baseInstallCommand = TMUX_INSTALL_COMMANDS[packageManager];
  const needsSudo = detected.privilege === "sudo" || detected.privilege === "needs_user";
  const humanInstallCommand = needsSudo ? withInteractiveSudo(baseInstallCommand) : baseInstallCommand;
  const installCommand = sshGuidanceCommand(commandSpec, guidanceTarget, humanInstallCommand, needsSudo);
  if (!installEnabled) {
    return {
      status: "needs_user",
      reason: "install_disabled",
      target: guidanceTarget,
      packageManager,
      mutated: false,
      installCommand,
      verifyCommand,
      message: `Automatic tmux installation is disabled for ${guidanceTarget}. Run: ${installCommand} Then verify: ${verifyCommand}`,
    };
  }
  if (detected.privilege === "needs_user") {
    return {
      status: "needs_user",
      reason: "passwordless_sudo_unavailable",
      target: guidanceTarget,
      packageManager,
      mutated: false,
      installCommand,
      verifyCommand,
      message: `tmux is missing on ${guidanceTarget} and automatic installation cannot use passwordless sudo. Run: ${installCommand} Then verify: ${verifyCommand}`,
    };
  }

  const machineInstallCommand = detected.privilege === "sudo"
    ? withNonInteractiveSudo(baseInstallCommand)
    : baseInstallCommand;
  setTimeoutContext({
    target: guidanceTarget,
    packageManager,
    mutated: false,
    installCommand,
    verifyCommand,
    stage: `running the ${packageManager} install`,
  });
  const install = await run(machineInstallCommand);
  if (install.exitCode !== 0) {
    const detail = resultDetail(install);
    return {
      status: "install_failed",
      target: guidanceTarget,
      packageManager,
      exitCode: install.exitCode,
      mutated: false,
      installCommand,
      verifyCommand,
      message: `Automatic tmux install with ${packageManager} failed on ${guidanceTarget} (exit ${install.exitCode ?? "unknown"})${detail ? `: ${detail}` : "."} Run: ${installCommand} Then verify: ${verifyCommand}`,
    };
  }

  setTimeoutContext({
    target: guidanceTarget,
    packageManager,
    mutated: true,
    installCommand,
    verifyCommand,
    stage: "verifying the installed tmux",
  });
  const reprobe = await run(TMUX_PROBE_COMMAND);
  const installedCapability = parseTmuxCapability(reprobe);
  if (!installedCapability) {
    return {
      status: "install_failed",
      target: guidanceTarget,
      packageManager,
      exitCode: reprobe.exitCode,
      mutated: true,
      installCommand,
      verifyCommand,
      message: `The ${packageManager} install command completed but tmux did not pass verification on ${guidanceTarget}${resultDetail(reprobe) ? `: ${resultDetail(reprobe)}` : "."} Run: ${installCommand} Then verify: ${verifyCommand}`,
    };
  }
  return {
    status: "installed",
    target: guidanceTarget,
    packageManager,
    ...installedCapability,
    mutated: true,
    installCommand,
    verifyCommand,
    message: `Installed tmux with ${packageManager} on ${guidanceTarget}; ${installedCapability.tmuxVersion} is available at ${installedCapability.tmuxPath}.`,
  };
}

function resolveBootstrapTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_TMUX_BOOTSTRAP_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("tmux bootstrap timeoutMs must be a positive finite number");
  }
  return Math.floor(timeoutMs);
}

function parseTmuxCapability(result: CommandResult): { tmuxPath: string; tmuxVersion: string } | undefined {
  const [tmuxPath, tmuxVersion] = result.stdout.trim().split("\n");
  if (result.exitCode !== 0 || !tmuxPath || !tmuxVersion) return undefined;
  return { tmuxPath, tmuxVersion };
}

interface TmuxDetection {
  user: string;
  packageManager: string;
  privilege: "root" | "sudo" | "direct" | "needs_user";
}

function parseDetection(result: CommandResult): TmuxDetection | undefined {
  if (result.exitCode !== 0) return undefined;
  const values = Object.fromEntries(result.stdout.trim().split("\n").map((line) => {
    const separator = line.indexOf("=");
    return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
  }));
  if (!values.user || !/^(root|sudo|direct|needs_user)$/.test(values.privilege ?? "")) return undefined;
  return {
    user: values.user,
    packageManager: values.pm ?? "",
    privilege: values.privilege as TmuxDetection["privilege"],
  };
}

function isTmuxPackageManager(value: string | undefined): value is TmuxPackageManager {
  return TMUX_PACKAGE_MANAGERS.some((candidate) => candidate === value);
}

function formatPackageManagerList(): string {
  return `${TMUX_PACKAGE_MANAGERS.slice(0, -1).join(", ")}, or ${TMUX_PACKAGE_MANAGERS.at(-1)}`;
}

function resultDetail(result: CommandResult): string {
  return (result.stderr.trim() || result.stdout.trim()).replaceAll(/\s+/g, " ").slice(0, 500);
}

function withNonInteractiveSudo(command: string): string {
  return command.split(" && ").map((part) => `sudo -n ${part}`).join(" && ");
}

function withInteractiveSudo(command: string): string {
  return command.split(" && ").map((part) => `sudo ${part}`).join(" && ");
}

function sshGuidanceCommand(
  spec: CommandSpec,
  target: string,
  remoteCommand: string,
  tty = false,
): string {
  const argv = spec.argv ?? [];
  const separator = argv.lastIndexOf("--");
  const connectionArgs: string[] = [];
  for (let index = 1; index >= 0 && index < separator; index += 1) {
    const option = argv[index];
    if (option === "-T") continue;
    const value = argv[index + 1];
    if ((option === "-p" || option === "-i" || option === "-J") && value) {
      connectionArgs.push(option, shellQuote(value));
      index += 1;
      continue;
    }
    if (option === "-o" && value) {
      index += 1;
      const key = value.slice(0, value.indexOf("=")).toLowerCase();
      if (REQUIRED_SSH_OPTIONS.has(key)) continue;
      connectionArgs.push(option, shellQuote(value));
    }
  }
  const renderedArgs = connectionArgs.length > 0 ? ` ${connectionArgs.join(" ")}` : "";
  return `ssh${tty ? " -t" : ""}${renderedArgs} ${shellQuote(target)} ${shellQuote(remoteCommand)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function withRemoteCommand(spec: CommandSpec, remoteCommand: string): CommandSpec {
  return {
    ...spec,
    command: remoteCommand,
    argv: [...(spec.argv?.slice(0, -1) ?? []), remoteCommand],
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
