/**
 * Parse a child run's `--mode json` NDJSON log into clean, human-facing text.
 *
 * The child streams one JSON event per line (message lifecycle + token deltas).
 * Non-JSON lines — pi's `[pi-warp] …` banner, `Warning: No project session …`,
 * any stray stderr — simply fail to parse and are skipped, so the noise that
 * polluted `--mode text` output never reaches the caller.
 *
 * Large logs: reading the whole file can exceed Node's max string length
 * (~536 MB) and makes live output expensive, so nothing here ever reads a whole
 * log. `tailLog` serves humans a bounded raw tail, and parseRun() folds the
 * stream INCREMENTALLY: each call reads only the bytes appended since the last
 * one (see log-cursor.ts) and merges them into the run's accumulated result.
 *
 * That is both cheaper and more accurate than the bounded tail it replaced.
 * Token spend accumulates from `message_end` events, so a tail-only parse
 * silently under-counted every run whose log outgrew the window — it said so in
 * a diagnostic, but the number was still wrong. An accumulating fold counts
 * every event it has ever seen, and only a bounded COLD start (a log already
 * huge the first time this process looks at it) leaves a gap.
 */

import {
    closeSync,
    openSync,
    readFileSync,
    readSync,
    statSync,
} from "node:fs";
import { readAppendedLines, type LogCursor } from "./log-cursor.ts";
import { logPathFor } from "./registry.ts";

interface ContentBlock { type: string; text?: string; name?: string }
interface Cost { total?: number }
interface MsgUsage { input?: number; output?: number; cacheRead?: number; cost?: Cost }
interface Msg { role?: string; content?: string | ContentBlock[]; usage?: MsgUsage }

/** Cumulative token + cost spend across a run's turns. */
export interface Usage {
    input: number;
    output: number;
    cacheRead: number;
    costUSD: number;
    /** input + output, the headline "tokens" number. */
    total: number;
}

const DEFAULT_PARSE_TAIL_BYTES = 32 * 1024 * 1024; // 32 MiB
const DEFAULT_RAW_TAIL_BYTES = 256 * 1024; // 256 KiB

function envBytes(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function maxParseBytes(): number {
    return envBytes("PI_SUBAGENT_MAX_LOG_PARSE_BYTES", DEFAULT_PARSE_TAIL_BYTES);
}

function maxRawTailBytes(): number {
    return envBytes("PI_SUBAGENT_MAX_RAW_TAIL_BYTES", DEFAULT_RAW_TAIL_BYTES);
}

function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB"];
    let i = 0;
    let size = n / 1024;
    while (size >= 1024 && i < units.length - 1) {
        size /= 1024;
        i++;
    }
    return `${size.toFixed(1)} ${units[i]}`;
}

interface TailRead {
    text: string;
    truncated: boolean;
    totalBytes: number;
    /** Set when the file could not be opened/read; text is empty. */
    error?: string;
}

/**
 * Read at most `maxBytes` from the end of `path`. Avoids `readFileSync` so logs
 * larger than Node's max string length can still be tailed for live output.
 */
function readTail(path: string, maxBytes: number): TailRead {
    let totalBytes = 0;
    try {
        totalBytes = statSync(path).size;
    } catch {
        return { text: "", truncated: false, totalBytes: 0, error: "log not found" };
    }

    if (totalBytes === 0) {
        return { text: "", truncated: false, totalBytes: 0 };
    }

    if (totalBytes <= maxBytes) {
        try {
            return { text: readFileSync(path, "utf-8"), truncated: false, totalBytes };
        } catch (e) {
            return {
                text: "",
                truncated: false,
                totalBytes,
                error: `read failed: ${(e as Error).message}`,
            };
        }
    }

    let fd: number;
    try {
        fd = openSync(path, "r");
    } catch (e) {
        return {
            text: "",
            truncated: true,
            totalBytes,
            error: `open failed: ${(e as Error).message}`,
        };
    }

    const buf = Buffer.alloc(maxBytes);
    const offset = totalBytes - maxBytes;
    let read = 0;
    try {
        read = readSync(fd, buf, 0, maxBytes, offset);
    } catch (e) {
        closeSync(fd);
        return {
            text: "",
            truncated: true,
            totalBytes,
            error: `tail read failed: ${(e as Error).message}`,
        };
    }
    closeSync(fd);

    const text = buf.toString("utf-8", 0, read);

    return { text, truncated: true, totalBytes };
}

/** Last `n` lines of a run's log, or a placeholder if empty/unreadable. */
export function tailLog(id: string, n: number, maxBytes = maxRawTailBytes()): string {
    const tail = readTail(logPathFor(id), maxBytes);
    if (tail.error || tail.text.trim() === "") return "(no output yet)";
    const lines = tail.text.split("\n");
    const kept = lines.slice(Math.max(0, lines.length - n));
    const out = kept.join("\n").trim();
    return out === "" ? "(no output yet)" : out;
}

/** Join the text blocks of a message into a plain string. */
function messageText(msg: Msg | undefined): string {
    if (!msg) return "";
    const c = msg.content;
    if (typeof c === "string") return c;
    if (!Array.isArray(c)) return "";
    return c.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("").trim();
}

export interface UnmatchedToolCall {
    /** Child tool-call id when the event stream provides one. */
    id?: string;
    /** Child tool name, retained for human diagnostics. */
    toolName: string;
}

export interface ParsedRun {
    /** Final assistant answer (empty until the run produces one). */
    finalText: string;
    /** Latest streamed text/thinking, for a live progress peek. */
    lastActivity: string;
    /** Names of tools the child invoked, in order (deduped-adjacent). */
    toolCalls: string[];
    /** Tool starts that were not matched by a tool end before parsing stopped. */
    unmatchedToolCalls: UnmatchedToolCall[];
    /** True if we saw the terminal `agent_end`/`agent_settled` event. */
    sawEnd: boolean;
    /** Cumulative token + cost spend so far. */
    usage: Usage;
    /** Diagnostics about truncation or parse failure, surfaced to the user. */
    diagnostics: string[];
}

/**
 * Authoritative lifecycle evidence scanned from the complete NDJSON stream.
 * Kept separate from parseRun()'s bounded tail so large-log result parsing stays
 * memory-safe while clean completion still requires full-stream tool balance.
 */
export interface LifecycleEvidence {
    sawEnd: boolean;
    unmatchedToolCalls: UnmatchedToolCall[];
    /** True when the full file was readable end-to-end. */
    complete: boolean;
    diagnostics: string[];
}

/** Fixed read size for lifecycle authority scans. Exported for memory-bound tests. */
export const LIFECYCLE_SCAN_CHUNK_BYTES = 64 * 1024;
/**
 * Historical per-record prefix bound used by fixtures/tests. The structural
 * scanner no longer retains a record prefix; it streams with O(1) state and
 * only keeps top-level lifecycle field values after complete JSON grammar validity.
 */
export const LIFECYCLE_RECORD_PREFIX_BYTES = 4 * 1024;

/** Bound captured top-level lifecycle string values (type / toolCallId / toolName). */
const LIFECYCLE_FIELD_VALUE_MAX_CHARS = 1024;
const LIFECYCLE_FIELD_KEY_MAX_CHARS = 64;
const LIFECYCLE_TOP_LEVEL_KEYS = new Set(["type", "toolCallId", "toolName"]);

function emptyLifecycleEvidence(diagnostics: string[] = []): LifecycleEvidence {
    return { sawEnd: false, unmatchedToolCalls: [], complete: false, diagnostics };
}

function applyLifecycleFields(
    fields: { type?: string; toolCallId?: string; toolName?: string },
    openToolCalls: Map<string, UnmatchedToolCall>,
    state: { sawEnd: boolean; anonymousToolCall: number },
): void {
    const type = fields.type;
    if (!type) return;
    if (type === "agent_end" || type === "agent_settled") state.sawEnd = true;

    const toolCallId = fields.toolCallId;
    if (type === "tool_execution_start") {
        const toolName = fields.toolName ?? "unknown";
        openToolCalls.set(toolCallId ?? `anonymous:${state.anonymousToolCall++}`, {
            id: toolCallId,
            toolName,
        });
    }
    if (type === "tool_execution_end") {
        if (toolCallId) {
            openToolCalls.delete(toolCallId);
        } else if (fields.toolName) {
            const matching = [...openToolCalls].find(([, call]) => call.toolName === fields.toolName);
            if (matching) openToolCalls.delete(matching[0]);
        }
    }
}

function unescapeJsonStringContent(raw: string): string | null {
    try {
        return JSON.parse(`"${raw}"`) as string;
    } catch {
        return null;
    }
}

/** Fail closed on pathological nesting; keeps container-stack memory bounded. */
const LIFECYCLE_JSON_MAX_DEPTH = 1024;

type JsonContainer = "object" | "array";
/**
 * Grammar expectation inside the current container.
 * - objectKeyOrEnd: after `{` — `"key"` or `}`
 * - objectKey: after `,` in object — `"key"` required (trailing comma invalid)
 * - objectColon: after key — `:`
 * - value: expecting any JSON value
 * - valueOrEnd: after `[` — value or `]`
 * - commaOrEnd: after a value — `,` or container end
 */
type JsonExpect =
    | "objectKeyOrEnd"
    | "objectKey"
    | "objectColon"
    | "value"
    | "valueOrEnd"
    | "commaOrEnd";

type NumberState =
    | "start"
    | "minus"
    | "int"
    | "intZero"
    | "fracDot"
    | "frac"
    | "expE"
    | "expSign"
    | "expDigit";

type PrimitiveKind = "true" | "false" | "null" | "number";

/**
 * Bounded streaming JSON-grammar scanner for one NDJSON object record.
 * Validates complete JSON grammar (trailing commas, delimiter matching,
 * primitives, escapes) without retaining payloads. Lifecycle fields are
 * collected only for depth-1 keys and applied only after the whole record
 * is grammar-valid.
 */
interface StructuralRecordScan {
    /** Stack of open containers; length is current depth. */
    containers: JsonContainer[];
    expect: JsonExpect;
    inString: boolean;
    /** True when the active string is an object key (not a value). */
    stringIsKey: boolean;
    /**
     * Escape state inside a string:
     * 0 = normal, 1 = saw backslash, 2..5 = collecting \uXXXX (2 + digitsSeen).
     */
    escapeMode: number;
    inPrimitive: boolean;
    primitiveKind: PrimitiveKind | null;
    /** Matched keyword length so far. */
    primitiveIndex: number;
    numberState: NumberState;
    started: boolean;
    finished: boolean;
    malformed: boolean;
    skipLine: boolean;
    currentKey: string | null;
    capturingKey: boolean;
    keyBuf: string;
    capturingValue: boolean;
    valueBuf: string;
    type?: string;
    toolCallId?: string;
    toolName?: string;
    /** Semantic lifecycle keys already observed at depth 1 (decoded). */
    seenLifecycleKeys: Set<string>;
}

function createStructuralRecordScan(): StructuralRecordScan {
    return {
        containers: [],
        expect: "value",
        inString: false,
        stringIsKey: false,
        escapeMode: 0,
        inPrimitive: false,
        primitiveKind: null,
        primitiveIndex: 0,
        numberState: "start",
        started: false,
        finished: false,
        malformed: false,
        skipLine: false,
        currentKey: null,
        capturingKey: false,
        keyBuf: "",
        capturingValue: false,
        valueBuf: "",
        seenLifecycleKeys: new Set(),
    };
}

function depthOf(scan: StructuralRecordScan): number {
    return scan.containers.length;
}

function markMalformed(scan: StructuralRecordScan): void {
    scan.malformed = true;
}

/**
 * Decode a captured object-key buffer (escape sequences already retained as
 * JSON source fragments) into its semantic string. Returns null on bad escapes.
 */
function decodeCapturedKey(raw: string): string | null {
    return unescapeJsonStringContent(raw);
}

/**
 * Record a top-level lifecycle key. Duplicate semantic keys (including escaped
 * equivalent spellings) fail the record closed — no field evidence from an
 * ambiguous record may authorize terminal/tool balance.
 */
function noteTopLevelLifecycleKey(scan: StructuralRecordScan, decodedKey: string): void {
    if (!LIFECYCLE_TOP_LEVEL_KEYS.has(decodedKey)) return;
    if (scan.seenLifecycleKeys.has(decodedKey)) {
        markMalformed(scan);
        return;
    }
    scan.seenLifecycleKeys.add(decodedKey);
}

function assignTopLevelLifecycleValue(scan: StructuralRecordScan): void {
    const key = scan.currentKey;
    if (!key || !LIFECYCLE_TOP_LEVEL_KEYS.has(key)) return;
    // Duplicates are rejected when the key is observed; defensive guard here.
    if (!scan.seenLifecycleKeys.has(key)) {
        markMalformed(scan);
        return;
    }
    const value = unescapeJsonStringContent(scan.valueBuf);
    if (value === null) {
        markMalformed(scan);
        return;
    }
    if (key === "type") scan.type = value;
    else if (key === "toolCallId") scan.toolCallId = value;
    else if (key === "toolName") scan.toolName = value;
}

function appendCaptured(scan: StructuralRecordScan, chunk: string): void {
    if (scan.capturingKey && scan.keyBuf.length < LIFECYCLE_FIELD_KEY_MAX_CHARS) {
        scan.keyBuf += chunk;
    } else if (scan.capturingValue && scan.valueBuf.length < LIFECYCLE_FIELD_VALUE_MAX_CHARS) {
        scan.valueBuf += chunk;
    }
}

function finishPrimitive(scan: StructuralRecordScan): boolean {
    if (!scan.inPrimitive || !scan.primitiveKind) return false;
    if (scan.primitiveKind === "number") {
        // Number must end on a complete state (not after bare '-', '.', 'e', or sign).
        if (
            scan.numberState === "minus" ||
            scan.numberState === "fracDot" ||
            scan.numberState === "expE" ||
            scan.numberState === "expSign" ||
            scan.numberState === "start"
        ) {
            markMalformed(scan);
            return false;
        }
    } else {
        const expected =
            scan.primitiveKind === "true" ? 4 : scan.primitiveKind === "false" ? 5 : 4;
        if (scan.primitiveIndex !== expected) {
            markMalformed(scan);
            return false;
        }
    }
    scan.inPrimitive = false;
    scan.primitiveKind = null;
    scan.primitiveIndex = 0;
    scan.numberState = "start";
    scan.expect = "commaOrEnd";
    scan.currentKey = null;
    return true;
}

function startPrimitive(scan: StructuralRecordScan, ch: string): void {
    scan.inPrimitive = true;
    scan.primitiveIndex = 1;
    if (ch === "t") {
        scan.primitiveKind = "true";
        return;
    }
    if (ch === "f") {
        scan.primitiveKind = "false";
        return;
    }
    if (ch === "n") {
        scan.primitiveKind = "null";
        return;
    }
    // number
    scan.primitiveKind = "number";
    if (ch === "-") {
        scan.numberState = "minus";
        return;
    }
    if (ch === "0") {
        scan.numberState = "intZero";
        return;
    }
    if (ch >= "1" && ch <= "9") {
        scan.numberState = "int";
        return;
    }
    markMalformed(scan);
}

function feedPrimitiveChar(scan: StructuralRecordScan, ch: string): void {
    if (!scan.primitiveKind) {
        markMalformed(scan);
        return;
    }
    if (scan.primitiveKind !== "number") {
        const target =
            scan.primitiveKind === "true" ? "true" : scan.primitiveKind === "false" ? "false" : "null";
        if (scan.primitiveIndex >= target.length || ch !== target[scan.primitiveIndex]) {
            markMalformed(scan);
            return;
        }
        scan.primitiveIndex++;
        return;
    }

    // Streaming number grammar (JSON).
    switch (scan.numberState) {
        case "minus":
            if (ch === "0") {
                scan.numberState = "intZero";
                return;
            }
            if (ch >= "1" && ch <= "9") {
                scan.numberState = "int";
                return;
            }
            markMalformed(scan);
            return;
        case "intZero":
            // Leading zero may only be followed by fraction/exponent, not more digits.
            if (ch === ".") {
                scan.numberState = "fracDot";
                return;
            }
            if (ch === "e" || ch === "E") {
                scan.numberState = "expE";
                return;
            }
            markMalformed(scan);
            return;
        case "int":
            if (ch >= "0" && ch <= "9") return;
            if (ch === ".") {
                scan.numberState = "fracDot";
                return;
            }
            if (ch === "e" || ch === "E") {
                scan.numberState = "expE";
                return;
            }
            markMalformed(scan);
            return;
        case "fracDot":
            if (ch >= "0" && ch <= "9") {
                scan.numberState = "frac";
                return;
            }
            markMalformed(scan);
            return;
        case "frac":
            if (ch >= "0" && ch <= "9") return;
            if (ch === "e" || ch === "E") {
                scan.numberState = "expE";
                return;
            }
            markMalformed(scan);
            return;
        case "expE":
            if (ch === "+" || ch === "-") {
                scan.numberState = "expSign";
                return;
            }
            if (ch >= "0" && ch <= "9") {
                scan.numberState = "expDigit";
                return;
            }
            markMalformed(scan);
            return;
        case "expSign":
            if (ch >= "0" && ch <= "9") {
                scan.numberState = "expDigit";
                return;
            }
            markMalformed(scan);
            return;
        case "expDigit":
            if (ch >= "0" && ch <= "9") return;
            markMalformed(scan);
            return;
        default:
            markMalformed(scan);
    }
}

function isValueStartChar(ch: string): boolean {
    return (
        ch === "\"" ||
        ch === "{" ||
        ch === "[" ||
        ch === "t" ||
        ch === "f" ||
        ch === "n" ||
        ch === "-" ||
        (ch >= "0" && ch <= "9")
    );
}

function canStartValue(scan: StructuralRecordScan): boolean {
    return scan.expect === "value" || scan.expect === "valueOrEnd";
}

function afterValueClosed(scan: StructuralRecordScan): void {
    scan.expect = "commaOrEnd";
    scan.currentKey = null;
}

function pushContainer(scan: StructuralRecordScan, kind: JsonContainer): void {
    if (scan.containers.length >= LIFECYCLE_JSON_MAX_DEPTH) {
        markMalformed(scan);
        return;
    }
    scan.containers.push(kind);
    scan.expect = kind === "object" ? "objectKeyOrEnd" : "valueOrEnd";
    scan.currentKey = null;
}

function popContainer(scan: StructuralRecordScan, kind: JsonContainer): void {
    if (scan.containers.length === 0 || scan.containers[scan.containers.length - 1] !== kind) {
        markMalformed(scan);
        return;
    }
    scan.containers.pop();
    if (scan.containers.length === 0) {
        scan.finished = true;
        scan.expect = "commaOrEnd";
        return;
    }
    afterValueClosed(scan);
}

function feedStructuralRecordChar(scan: StructuralRecordScan, ch: string): void {
    if (scan.malformed || scan.finished || scan.skipLine) return;

    // ── String body (including escape grammar) ─────────────────────────────
    if (scan.inString) {
        if (scan.escapeMode >= 2) {
            // Collecting remaining \uXXXX hex digits (escapeMode = 2 + digitsSeen).
            if (!/[0-9a-fA-F]/.test(ch)) {
                markMalformed(scan);
                return;
            }
            appendCaptured(scan, ch);
            scan.escapeMode++;
            // After 4 hex digits escapeMode reaches 6.
            if (scan.escapeMode >= 6) scan.escapeMode = 0;
            return;
        }
        if (scan.escapeMode === 1) {
            // Character immediately after backslash.
            if (ch === "u") {
                appendCaptured(scan, "\\u");
                scan.escapeMode = 2; // need 4 hex digits
                return;
            }
            if (
                ch === "\"" ||
                ch === "\\" ||
                ch === "/" ||
                ch === "b" ||
                ch === "f" ||
                ch === "n" ||
                ch === "r" ||
                ch === "t"
            ) {
                appendCaptured(scan, `\\${ch}`);
                scan.escapeMode = 0;
                return;
            }
            markMalformed(scan);
            return;
        }
        if (ch === "\\") {
            scan.escapeMode = 1;
            return;
        }
        if (ch === "\"") {
            scan.inString = false;
            scan.escapeMode = 0;
            if (scan.stringIsKey) {
                scan.stringIsKey = false;
                if (scan.capturingKey) {
                    scan.capturingKey = false;
                    const decoded = decodeCapturedKey(scan.keyBuf);
                    if (decoded === null) {
                        markMalformed(scan);
                        return;
                    }
                    // Fail closed on duplicate semantic lifecycle keys before any
                    // value is applied (escaped equivalents normalize first).
                    noteTopLevelLifecycleKey(scan, decoded);
                    if (scan.malformed) return;
                    scan.currentKey = decoded;
                } else {
                    scan.currentKey = null;
                }
                scan.expect = "objectColon";
                return;
            }
            if (scan.capturingValue) {
                scan.capturingValue = false;
                assignTopLevelLifecycleValue(scan);
                if (scan.malformed) return;
            }
            afterValueClosed(scan);
            return;
        }
        // Unescaped control characters are invalid JSON.
        if (ch.charCodeAt(0) < 0x20) {
            markMalformed(scan);
            return;
        }
        appendCaptured(scan, ch);
        return;
    }

    // ── Finish primitive on whitespace / delimiter ─────────────────────────
    if (scan.inPrimitive) {
        if (ch === " " || ch === "\t" || ch === "\r") {
            finishPrimitive(scan);
            return;
        }
        if (ch === "," || ch === "}" || ch === "]") {
            if (!finishPrimitive(scan)) return;
            // Fall through to delimiter handling.
        } else {
            feedPrimitiveChar(scan, ch);
            return;
        }
    }

    // ── Insignificant whitespace outside strings/primitives ────────────────
    if (ch === " " || ch === "\t" || ch === "\r") return;

    if (!scan.started) {
        if (ch === "{") {
            scan.started = true;
            pushContainer(scan, "object");
            return;
        }
        // Non-object NDJSON noise — ignore until the next record boundary.
        scan.skipLine = true;
        return;
    }

    // ── Structural tokens ──────────────────────────────────────────────────
    if (ch === "\"") {
        const d = depthOf(scan);
        if (
            d >= 1 &&
            scan.containers[d - 1] === "object" &&
            (scan.expect === "objectKeyOrEnd" || scan.expect === "objectKey")
        ) {
            scan.inString = true;
            scan.stringIsKey = true;
            scan.escapeMode = 0;
            if (d === 1) {
                scan.capturingKey = true;
                scan.keyBuf = "";
            }
            return;
        }
        if (canStartValue(scan)) {
            scan.inString = true;
            scan.stringIsKey = false;
            scan.escapeMode = 0;
            if (
                d === 1 &&
                scan.currentKey !== null &&
                LIFECYCLE_TOP_LEVEL_KEYS.has(scan.currentKey)
            ) {
                scan.capturingValue = true;
                scan.valueBuf = "";
            }
            return;
        }
        markMalformed(scan);
        return;
    }

    if (ch === ":") {
        if (scan.expect !== "objectColon") {
            markMalformed(scan);
            return;
        }
        scan.expect = "value";
        return;
    }

    if (ch === "{") {
        if (!canStartValue(scan)) {
            markMalformed(scan);
            return;
        }
        pushContainer(scan, "object");
        return;
    }

    if (ch === "[") {
        if (!canStartValue(scan)) {
            markMalformed(scan);
            return;
        }
        pushContainer(scan, "array");
        return;
    }

    if (ch === "}") {
        // Valid only for object containers in key-or-end or comma-or-end (not after bare comma).
        if (
            depthOf(scan) === 0 ||
            scan.containers[depthOf(scan) - 1] !== "object" ||
            (scan.expect !== "objectKeyOrEnd" && scan.expect !== "commaOrEnd")
        ) {
            markMalformed(scan);
            return;
        }
        popContainer(scan, "object");
        return;
    }

    if (ch === "]") {
        if (
            depthOf(scan) === 0 ||
            scan.containers[depthOf(scan) - 1] !== "array" ||
            (scan.expect !== "valueOrEnd" && scan.expect !== "commaOrEnd")
        ) {
            markMalformed(scan);
            return;
        }
        popContainer(scan, "array");
        // Top-level arrays are not lifecycle objects (started only on `{`).
        if (depthOf(scan) === 0) {
            markMalformed(scan);
        }
        return;
    }

    if (ch === ",") {
        if (scan.expect !== "commaOrEnd") {
            markMalformed(scan);
            return;
        }
        const cur = scan.containers[depthOf(scan) - 1];
        if (cur === "object") {
            scan.expect = "objectKey"; // key required — trailing comma before } is invalid
            scan.currentKey = null;
            return;
        }
        if (cur === "array") {
            scan.expect = "value"; // value required — trailing comma before ] is invalid
            return;
        }
        markMalformed(scan);
        return;
    }

    // Primitive value start.
    if (canStartValue(scan) && isValueStartChar(ch)) {
        startPrimitive(scan, ch);
        return;
    }

    markMalformed(scan);
}


/**
 * Stream the complete child log for lifecycle authority only.
 * Reads fixed-size chunks and walks each NDJSON record with bounded structural
 * state (no per-record payload retention). Top-level lifecycle fields are applied
 * only after a record is grammar-valid; unfinished/malformed records fail closed.
 */
export function scanLifecycleEvidence(id: string): LifecycleEvidence {
    const path = logPathFor(id);
    let totalBytes = 0;
    try {
        totalBytes = statSync(path).size;
    } catch {
        return emptyLifecycleEvidence(["Lifecycle scan failed: log not found"]);
    }
    if (totalBytes === 0) {
        return { sawEnd: false, unmatchedToolCalls: [], complete: true, diagnostics: [] };
    }

    let fd: number;
    try {
        fd = openSync(path, "r");
    } catch (e) {
        return emptyLifecycleEvidence([`Lifecycle scan failed: open failed: ${(e as Error).message}`]);
    }

    const openToolCalls = new Map<string, UnmatchedToolCall>();
    const state = { sawEnd: false, anonymousToolCall: 0 };
    const diagnostics: string[] = [];
    const buf = Buffer.alloc(Math.min(LIFECYCLE_SCAN_CHUNK_BYTES, totalBytes));
    let offset = 0;
    let complete = true;
    let scan = createStructuralRecordScan();

    const markUntrusted = (msg: string): void => {
        complete = false;
        if (!diagnostics.includes(msg)) diagnostics.push(msg);
    };

    const finishRecord = (): void => {
        if (scan.skipLine || !scan.started) {
            scan = createStructuralRecordScan();
            return;
        }
        if (
            scan.malformed ||
            scan.inString ||
            scan.escapeMode !== 0 ||
            scan.inPrimitive ||
            scan.containers.length !== 0 ||
            !scan.finished
        ) {
            markUntrusted("Lifecycle scan found unfinished or malformed NDJSON record");
            scan = createStructuralRecordScan();
            return;
        }
        // Grammar-valid object: apply only top-level lifecycle ownership.
        applyLifecycleFields(
            {
                type: scan.type,
                toolCallId: scan.toolCallId,
                toolName: scan.toolName,
            },
            openToolCalls,
            state,
        );
        scan = createStructuralRecordScan();
    };

    try {
        while (offset < totalBytes) {
            const toRead = Math.min(buf.length, totalBytes - offset);
            let read = 0;
            try {
                read = readSync(fd, buf, 0, toRead, offset);
            } catch (e) {
                return emptyLifecycleEvidence([
                    `Lifecycle scan failed: read failed: ${(e as Error).message}`,
                ]);
            }
            if (read <= 0) break;
            offset += read;

            // Decode chunk; structural state is O(1) so the chunk string is dropped each loop.
            const chunk = buf.toString("utf-8", 0, read);
            for (let i = 0; i < chunk.length; i++) {
                const ch = chunk[i];
                if (ch === "\n") {
                    finishRecord();
                    continue;
                }
                if (scan.finished) {
                    // Trailing junk after a closed object before newline is malformed.
                    if (ch !== " " && ch !== "\t" && ch !== "\r") {
                        scan.malformed = true;
                    }
                    continue;
                }
                if (scan.skipLine) continue;
                feedStructuralRecordChar(scan, ch);
            }
        }

        // EOF: finalize any record lacking a trailing newline.
        if (scan.started || scan.malformed) {
            finishRecord();
        } else if (scan.skipLine) {
            // Noise-only trailing content without a record — ignore.
        }
    } finally {
        closeSync(fd);
    }

    // Fail closed: any unfinished/malformed record makes the stream untrusted, so
    // terminal lifecycle evidence must not survive even if a later record looked valid.
    return {
        sawEnd: complete ? state.sawEnd : false,
        unmatchedToolCalls: [...openToolCalls.values()],
        complete,
        diagnostics,
    };
}

/** Overlay full-stream lifecycle fields onto a bounded parseRun result. */
export function withLifecycleEvidence(run: ParsedRun, evidence: LifecycleEvidence): ParsedRun {
    const diagnostics = [...run.diagnostics];
    for (const d of evidence.diagnostics) {
        if (!diagnostics.includes(d)) diagnostics.push(d);
    }
    // When the full stream could not be read, refuse clean completion by clearing
    // terminal evidence even if the bounded tail looked coherent.
    if (!evidence.complete) {
        return {
            ...run,
            sawEnd: false,
            unmatchedToolCalls: evidence.unmatchedToolCalls,
            diagnostics,
        };
    }
    return {
        ...run,
        sawEnd: evidence.sawEnd,
        unmatchedToolCalls: evidence.unmatchedToolCalls,
        diagnostics,
    };
}

/** Bounded output parse + authoritative full-stream lifecycle evidence. */
export function parseRunForLifecycle(id: string): ParsedRun {
    return withLifecycleEvidence(parseRun(id), scanLifecycleEvidence(id));
}

// ---- incremental parse state ----------------------------------------------
//
// A run's parsed result is an accumulating fold: `finalText` and `lastActivity`
// are latest-wins, `usage` and `toolCalls` accumulate, `sawEnd` is sticky, and
// open tool calls are a running map. So the whole thing folds forward over
// appended bytes — no re-reading, and no window past which spend stops counting.

/** Event types the fold below consumes. Everything else cannot move a field. */
const PARSE_EVENT_TYPES: ReadonlySet<string> = new Set([
    "agent_end",
    "agent_settled",
    "message_end",
    "turn_end",
    "message_update",
    "tool_execution_start",
    "tool_execution_end",
]);

/** Leading `{"type":"…"` of an NDJSON line, read without parsing it. */
const LEADING_TYPE = /^\s*\{\s*"type"\s*:\s*"([A-Za-z0-9_.-]+)"/;

/** The line's event type when it can be read cheaply, else undefined. */
function peekType(line: string): string | undefined {
    return LEADING_TYPE.exec(line)?.[1];
}

interface ParseState {
    cursor: LogCursor;
    usage: Usage;
    finalText: string;
    lastActivity: string;
    toolCalls: string[];
    openToolCalls: Map<string, UnmatchedToolCall>;
    anonymousToolCall: number;
    sawEnd: boolean;
    /** Bytes were skipped by a bounded cold start on an already-large log. */
    windowTruncated: boolean;
    /** Log size at the last read, for the truncation diagnostic. */
    totalBytes: number;
    /** Any event has ever been folded for this run. */
    sawAnyEvent: boolean;
    error?: string;
}

/** Runs tracked at once; a backstop against unbounded state, not a policy. */
const MAX_TRACKED_PARSE_RUNS = 64;

const parseStates = new Map<string, ParseState>();

/** Forget a run's accumulated parse (or all of them). */
export function resetParseRunCursor(id?: string): void {
    if (id === undefined) parseStates.clear();
    else parseStates.delete(id);
}

function freshState(cursor: LogCursor): ParseState {
    return {
        cursor,
        usage: { input: 0, output: 0, cacheRead: 0, costUSD: 0, total: 0 },
        finalText: "",
        lastActivity: "",
        toolCalls: [],
        openToolCalls: new Map(),
        anonymousToolCall: 0,
        sawEnd: false,
        windowTruncated: false,
        totalBytes: 0,
        sawAnyEvent: false,
    };
}

/** Copy of the accumulated state, for folding an unterminated trailing line. */
function speculativeCopy(state: ParseState): ParseState {
    return {
        ...state,
        usage: { ...state.usage },
        toolCalls: [...state.toolCalls],
        openToolCalls: new Map(state.openToolCalls),
    };
}

function rememberParseState(id: string, state: ParseState): void {
    parseStates.delete(id);
    parseStates.set(id, state);
    while (parseStates.size > MAX_TRACKED_PARSE_RUNS) {
        const oldest = parseStates.keys().next();
        if (oldest.done) break;
        parseStates.delete(oldest.value);
    }
}

/**
 * Which lines of an appended batch must actually be parsed.
 *
 * Every fact-bearing line does, except `message_update` — the high-volume type,
 * ~98% of a log's bytes, whose only contribution is the latest-wins
 * `lastActivity` peek. Within one batch only the LAST update that yields text
 * can survive, so walk back from the end and keep the first that does. Earlier
 * updates are then provably unobservable, and are never parsed at all.
 */
function selectParsableLines(lines: readonly string[]): Array<{ index: number; event: Record<string, unknown> }> {
    const parsed: Array<{ index: number; event: Record<string, unknown> }> = [];
    let liveUpdate: { index: number; event: Record<string, unknown> } | undefined;

    // Backward pass: find the newest message_update that would set lastActivity.
    for (let i = lines.length - 1; i >= 0 && !liveUpdate; i--) {
        const s = lines[i]!.trim();
        if (!s || s[0] !== "{") continue;
        if (peekType(s) !== "message_update") continue;
        const event = tryParse(s);
        if (!event) continue;
        if (activityTextOf(event) !== undefined) liveUpdate = { index: i, event };
    }

    // Forward pass: everything else, in order, so relative ordering is exact.
    for (let i = 0; i < lines.length; i++) {
        if (liveUpdate && i === liveUpdate.index) {
            parsed.push(liveUpdate);
            continue;
        }
        const s = lines[i]!.trim();
        if (!s || s[0] !== "{") continue;
        const type = peekType(s);
        if (type === "message_update") continue; // superseded or textless
        if (type !== undefined && !PARSE_EVENT_TYPES.has(type)) continue;
        const event = tryParse(s);
        if (event) parsed.push({ index: i, event });
    }
    return parsed;
}

function tryParse(line: string): Record<string, unknown> | undefined {
    try {
        return JSON.parse(line) as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

/** The live-progress text a `message_update` contributes, if any. */
function activityTextOf(e: Record<string, unknown>): string | undefined {
    const m = e.message as Msg | undefined;
    const t = messageText(m);
    if (t) return t;
    if (Array.isArray(m?.content)) {
        const think = m!.content.find((b) => b?.type === "thinking") as { thinking?: string } | undefined;
        if (think?.thinking) return `(thinking) ${think.thinking}`;
    }
    return undefined;
}

/** Fold one event into the run's accumulated state. */
function foldParseEvent(state: ParseState, e: Record<string, unknown>): void {
    const type = e.type as string | undefined;
    state.sawAnyEvent = true;

    // Authoritative final answer: the last assistant message at run end.
    if (type === "agent_end") {
        if (Array.isArray(e.messages)) {
            for (let i = e.messages.length - 1; i >= 0; i--) {
                const m = e.messages[i] as Msg;
                if (m?.role === "assistant") { const t = messageText(m); if (t) state.finalText = t; break; }
            }
        }
        state.sawEnd = true;
    }
    if (type === "agent_settled") state.sawEnd = true;

    // Progress signal + fallback final: finalized assistant turns.
    // Accumulate spend from `message_end` only (fires once per turn), so
    // multi-turn tool-using runs sum correctly without double counting.
    if (type === "message_end") {
        const m = e.message as Msg | undefined;
        if (m?.role === "assistant") {
            const t = messageText(m);
            // Latest finalized assistant text wins, so a run without a
            // terminal `agent_end` still yields its LAST answer, not its first.
            if (t) { state.lastActivity = t; state.finalText = t; }
            const u = m?.usage;
            if (u) {
                state.usage.input += u.input ?? 0;
                state.usage.output += u.output ?? 0;
                state.usage.cacheRead += u.cacheRead ?? 0;
                state.usage.costUSD += u.cost?.total ?? 0;
            }
        }
    }
    if (type === "turn_end") {
        const m = e.message as Msg | undefined;
        if (m?.role === "assistant") {
            const t = messageText(m);
            if (t) { state.lastActivity = t; if (!state.finalText) state.finalText = t; }
        }
    }

    // Live streaming: latest partial text or thinking.
    if (type === "message_update") {
        const t = activityTextOf(e);
        if (t) state.lastActivity = t;
    }

    // Tool activity. Pi emits a toolCallId for normal events; fall back to
    // tool-name matching when replaying older/id-less streams.
    const toolCallId = typeof e.toolCallId === "string" ? e.toolCallId : undefined;
    if (type === "tool_execution_start") {
        const toolName = typeof e.toolName === "string" ? e.toolName : "unknown";
        if (state.toolCalls[state.toolCalls.length - 1] !== toolName) state.toolCalls.push(toolName);
        state.openToolCalls.set(toolCallId ?? `anonymous:${state.anonymousToolCall++}`, { id: toolCallId, toolName });
    }
    if (type === "tool_execution_end") {
        if (toolCallId) {
            state.openToolCalls.delete(toolCallId);
        } else if (typeof e.toolName === "string") {
            const matching = [...state.openToolCalls].find(([, call]) => call.toolName === e.toolName);
            if (matching) state.openToolCalls.delete(matching[0]);
        }
    }
}

/**
 * Parse the log for run `id`. Tolerant of partial/streaming logs.
 *
 * Incremental: only bytes appended since the previous call for this id are read
 * and folded, so a live caller never re-reads a log that can reach gigabytes. A
 * rotated, truncated, or rewritten log is detected and re-read from a bounded
 * tail (see log-cursor.ts).
 */
export function parseRun(id: string): ParsedRun {
    const previous = parseStates.get(id);
    const read = readAppendedLines(logPathFor(id), previous?.cursor, maxParseBytes());
    const state = read.restarted || !previous ? freshState(read.cursor) : previous;
    state.cursor = read.cursor;
    if (read.totalBytes > 0) state.totalBytes = read.totalBytes;
    if (read.truncated) state.windowTruncated = true;
    state.error = read.error;
    rememberParseState(id, state);

    if (read.error !== undefined) {
        return {
            finalText: "", lastActivity: "", toolCalls: [], unmatchedToolCalls: [], sawEnd: false,
            usage: { input: 0, output: 0, cacheRead: 0, costUSD: 0, total: 0 },
            diagnostics: [`Log unreadable: ${read.error}`],
        };
    }

    for (const { event } of selectParsableLines(read.lines)) foldParseEvent(state, event);

    // A log whose final line was never terminated — a writer mid-event, or one
    // that simply did not end with a newline — still has to be readable. Fold it
    // into a COPY: the cursor has not consumed those bytes, so the same line
    // will arrive again as a complete line, and folding it durably here would
    // double-count its spend.
    const view = read.partial ? speculativeCopy(state) : state;
    if (read.partial) {
        for (const { event } of selectParsableLines([read.partial])) foldParseEvent(view, event);
    }

    const diagnostics: string[] = [];
    if (view.windowTruncated) {
        diagnostics.push(
            `Log truncated: this session began reading at the last ${fmtBytes(maxParseBytes())} ` +
            `of ${fmtBytes(view.totalBytes)}. Events before that point are not counted in tokens/tools.`,
        );
    }
    if (!view.sawAnyEvent) {
        if (view.totalBytes === 0) {
            return {
                finalText: "", lastActivity: "", toolCalls: [], unmatchedToolCalls: [], sawEnd: false,
                usage: { input: 0, output: 0, cacheRead: 0, costUSD: 0, total: 0 }, diagnostics: [],
            };
        }
        diagnostics.push("No parseable assistant/tool events found in the log tail.");
    }

    const usage: Usage = { ...view.usage, total: view.usage.input + view.usage.output };
    return {
        finalText: view.finalText,
        lastActivity: view.lastActivity,
        toolCalls: [...view.toolCalls],
        unmatchedToolCalls: [...view.openToolCalls.values()],
        sawEnd: view.sawEnd,
        usage,
        diagnostics,
    };
}

/** Build the human-readable body for subagent_output. Exported for unit testing. */
export function formatSubagentOutputBody(
    head: string,
    tools: string,
    parsedBody: string | undefined,
    rawTail: string,
    diagnostics: string[],
): string {
    let body: string;
    if (parsedBody) {
        body = parsedBody;
    } else {
        body = rawTail === "(no output yet)"
            ? "(no output yet)"
            : `(no parsed output yet)\n\n--- raw log tail ---\n${rawTail}`;
    }
    const diag = diagnostics.length ? `\n[parser: ${diagnostics.join("; ")}]` : "";
    return `${head}${tools}${diag}\n${body}`;
}

/** Build the human-readable body for subagent_result. Exported for unit testing. */
export function formatSubagentResultBody(
    head: string,
    finalText: string | undefined,
    rawTail: string,
    diagnostics: string[],
): string {
    let body = finalText || `(no final answer parsed)\n\n--- raw log tail ---\n${rawTail}`;
    const diag = diagnostics.length ? `\n[parser: ${diagnostics.join("; ")}]` : "";
    return `${head}${diag}\n${body}`;
}
