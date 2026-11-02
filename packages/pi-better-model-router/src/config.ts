import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaults, type RouterConfig } from "./routing.ts";

export function parseConfig(value: unknown): RouterConfig {
  const config = { ...defaults, ...(value as object) } as RouterConfig;
  const fail = () => { throw new Error("Invalid model-router.json: expected preferredProvider, positive token estimates, and unique candidates with valid rates, UTC minute windows, and YYYY-MM-DD offPeakDates."); };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  if (typeof config.preferredProvider !== "string" || !config.preferredProvider ||
      ![config.estimatedInputTokens, config.estimatedOutputTokens].every(n => Number.isFinite(n) && n > 0) ||
      !Array.isArray(config.candidates) || !config.candidates.length) fail();
  const keys = new Set<string>();
  for (const c of config.candidates) {
    if (!c || typeof c.provider !== "string" || !c.provider || typeof c.model !== "string" || !c.model) fail();
    const key = c.provider + "/" + c.model;
    if (keys.has(key)) fail();
    keys.add(key);
    for (const rates of [c.peak, c.offPeak]) {
      if (!rates || ![rates.input, rates.output, rates.cacheRead].every(n => Number.isFinite(n) && n >= 0)) fail();
    }
    if (!Array.isArray(c.peakWindows) || !c.peakWindows.every(w => Array.isArray(w) && w.length === 2 &&
        w.every(Number.isInteger) && w[0] >= 0 && w[1] <= 1440 && w[0] < w[1])) fail();
    if (!Array.isArray(c.offPeakDates) || !c.offPeakDates.every(d => typeof d === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d)) fail();
  }
  return config;
}
export function loadConfig(agentDir: string, cwd: string): RouterConfig {
  let merged: object = {};
  for (const path of [join(agentDir, "model-router.json"), join(cwd, ".pi", "model-router.json")]) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      parseConfig(parsed);
      merged = { ...merged, ...(parsed as object) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Model router config ${path}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return parseConfig(merged);
}
