export class WorkClient {
    constructor(socketPath: string, agentDir: string);
    snapshot?: any;
    onChange(listener: (...args: any[]) => void): () => void;
    subscribe(scope: object): Promise<any>;
    get(scope: object): Promise<any>;
    close(): void;
}
