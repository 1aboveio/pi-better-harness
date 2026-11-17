export interface CampaignWindow { side: 'before' | 'after'; workload: { history: number; clients: number; group: number }; checkout: string; artifactRoot: string; driverCheckout: string; durationMs: number; approved: any; outputDirectory: string }
export function windowInvocation(roots: { checkout: string; artifactRoot: string; driverCheckout: string; durationMs?: number }): { script: string; cwd: string; binding: string };
export function runCampaign(config: any, hooks?: { run?: (window: CampaignWindow) => Promise<any>; save?: (path: string, value: any) => void }): Promise<any>;
