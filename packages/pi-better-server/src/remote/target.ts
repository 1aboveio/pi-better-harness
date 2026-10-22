import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { defaultServerDir, socketPathFor } from "../paths.ts";
import { createSshMuxController, resolveSshCommand, type CommandSpec, type SshMuxController } from "../shared-ssh-core/index.ts";
import { createProcessRunner } from "./process-runner.ts";
import { ensureArgs, parseReadiness, remoteActivationScript, remoteEnsureScript } from "../startup/commands.ts";
import { absolutePath, discoverLocalRuntime, INSTALL_GUIDANCE, parseRuntime, probeRemoteRuntime, remoteRuntimeScript, shellQuote } from "../startup/runtime.ts";
import { createServerArtifact } from "../startup/artifact.ts";
import { stageRuntime } from "../startup/install.ts";
import type { ActivationResult, RemoteCommandResult, RunRemote, ServerBuild, StagedRuntime } from "../startup/managed-types.ts";

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
  /** Native SDK 1.2 runtime installation; older CLI SDKs retain registered-launcher startup by default. */
  managedRuntime?: boolean;
  /** Codex must retain its own startup path; never auto-start a Pi daemon for it. */
  agent?: "pi" | "codex";
  onProgress?: (stage: "ssh" | "directory" | "server" | "forward") => void;
  /** Managed install stages, then activating/ready/deferred; detail carries the deferral reason. */
  onUpgradeProgress?: (stage: string, detail?: string) => void;
}

export interface Target {
  /** Unix socket on this machine that reaches the daemon. */
  socketPath: string;
  /** Selected daemon state directory; absent for an arbitrary explicit local socket. */
  serverDir?: string;
  /** Client-matched build, including when activation is queued behind the current daemon. */
  desiredBuild?: ServerBuild;
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

/** SSH stdin is a byte stream: archives must never be encoded into a shell command. */
function runRemoteCommand(spec: CommandSpec, input?: Buffer, timeoutMs = 30_000, signal?: AbortSignal): Promise<RemoteCommandResult> {
  const abortError = () => new DOMException("The operation was aborted", "AbortError");
  if (signal?.aborted) return Promise.reject(abortError());
  if (spec.shell !== false || !spec.argv?.[0]) return Promise.reject(new Error("Remote runtime requires shell:false argv"));
  const [executable, ...args] = spec.argv;
  return new Promise((resolve, reject) => {
    const child = spawn(executable!, args, { cwd: spec.cwd, env: { ...process.env, ...spec.env }, shell: false, stdio: "pipe" });
    let stdout = "", stderr = "", timedOut = false;
    let inputError: Error | undefined;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    const abort = () => { child.kill("SIGTERM"); };
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdin.on("error", error => { inputError = error; });
    child.on("error", error => { cleanup(); reject(signal?.aborted ? abortError() : error); });
    child.on("close", exitCode => {
      cleanup();
      if (signal?.aborted) reject(abortError());
      else if (inputError && exitCode === 0 && !timedOut) reject(inputError);
      else resolve({ exitCode, stdout, stderr, ...(timedOut ? { timedOut: true } : {}) });
    });
    child.stdin.end(input);
  });
}

function parseActivationResult(text: string): ActivationResult {
  const value = JSON.parse(text) as Partial<ActivationResult> | null;
  if (value?.status === "ready" && value.readiness) return value as ActivationResult;
  if ((value?.status === "deferred" || value?.status === "recovery-required")
    && typeof value.reason === "string" && value.reason && typeof value.operationId === "string" && value.operationId) return value as ActivationResult;
  throw new Error("Invalid runtime activation result");
}

/** Use the staged runtime for a read-only hello, including when the legacy launcher lacks this API. */
function remoteReadinessScript(runtime: StagedRuntime, serverDir: string): string {
  const script = `import { pathToFileURL } from "node:url";
const { probeActivationDaemon } = await import(pathToFileURL(process.argv[1]).href);
const probe = await probeActivationDaemon(process.argv[2]);
if (probe.kind === "ready") process.stdout.write(JSON.stringify(probe.readiness) + "\\n");
else { process.stderr.write(probe.kind === "ambiguous" ? probe.reason : "No existing daemon"); process.exitCode = 1; }`;
  return `exec ${shellQuote(runtime.node)} --input-type=module --eval ${shellQuote(script)} ${shellQuote(posix.join(posix.dirname(runtime.entrypoint), "startup/activation.ts"))} ${shellQuote(serverDir)}`;
}

function canonicalStateScript(runtime: StagedRuntime, serverDir: string): string {
  const script = `import { mkdirSync, realpathSync } from "node:fs";
mkdirSync(process.argv[1], { recursive: true, mode: 0o700 });
process.stdout.write(JSON.stringify(realpathSync(process.argv[1])));`;
  return `exec ${shellQuote(runtime.node)} --input-type=module --eval ${shellQuote(script)} ${shellQuote(serverDir)}`;
}

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
    let serverDir: string | undefined;
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
      serverDir = process.env.PI_SERVER_DIR || runtime.defaultServerDir;
      progress("server");
      const result = await runner.runOnce({
        shell: false, argv: [runtime.launcher, ...ensureArgs(serverDir)],
        env: { PI_CODING_AGENT_DIR: runtime.agentDir, PI_SERVER_DIR: serverDir },
      }, undefined, 30_000);
      checkAbort();
      if (result.exitCode !== 0) throw new Error(`Server ensure at ${serverDir}: ${result.stderr.trim() || "launcher failed"}. ${INSTALL_GUIDANCE}`);
      socketPath = parseReadiness(result.stdout, serverDir).socketPath;
    }
    if (socketPath === undefined) {
      serverDir = defaultServerDir();
      socketPath = socketPathFor(serverDir);
    }
    return {
      socketPath,
      ...(serverDir ? { serverDir } : {}),
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
  let desiredBuild: ServerBuild | undefined;
  const run: RunRemote = (command, input, timeoutMs) => {
    const spec = resolveSshCommand({ command, ssh: { host: options.host! } }).commandSpec;
    return runRemoteCommand(mux.withMux(spec), input, timeoutMs, options.signal);
  };
  if (ensureServer) {
    // An explicit launcher keeps the manual path, even on platforms managed installs do not support.
    let command = process.env.PI_SERVER_COMMAND;
    if (!command) {
      const override = await run('printf %s "${PI_SERVER_COMMAND:-}"', undefined, 15_000);
      checkAbort();
      if (override.exitCode !== 0 || override.timedOut) throw new Error(`Runtime discovery on ${options.host}: ${override.stderr.trim() || "explicit launcher probe failed"}`);
      command = override.stdout || undefined;
    }
    if (command || options.managedRuntime === false || (options.managedRuntime === undefined && PI_VERSION !== "1.2.0")) {
      const discovery = resolveSshCommand({ command: remoteRuntimeScript(command), ssh: { host: options.host } });
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
      const upgradeProgress = (stage: string, detail?: string) => {
        checkAbort();
        options.onUpgradeProgress?.(stage, detail);
        checkAbort();
      };
      const probe = await probeRemoteRuntime(run, { signal: options.signal });
      // The host's environment may have changed since the opt-out check. Never stage over an override.
      if (probe.explicitCommand) throw new Error(`Runtime discovery on ${options.host}: PI_SERVER_COMMAND changed during setup; reconnect to use the explicit launcher`);
      const agentDir = probe.runtime?.agentDir ?? posix.join(probe.home, ".pi/agent");
      remoteDir = absolutePath(remoteDir ?? probe.runtime?.defaultServerDir ?? posix.join(agentDir, "server"), "--remote-dir");
      progress("server");
      upgradeProgress("artifact");
      const artifact = createServerArtifact({ platform: probe.platform });
      desiredBuild = artifact.build;
      const staged = await stageRuntime({
        // stageRuntime checks cancellation before work, then uses this same port for scratch cleanup.
        // Its cancel marker and final cleanup must still reach the host after setup is aborted.
        run: (command, input, timeoutMs) => options.signal?.aborted
          ? runRemoteCommand(mux.withMux(resolveSshCommand({ command, ssh: { host: options.host! } }).commandSpec), input, timeoutMs)
          : run(command, input, timeoutMs),
        artifact, signal: options.signal, onProgress: upgradeProgress,
      });
      upgradeProgress("activating");
      const canonical = await run(canonicalStateScript(staged, remoteDir));
      checkAbort();
      if (canonical.exitCode !== 0 || canonical.timedOut) throw new Error(`Runtime state directory on ${options.host}: ${canonical.stderr.trim() || "could not resolve the selected directory"}`);
      remoteDir = absolutePath(JSON.parse(canonical.stdout), "canonical server directory");
      // Activation resolves agentDir with realpath; only a new installation needs this directory created.
      const prepare = probe.runtime ? "" : `umask 077; mkdir -p ${shellQuote(agentDir)} || exit $?; `;
      const activated = await run(`${prepare}${remoteActivationScript(staged, agentDir, remoteDir, randomUUID())}`, undefined, 30_000);
      checkAbort();
      if (activated.exitCode !== 0 || activated.timedOut) throw new Error(`Runtime activation on ${options.host} at ${remoteDir}: ${activated.stderr.trim() || "activation command failed or timed out"}`);
      const outcome = parseActivationResult(activated.stdout);
      if (outcome.status === "recovery-required") throw new Error(`Runtime activation on ${options.host} at ${remoteDir} requires recovery: ${outcome.reason}`);
      if (outcome.status === "ready") {
        const readiness = parseReadiness(JSON.stringify(outcome.readiness), remoteDir);
        if (readiness.hello.build?.contentId !== desiredBuild.contentId) throw new Error(`Runtime activation on ${options.host}: ready daemon does not match the desired build`);
        remoteSocket = readiness.socketPath;
        upgradeProgress("ready");
      } else {
        upgradeProgress("deferred", outcome.reason);
        // Do not use ensure here: an absent socket is not permission to launch or reclaim a legacy owner.
        const existing = await run(remoteReadinessScript(staged, remoteDir), undefined, 15_000);
        checkAbort();
        try {
          if (existing.exitCode !== 0 || existing.timedOut) throw new Error(existing.stderr.trim() || "no ready daemon");
          remoteSocket = parseReadiness(existing.stdout, remoteDir).socketPath;
        } catch (error) {
          throw new Error(`Runtime activation deferred on ${options.host} at ${remoteDir}: ${outcome.reason}. Existing daemon readiness: ${String(error)}`);
        }
      }
    }
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
    serverDir: remoteDir,
    ...(desiredBuild ? { desiredBuild } : {}),
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
