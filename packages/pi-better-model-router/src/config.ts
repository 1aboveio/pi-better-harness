import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaults, type RouterConfig } from "./routing.ts";

export function parseConfig(value: unknown): RouterConfig {
  const config = { ...defaults, ...(value as object) } as RouterConfig;
  const fail = () => { throw new Error("Invalid model-router.json: only preferredProvider (deepseek or ollama-cloud), estimatedInputTokens, and estimatedOutputTokens are supported. Configure physical models and cost in Pi models.json."); };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  if (Object.keys(value as object).some(key => !Object.hasOwn(defaults, key)) ||
      !["deepseek", "ollama-cloud"].includes(config.preferredProvider) ||
      ![config.estimatedInputTokens, config.estimatedOutputTokens].every(n => Number.isFinite(n) && n > 0)) fail();
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
