/**
 * Durable intent for the fixed cancel_task operation. Admission and process
 * identity checks remain the host's responsibility. An accepted intent is not
 * evidence that a process stopped; recovery must use its original launch token.
 */
import { StoreError } from "./errors.ts";
import { getOperation } from "./operations.ts";
import { columnText, getRow, run, type StoreContext } from "./sqlite.ts";
import type { OwnerIdentity } from "./types.ts";
import { normalizeOwner, requireCounter, requireId, requireText, sameOwner } from "./validate.ts";

export interface TaskCancellationRequest {
    owner: OwnerIdentity;
    idempotencyKey: string;
    operationId: string;
    expectedLaunchToken: string;
    expectedTerminalRevision: number;
    expectedHostId: string;
    reason: string;
}

export interface TaskCancellationIntent extends TaskCancellationRequest {
    operation: "cancel_task";
    taskId: string;
    state: "accepted" | "stop-requested";
    acceptedAt: number;
}

function ownerKey(owner: OwnerIdentity): string {
    return JSON.stringify([owner.kind, owner.sessionId, owner.workspace, owner.branchId, owner.goalId]);
}

function request(input: TaskCancellationRequest): TaskCancellationRequest {
    return {
        owner: normalizeOwner("owner", input.owner),
        idempotencyKey: requireId("idempotencyKey", input.idempotencyKey),
        operationId: requireId("operationId", input.operationId),
        expectedLaunchToken: requireId("launchToken", input.expectedLaunchToken),
        expectedTerminalRevision: requireCounter("terminalRevision", input.expectedTerminalRevision),
        expectedHostId: requireId("hostId", input.expectedHostId),
        reason: requireText("reason", input.reason, 1024),
    };
}

export function getTaskCancellation(
    ctx: StoreContext,
    input: { owner: OwnerIdentity; idempotencyKey: string },
): TaskCancellationIntent | null {
    const owner = normalizeOwner("owner", input.owner);
    const key = requireId("idempotencyKey", input.idempotencyKey);
    const row = getRow(ctx, "SELECT intent_json, state FROM task_cancellation_requests WHERE owner_key = ? AND request_key = ?", ownerKey(owner), key);
    if (!row) return null;
    return { ...JSON.parse(columnText(row, "intent_json")), state: columnText(row, "state") };
}

export function acceptTaskCancellation(ctx: StoreContext, input: TaskCancellationRequest): TaskCancellationIntent {
    const normalized = request(input);
    return ctx.transaction(() => {
        // Journal lookup precedes current object checks: a retry after terminal
        // publication must recover the original receipt, not become a new stop.
        const previous = getTaskCancellation(ctx, normalized);
        if (previous) {
            const { operation: _operation, taskId: _taskId, state: _state, acceptedAt: _at, ...original } = previous;
            if (JSON.stringify(original) !== JSON.stringify(normalized)) {
                throw new StoreError("request-conflict", "Cancellation key is already bound to different request content.");
            }
            return previous;
        }
        const operation = getOperation(ctx, normalized.operationId);
        if (!operation) throw new StoreError("unknown-operation", "Cancellation operation does not exist.");
        if (!sameOwner(operation.owner, normalized.owner)) throw new StoreError("foreign-owner", "Cancellation requires the recorded execution owner.");
        if (operation.launchToken !== normalized.expectedLaunchToken || operation.terminalRevision !== normalized.expectedTerminalRevision) {
            throw new StoreError("operation-conflict", "Cancellation launch token or terminal revision changed.");
        }
        if (operation.supervision?.hostId !== normalized.expectedHostId) {
            throw new StoreError("supervision-conflict", "Cancellation supervision host changed.");
        }
        const intent: TaskCancellationIntent = {
            ...normalized, operation: "cancel_task", taskId: operation.taskId, state: "accepted", acceptedAt: ctx.now(),
        };
        run(ctx, "INSERT INTO task_cancellation_requests (owner_key, request_key, operation_id, intent_json, state) VALUES (?, ?, ?, ?, 'accepted')",
            ownerKey(normalized.owner), normalized.idempotencyKey, operation.operationId, JSON.stringify(intent));
        return intent;
    });
}

/** Record durable stop-file publication, never process exit or a terminal verdict. */
export function recordTaskStopRequested(ctx: StoreContext, input: TaskCancellationRequest): TaskCancellationIntent {
    return ctx.transaction(() => {
        const normalized = request(input);
        if (!getTaskCancellation(ctx, normalized)) throw new StoreError("request-conflict", "Cancellation intent must commit before the stop action.");
        const intent = acceptTaskCancellation(ctx, normalized);
        run(ctx, "UPDATE task_cancellation_requests SET state = 'stop-requested' WHERE owner_key = ? AND request_key = ?",
            ownerKey(normalized.owner), normalized.idempotencyKey);
        return { ...intent, state: "stop-requested" };
    });
}
