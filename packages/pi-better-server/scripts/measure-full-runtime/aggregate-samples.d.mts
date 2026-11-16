export interface ProcessSample { identity: { pid: number; start: string }; generation: string; at: number; sequence: number; cpu: { user: number; system: number }; rss: number }
export interface CohortOptions { required: { identity: { pid: number; start: string } }[]; generation: string; sampleIntervalMs?: number }
export function aggregateCohort(previous: ProcessSample[] | null, current: ProcessSample[], options: CohortOptions): { qualified: boolean; issues: string[]; cpuPercent: number | null; rssBytes: number | null; at: number | null };
export function summarizeCohorts(frames: ProcessSample[][], options: CohortOptions, window: { startedAt: number; endedAt: number }): {
  scope: string; method: string; qualified: boolean; generation: string; processIdentities: { pid: number; start: string }[];
  firstAt: number | null; lastAt: number | null; samples: number; issues: string[]; cpuPercent: number | null; rssBytes: number | null;
  intervals: { at: number; fromAt: number; cpuPercent: number; rssBytes: number }[];
};
