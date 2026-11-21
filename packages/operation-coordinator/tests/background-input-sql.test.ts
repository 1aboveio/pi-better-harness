import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSchema } from "../src/schema.ts";
import { createContext } from "../src/sqlite.ts";
import { ensureAssignmentChanges } from "../src/assignment-changes.ts";
import { setUpgradeFence } from "../src/upgrade.ts";

const tables = ["operations", "waits", "wait_dependencies", "background_parent_callbacks", "coordinator_state"];
const actions = ["INSERT", "UPDATE", "DELETE"];
const owners = await Promise.all([
    "../src/assignment-changes.ts",
    "../../pi-better-background-tasks/src/shared-operation-coordinator/src/assignment-changes.ts",
    "../../pi-better-server/src/runtime/domain/background-service/shared-operation-coordinator/src/assignment-changes.ts",
    "../../pi-better-server/src/runtime/domain/background-service/shared-operation-coordinator/src/assignment-changes.domain.mjs",
    "../../pi-better-server/src/runtime/domain/subagents/shared-operation-coordinator/src/assignment-changes.ts",
    "../../pi-better-server/src/runtime/domain/subagents/shared-operation-coordinator/src/assignment-changes.domain.mjs",
    "../../pi-better-server/src/runtime/domain/coordinator/src/assignment-changes.mjs",
    "../../pi-better-subagents/shared-operation-coordinator/src/assignment-changes.ts",
].map(async path => ({ path, ensure: (await import(new URL(path, import.meta.url).href)).ensureAssignmentChanges as typeof ensureAssignmentChanges })));
const operation = (id: string) => `INSERT INTO operations(operation_id,task_id,launch_token,owner_kind,owner_session_id,owner_workspace,observer_kind,observer_version,phase,health,created_at,updated_at)
    VALUES('${id}','${id}','token','parent-session','parent','/workspace','local-supervisor','1','running','active',1,1)`;
const inserts: Record<string, string> = {
    operations: operation("target"),
    waits: "INSERT INTO waits(wait_id,generation,owner_kind,owner_session_id,owner_workspace,phase,continuation_note,created_at,updated_at) VALUES('wait',1,'parent-session','parent','/workspace','waiting','continue',1,1)",
    wait_dependencies: "INSERT INTO wait_dependencies(wait_id,generation,ordinal,operation_id,link) VALUES('wait',1,0,'target','required')",
    background_parent_callbacks: "INSERT INTO background_parent_callbacks(operation_id,owner_kind,owner_workspace,owner_session_id) VALUES('target','parent-session','/workspace','parent')",
    coordinator_state: "INSERT INTO coordinator_state(key,value) VALUES('result-supervision-v1:target','{}')",
};
const updates: Record<string, string> = {
    operations: "UPDATE operations SET updated_at=2 WHERE operation_id='target'",
    waits: "UPDATE waits SET updated_at=2 WHERE wait_id='wait'",
    wait_dependencies: "UPDATE wait_dependencies SET terminal_revision=1 WHERE operation_id='target'",
    background_parent_callbacks: "UPDATE background_parent_callbacks SET owner_workspace='/workspace' WHERE operation_id='target'",
    coordinator_state: "UPDATE coordinator_state SET value='{}' WHERE key='result-supervision-v1:target'",
};
const deletes: Record<string, string> = {
    operations: "DELETE FROM operations WHERE operation_id='target'",
    waits: "DELETE FROM waits WHERE wait_id='wait'",
    wait_dependencies: "DELETE FROM wait_dependencies WHERE operation_id='target'",
    background_parent_callbacks: "DELETE FROM background_parent_callbacks WHERE operation_id='target'",
    coordinator_state: "DELETE FROM coordinator_state WHERE key='result-supervision-v1:target'",
};

for (const { path: owner, ensure } of owners) {
for (const table of tables) for (const action of actions) test(`${owner}: ${table} ${action} preserves authority and atomic revisions`, () => {
    const db = new DatabaseSync(":memory:"), ctx = createContext(db);
    try {
        ensureSchema(ctx);
        db.exec(operation("sibling"));
        if (table !== "operations" || action !== "INSERT") db.exec(operation("target"));
        if (table === "operations" && action === "DELETE") db.exec(deletes.background_parent_callbacks!);
        if (["waits", "wait_dependencies"].includes(table)) {
            db.exec(inserts.waits!); db.exec(inserts.wait_dependencies!);
        }
        if (table === "coordinator_state") db.exec(inserts.coordinator_state!);
        if (action === "INSERT" && table !== "operations") db.exec(deletes[table]!);
        ensure(ctx);
        const name = `background_input_${table}_${action.toLowerCase()}`;
        const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name)!.sql);
        assert.match(sql, /operation_id,revision/);
        // Isolate this actual installed product trigger so its exact revision
        // contribution is measurable independently of other nested source writes.
        for (const other of tables) for (const event of actions) {
            const trigger = `background_input_${other}_${event.toLowerCase()}`;
            if (trigger !== name) db.exec(`DROP TRIGGER ${trigger}`);
        }
        const generation = db.prepare("SELECT generation FROM assignment_change_source").get()!.generation;
        const write = action === "INSERT" ? inserts[table]! : action === "UPDATE" ? updates[table]! : deletes[table]!;
        const revision = () => db.prepare("SELECT revision FROM background_input_versions WHERE operation_id='target'").get()?.revision;
        db.exec("BEGIN"); db.exec(write);
        assert.equal(db.prepare("SELECT changes() AS n").get()!.n, 1, "the authority statement changes exactly its intended row");
        assert.equal(revision(), action === "UPDATE" ? 2 : 1);
        assert.equal(db.prepare("SELECT count(*) AS n FROM assignment_changes WHERE entity='background:operation'").get()!.n, action === "UPDATE" ? 2 : 1);
        db.exec("ROLLBACK");
        assert.equal(revision(), undefined);
        assert.equal(db.prepare("SELECT count(*) AS n FROM assignment_changes").get()!.n, 0);
        db.exec(write);
        assert.equal(revision(), action === "UPDATE" ? 2 : 1);
        assert.equal(db.prepare("SELECT revision FROM background_input_versions WHERE operation_id='sibling'").get(), undefined);
        assert.equal(db.prepare("SELECT generation FROM assignment_change_source").get()!.generation, generation);
    } finally { db.close(); }
});

test(`${owner}: reopening broken triggers preserves authority and journal positions`, () => {
    const root = mkdtempSync(join(tmpdir(), "background-sql-migration-")), path = join(root, "coordinator.sqlite");
    let db = new DatabaseSync(path);
    try {
        let ctx = createContext(db); ensureSchema(ctx); ensure(ctx);
        db.exec(operation("retained"));
        const generation = db.prepare("SELECT generation FROM assignment_change_source").get()!.generation;
        const before = db.prepare("SELECT max(seq) AS seq FROM assignment_changes").get()!.seq;
        const revision = db.prepare("SELECT revision FROM background_input_versions WHERE operation_id='retained'").get()!.revision;
        const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name GLOB 'background_input_*'").all();
        assert.equal(triggers.length, 15);
        for (const trigger of triggers) {
            db.exec(`DROP TRIGGER ${trigger.name}`);
            // Reinstall the original arity defect as the old-database fixture.
            db.exec(String(trigger.sql).replaceAll(".operation_id, 1", ".operation_id"));
        }
        db.exec("DELETE FROM schema_meta WHERE key='background_input_triggers_version'");
        assert.throws(() => setUpgradeFence(ctx, null), /1 values for 2 columns/);
        db.close(); db = new DatabaseSync(path); ctx = createContext(db);
        ensureSchema(ctx); ensure(ctx);
        assert.equal(db.prepare("SELECT generation FROM assignment_change_source").get()!.generation, generation);
        assert.equal(db.prepare("SELECT max(seq) AS seq FROM assignment_changes").get()!.seq, before);
        assert.equal(db.prepare("SELECT revision FROM background_input_versions WHERE operation_id='retained'").get()!.revision, revision);
        assert.equal(db.prepare("SELECT count(*) AS n FROM operations WHERE operation_id='retained'").get()!.n, 1);
        setUpgradeFence(ctx, null);
        setUpgradeFence(ctx, "candidate-epoch");
        setUpgradeFence(ctx, null);
        db.exec(operation("after-repair"));
        assert.ok(Number(db.prepare("SELECT revision FROM background_input_versions WHERE operation_id='after-repair'").get()!.revision) > 0);
        const installed = db.prepare("SELECT sql FROM sqlite_master WHERE name GLOB 'background_input_*' ORDER BY name").all();
        ensure(ctx);
        assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master WHERE name GLOB 'background_input_*' ORDER BY name").all(), installed);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
}
