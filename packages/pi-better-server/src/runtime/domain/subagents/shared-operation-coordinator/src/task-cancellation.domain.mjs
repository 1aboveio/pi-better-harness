// Generated fixed launch domain from packages/pi-better-subagents/shared-operation-coordinator/src/task-cancellation.ts. Do not edit directly.
// Generated from packages/operation-coordinator/src/task-cancellation.ts. Do not edit directly.
/**
 * Durable intent for the fixed cancel_task operation. Admission and process
 * identity checks remain the host's responsibility. An accepted intent is not
 * evidence that a process stopped; recovery must use its original launch token.
 */
import { StoreError } from "./errors.domain.mjs";
import { createHash, randomBytes } from "node:crypto";
import { getOperation, recordTerminalOutcome } from "./operations.domain.mjs";
import { columnText, getRow, run } from "./sqlite.domain.mjs";
import { normalizeOwner, requireCounter, requireId, requireText, sameOwner } from "./validate.domain.mjs";
export function cancellationRuntimeEpoch(ctx, instanceId) {
    return ctx.transaction(() => {
        const row = getRow(ctx, "SELECT value FROM coordinator_state WHERE key = 'cancellation-runtime'");
        const current = row ? JSON.parse(columnText(row, "value")) : { epoch: 0 };
        if (!instanceId || current.instanceId === instanceId)
            return current.epoch;
        const epoch = current.epoch + 1;
        run(ctx, "INSERT INTO coordinator_state (key, value) VALUES ('cancellation-runtime', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify({ instanceId, epoch }));
        return epoch;
    });
}
function cancelEpoch(ctx, operationId) {
    const row = getRow(ctx, "SELECT value FROM coordinator_state WHERE key = ?", `cancel:${operationId}`);
    return row ? Number(columnText(row, "value")) : 0;
}
function revision(operation, epoch) {
    const op = operation;
    return createHash("sha256").update(JSON.stringify([op && {
            operationId: op.operationId, owner: op.owner, launchToken: op.launchToken,
            terminalRevision: op.terminalRevision, phase: op.phase, authorityRef: op.authorityRef,
            hostId: op.supervision?.hostId,
        }, epoch])).digest("hex");
}
export function taskCancellationManaged(ctx, operationId) {
    return !!getRow(ctx, "SELECT credential_hash FROM task_cancellation_authorities WHERE json_extract(request_json, '$.request.operationId') = ? LIMIT 1", requireId("operationId", operationId));
}
export function pendingTaskCancellations(ctx) {
    return ctx.db.prepare("SELECT a.* FROM task_cancellation_authorities a JOIN task_cancellation_requests r ON json_extract(a.request_json, '$.request.operationId') = r.operation_id AND json_extract(a.request_json, '$.request.idempotencyKey') = r.request_key WHERE r.result_json IS NULL").all()
        .map(row => ({ credentialHash: columnText(row, "credential_hash"), ...JSON.parse(columnText(row, "request_json")), directory: columnText(row, "directory") }));
}
export function acceptAuthorizedTaskCancellation(ctx, input) {
    return ctx.transaction(() => {
        const admission = authorizedTaskCancellation(ctx, input.credential);
        const previous = getTaskCancellation(ctx, admission.request);
        if (previous)
            return acceptTaskCancellation(ctx, admission.request);
        if (input.runtimeEpoch !== cancellationRuntimeEpoch(ctx) || input.runtimeEpoch !== admission.runtimeEpoch)
            throw new StoreError("supervision-conflict", "not_accepted: stale-runtime-epoch; query journal before new admission");
        const operation = getOperation(ctx, admission.request.operationId);
        const epoch = cancelEpoch(ctx, admission.request.operationId);
        if (epoch !== admission.cancelEpoch || revision(operation, epoch) !== admission.revision)
            throw new StoreError("operation-conflict", "not_accepted: stale-revision or cancellation epoch");
        const intent = acceptTaskCancellation(ctx, admission.request);
        run(ctx, "INSERT INTO coordinator_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", `cancel:${intent.operationId}`, String(epoch + 1));
        return intent;
    });
}
export function cancellationCredential() {
    const credential = randomBytes(32).toString("hex");
    return { credential, hash: credentialHash(credential) };
}
function credentialHash(credential) {
    return createHash("sha256").update(requireText("credential", credential, 128)).digest("hex");
}
/** Called only by the existing admitted domain host, never by a socket command. */
export function admitTaskCancellation(ctx, input) {
    const normalized = request(input.request);
    const hash = requireId("credentialHash", input.credentialHash);
    const directory = requireText("directory", input.directory, 4096);
    ctx.transaction(() => {
        const operation = getOperation(ctx, normalized.operationId);
        if (!operation || !sameOwner(operation.owner, normalized.owner))
            throw new StoreError("foreign-owner", "Cancellation admission requires the recorded owner.");
        const previous = getTaskCancellation(ctx, normalized);
        if (operation.launchToken !== normalized.expectedLaunchToken || (!previous && operation.supervision?.hostId !== normalized.expectedHostId)) {
            throw new StoreError("supervision-conflict", "Cancellation admission requires the current exact launch and host.");
        }
        if (previous && JSON.stringify(request(previous)) !== JSON.stringify(normalized))
            throw new StoreError("request-conflict", "Cancellation key is bound to different request content.");
        const original = previous ? request(previous) : normalized;
        const epoch = cancelEpoch(ctx, normalized.operationId);
        run(ctx, "INSERT INTO task_cancellation_authorities (credential_hash, request_json, directory) VALUES (?, ?, ?)", hash, JSON.stringify({ request: original, runtimeEpoch: cancellationRuntimeEpoch(ctx), cancelEpoch: epoch, revision: revision(operation, epoch) }), directory);
    });
}
/** A credential binds an already-admitted exact request, not a claimed session ID. */
export function authorizedTaskCancellation(ctx, credential) {
    const row = getRow(ctx, "SELECT * FROM task_cancellation_authorities WHERE credential_hash = ?", credentialHash(credential));
    if (!row)
        throw new StoreError("foreign-owner", "permission-unavailable: cancellation authority is not registered.");
    return { credentialHash: credentialHash(credential), ...JSON.parse(columnText(row, "request_json")), directory: columnText(row, "directory") };
}
export function finishTaskCancellation(ctx, input) {
    const admission = authorizedTaskCancellation(ctx, input.credential);
    return finishTaskCancellationIntent(ctx, { request: admission.request, status: input.status, terminal: input.terminal });
}
export function finishTaskCancellationIntent(ctx, input) {
    return ctx.transaction(() => {
        const intent = recordTaskStopRequested(ctx, input.request);
        if (intent.result)
            return intent;
        if (input.publication) {
            if (input.publication.operationId !== intent.operationId || !sameOwner(input.publication.owner, intent.owner))
                throw new StoreError("foreign-owner", "Terminal publication does not match the cancellation intent.");
            recordTerminalOutcome(ctx, input.publication);
        }
        const result = { status: requireText("status", input.status, 64), terminal: input.terminal === true };
        run(ctx, "UPDATE task_cancellation_requests SET result_json = ? WHERE owner_key = ? AND request_key = ?", JSON.stringify(result), ownerKey(intent.owner), intent.idempotencyKey);
        return { ...intent, result };
    });
}
export function unknownTaskCancellation(ctx, input) {
    return ctx.transaction(() => {
        const intent = getTaskCancellation(ctx, input);
        if (!intent)
            throw new StoreError("request-conflict", "Cannot record an unknown outcome without an accepted intent.");
        if (intent.result)
            return intent;
        const result = { status: "outcome_unknown", terminal: false };
        run(ctx, "UPDATE task_cancellation_requests SET result_json = ? WHERE owner_key = ? AND request_key = ?", JSON.stringify(result), ownerKey(intent.owner), intent.idempotencyKey);
        return { ...intent, result };
    });
}
function ownerKey(owner) {
    return JSON.stringify([owner.kind, owner.sessionId, owner.workspace, owner.branchId, owner.goalId]);
}
function request(input) {
    return {
        owner: normalizeOwner("owner", input.owner),
        idempotencyKey: requireText("idempotencyKey", input.idempotencyKey, 512),
        operationId: requireId("operationId", input.operationId),
        expectedLaunchToken: requireId("launchToken", input.expectedLaunchToken),
        expectedTerminalRevision: requireCounter("terminalRevision", input.expectedTerminalRevision),
        expectedHostId: requireId("hostId", input.expectedHostId),
        reason: requireText("reason", input.reason, 1024),
    };
}
export function getTaskCancellation(ctx, input) {
    const owner = normalizeOwner("owner", input.owner);
    const key = requireText("idempotencyKey", input.idempotencyKey, 512);
    const row = getRow(ctx, "SELECT intent_json, state, result_json FROM task_cancellation_requests WHERE owner_key = ? AND request_key = ?", ownerKey(owner), key);
    if (!row)
        return null;
    return { ...JSON.parse(columnText(row, "intent_json")), state: columnText(row, "state"), ...(row.result_json ? { result: JSON.parse(columnText(row, "result_json")) } : {}) };
}
export function acceptTaskCancellation(ctx, input) {
    const normalized = request(input);
    return ctx.transaction(() => {
        // Journal lookup precedes current object checks: a retry after terminal
        // publication must recover the original receipt, not become a new stop.
        const previous = getTaskCancellation(ctx, normalized);
        if (previous) {
            const { operation: _operation, taskId: _taskId, state: _state, acceptedAt: _at, result: _result, ...original } = previous;
            if (JSON.stringify(original) !== JSON.stringify(normalized)) {
                throw new StoreError("request-conflict", "Cancellation key is already bound to different request content.");
            }
            return previous;
        }
        const operation = getOperation(ctx, normalized.operationId);
        if (!operation)
            throw new StoreError("unknown-operation", "Cancellation operation does not exist.");
        if (!sameOwner(operation.owner, normalized.owner))
            throw new StoreError("foreign-owner", "Cancellation requires the recorded execution owner.");
        if (operation.launchToken !== normalized.expectedLaunchToken || operation.terminalRevision !== normalized.expectedTerminalRevision) {
            throw new StoreError("operation-conflict", "Cancellation launch token or terminal revision changed.");
        }
        if (operation.supervision?.hostId !== normalized.expectedHostId) {
            throw new StoreError("supervision-conflict", "Cancellation supervision host changed.");
        }
        const intent = {
            ...normalized, operation: "cancel_task", taskId: operation.taskId, state: "accepted", acceptedAt: ctx.now(),
        };
        run(ctx, "INSERT INTO task_cancellation_requests (owner_key, request_key, operation_id, intent_json, state) VALUES (?, ?, ?, ?, 'accepted')", ownerKey(normalized.owner), normalized.idempotencyKey, operation.operationId, JSON.stringify(intent));
        return intent;
    });
}
/** Record durable stop-file publication, never process exit or a terminal verdict. */
export function recordTaskStopRequested(ctx, input) {
    return ctx.transaction(() => {
        const normalized = request(input);
        if (!getTaskCancellation(ctx, normalized))
            throw new StoreError("request-conflict", "Cancellation intent must commit before the stop action.");
        const intent = acceptTaskCancellation(ctx, normalized);
        run(ctx, "UPDATE task_cancellation_requests SET state = 'stop-requested' WHERE owner_key = ? AND request_key = ?", ownerKey(normalized.owner), normalized.idempotencyKey);
        return { ...intent, state: "stop-requested" };
    });
}
