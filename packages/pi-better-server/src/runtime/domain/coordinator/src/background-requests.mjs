// Generated canonical coordinator. Do not edit directly.
import { createHash } from 'node:crypto';
const prefix = 'background-request-v1:';
function storageKey(owner, key) { return prefix + createHash('sha256').update(JSON.stringify([owner, key])).digest('hex'); }
export class BackgroundRequests {
    context;
    alive;
    constructor(context, alive) {
        this.context = context;
        this.alive = alive;
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
    pending() { this.alive(); return this.context.db.prepare("SELECT value FROM coordinator_state WHERE key LIKE 'background-request-v1:%'").all().map(row => JSON.parse(String(row.value))).filter(value => value.state !== 'returned'); }
}
