export { startDaemon, type Daemon, type DaemonOptions } from "./server.ts";
export { SessionRegistry, type CreateSessionRequest, type SessionRegistryOptions } from "./registry.ts";
export { HostedSession } from "./hosted-session.ts";
export { defaultServerDir, ensureServerDir, indexPathFor, socketPathFor } from "./paths.ts";
export {
  encodeLine,
  LineDecoder,
  type ClientCommand,
  type DaemonCommand,
  type DaemonResponse,
  type ServerMessage,
  type SessionCommand,
  type SessionResponse,
  type SessionStatus,
  type SessionSummary,
} from "./protocol.ts";
