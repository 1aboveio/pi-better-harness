/**
 * Refusals from the durable operation coordinator.
 *
 * Every refusal is a typed `code` so a transport can turn it into a specific
 * model-facing reason instead of a generic failure. A refusal never leaves a
 * partial record: all writes run inside one immediate transaction.
 */
export type StoreErrorCode =
    /** The database was written by another schema version. Records are left untouched. */
    | "schema-version"
    /** This runtime has no `node:sqlite`, so durability cannot be promised. */
    | "sqlite-unavailable"
    /** Another process holds the write lock for longer than the configured budget. */
    | "store-busy"
    /** A stored row could not be parsed back into its record shape. */
    | "store-corruption"
    /** Caller input is malformed, out of bounds, or looks like credential material. */
    | "validation"
    /** The operation id is not registered in this store. */
    | "unknown-operation"
    /** An operation already exists with different immutable launch identity. */
    | "operation-conflict"
    /** The background task id belongs to a different owner. */
    | "task-ownership"
    /** The caller is not the recorded owner of the record it wants to change. */
    | "foreign-owner"
    /** A different terminal event is already recorded for this operation. */
    | "terminal-conflict"
    /** The owner already has a pending wait generation. */
    | "pending-wait-generation"
    /** The wait id / generation is not registered in this store. */
    | "unknown-wait"
    /** The requested wait phase transition is not allowed from the current phase. */
    | "wait-phase"
    /** The caller's view of the current phase is out of date (out-of-order call). */
    | "stale-phase"
    /** The caller addressed a generation that is not the current one. */
    | "stale-generation"
    /** The caller's cancellation epoch is out of date; the wait changed underneath. */
    | "stale-cancel-epoch"
    /** Not every dependency has a terminal outcome yet. */
    | "dependencies-unsettled"
    /** A parked wait tried to reach waiting/ready without checkpoint and writer proof. */
    | "checkpoint-proof"
    /** A published resume cannot be held without proven writer exit and a free lease. */
    | "resume-proof"
    /** Another resume claim is already active for this wait generation. */
    | "concurrent-claim"
    /** The resume claim is not in a state that allows the requested step. */
    | "claim-state"
    /** The attempt id is already published by another resume claim. */
    | "attempt-conflict"
    /** The owner must record reading the exact terminal evidence before acknowledging. */
    | "evidence-read-required"
    /** The acknowledged evidence revision is not the dependency's terminal revision. */
    | "stale-evidence"
    /** The outbox event is not in a state that allows the requested step. */
    | "outbox-state"
    /** The store has been closed. */
    | "closed";

export class StoreError extends Error {
    readonly code: StoreErrorCode;

    constructor(code: StoreErrorCode, message: string) {
        super(message);
        this.name = "StoreError";
        this.code = code;
    }
}

export function isStoreError(error: unknown): error is StoreError {
    return error instanceof StoreError;
}
