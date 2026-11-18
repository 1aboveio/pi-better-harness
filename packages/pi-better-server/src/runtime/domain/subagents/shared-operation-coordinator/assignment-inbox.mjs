// Generated fixed launch domain from packages/pi-better-subagents/shared-operation-coordinator/assignment-inbox.mjs. Do not edit directly.
import { createRequire } from "node:module";
/** Rebuildable observation state, never an execution or delivery credential. */
export class AssignmentInbox {
    constructor(path, connectionOrOptions, options = {}) {
        const connection = typeof connectionOrOptions?.prepare === "function" ? connectionOrOptions : undefined;
        if (!connection)
            options = connectionOrOptions ?? options;
        this.entityPrefix = options.entityPrefix;
        const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
        this.shared = Boolean(connection);
        this.db = connection ?? new DatabaseSync(path);
        this.alias = this.entityPrefix === "background:" ? "background_inbox" : "assignment_inbox";
        this.prefix = connection ? `${this.alias}.` : "";
        let attached = false;
        try {
            // Share the query owner's handle; only the attached derived file is durable.
            if (connection) {
                connection.prepare(`ATTACH DATABASE ? AS ${this.alias}`).run(path);
                attached = true;
            }
            // A second observer may open while the first holds a derived write
            // transaction. Existing schema/diagnostics require no write reservation.
            const tables = this.db.prepare(`SELECT count(*) AS n FROM ${this.prefix}sqlite_master
                WHERE type='table' AND name IN ('position','pending','applied_scopes','diagnostics')`).get().n;
            if (tables === 4 && this.db.prepare(`SELECT 1 FROM ${this.prefix}diagnostics LIMIT 1`).get())
                return;
            this.db.exec(`CREATE TABLE IF NOT EXISTS ${this.prefix}position (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation TEXT NOT NULL,
            received INTEGER NOT NULL, applied INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS ${this.prefix}pending (
                scope TEXT PRIMARY KEY, seq INTEGER NOT NULL, first_seq INTEGER NOT NULL, since INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS ${this.prefix}applied_scopes (scope TEXT PRIMARY KEY, seq INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS ${this.prefix}diagnostics (repairs INTEGER NOT NULL);`);
            // Reopening an initialized inbox must not reserve every attached file
            // merely to execute an INSERT whose SELECT would produce no rows.
            if (!this.db.prepare(`SELECT 1 FROM ${this.prefix}diagnostics LIMIT 1`).get()) {
                this.db.exec(`INSERT INTO ${this.prefix}diagnostics SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM ${this.prefix}diagnostics)`);
            }
        }
        catch (error) {
            // A failed constructor cannot transfer its alias to a caller.
            // Never detach an earlier participant or close a borrowed owner.
            try {
                if (attached)
                    this.db.exec(`DETACH DATABASE ${this.alias}`);
                else if (!connection)
                    this.db.close();
            }
            catch (cleanup) {
                throw new AggregateError([error, cleanup], "Assignment inbox initialization and owned cleanup failed");
            }
            throw error;
        }
    }
    receive(source, identity) {
        const version = source.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()?.value;
        if (!["1", "2", "3", "4"].includes(version))
            throw new Error("Unsupported assignment source schema");
        const token = source.prepare("SELECT generation FROM assignment_change_source WHERE singleton=1").get()?.generation;
        if (!token)
            throw new Error("Assignment change journal unavailable");
        const generation = `${identity}:${version}:${token}`;
        const bounds = source.prepare("SELECT min(seq) AS first, max(seq) AS last FROM assignment_changes").get();
        const last = Number(bounds.last ?? 0);
        const position = this.db.prepare(`SELECT * FROM ${this.prefix}position WHERE singleton=1`).get();
        const reset = !position || position.generation !== generation || position.received > last
            || (bounds.first !== null && position.received < Number(bounds.first) - 1);
        const after = reset ? last : position.received;
        const changes = reset ? [] : source.prepare("SELECT * FROM assignment_changes WHERE seq>? ORDER BY seq LIMIT 128").all(after);
        this.more = !reset && Number(changes.at(-1)?.seq ?? after) < last;
        if (!reset && !changes.length)
            return this.batch(generation);
        this.db.exec(this.shared ? `SAVEPOINT ${this.alias}_receive` : "BEGIN IMMEDIATE");
        try {
            if (reset) {
                this.db.exec(`DELETE FROM ${this.prefix}pending; DELETE FROM ${this.prefix}applied_scopes; UPDATE ${this.prefix}diagnostics SET repairs=repairs+1`);
                this.db.prepare(`INSERT INTO ${this.prefix}pending VALUES('*', ?, 0, ?)`).run(last, Date.now());
                this.db.prepare(`INSERT OR REPLACE INTO ${this.prefix}position VALUES(1, ?, ?, 0)`).run(generation, last);
            }
            const insert = this.db.prepare(`INSERT INTO ${this.prefix}pending VALUES(?, ?, ?, ?)
                ON CONFLICT(scope) DO UPDATE SET seq=excluded.seq`);
            for (const change of changes) {
                const background = change.entity.startsWith('background:');
                if (this.entityPrefix ? !change.entity.startsWith(this.entityPrefix) : background)
                    continue;
                insert.run(JSON.stringify([change.session_id, change.workspace, change.assignment_id]), change.seq, change.seq, Date.now());
            }
            // The obligations above and received position commit together.
            if (changes.length)
                this.db.prepare(`UPDATE ${this.prefix}position SET received=? WHERE singleton=1`).run(changes.at(-1).seq);
            this.db.exec(this.shared ? `RELEASE ${this.alias}_receive` : "COMMIT");
        }
        catch (error) {
            this.db.exec(this.shared ? `ROLLBACK TO ${this.alias}_receive; RELEASE ${this.alias}_receive` : "ROLLBACK");
            throw error;
        }
        return this.batch(generation);
    }
    batch(generation) {
        const batch = new Map(this.db.prepare(`SELECT scope, seq FROM ${this.prefix}pending ORDER BY first_seq, scope LIMIT 128`).all().map(row => [row.scope, String(row.seq)]));
        Object.defineProperty(batch, "generation", { value: generation });
        return batch;
    }
    acknowledge(batch, baselineComplete) {
        const position = this.db.prepare(`SELECT * FROM ${this.prefix}position WHERE singleton=1`).get();
        if (batch.generation && batch.generation !== position?.generation)
            return;
        if (batch.size && ![...batch.keys()].some(scope => scope !== "*" || baselineComplete))
            return;
        if (!batch.size && (!position || position.applied === position.received))
            return;
        this.db.exec(this.shared ? `SAVEPOINT ${this.alias}_ack` : "BEGIN IMMEDIATE");
        try {
            const remove = this.db.prepare(`DELETE FROM ${this.prefix}pending WHERE scope=? AND seq=?`);
            const applied = this.db.prepare(`INSERT INTO ${this.prefix}applied_scopes VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET seq=max(seq,excluded.seq)`);
            for (const [scope, seq] of batch)
                if (scope !== "*" || baselineComplete) {
                    if (remove.run(scope, Number(seq)).changes)
                        applied.run(scope, Number(seq));
                }
            // A later entity completing cannot advance past any earlier obligation.
            this.db.exec(`UPDATE ${this.prefix}position SET applied=max(0,min(received,
                COALESCE((SELECT min(first_seq)-1 FROM ${this.prefix}pending), received))) WHERE singleton=1`);
            this.db.exec(this.shared ? `RELEASE ${this.alias}_ack` : "COMMIT");
        }
        catch (error) {
            this.db.exec(this.shared ? `ROLLBACK TO ${this.alias}_ack; RELEASE ${this.alias}_ack` : "ROLLBACK");
            throw error;
        }
    }
    get metrics() {
        const pending = this.db.prepare(`SELECT count(*) AS pending, min(since) AS oldestPendingAt FROM ${this.prefix}pending`).get();
        return { ...this.db.prepare(`SELECT * FROM ${this.prefix}position`).get(),
            more: Boolean(this.more),
            affected: this.db.prepare(`SELECT scope, seq, first_seq, since FROM ${this.prefix}pending ORDER BY first_seq, scope LIMIT 128`).all(),
            ...pending, oldestPendingAgeMs: pending.oldestPendingAt === null ? 0 : Math.max(0, Date.now() - Number(pending.oldestPendingAt)),
            ...this.db.prepare(`SELECT repairs FROM ${this.prefix}diagnostics`).get() };
    }
    close() { if (this.shared)
        this.db.exec(`DETACH DATABASE ${this.alias}`);
    else
        this.db.close(); }
}
