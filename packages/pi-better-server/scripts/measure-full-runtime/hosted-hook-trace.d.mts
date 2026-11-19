export function traceHostedHook(owner: string, event: string, ordinal: number, handler: (...args: any[]) => any): (...args: any[]) => any;
export function traceHostedRequests(Client: { prototype: { request: (...args: any[]) => Promise<any> } }): void;
