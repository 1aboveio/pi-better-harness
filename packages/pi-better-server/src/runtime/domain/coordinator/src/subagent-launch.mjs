// Generated canonical coordinator. Do not edit directly.
import { randomBytes } from "node:crypto";
/** Fixed launch journal on the coordinator's existing connection and transaction. */
export class SubagentLaunchJournal {
    context;
    alive;
    constructor(context, alive) {
        this.context = context;
        this.alive = alive;
        this.transaction(() => this.db.exec(`CREATE TABLE IF NOT EXISTS subagent_launch_intents (
            owner TEXT NOT NULL, request_key TEXT NOT NULL, digest TEXT NOT NULL,
            epoch INTEGER NOT NULL, state TEXT NOT NULL, attempts TEXT NOT NULL, result TEXT,
            PRIMARY KEY(owner, request_key));
            CREATE TABLE IF NOT EXISTS subagent_management (singleton INTEGER PRIMARY KEY CHECK(singleton=1), instance TEXT NOT NULL, epoch INTEGER NOT NULL);`));
    }
    get db() { this.alive(); return this.context.db; }
    transaction(run) { this.alive(); return this.context.transaction(run); }
    epoch(instance) {
        return this.transaction(() => {
            const previous = this.db.prepare("SELECT * FROM subagent_management WHERE singleton=1").get();
            if (previous?.instance === instance)
                return Number(previous.epoch);
            const epoch = (Number(previous?.epoch ?? 0)) + 1;
            this.db.prepare("INSERT OR REPLACE INTO subagent_management VALUES (1, ?, ?)").run(instance, epoch);
            return epoch;
        });
    }
    current(epoch) {
        if (this.db.prepare("SELECT epoch FROM subagent_management WHERE singleton=1").get()?.epoch !== epoch)
            throw new Error("stale-runtime-epoch");
    }
    read(owner, key) { return this.db.prepare("SELECT * FROM subagent_launch_intents WHERE owner=? AND request_key=?").get(owner, key); }
    attempt(id) {
        const row = this.db.prepare("SELECT j.value AS attempt FROM subagent_launch_intents, json_each(subagent_launch_intents.attempts) j WHERE json_extract(j.value, '$.id')=? LIMIT 1").get(id);
        return row ? JSON.parse(String(row.attempt)) : undefined;
    }
    unresolvedAttempts() {
        return this.db.prepare("SELECT j.value AS attempt FROM subagent_launch_intents, json_each(subagent_launch_intents.attempts) j WHERE subagent_launch_intents.state='accepted'").all().map(row => JSON.parse(String(row.attempt)));
    }
    accept(owner, key, digest, epoch) {
        return this.transaction(() => {
            this.current(epoch);
            const prior = this.read(owner, key);
            if (prior) {
                if (prior.digest !== digest)
                    throw new Error("request-conflict: launch key has different content");
                return { prior: true, ...prior };
            }
            this.db.prepare("INSERT INTO subagent_launch_intents VALUES (?, ?, ?, ?, 'accepted', '[]', NULL)").run(owner, key, digest, epoch);
            return this.read(owner, key);
        });
    }
    prepare(owner, key, epoch, input) {
        return this.transaction(() => {
            this.current(epoch);
            const row = this.read(owner, key);
            if (!row || row.epoch !== epoch || row.state !== "accepted")
                throw new Error("Launch intent is not admitted");
            const attempts = JSON.parse(row.attempts);
            if (attempts.some(attempt => attempt.id === input.id))
                throw new Error("Attempt already dispatched; reconcile exact identity");
            const attempt = { ...input, token: randomBytes(32).toString("hex"), state: "prepared" };
            attempts.push(attempt);
            this.db.prepare("UPDATE subagent_launch_intents SET attempts=? WHERE owner=? AND request_key=?").run(JSON.stringify(attempts), owner, key);
            return attempt;
        });
    }
    spawned(owner, key, epoch, id, pid) {
        this.transaction(() => {
            this.current(epoch);
            const attempts = JSON.parse(this.read(owner, key).attempts);
            const attempt = attempts.find(value => value.id === id);
            if (!attempt || attempt.state !== "prepared")
                throw new Error("Launch publication is ambiguous");
            if (attempt.writerPid && attempt.writerPid !== pid)
                throw new Error("Launch writer does not match spawned process");
            Object.assign(attempt, { state: "spawned", pid });
            this.db.prepare("UPDATE subagent_launch_intents SET attempts=? WHERE owner=? AND request_key=?").run(JSON.stringify(attempts), owner, key);
        });
    }
    finish(owner, key, epoch, result) {
        this.transaction(() => {
            this.current(epoch);
            this.db.prepare("UPDATE subagent_launch_intents SET state='returned', result=? WHERE owner=? AND request_key=? AND epoch=?").run(JSON.stringify(result), owner, key, epoch);
        });
    }
}
