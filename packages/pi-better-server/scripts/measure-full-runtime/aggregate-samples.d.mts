export interface ProcessSample { identity: { pid: number; start: string }; generation: string; at: number; observedAt?: number; sequence: number; cpu: { user: number; system: number }; rss: number;
  sourceCohort?: { id: string; kind?: string; platform?: string; cpuResolutionMs?: number; captureStartedAt: number; capturedAt: number; pids: number[] } }
export interface CohortOptions { required: { identity: { pid: number; start: string } }[]; generation: string; sampleIntervalMs?: number }
export interface BatchSample extends Omit<ProcessSample, 'cpu'> { cpu: { totalMicros: number } }
export function aggregateCohort(previous: (ProcessSample | BatchSample)[] | null, current: (ProcessSample | BatchSample)[], options: CohortOptions): { qualified: boolean; issues: string[]; cpuPercent: number | null; rssBytes: number | null; at: number | null };
export function summarizeCohorts(frames: (ProcessSample | BatchSample)[][], options: CohortOptions, window: { startedAt: number; endedAt: number }): {
  scope: string; method: string; qualified: boolean; generation: string; processIdentities: { pid: number; start: string }[];
  firstAt: number | null; lastAt: number | null; samples: number; issues: string[]; cpuPercent: number | null; rssBytes: number | null;
  intervals: { at: number; fromAt: number; cpuPercent: number; rssBytes: number }[];
};
