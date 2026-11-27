import { createHash } from 'node:crypto';
import type { StoreContext } from './sqlite.ts';
export interface BackgroundRequest {
    owner: string;
    key: string;
    digest: string;
    state: 'accepted' | 'dispatching' | 'returned';
    operations: Array<{
        operationId: string;
        taskId: string;
        token: string;
    }>;
    result?: unknown;
    acceptedAt?: number;
    lastProgressAt?: number;
    writerFence?: { instance: string; pid: number; start: string };
}
const prefix = 'background-request-v1:';
// A partial index excludes returned history. CASE protects other coordinator
// records and makes corrupt request rows visible to recovery rather than hiding them.
const pendingPredicate = "key GLOB 'background-request-v1:*' AND CASE WHEN json_valid(value) THEN COALESCE(json_extract(value, '$.state'), '') != 'returned' ELSE 1 END";
export const BACKGROUND_PENDING_QUERY = `SELECT value FROM coordinator_state INDEXED BY background_requests_pending WHERE ${pendingPredicate} ORDER BY key LIMIT ?`;
function storageKey(owner: string, key: string) { return prefix + createHash('sha256').update(JSON.stringify([owner, key])).digest('hex'); }
export class BackgroundRequests {
    private context: StoreContext;
    private alive: () => void;
    constructor(context: StoreContext, alive: () => void) {
        this.context = context;
        this.alive = alive;
        alive();
        context.db.exec(`CREATE INDEX IF NOT EXISTS background_requests_pending ON coordinator_state(key) WHERE ${pendingPredicate}`);
    }
    read(owner: string, key: string): BackgroundRequest | undefined {
        this.alive();
        const row = this.context.db.prepare('SELECT value FROM coordinator_state WHERE key=?').get(storageKey(owner, key));
        return row ? JSON.parse(String(row.value)) : undefined;
    }
    private write(value: BackgroundRequest) {
        this.context.db.prepare('INSERT OR REPLACE INTO coordinator_state (key,value) VALUES (?,?)').run(storageKey(value.owner, value.key), JSON.stringify(value));
    }
    accept(owner: string, key: string, digest: string, writerFence?: BackgroundRequest['writerFence']) {
        this.alive();
        return this.context.transaction(() => {
            const prior = this.read(owner, key);
            if (prior) {
                if (prior.digest !== digest)
                    throw new Error('request-conflict: Background request key changed content');
                return { prior: true, record: prior };
            }
            const record: BackgroundRequest = { owner, key, digest, state: 'accepted', operations: [], acceptedAt: Date.now(), lastProgressAt: Date.now(), writerFence };
            this.write(record);
            return { prior: false, record };
        });
    }
    dispatch(owner: string, key: string) { this.update(owner, key, value => { if (value.state !== 'accepted')
        throw new Error('Background request already dispatched'); value.state = 'dispatching'; }); }
    operation(owner: string, key: string, operation: BackgroundRequest['operations'][number]) {
        this.update(owner, key, value => {
            if (value.state !== 'dispatching')
                throw new Error('Background request is not dispatching');
            if (value.operations.some(prior => prior.operationId === operation.operationId))
                throw new Error('Background operation already prepared');
            value.operations.push(operation);
        });
    }
    finish(owner: string, key: string, result: unknown) { this.update(owner, key, value => { value.result = result; value.state = 'returned'; }); }
    private update(owner: string, key: string, change: (value: BackgroundRequest) => void) {
        this.alive();
        this.context.transaction(() => { const value = this.read(owner, key); if (!value)
            throw new Error('Background request not admitted'); change(value); value.lastProgressAt = Date.now(); this.write(value); });
    }
    lifecycleReasons() {
        return this.pending().map(record => ({ kind: 'task', id: storageKey(record.owner, record.key),
            owner: record.owner, state: record.state, acceptedAt: record.acceptedAt ?? null,
            writerFence: record.writerFence ?? null,
            lastProgressAt: record.lastProgressAt ?? null, executionDeadline: null, nextDeadline: null,
            operations: record.operations.map(({ operationId, taskId }) => ({ operationId, taskId })),
            recovery: 'drain-accepted-background-request-until-journal-return-or-authoritative-handoff' }));
    }
    hasPending(): boolean {
        this.alive();
        return Boolean(this.context.db.prepare(`SELECT 1 FROM coordinator_state INDEXED BY background_requests_pending WHERE ${pendingPredicate} LIMIT 1`).get());
    }
    pending(limit = 128): BackgroundRequest[] {
        this.alive();
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new Error('Background recovery batch limit must be 1..128');
        return this.context.db.prepare(BACKGROUND_PENDING_QUERY).all(limit).map(row => JSON.parse(String(row.value)));
    }
}
