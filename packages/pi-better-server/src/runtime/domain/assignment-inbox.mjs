// Generated from packages/operation-coordinator/assignment-inbox.mjs. Do not edit directly.
import { createRequire } from "node:module";

/** Rebuildable observation state, never an execution or delivery credential. */
export class AssignmentInbox {
    constructor(path) {
        const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
        this.db = new DatabaseSync(path);
        this.db.exec(`CREATE TABLE IF NOT EXISTS position (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation TEXT NOT NULL,
            received INTEGER NOT NULL, applied INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS pending (
                scope TEXT PRIMARY KEY, seq INTEGER NOT NULL, first_seq INTEGER NOT NULL, since INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS diagnostics (repairs INTEGER NOT NULL);
            INSERT INTO diagnostics SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM diagnostics);`);
    }

    receive(source, identity) {
        const version = source.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()?.value;
        if (!["1", "2", "3", "4"].includes(version)) throw new Error("Unsupported assignment source schema");
        const token = source.prepare("SELECT generation FROM assignment_change_source WHERE singleton=1").get()?.generation;
        if (!token) throw new Error("Assignment change journal unavailable");
        const generation = `${identity}:${version}:${token}`;
        const bounds = source.prepare("SELECT min(seq) AS first, max(seq) AS last FROM assignment_changes").get();
        const last = Number(bounds.last ?? 0);
        const position = this.db.prepare("SELECT * FROM position WHERE singleton=1").get();
        const reset = !position || position.generation !== generation || position.received > last
            || (bounds.first !== null && position.received < Number(bounds.first) - 1);
        const after = reset ? last : position.received;
        const changes = reset ? [] : source.prepare("SELECT * FROM assignment_changes WHERE seq>? ORDER BY seq LIMIT 128").all(after);
        this.db.exec("BEGIN IMMEDIATE");
        try {
            if (reset) {
                this.db.exec("DELETE FROM pending; UPDATE diagnostics SET repairs=repairs+1");
                this.db.prepare("INSERT INTO pending VALUES('*', ?, 0, ?)").run(last, Date.now());
                this.db.prepare("INSERT OR REPLACE INTO position VALUES(1, ?, ?, 0)").run(generation, last);
            }
            const insert = this.db.prepare(`INSERT INTO pending VALUES(?, ?, ?, ?)
                ON CONFLICT(scope) DO UPDATE SET seq=excluded.seq`);
            for (const change of changes) insert.run(JSON.stringify([change.session_id, change.workspace, change.assignment_id]), change.seq, change.seq, Date.now());
            // The obligations above and received position commit together.
            if (changes.length) this.db.prepare("UPDATE position SET received=? WHERE singleton=1").run(changes.at(-1).seq);
            this.db.exec("COMMIT");
        } catch (error) { this.db.exec("ROLLBACK"); throw error; }
        return new Map(this.db.prepare("SELECT scope, seq FROM pending ORDER BY first_seq, scope LIMIT 128").all().map(row => [row.scope, String(row.seq)]));
    }

    acknowledge(batch, baselineComplete) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const remove = this.db.prepare("DELETE FROM pending WHERE scope=? AND seq=?");
            for (const [scope, seq] of batch) if (scope !== "*" || baselineComplete) remove.run(scope, Number(seq));
            // A later entity completing cannot advance past any earlier obligation.
            this.db.exec(`UPDATE position SET applied=max(0,min(received,
                COALESCE((SELECT min(first_seq)-1 FROM pending), received))) WHERE singleton=1`);
            this.db.exec("COMMIT");
        } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
    get metrics() {
        return { ...this.db.prepare("SELECT * FROM position").get(),
            ...this.db.prepare("SELECT count(*) AS pending, min(since) AS oldestPendingAt FROM pending").get(),
            ...this.db.prepare("SELECT repairs FROM diagnostics").get() };
    }
    close() { this.db.close(); }
}
