/**
 * JSON-RPC client for the Codex app-server, over its control socket (WebSocket on
 * a unix socket). The socket is only ever a local path: either the daemon's own, or
 * one that ssh forwarded from another machine. Nothing here opens a network port.
 */
import { connectUnixWebSocket, type UnixWebSocket } from "./ws-unix.ts";

export type JsonRpcNotification = { method: string; params?: any };

export class AppServerError extends Error {
  readonly code: number | undefined;
  constructor(method: string, message: string, code?: number) {
    super(`codex app-server ${method}: ${message}`);
    this.name = "AppServerError";
    this.code = code;
  }
}

export class CodexAppServerClient {
  private readonly ws: UnixWebSocket;
  private readonly pending = new Map<number, { method: string; resolve: (value: any) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<(notification: JsonRpcNotification) => void>();
  private nextId = 1;
  private closed = false;
  /** Result of `initialize`: includes `codexHome`. */
  info: { codexHome?: string; userAgent?: string } = {};

  private constructor(ws: UnixWebSocket) {
    this.ws = ws;
  }

  static async connect(socketPath: string, clientName = "pi-better-server"): Promise<CodexAppServerClient> {
    let client: CodexAppServerClient | undefined;
    const ws = await connectUnixWebSocket(socketPath, {
      onMessage: (text) => client?.onMessage(text),
      onClose: () => client?.onClosed(),
    });
    client = new CodexAppServerClient(ws);
    try {
      client.info = await client.call("initialize", { clientInfo: { name: clientName, version: "0" }, capabilities: null });
      ws.send(JSON.stringify({ method: "initialized" }));
    } catch (error) {
      client.close();
      throw error;
    }
    return client;
  }

  call<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new AppServerError(method, "connection closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerError(method, `no reply in ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ws.close();
    this.onClosed();
  }

  private onMessage(text: string): void {
    let message: any;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof message.id === "number" && this.pending.has(message.id) && (message.result !== undefined || message.error !== undefined)) {
      const entry = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new AppServerError(entry.method, String(message.error.message ?? "request failed"), message.error.code));
      else entry.resolve(message.result);
      return;
    }
    if (typeof message.method === "string" && message.id === undefined) for (const listener of this.listeners) listener(message);
  }

  private onClosed(): void {
    this.closed = true;
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      entry.reject(new AppServerError(entry.method, "connection closed"));
    }
  }
}
