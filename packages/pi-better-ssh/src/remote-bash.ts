import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import type { TruncationResult } from "@earendil-works/pi-coding-agent";
import {
  createSshMuxController,
  resolveSshCommand,
  wrapRemoteBashCommand,
} from "./shared-ssh-core/index.js";
import type { RemoteRunner, SshConnectionParams } from "./shared-ssh-core/index.js";

const MAX_TIMEOUT_MS = 2_147_483_647;
const REMOTE_CAPTURE_BYTES = DEFAULT_MAX_BYTES * 2;

export interface RemoteBashParams {
  command: string;
  host?: string;
  workdir?: string;
  timeout?: number;
  env?: Record<string, string>;
  user?: string;
  port?: number;
  identity_file?: string;
  jump?: string;
  options?: Record<string, string>;
}

export interface RemoteBashDependencies {
  runner: RemoteRunner;
  sessionScope: string;
  controlPathRoot?: string;
}

export interface RemoteBashResult {
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  timedOut: boolean;
  truncated: boolean;
  target: string;
  workdir?: string;
  mux: {
    state: "up";
    reused: boolean;
  };
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

export async function executeRemoteBash(
  params: RemoteBashParams,
  dependencies: RemoteBashDependencies,
  signal?: AbortSignal,
): Promise<RemoteBashResult> {
  const ssh = resolveConnection(params);
  const timeoutMs = resolveTimeoutMs(params.timeout);
  const remoteCommand = wrapRemoteBashCommand({
    command: params.command,
    workdir: params.workdir,
    env: params.env,
  });
  const resolved = resolveSshCommand({ command: remoteCommand, ssh });
  const mux = createSshMuxController({
    ...resolved,
    runner: dependencies.runner,
    sessionScope: dependencies.sessionScope,
    ...(dependencies.controlPathRoot ? { controlPathRoot: dependencies.controlPathRoot } : {}),
  });
  const muxState = await mux.ensure();
  const commandResult = await dependencies.runner.runOnce(
    mux.withMux(resolved.commandSpec),
    REMOTE_CAPTURE_BYTES,
    timeoutMs,
    signal,
  );
  const combinedOutput = commandResult.outputCapture?.output ?? `${commandResult.stdout}${commandResult.stderr}`;
  const retainedTruncation = truncateTail(combinedOutput, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  const truncation = commandResult.outputCapture
    ? {
      ...retainedTruncation,
      totalBytes: commandResult.outputCapture.totalBytes,
      totalLines: commandResult.outputCapture.totalLines,
    }
    : retainedTruncation;
  const cancelled = commandResult.timedOut === true || signal?.aborted === true;
  const fullOutputPath = truncation.truncated
    ? commandResult.outputCapture?.fullOutputPath ?? persistFullOutput(`${commandResult.stdout}${commandResult.stderr}`)
    : undefined;

  return {
    output: truncation.content,
    exitCode: cancelled ? undefined : commandResult.exitCode ?? undefined,
    cancelled,
    timedOut: commandResult.timedOut === true,
    truncated: truncation.truncated,
    target: resolved.identity.target,
    ...(params.workdir !== undefined ? { workdir: params.workdir } : {}),
    mux: { state: "up", reused: muxState.reused },
    ...(truncation.truncated ? { truncation } : {}),
    ...(fullOutputPath ? { fullOutputPath } : {}),
  };
}

function resolveConnection(params: RemoteBashParams): SshConnectionParams {
  const rawHost = params.host?.trim();
  if (!rawHost) {
    throw new Error("remote_bash requires host (an SSH Host alias or user@host); no active SSH profile is available");
  }
  if (/\s/.test(rawHost)) {
    throw new Error("remote_bash host must not contain whitespace");
  }

  const separator = rawHost.lastIndexOf("@");
  const embeddedUser = separator > 0 ? rawHost.slice(0, separator) : undefined;
  const host = separator > 0 ? rawHost.slice(separator + 1) : rawHost;
  if (!host || (separator === 0)) {
    throw new Error("remote_bash host must be an SSH Host alias or user@host");
  }
  if (embeddedUser && params.user && embeddedUser !== params.user) {
    throw new Error(`remote_bash user ${JSON.stringify(params.user)} conflicts with host user ${JSON.stringify(embeddedUser)}`);
  }

  return {
    host,
    ...(params.user || embeddedUser ? { user: params.user ?? embeddedUser } : {}),
    ...(params.port !== undefined ? { port: params.port } : {}),
    ...(params.identity_file !== undefined ? { identity_file: params.identity_file } : {}),
    ...(params.jump !== undefined ? { jump: params.jump } : {}),
    ...(params.options !== undefined ? { options: params.options } : {}),
  };
}

function resolveTimeoutMs(timeoutSeconds: number | undefined): number | undefined {
  if (timeoutSeconds === undefined) return undefined;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("remote_bash timeout must be a positive finite number of seconds");
  }
  const timeoutMs = timeoutSeconds * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`remote_bash timeout must not exceed ${MAX_TIMEOUT_MS / 1000} seconds`);
  }
  return timeoutMs;
}

function persistFullOutput(output: string): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-remote-bash-"));
  const path = join(directory, "output.log");
  writeFileSync(path, output, "utf8");
  return path;
}
