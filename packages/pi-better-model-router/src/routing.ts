export interface Rates { input: number; output: number; cacheRead: number }
export interface Candidate {
  provider: string;
  model: string;
  peak: Rates;
  offPeak: Rates;
  peakWindows: [number, number][];
  offPeakDates: string[];
}
export interface RouterConfig {
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
// Provider schedules belong to the bundled integration; model metadata comes
// from Pi's catalog, including models.json overrides.
export function resolveCandidates(models: readonly CatalogModel[]): Candidate[] {
  return [
    { provider: "deepseek", ids: ["deepseek-flash", "deepseek-v4-flash"], windows: [[60, 240], [360, 600]] },
    { provider: "ollama-cloud", ids: ["deepseek-v4.1-flash:cloud", "deepseek-v4.1-flash"], windows: [[720, 1080]] },
  ].flatMap(spec => {
    const pool = models.filter(m => m.provider === spec.provider && m.api !== "pi-virtual");
    const model = spec.ids.map(id => pool.find(m => m.id === id)).find(Boolean)
      ?? (spec.provider === "ollama-cloud"
        ? pool.filter(m => m.id.startsWith("deepseek-v4.1-flash:")).sort((a, b) => a.id.localeCompare(b.id))[0]
        : undefined);
    if (!model) return [];
    const peak = { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead };
    if (!Object.values(peak).every(n => Number.isFinite(n) && n >= 0) || peak.input + peak.output === 0) {
      throw new Error(`Model router: ${model.provider}/${model.id} needs nonzero catalog pricing. Set cost in Pi's models.json.`);
    }
    return [{ provider: model.provider, model: model.id, peak,
      offPeak: { input: peak.input / 2, output: peak.output / 2, cacheRead: peak.cacheRead / 2 },
      peakWindows: spec.windows as [number, number][], offPeakDates: [] }];
  });
}
export const defaults: RouterConfig = {
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
export function chooseCandidate(config: RouterConfig, available: Candidate[], now: Date,
  previous?: { provider: string; id: string }): Candidate {
  if (!available.length) throw new Error("Model router: no eligible Flash model is available. Check Pi's model catalog and provider login.");
  const score = (candidate: Candidate) => {
    const rates = ratesAt(candidate, now);
    return rates.input * config.estimatedInputTokens + rates.output * config.estimatedOutputTokens;
  };
  const best = Math.min(...available.map(score));
  const tied = available.filter(candidate => Math.abs(score(candidate) - best) < 1e-9);
  return tied.find(candidate => candidate.provider === config.preferredProvider)
    ?? tied.find(candidate => candidate.provider === previous?.provider && candidate.model === previous.id) ?? tied[0];
}
export function isTransient(error: string): boolean {
  return /\b429\b|\b50[0234]\b|rate.?limit|overload|temporar(?:y|ily)|service unavailable|timed? ?out|ECONNRESET|ECONNREFUSED|fetch failed/i.test(error);
}
