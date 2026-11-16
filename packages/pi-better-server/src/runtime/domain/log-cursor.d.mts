export function withLogReadBatch<T>(observe: () => T): T;
export const logReadMetrics: { bytes: number; reads: number; parsedEvents: number; displayFolded: number; healthFolded: number };
