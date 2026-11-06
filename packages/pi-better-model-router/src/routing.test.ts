import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension, { route, type VirtualDefinition } from "./index.ts";
import { defaults, chooseCandidate, isTransient, ratesAt, resolveCandidates } from "./routing.ts";
import { parseConfig, loadConfig } from "./config.ts";

const catalog = [
  { provider: "deepseek", id: "deepseek-flash", api: "openai-completions", cost: { input: 0.3, output: 1.2, cacheRead: 0.006 } },
  { provider: "ollama-cloud", id: "deepseek-v4.1-flash:cloud", api: "openai-completions", cost: { input: 0.3, output: 1.2, cacheRead: 0.006 } },
];
const candidates = resolveCandidates(catalog);

test("UTC weekday schedule routes around both providers' peak boundaries", () => {
  for (const [time, provider] of [
    ["00:59", "deepseek"], ["01:00", "ollama-cloud"], ["03:59", "ollama-cloud"],
    ["04:00", "deepseek"], ["06:00", "ollama-cloud"], ["10:00", "deepseek"],
    ["12:00", "deepseek"], ["17:59", "deepseek"], ["18:00", "deepseek"],
  ]) {
    const date = new Date("2026-10-26T" + time + ":00Z");
    assert.equal(chooseCandidate(defaults, candidates, date).provider, provider, time);
  }
  const ollama = candidates[1];
  assert.equal(ratesAt(ollama, new Date("2026-10-26T12:00Z")).output, 1.2);
  assert.equal(ratesAt(ollama, new Date("2026-10-26T18:00Z")).output, 0.6);
});
test("weekends and bundled holiday exceptions use off-peak rates; ties prefer DeepSeek", () => {
  assert.equal(ratesAt(candidates[0], new Date("2026-10-25T02:00Z")).output, 0.6);
  const holiday = { ...candidates[0], offPeakDates: ["2026-10-26"] };
  assert.equal(ratesAt(holiday, new Date("2026-10-26T02:00Z")).output, 0.6);
  assert.equal(chooseCandidate(defaults, candidates, new Date("2026-10-26T20:00Z"),
    { provider: "ollama-cloud", id: candidates[1].model }).provider, "deepseek");
});
test("custom rates use both token estimates and unavailable candidates cannot win", () => {
  const config = { ...defaults, estimatedInputTokens: 1, estimatedOutputTokens: 100,
    candidates: candidates.map((c, i) => ({ ...c, offPeak: { input: i ? 10 : 0, output: i ? 0 : 10, cacheRead: 0 } })) };
  assert.equal(chooseCandidate(config, config.candidates, new Date("2026-10-25T00:00Z")).provider, "ollama-cloud");
  assert.equal(chooseCandidate(defaults, [candidates[0]], new Date("2026-10-26T02:00Z")).provider, "deepseek");
  assert.throws(() => chooseCandidate(defaults, [], new Date()), /no eligible Flash model/);
});
test("policy config rejects model settings, unknown fields, and invalid weights", () => {
  for (const config of [
    { candidates: [] }, { model: "another-model" }, { peakWindows: [] },
    { estimatedInputTokens: 0 }, { preferredProvider: "unknown" }, { preferredProvider: null },
    { type: "unknown" }, { pricing: { deepseek: { peak: { input: -1 } } } },
    { pricing: { deepseek: { peakWindows: [[240, 60]] } } },
    { pricing: { deepseek: { offPeakDates: ["2026-02-30"] } } },
    { pricing: { deepseek: { model: "another-model" } } },
    { pricing: { deepseek: { peak: { typo: 1 } } } },
  ]) assert.throws(() => parseConfig(config), /Invalid/);
  assert.equal(parseConfig({}).preferredProvider, "deepseek");
  assert.equal(parseConfig({}).type, "price");
});
test("candidate resolution reuses catalog IDs and price overrides without redefining models", () => {
  const overridden = resolveCandidates([
    { ...catalog[0], cost: { input: 2, output: 4, cacheRead: 0.1 } },
    { ...catalog[1], id: "deepseek-v4.1-flash:1017-cloud" },
    { ...catalog[1], id: "unrelated-model" },
  ]);
  assert.equal(overridden[0].peak.input, 2);
  assert.equal(overridden[0].offPeak.output, 2);
  assert.equal(overridden[1].model, "deepseek-v4.1-flash:1017-cloud");
  assert.equal(overridden.length, 2);
  assert.deepEqual(resolveCandidates([{ ...catalog[0], api: "pi-virtual" }]), []);
  assert.throws(() => resolveCandidates([{ ...catalog[0], cost: { input: 0, output: 0, cacheRead: 0 } }]), /catalog pricing/);
});
test("project config overrides user config and malformed JSON is actionable", () => {
  const root = mkdtempSync(join(tmpdir(), "model-router-"));
  try {
    const agent = join(root, "agent"); const cwd = join(root, "project");
    mkdirSync(agent); mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(agent, "model-router.json"), JSON.stringify({ preferredProvider: "ollama-cloud", estimatedInputTokens: 123,
      pricing: { deepseek: { peak: { input: 0.8, output: 2 }, peakWindows: [[0, 60]] },
        "ollama-cloud": { offPeak: { output: 0.4 } } } }));
    writeFileSync(join(cwd, ".pi", "model-router.json"), JSON.stringify({ preferredProvider: "deepseek",
      pricing: { deepseek: { peak: { output: 3 }, peakWindows: [] } } }));
    assert.equal(loadConfig(agent, cwd).preferredProvider, "deepseek");
    assert.equal(loadConfig(agent, cwd).estimatedInputTokens, 123);
    const merged = loadConfig(agent, cwd);
    assert.deepEqual(merged.pricing.deepseek?.peak, { input: 0.8, output: 3 });
    assert.deepEqual(merged.pricing.deepseek?.peakWindows, []);
    assert.equal(merged.pricing["ollama-cloud"]?.offPeak?.output, 0.4);
    writeFileSync(join(cwd, ".pi", "model-router.json"), "{");
    assert.throws(() => loadConfig(agent, cwd), /Model router config/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("registered route preserves continuations and bounds transient fallback", () => {
  const cwd = mkdtempSync(join(tmpdir(), "model-router-route-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  try {
    let definition: VirtualDefinition | undefined;
    extension({ registerVirtualModel(d: VirtualDefinition) { definition = d; } } as unknown as ExtensionAPI);
    assert.equal(definition?.provider + "/" + definition?.id, "router/deepseek-flash-auto");
    const models = [...catalog];
    const ctx = { cwd, modelRegistry: { getAvailable: () => models } } as unknown as ExtensionContext;
    const now = new Date("2026-10-26T02:00Z");
    const selected = route({ reason: "user", thinkingLevel: "high" }, ctx, now);
    assert.equal(selected.model.provider, "ollama-cloud");
    mkdirSync(join(cwd, ".pi"));
    const policyPath = join(cwd, ".pi", "model-router.json");
    writeFileSync(policyPath, JSON.stringify({ type: "price", pricing: {
      "ollama-cloud": { offPeak: { input: 5, output: 10 } },
    } }));
    assert.equal(route({ reason: "user", thinkingLevel: "high" }, ctx, now).model.provider, "deepseek");
    rmSync(policyPath);
    const continued = route({ reason: "continuation", thinkingLevel: "high", previous: selected }, ctx,
      new Date("2026-10-26T12:00Z"));
    assert.equal(continued.model.provider, "deepseek");
    const failed = { ...selected, message: { errorMessage: "429 rate limit" } };
    const fallback = route({ reason: "retry", thinkingLevel: "high", failed }, ctx, now);
    assert.equal(fallback.model.provider, "deepseek");
    // Every candidate timed out, so the retry reuses one of them instead of ending the turn.
    const recovered = route({ reason: "retry", thinkingLevel: "high", state: fallback.state,
      failed: { ...fallback, message: { errorMessage: "503 overloaded" } } }, ctx, now);
    assert.equal(recovered.model.provider, "ollama-cloud");
    assert.deepEqual(recovered.state, { failedProviders: [] });
    assert.equal(route({ reason: "retry", thinkingLevel: "high",
      failed: { ...selected, message: { errorMessage: "context_length_exceeded" } } }, ctx, now).model.provider, "ollama-cloud");
    assert.equal(route({ reason: "user", thinkingLevel: "high", state: fallback.state }, ctx, now).model.provider, "ollama-cloud");
    models.splice(1, 1);
    assert.equal(route({ reason: "user", thinkingLevel: "high" }, ctx, now).model.provider, "deepseek");
  } finally {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = original;
    rmSync(cwd, { recursive: true, force: true });
  }
});
test("continuations keep the cheapest model and switch when another provider is cheaper", () => {
  const cwd = mkdtempSync(join(tmpdir(), "model-router-switch-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  try {
    const models = [...catalog];
    const ctx = { cwd, modelRegistry: { getAvailable: () => models } } as unknown as ExtensionContext;
    const monday = (time: string) => new Date("2026-10-26T" + time + ":00Z");
    const selected = route({ reason: "user", thinkingLevel: "high" }, ctx, monday("02:00"));
    assert.equal(selected.model.provider, "ollama-cloud");
    // DeepSeek is still at peak, so Ollama stays cheapest and the turn keeps its model.
    assert.equal(route({ reason: "continuation", thinkingLevel: "high", previous: selected }, ctx,
      monday("03:00")).model.provider, "ollama-cloud");
    // Both providers are off-peak from 10:00. A tie keeps the current provider
    // instead of paying a cold prompt cache for no gain.
    assert.equal(route({ reason: "continuation", thinkingLevel: "high", previous: selected }, ctx,
      monday("10:00")).model.provider, "ollama-cloud");
    // Ollama opens its peak window at 12:00, so the continuation moves to DeepSeek.
    const switched = route({ reason: "continuation", thinkingLevel: "high", previous: selected }, ctx, monday("12:00"));
    assert.equal(switched.model.provider, "deepseek");
    // A model chosen on Monday evening moves when DeepSeek enters its own peak window.
    const overnight = route({ reason: "user", thinkingLevel: "low" }, ctx, monday("20:00"));
    assert.equal(overnight.model.provider, "deepseek");
    const tuesday = route({ reason: "continuation", thinkingLevel: "low", previous: overnight }, ctx,
      new Date("2026-10-27T02:00Z"));
    assert.equal(tuesday.model.provider, "ollama-cloud");
    assert.equal(tuesday.thinkingLevel, "low");
    // Weekends are off-peak for both providers, so a tie keeps Ollama even though a
    // user turn would prefer DeepSeek.
    assert.equal(route({ reason: "user", thinkingLevel: "high" }, ctx,
      new Date("2026-10-25T12:00Z")).model.provider, "deepseek");
    assert.equal(route({ reason: "continuation", thinkingLevel: "high", previous: selected }, ctx,
      new Date("2026-10-25T12:00Z")).model.provider, "ollama-cloud");
  } finally {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = original;
    rmSync(cwd, { recursive: true, force: true });
  }
});
test("retries move to the other candidate except after a context overflow", () => {
  const cwd = mkdtempSync(join(tmpdir(), "model-router-retry-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  try {
    const models = [...catalog];
    const ctx = { cwd, modelRegistry: { getAvailable: () => models } } as unknown as ExtensionContext;
    const now = new Date("2026-10-26T02:00Z");
    const selected = route({ reason: "user", thinkingLevel: "high" }, ctx, now);
    assert.equal(selected.model.provider, "ollama-cloud");
    const retry = (errorMessage: string) => route({ reason: "retry", thinkingLevel: "high",
      failed: { ...selected, message: { errorMessage } } }, ctx, now).model.provider;
    assert.equal(retry("429 rate limit"), "deepseek");
    assert.equal(retry("400 invalid_request_error: tools[0] schema is invalid"), "deepseek");
    assert.equal(retry("401 invalid api key"), "deepseek");
    assert.equal(retry("context_length_exceeded"), "ollama-cloud");
    assert.equal(retry("This model's maximum context length is 65536 tokens"), "ollama-cloud");
  } finally {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = original;
    rmSync(cwd, { recursive: true, force: true });
  }
});
test("router state is reported only when the excluded providers change", () => {
  const cwd = mkdtempSync(join(tmpdir(), "model-router-state-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  try {
    const models = [...catalog];
    const ctx = { cwd, modelRegistry: { getAvailable: () => models } } as unknown as ExtensionContext;
    const now = new Date("2026-10-26T02:00Z");
    const selected = route({ reason: "user", thinkingLevel: "high" }, ctx, now);
    assert.equal("state" in selected, false);
    const failed = { ...selected, message: { errorMessage: "503 overloaded" } };
    const fallback = route({ reason: "retry", thinkingLevel: "high", failed }, ctx, now);
    assert.deepEqual(fallback.state, { failedProviders: [], transientProviders: ["ollama-cloud"] });
    // Pi appends a session entry for every state object it receives, so an unchanged
    // exclusion list must not be reported again on each request.
    assert.equal("state" in route({ reason: "continuation", thinkingLevel: "high",
      previous: fallback, state: fallback.state }, ctx, now), false);
    assert.deepEqual(route({ reason: "user", thinkingLevel: "high", state: fallback.state }, ctx, now).state,
      { failedProviders: [] });
    assert.equal("state" in route({ reason: "user", thinkingLevel: "high",
      state: { failedProviders: [] } }, ctx, now), false);
  } finally {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = original;
    rmSync(cwd, { recursive: true, force: true });
  }
});
test("declared limits cover a routing error that names no physical model", () => {
  let definition: VirtualDefinition | undefined;
  extension({ registerVirtualModel(d: VirtualDefinition) { definition = d; } } as unknown as ExtensionAPI);
  // Pi reads the virtual model's window whenever a response carries no physical model, and
  // the router's own routing error is such a response. An undeclared window becomes zero,
  // which makes every conversation look over the threshold and compacts it after each error.
  assert.equal(definition?.contextWindow, 1_000_000);
  assert.equal(definition?.maxTokens, 384_000);
});
test("outage errors stay retryable while rejected requests are final", () => {
  for (const message of ["Request timed out.", "Connection error.", "terminated", "502 <html>",
    "ECONNRESET", "Upstream HTTP/2 stream failed", "This operation was aborted"]) {
    assert.equal(isTransient(message), true, message);
  }
  for (const message of ["400 invalid_request_error: tools[0] schema is invalid", "401 invalid api key",
    "This model's maximum context length is 65536 tokens", "Model router: no eligible Flash model is available."]) {
    assert.equal(isTransient(message), false, message);
  }
});
test("rejected requests end the turn while a transient failure only demotes the provider", () => {
  const cwd = mkdtempSync(join(tmpdir(), "model-router-outage-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  try {
    const models = [...catalog];
    const ctx = { cwd, modelRegistry: { getAvailable: () => models } } as unknown as ExtensionContext;
    const now = new Date("2026-10-26T02:00Z");
    const selected = route({ reason: "user", thinkingLevel: "high" }, ctx, now);
    assert.equal(selected.model.provider, "ollama-cloud");
    // A rejected request is final for the turn, so the other candidate takes over.
    const rejected = route({ reason: "retry", thinkingLevel: "high",
      failed: { ...selected, message: { errorMessage: "400 invalid_request_error" } } }, ctx, now);
    assert.equal(rejected.model.provider, "deepseek");
    assert.deepEqual(rejected.state, { failedProviders: ["ollama-cloud"] });
    // Two rejected providers leave no route, which is still the documented outcome.
    assert.throws(() => route({ reason: "retry", thinkingLevel: "high", state: rejected.state,
      failed: { ...rejected, message: { errorMessage: "400 invalid_request_error" } } }, ctx, now),
      /no eligible Flash model/);
    // A timeout only sends the next attempt elsewhere; the turn keeps both routes.
    const timedOut = route({ reason: "retry", thinkingLevel: "high",
      failed: { ...selected, message: { errorMessage: "Request timed out." } } }, ctx, now);
    assert.equal(timedOut.model.provider, "deepseek");
    assert.deepEqual(timedOut.state, { failedProviders: [], transientProviders: ["ollama-cloud"] });
    const continued = route({ reason: "continuation", thinkingLevel: "high",
      previous: timedOut, state: timedOut.state }, ctx, now);
    assert.equal(continued.model.provider, "deepseek");
    // A rejected request on the current provider leaves the demoted one as the only route,
    // so it is retried rather than ending the turn.
    const rejectedAgain = route({ reason: "retry", thinkingLevel: "high", state: timedOut.state,
      failed: { ...timedOut, message: { errorMessage: "400 invalid_request_error" } } }, ctx, now);
    assert.equal(rejectedAgain.model.provider, "ollama-cloud");
    assert.deepEqual(rejectedAgain.state, { failedProviders: ["deepseek"] });
  } finally {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = original;
    rmSync(cwd, { recursive: true, force: true });
  }
});
test("old Pi hosts receive an actionable compatibility error", () => {
  assert.throws(() => extension({} as ExtensionAPI), /requires Pi with registerVirtualModel/);
});
