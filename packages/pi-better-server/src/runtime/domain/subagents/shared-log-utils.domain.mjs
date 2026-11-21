// Generated fixed launch domain from packages/pi-better-subagents/shared-log-utils.ts. Do not edit directly.
// Generated from packages/log-utils/index.ts. Do not edit directly.
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Read no more than `maxBytes` from a file's end. This avoids whole-file
 * allocation for live logs that can grow past Node's string-size limit.
 */
export function readBoundedTail(path, maxBytes) {
    const budget = Math.max(1, Math.floor(maxBytes));
    let totalBytes;
    try {
        totalBytes = statSync(path).size;
    }
    catch (error) {
        return { text: "", truncated: false, totalBytes: 0, error: errorText(error) };
    }
    if (totalBytes === 0)
        return { text: "", truncated: false, totalBytes };
    if (totalBytes <= budget) {
        try {
            return { text: readFileSync(path, "utf8"), truncated: false, totalBytes };
        }
        catch (error) {
            return { text: "", truncated: false, totalBytes, error: errorText(error) };
        }
    }
    let fd;
    try {
        fd = openSync(path, "r");
        const buffer = Buffer.allocUnsafe(budget);
        const start = totalBytes - budget;
        let offset = 0;
        while (offset < budget) {
            const read = readSync(fd, buffer, offset, budget - offset, start + offset);
            if (read <= 0)
                break;
            offset += read;
        }
        return { text: buffer.toString("utf8", 0, offset), truncated: true, totalBytes };
    }
    catch (error) {
        return { text: "", truncated: true, totalBytes, error: errorText(error) };
    }
    finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            }
            catch { /* best effort */ }
        }
    }
}
/**
 * Convert terminal-like output into display rows. A bare carriage return is a
 * cursor reset, so repeated progress redraws collapse to their latest state;
 * CRLF remains a normal newline. Individual rows are capped defensively.
 */
export function terminalDisplayRows(text, maxRowChars = 8 * 1024) {
    const rowLimit = Math.max(64, Math.floor(maxRowChars));
    const rows = [];
    let current = "";
    let progress = "";
    const append = (value) => {
        current += value;
        if (current.length > rowLimit)
            current = `...${current.slice(-(rowLimit - 3))}`;
    };
    const emit = () => {
        const value = current || progress;
        if (value)
            rows.push(value);
        current = "";
        progress = "";
    };
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (char === "\r") {
            if (text[i + 1] === "\n") {
                emit();
                i += 1;
            }
            else {
                progress = current || progress;
                current = "";
            }
        }
        else if (char === "\n") {
            emit();
        }
        else {
            append(char);
        }
    }
    const final = current || progress;
    if (final)
        rows.push(final);
    return rows;
}
export function tailTerminalDisplay(text, rows, maxRowChars) {
    const rendered = terminalDisplayRows(text, maxRowChars);
    const count = Math.max(1, Math.floor(rows));
    return rendered.slice(-count).join("\n");
}
// ---------------------------------------------------------------------------
// UTF-8 total-output budgets, verbatim paging, retained-file cursors, envelope
// ---------------------------------------------------------------------------
/** Issue #312 / OUTPUT-POLICY defaults: whole model-facing `content`, UTF-8 bytes. */
export const OUTPUT_BUDGET_BYTES = {
    status: 1 * 1024,
    answer: 2 * 1024,
    log: 1 * 1024,
    list: 1 * 1024,
    callbackBatch: 2 * 1024,
    rawPage: 16 * 1024,
};
/** Documented hard caps. Explicit larger pages are allowed up to these values. */
export const OUTPUT_BUDGET_MAX_BYTES = {
    status: 2 * 1024,
    answer: 8 * 1024,
    log: 4 * 1024,
    list: 4 * 1024,
    callbackBatch: 8 * 1024,
    rawPage: 64 * 1024,
};
export const OUTPUT_PAGE_DEFAULTS = {
    logLines: 10,
    listEntries: 10,
};
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });
const CURSOR_PREFIX = "p1.";
const ROW_CURSOR_PREFIX = "l1.";
const HEAD_SAMPLE_BYTES = 256;
const WINDOW_SAMPLE_BYTES = 256;
const NEWLINE = 0x0a;
function positiveInt(value) {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
    if (!Number.isFinite(n) || n <= 0)
        return undefined;
    return Math.max(1, Math.floor(n));
}
/** Nonpositive, NaN, and non-numeric inputs fall back; callers may request a lower budget. */
export function clampBudgetBytes(value, fallback) {
    return positiveInt(value) ?? positiveInt(fallback) ?? 1;
}
/** Surface default, or a caller request clamped to the documented hard cap. */
export function budgetFor(surface, requested) {
    const fallback = OUTPUT_BUDGET_BYTES[surface];
    const cap = OUTPUT_BUDGET_MAX_BYTES[surface];
    const n = positiveInt(requested);
    if (n === undefined)
        return fallback;
    return Math.min(n, cap);
}
/** Pager budget: exact zero is an explicit empty page; garbage falls back. */
function pagerBudget(value, fallback) {
    if (value === 0)
        return 0;
    const n = positiveInt(value);
    if (n === undefined)
        return fallback;
    return Math.min(n, OUTPUT_BUDGET_MAX_BYTES.rawPage);
}
export function utf8ByteLength(text) {
    return encoder.encode(text).byteLength;
}
function isContinuation(byte) {
    return (byte & 0xc0) === 0x80;
}
function sequenceLength(lead) {
    if (lead <= 0x7f)
        return 1;
    if ((lead & 0xe0) === 0xc0)
        return 2;
    if ((lead & 0xf0) === 0xe0)
        return 3;
    if ((lead & 0xf8) === 0xf0)
        return 4;
    return 1;
}
/**
 * Largest end <= `to` that does not split a UTF-8 sequence, given that bytes
 * after `to` are available in `bytes`. A sequence cut by the end of `bytes`
 * itself is reported through `incompleteAtEnd` when `atEnd` is set.
 */
function utf8SafeEnd(bytes, from, to) {
    if (to <= from)
        return from;
    const limit = Math.min(to, bytes.length);
    let seqStart = limit - 1;
    while (seqStart > from && isContinuation(bytes[seqStart]) && limit - seqStart < 4)
        seqStart -= 1;
    const lead = bytes[seqStart];
    if (isContinuation(lead))
        return limit;
    const needed = sequenceLength(lead);
    if (needed === 1 || seqStart + needed <= limit)
        return limit;
    if (seqStart + needed <= bytes.length)
        return seqStart;
    // The sequence runs past the available bytes. When every following byte is
    // a continuation it is a genuine, still-incomplete write; otherwise the
    // source itself is malformed and is passed through rather than stalling.
    for (let i = seqStart + 1; i < bytes.length; i += 1) {
        if (!isContinuation(bytes[i]))
            return limit;
    }
    return seqStart;
}
function alignStart(bytes, start) {
    if (start <= 0)
        return 0;
    if (start >= bytes.length)
        return bytes.length;
    let i = start;
    while (i < bytes.length && isContinuation(bytes[i]))
        i += 1;
    return i;
}
/**
 * End the page after the last newline in [from, to) when that keeps at least
 * half of the page; otherwise cut at `to` (already a UTF-8 boundary), so a
 * short line followed by a huge one does not produce a nearly empty page.
 */
function preferNewlineEnd(bytes, from, to) {
    const floor = from + Math.ceil((to - from) / 2);
    for (let i = to - 1; i >= floor - 1 && i >= from; i -= 1) {
        if (bytes[i] === NEWLINE)
            return i + 1;
    }
    return to;
}
/**
 * Byte range for one text page. With `forceProgress` a budget smaller than
 * the next code point still returns that code point (display clipping only);
 * pagers pass `false` so a page never exceeds its budget.
 */
function sliceUtf8Range(bytes, start, maxBytes, preferNewline, forceProgress = true) {
    const from = alignStart(bytes, start);
    if (from >= bytes.length)
        return { start: from, end: from };
    const budget = Math.max(0, Math.floor(maxBytes));
    let to = utf8SafeEnd(bytes, from, Math.min(bytes.length, from + budget));
    if (to <= from) {
        if (!forceProgress)
            return { start: from, end: from };
        to = Math.min(bytes.length, from + sequenceLength(bytes[from]));
    }
    // Prefer a newline only when this slice is truncated. If the remainder fits,
    // keep a final line that has no trailing newline.
    if (preferNewline && to > from && to < bytes.length)
        to = preferNewlineEnd(bytes, from, to);
    return { start: from, end: to };
}
/** Display clipping helper. It may exceed `maxBytes` by one code point to make progress. */
export function sliceUtf8Bytes(text, startByte, maxBytes, preferNewline = true) {
    const encoded = encoder.encode(text);
    const range = sliceUtf8Range(encoded, startByte, maxBytes, preferNewline);
    return {
        text: decoder.decode(encoded.subarray(range.start, range.end)),
        startByte: range.start,
        endByte: range.end,
        bytes: range.end - range.start,
    };
}
function hashBytes(bytes) {
    return createHash("sha256").update(bytes).digest("base64url");
}
/** Short digest stored in cursors (128 bits): cursors stay small in the model-facing budget. */
function shortHash(bytes) {
    return hashBytes(bytes).slice(0, 22);
}
/** Cursors carry a digest of their resource/scope, never the scope text itself. */
function resourceTag(resource) {
    return hashBytes(encoder.encode(resource)).slice(0, 16);
}
/**
 * Cursors that carry an offset are tagged, so a hand-copied cursor can be
 * recognised as damaged. Status cursors are not: they hold no offset, a
 * damaged one already falls back to the current facts, and their payload sits
 * in 1 KiB status responses where every cursor byte competes with decision
 * facts (`remote setup: …` was clipped once the cursor grew).
 */
function isTaggedCursorKind(kind) {
    return kind !== "s";
}
function encodeCursor(payload) {
    const tagged = isTaggedCursorKind(payload.k) ? { ...payload, x: cursorIntegrityTag(payload) } : payload;
    return CURSOR_PREFIX + Buffer.from(JSON.stringify(tagged), "utf8").toString("base64url");
}
/**
 * Integrity tag over every payload field except the tag itself.
 *
 * Cursors are re-typed by the model. One mistyped base64url character used to
 * decode into a payload that still parsed: when the changed field was the
 * source digest the pager reported `source-replaced`, restarted at byte 0 and
 * minted the same cursor again — the caller could never reach the rest of the
 * text (#617). The tag makes a near-miss detectable as corruption instead of
 * being read as a different source.
 */
function cursorIntegrityTag(payload) {
    const { x: _ignored, ...rest } = payload;
    // 36 bits: enough to catch an accidental edit, and short enough that the
    // cursor stays a small thing to copy.
    return shortHash(encoder.encode(JSON.stringify(rest))).slice(0, 6);
}
/**
 * Structural decode only: a corrupted payload still reports its kind and
 * resource so it can be classified and, where the offset is still meaningful,
 * resumed. `cursorIntegrityOk` is the separate integrity verdict.
 */
function decodeCursor(cursor) {
    if (!cursor || !cursor.startsWith(CURSOR_PREFIX))
        return undefined;
    try {
        const parsed = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"));
        if (parsed?.k === "t" || parsed?.k === "f" || parsed?.k === "s")
            return parsed;
    }
    catch {
        return undefined;
    }
    return undefined;
}
/** False when any payload field was altered after the cursor was minted. */
function cursorIntegrityOk(parsed) {
    if (!isTaggedCursorKind(parsed.k))
        return true;
    return typeof parsed.x === "string" && parsed.x === cursorIntegrityTag(parsed);
}
/**
 * Digest of one source snapshot at one offset. A text cursor carries it in `v`
 * and, recomputed against the current text, it answers both questions a
 * continuation needs: is this still the same source, and is this still its
 * offset? A changed source or a shifted offset changes it (#617).
 */
function textSnapshotDigest(revision, offset) {
    return shortHash(encoder.encode(`t\0${revision}\0${offset}`));
}
/**
 * Second, independent witness of the same fact, stored in `w`: the snapshot,
 * its length, and the offset. Both witnesses are recomputed from the current
 * text, so damage to either one alone still leaves a usable cursor — the
 * reported one-character miscopy keeps the page advancing instead of replaying
 * page 1 forever, while a genuinely replaced or shifted source fails both.
 */
function textOffsetWitness(revision, offset, length) {
    return shortHash(encoder.encode(`t\0${revision}\0${length}\0${offset}`)).slice(0, 6);
}
/** Decoded page offset, or NaN when the field did not survive decoding. */
function cursorOffset(parsed) {
    const o = parsed.o;
    return typeof o === "number" && Number.isFinite(o) ? Math.floor(o) : Number.NaN;
}
export function cursorKind(cursor) {
    if (cursor?.startsWith(ROW_CURSOR_PREFIX))
        return decodeRowCursor(cursor) ? "l" : undefined;
    return decodeCursor(cursor)?.k;
}
function readAt(fd, position, length) {
    if (length <= 0)
        return Buffer.alloc(0);
    const buffer = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
        const n = readSync(fd, buffer, filled, length - filled, position + filled);
        if (n <= 0)
            break;
        filled += n;
    }
    return filled === length ? buffer : buffer.subarray(0, filled);
}
function singleLine(value) {
    return value.replace(/[\r\n\x00-\x1f\x7f]/g, " ").trim();
}
function emptyPage(overrides) {
    return {
        text: "",
        hasMore: false,
        omittedBytes: 0,
        totalBytes: 0,
        startByte: 0,
        endByte: 0,
        gaps: [],
        ...overrides,
    };
}
/**
 * Page exact UTF-8 text. Consecutive pages concatenate to the original string.
 * Cursors are caller-owned: the same cursor plus maxBytes always yields the
 * same page, and two callers do not share consumption.
 *
 * A cursor that fails its integrity check is reported as `cursor-corrupt`,
 * never as a replaced source, and never replays page 1 blindly: it resumes at
 * its decoded offset only when a witness recomputed from the current text
 * proves that offset still belongs to the same snapshot. Otherwise — a
 * replaced, grown, or shifted source, a damaged offset, or a cursor from
 * before the witnesses existed — the page restarts at byte 0, so no unread
 * text is skipped (#617).
 */
export function pageVerbatimText(text, request = {}) {
    const maxBytes = pagerBudget(request.maxBytes, OUTPUT_BUDGET_BYTES.answer);
    const encoded = encoder.encode(text);
    const revision = shortHash(encoded);
    const resource = request.resource === undefined ? undefined : resourceTag(request.resource);
    let offset = 0;
    let reset;
    const parsed = decodeCursor(request.cursor);
    if (request.cursor) {
        if (!parsed || parsed.k !== "t") {
            reset = "stale-cursor";
        }
        else if (!cursorIntegrityOk(parsed) || parsed.w === undefined) {
            // A payload without its position witness (a cursor minted before this
            // format) is treated the same as a damaged one: its offset is unproven.
            reset = "cursor-corrupt";
            if ((parsed.r ?? undefined) === resource) {
                const decoded = cursorOffset(parsed);
                const inside = Number.isFinite(decoded) && decoded >= 0 && decoded <= encoded.length;
                // Two independent witnesses of "this snapshot at this offset": either
                // one surviving a single damaged field keeps a static-source cursor
                // moving instead of looping on page 1.
                const witnessed = inside && (parsed.v === textSnapshotDigest(revision, decoded)
                    || (parsed.w !== undefined && parsed.w === textOffsetWitness(revision, decoded, encoded.length)));
                if (witnessed)
                    offset = decoded;
            }
        }
        else if ((parsed.r ?? undefined) !== resource) {
            reset = "stale-cursor";
        }
        else {
            offset = Math.min(encoded.length, Math.max(0, Math.floor(parsed.o ?? 0)));
            if (parsed.v !== textSnapshotDigest(revision, offset)) {
                // Same cursor, different text: restart at byte 0 rather than serving
                // bytes from a position that no longer means what it did.
                reset = "source-replaced";
                offset = 0;
            }
        }
    }
    const mint = (o) => encodeCursor({
        k: "t",
        ...(resource !== undefined ? { r: resource } : {}),
        v: textSnapshotDigest(revision, o),
        o,
        n: encoded.length,
        w: textOffsetWitness(revision, o, encoded.length),
    });
    const make = (start, end) => ({
        text: decoder.decode(encoded.subarray(start, end)),
        revision,
        cursor: mint(start),
        nextCursor: mint(end),
        hasMore: end < encoded.length,
        omittedBytes: Math.max(0, encoded.length - end),
        totalBytes: encoded.length,
        startByte: start,
        endByte: end,
        ...(reset ? { reset } : {}),
        gaps: [],
    });
    if (offset >= encoded.length)
        return make(encoded.length, encoded.length);
    const range = sliceUtf8Range(encoded, offset, maxBytes, true, false);
    let end = range.end;
    const maxLines = positiveInt(request.maxLines);
    if (maxLines !== undefined) {
        let seen = 0;
        for (let i = range.start; i < end; i += 1) {
            if (encoded[i] === NEWLINE) {
                seen += 1;
                if (seen >= maxLines) {
                    end = i + 1;
                    break;
                }
            }
        }
    }
    return make(range.start, end);
}
function fileGaps(request) {
    const gaps = [];
    const discarded = request.discardedBytes;
    if (typeof discarded === "number" && Number.isFinite(discarded) && discarded > 0) {
        gaps.push({
            kind: "retention",
            bytes: Math.floor(discarded),
            detail: "older retained bytes discarded",
        });
    }
    for (const gap of request.captureGaps ?? []) {
        if (!Number.isFinite(gap.bytes) || gap.bytes <= 0)
            continue;
        gaps.push({ kind: "capture", bytes: Math.floor(gap.bytes), detail: gap.detail });
    }
    return gaps;
}
/**
 * Identity of the file object, not just its path. Linux filesystems reuse a
 * freed inode number immediately, so a delete + recreate can keep `dev:ino`;
 * the birth time tells the files apart where the platform reports it at fine
 * granularity. With coarse timestamps the two are indistinguishable by stat,
 * and the head/pre-offset byte checks classify the change instead.
 */
function fileIdentity(stats) {
    const birth = stats.birthtimeNs > 0n ? `:${stats.birthtimeNs.toString(36)}` : "";
    return `${stats.dev.toString(36)}:${stats.ino.toString(36)}${birth}`;
}
function fileRevision(generation, identity, snapshot) {
    return `${generation ?? ""}|${identity}|${snapshot}`;
}
function fileReadError(request, path, error, reset) {
    const resource = resourceTag(request.resource ?? path);
    const cursor = encodeCursor({ k: "f", r: resource, o: 0, n: 0 });
    return emptyPage({
        revision: "unreadable",
        cursor,
        nextCursor: cursor,
        gaps: [...fileGaps(request), { kind: "read", detail: errorText(error) }],
        ...(reset ? { reset } : {}),
    });
}
/**
 * Start byte of an end-anchored page inside `window` (the bytes immediately
 * before its upper bound). A backward page starts just after the first newline
 * that keeps at least half the window, so consecutive pages concatenate; when
 * no such newline exists (one oversized line) it starts on the next whole code
 * point and the page begins mid-line rather than stalling.
 */
function backwardPageStart(window) {
    let start = 0;
    while (start < window.length && isContinuation(window[start]))
        start += 1;
    const floor = Math.ceil(window.length / 2);
    for (let i = start; i < floor; i += 1) {
        if (window[i] === NEWLINE)
            return i + 1;
    }
    return start;
}
/**
 * Largest boundary <= `end` that does not split a UTF-8 sequence, looking only
 * at the bytes retained up to `end`. Used for the newest retained byte, which
 * a writer can leave inside a code point it has not finished emitting.
 */
function completeCodePointEnd(fd, end) {
    if (end <= 0)
        return 0;
    const from = Math.max(0, end - 4);
    const tail = readAt(fd, from, end - from);
    return from + utf8SafeEnd(tail, 0, tail.length);
}
/**
 * Page retained file bytes without skipping unread ranges. Snapshot high-water
 * marks keep a page stable while the file appends. Cursors bind the resource
 * (task/run plus session scope), the file object's identity, the consumer
 * generation, the head, and the bytes just before the offset, so replacement,
 * same-inode compaction, and in-place rewrites reset instead of resuming at a
 * meaningless offset. A trailing, still-incomplete UTF-8 sequence is withheld
 * (`pendingBytes`) and returned whole once the writer completes it.
 */
export function pageRetainedFile(path, request = {}) {
    const maxBytes = pagerBudget(request.maxBytes, OUTPUT_BUDGET_BYTES.rawPage);
    const resource = resourceTag(request.resource ?? path);
    const generation = request.generation === undefined ? undefined : String(request.generation);
    const suppliedGaps = fileGaps(request);
    let fd;
    try {
        fd = openSync(path, "r");
    }
    catch (error) {
        return fileReadError(request, path, error, request.cursor ? "source-replaced" : undefined);
    }
    const opened = fd;
    try {
        const stats = fstatSync(opened, { bigint: true });
        const size = Number(stats.size);
        const identity = fileIdentity(stats);
        const head = readAt(opened, 0, Math.min(HEAD_SAMPLE_BYTES, size));
        const headHash = shortHash(head);
        const windowHash = (o) => {
            if (o <= 0)
                return undefined;
            const from = Math.max(0, o - WINDOW_SAMPLE_BYTES);
            return shortHash(readAt(opened, from, o - from));
        };
        const initialSnapshot = () => Math.min(size, request.snapshotBytes !== undefined
            ? clampBudgetBytes(request.snapshotBytes, size)
            : size);
        const parsed = decodeCursor(request.cursor);
        let reset;
        let offset = 0;
        let snapshot = initialSnapshot();
        let appendReady = false;
        if (request.cursor) {
            if (!parsed || parsed.k !== "f") {
                reset = "stale-cursor";
            }
            else {
                // A hand-copied cursor is never reported as a replaced source: that was
                // a false claim, and the restart replayed page 1 forever (#617). A
                // damaged payload is also never resumed: its offset *and* its direction
                // come from a payload that failed its integrity check, so the pass
                // restarts at its own anchor (byte 0 forward, the newest byte backward)
                // instead of continuing somewhere the caller never reached (#617 R1).
                const corrupt = !cursorIntegrityOk(parsed);
                const reason = (clean) => (corrupt ? "cursor-corrupt" : clean);
                if (parsed.r !== resource) {
                    reset = reason("stale-cursor");
                }
                else if (parsed.i !== identity) {
                    reset = reason("source-replaced");
                }
                else if (corrupt) {
                    reset = "cursor-corrupt";
                }
                else {
                    const o = Math.max(0, Math.floor(parsed.o ?? 0));
                    const n = Math.max(0, Math.floor(parsed.n ?? 0));
                    const headLength = Math.max(0, Math.floor(parsed.hl ?? 0));
                    const generationChanged = generation !== undefined && parsed.g !== generation;
                    const bytesIntact = o <= n
                        && n <= size
                        && headLength <= size
                        && (!parsed.h || shortHash(head.subarray(0, headLength)) === parsed.h)
                        && (o === 0 || windowHash(o) === parsed.w);
                    if (generationChanged) {
                        // The consumer declared a compaction/replacement of this file.
                        reset = "compacted";
                    }
                    else if (!bytesIntact) {
                        // Same file object as far as stat can tell, but the bytes behind the
                        // cursor changed without a declared compaction: rewritten in place,
                        // or deleted and recreated on a reused inode with coarse timestamps.
                        reset = "source-replaced";
                    }
                    else {
                        offset = o;
                        snapshot = n;
                        appendReady = parsed.a === 1;
                    }
                }
            }
        }
        if (appendReady && offset >= snapshot && size > snapshot) {
            snapshot = Math.max(snapshot, initialSnapshot());
        }
        const mint = (o, n, append, back = false) => {
            const window = windowHash(o);
            return encodeCursor({
                k: "f",
                r: resource,
                o,
                n,
                ...(generation !== undefined ? { g: generation } : {}),
                i: identity,
                h: headHash,
                hl: head.length,
                ...(window ? { w: window } : {}),
                ...(append ? { a: 1 } : {}),
                ...(back ? { b: 1 } : {}),
            });
        };
        const base = {
            gaps: suppliedGaps,
            ...(reset ? { reset } : {}),
        };
        // A backward cursor keeps its own direction (even after a reset, which
        // restarts at the newest bytes); the request flag starts one.
        const backward = parsed?.k === "f" ? parsed.b === 1 : request.direction === "backward";
        if (backward) {
            if (!request.cursor || reset)
                offset = snapshot;
            if (offset > snapshot)
                offset = snapshot;
            const mintBackward = (o) => mint(o, snapshot, false, true);
            const revision = fileRevision(generation, identity, snapshot);
            // The newest retained byte can stop inside a code point the writer has not
            // finished. Withhold that suffix like the forward pager does, and anchor
            // the append cursor at its first byte, so the whole character arrives once
            // the writer completes it. Every other page starts where a previous page
            // already aligned.
            const snapshotEnd = completeCodePointEnd(opened, snapshot);
            if (offset <= 0) {
                // Nothing earlier is retained: hand back the forward append-ready cursor.
                return emptyPage({
                    revision,
                    cursor: mintBackward(0),
                    nextCursor: mint(snapshotEnd, snapshotEnd, true),
                    totalBytes: snapshot,
                    startByte: 0,
                    endByte: 0,
                    appendReady: true,
                    direction: "backward",
                    ...(snapshotEnd < snapshot ? { pendingBytes: snapshot - snapshotEnd } : {}),
                    ...base,
                });
            }
            const from = Math.max(0, offset - maxBytes);
            const window = readAt(opened, from, offset - from);
            const withheldFrom = offset === snapshot ? snapshotEnd : offset;
            const pendingBytes = offset - withheldFrom;
            // Byte 0 is always a valid page start; otherwise start at the first line
            // boundary that keeps as much of the window as possible.
            const reachedStart = from === 0;
            const start = reachedStart ? 0 : from + backwardPageStart(window.subarray(0, withheldFrom - from));
            if (!reachedStart && start >= withheldFrom) {
                // Budget is smaller than the next code point behind the cursor: stay put.
                const here = mintBackward(offset);
                return emptyPage({
                    revision,
                    cursor: here,
                    nextCursor: here,
                    hasMore: true,
                    omittedBytes: offset,
                    totalBytes: snapshot,
                    startByte: offset,
                    endByte: offset,
                    direction: "backward",
                    ...(pendingBytes > 0 ? { pendingBytes } : {}),
                    ...base,
                });
            }
            return {
                text: decoder.decode(window.subarray(start - from, withheldFrom - from)),
                revision,
                cursor: mintBackward(offset),
                // Reaching the oldest byte hands the whole pass back to forward polling:
                // the append cursor sits on the newest complete code point, so a withheld
                // character is returned whole rather than skipped.
                nextCursor: reachedStart ? mint(snapshotEnd, snapshotEnd, true) : mintBackward(start),
                hasMore: !reachedStart,
                omittedBytes: start,
                totalBytes: snapshot,
                startByte: start,
                endByte: withheldFrom,
                ...(reachedStart ? { appendReady: true } : {}),
                ...(pendingBytes > 0 ? { pendingBytes } : {}),
                direction: "backward",
                ...base,
            };
        }
        if (offset > snapshot)
            offset = snapshot;
        if (offset >= snapshot) {
            return emptyPage({
                revision: fileRevision(generation, identity, snapshot),
                cursor: mint(offset, snapshot, true),
                nextCursor: mint(snapshot, snapshot, true),
                totalBytes: snapshot,
                startByte: snapshot,
                endByte: snapshot,
                appendReady: true,
                ...base,
            });
        }
        const available = snapshot - offset;
        const limit = Math.min(maxBytes, available);
        const atSnapshotEnd = limit === available;
        const buffer = readAt(opened, offset, Math.min(available, limit + 4));
        let end = utf8SafeEnd(buffer, 0, limit);
        let pendingBytes = 0;
        if (atSnapshotEnd && end < limit) {
            // The retained bytes stop inside a sequence that is still being written.
            pendingBytes = available - end;
            snapshot = offset + end;
        }
        else if (!atSnapshotEnd && end > 0) {
            end = preferNewlineEnd(buffer, 0, end);
        }
        const endByte = offset + end;
        const revision = fileRevision(generation, identity, snapshot);
        if (end === 0 && pendingBytes === 0) {
            // Budget is smaller than the next code point: stay put, skip nothing.
            const here = mint(offset, snapshot, false);
            return emptyPage({
                revision,
                cursor: here,
                nextCursor: here,
                hasMore: true,
                omittedBytes: available,
                totalBytes: snapshot,
                startByte: offset,
                endByte: offset,
                ...base,
            });
        }
        const atEnd = endByte >= snapshot;
        return {
            text: decoder.decode(buffer.subarray(0, end)),
            revision,
            cursor: mint(offset, snapshot, false),
            nextCursor: mint(endByte, snapshot, atEnd),
            hasMore: !atEnd,
            omittedBytes: Math.max(0, snapshot - endByte),
            totalBytes: snapshot,
            startByte: offset,
            endByte,
            ...(atEnd ? { appendReady: true } : {}),
            ...(pendingBytes > 0 ? { pendingBytes } : {}),
            ...base,
        };
    }
    catch (error) {
        return fileReadError(request, path, error, request.cursor ? "source-replaced" : undefined);
    }
    finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            }
            catch { /* best effort */ }
        }
    }
}
function statusRevisionToken(contentRevision, failureRevision) {
    return hashBytes(encoder.encode(`${contentRevision}\0${failureRevision}`));
}
/**
 * Compare a caller-owned status cursor to the current content and failure
 * revisions. Failure-only changes are distinct from log-byte changes; nothing
 * is consumed globally.
 */
export function inspectStatusRevision(input) {
    const revision = statusRevisionToken(input.contentRevision, input.failureRevision);
    const resource = resourceTag(input.resource);
    const content = shortHash(encoder.encode(input.contentRevision)).slice(0, 16);
    const failure = shortHash(encoder.encode(input.failureRevision)).slice(0, 16);
    const nextCursor = encodeCursor({ k: "s", r: resource, c: content, f: failure });
    const parsed = decodeCursor(input.cursor);
    if (!input.cursor)
        return { change: "content", revision, nextCursor };
    if (!parsed || parsed.k !== "s" || parsed.r !== resource) {
        return { change: "reset", reset: "stale-cursor", revision, nextCursor };
    }
    const contentSame = parsed.c === content;
    const failureSame = parsed.f === failure;
    if (contentSame && failureSame)
        return { change: "none", revision, nextCursor };
    if (contentSame && !failureSame)
        return { change: "failure", revision, nextCursor };
    return { change: "content", revision, nextCursor };
}
export function formatUnchangedEvidence(cursor) {
    return `No new evidence since cursor ${cursor}.`;
}
/** Stable short revision of arbitrary JSON-serialisable status facts. */
export function revisionOf(value) {
    return createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("base64url").slice(0, 32);
}
// ---------------------------------------------------------------------------
// Shared output-control parameters, session scope keys, and log identity facts
// (#321/#323). Subagent and background-task tools both read these, so the two
// families cannot drift.
// ---------------------------------------------------------------------------
/**
 * Canonical output-control parameter names and their deprecated aliases.
 * Canonical names follow this repo's dominant snake_case tool-parameter style
 * (`max_log_bytes`, `timeout_seconds`, `exclude_tools`, `sandbox_dir`, ...).
 */
export const OUTPUT_CONTROL_ALIASES = {
    max_bytes: "maxBytes",
    lines: "tail_lines",
};
/**
 * Resolve output-control parameters. Both spellings work; when both are given
 * the canonical name wins. An explicit `null` is "not given", so a null
 * canonical value never hides an alias value (#332). Values are returned
 * unvalidated so each surface keeps its own defaults and hard caps.
 */
export function readOutputControls(params) {
    const p = (params && typeof params === "object" ? params : {});
    const pick = (canonical) => p[canonical] ?? p[OUTPUT_CONTROL_ALIASES[canonical]] ?? undefined;
    const maxBytes = pick("max_bytes");
    const lines = pick("lines");
    return {
        ...(maxBytes !== undefined ? { maxBytes } : {}),
        ...(lines !== undefined ? { lines } : {}),
    };
}
/** Explicit opt-in sections for otherwise-omitted spend and tool facts. */
export const OUTPUT_INCLUDE_VALUES = ["cost", "tools"];
/** Parse an `include` request into known values and unknown ones (both deduplicated). */
export function readOutputInclude(value) {
    // Any other non-null value (a number, boolean, or object) is one unknown entry, never silently nothing (#332).
    const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : value == null ? [] : [value];
    const include = new Set();
    const unknown = [];
    for (const entry of raw) {
        const name = String(entry ?? "").trim().toLowerCase();
        if (!name)
            continue;
        if (OUTPUT_INCLUDE_VALUES.includes(name))
            include.add(name);
        else if (!unknown.includes(name))
            unknown.push(name);
    }
    return { include, unknown };
}
/** Stable digest of one cwd + session origin (the digest the subagent registry indexes by). */
export function originScopeDigest(origin) {
    return createHash("sha256").update(origin.cwd).update("\0").update(origin.sessionId ?? "").digest("hex").slice(0, 24);
}
/**
 * Cursor scope. Every pagination and revision cursor binds this key, so a
 * cursor never crosses session scopes. `unavailable` wins over an origin: a
 * caller whose session identity could not be read is never the same scope as
 * a readable one.
 */
export function sessionScopeKey(input) {
    if (input.all)
        return "all";
    if (input.unavailable)
        return "session:unavailable";
    if (input.origin)
        return `session:${originScopeDigest(input.origin)}${!input.origin.sessionId && input.processId !== undefined ? `:process:${input.processId}` : ""}`;
    return input.fallback ?? "none";
}
/**
 * Identity facts of a retained log for a content revision: device, inode,
 * size, and whole-millisecond mtime, or the read error. A deleted, replaced,
 * or appended log is a content change.
 */
export function logIdentityFacts(path) {
    try {
        const stats = statSync(path);
        return [stats.dev, stats.ino, stats.size, Math.trunc(stats.mtimeMs)];
    }
    catch (error) {
        return ["unreadable", error.code ?? String(error)];
    }
}
/** Content revision: consumer lifecycle facts followed by the retained log's identity. */
export function lifecycleContentRevision(facts, logPath) {
    return revisionOf([...facts, logIdentityFacts(logPath)]);
}
function encodeRowCursor(payload) {
    return ROW_CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
function decodeRowCursor(cursor) {
    if (!cursor || !cursor.startsWith(ROW_CURSOR_PREFIX))
        return undefined;
    try {
        const parsed = JSON.parse(Buffer.from(cursor.slice(ROW_CURSOR_PREFIX.length), "base64url").toString("utf8"));
        if (parsed?.k === "l" && typeof parsed.r === "string" && typeof parsed.t === "number" && typeof parsed.i === "string")
            return parsed;
    }
    catch {
        return undefined;
    }
    return undefined;
}
export function isRowCursor(cursor) {
    return decodeRowCursor(cursor) !== undefined;
}
/** Resolve a list anchor only in the scope/filter that issued it. */
export function rowCursorKey(cursor, resource) {
    const parsed = decodeRowCursor(cursor);
    return parsed?.r === resourceTag(resource) && Number.isFinite(parsed.t) ? { time: parsed.t, id: parsed.i } : undefined;
}
/** Sorts before every real row: a cursor anchored here starts at the first row. */
const HEAD_ROW_KEY = { time: Number.MAX_SAFE_INTEGER, id: "" };
function rowOrder(a, b) {
    if (a.time !== b.time)
        return b.time - a.time;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}
function clipRow(row, maxBytes) {
    if (utf8ByteLength(row) <= maxBytes)
        return row;
    const marker = "…";
    const room = maxBytes - utf8ByteLength(marker);
    if (room <= 0)
        return "";
    const encoded = encoder.encode(row);
    const end = utf8SafeEnd(encoded, 0, room);
    return `${decoder.decode(encoded.subarray(0, end))}${marker}`;
}
/**
 * Page compact rows newest-first. The cursor records the last row shown, so
 * rows inserted ahead of it (new tasks) never shift later pages and rows are
 * neither repeated nor skipped. Only whole rows are counted as shown; a single
 * row larger than the page is clipped (callers put the id first).
 */
export function pageRows(items, request) {
    const keyed = items.map((item) => ({ item, key: request.keyOf(item) }))
        .sort((a, b) => rowOrder(a.key, b.key));
    const total = request.indexed?.total ?? keyed.length;
    const limit = Math.max(1, Math.floor(request.limit));
    const maxBytes = Math.max(0, Math.floor(request.maxBytes));
    let start = 0;
    let reset;
    const resource = resourceTag(request.resource);
    if (request.cursor) {
        const parsed = decodeRowCursor(request.cursor);
        if (!parsed || parsed.r !== resource) {
            reset = "stale-cursor";
        }
        else {
            const anchor = { time: parsed.t, id: parsed.i };
            start = keyed.findIndex((row) => rowOrder(row.key, anchor) > 0);
            if (start < 0)
                start = keyed.length;
        }
    }
    const lines = [];
    let used = 0;
    let clippedRows = 0;
    let index = start;
    for (; index < keyed.length && lines.length < limit; index += 1) {
        const row = request.render(keyed[index].item);
        const sep = lines.length ? 1 : 0;
        const size = utf8ByteLength(row);
        if (used + sep + size <= maxBytes) {
            lines.push(row);
            used += sep + size;
            continue;
        }
        if (lines.length === 0) {
            const clipped = clipRow(row, maxBytes);
            if (clipped) {
                lines.push(clipped);
                used += utf8ByteLength(clipped);
                clippedRows += 1;
                index += 1;
            }
        }
        break;
    }
    const shown = lines.length;
    const before = request.indexed?.before ?? start;
    const remaining = Math.max(0, total - before - lines.length);
    const current = request.cursor && !reset ? request.cursor : undefined;
    // The next page starts after the last row shown, or — when no row fit —
    // at this page's own start, so a caller can always retry with a larger page.
    const anchor = shown > 0 ? keyed[index - 1].key : rowCursorKey(current, request.resource) ?? (start > 0 ? keyed[start - 1].key : HEAD_ROW_KEY);
    const nextCursor = remaining > 0
        ? encodeRowCursor({ k: "l", r: resource, t: anchor.time, i: anchor.id })
        : undefined;
    return {
        text: lines.join("\n"),
        hasMore: remaining > 0,
        ...(current ? { cursor: current } : {}),
        ...(nextCursor ? { nextCursor } : {}),
        omittedBytes: 0,
        omittedRows: remaining,
        ...(reset ? { reset } : {}),
        gaps: [],
        shown,
        total,
        before,
        remaining,
        clippedRows,
    };
}
// ---------------------------------------------------------------------------
// Priority envelope
// ---------------------------------------------------------------------------
function joinParts(parts) {
    return parts.filter((part) => Boolean(part && part.length > 0)).join("\n");
}
function clipPrefix(text, maxBytes) {
    const total = utf8ByteLength(text);
    if (total <= maxBytes)
        return { text, omittedBytes: 0 };
    if (maxBytes <= 0)
        return { text: "", omittedBytes: total };
    const encoded = encoder.encode(text);
    const range = sliceUtf8Range(encoded, 0, maxBytes, true, false);
    return { text: decoder.decode(encoded.subarray(0, range.end)), omittedBytes: total - range.end };
}
function formatContinuation(info) {
    const lines = [];
    const page = info.page;
    if (page?.reset)
        lines.push(`reset=${page.reset}`);
    if (page && (page.hasMore || page.omittedBytes > 0 || (page.omittedRows ?? 0) > 0)) {
        const amount = page.omittedRows !== undefined
            ? `omittedRows=${page.omittedRows}`
            : `omittedBytes=${page.omittedBytes}`;
        const cursor = page.nextCursor ? ` nextCursor=${page.nextCursor}${page.via ? ` (${page.via})` : ""}` : "";
        // End-anchored pages count earlier bytes and continue toward the start.
        const direction = page.direction === "backward" ? " (newest-first page; nextCursor reads earlier bytes)" : "";
        lines.push(`hasMore=${page.hasMore} ${amount}${cursor}${direction}`);
    }
    else if (page?.appendReady && page.nextCursor) {
        lines.push(`end nextCursor=${page.nextCursor} (reuse to read only bytes appended later)`);
    }
    if (page?.pendingBytes) {
        lines.push(`pendingBytes=${page.pendingBytes} (incomplete UTF-8 sequence withheld until the writer completes it)`);
    }
    for (const gap of info.gaps) {
        const bytes = gap.bytes !== undefined ? ` bytes=${gap.bytes}` : "";
        const detail = gap.detail ? ` detail=${singleLine(gap.detail)}` : "";
        lines.push(`gap ${gap.kind}${bytes}${detail}`);
    }
    for (const item of info.omitted) {
        lines.push(`omitted ${item.section} bytes=${item.omittedBytes}`);
    }
    if (info.statusCursor)
        lines.push(`statusCursor=${info.statusCursor}`);
    if (lines.length === 0)
        return undefined;
    return ["---", ...lines].join("\n");
}
/** Bytes always left for a function-valued failure section so its counts survive. */
const FAILURE_SECTION_FLOOR = 256;
/**
 * Assemble one model-facing payload under a total UTF-8 byte cap.
 *
 * Budget priority: identity, decision facts (matched condition, stop error,
 * exit), continuation/gap metadata, then failures, diagnostics, the verbatim
 * page, and finally routine progress. `verbatimReserve` holds bytes back from
 * failures/diagnostics so an answer page always advances. The verbatim pager
 * receives the exact remaining budget and is never clipped afterwards, so
 * `nextCursor` always points at the first byte not shown (a zero budget yields
 * an empty page positioned at its start). Text order: identity (or failure
 * first with `failureFirst`), failure, decision, diagnostics, verbatim,
 * progress, continuation.
 */
export function assemblePriorityEnvelope(input) {
    const maxBytes = clampBudgetBytes(input.maxBytes, OUTPUT_BUDGET_BYTES.status);
    const sections = input.sections ?? {};
    const extraGaps = input.gaps ?? [];
    let continuationReserve = 0;
    let last;
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const omitted = [];
        const avail = Math.max(0, maxBytes - continuationReserve);
        let used = 0;
        let count = 0;
        const place = (name, text, room) => {
            if (!text)
                return undefined;
            const sep = count > 0 ? 1 : 0;
            const clipped = clipPrefix(text, room - sep);
            if (clipped.omittedBytes > 0)
                omitted.push({ section: name, omittedBytes: clipped.omittedBytes });
            if (!clipped.text)
                return undefined;
            used += sep + utf8ByteLength(clipped.text);
            count += 1;
            return clipped.text;
        };
        const identity = place("identity", sections.identity, avail - used);
        const decision = place("decision", sections.decision, avail - used);
        const failureInput = sections.failure;
        const failureFloor = failureInput ? Math.min(FAILURE_SECTION_FLOOR, Math.max(0, avail - used)) : 0;
        const reserve = input.verbatim
            ? Math.max(0, Math.min(Math.floor(input.verbatimReserve ?? 0), avail - used - failureFloor - 1))
            : 0;
        const failureRoom = avail - used - reserve;
        const failureText = typeof failureInput === "function"
            ? failureInput(Math.max(0, failureRoom - (count > 0 ? 1 : 0)))
            : failureInput;
        const failure = place("failure", failureText, failureRoom);
        const diagnostics = place("diagnostics", sections.diagnostics, avail - used - reserve);
        const verbatimBudget = Math.max(0, avail - used - (count > 0 ? 1 : 0));
        let page = input.verbatim?.(verbatimBudget);
        if (page && utf8ByteLength(page.text) > verbatimBudget)
            page = input.verbatim?.(0);
        const pageText = page?.text ? page.text : undefined;
        const gaps = [...extraGaps, ...(page?.gaps ?? [])];
        const body = input.failureFirst
            ? joinParts([failure, identity, decision, diagnostics, pageText])
            : joinParts([identity, failure, decision, diagnostics, pageText]);
        const bodyBytes = utf8ByteLength(body);
        let progress;
        if (sections.progress) {
            // Size the continuation as if progress were clipped, so the omission
            // line it may add is already paid for.
            const worst = formatContinuation({
                page,
                gaps,
                omitted: [...omitted, { section: "progress", omittedBytes: utf8ByteLength(sections.progress) }],
                statusCursor: input.statusCursor,
            });
            const leftover = maxBytes - bodyBytes - (body ? 1 : 0) - (worst ? utf8ByteLength(worst) + 1 : 0);
            const clipped = clipPrefix(sections.progress, leftover);
            if (clipped.omittedBytes > 0)
                omitted.push({ section: "progress", omittedBytes: clipped.omittedBytes });
            progress = clipped.text || undefined;
        }
        const continuation = formatContinuation({ page, gaps, omitted, statusCursor: input.statusCursor });
        const text = joinParts([body, progress, continuation]);
        const size = utf8ByteLength(text);
        last = { text, omitted, page, continuation, gaps };
        if (size <= maxBytes) {
            return {
                text,
                byteLength: size,
                truncated: Boolean(page?.hasMore) || omitted.length > 0,
                omitted,
                verbatim: page,
                continuation,
                gaps,
            };
        }
        // Reserve at least the whole continuation block; grow further if the body
        // still overflows (for example when a smaller page changes the cursor).
        continuationReserve = Math.max(continuationReserve + (size - maxBytes), (continuation ? utf8ByteLength(continuation) + 1 : 0) + (progress ? utf8ByteLength(progress) + 1 : 0));
    }
    // Budgets smaller than the metadata itself: keep the continuation (the way
    // back to the evidence) ahead of any body text.
    const fallback = last ?? { text: "", omitted: [], gaps: extraGaps };
    const tail = fallback.continuation ?? "";
    const head = clipPrefix(sections.identity ?? "", Math.max(0, maxBytes - utf8ByteLength(tail) - 1)).text;
    const combined = clipPrefix(joinParts([head, tail]), maxBytes);
    return {
        text: combined.text,
        byteLength: utf8ByteLength(combined.text),
        truncated: true,
        omitted: [...fallback.omitted, ...(combined.omittedBytes > 0 ? [{ section: "continuation", omittedBytes: combined.omittedBytes }] : [])],
        verbatim: fallback.page,
        continuation: fallback.continuation,
        gaps: fallback.gaps,
    };
}
