// Generated fixed launch domain from packages/pi-better-background-tasks/src/shared-ssh-core/index.ts. Do not edit directly.
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
export const DEFAULT_SSH_CONNECT_TIMEOUT_SECONDS = 10;
export const DEFAULT_SSH_CONTROL_PERSIST_SECONDS = 600;
export const MAX_SSH_CONTROL_PATH_BYTES = 100;
/** The longest socket name under a ControlPath root: `cm-` plus a 32-char hash. */
const MUX_CONTROL_PATH_NAME_TEMPLATE = `cm-${"0".repeat(32)}`;
export const DEFAULT_TMUX_BOOTSTRAP_TIMEOUT_MS = 120_000;
export class SshMuxError extends Error {
    // Declared, not a parameter property: Node's native type stripping (pi-better-server) cannot run those.
    commandResult;
    constructor(message, commandResult) {
        super(message);
        this.name = "SshMuxError";
        this.commandResult = commandResult;
    }
}
const REQUIRED_SSH_OPTIONS = new Set(["batchmode", "connecttimeout", "requesttty"]);
const MUX_CONTROL_OPTIONS = new Set(["controlmaster", "controlpath", "controlpersist"]);
const TMUX_STATUS_PREFIX = "__PI_BG_STATUS__=";
const TMUX_SIZE_PREFIX = "__PI_BG_SIZE__=";
const TMUX_PATH_PREFIX = "__PI_BG_TMUX_PATH__=";
const TMUX_VERSION_PREFIX = "__PI_BG_TMUX_VERSION__=";
const TMUX_CAPTURE_CHUNK_BYTES = 256 * 1024;
const TMUX_PROBE_COMMAND = [
    "tmux_path=$(command -v tmux) || exit 127",
    `printf '${TMUX_PATH_PREFIX}%s\\n' "$tmux_path"`,
    `printf '${TMUX_VERSION_PREFIX}%s\\n' "$("$tmux_path" -V)"`,
].join("; ");
const TMUX_PACKAGE_MANAGERS = ["apt-get", "dnf", "yum", "apk", "pacman", "zypper", "brew"];
const TMUX_INSTALL_COMMANDS = {
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
export function resolveSshCommand(input) {
    const command = requireValue(input.command, "command is required when ssh is set");
    const host = requireToken(input.ssh.host, "ssh.host is required");
    const user = optionalToken(input.ssh.user, "ssh.user must not be empty or contain whitespace");
    const target = user ? `${user}@${host}` : host;
    const argv = [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", `ConnectTimeout=${DEFAULT_SSH_CONNECT_TIMEOUT_SECONDS}`,
        "-T",
    ];
    if (input.ssh.port !== undefined) {
        if (!Number.isInteger(input.ssh.port) || input.ssh.port < 1 || input.ssh.port > 65_535) {
            throw new Error("ssh.port must be an integer between 1 and 65535");
        }
        argv.push("-p", String(input.ssh.port));
    }
    const identityFile = optionalValue(input.ssh.identity_file, "ssh.identity_file must not be empty");
    if (identityFile)
        argv.push("-i", identityFile);
    const jump = optionalValue(input.ssh.jump, "ssh.jump must not be empty");
    if (jump)
        argv.push("-J", jump);
    for (const [rawKey, rawValue] of Object.entries(input.ssh.options ?? {})) {
        const key = requireToken(rawKey, "ssh option names must not be empty or contain whitespace");
        if (REQUIRED_SSH_OPTIONS.has(key.toLowerCase()))
            continue;
        argv.push("-o", `${key}=${String(rawValue)}`);
    }
    argv.push("--", target, command);
    return {
        commandSpec: {
            command,
            argv,
            shell: false,
            cwd: input.cwd,
            env: input.env,
        },
        identity: {
            host,
            ...(user ? { user } : {}),
            ...(input.ssh.port !== undefined ? { port: input.ssh.port } : {}),
            ...(identityFile ? { identityFile } : {}),
            ...(jump ? { jump } : {}),
            ...(input.ssh.options ? { options: { ...input.ssh.options } } : {}),
            target,
        },
    };
}
export function wrapRemoteBashCommand(input) {
    const command = requireValue(input.command, "remote bash command is required");
    const workdir = input.workdir === undefined
        ? undefined
        : requireValue(input.workdir, "remote bash workdir must not be empty");
    const preamble = input.preamble === undefined
        ? undefined
        : requireValue(input.preamble, "remote bash preamble must not be empty");
    const script = [
        ...(workdir ? [`cd -- ${shellQuote(workdir)} || exit $?`] : []),
        ...Object.entries(input.env ?? {})
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, value]) => {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
                throw new Error(`invalid remote environment variable name: ${JSON.stringify(name)}`);
            }
            return `export ${name}=${shellQuote(String(value))}`;
        }),
        ...(preamble ? [preamble] : []),
        command,
    ].join("\n");
    return `bash -c ${shellQuote(script)}`;
}
export function defaultSshControlPathRoot() {
    const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    const root = join(agentDirectory, "ssh-control");
    // A long agent directory would push the socket past the unix path limit; fall back to a short per-user root.
    if (Buffer.byteLength(join(root, MUX_CONTROL_PATH_NAME_TEMPLATE)) <= MAX_SSH_CONTROL_PATH_BYTES)
        return root;
    return join("/tmp", `pi-ssh-${process.getuid?.() ?? "user"}`);
}
/**
 * Manages connection reuse for short synchronous SSH commands only.
 * Durable remote jobs must remain correct when no ControlMaster exists.
 */
export function createSshMuxController(options) {
    const sessionScope = requireValue(options.sessionScope, "ssh mux sessionScope is required").trim();
    // Native Windows OpenSSH cannot provide a working ControlMaster socket.
    if ((options.platform ?? process.platform) === "win32") {
        const commandResult = {
            exitCode: null, signal: null, stdout: "", stderr: "", startedAt: 0, endedAt: 0,
        };
        const disabled = {
            state: "down",
            target: options.identity.target,
            controlPath: "",
            detail: "SSH multiplexing is disabled on Windows; commands use independent connections.",
            commandResult,
        };
        const unsupportedForward = async () => {
            throw new SshMuxError("SSH Unix socket forwarding is not supported on Windows without ControlMaster.", commandResult);
        };
        return {
            controlPath: "",
            forwardUnixSocket: unsupportedForward,
            cancelUnixSocketForward: unsupportedForward,
            status: async () => disabled,
            ensure: async () => ({ ...disabled, reused: false }),
            cleanup: async () => ({ ...disabled, state: "not_running" }),
            withMux: (commandSpec) => muxCommandSpec(commandSpec, options.identity.target, [
                "-o", "ControlMaster=no",
                "-o", "ControlPersist=no",
                "-o", "ControlPath=none",
            ], true),
        };
    }
    const controlPathRoot = resolve(options.controlPathRoot ?? defaultSshControlPathRoot());
    const controlPath = join(controlPathRoot, `cm-${muxIdentityHash(options.identity, sessionScope)}`);
    if (Buffer.byteLength(controlPath) > MAX_SSH_CONTROL_PATH_BYTES) {
        throw new Error(`ssh mux ControlPath exceeds ${MAX_SSH_CONTROL_PATH_BYTES} bytes; configure a shorter controlPathRoot`);
    }
    const target = options.identity.target;
    const prepareRoot = () => ensureControlPathRoot(controlPathRoot);
    const forwardOperation = async (operation, localPath, remotePath) => {
        for (const [name, value] of [["localPath", localPath], ["remotePath", remotePath]]) {
            if (!value || /[\s:]/.test(value))
                throw new Error(`ssh forward ${name} must be non-empty and contain no whitespace or colon`);
        }
        prepareRoot();
        const commandResult = await options.runner.runOnce(muxCommandSpec(options.commandSpec, target, [
            "-o", "ControlMaster=no",
            "-o", `ControlPath=${controlPath}`,
            "-O", operation,
            "-L", `${localPath}:${remotePath}`,
        ], false));
        if (operation === "cancel")
            rmSync(localPath, { force: true });
        if (!commandSucceeded(commandResult)) {
            throw new SshMuxError(`SSH ${operation} of ${localPath} -> ${target}:${remotePath} failed${resultDetail(commandResult) ? `: ${resultDetail(commandResult)}` : "."}`, commandResult);
        }
        return { target, localPath, remotePath, detail: resultDetail(commandResult), commandResult };
    };
    const buildControlCommand = (operation) => {
        prepareRoot();
        return muxCommandSpec(options.commandSpec, target, [
            "-o", "ControlMaster=no",
            "-o", `ControlPath=${controlPath}`,
            "-O", operation,
        ], false);
    };
    const status = async () => {
        const commandResult = await options.runner.runOnce(buildControlCommand("check"));
        return {
            state: commandSucceeded(commandResult) ? "up" : "down",
            target,
            controlPath,
            detail: resultDetail(commandResult) || (commandSucceeded(commandResult) ? "ControlMaster is running." : "ControlMaster is not running."),
            commandResult,
        };
    };
    return {
        controlPath,
        status,
        forwardUnixSocket: async (localPath, remotePath) => {
            rmSync(localPath, { force: true }); // ssh will not bind over a stale socket file
            return await forwardOperation("forward", localPath, remotePath);
        },
        cancelUnixSocketForward: (localPath, remotePath) => forwardOperation("cancel", localPath, remotePath),
        withMux: (commandSpec) => {
            prepareRoot();
            return muxCommandSpec(commandSpec, target, [
                "-o", "ControlMaster=no",
                "-o", `ControlPath=${controlPath}`,
            ], true);
        },
        ensure: async () => {
            const existing = await status();
            if (existing.state === "up")
                return { ...existing, state: "up", reused: true };
            rmSync(controlPath, { force: true });
            const opened = await options.runner.runOnce(muxCommandSpec(options.commandSpec, target, [
                "-o", "ControlMaster=yes",
                "-o", `ControlPersist=${DEFAULT_SSH_CONTROL_PERSIST_SECONDS}`,
                "-o", `ControlPath=${controlPath}`,
                "-N", "-f",
            ], false));
            if (!commandSucceeded(opened)) {
                throw new SshMuxError(`SSH ControlMaster for ${target} failed to establish after one reopen attempt${resultDetail(opened) ? `: ${resultDetail(opened)}` : "."}`, opened);
            }
            const reopened = await status();
            if (reopened.state !== "up") {
                throw new SshMuxError(`SSH ControlMaster for ${target} failed to establish after one reopen attempt${reopened.detail ? `: ${reopened.detail}` : "."}`, reopened.commandResult);
            }
            return { ...reopened, state: "up", reused: false };
        },
        cleanup: async () => {
            let commandResult;
            try {
                commandResult = await options.runner.runOnce(buildControlCommand("exit"));
            }
            finally {
                rmSync(controlPath, { force: true });
            }
            return {
                state: commandSucceeded(commandResult) ? "stopped" : "not_running",
                target,
                controlPath,
                detail: resultDetail(commandResult) || (commandSucceeded(commandResult) ? "ControlMaster stopped." : "ControlMaster was not running."),
                commandResult,
            };
        },
    };
}
export function createTmuxSessionController(options) {
    return {
        bootstrapTmux: (bootstrapOptions) => bootstrapTmux(options.commandSpec, options.identity.target, options.runner, options.installTmux, resolveBootstrapTimeoutMs(bootstrapOptions?.timeoutMs)),
        startTmuxSession: (tmuxPath) => options.runner.runOnce(withRemoteCommand(options.commandSpec, tmuxStartCommand(tmuxPath, options.sessionName, options.command, options.workdir))),
        pollTmuxSession: async (logOffset, timeoutMs) => parseTmuxPollResult(await options.runner.runOnce(withRemoteCommand(options.commandSpec, tmuxPollCommand(options.sessionName, logOffset)), undefined, timeoutMs), logOffset),
        killTmuxSession: () => options.runner.runOnce(withRemoteCommand(options.commandSpec, `tmux kill-session -t ${shellQuote(options.sessionName)}`)),
    };
}
function muxIdentityHash(identity, sessionScope) {
    const optionValues = new Map();
    for (const [rawKey, rawValue] of Object.entries(identity.options ?? {})) {
        const key = rawKey.toLowerCase();
        if (REQUIRED_SSH_OPTIONS.has(key) || MUX_CONTROL_OPTIONS.has(key) || optionValues.has(key))
            continue;
        optionValues.set(key, String(rawValue));
    }
    const effectiveOptions = [...optionValues].sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
    const connectionIdentity = JSON.stringify({
        version: 1,
        sessionScope,
        target: identity.target,
        port: identity.port ?? null,
        identityFile: identity.identityFile ?? null,
        jump: identity.jump ?? null,
        options: effectiveOptions,
    });
    return createHash("sha256").update(connectionIdentity).digest("hex").slice(0, 32);
}
function ensureControlPathRoot(controlPathRoot) {
    mkdirSync(controlPathRoot, { recursive: true, mode: 0o700 });
    const stats = lstatSync(controlPathRoot);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(`ssh mux ControlPath root must be a real directory: ${controlPathRoot}`);
    }
    if (process.getuid && stats.uid !== process.getuid()) {
        throw new Error(`ssh mux ControlPath root must be owned by the current user: ${controlPathRoot}`);
    }
    chmodSync(controlPathRoot, 0o700);
}
function muxCommandSpec(commandSpec, target, muxArgv, preserveRemoteCommand) {
    const argv = commandSpec.argv ?? [];
    const separator = argv.lastIndexOf("--");
    if (argv[0] !== "ssh" || separator < 1 || argv[separator + 1] !== target) {
        throw new Error("ssh mux requires a command produced by resolveSshCommand");
    }
    const connectionArgv = withoutCallerMuxOptions(argv.slice(0, separator));
    const destinationArgv = preserveRemoteCommand ? argv.slice(separator + 1) : [target];
    return {
        ...(preserveRemoteCommand && commandSpec.command !== undefined ? { command: commandSpec.command } : {}),
        argv: [...connectionArgv, ...muxArgv, "--", ...destinationArgv],
        shell: false,
        ...(commandSpec.cwd !== undefined ? { cwd: commandSpec.cwd } : {}),
        ...(commandSpec.env !== undefined ? { env: commandSpec.env } : {}),
    };
}
function withoutCallerMuxOptions(connectionArgv) {
    const sanitized = [];
    for (let index = 0; index < connectionArgv.length; index += 1) {
        const argument = connectionArgv[index];
        const value = connectionArgv[index + 1];
        if (argument === "-o" && value) {
            const separator = value.indexOf("=");
            const key = (separator < 0 ? value : value.slice(0, separator)).toLowerCase();
            if (MUX_CONTROL_OPTIONS.has(key)) {
                index += 1;
                continue;
            }
        }
        sanitized.push(argument);
    }
    return sanitized;
}
function commandSucceeded(result) {
    return result.exitCode === 0 && !result.timedOut;
}
function tmuxLogPath(sessionName) {
    return `/tmp/${sessionName}.log`;
}
function tmuxExitPath(sessionName) {
    return `/tmp/${sessionName}.exit`;
}
function tmuxStartCommand(tmuxPath, sessionName, command, workdir) {
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
function tmuxPollCommand(sessionName, logOffset) {
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
function parseTmuxPollResult(result, logOffset) {
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
async function bootstrapTmux(commandSpec, target, runner, installEnabled, timeoutMs) {
    const deadlineAt = Date.now() + timeoutMs;
    let timeoutContext = {
        target,
        mutated: false,
        verifyCommand: sshGuidanceCommand(commandSpec, target, "command -v tmux && tmux -V"),
        stage: "probing tmux",
    };
    const run = async (remoteCommand) => {
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0)
            throw new TmuxBootstrapTimeoutError();
        const result = await runner.runOnce(withRemoteCommand(commandSpec, remoteCommand), undefined, remainingMs);
        if (result.timedOut)
            throw new TmuxBootstrapTimeoutError();
        return result;
    };
    try {
        return await bootstrapTmuxWithinDeadline(run, commandSpec, target, installEnabled, timeoutContext, (context) => {
            timeoutContext = context;
        });
    }
    catch (error) {
        if (!(error instanceof TmuxBootstrapTimeoutError))
            throw error;
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
class TmuxBootstrapTimeoutError extends Error {
}
async function bootstrapTmuxWithinDeadline(run, commandSpec, target, installEnabled, initialTimeoutContext, setTimeoutContext) {
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
function resolveBootstrapTimeoutMs(timeoutMs) {
    if (timeoutMs === undefined)
        return DEFAULT_TMUX_BOOTSTRAP_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error("tmux bootstrap timeoutMs must be a positive finite number");
    }
    return Math.floor(timeoutMs);
}
function parseTmuxCapability(result) {
    if (result.exitCode !== 0)
        return undefined;
    let tmuxPath;
    let tmuxVersion;
    for (const line of result.stdout.split("\n")) {
        if (line.startsWith(TMUX_PATH_PREFIX))
            tmuxPath = line.slice(TMUX_PATH_PREFIX.length);
        if (line.startsWith(TMUX_VERSION_PREFIX))
            tmuxVersion = line.slice(TMUX_VERSION_PREFIX.length);
    }
    if (!tmuxPath || !tmuxVersion)
        return undefined;
    if (!tmuxPath.startsWith("/") || /\s/.test(tmuxPath))
        return undefined;
    if (!/^tmux\b/i.test(tmuxVersion))
        return undefined;
    return { tmuxPath, tmuxVersion };
}
function parseDetection(result) {
    if (result.exitCode !== 0)
        return undefined;
    const values = Object.fromEntries(result.stdout.trim().split("\n").map((line) => {
        const separator = line.indexOf("=");
        return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
    }));
    if (!values.user || !/^(root|sudo|direct|needs_user)$/.test(values.privilege ?? ""))
        return undefined;
    return {
        user: values.user,
        packageManager: values.pm ?? "",
        privilege: values.privilege,
    };
}
function isTmuxPackageManager(value) {
    return TMUX_PACKAGE_MANAGERS.some((candidate) => candidate === value);
}
function formatPackageManagerList() {
    return `${TMUX_PACKAGE_MANAGERS.slice(0, -1).join(", ")}, or ${TMUX_PACKAGE_MANAGERS.at(-1)}`;
}
function resultDetail(result) {
    return (result.stderr.trim() || result.stdout.trim()).replaceAll(/\s+/g, " ").slice(0, 500);
}
function withNonInteractiveSudo(command) {
    return command.split(" && ").map((part) => `sudo -n ${part}`).join(" && ");
}
function withInteractiveSudo(command) {
    return command.split(" && ").map((part) => `sudo ${part}`).join(" && ");
}
function sshGuidanceCommand(spec, target, remoteCommand, tty = false) {
    const argv = spec.argv ?? [];
    const separator = argv.lastIndexOf("--");
    const connectionArgs = [];
    for (let index = 1; index >= 0 && index < separator; index += 1) {
        const option = argv[index];
        if (option === "-T")
            continue;
        const value = argv[index + 1];
        if ((option === "-p" || option === "-i" || option === "-J") && value) {
            connectionArgs.push(option, shellQuote(value));
            index += 1;
            continue;
        }
        if (option === "-o" && value) {
            index += 1;
            const key = value.slice(0, value.indexOf("=")).toLowerCase();
            if (REQUIRED_SSH_OPTIONS.has(key))
                continue;
            connectionArgs.push(option, shellQuote(value));
        }
    }
    const renderedArgs = connectionArgs.length > 0 ? ` ${connectionArgs.join(" ")}` : "";
    return `ssh${tty ? " -t" : ""}${renderedArgs} ${shellQuote(target)} ${shellQuote(remoteCommand)}`;
}
function shellQuote(value) {
    return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}
function withRemoteCommand(spec, remoteCommand) {
    return {
        ...spec,
        command: remoteCommand,
        argv: [...(spec.argv?.slice(0, -1) ?? []), remoteCommand],
    };
}
function requireValue(value, message) {
    if (!value || value.trim().length === 0)
        throw new Error(message);
    return value;
}
function requireToken(value, message) {
    const resolved = requireValue(value, message).trim();
    if (/\s/.test(resolved))
        throw new Error(message);
    return resolved;
}
function optionalValue(value, message) {
    if (value === undefined)
        return undefined;
    return requireValue(value, message);
}
function optionalToken(value, message) {
    if (value === undefined)
        return undefined;
    return requireToken(value, message);
}
