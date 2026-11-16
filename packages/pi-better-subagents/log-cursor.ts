/**
 * Incremental NDJSON log reading for the UI hot path.
 *
 * Child run logs are append-only and can reach gigabytes: a `message_update`
 * event re-serialises the whole accumulated message, so a long assistant turn
 * grows the log roughly quadratically. Re-reading a whole log on every widget
 * frame pegged the host's main thread (a 1 GB log, four times a second), and on
 * logs past V8's max string length `readFileSync` fails outright. This module
 * reads only the bytes appended since the previous call.
 *
 * Contract:
 *   - the cursor always sits on a line boundary, so callers only ever see
 *     complete lines — a half-written trailing line is left for the next read;
 *   - a log that shrank, or whose head bytes changed, is treated as a new log
 *     and re-read from a bounded tail (rotation / rewrite);
 *   - one read never exceeds `maxBytes`. When a log outran that budget the
 *     cursor skips ahead rather than falling permanently behind, and
 *     `truncated` reports that bytes were never seen.
 */

import { closeSync, openSync, readSync, statSync, fstatSync } from "node:fs";

/** Bytes of the log head kept to detect a rewrite behind our back. */
const HEAD_SAMPLE_BYTES = 256;

export const logReadMetrics = { bytes: 0, reads: 0, parsedEvents: 0, displayFolded: 0, healthFolded: 0 };
let batch: { reads: Map<string, LogRead>; events: Map<string, unknown>; ranges: Map<string, Array<{ start: number; data: Buffer }>> } | undefined;

/** Share identical ranges and decoding only during a synchronous observation. */
export function withLogReadBatch<T>(observe: () => T): T {
    const previous = batch;
    batch = { reads: new Map(), events: new Map(), ranges: new Map() };
    try { return observe(); } finally { batch = previous; }
}

export function parseLogEvent(line: string): any {
    if (batch?.events.has(line)) return batch.events.get(line);
    const event = JSON.parse(line);
    logReadMetrics.parsedEvents++;
    batch?.events.set(line, event);
    return event;
}

/** Default ceiling on a single read: also the cold-start tail window. */
export const DEFAULT_MAX_READ_BYTES = 32 * 1024 * 1024; // 32 MiB

/**
 * Where a reader left off. Opaque to callers: hand the previous cursor back to
 * `readAppendedLines` and store the one it returns.
 */
export interface LogCursor {
    /** First observed byte; a tail consumer never claims coverage before it. */
    coverageStart?: number;
    /** Bounded envelope of skipped byte ranges, exclusive end. */
    missing?: [number, number];
    /** An oversized record is being discarded up to its next newline. */
    skipLeading?: boolean;
    generation?: string;
    size?: number;
    modified?: number;
    /** Byte offset of the first unread byte; always a line boundary. */
    offset: number;
    /** Head bytes (latin1, byte-exact) used to detect a rewritten log. */
    head: string;
}

export interface LogRead {
    more?: boolean;
    /** Complete lines appended since the previous cursor, in order. */
    lines: string[];
    /**
     * Bytes after the last newline: a line still being written, or a final line
     * whose writer never terminated it. NOT consumed by the cursor, so a caller
     * that folds it must do so speculatively — it will be delivered again, as a
     * complete line, once its newline arrives.
     */
    partial?: string;
    /** Cursor to pass to the next call. */
    cursor: LogCursor;
    /** Log size observed for this read. */
    totalBytes: number;
    /** Bytes were skipped: a bounded cold start, or a log that outran maxBytes. */
    truncated: boolean;
    /** The previous cursor was discarded — log rotated, rewritten, or truncated. */
    restarted: boolean;
    /** Set when the log could not be opened or read; `lines` is empty. */
    error?: string;
}

function errText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function readAt(fd: number, position: number, length: number, path: string): Buffer {
    const buf = Buffer.allocUnsafe(length);
    const ranges = batch?.ranges.get(path) ?? [];
    let filled = 0;
    while (filled < length) {
        const at = position + filled;
        const cached = ranges.find(range => range.start <= at && range.start + range.data.length > at);
        if (cached) {
            const offset = at - cached.start;
            const n = Math.min(length - filled, cached.data.length - offset);
            cached.data.copy(buf, filled, offset, offset + n);
            filled += n;
            continue;
        }
        const next = Math.min(position + length, ...ranges.filter(range => range.start > at).map(range => range.start));
        const n = readSync(fd, buf, filled, next - at, at);
        if (n <= 0) break;
        if (batch) {
            ranges.push({ start: at, data: buf.subarray(filled, filled + n) });
            batch.ranges.set(path, ranges);
        }
        filled += n;
        logReadMetrics.bytes += n;
    }
    return filled === length ? buf : buf.subarray(0, filled);
}

/** Head sample as a byte-exact string, for rewrite detection. */
function readHead(fd: number, size: number, path: string): string {
    const length = Math.min(HEAD_SAMPLE_BYTES, size);
    if (length <= 0) return "";
    return readAt(fd, 0, length, path).toString("latin1");
}

/**
 * Same log? Compare the prefix both samples cover, so a head that is still
 * growing is not read as a rewrite. No shared prefix means one sample was taken
 * while the log was empty — nothing was read from it, so there is nothing the
 * new bytes could contradict.
 */
function headsAgree(previous: string, current: string): boolean {
    const shared = Math.min(previous.length, current.length);
    if (shared === 0) return true;
    return previous.slice(0, shared) === current.slice(0, shared);
}

/**
 * Read the complete lines appended to `path` since `previous`.
 *
 * Passing `previous: undefined` starts cold: the last `maxBytes` of the log,
 * with the leading partial line dropped.
 */
export function readAppendedLines(
    path: string,
    previous?: LogCursor,
    maxBytes: number = DEFAULT_MAX_READ_BYTES,
    cumulative = false,
): LogRead {
    const key = JSON.stringify([path, previous, maxBytes, cumulative]);
    const cached = batch?.reads.get(key);
    if (cached) return cached;
    const result = readLines(path, previous, maxBytes, cumulative);
    batch?.reads.set(key, result);
    return result;
}

function readLines(path: string, previous: LogCursor | undefined, maxBytes: number, cumulative: boolean): LogRead {
    logReadMetrics.reads++;
    const empty = (error?: string): LogRead => ({
        lines: [],
        cursor: previous ?? { offset: 0, head: "" },
        totalBytes: 0,
        truncated: false,
        restarted: false,
        error,
    });

    let size: number;
    try {
        size = statSync(path).size;
    } catch (err) {
        return empty(errText(err));
    }

    let fd: number;
    try {
        fd = openSync(path, "r");
    } catch (err) {
        return empty(errText(err));
    }

    try {
        const info = fstatSync(fd);
        size = info.size;
        const generation = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
        const head = readHead(fd, size, path);
        // A log that shrank or whose head changed is a different log: the old
        // offset would point into unrelated bytes. Compare only the prefix the
        // two samples share, so a log still shorter than the sample window is
        // not "rewritten" every time it grows.
        const resumable = previous !== undefined
            && (previous.generation === undefined || previous.generation === generation)
            && !(previous.size === size && previous.modified !== undefined && previous.modified !== info.mtimeMs)
            && previous.offset <= size
            && headsAgree(previous.head, head);
        const restarted = previous !== undefined && !resumable;

        let coverageStart = resumable ? previous!.coverageStart ?? 0 : 0;
        let missing = resumable ? previous!.missing : undefined;
        let skipLeading = resumable ? previous!.skipLeading : false;
        const cursor = (offset: number): LogCursor => ({ offset, head, generation, size, modified: info.mtimeMs, coverageStart, missing, skipLeading });
        let start = resumable ? previous!.offset : 0;
        let truncated = false;
        if (!cumulative && size - start > maxBytes) {
            // Skip ahead instead of lagging: a chatty log must not push the
            // cursor permanently into the past.
            start = size - maxBytes;
            coverageStart = start;
            missing = [missing?.[0] ?? (resumable ? previous!.offset : 0), start];
            truncated = true;
        }
        // We begin mid-line whenever bytes were skipped.
        const startedMidLine = truncated || skipLeading;

        if (size === start) {
            return { lines: [], cursor: cursor(start), totalBytes: size, truncated, restarted };
        }

        const end = cumulative ? Math.min(size, start + maxBytes) : size;
        const buf = readAt(fd, start, end - start, path);
        const lastNewline = buf.lastIndexOf(0x0a);
        if (lastNewline === -1) {
            // No complete line yet. Hold position so the line can finish —
            // unless it is an oversized partial we already skipped into, which
            // would otherwise be re-read forever.
            const oversized = cumulative && end < size;
            if (oversized) missing = [missing?.[0] ?? start, end];
            if (oversized) skipLeading = true;
            const offset = startedMidLine || oversized ? start + buf.length : start;
            const partial = startedMidLine ? undefined : buf.toString("utf-8");
            return { lines: [], partial: oversized ? undefined : partial, cursor: cursor(offset), totalBytes: size, truncated: truncated || oversized, restarted, more: end < size };
        }

        const text = buf.subarray(0, lastNewline + 1).toString("utf-8");
        const lines = text.split("\n");
        lines.pop(); // trailing "" after the final newline
        if (startedMidLine) {
            lines.shift(); // partial first line
            missing = [missing?.[0] ?? 0, start + buf.indexOf(0x0a) + 1];
            coverageStart = Math.max(coverageStart, missing[1]);
            skipLeading = false;
        }

        // Anything after the final newline is unterminated: hand it over
        // separately rather than pretending it is a line.
        const trailing = buf.subarray(lastNewline + 1);
        const partial = end === size && trailing.length > 0 ? trailing.toString("utf-8") : undefined;

        return {
            lines,
            partial,
            cursor: cursor(start + lastNewline + 1),
            totalBytes: size,
            truncated,
            restarted,
            more: end < size,
        };
    } catch (err) {
        return empty(errText(err));
    } finally {
        try {
            closeSync(fd);
        } catch { /* ignore */ }
    }
}
