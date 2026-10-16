/**
 * Can this host's Codex run a thread under a given model provider? A thread keeps the provider it was
 * recorded under (`session_meta.model_provider`), and the host's sign-in belongs to the providers that host
 * set up, so a thread moved to a host whose login is for another provider fails every turn with a 401.
 * The answer comes from the host's own app-server (`config/read`, `account/read`); no credential is read here.
 */
import type { CodexAppServerClient } from "./app-server.ts";

export interface ProviderCheck {
  ok: boolean;
  detail: string;
}

interface ProviderConfig {
  env_key?: string | null;
  experimental_bearer_token?: string | null;
  auth?: unknown;
  aws?: unknown;
  requires_openai_auth?: boolean;
}

interface AccountView {
  account: { type?: string } | null;
  requiresOpenaiAuth?: boolean;
}

/** Providers Codex ships with; they are not listed under `[model_providers]` in config.toml. */
const BUILT_IN_NO_AUTH = new Set(["ollama", "lmstudio"]);

export async function checkHostProvider(client: CodexAppServerClient, provider: string, env: NodeJS.ProcessEnv = process.env): Promise<ProviderCheck> {
  const { config } = await client.call<{ config: { model_provider?: string | null; model_providers?: Record<string, ProviderConfig> | null } }>("config/read", {});
  const account = await client.call<AccountView>("account/read", {});
  const configured = config.model_providers ?? {};
  const fallback = config.model_provider ?? "openai";
  const known = [...new Set([fallback, ...Object.keys(configured)])].map((id) => `"${id}"`).join(", ");
  const login = account.account?.type;
  const not = (why: string): ProviderCheck => ({ ok: false, detail: `model provider "${provider}" cannot be used there: ${why}. This host's default provider is "${fallback}" (configured: ${known}); pass --codex-provider <id> to rebind the thread to one of them` });

  const own = configured[provider];
  if (own) {
    if (own.env_key) return env[own.env_key] ? { ok: true, detail: `provider "${provider}" is configured there (key from $${own.env_key})` } : not(`it needs $${own.env_key}, which is not set there`);
    if (own.experimental_bearer_token || own.auth || own.aws) return { ok: true, detail: `provider "${provider}" is configured there` };
    if (own.requires_openai_auth) return login ? { ok: true, detail: `provider "${provider}" is configured there and Codex is signed in (${login})` } : not("it needs a Codex sign-in and this host is not signed in (`codex login`)");
    return { ok: true, detail: `provider "${provider}" is configured there and needs no sign-in` };
  }
  if (provider === "openai") {
    if (login === "chatgpt") return { ok: true, detail: 'provider "openai" is usable there (ChatGPT sign-in)' };
    if (login === "apiKey" && fallback === "openai") return { ok: true, detail: 'provider "openai" is usable there (API key)' };
    if (login === "apiKey") return not(`its only sign-in is an API key, which belongs to the provider "${fallback}" configured there`);
    return not("this host is not signed in (`codex login`)");
  }
  if (BUILT_IN_NO_AUTH.has(provider)) return { ok: true, detail: `provider "${provider}" is built in and needs no sign-in` };
  return not("it is not configured there");
}
