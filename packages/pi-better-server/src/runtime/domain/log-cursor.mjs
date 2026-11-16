// Generated from packages/pi-better-subagents/log-cursor.ts. Do not edit directly.
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
import { closeSync, openSync, readSync, statSync } from "node:fs";
/** Bytes of the log head kept to detect a rewrite behind our back. */
const HEAD_SAMPLE_BYTES = 256;
export const logReadMetrics = { bytes: 0, reads: 0, parsedEvents: 0, displayFolded: 0, healthFolded: 0 };
let batch;
/** Share identical ranges and decoding only during a synchronous observation. */
export function withLogReadBatch(observe) {
    const previous = batch;
    batch = { reads: new Map(), events: new Map(), ranges: new Map() };
    try {
        return observe();
    }
    finally {
        batch = previous;
    }
}
export function parseLogEvent(line) {
    if (batch?.events.has(line))
        return batch.events.get(line);
    const event = JSON.parse(line);
    logReadMetrics.parsedEvents++;
    batch?.events.set(line, event);
    return event;
}
/** Default ceiling on a single read: also the cold-start tail window. */
export const DEFAULT_MAX_READ_BYTES = 32 * 1024 * 1024; // 32 MiB
function errText(err) {
    return err instanceof Error ? err.message : String(err);
}
function readAt(fd, position, length, path) {
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
        if (n <= 0)
            break;
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
function readHead(fd, size, path) {
    const length = Math.min(HEAD_SAMPLE_BYTES, size);
    if (length <= 0)
        return "";
    return readAt(fd, 0, length, path).toString("latin1");
}
/**
 * Same log? Compare the prefix both samples cover, so a head that is still
 * growing is not read as a rewrite. No shared prefix means one sample was taken
 * while the log was empty — nothing was read from it, so there is nothing the
 * new bytes could contradict.
 */
function headsAgree(previous, current) {
    const shared = Math.min(previous.length, current.length);
    if (shared === 0)
        return true;
    return previous.slice(0, shared) === current.slice(0, shared);
}
/**
 * Read the complete lines appended to `path` since `previous`.
 *
 * Passing `previous: undefined` starts cold: the last `maxBytes` of the log,
 * with the leading partial line dropped.
 */
export function readAppendedLines(path, previous, maxBytes = DEFAULT_MAX_READ_BYTES) {
    const key = JSON.stringify([path, previous, maxBytes]);
    const cached = batch?.reads.get(key);
    if (cached)
        return cached;
    const result = readLines(path, previous, maxBytes);
    batch?.reads.set(key, result);
    return result;
}
function readLines(path, previous, maxBytes) {
    logReadMetrics.reads++;
    const empty = (error) => ({
        lines: [],
        cursor: previous ?? { offset: 0, head: "" },
        totalBytes: 0,
        truncated: false,
        restarted: false,
        error,
    });
    let size;
    try {
        size = statSync(path).size;
    }
    catch (err) {
        return empty(errText(err));
    }
    let fd;
    try {
        fd = openSync(path, "r");
    }
    catch (err) {
        return empty(errText(err));
    }
    try {
        const head = readHead(fd, size, path);
        // A log that shrank or whose head changed is a different log: the old
        // offset would point into unrelated bytes. Compare only the prefix the
        // two samples share, so a log still shorter than the sample window is
        // not "rewritten" every time it grows.
        const resumable = previous !== undefined
            && previous.offset <= size
            && headsAgree(previous.head, head);
        const restarted = previous !== undefined && !resumable;
        let start = resumable ? previous.offset : 0;
        let truncated = false;
        if (size - start > maxBytes) {
            // Skip ahead instead of lagging: a chatty log must not push the
            // cursor permanently into the past.
            start = size - maxBytes;
            truncated = true;
        }
        // We begin mid-line whenever bytes were skipped.
        const startedMidLine = truncated;
        if (size === start) {
            return { lines: [], cursor: { offset: start, head }, totalBytes: size, truncated, restarted };
        }
        const buf = readAt(fd, start, size - start, path);
        const lastNewline = buf.lastIndexOf(0x0a);
        if (lastNewline === -1) {
            // No complete line yet. Hold position so the line can finish —
            // unless it is an oversized partial we already skipped into, which
            // would otherwise be re-read forever.
            const offset = startedMidLine ? start + buf.length : start;
            const partial = startedMidLine ? undefined : buf.toString("utf-8");
            return { lines: [], partial, cursor: { offset, head }, totalBytes: size, truncated, restarted };
        }
        const text = buf.subarray(0, lastNewline + 1).toString("utf-8");
        const lines = text.split("\n");
        lines.pop(); // trailing "" after the final newline
        if (startedMidLine)
            lines.shift(); // partial first line
        // Anything after the final newline is unterminated: hand it over
        // separately rather than pretending it is a line.
        const trailing = buf.subarray(lastNewline + 1);
        const partial = trailing.length > 0 ? trailing.toString("utf-8") : undefined;
        return {
            lines,
            partial,
            cursor: { offset: start + lastNewline + 1, head },
            totalBytes: size,
            truncated,
            restarted,
        };
    }
    catch (err) {
        return empty(errText(err));
    }
    finally {
        try {
            closeSync(fd);
        }
        catch { /* ignore */ }
    }
}
