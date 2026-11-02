import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaults, type RouterConfig } from "./routing.ts";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validPricing(value: unknown): boolean {
  if (!object(value)) return false;
  return Object.entries(value).every(([provider, entry]) => {
    if (!["deepseek", "ollama-cloud"].includes(provider) || !object(entry)) return false;
    return Object.entries(entry).every(([key, field]) => {
      if (key === "peak" || key === "offPeak") {
        return object(field) && Object.entries(field).every(([name, rate]) =>
          ["input", "output", "cacheRead"].includes(name) && typeof rate === "number" && Number.isFinite(rate) && rate >= 0);
      }
      if (key === "peakWindows") return Array.isArray(field) && field.every(w =>
        Array.isArray(w) && w.length === 2 && w.every(Number.isInteger) &&
        w[0] >= 0 && w[1] <= 1440 && w[0] < w[1]);
      if (key === "offPeakDates") return Array.isArray(field) && field.every(d =>
        typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) &&
        new Date(d).toISOString().slice(0, 10) === d);
      return false;
    });
  });
}
export function parseConfig(value: unknown): RouterConfig {
  const config = { ...defaults, ...(value as object) } as RouterConfig;
  const fail = () => { throw new Error("Invalid model-router.json: expected type: price, preferredProvider (deepseek or ollama-cloud), positive token weights, and pricing overrides with nonnegative rates, UTC minute windows, or YYYY-MM-DD dates. Physical model settings belong in Pi models.json."); };
  if (!object(value)) fail();
  if (Object.keys(value as object).some(key => !Object.hasOwn(defaults, key)) ||
      config.type !== "price" ||
      !["deepseek", "ollama-cloud"].includes(config.preferredProvider) ||
      ![config.estimatedInputTokens, config.estimatedOutputTokens].every(n => Number.isFinite(n) && n > 0) ||
      !validPricing(config.pricing)) fail();
  return config;
}
export function mergeConfig(base: RouterConfig, override: RouterConfig): RouterConfig["pricing"] {
  const pricing = { ...base.pricing };
  for (const provider of ["deepseek", "ollama-cloud"] as const) {
    const incoming = override.pricing[provider];
    if (!incoming) continue;
    const previous = pricing[provider];
    pricing[provider] = { ...previous, ...incoming,
      peak: { ...previous?.peak, ...incoming.peak },
      offPeak: { ...previous?.offPeak, ...incoming.offPeak } };
  }
  return pricing;
}
export function loadConfig(agentDir: string, cwd: string): RouterConfig {
  let merged = parseConfig({});
  for (const path of [join(agentDir, "model-router.json"), join(cwd, ".pi", "model-router.json")]) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      const config = parseConfig(parsed);
      merged = parseConfig({ ...merged, ...(parsed as object), pricing: mergeConfig(merged, config) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Model router config ${path}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return merged;
}
