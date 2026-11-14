import type { WorkScope, WorkSnapshot } from "./read-model.ts";
export class WorkClient {
  constructor(socketPath: string, agentDir: string);
  snapshot?: WorkSnapshot;
  ready: Promise<any>;
  request(type: string, params?: object): Promise<any>;
  subscribe(scope: WorkScope): Promise<WorkSnapshot>;
  resync(): Promise<WorkSnapshot>;
  get(scope: WorkScope): Promise<WorkSnapshot>;
  onChange(listener: (snapshot: WorkSnapshot) => void): () => void;
  close(): void;
}
