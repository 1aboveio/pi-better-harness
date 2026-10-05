import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const FILE_NAME = "harness-prompt-suggestions.json";

export function readPreferences(): { enabled: boolean } {
  try {
    const data: unknown = JSON.parse(readFileSync(join(getAgentDir(), FILE_NAME), "utf8"));
    return { enabled: typeof data === "object" && data !== null &&
      "enabled" in data && data.enabled === true };
  } catch {
    return { enabled: false };
  }
}

/** Only the owner's explicitly confirmed user action may call this function. */
export function writeEnabled(enabled: boolean): void {
  if (typeof enabled !== "boolean") throw new TypeError("Prompt suggestions enabled must be boolean");
  const dir = getAgentDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, FILE_NAME);
  const temporary = join(dir, `.${FILE_NAME}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify({ enabled })}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
