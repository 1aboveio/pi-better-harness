import type { BatchSample } from './aggregate-samples.mjs';
export interface OSRecord { identity: { pid: number; start: string; boot?: string }; cpu: { totalMicros: number }; rss: number; observedAt: number; observedContinuousNs: string; at?: number }
export interface OSBatch { captureStartedAt: number; capturedAt: number; captureStartedContinuousNs: string; capturedContinuousNs: string; records: OSRecord[]; source?: Record<string, unknown> }
export function continuousClock(platform: string): string | undefined;
export function isNs(value: unknown): value is string;
export function elapsedMsBetween(from: string, to: string): number;
export function validAcquisition(batch: Pick<OSBatch, 'captureStartedContinuousNs' | 'capturedContinuousNs'>, records: Pick<OSRecord, 'observedAt' | 'observedContinuousNs'>[]): boolean;
export function platformCapture(pids: number[], options?: { run?: (...args: any[]) => string; read?: (path: string, encoding: string) => string; now?: () => number; platform?: string; units?: { ticks: number; pageBytes: number }; nativeCapture?: (pids: number[]) => OSBatch & {cpuResolutionMs: number}; nativeBindingId?: string; continuousNs?: () => string }): OSBatch & { source: Record<string, any> };
export function createBatchCapture(options: { capture?: (pids: number[]) => OSBatch; generation: string; pids: number[] }): () => Array<BatchSample & { sourceCohort: NonNullable<BatchSample['sourceCohort']> }>;
