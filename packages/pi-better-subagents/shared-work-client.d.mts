export class WorkClient {
    constructor(socketPath: string, agentDir: string, requiredCapabilities?: string[]);
    ready: Promise<any>;
    closed: boolean;
    request(type: string, params?: object): Promise<any>;
    snapshot?: any;
    onChange(listener: (...args: any[]) => void): () => void;
    onCatalog(listener: (...args: any[]) => void): () => void;
    subscribe(scope: object): Promise<any>;
    get(scope: object): Promise<any>;
    close(): void;
}
