/**
 * The local Codex installation: which `codex` binary, which CODEX_HOME, its pinned
 * version, and its app-server daemon (`codex app-server daemon start`). The daemon is
 * reached only through its unix control socket.
 */
import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient } from "./app-server.ts";
import { findRollout } from "./rollout.ts";

export interface CodexRuntimeOptions {
  /** The `codex` executable. Default: `$PI_CODEX_BIN` or `codex` from PATH. */
  bin?: string;
  /** CODEX_HOME. Default: `$CODEX_HOME` or `~/.codex`. */
  home?: string;
  /** Refuse to work unless `codex --version` is exactly this. Default: `$PI_CODEX_VERSION`. */
  pinnedVersion?: string;
}

export interface DaemonStatus {
  status: string;
  socketPath: string;
  cliVersion: string;
  appServerVersion?: string;
}

export class CodexRuntime {
  readonly bin: string;
  readonly home: string;
  readonly pinnedVersion: string | undefined;
  private cachedVersion: string | undefined;
  private connection: Promise<CodexAppServerClient> | undefined;

  constructor(options: CodexRuntimeOptions = {}) {
    this.bin = options.bin ?? process.env.PI_CODEX_BIN ?? "codex";
    this.home = options.home ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    this.pinnedVersion = options.pinnedVersion ?? process.env.PI_CODEX_VERSION;
  }

  get env(): NodeJS.ProcessEnv {
    return { ...process.env, CODEX_HOME: this.home };
  }

  get sessionsDir(): string {
    return join(this.home, "sessions");
  }

  get archivedDir(): string {
    return join(this.home, "archived_sessions");
  }

  /** `codex --version` ("codex-cli 0.159.2" -> "0.159.2"). Throws if the binary is missing. */
  version(): string {
    if (this.cachedVersion) return this.cachedVersion;
    let output: string;
    try {
      output = execFileSync(this.bin, ["--version"], { encoding: "utf8", env: this.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      throw new Error(`Cannot run \`${this.bin} --version\`: ${error instanceof Error ? error.message : String(error)}. Install Codex CLI or set PI_CODEX_BIN.`);
    }
    const match = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(output);
    if (!match) throw new Error(`Unrecognized \`${this.bin} --version\` output: ${output.trim()}`);
    this.cachedVersion = match[1]!;
    return this.cachedVersion;
  }

  /** Throws unless the installed Codex CLI is the pinned version (when one is pinned). */
  assertPinned(): void {
    const version = this.version();
    if (this.pinnedVersion && version !== this.pinnedVersion) {
      throw new Error(`Codex CLI version mismatch: this host runs codex-cli ${version} but ${this.pinnedVersion} is pinned (PI_CODEX_VERSION).`);
    }
  }

  rolloutPath(threadId: string): string | undefined {
    return findRollout(this.sessionsDir, threadId);
  }

  archivedRolloutPath(threadId: string): string | undefined {
    return findRollout(this.archivedDir, threadId);
  }

  /** `codex app-server daemon start` (idempotent): the daemon the Codex TUI attaches to. */
  ensureDaemon(): Promise<DaemonStatus> {
    return new Promise((resolve, reject) => {
      execFile(this.bin, ["app-server", "daemon", "start"], { env: this.env, timeout: 120_000, encoding: "utf8" }, (error, stdout, stderr) => {
        const lastLine = stdout.trim().split("\n").filter((line) => line.startsWith("{")).at(-1);
        if (error || !lastLine) return reject(new Error(`codex app-server daemon start failed: ${stderr.trim() || error?.message || stdout.trim()}`));
        try {
          const parsed = JSON.parse(lastLine) as DaemonStatus;
          if (typeof parsed.socketPath !== "string") throw new Error("no socketPath in daemon status");
          resolve(parsed);
        } catch (parseError) {
          reject(new Error(`codex app-server daemon start gave unreadable output: ${lastLine} (${parseError instanceof Error ? parseError.message : String(parseError)})`));
        }
      });
    });
  }

  /** A connected, initialized app-server client; reconnects after the previous one closed. */
  async client(): Promise<CodexAppServerClient> {
    if (this.connection) {
      const existing = await this.connection.catch(() => undefined);
      if (existing && !existing.isClosed) return existing;
    }
    const attempt = this.ensureDaemon().then((status) => CodexAppServerClient.connect(status.socketPath));
    this.connection = attempt;
    try {
      return await attempt;
    } catch (error) {
      this.connection = undefined;
      throw error;
    }
  }

  async daemonStatus(): Promise<DaemonStatus> {
    return this.ensureDaemon();
  }

  close(): void {
    const connection = this.connection;
    this.connection = undefined;
    void connection?.then((client) => client.close()).catch(() => undefined);
  }
}
