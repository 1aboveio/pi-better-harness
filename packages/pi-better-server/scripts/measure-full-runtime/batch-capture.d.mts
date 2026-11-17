import type { BatchSample } from './aggregate-samples.mjs';
export interface OSRecord { identity: { pid: number; start: string; boot?: string }; cpu: { totalMicros: number }; rss: number; observedAt?: number; at?: number }
export interface OSBatch { captureStartedAt: number; capturedAt: number; records: OSRecord[]; source?: Record<string, unknown> }
export function platformCapture(pids: number[], options?: { run?: (...args: any[]) => string; read?: (path: string, encoding: string) => string; now?: () => number; platform?: string; units?: { ticks: number; pageBytes: number }; nativeCapture?: (pids: number[]) => OSBatch & {cpuResolutionMs: number}; nativeBindingId?: string }): OSBatch & { source: Record<string, any> };
export function createBatchCapture(options: { capture?: (pids: number[]) => OSBatch; generation: string; pids: number[] }): () => Array<BatchSample & { sourceCohort: NonNullable<BatchSample['sourceCohort']> }>;
