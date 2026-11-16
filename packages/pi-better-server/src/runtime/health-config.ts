import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { healthThresholdsForConfig } from "./domain/health-observation.mjs";

const caches = new Map<string, { signature: string; revision: string; config: any; reason?: string }>();

/** Observe user preferences without invoking the legacy settings migration. */
export async function readHealthConfig(agentDir: string, needed = true) {
  const legacy = join(agentDir, "extensions/pi-better-subagents-config.json");
  const signature = createHash("sha256").update(JSON.stringify([join(agentDir, "settings.json"), legacy].map(path => {
    try { const info = statSync(path, { bigint: true }); return [info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String); }
    catch (error) { return (error as NodeJS.ErrnoException).code; }
  }))).digest("hex");
  // Empty inventories have no health projections; do not initialize the SDK for them.
  if (!needed) return { revision: "", config: {}, reason: undefined };
  const cached = caches.get(agentDir);
  if (cached?.signature === signature && !cached.reason) return cached;
  let config: any = {};
  let reason: string | undefined;
  try {
    const { readHarnessSetting } = await import("./domain/shared-harness-settings.mjs");
    config = readHarnessSetting("subagents", { agentDir: () => agentDir });
    if (config === undefined) {
      try { config = JSON.parse(readFileSync(legacy, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) config = {};
  } catch { config = {}; reason = "Health configuration unavailable; using domain default thresholds."; }
  // File identity discovers edits; only effective health content invalidates tasks.
  const revision = createHash("sha256").update(JSON.stringify(healthThresholdsForConfig(config))).digest("hex");
  const observation = { signature, revision, config, reason }; caches.set(agentDir, observation);
  if (caches.size > 8) caches.delete(caches.keys().next().value!);
  return observation;
}
