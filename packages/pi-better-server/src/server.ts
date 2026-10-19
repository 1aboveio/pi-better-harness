import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import type { RpcCommand } from "@earendil-works/pi-coding-agent";
import { CompanionManager, type CompanionManagerOptions } from "./companion.ts";
import { ConnectionControl } from "./control.ts";
import { checkHello } from "./handshake.ts";
import { defaultServerDir, ensureServerDir, socketPathFor } from "./paths.ts";
import { MoveService } from "./move/service.ts";
import { CONTROL_COMMANDS, DAEMON_COMMANDS, encodeLine, failure, LineDecoder, MOVE_COMMANDS, type MoveCommand, type ServerMessage } from "./protocol.ts";
import { SessionRegistry, type SessionRegistryOptions } from "./registry.ts";
import { NativeClientHost, NATIVE_HOST_COMMANDS } from "./remote-client/host.ts";

export interface DaemonOptions {
  /** Defaults to `~/.pi/agent/server` (or `$PI_SERVER_DIR`). */
  serverDir?: string;
  sessionOptions?: SessionRegistryOptions["sessionOptions"];
  log?: (message: string) => void;
  /** Bounds for each session's replay ring and on-disk event log. */
  eventLog?: SessionRegistryOptions["eventLog"];
  /** Where `start_companion` runs the attach terminal; defaults to `$PI_SERVER_TMUX_SOCKET` or the user's own tmux server. */
  companion?: Pick<CompanionManagerOptions, "tmuxSocket" | "command" | "readyTimeoutMs">;
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

  const registry = new SessionRegistry({ serverDir, sessionOptions: options.sessionOptions, eventLog: options.eventLog, log });
  await registry.resumeAll();
  const nativeHost = new NativeClientHost(registry);
  const companions = new CompanionManager({
    socketPath,
    ...options.companion,
    tmuxSocket: options.companion?.tmuxSocket ?? process.env.PI_SERVER_TMUX_SOCKET,
    isReady: (id) => registry.get(id)?.controllerIs((owner) => owner instanceof ConnectionControl && owner.companion) ?? false,
  });

  // A running attach companion holds the controller lease: the move ends it at the fence, after any wait for a turn, so one started during that wait is stopped too.
  const moves = new MoveService(registry, serverDir, (sessionId) => companions.stop(sessionId));

  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    const send = (message: ServerMessage): void => {
      if (!socket.destroyed) socket.write(encodeLine(message));
    };
    const control = new ConnectionControl(send);

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
      let releaseSessionOperation: (() => void) | undefined;
      try {
        if (!type) {
          send(failure(id, "unknown", "Missing command type"));
          return;
        }
        if (type === "hello") {
          const verdict = checkHello(command);
          if (verdict.ok) return reply({ data: verdict.data });
          send(failure(id, type, verdict.error));
          socket.end(); // an incompatible client gets the reason, then the door
          return;
        }
        if (NATIVE_HOST_COMMANDS.has(type)) return reply({ data: await nativeHost.handle(command) });
        if (nativeHost.busy && type !== "list_sessions") {
          send(failure(id, type, "Remote extensions are being updated; retry after installation finishes"));
          return;
        }
        if (MOVE_COMMANDS.has(type) || (DAEMON_COMMANDS.has(type) && type !== "list_sessions")) releaseSessionOperation = nativeHost.enterSessionOperation();
        if (MOVE_COMMANDS.has(type)) {
          return reply(await moves.handle(command as MoveCommand));
        }
        if (DAEMON_COMMANDS.has(type)) {
          const sessionId = typeof command.sessionId === "string" ? command.sessionId : "";
          if (type === "list_sessions") return reply({ data: { sessions: registry.list() } });
          if (type === "create_session") {
            const summary = await registry.create(command as never);
            // A brand-new session has no history to catch up on: stream it live to its creator.
            const created = registry.get(summary.sessionId);
            if (created) control.subscribe(summary.sessionId, created, undefined);
            return reply({ sessionId: summary.sessionId, data: summary });
          }
          if (!sessionId) {
            send(failure(id, type, "sessionId is required"));
            return;
          }
          if (type === "open_session") {
            const summary = await registry.open(sessionId);
            return reply({ sessionId, data: summary });
          }
          if (type === "rename_session") {
            const summary = await registry.rename(sessionId, command.name as string);
            return reply({ sessionId, data: summary });
          }
          if (type === "start_companion") {
            const summary = await registry.open(sessionId);
            const info = await companions.start(sessionId, summary.cwd);
            return reply({ sessionId, data: info });
          }
          if (type === "stop_companion") return reply({ sessionId, data: { stopped: await companions.stop(sessionId) } });
          if (type === "close_session") {
            const blocked = registry.ownership.blockedReason(sessionId);
            if (blocked) throw new Error(blocked);
            control.unsubscribe(sessionId);
            await companions.stop(sessionId);
            await registry.close(sessionId);
            return reply({ sessionId });
          }
          throw new Error(`Unknown daemon command: ${type}`);
        }
        const sessionId = typeof command.sessionId === "string" ? command.sessionId : "";
        if (!sessionId) {
          send(failure(id, type, "sessionId is required"));
          return;
        }
        const blocked = registry.ownership.blockedReason(sessionId);
        if (blocked) {
          send(failure(id, type, blocked, sessionId));
          return;
        }
        const hosted = registry.get(sessionId);
        if (hosted && CONTROL_COMMANDS.has(type)) return control.handle(command, hosted);
        if (!hosted) {
          const reason = registry.resumeError(sessionId);
          send(failure(id, type, reason ? `Session ${sessionId} failed to resume: ${reason}` : `Session not open: ${sessionId}`, sessionId));
          return;
        }
        if (type === "client_snapshot") return reply({ sessionId, data: await hosted.clientSnapshot() });
        if (type === "clear_queue") return reply({ sessionId, data: hosted.session.clearQueue() });
        if (type === "abort_compaction") {
          hosted.session.abortCompaction();
          return reply({ sessionId });
        }
        const { sessionId: _addressed, ...rpc } = command;
        const response = await hosted.handle(rpc as RpcCommand);
        send({ ...response, sessionId } as ServerMessage);
      } catch (error) {
        send(failure(id, type || "unknown", error instanceof Error ? error.message : String(error)));
      } finally {
        releaseSessionOperation?.();
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
      control.dispose();
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
