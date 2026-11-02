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
  candidates: Candidate[];
}
const peak = { input: 0.3, output: 1.2, cacheRead: 0.006 };
const offPeak = { input: 0.15, output: 0.6, cacheRead: 0.003 };
export const defaults: RouterConfig = {
  preferredProvider: "deepseek",
  estimatedInputTokens: 10000,
  estimatedOutputTokens: 2000,
  candidates: [
    { provider: "deepseek", model: "deepseek-flash", peak, offPeak,
      peakWindows: [[60, 240], [360, 600]], offPeakDates: [] },
    { provider: "ollama-cloud", model: "deepseek-v4.1-flash:cloud", peak, offPeak,
      peakWindows: [[720, 1080]], offPeakDates: [] },
  ],
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
  if (!available.length) throw new Error("Model router: no configured candidate is available. Check model IDs and provider login.");
  const score = (candidate: Candidate) => {
    const rates = ratesAt(candidate, now);
    return rates.input * config.estimatedInputTokens + rates.output * config.estimatedOutputTokens;
  };
  const best = Math.min(...available.map(score));
  const tied = available.filter(candidate => Math.abs(score(candidate) - best) < 1e-9);
  return tied.find(candidate => candidate.provider === previous?.provider && candidate.model === previous.id)
    ?? tied.find(candidate => candidate.provider === config.preferredProvider) ?? tied[0];
}
export function isTransient(error: string): boolean {
  return /\b429\b|\b50[0234]\b|rate.?limit|overload|temporar(?:y|ily)|service unavailable|timed? ?out|ECONNRESET|ECONNREFUSED|fetch failed/i.test(error);
}
