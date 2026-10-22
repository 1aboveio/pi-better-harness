import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface LifecycleConfig {
  sessionIdleMs: number;
  daemonIdleMs: number;
}

export function readLifecycleConfig(serverDir: string, overrides: Partial<LifecycleConfig> = {}, env = process.env): LifecycleConfig {
  const path = join(serverDir, "lifecycle.json");
  let saved: Partial<LifecycleConfig> = {};
  if (existsSync(path)) {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} must contain a JSON object`);
    saved = parsed;
  }
  const duration = (key: keyof LifecycleConfig, environment: string, fallback: number): number => {
    const raw = overrides[key] ?? env[environment] ?? (saved[key] === undefined ? fallback : saved[key]);
    const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${key} (${environment}) must be a non-negative integer in milliseconds; 0 disables it`);
    }
    return value;
  };
  return {
    sessionIdleMs: duration("sessionIdleMs", "PI_SERVER_SESSION_IDLE_MS", 24 * 60 * 60 * 1000),
    daemonIdleMs: duration("daemonIdleMs", "PI_SERVER_DAEMON_IDLE_MS", 30 * 60 * 1000),
  };
}