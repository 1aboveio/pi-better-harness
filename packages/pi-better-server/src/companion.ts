import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface CompanionInfo {
  /** Name of the tmux session on the host that runs the companion terminal. */
  tmuxSession: string;
  /** argv (run on the host) that attaches a terminal to it; `ssh -t <host> <argv>` is `pi-remote attach --host`. */
  attach: string[];
  /** False when a companion for this session was already running and is reused. */
  created: boolean;
}

export interface CompanionManagerOptions {
  socketPath: string;
  /** Name of a dedicated tmux server (`tmux -L`). Default: the user's own tmux server. */
  tmuxSocket?: string;
  /** Replace the companion's command line (tests); default runs `pi-remote console` with this Node. */
  command?: (sessionId: string, socketPath: string) => string[];
  /** True once the companion itself (not some other client) holds the session's controller lease. */
  isReady: (sessionId: string) => boolean;
  readyTimeoutMs?: number;
}

const REMOTE_CLI = fileURLToPath(new URL("./remote-cli.ts", import.meta.url));

function run(file: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, (error, _stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 127) : 0;
      resolve({ code, stderr: error && code === 127 && !stderr ? error.message : stderr });
    });
  });
}

/**
 * Runs one full-screen terminal per session inside a named tmux session on the
 * daemon's host. The terminal is an ordinary daemon client (`pi-remote console`)
 * that holds the controller lease, so attaching never makes a second writer:
 * any number of `tmux attach` clients share that one pane.
 */
export class CompanionManager {
  private readonly options: CompanionManagerOptions;
  private readonly inFlight = new Map<string, Promise<CompanionInfo>>();

  constructor(options: CompanionManagerOptions) {
    this.options = options;
  }

  static sessionName(sessionId: string): string {
    return `pi-${sessionId.slice(0, 12)}`;
  }

  private tmux(...args: string[]): string[] {
    return [...(this.options.tmuxSocket ? ["-L", this.options.tmuxSocket] : []), ...args];
  }

  private async exists(name: string): Promise<boolean> {
    return (await run("tmux", this.tmux("has-session", "-t", `=${name}`))).code === 0;
  }

  /** Start the companion for a session, or return the one already running. Calls for one session are serialized. */
  start(sessionId: string, cwd: string): Promise<CompanionInfo> {
    const running = this.inFlight.get(sessionId);
    if (running) return running;
    const started = this.startOnce(sessionId, cwd).finally(() => this.inFlight.delete(sessionId));
    this.inFlight.set(sessionId, started);
    return started;
  }

  private async startOnce(sessionId: string, cwd: string): Promise<CompanionInfo> {
    const name = CompanionManager.sessionName(sessionId);
    const attach = ["tmux", ...this.tmux("attach", "-t", `=${name}`)];
    if (await this.exists(name)) return { tmuxSession: name, attach, created: false };

    const command = this.options.command?.(sessionId, this.options.socketPath) ?? [process.execPath, REMOTE_CLI, "console", sessionId, "--companion", "--socket", this.options.socketPath];
    const made = await run("tmux", this.tmux("new-session", "-d", "-s", name, "-x", "200", "-y", "50", "-c", cwd, "--", ...command));
    if (made.code !== 0) {
      throw new Error(made.code === 127 ? "tmux is not installed on this host; attach needs it" : `tmux could not start the companion: ${made.stderr.trim() || `exit ${made.code}`}`);
    }
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? 15_000);
    while (!this.options.isReady(sessionId)) {
      if (!(await this.exists(name))) throw new Error("The companion terminal exited before it took control; another client may hold the session's controller lease");
      if (Date.now() > deadline) {
        await this.stop(sessionId);
        throw new Error("The companion terminal did not take control in time");
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return { tmuxSession: name, attach, created: true };
  }

  async stop(sessionId: string): Promise<boolean> {
    const name = CompanionManager.sessionName(sessionId);
    return (await run("tmux", this.tmux("kill-session", "-t", `=${name}`))).code === 0;
  }
}
