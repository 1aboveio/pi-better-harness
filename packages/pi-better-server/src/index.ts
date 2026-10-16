export { startDaemon, type Daemon, type DaemonOptions } from "./server.ts";
export { SessionRegistry, type CreateSessionRequest, type SessionRegistryOptions } from "./registry.ts";
export { answerPending, type AnswerOptions, type AnswerResult } from "./remote/answer.ts";
export { EventLog, type EventLogOptions } from "./event-log.ts";
export { HostedSession } from "./hosted-session.ts";
export { defaultServerDir, ensureServerDir, indexPathFor, socketPathFor } from "./paths.ts";
export {
  encodeLine,
  LineDecoder,
  PROTOCOL_VERSION,
  type HelloCommand,
  type HelloData,
  type ClientCommand,
  type ControlCommand,
  type DialogAnswer,
  type PendingDialog,
  type DaemonCommand,
  type DaemonResponse,
  type ServerMessage,
  type SessionCommand,
  type SessionResponse,
  type SessionStatus,
  type SessionSummary,
} from "./protocol.ts";
export { checkHello, SERVER_EXTENSION_VERSIONS, serverHello } from "./handshake.ts";
export { DaemonClient, HandshakeError, type ConnectOptions } from "./client.ts";
