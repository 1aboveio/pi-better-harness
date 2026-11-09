import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { loadConfig } from "./config.ts";
import { chooseCandidate, isCheapest, isContextOverflow, isTransient, resolveCandidates } from "./routing.ts";

// Structural contract keeps this standalone package buildable alongside the
// monorepo's older SDK. Pi 1.4's native virtual-model API is required at runtime.
type Level = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
interface Physical { model: Model<Api>; thinkingLevel?: Level }
/** Providers this turn left behind. Hard failures end the turn; transient ones stay retryable. */
export interface RouteState { failedProviders: string[]; transientProviders?: string[] }
export interface RouteRequest {
  reason: "user" | "continuation" | "retry" | "direct";
  thinkingLevel: Level;
  previous?: Physical;
  failed?: Physical & { message: { errorMessage?: string } };
  state?: RouteState;
}
interface RouteResult { model: Model<Api>; thinkingLevel: Level; state?: RouteState }
export interface VirtualDefinition {
  provider: string; id: string; name: string; thinkingLevels: Level[];
  contextWindow: number; maxTokens: number;
  route(request: RouteRequest, ctx: ExtensionContext): RouteResult;
}
// Pi needs a declared window whenever a response names no physical model, which is exactly
// the router's own routing error: with no declared limit Pi falls back to a zero window, sees
// every conversation as over the threshold, and compacts after each routing error.
//
// Both candidate families share one 1,048,576-token window between input and output, but Pi
// treats contextWindow as the input allowance and maxTokens as room beyond it. Declaring the
// raw window beside a large output budget therefore promises capacity the provider does not
// have: 746,917 tokens of history plus a 384,000-token completion is 1,130,917, and the
// request is rejected for exceeding 1,048,576. Declare the input budget the shared window
// leaves after the output budget instead, so both the compaction threshold and the
// request-time clamp stay inside the real window.
const PROVIDER_CONTEXT_WINDOW = 1_048_576;
const MAX_TOKENS = 64_000;
const CONTEXT_WINDOW = PROVIDER_CONTEXT_WINDOW - MAX_TOKENS;
function sameList(left: readonly string[] = [], right: readonly string[] = []): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function sameState(left: RouteState, right: RouteState): boolean {
  return sameList(left.failedProviders, right.failedProviders) &&
    sameList(left.transientProviders, right.transientProviders);
}
function addProvider(list: readonly string[], provider: string): string[] {
  return [...new Set([...list.filter(entry => entry !== provider), provider])];
}
function withoutProvider(list: readonly string[], provider: string): string[] {
  return list.filter(entry => entry !== provider);
}
export function route(request: RouteRequest, ctx: ExtensionContext, now = new Date()): RouteResult {
  const config = loadConfig(getAgentDir(), ctx.cwd);
  const models = ctx.modelRegistry.getAvailable();
  const available = resolveCandidates(models, config);
  const find = (physical?: Physical) => physical && available.find(c =>
    c.provider === physical.model.provider && c.model === physical.model.id);
  // Pi retries a context overflow after compacting the conversation. That retry keeps the
  // failed model, because a switch would pay a cold cache right after compaction.
  if (request.reason === "retry" && request.failed && isContextOverflow(request.failed.message.errorMessage ?? "")) {
    if (!find(request.failed)) throw new Error("Model router: failed model is no longer available.");
    return { model: request.failed.model, thinkingLevel: request.failed.thinkingLevel ?? request.thinkingLevel };
  }
  const startsTurn = request.reason === "user" || request.reason === "direct";
  // A new user turn clears every exclusion. Inside a turn a hard failure keeps that
  // provider out; a transient one only sends the next attempt to the other candidate.
  let failedProviders = startsTurn ? [] : request.state?.failedProviders ?? [];
  let transientProviders = startsTurn ? [] : request.state?.transientProviders ?? [];
  if (request.reason === "retry" && request.failed) {
    const { provider } = request.failed.model;
    if (isTransient(request.failed.message.errorMessage ?? "")) {
      transientProviders = addProvider(transientProviders, provider);
      failedProviders = withoutProvider(failedProviders, provider);
    } else {
      failedProviders = addProvider(failedProviders, provider);
      transientProviders = withoutProvider(transientProviders, provider);
    }
  }
  const previous = find(request.previous);
  let eligible = available.filter(c => !failedProviders.includes(c.provider) && !transientProviders.includes(c.provider));
  let recovered = false;
  if (!eligible.length && transientProviders.length) {
    // Retrying a provider that timed out beats ending the turn with no route at all.
    eligible = available.filter(c => !failedProviders.includes(c.provider));
    transientProviders = [];
    recovered = true;
  }
  const sticky = request.reason === "continuation" ? previous : undefined;
  const keep = sticky !== undefined && eligible.includes(sticky) && isCheapest(config, sticky, eligible, now);
  // Reusing the model the turn already used preserves its prompt cache; the price policy
  // can still move the turn at the next price boundary.
  let reuse: typeof previous;
  if (keep) reuse = sticky;
  else if (recovered && previous !== undefined && eligible.includes(previous)) reuse = previous;
  const candidate = reuse ?? chooseCandidate(config, eligible, now, request.previous?.model);
  const model = models.find(m => m.provider === candidate.provider && m.id === candidate.model)!;
  const state: RouteState = { failedProviders, ...(transientProviders.length ? { transientProviders } : {}) };
  // Pi appends a session entry for every state object it receives, so report the
  // excluded providers only when that list changes.
  return {
    model,
    thinkingLevel: reuse !== undefined
      ? request.previous?.thinkingLevel ?? request.thinkingLevel : request.thinkingLevel,
    ...(sameState(request.state ?? { failedProviders: [] }, state) ? {} : { state }),
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
    contextWindow: CONTEXT_WINDOW, maxTokens: MAX_TOKENS,
    route,
  });
}
