import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";

export interface TailRead {
  text: string;
  truncated: boolean;
  totalBytes: number;
  error?: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read no more than `maxBytes` from a file's end. This avoids whole-file
 * allocation for live logs that can grow past Node's string-size limit.
 */
export function readBoundedTail(path: string, maxBytes: number): TailRead {
  const budget = Math.max(1, Math.floor(maxBytes));
  let totalBytes: number;
  try {
    totalBytes = statSync(path).size;
  } catch (error) {
    return { text: "", truncated: false, totalBytes: 0, error: errorText(error) };
  }
  if (totalBytes === 0) return { text: "", truncated: false, totalBytes };
  if (totalBytes <= budget) {
    try {
      return { text: readFileSync(path, "utf8"), truncated: false, totalBytes };
    } catch (error) {
      return { text: "", truncated: false, totalBytes, error: errorText(error) };
    }
  }

  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(budget);
    const start = totalBytes - budget;
    let offset = 0;
    while (offset < budget) {
      const read = readSync(fd, buffer, offset, budget - offset, start + offset);
      if (read <= 0) break;
      offset += read;
    }
    return { text: buffer.toString("utf8", 0, offset), truncated: true, totalBytes };
  } catch (error) {
    return { text: "", truncated: true, totalBytes, error: errorText(error) };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

/**
 * Convert terminal-like output into display rows. A bare carriage return is a
 * cursor reset, so repeated progress redraws collapse to their latest state;
 * CRLF remains a normal newline. Individual rows are capped defensively.
 */
export function terminalDisplayRows(text: string, maxRowChars = 8 * 1024): string[] {
  const rowLimit = Math.max(64, Math.floor(maxRowChars));
  const rows: string[] = [];
  let current = "";
  let progress = "";

  const append = (value: string) => {
    current += value;
    if (current.length > rowLimit) current = `...${current.slice(-(rowLimit - 3))}`;
  };
  const emit = () => {
    const value = current || progress;
    if (value) rows.push(value);
    current = "";
    progress = "";
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === "\r") {
      if (text[i + 1] === "\n") {
        emit();
        i += 1;
      } else {
        progress = current || progress;
        current = "";
      }
    } else if (char === "\n") {
      emit();
    } else {
      append(char);
    }
  }
  const final = current || progress;
  if (final) rows.push(final);
  return rows;
}

export function tailTerminalDisplay(text: string, rows: number, maxRowChars?: number): string {
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
} as const;

/** Documented hard caps. Explicit larger pages are allowed up to these values. */
export const OUTPUT_BUDGET_MAX_BYTES = {
  status: 2 * 1024,
  answer: 8 * 1024,
  log: 4 * 1024,
  list: 4 * 1024,
  callbackBatch: 8 * 1024,
  rawPage: 64 * 1024,
} as const;

export const OUTPUT_PAGE_DEFAULTS = {
  logLines: 10,
  listEntries: 10,
} as const;

export type OutputBudgetSurface = keyof typeof OUTPUT_BUDGET_BYTES;

export type PageReset = "stale-cursor" | "source-replaced" | "compacted";
export type EvidenceGapKind = "capture" | "retention" | "read";
export type StatusChange = "none" | "failure" | "content" | "reset";
export type EnvelopeSectionName =
  | "identity"
  | "failure"
  | "decision"
  | "diagnostics"
  | "verbatim"
  | "progress";

export interface EvidenceGap {
  kind: EvidenceGapKind;
  bytes?: number;
  detail?: string;
}

export interface PageRequest {
  cursor?: string;
  /** UTF-8 byte budget for this page. Nonpositive/NaN fall back to the API default. */
  maxBytes?: number;
  /** Optional line cap. Pages still make forward progress on a single huge line. */
  maxLines?: number;
}

export interface PageResult {
  text: string;
  revision: string;
  /** Caller-owned cursor that reproduces this page with the same maxBytes. */
  cursor: string;
  /** Start of the following page, or the snapshot end (append-ready when hasMore is false). */
  nextCursor: string;
  hasMore: boolean;
  /** Readable bytes after this page within the current snapshot. */
  omittedBytes: number;
  totalBytes: number;
  startByte: number;
  endByte: number;
  reset?: PageReset;
  gaps: EvidenceGap[];
}

export interface FilePageRequest extends PageRequest {
  /** Stable resource id bound into the cursor (task/run id). Defaults to path. */
  resource?: string;
  /**
   * Consumer-owned generation. Increment on replacement or same-inode
   * compaction so a compatible head cannot hide a rewrite.
   */
  generation?: number | string;
  /** Bytes permanently discarded by retention before the current file bytes. */
  discardedBytes?: number;
  /** Bytes never written because capture overflowed. */
  captureGaps?: Array<{ bytes: number; detail?: string }>;
  /** Pin pagination to this many leading bytes; defaults to the size at first read. */
  snapshotBytes?: number;
}

export interface VerbatimPage {
  text: string;
  hasMore: boolean;
  nextCursor?: string;
  omittedBytes: number;
  revision?: string;
  reset?: PageReset;
  gaps?: EvidenceGap[];
  totalBytes?: number;
  startByte?: number;
  endByte?: number;
}

export interface EnvelopeSections {
  identity?: string;
  failure?: string;
  decision?: string;
  diagnostics?: string;
  progress?: string;
}

export interface EnvelopeOmission {
  section: EnvelopeSectionName | string;
  omittedBytes: number;
}

export interface AssembledEnvelope {
  text: string;
  byteLength: number;
  truncated: boolean;
  omitted: EnvelopeOmission[];
  verbatim?: VerbatimPage;
  continuation?: string;
  gaps: EvidenceGap[];
}

export interface StatusRevisionInput {
  cursor?: string;
  resource: string;
  contentRevision: string;
  failureRevision: string;
}

export interface StatusRevisionResult {
  change: StatusChange;
  reset?: PageReset;
  revision: string;
  nextCursor: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });
const CURSOR_PREFIX = "p1.";
const HEAD_SAMPLE_BYTES = 256;
const NEWLINE = 0x0a;

interface CursorPayload {
  k: "t" | "f" | "s";
  r?: string;
  v?: string;
  o?: number;
  n?: number;
  g?: string;
  i?: string;
  h?: string;
  hl?: number;
  c?: string;
  f?: string;
  a?: 1;
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.max(1, Math.floor(n));
}

/** Nonpositive, NaN, and non-numeric inputs fall back; callers may request a lower budget. */
export function clampBudgetBytes(value: unknown, fallback: number): number {
  return positiveInt(value) ?? positiveInt(fallback) ?? 1;
}

/** Surface default, or a caller request clamped to the documented hard cap. */
export function budgetFor(surface: OutputBudgetSurface, requested?: unknown): number {
  const fallback = OUTPUT_BUDGET_BYTES[surface];
  const cap = OUTPUT_BUDGET_MAX_BYTES[surface];
  const n = positiveInt(requested);
  if (n === undefined) return fallback;
  return Math.min(n, cap);
}

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function sequenceLength(lead: number): number {
  if (lead <= 0x7f) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 1;
}

function completeEnd(bytes: Uint8Array, from: number, to: number): number {
  const length = bytes.length;
  if (to <= from) return from;
  if (to >= length) return length;
  let seqStart = to - 1;
  while (seqStart > from && isContinuation(bytes[seqStart]!)) seqStart -= 1;
  if (isContinuation(bytes[seqStart]!)) return to;
  const needed = sequenceLength(bytes[seqStart]!);
  return seqStart + needed > to ? seqStart : to;
}

function nextCodepointEnd(bytes: Uint8Array, from: number): number {
  if (from >= bytes.length) return from;
  return Math.min(bytes.length, from + sequenceLength(bytes[from]!));
}

function alignStart(bytes: Uint8Array, start: number): number {
  if (start <= 0) return 0;
  if (start >= bytes.length) return bytes.length;
  let i = start;
  while (i < bytes.length && isContinuation(bytes[i]!)) i += 1;
  return i;
}

function sliceUtf8Range(
  bytes: Uint8Array,
  start: number,
  maxBytes: number,
  preferNewline: boolean,
): { start: number; end: number } {
  const from = alignStart(bytes, start);
  if (from >= bytes.length) return { start: from, end: from };
  const budget = Math.max(0, Math.floor(maxBytes));
  let to = completeEnd(bytes, from, Math.min(bytes.length, from + budget));
  if (to <= from) to = nextCodepointEnd(bytes, from);
  // Prefer a newline only when this slice is truncated. If the remainder fits,
  // keep a final line that has no trailing newline — otherwise a one-page
  // answer is missing its last line and reconstruction needs a second page.
  if (preferNewline && to > from && to < bytes.length) {
    for (let i = to - 1; i >= from; i -= 1) {
      if (bytes[i] === NEWLINE) {
        to = i + 1;
        break;
      }
    }
  }
  return { start: from, end: to };
}

export function sliceUtf8Bytes(
  text: string,
  startByte: number,
  maxBytes: number,
  preferNewline = true,
): { text: string; startByte: number; endByte: number; bytes: number } {
  const encoded = encoder.encode(text);
  const range = sliceUtf8Range(encoded, startByte, maxBytes, preferNewline);
  return {
    text: decoder.decode(encoded.subarray(range.start, range.end)),
    startByte: range.start,
    endByte: range.end,
    bytes: range.end - range.start,
  };
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64url");
}

function encodeCursor(payload: CursorPayload): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): CursorPayload | undefined {
  if (!cursor || !cursor.startsWith(CURSOR_PREFIX)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8")) as CursorPayload;
    if (parsed?.k === "t" || parsed?.k === "f" || parsed?.k === "s") return parsed;
  } catch {
    return undefined;
  }
  return undefined;
}

export function cursorKind(cursor: string | undefined): "t" | "f" | "s" | undefined {
  return decodeCursor(cursor)?.k;
}

function headMatches(previousHash: string | undefined, previousLength: number | undefined, current: string): boolean {
  if (!previousHash) return true;
  const length = Math.max(0, previousLength ?? 0);
  const prefix = current.slice(0, length);
  return hashBytes(Buffer.from(prefix, "latin1")) === previousHash;
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const n = readSync(fd, buffer, filled, length - filled, position + filled);
    if (n <= 0) break;
    filled += n;
  }
  return filled === length ? buffer : buffer.subarray(0, filled);
}

function singleLine(value: string): string {
  return value.replace(/[\r\n\x00-\x1f\x7f]/g, " ").trim();
}

function emptyPage(overrides: Partial<PageResult> & Pick<PageResult, "revision" | "cursor" | "nextCursor">): PageResult {
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
 */
export function pageVerbatimText(text: string, request: PageRequest = {}): PageResult {
  const maxBytes = budgetFor("answer", request.maxBytes);
  const encoded = encoder.encode(text);
  const revision = hashBytes(encoded);
  let offset = 0;
  let reset: PageReset | undefined;
  const parsed = decodeCursor(request.cursor);
  if (request.cursor) {
    if (!parsed || parsed.k !== "t") {
      reset = "stale-cursor";
    } else if (parsed.v !== revision) {
      reset = "source-replaced";
    } else {
      offset = Math.max(0, Math.floor(parsed.o ?? 0));
    }
  }
  const make = (start: number, end: number, more: boolean): PageResult => {
    const payload = (o: number, append: boolean): CursorPayload => ({
      k: "t",
      v: revision,
      o,
      n: encoded.length,
      ...(append ? { a: 1 } : {}),
    });
    return {
      text: decoder.decode(encoded.subarray(start, end)),
      revision,
      cursor: encodeCursor(payload(start, false)),
      nextCursor: encodeCursor(payload(end, end >= encoded.length)),
      hasMore: more,
      omittedBytes: Math.max(0, encoded.length - end),
      totalBytes: encoded.length,
      startByte: start,
      endByte: end,
      ...(reset ? { reset } : {}),
      gaps: [],
    };
  };
  if (offset >= encoded.length) return make(encoded.length, encoded.length, false);
  const range = sliceUtf8Range(encoded, offset, maxBytes, true);
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
  return make(range.start, end, end < encoded.length);
}

function fileGaps(request: FilePageRequest): EvidenceGap[] {
  const gaps: EvidenceGap[] = [];
  const discarded = request.discardedBytes;
  if (typeof discarded === "number" && Number.isFinite(discarded) && discarded > 0) {
    gaps.push({
      kind: "retention",
      bytes: Math.floor(discarded),
      detail: "older retained bytes discarded",
    });
  }
  for (const gap of request.captureGaps ?? []) {
    if (!Number.isFinite(gap.bytes) || gap.bytes <= 0) continue;
    gaps.push({ kind: "capture", bytes: Math.floor(gap.bytes), detail: gap.detail });
  }
  return gaps;
}

function inodeKey(dev: number, ino: number): string {
  return `${dev}:${ino}`;
}

function fileRevision(generation: string | undefined, inode: string, snapshot: number): string {
  return `${generation ?? ""}|${inode}|${snapshot}`;
}

function fileReadError(
  request: FilePageRequest,
  path: string,
  error: unknown,
  reset?: PageReset,
): PageResult {
  const resource = request.resource ?? path;
  const cursor = encodeCursor({ k: "f", r: resource, o: 0, n: 0 });
  return emptyPage({
    revision: "unreadable",
    cursor,
    nextCursor: encodeCursor({ k: "f", r: resource, o: 0, n: 0, a: 1 }),
    gaps: [...fileGaps(request), { kind: "read", detail: errorText(error) }],
    ...(reset ? { reset } : {}),
  });
}

/**
 * Page retained file bytes without skipping unread ranges. Snapshot high-water
 * marks keep a page stable while the file appends; consumer `generation` plus
 * inode/head checks disclose replacement and same-inode compaction.
 */
export function pageRetainedFile(path: string, request: FilePageRequest = {}): PageResult {
  const maxBytes = budgetFor("rawPage", request.maxBytes);
  const resource = request.resource ?? path;
  const generation = request.generation === undefined ? undefined : String(request.generation);
  const suppliedGaps = fileGaps(request);
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    return fileReadError(request, path, error, request.cursor ? "source-replaced" : undefined);
  }
  const opened = fd;
  try {
    const stats = fstatSync(opened);
    const size = stats.size;
    const inode = inodeKey(stats.dev, stats.ino);
    const head = readAt(opened, 0, Math.min(HEAD_SAMPLE_BYTES, size)).toString("latin1");
    const parsed = decodeCursor(request.cursor);
    let reset: PageReset | undefined;
    let offset = 0;
    let snapshot = Math.min(size, request.snapshotBytes !== undefined
      ? clampBudgetBytes(request.snapshotBytes, size)
      : size);
    let appendReady = false;

    if (request.cursor) {
      const identityOk = parsed?.k === "f"
        && parsed.r === resource
        && (generation === undefined || parsed.g === generation)
        && parsed.i === inode
        && headMatches(parsed.h, parsed.hl, head)
        && (parsed.n ?? 0) <= size
        && (parsed.o ?? 0) <= size;
      if (!parsed || parsed.k !== "f" || parsed.r !== resource) {
        reset = "stale-cursor";
      } else if (!identityOk) {
        reset = parsed.i !== inode ? "source-replaced" : "compacted";
      } else {
        offset = Math.max(0, Math.floor(parsed.o ?? 0));
        snapshot = Math.max(0, Math.floor(parsed.n ?? snapshot));
        appendReady = parsed.a === 1;
      }
    }

    if (reset) {
      offset = 0;
      snapshot = Math.min(size, request.snapshotBytes !== undefined
        ? clampBudgetBytes(request.snapshotBytes, size)
        : size);
      appendReady = false;
    }

    if (appendReady && offset >= snapshot && size > snapshot) {
      snapshot = Math.min(size, request.snapshotBytes !== undefined
        ? clampBudgetBytes(request.snapshotBytes, size)
        : size);
      appendReady = false;
    }

    const revision = fileRevision(generation, inode, snapshot);
    const payload = (o: number, n: number, append: boolean): CursorPayload => ({
      k: "f",
      r: resource,
      o,
      n,
      g: generation,
      i: inode,
      h: hashBytes(Buffer.from(head, "latin1")),
      hl: head.length,
      ...(append ? { a: 1 } : {}),
    });

    if (size === 0) {
      return emptyPage({
        revision,
        cursor: encodeCursor(payload(0, 0, false)),
        nextCursor: encodeCursor(payload(0, 0, true)),
        totalBytes: 0,
        gaps: suppliedGaps,
        ...(reset ? { reset } : {}),
      });
    }

    if (offset > snapshot) offset = snapshot;
    if (appendReady || offset >= snapshot) {
      return emptyPage({
        revision,
        cursor: encodeCursor(payload(snapshot, snapshot, false)),
        nextCursor: encodeCursor(payload(snapshot, snapshot, true)),
        totalBytes: snapshot,
        startByte: snapshot,
        endByte: snapshot,
        gaps: suppliedGaps,
        ...(reset ? { reset } : {}),
      });
    }

    const length = Math.min(maxBytes + 4, snapshot - offset);
    const buffer = readAt(opened, offset, length);
    const range = sliceUtf8Range(buffer, 0, Math.min(maxBytes, snapshot - offset), true);
    let end = offset + range.end;
    if (end > snapshot) end = snapshot;
    if (end <= offset && offset < snapshot) {
      const forced = Math.min(snapshot, offset + sequenceLength(buffer[0] ?? 0));
      end = Math.max(offset + 1, forced);
    }
    const slice = readAt(opened, offset, end - offset);
    const atEnd = end >= snapshot;
    return {
      text: decoder.decode(slice),
      revision,
      cursor: encodeCursor(payload(offset, snapshot, false)),
      nextCursor: encodeCursor(payload(end, snapshot, atEnd)),
      hasMore: end < snapshot,
      omittedBytes: Math.max(0, snapshot - end),
      totalBytes: snapshot,
      startByte: offset,
      endByte: end,
      gaps: suppliedGaps,
      ...(reset ? { reset } : {}),
    };
  } catch (error) {
    return fileReadError(request, path, error, request.cursor ? "source-replaced" : undefined);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function statusRevisionToken(contentRevision: string, failureRevision: string): string {
  return hashBytes(encoder.encode(`${contentRevision}\0${failureRevision}`));
}

/**
 * Compare a caller-owned status cursor to the current content and failure
 * revisions. Failure-only changes are distinct from log-byte changes; nothing
 * is consumed globally.
 */
export function inspectStatusRevision(input: StatusRevisionInput): StatusRevisionResult {
  const revision = statusRevisionToken(input.contentRevision, input.failureRevision);
  const nextCursor = encodeCursor({
    k: "s",
    r: input.resource,
    c: input.contentRevision,
    f: input.failureRevision,
  });
  const parsed = decodeCursor(input.cursor);
  if (!input.cursor) return { change: "content", revision, nextCursor };
  if (!parsed || parsed.k !== "s" || parsed.r !== input.resource) {
    return { change: "reset", reset: "stale-cursor", revision, nextCursor };
  }
  const contentSame = parsed.c === input.contentRevision;
  const failureSame = parsed.f === input.failureRevision;
  if (contentSame && failureSame) return { change: "none", revision, nextCursor };
  if (contentSame && !failureSame) return { change: "failure", revision, nextCursor };
  return { change: "content", revision, nextCursor };
}

export function formatUnchangedEvidence(cursor: string): string {
  return `No new evidence since cursor ${cursor}.`;
}

function joinParts(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part && part.length > 0)).join("\n");
}

function clipPrefix(text: string, maxBytes: number): { text: string; omittedBytes: number } {
  const total = utf8ByteLength(text);
  if (total <= maxBytes) return { text, omittedBytes: 0 };
  const slice = sliceUtf8Bytes(text, 0, maxBytes, true);
  return { text: slice.text, omittedBytes: total - slice.bytes };
}

function fitSections(
  items: Array<{ name: EnvelopeSectionName; text: string | undefined }>,
  budget: number,
): { text: string; omitted: EnvelopeOmission[] } {
  const omitted: EnvelopeOmission[] = [];
  const included: string[] = [];
  let used = 0;
  let clipping = false;
  for (const item of items) {
    if (!item.text) continue;
    const size = utf8ByteLength(item.text);
    if (clipping) {
      omitted.push({ section: item.name, omittedBytes: size });
      continue;
    }
    const sep = included.length > 0 ? 1 : 0;
    if (used + sep + size <= budget) {
      included.push(item.text);
      used += sep + size;
      continue;
    }
    const room = budget - used - sep;
    if (room > 0) {
      const clipped = clipPrefix(item.text, room);
      if (clipped.text) {
        included.push(clipped.text);
        used += sep + utf8ByteLength(clipped.text);
      }
      if (clipped.omittedBytes > 0) omitted.push({ section: item.name, omittedBytes: clipped.omittedBytes });
    } else {
      omitted.push({ section: item.name, omittedBytes: size });
    }
    clipping = true;
  }
  return { text: included.join("\n"), omitted };
}

function formatContinuation(info: {
  hasMore: boolean;
  omittedBytes: number;
  nextCursor?: string;
  reset?: PageReset;
  gaps: EvidenceGap[];
  omitted: EnvelopeOmission[];
}): string | undefined {
  const lines: string[] = [];
  if (info.reset) lines.push(`reset=${info.reset}`);
  if (info.hasMore || info.omittedBytes > 0) {
    const cursor = info.nextCursor ? ` nextCursor=${info.nextCursor}` : "";
    lines.push(`hasMore=${info.hasMore} omittedBytes=${info.omittedBytes}${cursor}`);
  }
  for (const gap of info.gaps) {
    const bytes = gap.bytes !== undefined ? ` bytes=${gap.bytes}` : "";
    const detail = gap.detail ? ` detail=${singleLine(gap.detail)}` : "";
    lines.push(`gap ${gap.kind}${bytes}${detail}`);
  }
  for (const item of info.omitted) {
    lines.push(`omitted ${item.section} bytes=${item.omittedBytes}`);
  }
  if (lines.length === 0) return undefined;
  return ["---", ...lines].join("\n");
}

/**
 * Assemble one model-facing payload under a total UTF-8 byte cap.
 *
 * Consumers must page verbatim answers/logs from the budget passed to
 * `verbatim` rather than from the surface cap. The assembler measures
 * identity/failure/decision/diagnostics first, reserves continuation
 * metadata, then hands the remainder to `verbatim`, so headers never clip
 * already-sliced answer bytes. Reconstructing those pages still concatenates
 * to the original source; pages are merely smaller.
 */
export function assemblePriorityEnvelope(input: {
  maxBytes: number;
  sections?: EnvelopeSections;
  verbatim?: (budget: number) => VerbatimPage;
  gaps?: EvidenceGap[];
}): AssembledEnvelope {
  const maxBytes = clampBudgetBytes(input.maxBytes, OUTPUT_BUDGET_BYTES.status);
  const sections = input.sections ?? {};
  const extraGaps = input.gaps ?? [];
  const requiredItems: Array<{ name: EnvelopeSectionName; text: string | undefined }> = [
    { name: "identity", text: sections.identity },
    { name: "failure", text: sections.failure },
    { name: "decision", text: sections.decision },
    { name: "diagnostics", text: sections.diagnostics },
  ];

  const clipVerbatim = (page: VerbatimPage | undefined, budget: number, omitted: EnvelopeOmission[]): VerbatimPage | undefined => {
    if (!page) return undefined;
    const pageBytes = utf8ByteLength(page.text);
    if (pageBytes <= budget) return page;
    if (budget <= 0) {
      omitted.push({ section: "verbatim", omittedBytes: pageBytes + page.omittedBytes });
      return { ...page, text: "", hasMore: true, omittedBytes: pageBytes + page.omittedBytes };
    }
    const clipped = clipPrefix(page.text, budget);
    return {
      ...page,
      text: clipped.text,
      hasMore: true,
      omittedBytes: page.omittedBytes + clipped.omittedBytes,
    };
  };

  let continuationReserve = 0;
  let includeProgress = true;
  let page: VerbatimPage | undefined;
  let continuation: string | undefined;
  let omitted: EnvelopeOmission[] = [];
  let text = "";
  let gaps: EvidenceGap[] = extraGaps;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const fitted = fitSections(requiredItems, Math.max(1, maxBytes - continuationReserve));
    omitted = [...fitted.omitted];
    const requiredBytes = utf8ByteLength(fitted.text);
    const verbatimBudget = Math.max(0, maxBytes - requiredBytes - (requiredBytes > 0 ? 1 : 0) - continuationReserve);
    page = clipVerbatim(input.verbatim?.(verbatimBudget), verbatimBudget, omitted);
    gaps = [...extraGaps, ...(page?.gaps ?? [])];
    const body = joinParts([fitted.text, page?.text]);
    const bodyBytes = utf8ByteLength(body);
    continuation = formatContinuation({
      hasMore: Boolean(page?.hasMore),
      omittedBytes: page?.omittedBytes ?? 0,
      nextCursor: page?.nextCursor,
      reset: page?.reset,
      gaps,
      omitted,
    });
    const withoutProgress = joinParts([body, continuation]);
    const withoutProgressBytes = utf8ByteLength(withoutProgress);
    if (withoutProgressBytes > maxBytes) {
      continuationReserve += withoutProgressBytes - maxBytes + 8;
      includeProgress = false;
      continue;
    }

    let progressText: string | undefined;
    if (sections.progress) {
      const leftover = maxBytes - withoutProgressBytes;
      if (includeProgress && leftover > 1) {
        const clipped = clipPrefix(sections.progress, leftover - 1);
        if (clipped.text) progressText = clipped.text;
        if (clipped.omittedBytes > 0) omitted.push({ section: "progress", omittedBytes: clipped.omittedBytes });
      } else {
        omitted.push({ section: "progress", omittedBytes: utf8ByteLength(sections.progress) });
      }
    }
    continuation = formatContinuation({
      hasMore: Boolean(page?.hasMore),
      omittedBytes: page?.omittedBytes ?? 0,
      nextCursor: page?.nextCursor,
      reset: page?.reset,
      gaps,
      omitted,
    });
    text = joinParts([body, progressText, continuation]);
    const size = utf8ByteLength(text);
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
    includeProgress = false;
  }

  const clipped = clipPrefix(text || joinParts([fitSections(requiredItems, maxBytes).text, continuation]), maxBytes);
  if (clipped.omittedBytes > 0) omitted.push({ section: "verbatim", omittedBytes: clipped.omittedBytes });
  return {
    text: clipped.text,
    byteLength: utf8ByteLength(clipped.text),
    truncated: true,
    omitted,
    verbatim: page,
    continuation,
    gaps,
  };
}
