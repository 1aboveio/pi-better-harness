// Generated from packages/operation-coordinator/src/background-parent-callbacks.ts. Do not edit directly.
/** Pending parent notifications are obligations, independent of UI retention. */
import { bumpChangeRevision } from './discovery.ts';
import { mapOperation } from './rows.ts';
import { getRow, getRows, run, type StoreContext } from './sqlite.ts';
import { requireBoolean, requireCounter, requireId, requirePath } from './validate.ts';
import type { OperationRecord } from './types.ts';

export interface ParentCallbackScope { sessionId: string; workspace: string }
export interface ParentCallbackPage { after?: string; limit?: number }
export interface RecentBackgroundTerminalPage {
    since: number;
    after?: { terminalAt: number; operationId: string };
    limit?: number;
    owner?: ParentCallbackScope;
}
const pageSize = (limit = 256) => Math.max(1, Math.min(256, requireCounter('limit', limit)));
const scopeValues = (scope: ParentCallbackScope) => [requirePath('workspace', scope.workspace), requireId('sessionId', scope.sessionId)] as const;

export function setParentCallbackPending(ctx: StoreContext, taskId: string, pending: boolean): boolean {
    taskId = requireId('taskId', taskId);
    pending = requireBoolean('pending', pending);
    return ctx.transaction(() => {
        const operation = getRow(ctx, "SELECT operation_id, owner_workspace, owner_session_id FROM operations WHERE task_id=? AND owner_kind='parent-session' AND observer_kind='local-supervisor'", taskId);
        if (!operation) return false;
        const changed = pending
            ? run(ctx, `INSERT OR IGNORE INTO background_parent_callbacks(operation_id,owner_kind,owner_workspace,owner_session_id)
                VALUES (?,'parent-session',?,?)`, String(operation.operation_id), String(operation.owner_workspace), String(operation.owner_session_id))
            : run(ctx, 'DELETE FROM background_parent_callbacks WHERE operation_id=?', String(operation.operation_id));
        if (changed > 0) bumpChangeRevision(ctx);
        return changed > 0;
    });
}

export function listPendingParentCallbacks(ctx: StoreContext, scope: ParentCallbackScope, options: ParentCallbackPage = {}): OperationRecord[] {
    return getRows(ctx, `SELECT o.* FROM background_parent_callbacks p JOIN operations o ON o.operation_id=p.operation_id
        WHERE p.owner_kind='parent-session' AND p.owner_workspace=? AND p.owner_session_id=? AND p.operation_id>? AND o.terminal_revision>0
        ORDER BY p.operation_id LIMIT ?`, ...scopeValues(scope), options.after === undefined ? '' : requireId('after', options.after), pageSize(options.limit)).map(mapOperation);
}

export function listRecentBackgroundTerminals(ctx: StoreContext, options: RecentBackgroundTerminalPage): OperationRecord[] {
    const params: Array<string|number> = [requireCounter('since', options.since)];
    let where = "observer_kind='local-supervisor' AND terminal_revision>0 AND terminal_at>=?";
    if (options.owner) { where += " AND owner_kind='parent-session' AND owner_workspace=? AND owner_session_id=?"; params.push(...scopeValues(options.owner)); }
    if (options.after) { where += ' AND (terminal_at,operation_id)>(?,?)'; params.push(requireCounter('after.terminalAt', options.after.terminalAt), requireId('after.operationId', options.after.operationId)); }
    params.push(pageSize(options.limit));
    return getRows(ctx, `SELECT * FROM operations WHERE ${where} ORDER BY terminal_at,operation_id LIMIT ?`, ...params).map(mapOperation);
}

/** Call from the canonical manager in bounded batches, yielding between pages. */
export function seedPendingParentCallbacks(ctx: StoreContext, options: { limit?: number } = {}): { done: boolean; seeded: number } {
    return ctx.transaction(() => {
        const migration = getRow(ctx, 'SELECT * FROM background_parent_callback_migration WHERE singleton=1')!;
        if (Number(migration.done)) return { done: true, seeded: 0 };
        const limit = pageSize(options.limit);
        const rows = getRows(ctx, `SELECT operation_id,owner_workspace,owner_session_id FROM operations
            WHERE owner_kind='parent-session' AND observer_kind='local-supervisor' AND operation_id>? AND operation_id<=?
            ORDER BY operation_id LIMIT ?`, String(migration.after_operation_id), String(migration.through_operation_id), limit);
        let seeded = 0;
        for (const row of rows) seeded += Number(run(ctx, `INSERT OR IGNORE INTO background_parent_callbacks(operation_id,owner_kind,owner_workspace,owner_session_id)
            VALUES (?,'parent-session',?,?)`, String(row.operation_id), String(row.owner_workspace), String(row.owner_session_id)));
        const after = rows.length ? String(rows.at(-1)!.operation_id) : String(migration.after_operation_id);
        const done = rows.length < limit || after === migration.through_operation_id;
        run(ctx, 'UPDATE background_parent_callback_migration SET after_operation_id=?,done=? WHERE singleton=1', after, done ? 1 : 0);
        if (seeded) bumpChangeRevision(ctx);
        return { done, seeded };
    });
}
