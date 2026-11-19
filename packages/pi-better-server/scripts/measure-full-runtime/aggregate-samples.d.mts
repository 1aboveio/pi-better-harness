export interface ProcessSample { identity: { pid: number; start: string; boot?: string }; generation: string; at: number; observedAt?: number; observedContinuousNs?: string; sequence: number; cpu: { user: number; system: number }; rss: number;
  sourceCohort?: { id: string; kind?: string; platform?: string; cpuResolutionMs?: number; nativeBindingId?: string; clock?: string; captureStartedAt: number; capturedAt: number; captureStartedContinuousNs?: string; capturedContinuousNs?: string; pids: number[] } }
export interface CohortOptions { required: { identity: { pid: number; start: string; boot?: string } }[]; generation: string; clock?: string; sampleIntervalMs?: number }
export interface BatchSample extends Omit<ProcessSample, 'cpu'> { cpu: { totalMicros: number } }
export function aggregateCohort(previous: (ProcessSample | BatchSample)[] | null, current: (ProcessSample | BatchSample)[], options: CohortOptions): { qualified: boolean; issues: string[]; cpuPercent: number | null; rssBytes: number | null; at: number | null; continuousNs?: string };
export function summarizeCohorts(frames: (ProcessSample | BatchSample)[][], options: CohortOptions, window: { startedAt: number; endedAt: number; startedContinuousNs?: string; endedContinuousNs?: string }): {
  scope: string; method: string; qualified: boolean; generation: string; processIdentities: { pid: number; start: string }[];
  firstAt: number | null; lastAt: number | null; firstContinuousNs?: string; lastContinuousNs?: string; samples: number; issues: string[]; cpuPercent: number | null; rssBytes: number | null;
  intervals: { at: number; fromAt: number; continuousNs?: string; fromContinuousNs?: string; cpuPercent: number; rssBytes: number }[];
};
