import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Last event `seq` `pi-remote tail` printed per session, so the next tail resumes from there. */
function cursorFile(): string {
  return join(process.env.PI_REMOTE_STATE_DIR || join(getAgentDir(), "remote"), "tail-cursors.json");
}

export function cursorKey(host: string | undefined, sessionId: string): string {
  return `${host ?? "local"}:${sessionId}`;
}

export function readCursor(key: string): number | undefined {
  try {
    const value = (JSON.parse(readFileSync(cursorFile(), "utf8")) as Record<string, unknown>)[key];
    return typeof value === "number" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeCursor(key: string, seq: number): void {
  const file = cursorFile();
  let all: Record<string, number> = {};
  try {
    if (existsSync(file)) all = JSON.parse(readFileSync(file, "utf8")) as Record<string, number>;
  } catch {
    all = {};
  }
  all[key] = seq;
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(all)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}
