/**
 * Minimal WebSocket client over a unix socket: the Codex app-server speaks
 * WebSocket on `unix://PATH`, and Node's WebSocket cannot dial a unix socket.
 * Text frames only; that is all the app-server's JSON-RPC uses.
 */
import { createHash, randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface UnixWebSocket {
  send(text: string): void;
  close(): void;
}

export interface UnixWebSocketHandlers {
  onMessage(text: string): void;
  onClose(error?: Error): void;
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const length = payload.length;
  const header = length < 126 ? Buffer.from([0x80 | opcode, 0x80 | length]) : length < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 0xff]) : (() => {
    const buffer = Buffer.alloc(10);
    buffer[0] = 0x80 | opcode;
    buffer[1] = 0x80 | 127;
    buffer.writeBigUInt64BE(BigInt(length), 2);
    return buffer;
  })();
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i]! ^= mask[i % 4]!;
  return Buffer.concat([header, mask, masked]);
}

/** Open a WebSocket to `socketPath`. Resolves after the upgrade handshake. */
export function connectUnixWebSocket(socketPath: string, handlers: UnixWebSocketHandlers): Promise<UnixWebSocket> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(socketPath);
    const key = randomBytes(16).toString("base64");
    let buffer: Buffer = Buffer.alloc(0);
    let upgraded = false;
    let fragments: Buffer[] = [];
    let closed = false;
    const finish = (error?: Error): void => {
      if (closed) return;
      closed = true;
      socket.destroy();
      if (!upgraded) reject(error ?? new Error("socket closed before the WebSocket upgrade"));
      else handlers.onClose(error);
    };
    const api: UnixWebSocket = {
      send: (text) => void socket.write(encodeFrame(0x1, Buffer.from(text, "utf8"))),
      close: () => {
        if (!closed) socket.write(encodeFrame(0x8, Buffer.alloc(0)));
        finish();
      },
    };
    const pump = (): void => {
      for (;;) {
        if (buffer.length < 2) return;
        const fin = (buffer[0]! & 0x80) !== 0;
        const opcode = buffer[0]! & 0x0f;
        let length = buffer[1]! & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffer.length < offset + length) return;
        const payload = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        if (opcode === 0x8) return finish();
        if (opcode === 0x9) {
          socket.write(encodeFrame(0xa, payload));
          continue;
        }
        if (opcode === 0xa) continue;
        fragments.push(Buffer.from(payload));
        if (fin) {
          const text = Buffer.concat(fragments).toString("utf8");
          fragments = [];
          handlers.onMessage(text);
        }
      }
    };
    socket.on("connect", () => {
      socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString("latin1");
        buffer = buffer.subarray(end + 4);
        const accept = createHash("sha1").update(key + GUID).digest("base64");
        if (!/^HTTP\/1\.1 101/.test(head) || !head.includes(accept)) return finish(new Error(`WebSocket upgrade refused: ${head.split("\r\n")[0]}`));
        upgraded = true;
        resolve(api);
      }
      pump();
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish());
  });
}
