export const requiredWindows: { history: number; clients: number; group: number }[];
export function validatePairedReports(before: unknown, after: unknown, expected?: any): {
  schemaVersion: number; qualified: boolean; issues: { path: string; code: string }[];
  cpuComparison: { window: string; beforeCpuMs: number; afterCpuMs: number }[] | null;
  cpuThreshold: { status: string; reason: string };
};
