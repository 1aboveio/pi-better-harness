import { appendFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { CommandResult } from "./types.js";

export function appendWatchResult(logPath: string, result: CommandResult): void {
  mkdirSync(dirname(logPath), { recursive: true });
  const header = `\n--- check ${new Date(result.startedAt).toISOString()} exit=${result.exitCode ?? "null"} signal=${result.signal ?? "null"} duration_ms=${result.endedAt - result.startedAt} ---\n`;
  appendFileSync(logPath, header);
  if (result.stdout) appendFileSync(logPath, result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
  if (result.stderr) appendFileSync(logPath, `[stderr]\n${result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`}`);
}

export function appendLine(logPath: string, line: string): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${line}\n`);
}

export function readLog(logPath: string, tailLines?: number): { text: string; truncated: boolean } {
  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return { text: "", truncated: false };
  }
  if (!tailLines || tailLines <= 0) return { text, truncated: false };
  const lines = text.split(/\r?\n/);
  if (lines.length <= tailLines) return { text, truncated: false };
  return { text: lines.slice(-tailLines).join("\n"), truncated: true };
}