import type { WorkReadModel } from "../../src/runtime/read-model.ts";

export interface SourceEventRecord {
  sequence: number;
  stage: string;
  [key: string]: unknown;
}

export function sourceEventTrace(model: WorkReadModel): () => {
  total: number;
  dropped: number;
  records: SourceEventRecord[];
};
