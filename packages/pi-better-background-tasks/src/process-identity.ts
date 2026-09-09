import { execFileSync } from "node:child_process";

const selfStartToken = readProcessStartToken(process.pid);

export function currentProcessStartToken(): string | undefined {
  return selfStartToken;
}

export function readProcessStartToken(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === "win32") return undefined;
  try {
    const output = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

export function processIdentityAlive(
  pid: number | undefined,
  recordedStartToken?: string,
  recordedAt?: number,
): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  const current = readProcessStartToken(pid);
  if (recordedStartToken && current) return recordedStartToken === current;
  if (!recordedStartToken && current && recordedAt !== undefined) {
    const currentStartedAt = Date.parse(current);
    if (Number.isFinite(currentStartedAt) && currentStartedAt > recordedAt + 2_000) return false;
  }
  return true;
}