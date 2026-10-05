import type { AssistantMessageEventStream, Context, Model, Api, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type CompatibleRegistry = ExtensionContext["modelRegistry"] & {
  streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions & {
    transformHeaders?: (headers: Record<string, string | null>) => Record<string, string | null>;
  }) => AssistantMessageEventStream;
};

class SuggestionTransportError extends Error {}
const transportState = globalThis as unknown as { [key: symbol]: WeakSet<object> | undefined };
const outstanding = transportState[Symbol.for("pi-better-harness.prompt-suggestion-outstanding")] ??= new WeakSet<object>();

function sanitizeUsage(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const numbers = (source: Record<string, unknown>, keys: string[]) => Object.fromEntries(
    keys.flatMap(key => typeof source[key] === "number" && Number.isFinite(source[key]) && source[key] >= 0
      ? [[key, source[key]]] : []),
  );
  const usage: Record<string, unknown> = numbers(source, ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]);
  if (source.cost && typeof source.cost === "object" && !Array.isArray(source.cost)) {
    const cost = numbers(source.cost as Record<string, unknown>, ["input", "output", "cacheRead", "cacheWrite", "total"]);
    if (Object.keys(cost).length) usage.cost = cost;
  }
  return Object.keys(usage).length ? usage : undefined;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new SuggestionTransportError("Prompt suggestion cancelled or timed out"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

/** Standalone auxiliary inference, never a session message or a tool-capable turn. */
export async function generateSuggestion(
  ctx: ExtensionContext,
  context: string,
  signal: AbortSignal,
  hooks: { eligible?: () => boolean; onUsage?: (usage: unknown) => void } = {},
): Promise<{ text: string; usage?: unknown }> {
  if (!context.trim() || context.length > 8_000) throw new Error("Invalid prompt suggestion context");
  const model = ctx.model;
  if (!model) throw new Error("Prompt suggestions require an active model");
  // Pi 1.0 virtual models route to another model/provider; v1 requires the active physical model.
  if (model.api === "pi-virtual") throw new Error("Prompt suggestions require a physical model, not a routed model");
  const registry = ctx.modelRegistry as CompatibleRegistry;
  if (outstanding.has(registry)) throw new SuggestionTransportError("Prompt suggestions: previous provider response is still active");
  let reserved = false;
  let trackingResult = false;
  const reserve = () => {
    if (outstanding.has(registry)) throw new SuggestionTransportError("Prompt suggestions: previous provider response is still active");
    outstanding.add(registry);
    reserved = true;
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const expiresAt = Date.now() + 4_000;
  const deadline = setTimeout(abort, 4_000);
  const check = () => {
    if (Date.now() >= expiresAt) abort();
    if (controller.signal.aborted) throw new SuggestionTransportError("Prompt suggestion cancelled or timed out");
    if (hooks.eligible && !hooks.eligible()) throw new SuggestionTransportError("Prompt suggestions: request is no longer eligible");
  };
  try {
    check();
    const configured = registry.getRegisteredProviderConfig?.(model.provider);
    const native = registry.getRegisteredNativeProvider?.(model.provider);
    const provider = registry.getProvider?.(model.provider);
    const customStream = native || (configured?.api === model.api && typeof configured?.streamSimple === "function");
    // These bundled APIs cannot honor all v1 bounds in either inspected SDK.
    if (!customStream && model.api === "openai-codex-responses") {
      throw new SuggestionTransportError("Prompt suggestions: bundled Codex transport cannot enforce the output token cap");
    }
    if (!customStream && model.api === "bedrock-converse-stream") {
      throw new SuggestionTransportError("Prompt suggestions: bundled Bedrock transport cannot disable retries");
    }
    const commandValue = (value: unknown) => typeof value === "string" && value.startsWith("!");
    if (registry.getProviderAuthStatus?.(model.provider).source === "models_json_command" ||
        commandValue(configured?.apiKey) || Object.values(configured?.headers ?? {}).some(commandValue) ||
        configured?.models?.some(entry => Object.values(entry.headers ?? {}).some(commandValue)) ||
        Object.values(native?.headers ?? {}).some(commandValue) ||
        Object.values(model.headers ?? {}).some(commandValue)) {
      throw new SuggestionTransportError("Prompt suggestions: command-based auth cannot meet the whole-request deadline");
    }
    if (typeof registry.getProvider !== "function") {
      throw new SuggestionTransportError("Prompt suggestions need a compatible public provider transport");
    }
    // Pi 0.82.1 and 1.0.0 expose neither the composed raw headers nor their config
    // snapshot/path. getAgentDir()/models.json cannot certify custom paths or stale
    // snapshots. Identity with an untouched native registration proves no composer
    // layer is present only in an error-free registry (composition errors can
    // fall back to native). Reject all other transports BEFORE auth resolution.
    // This includes static extension configs, builtins, and native config overlays.
    // Native auth callbacks remain trusted provider code, not inspectable config.
    if (!native || provider !== native || typeof registry.getError !== "function" || registry.getError()) {
      throw new SuggestionTransportError("Prompt suggestions: cannot safely inspect composed auth/header configuration on this SDK; an untouched native provider is required");
    }
    const request: Context = { messages: [{ role: "user", content: context, timestamp: Date.now() }] };
    const options: SimpleStreamOptions = {
      signal: controller.signal, maxTokens: 128, maxRetries: 0, timeoutMs: 4_000,
      websocketConnectTimeoutMs: 4_000,
      // An omitted reasoning level disables optional thinking in streamSimple.
      reasoning: undefined,
    };
    let stream: AssistantMessageEventStream;
    if (typeof registry.streamSimple === "function") {
      check();
      reserve();
      stream = registry.streamSimple(model, request, {
        ...options,
        // Public transform runs after auth, guarding dispatch after a slow auth resolution.
        transformHeaders(headers) { check(); return headers; },
      });
    } else {
      if (typeof registry.getProvider !== "function" || typeof registry.getApiKeyAndHeaders !== "function" ||
          typeof registry.getProviderAuth !== "function") {
        throw new SuggestionTransportError("Prompt suggestions need a compatible public provider transport");
      }
      if (!provider || typeof provider.streamSimple !== "function") {
        throw new SuggestionTransportError("Prompt suggestions: active provider has no public streamSimple transport");
      }
      const resolved = await abortable(registry.getApiKeyAndHeaders(model), controller.signal);
      check();
      if (!resolved.ok) throw new SuggestionTransportError("Prompt suggestions: active provider authentication unavailable");
      // 0.82.1's compatibility helper strips endpoint overrides and null headers.
      const auth = await abortable(registry.getProviderAuth(model.provider), controller.signal);
      check();
      // Only 0.82.1 reaches this path. In 1.0 the registry owns transcript normalization.
      const legacyStreamSimple = provider.streamSimple as unknown as (
        model: Model<Api>, context: Context, options: SimpleStreamOptions,
      ) => AssistantMessageEventStream;
      reserve();
      stream = legacyStreamSimple.call(provider, auth?.auth.baseUrl ? { ...model, baseUrl: auth.auth.baseUrl } : model, request, {
        ...options, apiKey: resolved.apiKey,
        headers: { ...auth?.auth.headers, ...resolved.headers },
        env: resolved.env ?? auth?.env,
      });
    }
    if (!stream || typeof stream.result !== "function") {
      throw new SuggestionTransportError("Prompt suggestions: provider has no bounded result API");
    }
    const pending = stream.result();
    trackingResult = true;
    // Local cancellation cannot prove an abort-insensitive provider stream has settled.
    const tracked = pending.then(result => {
      outstanding.delete(registry);
      const usage = sanitizeUsage(result?.usage);
      // Settlement owns accounting, independently of validity/freshness/cancellation.
      // Do not let an owner's ledger exception prevent release or leak its message.
      if (usage !== undefined) { try { hooks.onUsage?.(usage); } catch {} }
      return { ...result, usage };
    }, error => {
      outstanding.delete(registry);
      throw error;
    });
    const result = await abortable(tracked, controller.signal);
    check();
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      throw new SuggestionTransportError("Prompt suggestions: provider request failed");
    }
    if (result.stopReason !== "stop" || !Array.isArray(result.content) ||
        result.content.some((part) => part.type === "toolCall")) {
      throw new SuggestionTransportError("Prompt suggestions: provider returned an incomplete or tool response");
    }
    return {
      text: result.content.filter((part) => part.type === "text").map((part) => part.text).join(""),
      usage: result.usage,
    };
  } catch (error) {
    // Never forward arbitrary SDK error messages (which can include credentials/payloads).
    if (error instanceof SuggestionTransportError) throw error;
    throw new Error("Prompt suggestions: provider transport failed");
  } finally {
    if (reserved && !trackingResult) outstanding.delete(registry);
    clearTimeout(deadline);
    signal.removeEventListener("abort", abort);
  }
}
