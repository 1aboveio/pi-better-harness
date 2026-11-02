import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { loadConfig } from "./config.ts";
import { chooseCandidate, isTransient, resolveCandidates } from "./routing.ts";

// Structural contract keeps this standalone package buildable alongside the
// monorepo's older SDK. Pi 1.4's native virtual-model API is required at runtime.
type Level = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
interface Physical { model: Model<Api>; thinkingLevel?: Level }
export interface RouteRequest {
  reason: "user" | "continuation" | "retry" | "direct";
  thinkingLevel: Level;
  previous?: Physical;
  failed?: Physical & { message: { errorMessage?: string } };
  state?: { failedProviders: string[] };
}
interface RouteResult { model: Model<Api>; thinkingLevel: Level; state?: { failedProviders: string[] } }
export interface VirtualDefinition {
  provider: string; id: string; name: string; thinkingLevels: Level[];
  route(request: RouteRequest, ctx: ExtensionContext): RouteResult;
}
export function route(request: RouteRequest, ctx: ExtensionContext, now = new Date()): RouteResult {
  const config = loadConfig(getAgentDir(), ctx.cwd);
  const models = ctx.modelRegistry.getAvailable();
  const available = resolveCandidates(models, config);
  const find = (physical?: Physical) => physical && available.find(c =>
    c.provider === physical.model.provider && c.model === physical.model.id);
  let failedProviders = request.reason === "user" || request.reason === "direct"
    ? [] : request.state?.failedProviders ?? [];
  if (request.reason === "retry" && request.failed) {
    if (!isTransient(request.failed.message.errorMessage ?? "")) {
      if (!find(request.failed)) throw new Error("Model router: failed model is no longer available.");
      return { model: request.failed.model, thinkingLevel: request.failed.thinkingLevel ?? request.thinkingLevel };
    }
    failedProviders = [...new Set([...failedProviders, request.failed.model.provider])];
  }
  const eligible = available.filter(c => !failedProviders.includes(c.provider));
  const sticky = request.reason === "continuation" ? find(request.previous) : undefined;
  const candidate = sticky && eligible.includes(sticky) ? sticky
    : chooseCandidate(config, eligible, now, request.previous?.model);
  const model = models.find(m => m.provider === candidate.provider && m.id === candidate.model)!;
  return {
    model,
    thinkingLevel: sticky ? request.previous?.thinkingLevel ?? request.thinkingLevel : request.thinkingLevel,
    state: { failedProviders },
  };
}
export default function (pi: ExtensionAPI) {
  const host = pi as unknown as { registerVirtualModel?: (definition: VirtualDefinition) => void };
  if (typeof host.registerVirtualModel !== "function") {
    throw new Error("pi-better-model-router requires Pi with registerVirtualModel (tested with Pi 1.4.0). Upgrade Pi to use this extension.");
  }
  host.registerVirtualModel({
    provider: "router", id: "deepseek-flash-auto", name: "DeepSeek Flash Auto",
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    route,
  });
}
