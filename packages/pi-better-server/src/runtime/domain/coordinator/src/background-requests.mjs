// Generated canonical coordinator. Do not edit directly.
import { createHash } from 'node:crypto';
const prefix = 'background-request-v1:';
// A partial index excludes returned history. CASE protects other coordinator
// records and makes corrupt request rows visible to recovery rather than hiding them.
const pendingPredicate = "key GLOB 'background-request-v1:*' AND CASE WHEN json_valid(value) THEN COALESCE(json_extract(value, '$.state'), '') != 'returned' ELSE 1 END";
export const BACKGROUND_PENDING_QUERY = `SELECT value FROM coordinator_state INDEXED BY background_requests_pending WHERE ${pendingPredicate} ORDER BY key LIMIT ?`;
function storageKey(owner, key) { return prefix + createHash('sha256').update(JSON.stringify([owner, key])).digest('hex'); }
export class BackgroundRequests {
    context;
    alive;
    constructor(context, alive) {
        this.context = context;
        this.alive = alive;
        alive();
        context.db.exec(`CREATE INDEX IF NOT EXISTS background_requests_pending ON coordinator_state(key) WHERE ${pendingPredicate}`);
    }
    read(owner, key) {
        this.alive();
        const row = this.context.db.prepare('SELECT value FROM coordinator_state WHERE key=?').get(storageKey(owner, key));
        return row ? JSON.parse(String(row.value)) : undefined;
    }
    write(value) {
        this.context.db.prepare('INSERT OR REPLACE INTO coordinator_state (key,value) VALUES (?,?)').run(storageKey(value.owner, value.key), JSON.stringify(value));
    }
    accept(owner, key, digest) {
        this.alive();
        return this.context.transaction(() => {
            const prior = this.read(owner, key);
            if (prior) {
                if (prior.digest !== digest)
                    throw new Error('request-conflict: Background request key changed content');
                return { prior: true, record: prior };
            }
            const record = { owner, key, digest, state: 'accepted', operations: [] };
            this.write(record);
            return { prior: false, record };
        });
    }
    dispatch(owner, key) {
        this.update(owner, key, value => {
            if (value.state !== 'accepted')
                throw new Error('Background request already dispatched');
            value.state = 'dispatching';
        });
    }
    operation(owner, key, operation) {
        this.update(owner, key, value => {
            if (value.state !== 'dispatching')
                throw new Error('Background request is not dispatching');
            if (value.operations.some(prior => prior.operationId === operation.operationId))
                throw new Error('Background operation already prepared');
            value.operations.push(operation);
        });
    }
    finish(owner, key, result) { this.update(owner, key, value => { value.result = result; value.state = 'returned'; }); }
    update(owner, key, change) {
        this.alive();
        this.context.transaction(() => {
            const value = this.read(owner, key);
            if (!value)
                throw new Error('Background request not admitted');
            change(value);
            this.write(value);
        });
    }
    hasPending() {
        this.alive();
        return Boolean(this.context.db.prepare(`SELECT 1 FROM coordinator_state INDEXED BY background_requests_pending WHERE ${pendingPredicate} LIMIT 1`).get());
    }
    pending(limit = 128) {
        this.alive();
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128)
            throw new Error('Background recovery batch limit must be 1..128');
        return this.context.db.prepare(BACKGROUND_PENDING_QUERY).all(limit).map(row => JSON.parse(String(row.value)));
    }
}
