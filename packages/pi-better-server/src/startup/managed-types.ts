import type { Readiness } from "./ensure.ts";

export type RuntimePlatform = "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64";

/** Identity excludes timestamps and the generated manifest itself. */
export interface ServerBuild {
  format: 1;
  contentId: string;
  sourceDigest: string;
  piSdkVersion: string;
  nodeVersion: string;
  platform: RuntimePlatform;
  dependencyLockDigest: string;
  protocolVersion: number;
  serverVersion: string;
}

export interface ServerArtifact {
  build: ServerBuild;
  bytes: Buffer;
  sha256: string;
}

/** A verified runtime is not permission to start another registry writer. */
export interface StagedRuntime {
  format: 1;
  build: ServerBuild;
  root: string;
  node: string;
  entrypoint: string;
  manifestPath: string;
  installRoot: string;
}

export interface RemoteCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type RunRemote = (command: string, input?: Buffer, timeoutMs?: number) => Promise<RemoteCommandResult>;

export interface UpgradeRequest {
  operationId: string;
  runtime: StagedRuntime;
  agentDir: string;
  serverDir: string;
}

export type ActivationResult =
  | { status: "ready"; readiness: Readiness; operationId?: string }
  | { status: "deferred"; reason: string; operationId: string }
  | { status: "recovery-required"; reason: string; operationId: string };

/** commitStop is synchronous and must leave admission fenced after the callback returns. */
export interface IdleSessionsLease {
  assertIdle(): void;
  refreshIdle(): Promise<void>;
  commitStop(): void;
}