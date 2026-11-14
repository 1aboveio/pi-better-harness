import type { WorkScope, WorkSnapshot } from "./read-model.ts";
export class WorkClient {
  constructor(socketPath: string, agentDir: string, requiredCapabilities?: string[]);
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
