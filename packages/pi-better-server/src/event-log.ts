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
  private lastSeq = 0;
  private fileEvents = 0;

  constructor(path: string, options: EventLogOptions = {}) {
    this.path = path;
    this.ringSize = options.ringSize ?? DEFAULT_RING;
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const existing = this.readFile();
    this.fileEvents = existing.length;
    this.lastSeq = existing.at(-1)?.seq ?? 0;
    this.ring.push(...existing.slice(-this.ringSize));
  }

  get last(): number {
    return this.lastSeq;
  }

  append(event: unknown): LoggedEvent {
    const logged: LoggedEvent = { seq: ++this.lastSeq, event };
    this.ring.push(logged);
    if (this.ring.length > this.ringSize) this.ring.shift();
    appendFileSync(this.path, `${JSON.stringify(logged)}\n`, { mode: 0o600 });
    if (++this.fileEvents > this.maxEvents) this.compact();
    return logged;
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
    const keep = this.readFile().slice(-Math.floor(this.maxEvents / 2));
    writeFileSync(this.path, keep.map((entry) => `${JSON.stringify(entry)}\n`).join(""), { mode: 0o600 });
    this.fileEvents = keep.length;
  }

  private readFile(): LoggedEvent[] {
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
