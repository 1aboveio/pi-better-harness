import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { buildSuggestionContext, SuggestionEngine, validateSuggestion } from "../packages/pi-better-harness/extensions/prompt-suggestions/engine.ts";
import { generateSuggestion } from "../packages/pi-better-harness/extensions/prompt-suggestions/provider.ts";
import { readPreferences, writeEnabled } from "../packages/pi-better-harness/extensions/prompt-suggestions/preferences.ts";

const sdkUrl = process.env.PI_CODEMODE_TEST_SDK_DIR
  ? pathToFileURL(join(process.env.PI_CODEMODE_TEST_SDK_DIR, "dist/index.js")).href
  : import.meta.resolve("@earendil-works/pi-coding-agent");
const sdk = await import(sdkUrl);
const ai = await import(process.env.PI_CODEMODE_TEST_SDK_DIR
  ? new URL("../../pi-ai/dist/index.js", sdkUrl).href
  : import.meta.resolve("@earendil-works/pi-ai"));
const flush = () => new Promise(setImmediate);
const text = (value) => ({ type: "text", text: value });
const user = (value) => ({ type: "message", message: { role: "user", content: value } });
const answer = (value, extra = {}) => ({ type: "message", message: {
  role: "assistant", content: [text(value)], stopReason: "stop", ...extra,
} });

test("validation rejects unsafe or reinterpreted output without rejecting CJK or combining graphemes", () => {
  for (const invalid of ["", "   ", "/merge", " !rm", "@tool", "first\nsecond", "first\rsecond", "next\n",
    "\tNext", "\x1b[31mNext", "Next\x7f", "Next\x9b31m", "Next\u202e", "Next\u2066", "Next\u200b",
    "Next\ufeff", "Next\u00ad", "Next\u034f", "Next\u2028", "Next\u2029", "\ud800", "```next```",
    "a".repeat(161), "\u8bf7".repeat(161), "e\u0301".repeat(161)]) {
    assert.equal(validateSuggestion(invalid), undefined, JSON.stringify(invalid));
  }
  for (const valid of ["\u8bf7\u8fd0\u884c\u6d4b\u8bd5", "e\u0301".repeat(160), "\u8bf7".repeat(160), "Review the focused tests", "What changed?"]) {
    assert.equal(validateSuggestion(valid), valid);
  }
  assert.equal(validateSuggestion("  Run tests  "), "Run tests");
});

test("context selects whole recent exchanges, retaining newest intent/final answer without tool or hidden data", () => {
  const branch = [
    user("old-intent"), answer("old-answer"),
    user("older-oversize" + "x".repeat(8_000)), answer("older-answer"),
    { type: "custom_message", role: "user", content: "hidden-custom-payload" },
    user([text("newest-intent"), { type: "image", data: "raw-image", mimeType: "image/png" }]),
    answer("tool commentary", { stopReason: "toolUse", content: [text("tool commentary"),
      { type: "toolCall", name: "bash", arguments: { command: "raw-command" } }] }),
    { type: "message", message: { role: "toolResult", content: [text("raw-tool-output")] } },
    answer("newest-final", { content: [text("newest-final"), { type: "thinking", thinking: "hidden-reasoning" }] }),
    { type: "custom", data: { secret: "private-metadata" } },
  ];
  const context = buildSuggestionContext(branch);
  assert.ok(context.length <= 8_000);
  const exchanges = context.split("\n").slice(2).map((line) => JSON.parse(line));
  assert.deepEqual(exchanges, [{ user: "newest-intent", assistant: "newest-final" }]);
  for (const excluded of ["raw-image", "hidden-reasoning", "raw-command", "raw-tool-output", "tool commentary", "private-metadata", "hidden-custom-payload"]) {
    assert.equal(context.includes(excluded), false);
  }
  const recent = buildSuggestionContext([user("one"), answer("first"), user("two"), answer("second")]);
  assert.deepEqual(recent.split("\n").slice(2).map(JSON.parse), [
    { user: "one", assistant: "first" }, { user: "two", assistant: "second" },
  ]);
});

test("context never revives an earlier success or truncates essential newest text", () => {
  for (const branch of [[], [answer("orphan")], [user("intent")], [user("intent"), answer("")],
    [user("intent"), answer("failed", { stopReason: "error" })],
    [user("intent"), answer("partial", { stopReason: "length" })],
    [user("earlier"), answer("good"), user("new"), answer("aborted", { stopReason: "aborted" })],
    [user("x".repeat(8_000)), answer("essential")], [user("essential"), answer("x".repeat(8_000))]]) {
    assert.equal(buildSuggestionContext(branch), undefined);
  }
  const latest = buildSuggestionContext([user("question"), answer("earlier"), answer("final")]);
  assert.deepEqual(JSON.parse(latest.split("\n").at(-1)), { user: "question", assistant: "final" });
});

function harness(t, generate, options = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const shown = [];
  const states = [];
  const engine = new SuggestionEngine({ generate, onSuggestion: (value) => shown.push(value),
    onState: (reason, usage) => states.push({ reason, usage }), ...options });
  t.after(() => engine.dispose());
  return { engine, shown, states, tick: async (ms) => { t.mock.timers.tick(ms); await flush(); } };
}

test("opt-in owner scheduling is asynchronous, debounced, bounded, and accounts auxiliary usage", async (t) => {
  const requests = [];
  const h = harness(t, async (context, signal) => {
    requests.push({ context, signal });
    return { text: "Run the focused tests", usage: { input: 50, output: 7 } };
  });
  await h.tick(5_000);
  assert.equal(requests.length, 0, "construction alone never requests inference");
  h.engine.schedule("old");
  await h.tick(299);
  assert.equal(requests.length, 0);
  h.engine.schedule("new");
  await h.tick(299);
  assert.equal(requests.length, 0);
  await h.tick(1);
  assert.deepEqual(requests.map((request) => request.context), ["new"]);
  assert.deepEqual(h.shown, ["Run the focused tests"]);
  assert.deepEqual(h.states.find((state) => state.reason === "ready").usage, { input: 50, output: 7 });
  await h.tick(4_000);
  assert.equal(h.states.some((state) => state.reason === "timeout"), false);
  h.engine.schedule("x".repeat(8_001));
  h.engine.schedule("");
  await h.tick(300);
  assert.equal(requests.length, 1);
});

test("cancel before dispatch and dispose invalidate all pending work", async (t) => {
  let calls = 0;
  const h = harness(t, async () => { calls++; return { text: "Next" }; });
  h.engine.schedule("context");
  h.engine.cancel("typing");
  await h.tick(300);
  assert.equal(calls, 0);
  h.engine.schedule("context");
  h.engine.dispose();
  h.engine.schedule("context");
  await h.tick(5_000);
  assert.equal(calls, 0);
  assert.deepEqual(h.shown, []);
});

test("timeout invalidates before abort, ignores late completions, and never overlaps or retries", async (t) => {
  const requests = [];
  const h = harness(t, (context, signal) => {
    const pending = Promise.withResolvers();
    signal.addEventListener("abort", () => pending.resolve({ text: "Late suggestion", usage: { output: 9 } }));
    requests.push({ context, signal, pending });
    return pending.promise;
  });
  h.engine.schedule("first");
  await h.tick(300);
  await h.tick(3_999);
  assert.equal(requests[0].signal.aborted, false);
  await h.tick(1);
  assert.equal(requests[0].signal.aborted, true);
  assert.deepEqual(h.shown, []);
  assert.equal(h.states.at(-1).reason, "timeout");
  await h.tick(10_000);
  assert.equal(requests.length, 1);
  h.engine.schedule("fresh");
  await h.tick(300);
  assert.equal(requests.length, 2);
});

test("superseding an abort-insensitive provider cannot dispatch overlapping requests", async (t) => {
  const pending = Promise.withResolvers();
  let calls = 0;
  let signal;
  const h = harness(t, (_context, value) => {
    calls++;
    signal = value;
    return calls === 1 ? pending.promise : Promise.resolve({ text: "Fresh suggestion" });
  });
  h.engine.schedule("first");
  await h.tick(300);
  h.engine.schedule("second");
  assert.equal(signal.aborted, true);
  await h.tick(300);
  assert.equal(calls, 1);
  assert.equal(h.states.at(-1).reason, "busy");
  pending.resolve({ text: "Stale" });
  await flush();
  assert.deepEqual(h.shown, []);
  h.engine.schedule("third");
  await h.tick(300);
  assert.equal(calls, 2);
  assert.deepEqual(h.shown, ["Fresh suggestion"]);
});

test("elapsed wall deadline rejects completion even before the timeout callback can run", async (t) => {
  const pending = Promise.withResolvers();
  let signal;
  const h = harness(t, (_context, value) => { signal = value; return pending.promise; });
  h.engine.schedule("context");
  await h.tick(300);
  t.mock.timers.setTime(4_301);
  pending.resolve({ text: "Too late" });
  await flush();
  assert.equal(signal.aborted, true);
  assert.deepEqual(h.shown, []);
  assert.equal(h.states.at(-1).reason, "timeout");
});

test("invalid/empty output and provider errors stay quiet, do not retry, and do not leak provider errors", async (t) => {
  const results = ["/publish", "", "Next\nline"];
  let calls = 0;
  const h = harness(t, async () => {
    calls++;
    if (results.length) return { text: results.shift() };
    throw new Error("synthetic-secret");
  });
  for (let i = 0; i < 4; i++) { h.engine.schedule("context"); await h.tick(300); }
  await h.tick(10_000);
  assert.equal(calls, 4);
  assert.deepEqual(h.shown, []);
  assert.ok(h.states.some((state) => state.reason === "invalid-output"));
  assert.ok(h.states.some((state) => state.reason === "no-suggestion"));
  assert.equal(h.states.at(-1).reason, "error");
  assert.equal(JSON.stringify(h.states).includes("synthetic-secret"), false);
});

test("five displayed-but-unused suggestions skip exactly three eligible schedules and acceptance resets cooldown", async (t) => {
  let calls = 0;
  const h = harness(t, async () => { calls++; return { text: "Next" }; });
  for (let i = 0; i < 5; i++) {
    h.engine.schedule("context"); await h.tick(300); h.engine.noteUnused();
  }
  assert.equal(h.shown.length, 5);
  h.engine.schedule("");
  h.engine.schedule("x".repeat(8_001));
  for (let i = 0; i < 3; i++) { h.engine.schedule("context"); await h.tick(300); }
  assert.equal(calls, 5);
  h.engine.schedule("context"); await h.tick(300);
  assert.equal(calls, 6);
  for (let i = 0; i < 5; i++) h.engine.noteUnused();
  h.engine.noteAccepted();
  h.engine.schedule("context"); await h.tick(300);
  assert.equal(calls, 7);
});

async function runtimeFixture(t, { auth, holdAuth = false, holdResponse = false, response = {}, fail,
  api = "test-prompt-api", modelsJson } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-prompt-provider-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const requests = [];
  let authCalls = 0;
  const authEntered = Promise.withResolvers();
  const releaseAuth = Promise.withResolvers();
  const requestEntered = Promise.withResolvers();
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const model = { id: "recording", name: "Recording", api, provider: "test-prompt-provider",
    baseUrl: "https://example.invalid/configured", reasoning: true, input: ["text"],
    contextWindow: 128_000, maxTokens: 1_024, cost, headers: { "X-Model": "model-header" } };
  if (modelsJson) writeFileSync(join(root, "models.json"), JSON.stringify(modelsJson(root, model)));
  const provider = ai.createProvider({ id: model.provider, models: [model], headers: { "X-Provider": "provider-header" },
    auth: { apiKey: { label: "Synthetic auth", check: async () => ({ source: "test" }), resolve: async () => {
      authCalls++;
      authEntered.resolve();
      if (holdAuth) await releaseAuth.promise;
      return auth ?? { auth: { apiKey: "synthetic-key", headers: { "X-Auth": "auth-header" } }, env: { TEST_PROVIDER_REGION: "test-region" } };
    } } },
    api: { stream() { throw new Error("Expected streamSimple"); }, streamSimple(selected, context, options) {
      if (fail) throw new Error(fail);
      const stream = ai.createAssistantMessageEventStream();
      const message = { role: "assistant", content: [text("Run the focused tests")], api: selected.api,
        provider: selected.provider, model: selected.id, stopReason: "stop", timestamp: 0,
        usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25, cost: { ...cost, total: 0 } }, ...response };
      requests.push({ model: selected, context, options, finish() {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end(message);
      } });
      requestEntered.resolve(requests.at(-1));
      if (!holdResponse) requests.at(-1).finish();
      return stream;
    } },
  });
  const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), refreshOnCreate: false,
    modelsPath: join(root, "models.json"), modelsStorePath: join(root, "models-store.json") });
  runtime.registerNativeProvider(provider);
  await runtime.refresh({ allowNetwork: false });
  const registry = new sdk.ModelRegistry(runtime);
  const ctx = { model: runtime.getModel(model.provider, model.id), modelRegistry: registry };
  t.after(() => { releaseAuth.resolve(); for (const request of requests) request.finish(); });
  return { root, runtime, registry, ctx, requests, authEntered, releaseAuth, requestEntered, get authCalls() { return authCalls; } };
}

test("installed SDK uses the registered third-party provider with active model/auth/headers/env and strict budgets", async (t) => {
  const fixture = await runtimeFixture(t);
  const controller = new AbortController();
  const usages = [];
  const result = await generateSuggestion(fixture.ctx, "Bounded conversation", controller.signal, { onUsage: value => usages.push(value) });
  assert.equal(fixture.requests.length, 1);
  const request = fixture.requests[0];
  assert.equal(request.model.id, fixture.ctx.model.id);
  assert.equal(request.model.provider, fixture.ctx.model.provider);
  assert.equal(request.model.baseUrl, fixture.ctx.model.baseUrl);
  assert.equal(request.options.apiKey, "synthetic-key");
  assert.equal(request.options.headers["X-Auth"], "auth-header");
  assert.equal(request.options.headers["X-Model"], "model-header");
  assert.equal(request.options.env.TEST_PROVIDER_REGION, "test-region");
  assert.equal(request.options.maxTokens, 128);
  assert.equal(request.options.maxRetries, 0);
  assert.equal(request.options.reasoning, undefined);
  assert.ok(request.options.timeoutMs <= 4_000);
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.equal(request.context.tools, undefined);
  assert.equal(request.context.messages.some((message) => message.tools?.length || message.role === "toolResult"), false);
  assert.deepEqual(request.context.messages.filter((message) => message.role === "user").map((message) => message.content), ["Bounded conversation"]);
  assert.equal(result.text, "Run the focused tests");
  assert.equal(result.usage.input, 20);
  assert.equal(result.usage.output, 5);
  assert.deepEqual(usages, [result.usage], "successful settlement reports usage only once and retains the standalone return value");
});

test("models.json command headers in hidden SDK composer layers never execute before rejection", async (t) => {
  for (const layer of ["provider", "model", "override"]) {
    const fixture = await runtimeFixture(t, { modelsJson(root, model) {
      const headers = { "X-Command": `!printf executed > '${join(root, "shell-sentinel")}'; printf header` };
      const config = layer === "provider" ? { headers }
        : layer === "model" ? { models: [{ id: model.id, headers }] }
          : { modelOverrides: { [model.id]: { headers } } };
      return { providers: { [model.provider]: config } };
    } });
    assert.equal(fixture.registry.getError(), undefined);
    assert.equal(fixture.registry.getRegisteredProviderConfig(fixture.ctx.model.provider), undefined);
    assert.notEqual(fixture.registry.getProviderAuthStatus(fixture.ctx.model.provider).source, "models_json_command");
    assert.equal(Object.values(fixture.ctx.model.headers ?? {}).some(value => value.startsWith("!")), false,
      "the active model does not expose command headers hidden by composition");
    assert.equal(existsSync(join(fixture.root, "shell-sentinel")), false);
    await assert.rejects(generateSuggestion(fixture.ctx, "context", new AbortController().signal), /cannot safely inspect composed/);
    assert.equal(fixture.authCalls, 0, `${layer} header rejected before native auth resolution`);
    assert.equal(fixture.requests.length, 0);
    assert.equal(existsSync(join(fixture.root, "shell-sentinel")), false, `${layer} header shell MUST NOT execute`);
  }
});

test("opaque custom-path and stale models.json snapshots fail closed even when the current file is safe", async (t) => {
  const fixture = await runtimeFixture(t, { modelsJson(root, model) {
    return { providers: { [model.provider]: { headers: {
      "X-Command": `!printf executed > '${join(root, "shell-sentinel")}'; printf header`,
    } } } };
  } });
  writeFileSync(join(fixture.root, "models.json"), '{}');
  await assert.rejects(generateSuggestion(fixture.ctx, "context", new AbortController().signal), /cannot safely inspect composed/);
  assert.equal(fixture.authCalls, 0);
  assert.equal(fixture.requests.length, 0);
  assert.equal(existsSync(join(fixture.root, "shell-sentinel")), false);
});

test("registered config and native header command values are rejected before auth or dispatch", async (t) => {
  for (const layer of ["key", "provider", "model", "native"]) {
    const fixture = await runtimeFixture(t);
    const sentinel = join(fixture.root, "shell-sentinel");
    const command = `!printf executed > '${sentinel}'; printf credential`;
    let ctx = fixture.ctx;
    if (layer === "native") {
      const native = fixture.registry.getRegisteredNativeProvider(ctx.model.provider);
      fixture.runtime.registerNativeProvider({ ...native, headers: { "X-Command": command } });
    } else {
      const id = "prompt-command-registration";
      const config = { baseUrl: "https://example.invalid", api: "openai-completions", apiKey: "synthetic-key" };
      if (layer === "key") config.apiKey = command;
      if (layer === "provider") config.headers = { "X-Command": command };
      if (layer === "model") config.models = [{ ...fixture.ctx.model, headers: { "X-Command": command } }];
      fixture.runtime.registerProvider(id, config);
      ctx = { model: { ...ctx.model, provider: id }, modelRegistry: fixture.registry };
    }
    await fixture.runtime.refresh({ allowNetwork: false });
    await assert.rejects(generateSuggestion(ctx, "context", new AbortController().signal), /command-based auth/);
    assert.equal(fixture.authCalls, 0);
    assert.equal(fixture.requests.length, 0);
    assert.equal(existsSync(sentinel), false, `${layer} command MUST NOT execute`);
  }
});

test("SDK composition-error fallback cannot disguise hidden command model headers as untouched native", async (t) => {
  const fixture = await runtimeFixture(t, { modelsJson(root, model) {
    return { providers: { [model.provider]: { models: [{ id: model.id, maxTokens: 0,
      headers: { "X-Command": `!printf executed > '${join(root, "shell-sentinel")}'; printf header` } }] } } };
  } });
  assert.match(fixture.registry.getError(), /invalid maxTokens/);
  assert.equal(fixture.registry.getProvider(fixture.ctx.model.provider),
    fixture.registry.getRegisteredNativeProvider(fixture.ctx.model.provider), "SDK fell back to the native provider");
  await assert.rejects(generateSuggestion(fixture.ctx, "context", new AbortController().signal), /cannot safely inspect composed/);
  assert.equal(fixture.authCalls, 0);
  assert.equal(fixture.requests.length, 0);
  assert.equal(existsSync(join(fixture.root, "shell-sentinel")), false);
});

test("eligibility lost during asynchronous SDK auth prevents actual provider dispatch", async (t) => {
  const fixture = await runtimeFixture(t, { holdAuth: true });
  let eligible = true;
  const usages = [];
  const pending = generateSuggestion(fixture.ctx, "context", new AbortController().signal,
    { eligible: () => eligible, onUsage: usage => usages.push(usage) });
  const rejected = assert.rejects(pending, /eligible|provider request failed/);
  await fixture.authEntered.promise;
  eligible = false;
  fixture.releaseAuth.resolve();
  await rejected;
  await flush();
  assert.equal(fixture.requests.length, 0);
  assert.equal(usages.some(usage => usage.input > 0 || usage.output > 0), false);
  await assert.rejects(generateSuggestion(fixture.ctx, "context", new AbortController().signal,
    { eligible: () => false }), /no longer eligible/);
  assert.equal(fixture.requests.length, 0);
});

test("SDK auth-selected endpoint overrides and deletion headers survive compatibility transport", async (t) => {
  const fixture = await runtimeFixture(t, { auth: { auth: { apiKey: "synthetic-key", baseUrl: "https://example.invalid/auth-selected",
    headers: { "X-Removed": null, "X-Auth": "auth-header" } }, env: { TEST_PROVIDER_REGION: "auth-region" } } });
  await generateSuggestion(fixture.ctx, "context", new AbortController().signal);
  const request = fixture.requests[0];
  assert.equal(request.model.baseUrl, "https://example.invalid/auth-selected");
  assert.equal(request.options.headers["X-Removed"], null);
  assert.equal(request.options.env.TEST_PROVIDER_REGION, "auth-region");
});

test("abort during real SDK auth rejects promptly and prevents late provider dispatch", async (t) => {
  const fixture = await runtimeFixture(t, { holdAuth: true });
  const controller = new AbortController();
  const pending = generateSuggestion(fixture.ctx, "context", controller.signal);
  const rejected = assert.rejects(pending, /cancelled|timed out/);
  await fixture.authEntered.promise;
  controller.abort();
  await rejected;
  fixture.releaseAuth.resolve();
  await flush();
  assert.equal(fixture.requests.length, 0);
});

test("whole provider deadline includes auth setup and invalidates late auth", async (t) => {
  const fixture = await runtimeFixture(t, { holdAuth: true });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const pending = generateSuggestion(fixture.ctx, "context", new AbortController().signal);
  const rejected = assert.rejects(pending, /cancelled|timed out/);
  await fixture.authEntered.promise;
  t.mock.timers.tick(4_000);
  await rejected;
  fixture.releaseAuth.resolve();
  await flush();
  assert.equal(fixture.requests.length, 0);
});

test("cancel during response aborts the provider signal and rejects completion even if the provider ignores abort", async (t) => {
  const fixture = await runtimeFixture(t, { holdResponse: true });
  const controller = new AbortController();
  const pending = generateSuggestion(fixture.ctx, "context", controller.signal);
  const rejected = assert.rejects(pending, /cancelled|timed out/);
  const request = await fixture.requestEntered.promise;
  controller.abort();
  await rejected;
  assert.equal(request.options.signal.aborted, true);
  request.finish();
  await flush();
  assert.equal(fixture.requests.length, 1);
});

test("an abort-insensitive provider cannot overlap a later request, and settlement releases the guard", async (t) => {
  const fixture = await runtimeFixture(t, { holdResponse: true });
  const controller = new AbortController();
  const pending = generateSuggestion(fixture.ctx, "first", controller.signal);
  const rejected = assert.rejects(pending, /cancelled|timed out/);
  await fixture.requestEntered.promise;
  controller.abort();
  await rejected;
  await assert.rejects(generateSuggestion(fixture.ctx, "second", new AbortController().signal), /previous provider response is still active/);
  const reloaded = await import("../packages/pi-better-harness/extensions/prompt-suggestions/provider.ts?reload-guard");
  assert.notEqual(reloaded.generateSuggestion, generateSuggestion);
  await assert.rejects(reloaded.generateSuggestion(fixture.ctx, "after reload", new AbortController().signal), /previous provider response is still active/);
  assert.equal(fixture.requests.length, 1);
  fixture.requests[0].finish();
  await flush();
  const next = generateSuggestion(fixture.ctx, "fresh", new AbortController().signal);
  await flush();
  assert.equal(fixture.requests.length, 2);
  fixture.requests[1].finish();
  assert.equal((await next).text, "Run the focused tests");
});

test("stale, aborted, and timed-out completions report sanitized usage once at settlement", async (t) => {
  for (const invalidation of ["stale", "abort", "timeout"]) {
    await t.test(invalidation, async (t) => {
      const fixture = await runtimeFixture(t, { holdResponse: true,
        response: { usage: { input: 11, output: 3, cacheRead: 0, cacheWrite: -1, totalTokens: NaN,
          cost: { total: 0, output: Infinity, secret: "synthetic-secret" }, secret: "synthetic-secret" } } });
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      const controller = new AbortController();
      const usages = [];
      let eligible = true;
      const pending = generateSuggestion(fixture.ctx, "context", controller.signal,
        { eligible: () => eligible, onUsage: usage => usages.push(usage) });
      const rejected = assert.rejects(pending, /no longer eligible|cancelled|timed out/);
      const request = await fixture.requestEntered.promise;
      if (invalidation === "stale") eligible = false;
      else if (invalidation === "abort") controller.abort();
      else t.mock.timers.tick(4_000);
      if (invalidation !== "stale") {
        await rejected;
        assert.deepEqual(usages, [], "local cancellation cannot fabricate usage before settlement");
        await assert.rejects(generateSuggestion(fixture.ctx, "overlap", new AbortController().signal), /still active/);
      }
      request.finish();
      await rejected;
      await flush();
      assert.deepEqual(usages, [{ input: 11, output: 3, cacheRead: 0, cost: { total: 0 } }]);
      request.finish();
      await flush();
      assert.equal(usages.length, 1, "repeated terminal events cannot double-count settled usage");
      assert.equal(fixture.requests.length, 1);
    });
  }
});

test("non-numeric usage remains unknown instead of becoming zero or leaking provider data", async (t) => {
  const fixture = await runtimeFixture(t, { response: { usage: { input: -1, output: "5", cacheRead: Infinity,
    totalTokens: NaN, cost: { total: -1, secret: "synthetic-secret" }, secret: "synthetic-secret" } } });
  const usages = [];
  const result = await generateSuggestion(fixture.ctx, "context", new AbortController().signal,
    { onUsage: usage => usages.push(usage) });
  assert.equal(result.usage, undefined);
  assert.deepEqual(usages, []);
  assert.equal(result.text, "Run the focused tests");
});

test("unbounded bundled APIs and command-based auth fail before inference, while a native bounded custom transport remains usable", async (t) => {
  const fixture = await runtimeFixture(t);
  for (const [provider, api, reason] of [["openai-codex", "openai-codex-responses", /output token cap/],
    ["amazon-bedrock", "bedrock-converse-stream", /disable retries/]]) {
    await assert.rejects(generateSuggestion({ model: { ...fixture.ctx.model, provider, api }, modelRegistry: fixture.registry },
      "context", new AbortController().signal), reason);
  }
  fixture.runtime.registerProvider("command-auth-fixture", {
    baseUrl: "https://example.invalid", api: "openai-completions", apiKey: "!must-not-execute",
  });
  await assert.rejects(generateSuggestion({ model: { ...fixture.ctx.model, provider: "command-auth-fixture" }, modelRegistry: fixture.registry },
    "context", new AbortController().signal), /command-based auth/);
  assert.equal(fixture.requests.length, 0);
  const native = await runtimeFixture(t, { api: "openai-codex-responses" });
  await generateSuggestion(native.ctx, "context", new AbortController().signal);
  assert.equal(native.requests.length, 1);
  assert.equal(native.requests[0].options.maxTokens, 128);
});

test("transport refuses unsupported, incomplete, tool, and failed output without leaking SDK exceptions", async (t) => {
  for (const response of [
    { stopReason: "length" }, { stopReason: "toolUse", content: [{ type: "toolCall", name: "bash", arguments: {} }] },
    { stopReason: "stop", content: [text("Next"), { type: "toolCall", name: "bash", arguments: {} }] },
    { stopReason: "error", errorMessage: "synthetic-secret" }, { stopReason: "aborted" },
  ]) {
    const usages = [];
    const fixture = await runtimeFixture(t, { response: { ...response, usage: { input: 20, output: 5, cacheRead: -1,
      cacheWrite: Infinity, totalTokens: "25", cost: { total: 0.125, input: NaN, secret: "synthetic-secret" },
      secret: "synthetic-secret" } } });
    await assert.rejects(generateSuggestion(fixture.ctx, "context", new AbortController().signal, { onUsage: value => usages.push(value) }),
      (error) => /failed|incomplete|tool response/.test(error.message) && !error.message.includes("synthetic-secret"));
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(usages, [{ input: 20, output: 5, cost: { total: 0.125 } }],
      "invalid result usage is sanitized and reported once, independently of output validation");
  }
  const failed = await runtimeFixture(t, { fail: "Prompt suggestions: synthetic-secret" });
  await assert.rejects(generateSuggestion(failed.ctx, "context", new AbortController().signal),
    (error) => /^Prompt suggestions: provider (request|transport) failed$/.test(error.message));
  await assert.rejects(generateSuggestion({ model: failed.ctx.model, modelRegistry: {} }, "context", new AbortController().signal), /compatible public provider transport/);
  await assert.rejects(generateSuggestion({ model: undefined }, "context", new AbortController().signal), /active model/);
  await assert.rejects(generateSuggestion({ model: { ...failed.ctx.model, api: "pi-virtual" } }, "context", new AbortController().signal), /physical model/);
  await assert.rejects(generateSuggestion(failed.ctx, "x".repeat(8_001), new AbortController().signal), /Invalid.*context/);
});

test("opaque extension-registered transport/auth/header composition fails closed without falling back", async (t) => {
  const fixture = await runtimeFixture(t);
  const calls = [];
  const originalKey = process.env.PROMPT_TEST_KEY;
  const originalHeader = process.env.PROMPT_TEST_HEADER;
  process.env.PROMPT_TEST_KEY = "synthetic-extension-key";
  process.env.PROMPT_TEST_HEADER = "resolved-extension-header";
  t.after(() => {
    for (const [key, original] of [["PROMPT_TEST_KEY", originalKey], ["PROMPT_TEST_HEADER", originalHeader]]) {
      if (original === undefined) delete process.env[key]; else process.env[key] = original;
    }
  });
  fixture.runtime.registerProvider("prompt-extension-fixture", {
    baseUrl: "https://example.invalid/custom", api: "prompt-custom-api", apiKey: "$PROMPT_TEST_KEY", authHeader: true,
    headers: { "X-Extension": "$PROMPT_TEST_HEADER" },
    models: [{ id: "custom", name: "Custom", input: ["text"], reasoning: false, contextWindow: 128_000,
      maxTokens: 1_024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, headers: { "X-Model": "$PROMPT_TEST_HEADER" } }],
    streamSimple(model, context, options) {
      calls.push({ model, context, options });
      const stream = ai.createAssistantMessageEventStream();
      const message = { role: "assistant", content: [text("Check the regression")], api: model.api, provider: model.provider,
        model: model.id, stopReason: "stop", timestamp: 0,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return stream;
    },
  });
  const model = fixture.runtime.getModel("prompt-extension-fixture", "custom");
  await assert.rejects(generateSuggestion({ model, modelRegistry: fixture.registry }, "context", new AbortController().signal),
    /cannot safely inspect composed auth\/header configuration/);
  assert.equal(fixture.requests.length, 0, "never fall back to another registered provider");
  assert.equal(calls.length, 0);
});

test("preferences default off, require a boolean, persist atomically in the user agent dir, and leave other files alone", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-prompt-preferences-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  t.after(() => {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
    rmSync(root, { recursive: true, force: true });
  });
  const dir = process.env.PI_CODING_AGENT_DIR;
  const file = join(dir, "harness-prompt-suggestions.json");
  assert.deepEqual(readPreferences(), { enabled: false });
  writeEnabled(true);
  assert.deepEqual(readPreferences(), { enabled: true });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  writeFileSync(join(dir, "settings.json"), '{"unchanged":true}');
  for (const malformed of ["invalid-json", "null", '"on"', '{"enabled":"true"}', '{"enabled":1}', '{}']) {
    writeFileSync(file, malformed);
    assert.deepEqual(readPreferences(), { enabled: false });
  }
  assert.throws(() => writeEnabled("on"), /must be boolean/);
  writeEnabled(false);
  assert.deepEqual(readPreferences(), { enabled: false });
  const foreign = join(root, "foreign.json");
  writeFileSync(foreign, '{"untouched":true}');
  rmSync(file);
  symlinkSync(foreign, file);
  writeEnabled(true);
  assert.equal(readFileSync(foreign, "utf8"), '{"untouched":true}', "atomic replacement must not follow a destination symlink");
  assert.deepEqual(readPreferences(), { enabled: true });
  assert.equal(readFileSync(join(dir, "settings.json"), "utf8"), '{"unchanged":true}');
  rmSync(file);
  mkdirSync(file);
  assert.throws(() => writeEnabled(false), (error) => ["EISDIR", "EPERM", "EACCES"].includes(error.code));
  assert.deepEqual(readdirSync(dir).sort(), ["harness-prompt-suggestions.json", "settings.json"], "failed writes clean up their temporary file");
});
