/**
 * Wire protocol: strict LF-delimited JSON lines over the daemon's Unix socket.
 *
 * Every client line is a Pi RPC command (the payloads come straight from Pi's
 * own `RpcCommand` type) plus a `sessionId` that addresses one hosted session,
 * or one of the four daemon-level commands below. Responses reuse Pi's
 * `{ type: "response", command, success, ... }` shape and echo `id` and
 * `sessionId`. Session events are pushed as `{ type: "event", sessionId, event }`.
 */
import type { RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";

/** A Pi RPC command addressed to one hosted session. */
export type SessionCommand = RpcCommand extends infer C ? (C extends RpcCommand ? C & { sessionId: string } : never) : never;

export type SessionStatus = "running" | "closed";

export interface SessionSummary {
  sessionId: string;
  cwd: string;
  sessionFile: string;
  status: SessionStatus;
  name?: string;
  model?: string;
  /** Git branch checked out in `cwd`, when it is a git work tree. */
  branch?: string;
  /** True while a turn is in flight in the live session. */
  isStreaming: boolean;
  /** True when the session is hosted in memory right now. */
  live: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Bumped on any wire change an older client cannot ignore. A `hello` with a different version is rejected. */
export const PROTOCOL_VERSION = 1;

export interface HelloCommand {
  id?: string;
  type: "hello";
  protocolVersion: number;
  /** Pi version the client runs; compared by major.minor when present. */
  piVersion?: string;
  /** Extension and harness versions the client runs, by package name. Reported, not enforced. */
  extensionVersions?: Record<string, string>;
}

export interface HelloData {
  protocolVersion: number;
  piVersion: string;
  extensionVersions: Record<string, string>;
}

export type DaemonCommand =
  | { id?: string; type: "list_sessions" }
  | {
      id?: string;
      type: "create_session";
      cwd?: string;
      name?: string;
      model?: { provider: string; modelId: string };
      thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    }
  | { id?: string; type: "open_session"; sessionId: string }
  | { id?: string; type: "close_session"; sessionId: string };

export type ClientCommand = HelloCommand | DaemonCommand | SessionCommand;

export type DaemonResponse =
  | { id?: string; type: "response"; command: "hello"; success: true; data: HelloData }
  | { id?: string; type: "response"; command: "list_sessions"; success: true; data: { sessions: SessionSummary[] } }
  | { id?: string; type: "response"; command: "create_session"; success: true; sessionId: string; data: SessionSummary }
  | { id?: string; type: "response"; command: "open_session"; success: true; sessionId: string; data: SessionSummary }
  | { id?: string; type: "response"; command: "close_session"; success: true; sessionId: string };

export type SessionResponse = RpcResponse & { sessionId?: string };

export type ServerMessage =
  | DaemonResponse
  | SessionResponse
  | { type: "event"; sessionId: string; event: unknown };

export const DAEMON_COMMANDS: ReadonlySet<string> = new Set(["list_sessions", "create_session", "open_session", "close_session"]);

/** Pi RPC commands that rebind the whole session; the daemon pins one session file per session id. */
export const UNSUPPORTED_SESSION_COMMANDS: ReadonlySet<string> = new Set(["new_session", "switch_session", "fork", "clone"]);

/** Largest accepted line; guards the daemon against an unterminated client stream. */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

export function encodeLine(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Incremental LF-only framing. Unlike readline it does not split on U+2028/U+2029
 * or a bare CR, which can legally appear inside JSON strings.
 */
export class LineDecoder {
  private buffer = "";
  private readonly onLine: (line: string) => void;
  private readonly onOverflow: () => void;

  constructor(onLine: (line: string) => void, onOverflow: () => void) {
    this.onLine = onLine;
    this.onOverflow = onOverflow;
  }

  push(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) this.onLine(line);
      index = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.buffer = "";
      this.onOverflow();
    }
  }
}

export function failure(id: string | undefined, command: string, error: string, sessionId?: string): ServerMessage {
  return {
    ...(id !== undefined ? { id } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    type: "response",
    command,
    success: false,
    error,
  } as ServerMessage;
}
