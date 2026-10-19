import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface LoggedEvent {
  seq: number;
  event: unknown;
}

export interface EventLogOptions {
  /** Newest events kept in memory for fast replay. */
  ringSize?: number;
  /** Newest events kept on disk; the file is cut back to half of this when it grows past it. */
  maxEvents?: number;
  /** Newest bytes kept on disk; the file is cut back to half of this when it grows past it. */
  maxBytes?: number;
  /** Newest bytes kept in memory for fast replay (the ring also holds at most `ringSize` events). */
  ringBytes?: number;
  /** How long appended lines may wait in memory before they are written in one batch. */
  flushMs?: number;
}

export interface Replay {
  events: LoggedEvent[];
  /** Oldest seq still available (0 when the log is empty). */
  firstSeq: number;
  /** True when events between `sinceSeq` and `firstSeq` were dropped to stay bounded. */
  truncated: boolean;
}

const DEFAULT_RING = 2_000;
const DEFAULT_MAX_EVENTS = 50_000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_RING_BYTES = 16 * 1024 * 1024;
const DEFAULT_FLUSH_MS = 50;

/**
 * Per-session ordered event log. Every event gets the next `seq`; the newest
 * ones sit in a ring, and all of them are appended to a JSONL file so a client
 * can catch up after a long disconnect and `seq` keeps counting across a
 * daemon restart. Both are bounded.
 */
export class EventLog {
  private readonly ring: LoggedEvent[] = [];
  private readonly ringSize: number;
  private readonly maxEvents: number;
  private readonly path: string;
  private readonly ringSizes: number[] = [];
  private ringBytesUsed = 0;
  private readonly maxBytes: number;
  private readonly ringBytes: number;
  private readonly flushMs: number;
  private lastSeq = 0;
  private fileEvents = 0;
  private fileBytes = 0;
  /** Serialized lines not yet written; a streaming turn appends one per token, so they go out in batches. */
  private pending: string[] = [];
  private pendingBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(path: string, options: EventLogOptions = {}) {
    this.path = path;
    this.ringSize = options.ringSize ?? DEFAULT_RING;
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const existing = this.readFile();
    this.fileEvents = existing.length;
    this.lastSeq = existing.at(-1)?.seq ?? 0;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.ringBytes = options.ringBytes ?? DEFAULT_RING_BYTES;
    this.flushMs = options.flushMs ?? DEFAULT_FLUSH_MS;
    this.fileBytes = existing.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)) + 1, 0);
    for (const entry of existing.slice(-this.ringSize)) this.pushRing(entry, Buffer.byteLength(JSON.stringify(entry)) + 1);
    if (this.fileEvents > this.maxEvents || this.fileBytes > this.maxBytes) this.compact();
  }

  get last(): number {
    return this.lastSeq;
  }

  append(event: unknown): LoggedEvent {
    const logged: LoggedEvent = { seq: ++this.lastSeq, event };
    const line = `${JSON.stringify(logged)}\n`;
    const size = Buffer.byteLength(line);
    this.pushRing(logged, size);
    this.pending.push(line);
    this.pendingBytes += size;
    this.fileEvents++;
    this.fileBytes += size;
    // Small batches are written after a short delay; a big one (or a quiet gap in the stream) does not wait.
    if (this.pendingBytes >= 256 * 1024) this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushMs);
      this.timer.unref();
    }
    if (this.fileEvents > this.maxEvents || this.fileBytes > this.maxBytes) this.compact();
    return logged;
  }

  /** Write every appended event to disk now. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.length === 0) return;
    const text = this.pending.join("");
    this.pending = [];
    this.pendingBytes = 0;
    appendFileSync(this.path, text, { mode: 0o600 });
  }

  private pushRing(entry: LoggedEvent, size: number): void {
    this.ring.push(entry);
    this.ringSizes.push(size);
    this.ringBytesUsed += size;
    // Always keep the newest event, however large.
    while (this.ring.length > 1 && (this.ring.length > this.ringSize || this.ringBytesUsed > this.ringBytes)) {
      this.ring.shift();
      this.ringBytesUsed -= this.ringSizes.shift()!;
    }
  }

  /** Every retained event with `seq > sinceSeq`, in order. */
  since(sinceSeq: number): Replay {
    const ringFirst = this.ring[0]?.seq;
    const source = ringFirst !== undefined && sinceSeq + 1 >= ringFirst ? this.ring : this.readFile();
    const firstSeq = source[0]?.seq ?? 0;
    return {
      events: source.filter((entry) => entry.seq > sinceSeq),
      firstSeq,
      truncated: firstSeq > sinceSeq + 1,
    };
  }

  private compact(): void {
    const entries = this.readFile();
    let keep = entries.slice(-Math.floor(this.maxEvents / 2));
    const lines = keep.map((entry) => `${JSON.stringify(entry)}\n`);
    let bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
    let start = 0;
    // Drop the oldest until the file is at half its byte bound (the newest event always stays).
    while (start < lines.length - 1 && bytes > this.maxBytes / 2) bytes -= Buffer.byteLength(lines[start++]!);
    keep = keep.slice(start);
    writeFileSync(this.path, lines.slice(start).join(""), { mode: 0o600 });
    this.fileEvents = keep.length;
    this.fileBytes = bytes;
  }

  private readFile(): LoggedEvent[] {
    this.flush();
    if (!existsSync(this.path)) return [];
    const entries: LoggedEvent[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line) as LoggedEvent);
      } catch {
        // A line cut short by a crash mid-append: everything before it is intact.
      }
    }
    return entries;
  }
}
