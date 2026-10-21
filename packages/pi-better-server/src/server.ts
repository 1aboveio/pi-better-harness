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
import { claimDaemonOwner } from "./daemon-owner.ts";
import { readLifecycleConfig, type LifecycleConfig } from "./lifecycle-config.ts";

export interface DaemonOptions extends Partial<LifecycleConfig> {
  /** Defaults to `~/.pi/agent/server` (or `$PI_SERVER_DIR`). */
  serverDir?: string;
  sessionOptions?: SessionRegistryOptions["sessionOptions"];
  log?: (message: string) => void;
  /** Bounds for each session's replay ring and on-disk event log. */
  eventLog?: SessionRegistryOptions["eventLog"];
  /** Where `start_companion` runs the attach terminal; defaults to `$PI_SERVER_TMUX_SOCKET` or the user's own tmux server. */
  companion?: Pick<CompanionManagerOptions, "tmuxSocket" | "command" | "readyTimeoutMs">;
  /** Clock injection for deterministic lifetime tests. */
  now?: () => number;
  /** Brief protection between hello/readiness and creation of a session. */
  startupGraceMs?: number;
}

export interface Daemon {
  readonly serverDir: string;
  readonly socketPath: string;
  readonly registry: SessionRegistry;
  readonly closed: Promise<void>;
  /** Run the same maintenance pass used by the background scheduler. */
  sweepIdle(): Promise<void>;
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
  const config = readLifecycleConfig(serverDir, options);
  const now = options.now ?? Date.now;
  const startupGraceMs = options.startupGraceMs ?? 30_000;
  if (!Number.isSafeInteger(startupGraceMs) || startupGraceMs < 0) throw new Error("startupGraceMs must be a non-negative integer");
  const releaseOwner = claimDaemonOwner(serverDir);
  let cleanupStartup = async (): Promise<void> => undefined;
  try {
    if (existsSync(socketPath)) {
      if (await socketIsLive(socketPath)) throw new Error(`A pi-better-server is already listening on ${socketPath}`);
      unlinkSync(socketPath); // left behind by a daemon that died without cleaning up
    }

    const registry = new SessionRegistry({ serverDir, sessionOptions: options.sessionOptions, eventLog: options.eventLog, log, sessionIdleMs: config.sessionIdleMs, now });
    cleanupStartup = () => registry.shutdown();
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
    const dispatches = new Set<Promise<void>>();
    let inFlight = 0;
    let draining = false;
    let zeroSince: number | undefined = registry.activeCount === 0 ? now() : undefined;
    let startupUntil = 0;
    const server: Server = createServer((socket) => {
      sockets.add(socket);
      const send = (message: ServerMessage): void => {
        if (!socket.destroyed) socket.write(encodeLine(message));
      };
      const control = new ConnectionControl(send);
      let greeted = false;

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
        if (draining) {
          send(failure(id, type || "unknown", "Daemon is shutting down; reconnect to start it again"));
          return;
        }
        inFlight++;
        try {
          if (!type) {
            send(failure(id, "unknown", "Missing command type"));
            return;
          }
          if (type === "hello") {
            const verdict = checkHello(command);
            if (verdict.ok) {
              if (!greeted) startupUntil = Math.max(startupUntil, now() + startupGraceMs);
              greeted = true;
              return reply({ data: verdict.data });
            }
            send(failure(id, type, verdict.error));
            socket.end(); // an incompatible client gets the reason, then the door
            return;
          }
          if (NATIVE_HOST_COMMANDS.has(type)) return reply({ data: await nativeHost.handle(command) });
          if (nativeHost.busy && !["list_sessions", "client_snapshot", "subscribe", "acquire_control", "release_control", "extension_ui_response"].includes(type)) {
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
              zeroSince = undefined;
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
              zeroSince = undefined;
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
          if (type === "client_reload") {
            if (!hosted.isController(control)) throw new Error("Acquire the session controller lease before reloading");
            await nativeHost.reload(sessionId);
            return reply({ sessionId });
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
          inFlight--;
          if (registry.activeCount > 0) zeroSince = undefined;
          else zeroSince ??= now();
        }
      };

      socket.setEncoding("utf8");
      const decoder = new LineDecoder(
        (line) => {
          const request = dispatch(line);
          dispatches.add(request);
          void request.then(() => dispatches.delete(request), error => {
            dispatches.delete(request);
            log(`request dispatch failed: ${String(error)}`);
          });
        },
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

    cleanupStartup = async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await registry.shutdown();
    };
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
    let maintenance: Promise<void> | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let finishClosed!: () => void;
    const closed = new Promise<void>(resolve => { finishClosed = resolve; });
    const daemon: Daemon = {
      serverDir,
      socketPath,
      registry,
      closed,
      sweepIdle() {
        if (draining) return stopped ?? Promise.resolve();
        if (nativeHost.busy) return Promise.resolve();
        maintenance ??= (async () => {
          const expired = await registry.expireIdle(now());
          if (draining) return;
          for (const sessionId of expired) await companions.stop(sessionId);
          if (registry.activeCount > 0) {
            zeroSince = undefined;
            return;
          }
          zeroSince ??= now();
          if (config.daemonIdleMs === 0 || now() - zeroSince < config.daemonIdleMs || now() < startupUntil) return;
          // No create/open can slip between this check and the synchronous admission fence.
          if (inFlight > 0 || nativeHost.busy || registry.hasPendingOperations) return;
          draining = true;
          log("idle timeout with no active sessions; shutting down");
        })().finally(() => { maintenance = undefined; });
        return maintenance.then(() => draining ? daemon.stop() : undefined);
      },
      stop() {
        const pendingMaintenance = maintenance;
        stopped ??= (async () => {
          draining = true;
          if (timer) clearInterval(timer);
          await pendingMaintenance?.catch(error => log(`maintenance interrupted during shutdown: ${String(error)}`));
          const closed = new Promise<void>((resolve) => server.close(() => resolve()));
          for (const socket of sockets) socket.destroy();
          await closed;
          await registry.shutdown();
          await Promise.allSettled([...dispatches]);
          if (existsSync(socketPath)) unlinkSync(socketPath);
          releaseOwner();
          finishClosed();
        })();
        return stopped;
      },
    };
    const durations = [config.sessionIdleMs, config.daemonIdleMs].filter(value => value > 0);
    if (durations.length) {
      timer = setInterval(() => { void daemon.sweepIdle().catch(error => log(`lifecycle maintenance failed: ${String(error)}`)); }, Math.max(5, Math.min(30_000, ...durations)));
      timer.unref();
    }
    return daemon;
  } catch (error) {
    await cleanupStartup();
    releaseOwner();
    throw error;
  }
}
