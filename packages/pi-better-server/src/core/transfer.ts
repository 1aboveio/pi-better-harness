/**
 * Resumable-by-offset chunked file transfer, used to move a bundle over the
 * daemon's own socket (which an SSH forward carries between machines). The
 * receiver checks the total size and sha256 before it calls the file complete.
 */
import { closeSync, mkdirSync, openSync, readSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { sha256File } from "./bundle.ts";

export const DEFAULT_CHUNK_BYTES = 1024 * 1024;

export class TransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferError";
  }
}

export function readChunk(path: string, offset: number, length: number): { data: Buffer; eof: boolean } {
  const size = statSync(path).size;
  const want = Math.max(0, Math.min(length, size - offset));
  const buffer = Buffer.alloc(want);
  const fd = openSync(path, "r");
  try {
    let read = 0;
    while (read < want) {
      const n = readSync(fd, buffer, read, want - read, offset + read);
      if (n === 0) break;
      read += n;
    }
  } finally {
    closeSync(fd);
  }
  return { data: buffer, eof: offset + want >= size };
}

/** Receives one file by sequential writes; `finish` proves it arrived whole. */
export class InboundTransfer {
  readonly path: string;
  private readonly size: number;
  private readonly sha256: string;
  private received = 0;
  private fd: number | undefined;

  constructor(path: string, size: number, sha256: string) {
    this.path = path;
    this.size = size;
    this.sha256 = sha256;
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, "w", 0o600);
  }

  write(offset: number, data: Buffer): number {
    if (this.fd === undefined) throw new TransferError("transfer already finished");
    if (offset !== this.received) throw new TransferError(`out-of-order chunk: expected offset ${this.received}, got ${offset}`);
    if (this.received + data.length > this.size) throw new TransferError("transfer is larger than announced");
    writeSync(this.fd, data);
    this.received += data.length;
    return this.received;
  }

  finish(): void {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
    if (this.received !== this.size) throw new TransferError(`transfer incomplete: got ${this.received} of ${this.size} bytes`);
    if (sha256File(this.path) !== this.sha256) throw new TransferError("checksum mismatch: the archive changed in transit");
  }

  abort(): void {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
  }
}
