import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const domain = "../src/runtime/domain/subagents/";
const { LaunchJournal } = await import(domain + "managed-launch-journal.mjs");
const { openStore } = await import(domain + "shared-operation-coordinator/index.domain.mjs");

function location(t: TestContext) {
  const base = resolve("../../.work/761"); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "storage-order-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, path: join(root, "operation-coordinator.sqlite") };
}

for (const order of ["journal-first", "coordinator-first"]) {
  test(`cold ${order} initializes a shared owned SQLite store that accepts an assignment`, (t) => {
    const { root, path } = location(t);
    if (order === "coordinator-first") openStore({ path }).close();
    const journal = new LaunchJournal(path);
    try {
      const epoch = journal.epoch("storage-server");
      journal.accept("storage-owner", "storage-request", "request-digest", epoch);
      const store = openStore({ path });
      try {
        store.registerAssignment({ assignmentId: "storage-assignment", attemptId: "sa_storage_1",
          owner: { kind: "worker-conversation", sessionId: "worker-storage", workspace: root },
          recipient: { kind: "parent-session", sessionId: "parent-storage", workspace: root } });
      } finally { store.close(); }
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        assert.equal(db.prepare("SELECT count(*) AS n FROM assignment_attempts WHERE attempt_id=?").get("sa_storage_1")?.n, 1);
        assert.equal(journal.read("storage-owner", "storage-request").state, "accepted");
      } finally { db.close(); }
    } finally { journal.close(); }
  });
}

for (const pollution of ["foreign-table", "old-journal-only"]) {
  test(`launch journal preserves and refuses unknown ${pollution} SQLite contents`, (t) => {
    const { path } = location(t);
    const db = new DatabaseSync(path);
    const ddl = pollution === "foreign-table" ? "CREATE TABLE foreign_data (value TEXT); INSERT INTO foreign_data VALUES ('retain-me')"
      : "CREATE TABLE subagent_launch_intents (value TEXT); INSERT INTO subagent_launch_intents VALUES ('retain-intent'); CREATE TABLE subagent_management (value TEXT); INSERT INTO subagent_management VALUES ('retain-manager')";
    db.exec(ddl);
    const tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name);
    const before = tables();
    try {
      assert.throws(() => new LaunchJournal(path), /no schema_version.*not written by the operation coordinator/);
      assert.deepEqual(tables(), before);
      const table = pollution === "foreign-table" ? "foreign_data" : "subagent_launch_intents";
      assert.equal(db.prepare(`SELECT value FROM ${table}`).get()?.value, pollution === "foreign-table" ? "retain-me" : "retain-intent");
      if (pollution === "old-journal-only") assert.equal(db.prepare("SELECT value FROM subagent_management").get()?.value, "retain-manager");
      assert.throws(() => openStore({ path }), /no schema_version/);
    } finally { db.close(); }
  });
}

test("launch journal refuses a future coordinator version before creating launch tables", (t) => {
  const { path } = location(t); openStore({ path }).close();
  const db = new DatabaseSync(path);
  try {
    db.prepare("UPDATE schema_meta SET value='999' WHERE key='schema_version'").run();
    assert.throws(() => new LaunchJournal(path), /schema version 999/);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('subagent_launch_intents', 'subagent_management')").all(), []);
    assert.equal(db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()?.value, "999");
  } finally { db.close(); }
});
