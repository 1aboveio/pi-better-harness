import { appendFileSync, closeSync, openSync, readSync, statSync, truncateSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { pageRetainedFile, readBoundedTail, tailTerminalDisplay, terminalDisplayRows } from "./shared-log-utils.js";
import type { FilePageRequest, PageResult } from "./shared-log-utils.js";
import type { BackgroundTaskMeta, CommandResult } from "./types.js";

export const DEFAULT_MAX_LOG_BYTES = 4 * 1024 * 1024;
export const MAX_LOG_TAIL_READ_BYTES = 512 * 1024;
const RETAINED_LOG_FRACTION = 0.75;

export function appendWatchResult(logPath: string, result: CommandResult): void {
  mkdirSync(dirname(logPath), { recursive: true });
  const capture = result.captureTruncated
    ? ` capture_discarded_stdout=${result.stdoutDiscardedBytes ?? 0} capture_discarded_stderr=${result.stderrDiscardedBytes ?? 0}`
    : "";
  const header = `\n--- check ${new Date(result.startedAt).toISOString()} exit=${result.exitCode ?? "null"} signal=${result.signal ?? "null"} duration_ms=${result.endedAt - result.startedAt}${capture} ---\n`;
  appendFileSync(logPath, header);
  if (result.stdout) appendFileSync(logPath, result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
  if (result.stderr) appendFileSync(logPath, `[stderr]\n${result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`}`);
}

export function appendLine(logPath: string, line: string): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${line}\n`);
}

export function appendTaskOutput(logPath: string, output: string): void {
  if (!output) return;
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, output);
}

export interface LogRead {
  text: string;
  truncated: boolean;
  totalBytes?: number;
  error?: string;
  /** Display rows before the returned tail within the bounded read window. */
  omittedRows?: number;
}

export function readLog(logPath: string, tailLines?: number): LogRead {
  const requestedRows = tailLines && tailLines > 0 ? Math.floor(tailLines) : undefined;
  const tail = readBoundedTail(logPath, MAX_LOG_TAIL_READ_BYTES);
  if (tail.error) {
    return { text: "", truncated: tail.truncated, totalBytes: tail.totalBytes, error: tail.error };
  }
  if (!tail.text) return { text: "", truncated: false, totalBytes: tail.totalBytes };
  if (!requestedRows) return { text: tail.text, truncated: tail.truncated, totalBytes: tail.totalBytes };
  const rows = terminalDisplayRows(tail.text);
  const omittedRows = Math.max(0, rows.length - requestedRows);
  return {
    text: tailTerminalDisplay(tail.text, requestedRows),
    truncated: tail.truncated || omittedRows > 0,
    totalBytes: tail.totalBytes,
    ...(omittedRows > 0 ? { omittedRows } : {}),
  };
}

export function captureGapsFor(meta: BackgroundTaskMeta): Array<{ bytes: number; detail?: string }> {
  const gaps: Array<{ bytes: number; detail?: string }> = [];
  if (meta.stdoutDiscardedBytes) {
    gaps.push({ bytes: meta.stdoutDiscardedBytes, detail: "stdout capture overflow" });
  }
  if (meta.stderrDiscardedBytes) {
    gaps.push({ bytes: meta.stderrDiscardedBytes, detail: "stderr capture overflow" });
  }
  if (!gaps.length && meta.captureDiscardedBytes) {
    gaps.push({ bytes: meta.captureDiscardedBytes, detail: `${meta.captureOverflowEvents ?? 1} capture overflow(s)` });
  }
  return gaps;
}

/** Page retained raw bytes with this task's generation and disclosed capture/retention loss. */
export function pageTaskLog(meta: BackgroundTaskMeta, request: FilePageRequest = {}): PageResult {
  return pageRetainedFile(meta.logPath, {
    ...request,
    resource: request.resource ?? meta.id,
    generation: request.generation ?? meta.logGeneration ?? 0,
    discardedBytes: request.discardedBytes ?? meta.logDiscardedBytes,
    captureGaps: request.captureGaps ?? captureGapsFor(meta),
  });
}

export function resolveMaxLogBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_MAX_LOG_BYTES;
  return Math.max(64 * 1024, Math.floor(value));
}

/**
 * Compact in place so detached children keep writing to the same inode. A
 * rename-based rotation would leave their inherited descriptor unbounded.
 */
export function retainLogTail(logPath: string, maxBytes: number): { discardedBytes: number } | undefined {
  let size: number;
  try {
    size = statSync(logPath).size;
  } catch {
    return undefined;
  }
  if (size <= maxBytes) return undefined;

  const start = Math.max(0, size - Math.floor(maxBytes * RETAINED_LOG_FRACTION));
  let fd: number | undefined;
  let retained: Buffer;
  try {
    fd = openSync(logPath, "r");
    retained = Buffer.allocUnsafe(size - start);
    let offset = 0;
    while (offset < retained.length) {
      const read = readSync(fd, retained, offset, retained.length - offset, start + offset);
      if (read <= 0) break;
      offset += read;
    }
    retained = retained.subarray(0, offset);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }

  const discardedBytes = Math.max(0, size - retained.length);
  try {
    truncateSync(logPath, 0);
    if (retained.length) appendFileSync(logPath, retained);
    appendFileSync(logPath, `--- log retention discarded ${discardedBytes} bytes; newest output retained ---\n`);
    return { discardedBytes };
  } catch {
    return undefined;
  }
}