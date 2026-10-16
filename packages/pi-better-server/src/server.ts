import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import type { RpcCommand } from "@earendil-works/pi-coding-agent";
import { HostedSession } from "./hosted-session.ts";
import { defaultServerDir, ensureServerDir, socketPathFor } from "./paths.ts";
import { DAEMON_COMMANDS, encodeLine, failure, LineDecoder, type ServerMessage } from "./protocol.ts";
import { SessionRegistry, type SessionRegistryOptions } from "./registry.ts";

export interface DaemonOptions {
  /** Defaults to `~/.pi/agent/server` (or `$PI_SERVER_DIR`). */
  serverDir?: string;
  sessionOptions?: SessionRegistryOptions["sessionOptions"];
  log?: (message: string) => void;
}

export interface Daemon {
  readonly serverDir: string;
  readonly socketPath: string;
  readonly registry: SessionRegistry;
  /** Close the socket and release sessions. Sessions stay marked running so the next start resumes them. */
  stop(): Promise<void>;
}

/** True when something is already accepting connections on the socket. */
function socketIsLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

export async function startDaemon(options: DaemonOptions = {}): Promise<Daemon> {
  const serverDir = options.serverDir ?? defaultServerDir();
  const socketPath = socketPathFor(serverDir);
  const log = options.log ?? (() => undefined);
  ensureServerDir(serverDir);
  if (existsSync(socketPath)) {
    if (await socketIsLive(socketPath)) throw new Error(`A pi-better-server is already listening on ${socketPath}`);
    unlinkSync(socketPath); // left behind by a daemon that died without cleaning up
  }

  const registry = new SessionRegistry({ serverDir, sessionOptions: options.sessionOptions, log });
  await registry.resumeAll();

  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    // Sessions the client created or opened on this connection push their events back to it.
    const attached = new Map<string, () => void>();
    const send = (message: ServerMessage): void => {
      if (!socket.destroyed) socket.write(encodeLine(message));
    };
    const attach = (sessionId: string, hosted: HostedSession | undefined): void => {
      if (!hosted || attached.has(sessionId)) return;
      attached.set(sessionId, hosted.addListener((event) => send({ type: "event", sessionId, event })));
    };
    const detach = (sessionId: string): void => {
      attached.get(sessionId)?.();
      attached.delete(sessionId);
    };

    const dispatch = async (line: string): Promise<void> => {
      let command: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
        command = parsed as Record<string, unknown>;
      } catch {
        send(failure(undefined, "parse", "Invalid JSON line"));
        return;
      }
      const id = typeof command.id === "string" ? command.id : undefined;
      const type = typeof command.type === "string" ? command.type : "";
      const reply = (message: Record<string, unknown>): void => send({ ...(id !== undefined ? { id } : {}), type: "response", command: type, success: true, ...message } as ServerMessage);
      try {
        if (!type) {
          send(failure(id, "unknown", "Missing command type"));
          return;
        }
        if (DAEMON_COMMANDS.has(type)) {
          const sessionId = typeof command.sessionId === "string" ? command.sessionId : "";
          if (type === "list_sessions") return reply({ data: { sessions: registry.list() } });
          if (type === "create_session") {
            const summary = await registry.create(command as never);
            attach(summary.sessionId, registry.get(summary.sessionId));
            return reply({ sessionId: summary.sessionId, data: summary });
          }
          if (!sessionId) {
            send(failure(id, type, "sessionId is required"));
            return;
          }
          if (type === "open_session") {
            const summary = await registry.open(sessionId);
            attach(sessionId, registry.get(sessionId));
            return reply({ sessionId, data: summary });
          }
          detach(sessionId);
          await registry.close(sessionId);
          return reply({ sessionId });
        }
        const sessionId = typeof command.sessionId === "string" ? command.sessionId : "";
        if (!sessionId) {
          send(failure(id, type, "sessionId is required"));
          return;
        }
        const hosted = registry.get(sessionId);
        if (!hosted) {
          const reason = registry.resumeError(sessionId);
          send(failure(id, type, reason ? `Session ${sessionId} failed to resume: ${reason}` : `Session not open: ${sessionId}`, sessionId));
          return;
        }
        const { sessionId: _addressed, ...rpc } = command;
        const response = await hosted.handle(rpc as RpcCommand);
        send({ ...response, sessionId } as ServerMessage);
      } catch (error) {
        send(failure(id, type || "unknown", error instanceof Error ? error.message : String(error)));
      }
    };

    socket.setEncoding("utf8");
    const decoder = new LineDecoder(
      (line) => void dispatch(line),
      () => {
        send(failure(undefined, "parse", "Line too long"));
        socket.destroy();
      },
    );
    socket.on("data", (chunk: string) => decoder.push(chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => {
      sockets.delete(socket);
      for (const unsubscribe of attached.values()) unsubscribe();
      attached.clear();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Unix socket only: there is deliberately no TCP listener.
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(socketPath, 0o600);
  log(`listening on ${socketPath}`);

  let stopped: Promise<void> | undefined;
  return {
    serverDir,
    socketPath,
    registry,
    stop() {
      stopped ??= (async () => {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        for (const socket of sockets) socket.destroy();
        await closed;
        await registry.shutdown();
        if (existsSync(socketPath)) unlinkSync(socketPath);
      })();
      return stopped;
    },
  };
}
