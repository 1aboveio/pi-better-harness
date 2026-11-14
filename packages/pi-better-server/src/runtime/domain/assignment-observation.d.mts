export function createAssignmentReader(path: string): { revision(): string; read(owner: any): any; close(): void };
