export interface WorkloadSettings { history: number; group: number; clients: number; durationMs: number; baseline: string }
export interface WorkloadManifest { durable: string; history: number; seededLogBytes: number; tasks: { id: string; finalText: string; costUSD: number; bytes: number }[] }
export const baseline: string;
export function workloadSettings(env?: Record<string, string | undefined>): WorkloadSettings | undefined;
export function seedWorkload(input: { root: string; agent: string; cwd: string; settings: WorkloadSettings }): WorkloadManifest;
export function reconcileWorkload(work: { get(scope: unknown): Promise<any> }, cwd: string, manifest: WorkloadManifest): Promise<unknown>;
