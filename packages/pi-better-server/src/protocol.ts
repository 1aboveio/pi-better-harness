/**
 * Wire protocol: strict LF-delimited JSON lines over the daemon's Unix socket.
 *
 * Every client line is a Pi RPC command (the payloads come straight from Pi's
 * own `RpcCommand` type) plus a `sessionId` that addresses one hosted session,
 * or one of the daemon-level and control commands below. Responses reuse Pi's
 * `{ type: "response", command, success, ... }` shape and echo `id` and
 * `sessionId`. Session events are pushed as `{ type: "event", sessionId, seq, event }`
 * only to connections that `subscribe`d (and to the creator of a session from
 * `create_session`); `open_session` does not stream.
 */
import type { RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";
import type { CompanionInfo } from "./companion.ts";
import type { DialogAnswer, PendingDialog } from "./ui-bridge.ts";

export type { DialogAnswer, PendingDialog };

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
  /** Codex hosts: the error the thread's last turn ended with, while it has not run a good turn since. */
  lastError?: string;
  /** Present when this daemon does not currently own the session: fenced for a move, or moved away. */
  ownership?: "fenced" | "moved";
  /** True when the session is hosted in memory right now. */
  live: boolean;
  /** Seq of the newest event the session has published (0 before the first). */
  lastSeq: number;
  /** True while some connection holds the controller lease. */
  hasController: boolean;
  /** Dialogs an extension is blocked on. Non-empty means the turn waits for a person. */
  needsInput: PendingDialog[];
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
  capabilities?: string[];
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
  | { id?: string; type: "close_session"; sessionId: string }
  | { id?: string; type: "start_companion"; sessionId: string }
  | { id?: string; type: "stop_companion"; sessionId: string }
  | MoveCommand;

/**
 * Daemon-to-daemon session move. The CLI drives both ends: fence + export on the
 * source, begin/write/commit on the target, then retire (or unfence) on the source.
 */
export type MoveCommand =
  | { id?: string; type: "move_fence"; sessionId: string; moveId: string; waitMs?: number }
  | { id?: string; type: "move_export"; sessionId: string; moveId: string }
  | { id?: string; type: "move_read"; moveId: string; offset: number; length: number }
  | { id?: string; type: "move_retire"; sessionId: string; moveId: string; movedTo: string }
  | { id?: string; type: "move_unfence"; sessionId: string; moveId?: string }
  | { id?: string; type: "move_begin"; moveId: string; sessionId: string; size: number; sha256: string; cwd?: string; rebindProvider?: string }
  | { id?: string; type: "move_write"; moveId: string; offset: number; data: string }
  | { id?: string; type: "move_commit"; moveId: string }
  | { id?: string; type: "move_abort"; moveId: string; sessionId: string }
  /** Checks to run on the receiving daemon before anything is fenced; with `sessionId`, also describes that session for a pull. */
  | { id?: string; type: "move_preflight"; sessionId?: string; model?: string; modelProvider?: string; rebindProvider?: string; repoRemote?: string; requireGh?: boolean; bytes?: number; dir?: string };

/**
 * Event delivery and control, all addressed to one session:
 * - `subscribe` replays retained events after `sinceSeq` (omit it for live only), then streams live.
 *   Re-subscribing on the same connection replaces the earlier subscription.
 * - `acquire_control` / `release_control` take and give back the single controller lease; it also ends on disconnect.
 * - `extension_ui_response` answers a pending dialog (`requestId`); only the lease holder may.
 */
export type ControlCommand =
  | { id?: string; type: "subscribe"; sessionId: string; sinceSeq?: number }
  | { id?: string; type: "acquire_control"; sessionId: string; /** Set by the attach companion so the daemon can tell its lease from a person's. */ companion?: boolean }
  | { id?: string; type: "release_control"; sessionId: string }
  | ({ id?: string; type: "extension_ui_response"; sessionId: string; requestId: string } & DialogAnswer);

export type ClientCommand = HelloCommand | DaemonCommand | ControlCommand | SessionCommand;

export type DaemonResponse =
  | { id?: string; type: "response"; command: "hello"; success: true; data: HelloData }
  | { id?: string; type: "response"; command: "list_sessions"; success: true; data: { sessions: SessionSummary[] } }
  | { id?: string; type: "response"; command: "create_session"; success: true; sessionId: string; data: SessionSummary }
  | { id?: string; type: "response"; command: "open_session"; success: true; sessionId: string; data: SessionSummary }
  | { id?: string; type: "response"; command: "close_session"; success: true; sessionId: string }
  | { id?: string; type: "response"; command: "start_companion"; success: true; sessionId: string; data: CompanionInfo }
  | { id?: string; type: "response"; command: "stop_companion"; success: true; sessionId: string; data: { stopped: boolean } };

export type SessionResponse = RpcResponse & { sessionId?: string };

export type ServerMessage =
  | DaemonResponse
  | SessionResponse
  | { type: "event"; sessionId: string; seq: number; generation?: string; event: unknown };

export const MOVE_COMMANDS: ReadonlySet<string> = new Set([
  "move_fence",
  "move_export",
  "move_read",
  "move_retire",
  "move_unfence",
  "move_begin",
  "move_write",
  "move_commit",
  "move_abort",
  "move_preflight",
]);

export const DAEMON_COMMANDS: ReadonlySet<string> = new Set(["list_sessions", "create_session", "open_session", "close_session", "start_companion", "stop_companion", ...MOVE_COMMANDS]);

export const CONTROL_COMMANDS: ReadonlySet<string> = new Set(["subscribe", "acquire_control", "release_control", "extension_ui_response"]);

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
