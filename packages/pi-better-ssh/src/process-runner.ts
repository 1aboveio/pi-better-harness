import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import type {
  CommandOutputCapture,
  CommandResult,
  CommandSpec,
  RemoteRunner,
  SpawnedProcess,
} from "./shared-ssh-core/index.js";

const DEFAULT_CAPTURE_BYTES = DEFAULT_MAX_BYTES * 2;

export function createProcessRemoteRunner(): RemoteRunner {
  return {
    spawn(): SpawnedProcess {
      throw new Error("pi-better-ssh does not support detached remote processes; use bg_task_spawn with structured ssh");
    },
    runOnce: runProcessOnce,
  };
}

function runProcessOnce(
  spec: CommandSpec,
  maxBufferBytes = DEFAULT_CAPTURE_BYTES,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const argv = validateCommandSpec(spec);
  const startedAt = Date.now();
  const child = nodeSpawn(argv[0]!, argv.slice(1), {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const retainedBytes = Math.max(DEFAULT_CAPTURE_BYTES, Math.floor(maxBufferBytes));
  const combined = new CommandOutputCaptureBuffer(retainedBytes);
  const stdout = new TailBuffer(retainedBytes);
  const stderr = new TailBuffer(retainedBytes);
  let timedOut = false;
  let settled = false;

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout.append(chunk);
    combined.append(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr.append(chunk);
    combined.append(chunk);
  });

  return new Promise((resolve, reject) => {
    const stopSlave = (): void => {
      if (!settled) child.kill("SIGTERM");
    };
    const onAbort = (): void => stopSlave();
    const timeout = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      stopSlave();
    }, Math.max(1, timeoutMs));
    timeout?.unref();
    if (signal?.aborted) stopSlave();
    else signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (): void => {
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (error) => {
      finish();
      combined.discard();
      reject(error);
    });
    child.on("close", (exitCode, childSignal) => {
      finish();
      resolve({
        exitCode,
        signal: childSignal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        startedAt,
        endedAt: Date.now(),
        ...(timedOut ? { timedOut: true } : {}),
        outputCapture: combined.finish(),
      });
    });
  });
}

function validateCommandSpec(spec: CommandSpec): string[] {
  if (spec.shell !== false || !spec.argv?.[0]) {
    throw new Error("pi-better-ssh runner requires a non-empty shell:false argv");
  }
  return spec.argv;
}

class TailBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer): void {
    this.chunks.push(Buffer.from(chunk));
    this.bytes += chunk.length;
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift()!;
      this.bytes -= removed.length;
    }
    if (this.bytes > this.maxBytes && this.chunks.length === 1) {
      this.chunks[0] = this.chunks[0]!.subarray(this.bytes - this.maxBytes);
      this.bytes = this.chunks[0]!.length;
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

class CommandOutputCaptureBuffer extends TailBuffer {
  private readonly directory = mkdtempSync(join(tmpdir(), "pi-remote-bash-"));
  private readonly path = join(this.directory, "output.log");
  private readonly fd = openSync(this.path, "w", 0o600);
  private totalBytes = 0;
  private newlineCount = 0;
  private closed = false;

  override append(chunk: Buffer): void {
    super.append(chunk);
    writeSync(this.fd, chunk);
    this.totalBytes += chunk.length;
    for (const byte of chunk) {
      if (byte === 0x0a) this.newlineCount += 1;
    }
  }

  finish(): CommandOutputCapture {
    this.close();
    const totalLines = this.newlineCount + 1;
    const truncated = this.totalBytes > DEFAULT_MAX_BYTES || totalLines > DEFAULT_MAX_LINES;
    if (!truncated) rmSync(this.directory, { recursive: true, force: true });
    return {
      output: this.text(),
      totalBytes: this.totalBytes,
      totalLines,
      ...(truncated ? { fullOutputPath: this.path } : {}),
    };
  }

  discard(): void {
    this.close();
    rmSync(this.directory, { recursive: true, force: true });
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }
}
