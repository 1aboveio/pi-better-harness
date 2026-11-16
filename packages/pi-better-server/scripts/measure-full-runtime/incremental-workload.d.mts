export interface WorkloadSettings { history: number; group: number; clients: number; durationMs: number; baseline: string }
export interface WorkloadTask { id: string; finalText: string; costUSD: number; input: number; output: number; bytes: number; logState?: 'present' | 'empty' | 'missing' }
export interface WorkloadManifest { agent: string; cwd: string; runs: string; durable: string; history: number; seededLogBytes: number; tasks: WorkloadTask[] }
export const baseline: string;
export function workloadTransport(root: string, env?: Record<string, string | undefined>): { directory: string; socketPath: string };
export function workloadSettings(env?: Record<string, string | undefined>): WorkloadSettings | undefined;
export function seedWorkload(input: { root: string; agent: string; cwd: string; settings: WorkloadSettings }): WorkloadManifest;
export function reconcileWorkload(work: { get(scope: unknown): Promise<any> }, cwd: string, manifest: WorkloadManifest): Promise<unknown>;
export function reconcileTask(task: WorkloadTask, row: any, cwd: string): any;
export function mutateWorkload(manifest: WorkloadManifest, command: { kind: string; id?: string; cents?: number; text?: string; theme?: string }): { kind: string; id?: string; beforeBytes: number; afterBytes: number; appendedBytes: number; beforeDigest: string; afterDigest: string | null; expected?: Pick<WorkloadTask, 'finalText' | 'costUSD' | 'input' | 'output' | 'logState'> };
export function workloadCounterDelta(before: any, after: any): any;
export function mutationExpectation(task: WorkloadTask | undefined, command: any): Pick<WorkloadTask, 'finalText' | 'costUSD' | 'input' | 'output' | 'logState'> | undefined;
