import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension, { route, type VirtualDefinition } from "./index.ts";
import { defaults, chooseCandidate, ratesAt, resolveCandidates } from "./routing.ts";
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
    assert.equal(continued.model.provider, "ollama-cloud");
    const failed = { ...selected, message: { errorMessage: "429 rate limit" } };
    const fallback = route({ reason: "retry", thinkingLevel: "high", failed }, ctx, now);
    assert.equal(fallback.model.provider, "deepseek");
    assert.throws(() => route({ reason: "retry", thinkingLevel: "high", state: fallback.state,
      failed: { ...fallback, message: { errorMessage: "503 overloaded" } } }, ctx, now), /no eligible Flash model/);
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
test("old Pi hosts receive an actionable compatibility error", () => {
  assert.throws(() => extension({} as ExtensionAPI), /requires Pi with registerVirtualModel/);
});
