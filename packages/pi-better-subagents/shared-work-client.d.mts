export class WorkClient {
    constructor(socketPath: string, agentDir: string);
    snapshot?: any;
    readonly closed: boolean;
    onChange(listener: (...args: any[]) => void): () => void;
    subscribe(scope: object): Promise<any>;
    get(scope: object): Promise<any>;
    close(): void;
}
