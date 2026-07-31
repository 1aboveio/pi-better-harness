// Generated from packages/log-utils/index.ts. Do not edit directly.
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";

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