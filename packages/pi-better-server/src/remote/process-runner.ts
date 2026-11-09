import { spawn } from "node:child_process";
import type { CommandResult, CommandSpec, RemoteRunner } from "../shared-ssh-core/index.ts";

/** Runs the short `ssh` control commands ssh-core builds. Detached processes are not needed here. */
export function createProcessRunner(options: { signal?: AbortSignal } = {}): RemoteRunner {
  const { signal: connectSignal } = options;
  const abortError = () => new DOMException("The operation was aborted", "AbortError");
  return {
    spawn() {
      throw new Error("pi-remote does not spawn detached remote processes");
    },
    runOnce(spec: CommandSpec, _maxBufferBytes?: number, timeoutMs?: number): Promise<CommandResult> {
      if (connectSignal?.aborted) return Promise.reject(abortError());
      const argv = spec.argv;
      if (spec.shell !== false || !argv?.[0]) return Promise.reject(new Error("pi-remote runner requires a non-empty shell:false argv"));
      const startedAt = Date.now();
      return new Promise((resolve, reject) => {
        const child = spawn(argv[0]!, argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env }, shell: false, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, timeoutMs);
        const onAbort = () => child.kill("SIGTERM");
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          connectSignal?.removeEventListener("abort", onAbort);
        };
        connectSignal?.addEventListener("abort", onAbort, { once: true });
        if (connectSignal?.aborted) onAbort();
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.on("error", (error) => {
          cleanup();
          reject(connectSignal?.aborted ? abortError() : error);
        });
        // "close", not "exit": a backgrounded ssh master (-f) inherits the pipes until it detaches.
        child.on("close", (exitCode, signal) => {
          cleanup();
          if (connectSignal?.aborted) {
            reject(abortError());
            return;
          }
          resolve({ exitCode, signal, stdout, stderr, startedAt, endedAt: Date.now(), ...(timedOut ? { timedOut: true } : {}) });
        });
      });
    },
  };
}
