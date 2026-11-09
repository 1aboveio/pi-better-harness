// Generated from packages/operation-coordinator/src/operations.ts. Do not edit directly.
/**
 * Operation registration, supervision updates and terminal outcomes.
 *
 * Launch identity is immutable. Registering the same launch twice is an
 * idempotent replay; changing any of it is refused, because a store that
 * rewrites an owner or a task binding cannot be used to prove who owns a wait.
 *
 * A terminal outcome is recorded once per operation (`terminalRevision` 1) with
 * the supervisor's event id. A replay with the same event id returns the
 * recorded revision without side effects; a different terminal event for the
 * same operation is refused instead of overwriting the first evidence.
 */
import { StoreError } from "./errors.ts";
import { mapOperation, ownerFromRow, readOperation, requireOperation } from "./rows.ts";
import {
    columnText,
    getRow,
    getRows,
    isUniqueViolation,
    run,
    type StoreContext,
} from "./sqlite.ts";
import type {
    EvidenceRefInput,
    ObserverHealth,
    OperationFilter,
    OperationRecord,
    RecordSupervisionInput,
    RecordTerminalOutcomeInput,
    RecordTerminalOutcomeResult,
    RegisterOperationInput,
    RegisterOperationResult,
    SupervisionIdentity,
    TerminalOutcome,
    WaitRecord,
} from "./types.ts";
import {
    describeOwnerDiff,
    normalizeOwner,
    optionalText,
    requireBoolean,
    requireEnum,
    requireEvidenceKind,
    requireId,
    requireObserver,
    requireOptionalCounter,
    requireText,
    sameOwner,
} from "./validate.ts";
import { mapOutbox } from "./rows.ts";
import { settleWaitsForOperation } from "./waits.ts";
import { appendChange } from "./changes.ts";

const HEALTH_VALUES: readonly ObserverHealth[] = ["active", "unmonitored", "lost"];
const OUTCOME_VALUES: readonly TerminalOutcome[] = ["succeeded", "failed", "cancelled", "lost"];

function normalizeSupervision(value: unknown): SupervisionIdentity | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "object" || Array.isArray(value)) {
        throw new StoreError("validation", "Invalid supervision: must be an object");
    }
    const supervision = value as Partial<SupervisionIdentity>;
    return {
        hostId: requireId("supervision.hostId", supervision.hostId),
        runnerId: supervision.runnerId === undefined || supervision.runnerId === null
            ? null
            : requireId("supervision.runnerId", supervision.runnerId),
        processStartToken: supervision.processStartToken === undefined || supervision.processStartToken === null
            ? null
            : requireId("supervision.processStartToken", supervision.processStartToken),
    };
}

function normalizeEvidence(value: unknown): EvidenceRefInput[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
        throw new StoreError("validation", "Invalid evidence: must be an array");
    }
    return value.map((entry, index) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new StoreError("validation", `Invalid evidence[${index}]: must be an object`);
        }
        const item = entry as Partial<EvidenceRefInput>;
        const normalized: EvidenceRefInput = {
            kind: requireEvidenceKind(`evidence[${index}].kind`, item.kind),
            ref: requireText(`evidence[${index}].ref`, item.ref, 1024),
            detailLost: item.detailLost === undefined ? false : requireBoolean(
                `evidence[${index}].detailLost`,
                item.detailLost,
            ),
        };
        const summary = optionalText(`evidence[${index}].summary`, item.summary, 2048);
        if (summary !== null) normalized.summary = summary;
        const bytes = requireOptionalCounter(`evidence[${index}].bytes`, item.bytes);
        if (bytes !== null) normalized.bytes = bytes;
        return normalized;
    });
}

export function registerOperation(
    ctx: StoreContext,
    input: RegisterOperationInput,
): RegisterOperationResult {
    const operationId = requireId("operationId", input.operationId);
    const taskId = requireId("taskId", input.taskId);
    const launchToken = requireId("launchToken", input.launchToken);
    const owner = normalizeOwner("owner", input.owner);
    const observer = requireObserver("observer", input.observer);
    const supervision = normalizeSupervision(input.supervision);
    const authorityRef = optionalText("authorityRef", input.authorityRef, 512);
    const intentRef = optionalText("intentRef", input.intentRef, 200);

    const assertTaskAvailable = (): void => {
        const byTask = getRows(ctx, "SELECT * FROM operations WHERE task_id = ?", taskId)[0];
        if (!byTask) return;
        const existingOwner = ownerFromRow(byTask);
        if (!sameOwner(existingOwner, owner)) {
            throw new StoreError(
                "task-ownership",
                `Background task ${taskId} is owned by another execution owner. A task id belongs to the launch that registered it; a different owner must not attach to it.`,
            );
        }
        throw new StoreError(
            "operation-conflict",
            `Background task ${taskId} is already bound to operation ${columnText(byTask, "operation_id")}. One durable operation exists per task launch; reconcile the recorded one instead of registering a second.`,
        );
    };

    const assertLaunchIdentity = (existing: OperationRecord): void => {
        const differences: string[] = [];
        if (existing.taskId !== taskId) differences.push("taskId");
        if (existing.launchToken !== launchToken) differences.push("launchToken");
        if (!sameOwner(existing.owner, owner)) {
            differences.push(`owner (${describeOwnerDiff(existing.owner, owner)})`);
        }
        if (existing.observer.kind !== observer.kind || existing.observer.version !== observer.version) {
            differences.push("observer");
        }
        if (differences.length > 0) {
            throw new StoreError(
                "operation-conflict",
                `Operation ${operationId} is already registered with a different launch identity: ${differences.join(", ")}. Launch identity and ownership are immutable; register a new operation id for a new launch.`,
            );
        }
    };

    return ctx.transaction(() => {
        const existing = readOperation(ctx, operationId);
        if (existing) {
            assertLaunchIdentity(existing);
            return { operation: existing, created: false };
        }
        const tombstone = getRow(
            ctx,
            `SELECT operation_id, task_id FROM retention_units
             WHERE state = 'complete'
               AND (
                   operation_id = ?
                   OR (task_id IS NOT NULL AND task_id = ?)
                   OR (launch_token IS NOT NULL AND launch_token = ?)
               )
             LIMIT 1`,
            operationId,
            taskId,
            launchToken,
        );
        if (tombstone) {
            throw new StoreError(
                "retention-protected",
                `Operation ${operationId} reuses a launch identity tombstoned by completed retention (operation ${columnText(tombstone, "operation_id")}, task ${columnText(tombstone, "task_id")}). Register a new launch identity; a pruned identity is never resurrected.`,
            );
        }
        assertTaskAvailable();

        const at = ctx.now();
        try {
            run(
                ctx,
                `INSERT INTO operations (
                    operation_id, task_id, launch_token,
                    owner_kind, owner_session_id, owner_workspace, owner_branch_id, owner_goal_id,
                    observer_kind, observer_version, supervision_json, authority_ref, intent_ref,
                    phase, health, health_reason, terminal_revision, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 'active', NULL, 0, ?, ?)`,
                operationId,
                taskId,
                launchToken,
                owner.kind,
                owner.sessionId,
                owner.workspace,
                owner.branchId ?? null,
                owner.goalId ?? null,
                observer.kind,
                observer.version,
                supervision ? JSON.stringify(supervision) : null,
                authorityRef,
                intentRef,
                at,
                at,
            );
        } catch (error) {
            // Another process may have registered the same launch (or the same task)
            // between the check above and this insert. Re-read and report the same
            // typed outcome instead of leaking a raw constraint error.
            if (!isUniqueViolation(error, "operations.task_id", "operations.operation_id")) throw error;
            const raced = readOperation(ctx, operationId);
            if (raced) {
                assertLaunchIdentity(raced);
                return { operation: raced, created: false };
            }
            assertTaskAvailable();
            throw error;
        }
        return { operation: requireOperation(ctx, operationId), created: true };
    });
}

/**
 * Replace the supervision identity and/or observer health. A replacement host
 * may take over observation; ownership and launch identity stay untouched.
 */
export function recordSupervision(
    ctx: StoreContext,
    input: RecordSupervisionInput,
): OperationRecord {
    const operationId = requireId("operationId", input.operationId);
    const owner = normalizeOwner("owner", input.owner);
    const supervision = normalizeSupervision(input.supervision);
    const health = input.health === undefined
        ? null
        : requireEnum("health", input.health, HEALTH_VALUES);
    const reason = optionalText("reason", input.reason, 1024);
    if (health === null && supervision === null) {
        throw new StoreError("validation", "Invalid supervision update: nothing to record");
    }

    return ctx.transaction(() => {
        const operation = requireOperation(ctx, operationId);
        if (!sameOwner(operation.owner, owner)) {
            throw new StoreError(
                "foreign-owner",
                `Operation ${operationId} belongs to another execution owner (differs in ${describeOwnerDiff(operation.owner, owner)}).`,
            );
        }
        const nextHealth = health ?? operation.health;
        const nextReason = nextHealth === "active" ? null : (reason ?? operation.healthReason);
        if (nextHealth !== "active" && nextReason === null) {
            throw new StoreError(
                "validation",
                "Invalid reason: observer health other than active requires a recorded reason",
            );
        }
        run(
            ctx,
            "UPDATE operations SET supervision_json = ?, health = ?, health_reason = ?, updated_at = ? WHERE operation_id = ?",
            supervision ? JSON.stringify(supervision) : operation.supervision
                ? JSON.stringify(operation.supervision)
                : null,
            nextHealth,
            nextReason,
            ctx.now(),
            operationId,
        );
        return requireOperation(ctx, operationId);
    });
}

export function recordTerminalOutcome(
    ctx: StoreContext,
    input: RecordTerminalOutcomeInput,
): RecordTerminalOutcomeResult {
    const operationId = requireId("operationId", input.operationId);
    const eventId = requireId("eventId", input.eventId);
    const outcome = requireEnum("outcome", input.outcome, OUTCOME_VALUES);
    const owner = normalizeOwner("owner", input.owner);
    const evidence = normalizeEvidence(input.evidence);
    const reason = optionalText("reason", input.reason, 1024);
    const detailLost = input.detailLost === undefined
        ? outcome === "lost"
        : requireBoolean("detailLost", input.detailLost);

    return ctx.transaction(() => {
        const operation = requireOperation(ctx, operationId);
        if (!sameOwner(operation.owner, owner)) {
            throw new StoreError(
                "foreign-owner",
                `Operation ${operationId} belongs to another execution owner (differs in ${describeOwnerDiff(operation.owner, owner)}); a terminal outcome must be reported by or for its registered owner.`,
            );
        }
        if (operation.phase === "terminal") {
            if (operation.terminalEventId === eventId) {
                return {
                    operation,
                    recorded: false,
                    outbox: listOutboxForRevision(ctx, operationId, operation.terminalRevision),
                    ready: [],
                };
            }
            throw new StoreError(
                "terminal-conflict",
                `Operation ${operationId} already recorded terminal event ${operation.terminalEventId} (${operation.terminalOutcome}). Event ${eventId} is a different terminal event and cannot replace it; a replayed event must reuse its original event id.`,
            );
        }

        // A replay may omit evidence: the recorded revision already holds it. Only a
        // new terminal revision must be interpretable on its own.
        if (evidence.length === 0 && reason === null) {
            throw new StoreError(
                "validation",
                "Invalid reason: a terminal outcome without evidence must record why (for example lost supervision), so the result is interpretable.",
            );
        }
        const at = ctx.now();
        evidence.forEach((item, ordinal) => {
            run(
                ctx,
                `INSERT INTO operation_evidence (
                    operation_id, terminal_revision, ordinal, kind, ref, summary, detail_lost, bytes, captured_at
                ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
                operationId,
                ordinal,
                item.kind,
                item.ref,
                item.summary ?? null,
                item.detailLost ? 1 : 0,
                item.bytes ?? null,
                at,
            );
        });
        run(
            ctx,
            `UPDATE operations
             SET phase = 'terminal', terminal_revision = 1, terminal_outcome = ?, terminal_event_id = ?,
                 terminal_detail_lost = ?, terminal_reason = ?, terminal_at = ?, updated_at = ?
             WHERE operation_id = ?`,
            outcome,
            eventId,
            detailLost ? 1 : 0,
            reason,
            at,
            at,
            operationId,
        );
        const settledOperation = requireOperation(ctx, operationId);
        const settled = settleWaitsForOperation(ctx, settledOperation, at);
        appendChange(ctx, {
            kind: "terminal",
            owner: settledOperation.owner,
            operationId: settledOperation.operationId,
            taskId: settledOperation.taskId,
            terminalRevision: settledOperation.terminalRevision,
        });
        const outbox = listOutboxForRevision(ctx, operationId, 1);
        return {
            operation: settledOperation,
            recorded: true,
            outbox,
            ready: settled.ready as WaitRecord[],
        };
    });
}

export function getOperation(ctx: StoreContext, operationId: string): OperationRecord | null {
    return readOperation(ctx, operationId);
}

export function listOperations(
    ctx: StoreContext,
    filter: OperationFilter = {},
): OperationRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.owner) {
        const owner = normalizeOwner("owner", filter.owner);
        clauses.push(
            "owner_kind = ? AND owner_session_id = ? AND owner_workspace = ? AND coalesce(owner_branch_id, '') = ? AND coalesce(owner_goal_id, '') = ?",
        );
        params.push(owner.kind, owner.sessionId, owner.workspace, owner.branchId ?? "", owner.goalId ?? "");
    }
    if (filter.phase !== undefined) {
        clauses.push("phase = ?");
        params.push(requireEnum("phase", filter.phase, ["running", "terminal"] as const));
    }
    if (filter.taskId !== undefined) {
        clauses.push("task_id = ?");
        params.push(requireId("taskId", filter.taskId));
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return getRows(ctx, `SELECT * FROM operations ${where} ORDER BY created_at, operation_id`, ...params)
        .map(mapOperation);
}

function listOutboxForRevision(
    ctx: StoreContext,
    operationId: string,
    terminalRevision: number,
) {
    return getRows(
        ctx,
        "SELECT * FROM outbox_events WHERE operation_id = ? AND terminal_revision = ? ORDER BY created_at, event_id",
        operationId,
        terminalRevision,
    ).map((row) => mapOutbox(ctx, row));
}
