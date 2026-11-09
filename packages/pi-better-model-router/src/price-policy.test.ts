import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "./config.ts";
import { chooseCandidate, resolveCandidates, ratesAt } from "./routing.ts";

const models = [
  { provider: "deepseek", id: "deepseek-flash", api: "openai-completions", cost: { input: 0.3, output: 1.2, cacheRead: 0.006 } },
  { provider: "ollama-cloud", id: "deepseek-v4.1-flash:cloud", api: "openai-completions", cost: { input: 0.3, output: 1.2, cacheRead: 0.006 } },
];
test("price overrides change the winning provider without changing model definitions", () => {
  const config = parseConfig({ type: "price", pricing: {
    deepseek: { offPeak: { input: 0.6, output: 2.4 } },
  } });
  const candidates = resolveCandidates(models, config);
  assert.equal(chooseCandidate(config, candidates, new Date("2026-10-26T12:30Z")).provider, "ollama-cloud");
  assert.equal(candidates[0].peak.input, 0.3);
  assert.equal(candidates[0].offPeak.cacheRead, 0.003);
  assert.equal(models[0].cost.input, 0.3);
});
test("peak overrides supply the default discounted rate; explicit off-peak fields win", () => {
  const config = parseConfig({ pricing: { deepseek: {
    peak: { input: 0.8, output: 2 }, offPeak: { output: 0.7 },
  } } });
  const [candidate] = resolveCandidates(models, config);
  assert.equal(candidate.offPeak.input, 0.4);
  assert.equal(candidate.offPeak.output, 0.7);
});
test("schedule and holiday overrides determine when each rate applies", () => {
  const config = parseConfig({ pricing: { deepseek: {
    peakWindows: [[720, 780]], offPeakDates: ["2026-10-27"],
  } } });
  const [candidate] = resolveCandidates(models, config);
  for (const [instant, expected] of [
    ["2026-10-26T11:59Z", 0.6], ["2026-10-26T12:00Z", 1.2],
    ["2026-10-26T13:00Z", 0.6], ["2026-10-27T12:30Z", 0.6],
    ["2026-10-25T12:30Z", 0.6],
  ] as const) assert.equal(ratesAt(candidate, new Date(instant)).output, expected, instant);
});
test("explicit free-rate overrides are allowed, while absent catalog prices still fail", () => {
  const unpriced = [{ ...models[0], cost: { input: 0, output: 0, cacheRead: 0 } }];
  assert.throws(() => resolveCandidates(unpriced, parseConfig({ pricing: { deepseek: {} } })), /catalog pricing/);
  for (const peak of [{ cacheRead: 0.01 }, { input: 0.3 }, { output: 1.2 }]) {
    assert.throws(() => resolveCandidates(unpriced, parseConfig({ pricing: { deepseek: { peak } } })), /catalog pricing/);
  }
  assert.throws(() => resolveCandidates([{ ...models[0], cost: { input: 0.3, output: 0, cacheRead: 0 } }]), /catalog pricing/);
  const config = parseConfig({ pricing: { deepseek: { peak: { input: 0, output: 0 } } } });
  assert.equal(resolveCandidates(unpriced, config)[0].offPeak.output, 0);
});
