import { createHash } from "node:crypto";
import OpenAI from "openai";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Item = Record<string, unknown>;
type StreamEvent = { type: string; response?: { status: string; output?: Item[] } };

export function supportsCompaction(model?: Model<Api>): model is Model<Api> {
  return !!model && /^(?:openai\/)?gpt-/i.test(model.id) &&
    (model.api === "openai-responses" || model.api === "openai-codex-responses");
}

export function route(model: Model<Api>): string {
  const identity = [model.api, model.provider, model.baseUrl.replace(/\/+$/, ""), model.id];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function compactedWindow(output: unknown): Item[] | undefined {
  if (Array.isArray(output) && output.every(item => item && typeof item === "object") &&
      output.some(item => item.type === "compaction" && typeof item.encrypted_content === "string" && item.encrypted_content.length)) {
    return output;
  }
  return undefined;
}

function unavailable(error: unknown) {
  if (!(error instanceof OpenAI.APIError)) return false;
  return [404, 405, 501].includes(error.status ?? 0) ||
    ([400, 422].includes(error.status ?? 0) &&
      /unsupported|not supported|(?:invalid|unknown).*compaction_trigger|context_length_exceeded/i.test(error.message));
}

export async function compactWindow(ctx: ExtensionContext, model: Model<Api>, input: object[], focus: string | undefined, signal: AbortSignal) {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  // Preserve null overrides so the OpenAI client also omits its own default headers.
  const headers: Record<string, string | null> = Object.fromEntries(
    [...Object.entries(model.headers ?? {}), ...Object.entries(auth.headers ?? {})]
      .map(([name, value]) => [name.toLowerCase(), value]),
  );
  let baseURL = model.baseUrl.replace(/\/+$/, "");
  const codex = model.api === "openai-codex-responses";
  if (codex) {
    baseURL = baseURL.replace(/\/codex(?:\/responses)?$/, "") + "/codex";
    const claims = JSON.parse(Buffer.from(auth.apiKey?.split(".")[1] ?? "", "base64url").toString());
    const accountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof accountId !== "string") throw new Error("Codex account ID unavailable");
    headers["chatgpt-account-id"] = accountId;
    headers.originator = "pi";
  }
  const sessionId = ctx.sessionManager.getSessionId();
  headers[codex ? "session-id" : "session_id"] = sessionId;
  // Credentials come exclusively from this Pi route, including gateways using custom headers.
  if (!auth.apiKey && headers.authorization == null && headers["cf-aig-authorization"] == null) {
    throw new Error("No credentials configured for the active Responses route");
  }
  const client = new OpenAI({ baseURL, apiKey: auth.apiKey ?? "unused", defaultHeaders: headers, maxRetries: 0 });
  const instructions = [ctx.getSystemPrompt(), focus].filter(Boolean).join("\n\n");
  const body = { model: model.id, input, instructions };
  try {
    const response = await client.post<{ output: Item[] }>("/responses/compact", { body, signal });
    const output = compactedWindow(response.output);
    if (!output) throw new Error("Compact endpoint returned no encrypted compaction item");
    return output;
  } catch (error) {
    signal.throwIfAborted();
    if (!unavailable(error) && !(error instanceof OpenAI.APIError && error.status === 502)) throw error;
  }

  // Some Responses gateways only expose the explicit trigger on their streaming endpoint.
  try {
    const stream = await client.post<AsyncIterable<StreamEvent>>("/responses", {
      body: { ...body, input: [...input, { type: "compaction_trigger" }], store: false, stream: true, prompt_cache_key: sessionId },
      stream: true, signal,
    });
    for await (const event of stream) {
      if (event.type === "response.completed" && event.response?.status === "completed") {
        // An older endpoint may ignore the trigger and generate an ordinary reply.
        const output = compactedWindow(event.response.output);
        if (output || event.response.output?.some(item => item.type === "message")) return output;
        throw new Error("Compaction completed without a usable output window");
      }
    }
    throw new Error("Compaction stream ended before response.completed");
  } catch (error) {
    signal.throwIfAborted();
    if (!unavailable(error)) throw error;
  }
}
