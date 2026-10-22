import type { ParseArgsOptionsConfig } from "node:util";
import { DaemonClient } from "../client.ts";
import { resolveTarget, type Target, type TargetOptions } from "./target.ts";

/** Options every `pi-remote` subcommand accepts. */
export const GLOBAL_OPTIONS = {
  agent: { type: "string" },
  host: { type: "string" },
  socket: { type: "string" },
  "remote-dir": { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

export interface ParsedArgs {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
}

/** What a subcommand gets: a lazily connected daemon client and the output streams. */
export interface RemoteContext {
  readonly host: string | undefined;
  readonly json: boolean;
  /** Aborted on SIGINT/SIGTERM; long-running commands (tail) stop when it fires. */
  readonly signal: AbortSignal;
  connect(): Promise<DaemonClient>;
  /** Forward another unix socket that lives next to the daemon (see Target.forwardSocket). */
  forwardSocket(remoteSocketPath: string): Promise<{ socketPath: string; close(): Promise<void> }>;
  stdout(text: string): void;
  stderr(text: string): void;
  close(): Promise<void>;
}

/** A `pi-remote` subcommand lives in its own module and exports this shape as `command`. */
export interface Subcommand {
  usage: string;
  options: ParseArgsOptionsConfig;
  run(args: ParsedArgs, context: RemoteContext): Promise<number>;
}

export interface ContextOptions extends TargetOptions {
  json?: boolean;
  signal?: AbortSignal;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export function createContext(options: ContextOptions): RemoteContext {
  let target: Promise<Target> | undefined;
  let client: Promise<DaemonClient> | undefined;
  return {
    host: options.host,
    json: options.json ?? false,
    signal: options.signal ?? new AbortController().signal,
    connect() {
      target ??= resolveTarget(options);
      client ??= target.then((t) => DaemonClient.connect(t.socketPath, { signal: options.signal }));
      return client;
    },
    async forwardSocket(remoteSocketPath) {
      target ??= resolveTarget(options);
      return (await target).forwardSocket(remoteSocketPath);
    },
    stdout: options.stdout ?? ((text) => void process.stdout.write(text)),
    stderr: options.stderr ?? ((text) => void process.stderr.write(text)),
    async close() {
      const opened = client;
      client = undefined;
      (await opened?.catch(() => undefined))?.close();
      const t = await target?.catch(() => undefined);
      target = undefined;
      await t?.close();
    },
  };
}
