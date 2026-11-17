import type { WorkScope, WorkSnapshot } from "./read-model.ts";
export class WorkClient {
  readonly closed: boolean;
  constructor(socketPath: string | import("node:stream").Duplex, agentDir: string, requiredCapabilities?: string[]);
  snapshot?: WorkSnapshot;
  ready: Promise<any>;
  request(type: string, params?: object): Promise<any>;
  subscribe(scope: WorkScope): Promise<WorkSnapshot>;
  resync(): Promise<WorkSnapshot>;
  get(scope: WorkScope): Promise<WorkSnapshot>;
  onChange(listener: (snapshot: WorkSnapshot) => void): () => void;
  onCatalog(listener: (snapshot: any) => void): () => void;
  close(): void;
}

export interface ConnectionOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
    recover?: (options: { timeoutMs: number; signal: AbortSignal }) => Promise<unknown>;
}
/** Establishes a connection; never replays application requests. */
export function connectWorkClient(socketPath: string, agentDir: string, capabilities?: string[], options?: ConnectionOptions): Promise<WorkClient>;
