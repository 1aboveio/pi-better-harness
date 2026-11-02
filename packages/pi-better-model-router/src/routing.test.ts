import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension, { route, type VirtualDefinition } from "./index.ts";
import { defaults, chooseCandidate, ratesAt } from "./routing.ts";
import { parseConfig, loadConfig } from "./config.ts";

test("UTC weekday schedule routes around both providers' peak boundaries", () => {
  for (const [time, provider] of [
    ["00:59", "deepseek"], ["01:00", "ollama-cloud"], ["03:59", "ollama-cloud"],
    ["04:00", "deepseek"], ["06:00", "ollama-cloud"], ["10:00", "deepseek"],
    ["12:00", "deepseek"], ["17:59", "deepseek"], ["18:00", "deepseek"],
  ]) {
    const date = new Date("2026-10-26T" + time + ":00Z");
    assert.equal(chooseCandidate(defaults, defaults.candidates, date).provider, provider, time);
  }
  const ollama = defaults.candidates[1];
  assert.equal(ratesAt(ollama, new Date("2026-10-26T12:00Z")).output, 1.2);
  assert.equal(ratesAt(ollama, new Date("2026-10-26T18:00Z")).output, 0.6);
});
test("weekends and configured holidays use off-peak rates; ties preserve provider", () => {
  assert.equal(ratesAt(defaults.candidates[0], new Date("2026-10-25T02:00Z")).output, 0.6);
  const holiday = { ...defaults.candidates[0], offPeakDates: ["2026-10-26"] };
  assert.equal(ratesAt(holiday, new Date("2026-10-26T02:00Z")).output, 0.6);
  assert.equal(chooseCandidate(defaults, defaults.candidates, new Date("2026-10-26T20:00Z"),
    { provider: "ollama-cloud", id: defaults.candidates[1].model }).provider, "ollama-cloud");
});
test("custom rates use both token estimates and unavailable candidates cannot win", () => {
  const config = { ...defaults, estimatedInputTokens: 1, estimatedOutputTokens: 100,
    candidates: defaults.candidates.map((c, i) => ({ ...c, offPeak: { input: i ? 10 : 0, output: i ? 0 : 10, cacheRead: 0 } })) };
  assert.equal(chooseCandidate(config, config.candidates, new Date("2026-10-25T00:00Z")).provider, "ollama-cloud");
  assert.equal(chooseCandidate(defaults, [defaults.candidates[0]], new Date("2026-10-26T02:00Z")).provider, "deepseek");
  assert.throws(() => chooseCandidate(defaults, [], new Date()), /no configured candidate/);
});
test("invalid schedules and rates are rejected", () => {
  for (const change of [
    { peakWindows: [[240, 60]] }, { peak: { input: -1, output: 1, cacheRead: 0 } },
    { offPeakDates: ["2026-02-30"] }, { model: "" },
  ]) assert.throws(() => parseConfig({ candidates: [{ ...defaults.candidates[0], ...change }] }), /Invalid/);
});
test("project config overrides user config and malformed JSON is actionable", () => {
  const root = mkdtempSync(join(tmpdir(), "model-router-"));
  try {
    const agent = join(root, "agent"); const cwd = join(root, "project");
    mkdirSync(agent); mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(agent, "model-router.json"), JSON.stringify({ preferredProvider: "ollama-cloud", estimatedInputTokens: 123 }));
    writeFileSync(join(cwd, ".pi", "model-router.json"), JSON.stringify({ preferredProvider: "deepseek" }));
    assert.equal(loadConfig(agent, cwd).preferredProvider, "deepseek");
    assert.equal(loadConfig(agent, cwd).estimatedInputTokens, 123);
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
    const models = defaults.candidates.map(c => ({ provider: c.provider, id: c.model, api: "openai-completions" }));
    const ctx = { cwd, modelRegistry: { getAvailable: () => models } } as unknown as ExtensionContext;
    const now = new Date("2026-10-26T02:00Z");
    const selected = route({ reason: "user", thinkingLevel: "high" }, ctx, now);
    assert.equal(selected.model.provider, "ollama-cloud");
    const continued = route({ reason: "continuation", thinkingLevel: "high", previous: selected }, ctx,
      new Date("2026-10-26T12:00Z"));
    assert.equal(continued.model.provider, "ollama-cloud");
    const failed = { ...selected, message: { errorMessage: "429 rate limit" } };
    const fallback = route({ reason: "retry", thinkingLevel: "high", failed }, ctx, now);
    assert.equal(fallback.model.provider, "deepseek");
    assert.throws(() => route({ reason: "retry", thinkingLevel: "high", state: fallback.state,
      failed: { ...fallback, message: { errorMessage: "503 overloaded" } } }, ctx, now), /no configured candidate/);
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
