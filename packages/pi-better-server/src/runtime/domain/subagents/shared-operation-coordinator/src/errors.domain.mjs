// Generated fixed launch domain from packages/pi-better-subagents/shared-operation-coordinator/src/errors.ts. Do not edit directly.
export class StoreError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "StoreError";
        this.code = code;
    }
}
export function isStoreError(error) {
    return error instanceof StoreError;
}
