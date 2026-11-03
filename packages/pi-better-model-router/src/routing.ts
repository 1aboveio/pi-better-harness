export interface Rates { input: number; output: number; cacheRead: number }
export interface Candidate {
  provider: string;
  model: string;
  peak: Rates;
  offPeak: Rates;
  peakWindows: [number, number][];
  offPeakDates: string[];
}
export interface PricingOverride {
  peak?: Partial<Rates>;
  offPeak?: Partial<Rates>;
  peakWindows?: [number, number][];
  offPeakDates?: string[];
}
export interface RouterConfig {
  type: "price";
  pricing: Partial<Record<"deepseek" | "ollama-cloud", PricingOverride>>;
  preferredProvider: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
}
export interface CatalogModel {
  provider: string;
  id: string;
  api: string;
  cost: Rates;
}
export interface CandidateSpec {
  provider: keyof RouterConfig["pricing"];
  ids: readonly string[];
  prefix?: string;
  windows: [number, number][];
}
// Shared by runtime selection and child dependency discovery. IDs are ordered
// by preference; prefix matches are considered only after all exact IDs.
export const candidateSpecs: readonly CandidateSpec[] = [
  { provider: "deepseek", ids: ["deepseek-flash", "deepseek-v4-flash"], windows: [[60, 240], [360, 600]] },
  { provider: "ollama-cloud", ids: ["deepseek-v4.1-flash:cloud", "deepseek-v4.1-flash"],
    prefix: "deepseek-v4.1-flash:", windows: [[720, 1080]] },
];
// Use catalog metadata and bundled schedules unless the price policy overrides
// a rate or calendar rule. Physical model definitions remain owned by Pi.
export function resolveCandidates(models: readonly CatalogModel[], config: RouterConfig = defaults): Candidate[] {
  return candidateSpecs.flatMap(spec => {
    const pool = models.filter(m => m.provider === spec.provider && m.api !== "pi-virtual");
    const model = spec.ids.map(id => pool.find(m => m.id === id)).find(Boolean)
      ?? (spec.prefix !== undefined
        ? pool.filter(m => m.id.startsWith(spec.prefix!)).sort((a, b) => a.id.localeCompare(b.id))[0]
        : undefined);
    if (!model) return [];
    const override = config.pricing[spec.provider];
    const peak = { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead, ...override?.peak };
    const offPeak = { input: peak.input / 2, output: peak.output / 2, cacheRead: peak.cacheRead / 2, ...override?.offPeak };
    if (![...Object.values(peak), ...Object.values(offPeak)].every(n => Number.isFinite(n) && n >= 0) ||
        (["input", "output"] as const).some(field => peak[field] === 0 && override?.peak?.[field] === undefined)) {
      throw new Error(`Model router: ${model.provider}/${model.id} needs nonzero catalog pricing. Set cost in Pi's models.json.`);
    }
    return [{ provider: model.provider, model: model.id, peak,
      offPeak, peakWindows: override?.peakWindows ?? spec.windows,
      offPeakDates: override?.offPeakDates ?? [] }];
  });
}
export const defaults: RouterConfig = {
  type: "price",
  pricing: {},
  preferredProvider: "deepseek",
  estimatedInputTokens: 10000,
  estimatedOutputTokens: 2000,
};
export function ratesAt(candidate: Candidate, now: Date): Rates {
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  const weekday = now.getUTCDay() >= 1 && now.getUTCDay() <= 5;
  const holiday = candidate.offPeakDates.includes(now.toISOString().slice(0, 10));
  return weekday && !holiday && candidate.peakWindows.some(([start, end]) => minute >= start && minute < end)
    ? candidate.peak : candidate.offPeak;
}
export function estimatedCost(config: RouterConfig, candidate: Candidate, now: Date): number {
  const rates = ratesAt(candidate, now);
  return rates.input * config.estimatedInputTokens + rates.output * config.estimatedOutputTokens;
}
// A continuation keeps its model unless another candidate is strictly cheaper, so a
// price boundary can move a long turn. Equal cost keeps the current provider: a switch
// would pay a cold prompt cache for no gain.
export function isCheapest(config: RouterConfig, candidate: Candidate, available: Candidate[], now: Date): boolean {
  const own = estimatedCost(config, candidate, now);
  return available.every(other => estimatedCost(config, other, now) >= own - 1e-9);
}
export function chooseCandidate(config: RouterConfig, available: Candidate[], now: Date,
  previous?: { provider: string; id: string }): Candidate {
  if (!available.length) throw new Error("Model router: no eligible Flash model is available. Check Pi's model catalog and provider login.");
  const score = (candidate: Candidate) => estimatedCost(config, candidate, now);
  const best = Math.min(...available.map(score));
  const tied = available.filter(candidate => Math.abs(score(candidate) - best) < 1e-9);
  return tied.find(candidate => candidate.provider === config.preferredProvider)
    ?? tied.find(candidate => candidate.provider === previous?.provider && candidate.model === previous.id) ?? tied[0];
}
export function isTransient(error: string): boolean {
  return /\b429\b|\b50[0234]\b|rate.?limit|overload|temporar(?:y|ily)|service unavailable|timed? ?out|ECONNRESET|ECONNREFUSED|fetch failed/i.test(error);
}
// Pi retries a context overflow after compacting the conversation. That retry keeps
// the failed model, because a switch would pay a cold cache right after compaction.
export function isContextOverflow(error: string): boolean {
  return /context.?(length|window)|too many tokens|prompt is too long|exceeds? (?:the )?(?:maximum )?(?:context|token)|reduce the length of the (?:messages|prompt)/i.test(error);
}
