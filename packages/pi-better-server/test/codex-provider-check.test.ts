import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CodexAppServerClient } from "../src/codex/app-server.ts";
import type { CodexMoveAdapter } from "../src/codex/adapter.ts";
import type { CodexRuntime } from "../src/codex/runtime.ts";
import { deliverToThread } from "../src/codex/deliver.ts";
import { checkHostProvider } from "../src/codex/provider.ts";

/** A host whose Codex reads `config` and `account`; no process involved. */
function host(config: object, account: object = { account: null }): CodexAppServerClient {
  return { call: async (method: string) => (method === "config/read" ? { config } : account) } as unknown as CodexAppServerClient;
}

describe("checkHostProvider", () => {
  it("refuses a provider named like an object prototype key as not configured", async () => {
    const client = host({ model_provider: "beta", model_providers: { beta: {} } });
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const verdict = await checkHostProvider(client, name);
      assert.equal(verdict.ok, false, name);
      assert.match(verdict.detail, /it is not configured there/, name);
    }
  });

  it("still accepts a provider the host really configures, even one called __proto__", async () => {
    const providers = JSON.parse('{"__proto__": {}, "beta": {}}');
    assert.equal((await checkHostProvider(host({ model_providers: providers }), "__proto__")).ok, true);
    assert.equal((await checkHostProvider(host({ model_providers: providers }), "beta")).ok, true);
  });

  it("refuses a configured provider whose $env_key is unset, and accepts it once set", async () => {
    const client = host({ model_providers: { beta: { env_key: "PI_TEST_BETA_KEY" } } });
    const refused = await checkHostProvider(client, "beta", {});
    assert.equal(refused.ok, false);
    assert.match(refused.detail, /model provider "beta" cannot be used there: it needs \$PI_TEST_BETA_KEY, which is not set there/);
    assert.equal((await checkHostProvider(client, "beta", { PI_TEST_BETA_KEY: "k" })).ok, true);
  });

  it("refuses a requires_openai_auth provider when Codex is not signed in, and accepts it when signed in", async () => {
    const config = { model_providers: { beta: { requires_openai_auth: true } } };
    const refused = await checkHostProvider(host(config, { account: null }), "beta");
    assert.equal(refused.ok, false);
    assert.match(refused.detail, /model provider "beta" cannot be used there: it needs a Codex sign-in and this host is not signed in/);
    assert.equal((await checkHostProvider(host(config, { account: { type: "chatgpt" } }), "beta")).ok, true);
  });
});

describe("deliverToThread", () => {
  it("reports success when turn/start worked but the follow-up thread/turns/list read fails", async () => {
    const calls: string[] = [];
    const client = {
      call: async (method: string) => {
        calls.push(method);
        if (method === "thread/read") return { thread: { status: { type: "idle" } } };
        if (method === "turn/start") return { turn: { id: "t1" } };
        // The pre-start lookup for a running turn succeeds (none); only the read after turn/start fails.
        if (method === "thread/turns/list" && !calls.includes("turn/start")) return { data: [] };
        throw new Error("thread/turns/list: boom");
      },
    } as unknown as CodexAppServerClient;
    const runtime = { rolloutPath: () => "/rollout", client: async () => client } as unknown as CodexRuntime;
    const adapter = { ownership: { get: () => ({ state: "owned" }) } } as unknown as CodexMoveAdapter;
    assert.deepEqual(await deliverToThread(adapter, runtime, "th", "hi"), { delivered: "prompt" });
    assert.equal(calls.filter((m) => m === "turn/start").length, 1, "the message was sent exactly once");
    assert.ok(calls.includes("thread/turns/list"), "the watch did try to read");
  });
});
