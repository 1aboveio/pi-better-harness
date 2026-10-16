/**
 * Daemon for Codex hosts: the same unix-socket protocol as the Pi daemon, limited to
 * what a Codex host needs: hello, list_sessions (Codex threads), get_state / steer / prompt
 * (so `pi-remote steer` works on a thread), the move commands, and `codex_endpoint`
 * (where the Codex app-server's control socket is, for attach).
 * The daemon never listens on TCP, and the app-server it fronts is reached only
 * through its own unix socket.
 */
import { chmodSync, existsSync, statSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { checkHello } from "../handshake.ts";
import { MoveHost } from "../core/move-host.ts";
import { defaultServerDir, ensureServerDir, movesDirFor, socketPathFor } from "../paths.ts";
import { encodeLine, failure, LineDecoder, MOVE_COMMANDS, type MoveCommand, type ServerMessage, type SessionSummary } from "../protocol.ts";
import { CodexMoveAdapter } from "./adapter.ts";
import { deliverToThread, isThreadRunning } from "./deliver.ts";
import { readRolloutMeta, readThreadName } from "./rollout.ts";
import { CodexRuntime, type CodexRuntimeOptions } from "./runtime.ts";

export interface CodexDaemonOptions {
  serverDir?: string;
  codex?: CodexRuntimeOptions;
  log?: (message: string) => void;
}

export interface CodexDaemon {
  readonly serverDir: string;
  readonly socketPath: string;
  readonly runtime: CodexRuntime;
  stop(): Promise<void>;
}

export interface CodexEndpoint {
  /** Unix socket of the Codex app-server on the daemon's host. */
  socketPath: string;
  codexVersion: string;
  appServerVersion?: string;
}

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

async function listThreads(runtime: CodexRuntime, adapter: CodexMoveAdapter): Promise<SessionSummary[]> {
  const client = await runtime.client();
  const sessions: SessionSummary[] = [];
  let cursor: string | null = null;
  do {
    const page: { data: any[]; nextCursor: string | null } = await client.call("thread/list", { limit: 100, cursor, sourceKinds: ["cli", "vscode", "exec", "appServer"] });
    for (const thread of page.data) {
      const ownership = adapter.ownership.get(thread.id).state;
      const iso = (seconds: unknown): string => new Date(Number(seconds) * 1000).toISOString();
      sessions.push({
        sessionId: thread.id,
        cwd: thread.cwd,
        sessionFile: thread.path ?? "",
        status: "running",
        ...(thread.name ? { name: thread.name } : thread.preview ? { name: String(thread.preview).slice(0, 80) } : {}),
        ...(thread.model ? { model: thread.model } : {}),
        isStreaming: thread.status?.type === "active",
        ...(ownership !== "owned" ? { ownership } : {}),
        live: thread.status?.type !== "notLoaded",
        lastSeq: 0,
        hasController: false,
        needsInput: [],
        createdAt: iso(thread.createdAt),
        updatedAt: iso(thread.updatedAt),
      });
    }
    cursor = page.nextCursor;
  } while (cursor);
  // A fenced or moved thread is archived on this app-server (thread/list omits it), but it must stay
  // addressable: `move --abort`, `--retire` and `ls` resolve it here. Build its row from the rollout.
  const listed = new Set(sessions.map((session) => session.sessionId));
  for (const record of adapter.ownership.list()) {
    if (record.state === "owned" || listed.has(record.sessionId)) continue;
    const file = runtime.rolloutPath(record.sessionId) ?? runtime.archivedRolloutPath(record.sessionId);
    if (!file) continue;
    try {
      const meta = readRolloutMeta(file);
      const name = readThreadName(runtime.home, record.sessionId);
      sessions.push({
        sessionId: record.sessionId,
        cwd: meta.cwd,
        sessionFile: file,
        status: "closed",
        ...(name ? { name } : {}),
        isStreaming: false,
        ownership: record.state,
        live: false,
        lastSeq: 0,
        hasController: false,
        needsInput: [],
        createdAt: meta.createdAt ?? record.updatedAt,
        updatedAt: statSync(file).mtime.toISOString(),
      });
    } catch {
      /* an unreadable rollout cannot be summarized; the move commands still accept the full id */
    }
  }
  return sessions;
}

export async function startCodexDaemon(options: CodexDaemonOptions = {}): Promise<CodexDaemon> {
  const serverDir = options.serverDir ?? defaultServerDir();
  const socketPath = socketPathFor(serverDir);
  const log = options.log ?? (() => undefined);
  ensureServerDir(serverDir);
  if (existsSync(socketPath)) {
    if (await socketIsLive(socketPath)) throw new Error(`A pi-better-server is already listening on ${socketPath}`);
    unlinkSync(socketPath);
  }

  const runtime = new CodexRuntime(options.codex);
  runtime.assertPinned();
  const adapter = new CodexMoveAdapter(runtime, serverDir);
  const moves = new MoveHost(adapter, serverDir, movesDirFor(serverDir));

  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    const send = (message: unknown): void => {
      if (!socket.destroyed) socket.write(encodeLine(message));
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
        if (type === "hello") {
          const verdict = checkHello(command);
          if (verdict.ok) return reply({ data: { ...verdict.data, extensionVersions: { ...verdict.data.extensionVersions, "codex-cli": runtime.version() } } });
          send(failure(id, type, verdict.error));
          socket.end();
          return;
        }
        if (MOVE_COMMANDS.has(type)) return reply(await moves.handle(command as MoveCommand));
        if (type === "list_sessions") return reply({ data: { sessions: await listThreads(runtime, adapter) } });
        if (type === "get_state" || type === "steer" || type === "prompt") {
          const sessionId = typeof command.sessionId === "string" ? command.sessionId : "";
          if (!sessionId) throw new Error(`${type} needs a sessionId`);
          if (type === "get_state") return reply({ sessionId, data: { sessionId, isStreaming: await isThreadRunning(adapter, runtime, sessionId) } });
          const message = typeof command.message === "string" ? command.message.trim() : "";
          if (!message) throw new Error(`${type} needs a message`);
          return reply({ sessionId, data: { delivered: await deliverToThread(adapter, runtime, sessionId, message) } });
        }
        if (type === "codex_endpoint") {
          const status = await runtime.daemonStatus();
          const endpoint: CodexEndpoint = { socketPath: status.socketPath, codexVersion: runtime.version(), ...(status.appServerVersion ? { appServerVersion: status.appServerVersion } : {}) };
          return reply({ data: endpoint });
        }
        send(failure(id, type || "unknown", `Codex hosts do not serve "${type}". Use the Codex TUI (pi-remote attach) to drive a thread.`));
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
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(socketPath, 0o600);
  log(`codex host listening on ${socketPath} (codex-cli ${runtime.version()}, CODEX_HOME ${runtime.home})`);

  let stopped: Promise<void> | undefined;
  return {
    serverDir,
    socketPath,
    runtime,
    stop() {
      stopped ??= (async () => {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        for (const socket of sockets) socket.destroy();
        await closed;
        runtime.close();
        if (existsSync(socketPath)) unlinkSync(socketPath);
      })();
      return stopped;
    },
  };
}
