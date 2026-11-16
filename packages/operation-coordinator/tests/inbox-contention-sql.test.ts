import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, createContext } from "../src/sqlite.ts";
import { ensureSchema } from "../src/schema.ts";
import { ensureAssignmentChanges } from "../src/assignment-changes.ts";
// @ts-expect-error Actual shared observation implementation.
import { AssignmentInbox } from "../assignment-inbox.mjs";

test("initialized observer construction and idle receipt do not contend with the existing derived writer", () => {
    const root = mkdtempSync(join(tmpdir(), "inbox-sql-contention-"));
    const source = openDatabase(join(root, "source.sqlite"), { busyTimeoutMs: 0 });
    const ctx = createContext(source); ensureSchema(ctx); ensureAssignmentChanges(ctx);
    const first = new DatabaseSync(":memory:"), second = new DatabaseSync(":memory:");
    const path = join(root, "assignments.sqlite"), backgroundPath = join(root, "background.sqlite");
    const owner = new AssignmentInbox(path, first);
    const background = new AssignmentInbox(backgroundPath, first, { entityPrefix: "background:" });
    let observer: any, backgroundObserver: any;
    try {
        const baselines = [owner, background].map(inbox => inbox.receive(source, "source"));
        const repairDDL = "CREATE TABLE IF NOT EXISTS background_inbox.background_file_repair(singleton INTEGER PRIMARY KEY CHECK(singleton=1), identity TEXT, after_id TEXT, complete INTEGER)";
        first.exec(repairDDL);
        first.exec("BEGIN IMMEDIATE");
        assert.doesNotThrow(() => { observer = new AssignmentInbox(path, second); }, "an initialized inbox must not write during attachment");
        backgroundObserver = new AssignmentInbox(backgroundPath, second, { entityPrefix: "background:" });
        assert.doesNotThrow(() => second.exec(repairDDL), "existing Background repair schema does not reserve a write");
        assert.doesNotThrow(() => second.exec("CREATE TABLE query_projection(id TEXT PRIMARY KEY)"), "query-owner main schema does not write the attached inboxes");
        for (const inbox of [observer, backgroundObserver]) {
            const changes = second.prepare(`SELECT total_changes() AS n`).get()!.n;
            const batch = inbox.receive(source, "source");
            assert.ok(batch.has("*"));
            inbox.acknowledge(batch, false);
            assert.equal(second.prepare("SELECT total_changes() AS n").get()!.n, changes, "idle observer must not write");
        }
        first.exec("ROLLBACK");
        [owner, background].forEach((inbox, index) => inbox.acknowledge(baselines[index], true));
        first.exec("BEGIN IMMEDIATE");
        for (const inbox of [observer, backgroundObserver]) {
            const batch = inbox.receive(source, "source");
            assert.equal(batch.size, 0);
            assert.doesNotThrow(() => inbox.acknowledge(batch, false));
        }
        first.exec("ROLLBACK");
        // A real source writer's reserved WAL lock is independent of derived state.
        source.exec("BEGIN IMMEDIATE; INSERT INTO coordinator_state VALUES('unrelated-writer','held')");
        const reader = new DatabaseSync(join(root, "source.sqlite"), { readOnly: true });
        try { assert.equal(observer.receive(reader, "source").size, 0); }
        finally { reader.close(); source.exec("ROLLBACK"); }
        const schemaReader = new DatabaseSync(join(root, "source.sqlite"), { readOnly: true });
        try {
            ctx.transaction(() => {
                ensureAssignmentChanges(ctx);
                source.exec("CREATE INDEX held_schema_probe ON coordinator_state(value)");
                assert.equal(observer.receive(schemaReader, "source").size, 0, "a coordinator schema transaction is not a derived-inbox write");
            });
        } finally { schemaReader.close(); }
        // Real new obligations still require the durable transaction. A busy
        // writer must remain visible and cannot advance the received cursor.
        source.exec("INSERT INTO assignment_changes(entity,assignment_id,session_id,workspace) VALUES('outcome','a','session','/workspace')");
        const received = observer.metrics.received;
        first.exec("BEGIN IMMEDIATE");
        assert.throws(() => observer.receive(source, "source"), /database is locked/);
        assert.equal(observer.metrics.received, received);
        first.exec("ROLLBACK");
        assert.equal(observer.receive(source, "source").size, 1);
    } finally {
        if (first.isTransaction) first.exec("ROLLBACK");
        backgroundObserver?.close(); observer?.close(); background.close(); owner.close();
        second.close(); first.close(); source.close(); rmSync(root, { recursive: true, force: true });
    }
});
