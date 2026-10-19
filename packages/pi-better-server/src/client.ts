import { connect, type Socket } from "node:net";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { SERVER_EXTENSION_VERSIONS } from "./handshake.ts";
import { encodeLine, LineDecoder, PROTOCOL_VERSION, type HelloData } from "./protocol.ts";

/** The daemon refused the `hello`; the message is the daemon's own explanation. */
export class HandshakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandshakeError";
  }
}

export interface ConnectOptions {
  /** Override what the client announces (tests use this to play an incompatible client). `false` skips the handshake. */
  hello?: { protocolVersion?: number; piVersion?: string; extensionVersions?: Record<string, string> } | false;
}

type Message = { id?: string; type: string; success?: boolean; error?: string; data?: any; sessionId?: string; [key: string]: unknown };

/** Newline-JSON client for the daemon socket. Connects, says hello, then multiplexes requests and events. */
export class DaemonClient {
  /** What the daemon announced in its hello reply; undefined when the handshake was skipped. */
  server: HelloData | undefined;
  private readonly socket: Socket;
  private readonly pending = new Map<string, { resolve: (message: Message) => void; reject: (error: Error) => void }>();
  private readonly eventListeners = new Set<(message: Message) => void>();
  private readonly closeListeners = new Set<() => void>();
  private nextId = 1;
  private closed = false;

  private constructor(socket: Socket, server: HelloData | undefined) {
    this.socket = socket;
    this.server = server;
    socket.setEncoding("utf8");
    const decoder = new LineDecoder(
      (line) => this.onLine(line),
      () => socket.destroy(),
    );
    socket.on("data", (chunk: string) => decoder.push(chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => this.onClosed());
  }

  static async connect(socketPath: string, options: ConnectOptions = {}): Promise<DaemonClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(socketPath);
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
    const client = new DaemonClient(socket, undefined);
    if (options.hello === false) return client;
    const response = await client.request({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      piVersion: PI_VERSION,
      extensionVersions: { ...SERVER_EXTENSION_VERSIONS },
      ...options.hello,
    }).catch((error: unknown) => {
      client.close();
      throw error;
    });
    if (!response.success) {
      client.close();
      throw new HandshakeError(response.error ?? "daemon rejected the handshake");
    }
    client.server = response.data as HelloData;
    return client;
  }

  /** Send one command and wait for its response. A `success:false` response resolves; it is not thrown. */
  request(command: Record<string, unknown>): Promise<Message> {
    if (this.closed) return Promise.reject(new Error("connection closed"));
    const id = `c${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(encodeLine({ ...command, id }));
    });
  }

  /** Like `request`, but a failed response throws with the daemon's error text. */
  async call(command: Record<string, unknown>): Promise<Message> {
    const response = await this.request(command);
    if (!response.success) throw new Error(response.error ?? `${String(command.type)} failed`);
    return response;
  }

  /** Every pushed `{type:"event"}` line, for sessions this connection created or `subscribe`d to (each carries `seq`). */
  onEvent(listener: (message: Message) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    this.socket.destroy();
  }

  private onLine(line: string): void {
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      return;
    }
    if (message.type === "event") {
      for (const listener of this.eventListeners) listener(message);
      return;
    }
    const waiter = message.id ? this.pending.get(message.id) : undefined;
    if (waiter && message.id) {
      this.pending.delete(message.id);
      waiter.resolve(message);
    }
  }

  private onClosed(): void {
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(new Error("connection closed"));
    this.pending.clear();
    for (const listener of this.closeListeners) listener();
  }
}
