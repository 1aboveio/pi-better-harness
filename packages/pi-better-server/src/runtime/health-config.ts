import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const caches = new Map<string, { revision: string; config: any }>();

/** Observe user preferences without invoking the legacy settings migration. */
export async function readHealthConfig(agentDir: string, needed = true) {
  const legacy = join(agentDir, "extensions/pi-better-subagents-config.json");
  const revision = createHash("sha256").update(JSON.stringify([join(agentDir, "settings.json"), legacy].map(path => {
    try { const info = statSync(path, { bigint: true }); return [info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String); }
    catch (error) { return (error as NodeJS.ErrnoException).code; }
  }))).digest("hex");
  // Empty inventories have no health projections; do not initialize the SDK for them.
  if (!needed) return { revision, config: {} };
  if (caches.get(agentDir)?.revision === revision) return caches.get(agentDir)!;
  let config: any = {};
  try {
    const { readHarnessSetting } = await import("./domain/shared-harness-settings.mjs");
    config = readHarnessSetting("subagents", { agentDir: () => agentDir });
    if (config === undefined) config = JSON.parse(readFileSync(legacy, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) config = {};
  } catch { config = {}; }
  const observation = { revision, config }; caches.set(agentDir, observation);
  if (caches.size > 8) caches.delete(caches.keys().next().value!);
  return observation;
}
