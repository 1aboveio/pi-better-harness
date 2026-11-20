export class WorkClient {
    constructor(socketPath: string, agentDir: string, requiredCapabilities?: string[]);
    ready: Promise<any>;
    request(type: string, params?: object): Promise<any>;
    snapshot?: any;
    readonly closed: boolean;
    onChange(listener: (...args: any[]) => void): () => void;
    onCatalog(listener: (...args: any[]) => void): () => void;
    subscribe(scope: object): Promise<any>;
    get(scope: object): Promise<any>;
    close(): void;
}

export interface ConnectionOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
    recover?: (options: { timeoutMs: number; signal: AbortSignal }) => Promise<unknown>;
}
/** Establishes a connection; never replays application requests. */
export function connectWorkClient(socketPath: string, agentDir: string, capabilities?: string[], options?: ConnectionOptions): Promise<WorkClient>;

export function shouldRestoreWorkObservation(event: { reason: string; piBetterServerHosted?: boolean } | undefined, session: { getSessionFile?(): string | undefined; getLeafId?(): string | null }): boolean;
